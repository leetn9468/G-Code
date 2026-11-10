// Embedded terminal: one pseudo-terminal per tab, running the user's login
// shell in the project folder (logic follows OpenCode's PTY service).
//
// Per terminal four small threads:
//   reader  — blocking reads from the PTY master into a bounded queue (backpressure)
//   pump    — coalesces output for ~8 ms / 64 KiB and sends raw bytes over the
//             webview Channel (an ArrayBuffer in JS; xterm decodes UTF-8 as a
//             stream, so characters split across reads stay intact). The exit
//             notice travels on the same Channel, after the last output.
//             Flow control (xterm's guide): the pump pauses while more than
//             2 MiB is unacknowledged; xterm acks what it has parsed
//             (terminal_ack). The bounded queue then fills, the reader stops,
//             and the kernel stalls a flooding program (`yes`, a huge `cat`).
//   writer  — writes input, so a full tty buffer never blocks an IPC thread
//   waiter  — reaps the shell and reports its exit
// Closing a tab hangs up the shell's process group (SIGHUP, then SIGKILL after
// 500 ms if it is still alive). Everything is closed on page reload
// (terminal_close_all) and when the app exits.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

const MAX_TERMINALS: usize = 20;
const COALESCE: Duration = Duration::from_millis(8);
const COALESCE_BYTES: usize = 64 * 1024;
const KILL_GRACE: Duration = Duration::from_millis(500);
const UNACKED_HIGH: usize = 2 * 1024 * 1024;
const UNACKED_LOW: usize = 512 * 1024;

/// Bytes sent to the webview and not yet parsed by xterm, plus a closed flag
/// that releases a waiting pump when the tab goes away.
#[derive(Default)]
struct Flow { state: Mutex<(usize, bool)>, changed: std::sync::Condvar }

impl Flow {
    /// Waits until the webview has caught up; false once the terminal is closed.
    fn wait_for_room(&self) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        if state.0 > UNACKED_HIGH {
            while state.0 > UNACKED_LOW && !state.1 {
                state = match self.changed.wait(state) { Ok(state) => state, Err(_) => return false };
            }
        }
        !state.1
    }
    fn sent(&self, bytes: usize) { if let Ok(mut state) = self.state.lock() { state.0 += bytes } }
    fn acked(&self, bytes: usize) {
        if let Ok(mut state) = self.state.lock() { state.0 = state.0.saturating_sub(bytes) }
        self.changed.notify_all();
    }
    fn close(&self) {
        if let Ok(mut state) = self.state.lock() { state.1 = true }
        self.changed.notify_all();
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Notice {
    /// The shell ended; `code` is None when a signal ended it.
    Exit { code: Option<u32> },
}

enum Pumped { Output(Vec<u8>), Exit(Option<u32>) }

struct Session {
    pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    exited: Arc<AtomicBool>,
    flow: Arc<Flow>,
}

#[derive(Default)]
pub struct TerminalState {
    next: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    /// Opens in progress, counted against MAX_TERMINALS with the live sessions.
    opening: Arc<Mutex<usize>>,
}

/// One reserved slot under MAX_TERMINALS; released when the open finishes.
struct Reservation(Arc<Mutex<usize>>);
impl Drop for Reservation {
    fn drop(&mut self) { if let Ok(mut opening) = self.0.lock() { *opening = opening.saturating_sub(1) } }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 }
}

fn working_directory(cwd: Option<String>) -> PathBuf {
    cwd.filter(|path| !path.trim().is_empty())
        .and_then(|path| crate::storage::validate_working_directory(&path).ok())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn shell_command(cwd: Option<String>) -> CommandBuilder {
    // The default program is the user's login shell ($SHELL, else the passwd
    // entry) started with a "-zsh" style argv0, so ~/.zprofile and
    // path_helper give PATH what Terminal.app has, even though a GUI app
    // inherits launchd's minimal environment. (Adding args here would panic.)
    let mut command = CommandBuilder::new_default_prog();
    command.env("PATH", crate::path_env::gui_path(command.get_env("PATH")));
    command.cwd(working_directory(cwd));
    // Development tooling variables (bun/vite/tauri dev) do not belong in the user's shell.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        // Keep user npm preferences. Tool-only defaults are never set on this shell.
        if !name.to_ascii_lowercase().starts_with("npm_config_") && ["npm_", "BUN_", "VITE_", "TAURI_"].iter().any(|prefix| name.starts_with(prefix)) { command.env_remove(&key); }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Not Apple_Terminal, so macOS's /etc/zshrc session-restore hooks stay out.
    command.env("TERM_PROGRAM", "G-Code");
    command.env("GCODE_TERMINAL", "1");
    if std::env::var_os("LANG").is_none() { command.env("LANG", "en_US.UTF-8"); }
    command
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: i32) {
    // The shell is a session leader (setsid), so its pid is its process group.
    if let Some(pid) = pid.filter(|pid| *pid > 1) { unsafe { libc::killpg(pid as libc::pid_t, signal); } }
}

/// Ends a session. A tab closed from the UI releases its pump at once; a shell
/// that exited on its own gives the pump `drain` to deliver its last output
/// (which may still be waiting for xterm's acks) before it is released.
fn hang_up(session: Session, drain: Option<Duration>) {
    let Session { pid, master, input, exited, flow } = session;
    match drain {
        None => flow.close(),
        Some(grace) => { std::thread::spawn(move || { std::thread::sleep(grace); flow.close() }); }
    }
    drop(input);
    #[cfg(unix)]
    signal_group(pid, libc::SIGHUP);
    // Closing the master hangs up the tty: the foreground job gets SIGHUP too.
    drop(master);
    #[cfg(unix)]
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        // The waiter reaps the shell; checking it guards against pid reuse.
        if !exited.load(Ordering::SeqCst) { signal_group(pid, libc::SIGKILL) }
    });
    #[cfg(not(unix))]
    let _ = (pid, exited);
}

pub fn open(state: &TerminalState, cwd: Option<String>, cols: u16, rows: u16, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    open_command(state, shell_command(cwd), cols, rows, events)
}

fn reserve(state: &TerminalState) -> Result<Reservation, String> {
    let sessions = state.sessions.lock().map_err(|_| "terminal state poisoned")?;
    let mut opening = state.opening.lock().map_err(|_| "terminal state poisoned")?;
    if sessions.len() + *opening >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals can be open.")) }
    *opening += 1;
    Ok(Reservation(Arc::clone(&state.opening)))
}

fn open_command(state: &TerminalState, command: CommandBuilder, cols: u16, rows: u16, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    // Checked and reserved under one lock, so concurrent opens cannot pass the cap together.
    let reservation = reserve(state)?;
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|error| format!("Could not open a terminal: {error}"))?;
    let mut child = pair.slave.spawn_command(command).map_err(|error| format!("Could not start the shell: {error}"))?;
    // The parent's copy of the slave must close, or reads never see the shell exit.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let pid = child.process_id();
    let exited = Arc::new(AtomicBool::new(false));
    let flow = Arc::new(Flow::default());
    let (input, inputs) = mpsc::channel::<Vec<u8>>();
    let (pump, pumped) = mpsc::sync_channel::<Pumped>(64);
    let (reader_done, reader_finished) = mpsc::channel::<()>();
    let spawn = |name: &str, work: Box<dyn FnOnce() + Send>| std::thread::Builder::new().name(format!("terminal-{id}-{name}")).spawn(work).map(|_| ()).map_err(|error| error.to_string());

    spawn("writer", Box::new(move || {
        for bytes in inputs { if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() { break } }
    }))?;

    let output: SyncSender<Pumped> = pump.clone();
    spawn("reader", Box::new(move || {
        let mut buffer = vec![0u8; COALESCE_BYTES];
        loop {
            match reader.read(&mut buffer) {
                // macOS reports the closed slave as EIO rather than EOF.
                Ok(0) | Err(_) => break,
                Ok(read) => if output.send(Pumped::Output(buffer[..read].to_vec())).is_err() { break },
            }
        }
        let _ = reader_done.send(());
    }))?;

    let pump_flow = Arc::clone(&flow);
    spawn("pump", Box::new(move || {
        let mut pending: Vec<u8> = Vec::new();
        let flush = |pending: &mut Vec<u8>| -> Result<(), ()> {
            if pending.is_empty() { return Ok(()) }
            // Paused while xterm is behind; a closed tab stops the pump.
            if !pump_flow.wait_for_room() { return Err(()) }
            pump_flow.sent(pending.len());
            events.send(InvokeResponseBody::Raw(std::mem::take(pending))).map_err(|_| ())
        };
        'pump: while let Ok(first) = pumped.recv() {
            let mut next = Some(first);
            let deadline = Instant::now() + COALESCE;
            while let Some(message) = next.take() {
                match message {
                    Pumped::Output(bytes) => pending.extend_from_slice(&bytes),
                    Pumped::Exit(code) => {
                        let _ = flush(&mut pending);
                        let notice = serde_json::to_string(&Notice::Exit { code }).unwrap_or_default();
                        let _ = events.send(InvokeResponseBody::Json(notice));
                        break 'pump;
                    }
                }
                if pending.len() >= COALESCE_BYTES { break }
                match pumped.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(message) => next = Some(message),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => { let _ = flush(&mut pending); break 'pump }
                }
            }
            // A webview that went away ends the pump; the PTY is closed elsewhere.
            if flush(&mut pending).is_err() { break }
        }
    }))?;

    let sessions = Arc::clone(&state.sessions);
    let reaped = Arc::clone(&exited);
    spawn("waiter", Box::new(move || {
        let status = child.wait().ok();
        reaped.store(true, Ordering::SeqCst);
        // Let the reader drain what the shell printed last (a background job
        // that keeps the tty open must not hold the exit notice back for long).
        let _ = reader_finished.recv_timeout(Duration::from_millis(250));
        // A tab closed from the UI was already removed: no notice for it.
        let removed = sessions.lock().ok().and_then(|mut sessions| sessions.remove(&id));
        if let Some(session) = removed {
            let code = status.and_then(|status| if status.signal().is_some() { None } else { Some(status.exit_code()) });
            let _ = pump.send(Pumped::Exit(code));
            hang_up(session, Some(Duration::from_secs(5)));
        }
    }))?;

    state.sessions.lock().map_err(|_| "terminal state poisoned")?.insert(id, Session { pid, master: pair.master, input, exited, flow });
    drop(reservation);
    Ok(id)
}

/// xterm parsed `bytes` of output (sent in batches from its write callbacks).
pub fn ack(state: &TerminalState, id: u32, bytes: usize) {
    if let Some(flow) = state.sessions.lock().ok().and_then(|sessions| sessions.get(&id).map(|session| Arc::clone(&session.flow))) { flow.acked(bytes) }
}

pub fn write(state: &TerminalState, id: u32, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "terminal state poisoned")?;
    let session = sessions.get(&id).ok_or("This terminal has ended")?;
    session.input.send(data.into_bytes()).map_err(|_| "This terminal has ended".to_string())
}

pub fn resize(state: &TerminalState, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "terminal state poisoned")?;
    let session = sessions.get(&id).ok_or("This terminal has ended")?;
    // TIOCSWINSZ: the kernel sends the shell SIGWINCH.
    session.master.resize(size(cols, rows)).map_err(|error| error.to_string())
}

pub fn close(state: &TerminalState, id: u32) {
    let removed = state.sessions.lock().ok().and_then(|mut sessions| sessions.remove(&id));
    if let Some(session) = removed { hang_up(session, None) }
}

pub fn close_all(state: &TerminalState) {
    let drained: Vec<Session> = state.sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect()).unwrap_or_default();
    for session in drained { hang_up(session, None) }
}

/// At app exit the grace threads die with the process, so escalate in place.
pub fn close_all_now(state: &TerminalState) {
    let drained: Vec<Session> = state.sessions.lock().map(|mut sessions| sessions.drain().map(|(_, session)| session).collect()).unwrap_or_default();
    if drained.is_empty() { return }
    #[cfg(unix)]
    {
        let groups: Vec<(Option<u32>, Arc<AtomicBool>)> = drained.iter().map(|session| (session.pid, Arc::clone(&session.exited))).collect();
        for session in drained { hang_up(session, None) }
        std::thread::sleep(Duration::from_millis(100));
        for (pid, exited) in groups { if !exited.load(Ordering::SeqCst) { signal_group(pid, libc::SIGKILL) } }
    }
    #[cfg(not(unix))]
    for session in drained { hang_up(session, None) }
}
