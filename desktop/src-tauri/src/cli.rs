use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default, Clone)]
pub struct CliState {
    lifecycle: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    process: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    local_runtime: Arc<Mutex<Option<crate::local_models::LocalRuntime>>>,
}

pub fn apply_local_status(state: &CliState, status: &mut crate::local_models::LocalModelStatus) {
    if let Ok(runtime) = state.local_runtime.lock() {
        if let Some(runtime) = runtime.as_ref().filter(|r| Some(r.model_path.as_str()) == status.model_path.as_deref()) {
            status.applied_context = Some(runtime.applied_context);
            status.context_reason = runtime.context_reason.clone();
        }
    }
}

#[derive(Serialize, Clone)]
struct CliEvent {
    timestamp: u64,
    #[serde(flatten)]
    data: Value,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone)]
struct SessionEmitter {
    app: AppHandle,
    generation: Arc<AtomicU64>,
    epoch: u64,
}

fn emit(app: &SessionEmitter, event: &str, data: Value) {
    if app.generation.load(Ordering::SeqCst) == app.epoch {
        let _ = app.app.emit(event, CliEvent { timestamp: now(), data });
    }
}

struct CliArtifacts {
    executable: PathBuf,
    skills: PathBuf,
}

fn artifacts_in(root: PathBuf) -> Result<CliArtifacts, String> {
    let artifacts = CliArtifacts {
        executable: root.join("bin").join(if cfg!(windows) { "gcode.exe" } else { "gcode" }),
        skills: root.join("skills"),
    };
    for binary in [&artifacts.executable] {
        if !binary.is_file() { return Err(format!("Bundled executable is missing: {}. Rebuild or reinstall G-Code.", binary.display())); }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(binary).map_err(|e| e.to_string())?.permissions().mode() & 0o111 == 0 {
                return Err(format!("Bundled file is not executable: {}", binary.display()));
            }
        }
    }
    for resource in [&artifacts.skills] {
        if !resource.is_dir() { return Err(format!("Bundled resource is missing: {}. Rebuild or reinstall G-Code.", resource.display())); }
    }
    Ok(artifacts)
}

fn cli_artifacts(app: &AppHandle) -> Result<CliArtifacts, String> {
    let resources = app.path().resource_dir().map_err(|e| format!("Cannot locate app resources: {e}"))?;
    let bundled = resources.join("gcode-runtime");
    if bundled.is_dir() { return artifacts_in(bundled); }
    // Development uses the same private compiled artifacts as release builds.
    // A release never searches a checkout or a user's external Bun installation.
    #[cfg(debug_assertions)] {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return artifacts_in(manifest.parent().ok_or("Missing desktop build directory")?.join("runtime").join("gcode"));
    }
    #[cfg(not(debug_assertions))]
    Err("Bundled G-Code runtime is missing. Rebuild or reinstall the application.".into())
}

/// Management commands use the same bundled binary without session setup or credentials.
pub(crate) fn executable(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cli_artifacts(app)?.executable)
}

/// The first executable `bin/rg` below the given runtime roots, if any.
fn bundled_rg_in(roots: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    roots.into_iter().map(|root| root.join("bin").join(if cfg!(windows) { "rg.exe" } else { "rg" })).find(|rg| {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(rg).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
        }
        #[cfg(not(unix))] { rg.is_file() }
    })
}

/// Grep and Glob use this ripgrep instead of a PATH lookup or the slow JS walk.
fn bundled_rg(app: &AppHandle) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = app.path().resource_dir().ok().map(|r| r.join("ripgrep-runtime")).into_iter().collect();
    #[cfg(debug_assertions)]
    let roots = { let mut roots = roots; if let Some(desktop) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() { roots.push(desktop.join("runtime").join("ripgrep")); } roots };
    bundled_rg_in(roots)
}

fn safe_arg(value: &str) -> &str {
    if value.starts_with("sk-") || value.len() > 120 { "[REDACTED]" } else { value }
}

pub fn start(app: AppHandle, state: CliState, provider: String, model: String, resume_id: Option<String>, ollama_host: Option<String>, local_model_path: Option<String>, local_runtime_path: Option<String>, local_context: Option<u64>, context_calibration: Option<Value>, handoff_session_id: Option<String>, working_directory: PathBuf) -> Result<u32, String> {
    let _lifecycle = state.lifecycle.lock().map_err(|_| "CLI lifecycle lock poisoned")?;
    stop_inner(&state)?;
    let app = SessionEmitter { app, generation: state.generation.clone(), epoch: state.generation.load(Ordering::SeqCst) };
    let artifacts = cli_artifacts(&app.app)?;
    if !working_directory.is_absolute() || !working_directory.is_dir() {
        return Err("Choose an existing absolute working directory before starting a session.".into());
    }

    let local_runtime = if provider == "local" {
        emit(&app, "cli-output", json!({"kind":"status", "text":"Loading the selected GGUF model…"}));
        let progress_app = app.clone();
        Some(crate::local_models::start(local_model_path, local_runtime_path, local_context,
            || state.generation.load(Ordering::SeqCst) != app.epoch,
            move |event| emit(&progress_app, "cli-runtime-state", event))?)
    } else { None };
    if state.generation.load(Ordering::SeqCst) != app.epoch {
        return Err("Session startup cancelled".into());
    }
    let mut command = Command::new(&artifacts.executable);
    apply_context_calibration(&mut command, context_calibration.as_ref(), &model, resume_id.is_some());
    command.env_remove("GCODE_HANDOFF_SESSION_ID");
    if resume_id.is_none() {
        if let Some(id) = handoff_session_id.as_deref() {
            crate::storage::load_session(id, &working_directory.to_string_lossy())?;
            command.env("GCODE_HANDOFF_SESSION_ID", id);
        }
    }
    crate::path_env::configure_cli_path(&mut command);
    command.env("GCODE_DESKTOP", "1")
        .env("GCODE_BUNDLED_SKILLS_DIR", &artifacts.skills);
    if let Some(rg) = bundled_rg(&app.app) { command.env("GCODE_RG_PATH", rg); }
    if let Some(runtime) = &local_runtime { command.arg("--base-url").arg(&runtime.base_url); }
    crate::providers::inject_saved_keys(&mut command);
    if provider == "local" {
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
            command.env_remove(key);
        }
        command.env("NO_PROXY", "*").env("no_proxy", "*");
    }
    if let Some(host) = ollama_host { command.env("OLLAMA_HOST", host); }
    command.arg("--provider").arg(&provider)
        .arg("--model").arg(&model)
        .current_dir(&working_directory)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(id) = resume_id { command.arg("--resume").arg(id); }

    eprintln!(
        "[desktop-cli] spawn: {} --provider {} --model {} (credential env values: [REDACTED])",
        artifacts.executable.display(),
        safe_arg(&provider),
        safe_arg(&model),
    );

    let mut child = command.spawn().map_err(|e| format!("failed to start CLI: {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("CLI stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("CLI stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("CLI stderr unavailable")?;
    *state.stdin.lock().map_err(|_| "CLI stdin lock poisoned")? = Some(stdin);
    *state.process.lock().map_err(|_| "CLI process lock poisoned")? = Some(child);
    *state.local_runtime.lock().map_err(|_| "Local runtime lock poisoned")? = local_runtime;

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let output_app = app.clone();
    let output_done = pump_stdout(stdout, ready_tx, Arc::new(move |event: &'static str, payload: Value| emit(&output_app, event, payload)));
    let error_app = app.clone();
    let startup = Arc::new(Mutex::new(StartupStderr::default()));
    let error_startup = startup.clone();
    let (stderr_done_tx, stderr_done) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _done = stderr_done_tx;
        read_stderr(stderr, &error_startup, |event, payload| emit(&error_app, event, payload));
    });

    let monitor_app = app.clone();
    let monitor_state = state.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        // Synchronize cleanup with replacement starts. An epoch check alone
        // cannot protect resources installed after the check by a new session.
        let Ok(_lifecycle) = monitor_state.lifecycle.lock() else { break; };
        if monitor_state.generation.load(Ordering::SeqCst) != monitor_app.epoch { break; }
        let (missing, exit) = monitor_state.process.lock().ok().map(|mut slot| {
            let missing = slot.as_ref().map(|child| child.id()) != Some(pid);
            if missing { return (true, None); }
            let exit = slot.as_mut().and_then(|child| child.try_wait().ok().flatten()).map(|status| {
                *slot = None;
                status
            });
            (missing, exit)
        }).unwrap_or((true, None));
        if missing { break; }
        let runtime_error = monitor_state.local_runtime.lock().ok()
            .and_then(|mut slot| slot.as_mut().and_then(|runtime| runtime.exit_error()));
        if let Some(error) = runtime_error {
            emit(&monitor_app, "cli-error", json!({ "message": error }));
            emit(&monitor_app, "cli-exit", json!({ "code": null, "success": false }));
            // The model server failed, not the user: the CLI saves the turn as "session closed".
            let _ = stop_inner_with(&monitor_state, StopCause::SessionClosed);
            break;
        }
        if let Some(status) = exit {
            if monitor_state.generation.load(Ordering::SeqCst) != monitor_app.epoch { break; }
            if let Ok(mut runtime) = monitor_state.local_runtime.lock() { *runtime = None; }
            if let Ok(mut input) = monitor_state.stdin.lock() { *input = None; }
            await_output(&output_done, OUTPUT_AFTER_EXIT);
            emit(&monitor_app, "cli-exit", json!({ "code": status.code(), "success": status.success() }));
            break;
        }
    });

    // The CLI has an overall 60-second MCP startup budget, preceded by
    // bounded provider initialization. Poll so stop can cancel promptly
    // even while start holds the lifecycle lock.
    if let Err(error) = wait_for_cli_ready(&ready_rx,
        || state.generation.load(Ordering::SeqCst) != app.epoch,
        std::time::Duration::from_secs(90)) {
        let error = startup_error(error, &stderr_done, &startup);
        let _ = stop_inner(&state);
        return Err(error);
    }
    // Ready: a fatal line from here on is a chat error. One read just before is passed on as one.
    if let Some(reason) = end_startup(&startup) { emit(&app, "cli-error", json!({ "message": format!("Fatal: {reason}") })); }
    emit(&app, "cli-output", json!({ "kind": "session-started", "text": "", "pid": pid }));
    Ok(pid)
}

fn wait_for_cli_ready(ready: &mpsc::Receiver<()>, cancelled: impl Fn() -> bool, timeout: std::time::Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if cancelled() { return Err("Session startup cancelled".into()); }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { return Err(format!("CLI initialization timed out after {} seconds", timeout.as_secs())); }
        match ready.recv_timeout(remaining.min(std::time::Duration::from_millis(100))) {
            Ok(()) if !cancelled() => return Ok(()),
            Ok(()) => return Err("Session startup cancelled".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(CLI_EXITED_EARLY.into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {},
        }
    }
}

/// How often the text the model streamed is handed to the webview. Each event is a script the webview
/// runs and a React update: at 1,500 chunks a second one event per chunk froze the window, Stop included.
const TEXT_BATCH: std::time::Duration = std::time::Duration::from_millis(33);
/// The longest tool output sent with a tool-result frame. The chat reads tool-state; this frame is only
/// for a CLI too old to send it, and a Grep's 8 MB here costs the webview for nothing.
const TOOL_RESULT_OUTPUT_CHARS: usize = 64 * 1024;

type Sink = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// Every stdout event in the order it was read, with assistant text merged between them. Any other event
/// first hands over the text before it, so what a replay trims (its character count) still lines up.
struct StdoutEvents { pending: Mutex<String>, sink: Sink }

impl StdoutEvents {
    fn text(&self, text: &str) {
        if let Ok(mut pending) = self.pending.lock() { pending.push_str(text); }
    }
    fn hand_over(&self, pending: &mut String) {
        if !pending.is_empty() { (self.sink)("cli-output", json!({ "kind": "assistant-text", "text": std::mem::take(pending) })); }
    }
    fn flush(&self) {
        if let Ok(mut pending) = self.pending.lock() { self.hand_over(&mut pending); }
    }
    fn event(&self, event: &'static str, payload: Value) {
        let mut pending = self.pending.lock().unwrap_or_else(|error| error.into_inner());
        self.hand_over(&mut pending);
        (self.sink)(event, payload);
    }
    fn route(&self, value: Value) {
        if let Some((event, payload)) = stdout_event(value) {
            match (event, payload.get("kind").and_then(Value::as_str), payload.get("text").and_then(Value::as_str)) {
                ("cli-output", Some("assistant-text"), Some(text)) => self.text(text),
                _ => self.event(event, payload),
            }
        }
    }
    fn bytes(&self, bytes: &[u8]) {
        if !bytes.is_empty() { self.text(&String::from_utf8_lossy(bytes)); }
    }
}

/// How long cli-exit waits for what the CLI wrote before it died. Text arriving after cli-exit would open
/// a new bubble under the "ended" state. Bounded: a stray process can hold the pipe open past the CLI.
const OUTPUT_AFTER_EXIT: std::time::Duration = std::time::Duration::from_millis(250);

/// Reads stdout on its own thread; the flag is set once all of it has been handed on.
fn pump_stdout(stdout: impl Read + Send + 'static, ready: mpsc::SyncSender<()>, sink: Sink) -> Arc<std::sync::atomic::AtomicBool> {
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished = done.clone();
    std::thread::spawn(move || { read_stdout(stdout, ready, sink); finished.store(true, Ordering::SeqCst); });
    done
}

fn await_output(done: &std::sync::atomic::AtomicBool, limit: std::time::Duration) {
    let deadline = std::time::Instant::now() + limit;
    while !done.load(Ordering::SeqCst) && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(5)); }
}

fn read_stdout(mut stdout: impl Read, ready: mpsc::SyncSender<()>, sink: Sink) {
    let events = Arc::new(StdoutEvents { pending: Mutex::new(String::new()), sink });
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (flusher_events, flusher_done) = (events.clone(), done.clone());
    std::thread::spawn(move || while !flusher_done.load(Ordering::SeqCst) {
        std::thread::sleep(TEXT_BATCH);
        flusher_events.flush();
    });
    let mut ready = Some(ready);
    let mut buffer = [0_u8; 1024];
    let mut pending = Vec::<u8>::new();
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => {
                // Text printed before any frame is passed on, but a frame that never closed can only
                // have been cut when the CLI died. As text it was megabytes of raw JSON for the Markdown
                // renderer, which hung the webview for minutes.
                if pending.first() != Some(&0x1e) { events.bytes(&pending); }
                break;
            }
            Ok(size) => {
                pending.extend_from_slice(&buffer[..size]);
                loop {
                    if let Some(start) = pending.iter().position(|byte| *byte == 0x1e) {
                        if start > 0 {
                            events.bytes(&pending[..start]);
                            pending.drain(..start);
                        }
                        if let Some(relative_end) = pending[1..].iter().position(|byte| *byte == 0x1e) {
                            let end = relative_end + 1;
                            let frame = String::from_utf8_lossy(&pending[1..end]).to_string();
                            if let Ok(value) = serde_json::from_str::<Value>(&frame) {
                                if value.get("type").and_then(Value::as_str) == Some("session-started") {
                                    if let Some(sender) = ready.take() { let _ = sender.send(()); }
                                }
                                events.route(value);
                            }
                            pending.drain(..=end);
                            continue;
                        }
                        break;
                    }

                    match std::str::from_utf8(&pending) {
                        Ok(_) => {
                            events.bytes(&pending);
                            pending.clear();
                        }
                        Err(error) if error.error_len().is_none() => {
                            let valid = error.valid_up_to();
                            events.bytes(&pending[..valid]);
                            pending.drain(..valid);
                        }
                        Err(_) => {
                            events.bytes(&pending);
                            pending.clear();
                        }
                    }
                    break;
                }
            }
            Err(error) => { events.event("cli-error", json!({ "message": error.to_string() })); break; }
        }
    }
    done.store(true, Ordering::SeqCst);
    events.flush();
}

/// The longest handoff request passed on to the desktop, in characters.
const HANDOFF_REQUEST_CHARS: usize = 20_000;
/// A replay notice's reason is a short status line.
const REPLY_RESTART_REASON_CHARS: usize = 200;

/// Match the shared engine validator: no coercion, clamping, or arbitrary payload forwarding.
fn valid_calibration(value: &Value) -> Option<Value> {
    let model = value.get("model")?.as_str()?;
    let scale = value.get("scale")?.as_f64()?;
    if model.trim().is_empty() || model.encode_utf16().count() > 256 || !scale.is_finite() || !(0.5..=4.0).contains(&scale) { return None; }
    Some(json!({ "model": model, "scale": scale }))
}

fn apply_context_calibration(command: &mut Command, value: Option<&Value>, model: &str, resumed: bool) {
    command.env_remove("GCODE_CONTEXT_CALIBRATION");
    if resumed { return; }
    if let Some(value) = value.and_then(valid_calibration).filter(|value| value["model"].as_str() == Some(model)) {
        command.env("GCODE_CONTEXT_CALIBRATION", value.to_string());
    }
}

fn stdout_event(value: Value) -> Option<(&'static str, Value)> {
    let kind = value.get("type")?.as_str()?;
    match kind {
        "assistant-text" => Some(("cli-output", json!({ "kind": "assistant-text", "text": value.get("text")?.as_str()? }))),
        "session-started" => Some(("cli-output", json!({ "kind": "session-started", "text":"", "sessionId": value.get("sessionId")?.as_str()? }))),
        "context-status" | "outputs" | "controls" | "tasks" => Some(("cli-session-state", value)),
        "network_incident" | "network-decision" => {
            value.get("incident")?.get("id")?.as_str()?;
            value.get("sessionId")?.as_str()?;
            Some(("cli-session-state", value))
        }
        "budget-status" | "budget-reached" => {
            value.get("budget")?.as_object()?;
            value.get("sessionId")?.as_str()?;
            Some(("cli-session-state", value))
        }
        "context-full" => {
            if value.get("requestId")?.as_str()?.is_empty() { return None; }
            Some(("cli-context-full", value))
        }
        "handoff" => {
            let mut payload = json!({ "summary": value.get("summary")?.as_str()?, "path": value.get("path")?.as_str()?, "sessionId": value.get("sessionId")?.as_str()? });
            // The user's request in the turn that handed off, for the next session to pick up.
            if let Some(request) = value.get("request").and_then(Value::as_str).filter(|request| !request.is_empty()) {
                payload["request"] = Value::String(request.chars().take(HANDOFF_REQUEST_CHARS).collect());
            }
            if let Some(calibration) = value.get("calibration").and_then(valid_calibration) { payload["calibration"] = calibration; }
            // Sessions in a row that handed off without progress; the next continuation acts on it.
            if let Some(stalls) = value.get("stalls").and_then(Value::as_u64).filter(|stalls| (1..=999).contains(stalls)) { payload["stalls"] = json!(stalls); }
            Some(("cli-handoff", payload))
        }
        "tool-state" => Some(("cli-tool-state", value)),
        // A workflow's nodes (runs, phases, agents, tools), for the Tasks view under the call running it.
        "workflow-state" | "workflow-done" => {
            value.get("runId")?.as_str().filter(|id| !id.is_empty())?;
            if kind == "workflow-state" { value.get("node")?.get("id")?.as_str()?; }
            Some(("cli-session-state", value))
        }
        // Every approval waiting, oldest first (the oldest is also sent as a tool-approval).
        "approval-queue" => {
            value.get("pending")?.as_array()?;
            Some(("cli-session-state", value))
        }
        // A turn the CLI started on its own: a background workflow finished, budget was added, a
        // network attempt was allowed.
        "turn-started" => {
            let source = value.get("source")?.as_str()?;
            if !["workflow", "budget", "network"].contains(&source) { return None; }
            Some(("cli-turn-event", json!({ "type": "turn-started", "source": source })))
        }
        "steer" => {
            let id = value.get("id")?.as_str()?;
            let state = value.get("state")?.as_str()?;
            if id.is_empty() || !["queued", "delivered", "returned"].contains(&state) { return None; }
            Some(("cli-turn-event", json!({ "type": "steer", "id": id, "state": state })))
        }
        "reply-restart" => {
            // A workflow agent's replay is not the conversation's: its text was never shown there.
            if value.get("runId").is_some() || value.get("agentId").is_some() { return None; }
            let count = |key: &str| value.get(key).and_then(Value::as_u64);
            let reason: String = value.get("reason").and_then(Value::as_str).unwrap_or("").chars().take(REPLY_RESTART_REASON_CHARS).collect();
            let tools: Vec<&str> = value.get("tools").and_then(Value::as_array).map(|tools| tools.iter().filter_map(Value::as_str).filter(|id| !id.is_empty()).collect()).unwrap_or_default();
            Some(("cli-turn-event", json!({ "type": "reply-restart", "attempt": count("attempt")?, "max": count("max")?, "reason": reason,
                "text": count("text")?, "thinking": count("thinking").unwrap_or(0), "tools": tools })))
        }
        "status" | "system" => Some(("cli-output", json!({ "kind": kind, "text": value.get("text")?.as_str()? }))),
        "tool-approval" | "approval-withdrawn" => {
            if value.get("requestId")?.as_str()?.is_empty() { return None; }
            Some((if kind == "tool-approval" { "cli-tool-approval" } else { "cli-approval-withdrawn" }, value))
        }
        "tool-use" => Some(("cli-tool-use", value)),
        "tool-result" => {
            let mut value = value;
            let long = value.get("output").and_then(Value::as_str).filter(|output| output.len() > TOOL_RESULT_OUTPUT_CHARS).map(|output| output.chars().take(TOOL_RESULT_OUTPUT_CHARS).collect::<String>());
            if let Some(output) = long { value["output"] = Value::String(output); }
            Some(("cli-tool-result", value))
        }
        "turn-complete" => Some(("cli-output", json!({ "kind": "generation-complete", "text": "" }))),
        "error" => Some(("cli-error", value)),
        _ => None,
    }
}

const CLI_EXITED_EARLY: &str = "CLI exited before initialization completed.";
/// How much of what a CLI that died at start wrote is shown: its last lines, each cut to this.
const STARTUP_TAIL_LINES: usize = 8;
const STARTUP_TAIL_CHARS: usize = 500;

/// What the CLI wrote on stderr before it was ready. A "Fatal:" line then is its reason for not
/// starting (the session is open in another G-Code process, a key is missing…). start() returns it
/// as its error instead of the generic CLI_EXITED_EARLY, and it is not also sent as a chat error.
#[derive(Default)]
struct StartupStderr { ready: bool, fatal: Option<String>, tail: std::collections::VecDeque<String> }

fn read_stderr(stderr: impl Read, startup: &Mutex<StartupStderr>, emit_event: impl Fn(&'static str, Value)) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some((event, payload)) = startup_stderr_event(&strip_ansi(&line), startup) { emit_event(event, payload); }
    }
}

fn startup_stderr_event(clean: &str, startup: &Mutex<StartupStderr>) -> Option<(&'static str, Value)> {
    if let Some(reason) = clean.strip_prefix("Fatal:") {
        if let Ok(mut held) = startup.lock() {
            if !held.ready { held.fatal = Some(reason.trim().to_string()); return None; }
        }
    }
    let event = stderr_event(clean);
    // What is not an event would otherwise be gone: a runtime that cannot load says why only here.
    if event.is_none() && !clean.is_empty() {
        if let Ok(mut held) = startup.lock() {
            if !held.ready {
                if held.tail.len() == STARTUP_TAIL_LINES { held.tail.pop_front(); }
                held.tail.push_back(clean.chars().take(STARTUP_TAIL_CHARS).collect());
            }
        }
    }
    event
}

/// Marks the CLI ready, so later fatal lines are chat errors; returns a fatal line read before that.
fn end_startup(startup: &Mutex<StartupStderr>) -> Option<String> {
    startup.lock().ok().and_then(|mut held| { held.ready = true; held.fatal.take() }).filter(|reason| !reason.is_empty())
}

/// start()'s error when the CLI did not get ready. After an early exit, its stderr is read to the
/// end first, so the CLI's own reason replaces the generic one. The wait is bounded: a process the
/// CLI started may still hold the pipe.
fn startup_error(error: String, stderr_done: &mpsc::Receiver<()>, startup: &Mutex<StartupStderr>) -> String {
    if error != CLI_EXITED_EARLY { return error; }
    let _ = stderr_done.recv_timeout(std::time::Duration::from_secs(1));
    let tail = startup.lock().map(|held| held.tail.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
    end_startup(startup).unwrap_or_else(|| if tail.is_empty() { error } else { format!("{error} It wrote:\n{tail}") })
}

fn stderr_event(clean: &str) -> Option<(&'static str, Value)> {
    // Tool descriptions and server logs can contain arbitrary newlines. Only
    // the escaped stdout protocol may report tool events or request approval.
    if clean.starts_with("[tool") || clean.starts_with("[approval]") { return None; }
    if is_cli_error(clean) { return Some(("cli-error", json!({ "message": clean }))); }
    // A forward list, so a tool's stray stderr stays out of the chat. [dsh] also carries the bridge's
    // own text and "Connected": only what the person has to know passes.
    const NOTES: [&str; 11] = ["[session]", "[mcp]", "[permissions]", "[skills]", "[context]", "[workflow] Invalid user settings", "[dsh] dsh", "[dsh] Project dsh", "[dsh] Cannot read", "[dsh] Bridge unavailable", "[dsh] Server name conflict"];
    if NOTES.iter().any(|tag| clean.starts_with(tag)) || clean.starts_with("[dsh] Skipped incompatible") {
        return Some(("cli-output", json!({ "kind": "system", "text": clean })));
    }
    None
}

fn strip_ansi(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(next) = chars.next() { if next.is_ascii_alphabetic() { break; } }
        } else if ch != '\r' { result.push(ch); }
    }
    result.trim().to_string()
}

pub fn send(state: &CliState, text: &str) -> Result<(), String> {
    // The existing IPC text argument is a framed transport. Message envelopes
    // retain their literal contents; only an explicit approval envelope routes
    // to approval(). Never classify user words as a tray decision.
    if text.starts_with('\u{1e}') {
        let encoded = text.strip_prefix('\u{1e}').and_then(|v| v.strip_suffix('\u{1e}')).ok_or("Incomplete input frame")?;
        let value: Value = serde_json::from_str(encoded).map_err(|_| "Invalid input frame")?;
        match value.get("type").and_then(Value::as_str) {
            Some("message") if value.get("text").and_then(Value::as_str).is_some() => return write_frame(state, value),
            Some("context-choice") => {
                let request_id = value.get("requestId").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("Context choice requires requestId")?;
                let choice = value.get("choice").and_then(Value::as_str).filter(|c| ["handoff", "compact", "stop"].contains(c)).ok_or("Unknown context choice")?;
                return write_frame(state, json!({"type":"context-choice", "requestId":request_id, "choice":choice}));
            }
            Some("steer") => {
                // Text for the running turn; the CLI answers with steer events for this id.
                let id = value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("Steer requires an id")?;
                let text = value.get("text").and_then(Value::as_str).filter(|text| !text.trim().is_empty()).ok_or("Steer requires text")?;
                return write_frame(state, json!({"type":"steer", "id":id, "text":text}));
            }
            Some("task-control") => {
                let id = value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("Task control requires an id")?;
                if value.get("action").and_then(Value::as_str) != Some("stop") { return Err("Unknown task action".into()); }
                return write_frame(state, json!({"type":"task-control", "id":id, "action":"stop"}));
            }
            Some("approval") => {
                let request_id = value.get("requestId").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("Approval requires requestId")?;
                let allowed = value.get("allowed").and_then(Value::as_bool).ok_or("Approval requires a boolean decision")?;
                return approval(state, request_id, allowed);
            }
            _ => return Err("Invalid input frame type".into()),
        }
    }
    write_frame(state, json!({"type":"message", "text":text}))
}

fn write_frame(state: &CliState, value: Value) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|_| "CLI stdin lock poisoned")?;
    let stdin = guard.as_mut().ok_or("No active CLI session")?;
    let frame = format!("\u{1e}{value}\u{1e}\n");
    stdin.write_all(frame.as_bytes()).and_then(|_| stdin.flush())
        .map_err(|e| format!("failed to write to CLI: {e}"))?;
    eprintln!("[desktop-cli] stdin frame write confirmed ({} bytes)", frame.len());
    Ok(())
}

fn is_cli_error(line: &str) -> bool {
    line.starts_with("Error:") || line.starts_with("Fatal:")
        || (line.starts_with("[llm]") && !line.contains("Provider:"))
}

pub fn approval(state: &CliState, request_id: &str, allowed: bool) -> Result<(), String> {
    if request_id.is_empty() { return Err("Approval requires requestId".into()); }
    write_frame(state, json!({"type":"approval", "requestId":request_id, "allowed":allowed}))
}

pub fn stop(state: &CliState) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let _lifecycle = state.lifecycle.lock().map_err(|_| "CLI lifecycle lock poisoned")?;
    stop_inner(state)
}

/// The app is being terminated, not the user stopping a turn: the CLI saves the turn as a closed session.
pub fn close(state: &CliState) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let _lifecycle = state.lifecycle.lock().map_err(|_| "CLI lifecycle lock poisoned")?;
    stop_inner_with(state, StopCause::SessionClosed)
}

/// Why the CLI is being stopped. Under GCODE_DESKTOP=1 the CLI reads SIGTERM as the user's Stop
/// (the turn is saved as "Stopped by user") and SIGHUP as the session closing under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopCause { User, SessionClosed }

impl StopCause {
    #[cfg(unix)]
    fn signal(self) -> i32 { match self { StopCause::User => libc::SIGTERM, StopCause::SessionClosed => libc::SIGHUP } }
}

fn stop_inner(state: &CliState) -> Result<(), String> { stop_inner_with(state, StopCause::User) }

fn stop_inner_with(state: &CliState, cause: StopCause) -> Result<(), String> {
    #[cfg(not(unix))] let _ = cause;
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut guard = state.process.lock().map_err(|_| "CLI process lock poisoned")?;
    if let Some(mut child) = guard.take() {
        #[cfg(unix)] unsafe { libc::kill(child.id() as i32, cause.signal()); }
        #[cfg(not(unix))] child.kill().map_err(|e| e.to_string())?;
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
                _ => { let _ = child.kill(); let _ = child.wait(); break; }
            }
        }
    } else {
        drop(guard);
    }
    if let Ok(mut input) = state.stdin.lock() { *input = None; }
    if let Ok(mut runtime) = state.local_runtime.lock() { *runtime = None; }
    Ok(())
}

pub fn state(app: &AppHandle) -> CliState { app.state::<CliState>().inner().clone() }
