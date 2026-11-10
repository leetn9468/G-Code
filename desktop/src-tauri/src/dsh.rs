//! Explicit DSH management operations. These do not create a chat or inject provider keys.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

fn settings_view(settings: &Value) -> Value {
    json!({
        "dsh": settings.get("dsh").cloned().unwrap_or_else(|| json!({"enabled": false, "toolTimeoutSeconds": 60, "plugins": []})),
        "guillotine": settings.pointer("/execution/networkGuard/enabled").and_then(Value::as_bool) == Some(true),
    })
}

pub fn read_settings() -> Result<Value, String> {
    // Not "off": the panel says it cannot tell, and install stays refused.
    Ok(settings_view(&crate::settings::read_checked()?))
}

fn merge_settings(mut settings: Value, config: Value) -> Result<Value, String> {
    let object = config.as_object().ok_or("DSH configuration must be an object")?;
    if object.get("enabled").is_some_and(|value| !value.is_boolean()) {
        return Err("DSH enabled must be a boolean".into());
    }
    if object.get("toolTimeoutSeconds").is_some_and(|value| !value.as_u64().is_some_and(|seconds| (10..=600).contains(&seconds))) {
        return Err("DSH tool timeout must be an integer from 10 to 600".into());
    }
    if object.get("plugins").is_some_and(|value| !value.is_array()) {
        return Err("DSH plugins must be an array".into());
    }
    // Validate the editable shape without rewriting plugin configuration or unknown keys.
    // The CLI applies the exact package/version/file validation before any loading/install.
    let mut retained_paths: HashMap<&str, usize> = HashMap::new();
    if let Some(previous) = settings.pointer("/dsh/plugins").and_then(Value::as_array) {
        for path in previous.iter().filter_map(|plugin| plugin.get("path").and_then(Value::as_str)) {
            *retained_paths.entry(path).or_default() += 1;
        }
    }
    if let Some(plugins) = object.get("plugins").and_then(Value::as_array) {
        for plugin in plugins {
            let entry = plugin.as_object().ok_or("Each DSH plugin must be an object")?;
            if entry.get("enabled").is_some_and(|value| !value.is_boolean()) || entry.get("config").is_some_and(|value| !value.is_object()) {
                return Err("DSH plugin enabled must be boolean and config must be an object".into());
            }
            let local = entry.get("path").and_then(Value::as_str);
            let package = entry.get("package").and_then(Value::as_str);
            let version = entry.get("version").and_then(Value::as_str);
            if !matches!((local, package, version), (Some(_), None, None) | (None, Some(_), Some(_))) {
                return Err("Choose a DSH plugin file or an npm package and exact version".into());
            }
            if let Some(file) = local {
                let path = Path::new(file);
                let retained = retained_paths.get_mut(file).is_some_and(|count| {
                    if *count == 0 { false } else { *count -= 1; true }
                });
                // A deleted plugin must not prevent disabling DSH or editing another
                // entry. Only newly added path occurrences need an existing file.
                if !path.is_absolute() || (!retained && !path.is_file()) || !matches!(path.extension().and_then(|value| value.to_str()), Some("js" | "mjs")) {
                    return Err("DSH plugin file must be an existing absolute .js or .mjs path".into());
                }
            }
        }
    }
    settings.as_object_mut().ok_or("User settings must be a JSON object")?.insert("dsh".into(), config);
    Ok(settings)
}

pub fn write_settings(config: Value) -> Result<(), String> {
    // A partial-key write refuses an unreadable existing file, never erases it (save refuses too).
    if let Some(path) = crate::settings::settings_path() {
        match std::fs::read(&path) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Cannot update DSH: user settings are not valid JSON")?;
                if !value.is_object() { return Err("User settings must be a JSON object".into()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot update DSH: user settings could not be read".into()),
        }
    }
    let next = merge_settings(crate::settings::load(), config)?;
    crate::settings::save(&next).map_err(|_| "Could not save DSH settings".to_string())
}

#[derive(Clone, Copy)]
enum Operation { Status, Install }

fn command(executable: &Path, cwd: &Path, operation: Operation) -> Command {
    let mut command = Command::new(executable);
    command.arg("dsh").arg(match operation { Operation::Status => "status", Operation::Install => "install" });
    if matches!(operation, Operation::Status) { command.arg("--json"); }
    command.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Never accept a JavaScript preload inherited by the desktop process.
    for key in ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"] { command.env_remove(key); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    command
}

type ChildSlot = Arc<Mutex<Option<Child>>>;

#[derive(Default)]
struct RegistryState { next_id: u64, stopping: bool, children: HashMap<u64, ChildSlot> }

#[derive(Clone, Default)]
struct ProcessRegistry(Arc<Mutex<RegistryState>>);

impl ProcessRegistry {
    fn spawn(&self, mut command: Command) -> Result<ManagedChild, String> {
        // Hold registration through spawn: shutdown either owns this process or
        // rejects the launch. There is no unregistered child between those steps.
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopping { return Err("Command cancelled because G-Code is exiting".into()); }
        let child = Arc::new(Mutex::new(Some(command.spawn().map_err(|_| "Could not start the bundled G-Code command")?)));
        state.next_id += 1;
        let id = state.next_id;
        state.children.insert(id, child.clone());
        Ok(ManagedChild { id, child, registry: self.clone() })
    }

    fn stop_all(&self) {
        let children: Vec<_> = {
            let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
            state.stopping = true;
            state.children.values().cloned().collect()
        };
        for child in children { stop_child(&child); }
        self.0.lock().unwrap_or_else(|error| error.into_inner()).children.clear();
    }
}

fn registry() -> &'static ProcessRegistry {
    static REGISTRY: OnceLock<ProcessRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ProcessRegistry::default)
}

pub fn stop_all() { registry().stop_all(); }

fn stop_child(slot: &ChildSlot) {
    // Keep the mutex until reaping completes. A worker and app shutdown share the
    // actual Child, never a loose PID list, and only one side can signal it once.
    let mut slot = slot.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(mut child) = slot.take() {
        if !matches!(child.try_wait(), Ok(Some(_))) {
            // The status command handles SIGTERM by closing its detached bridge.
            // Allow that cleanup before forcibly killing the CLI's own process group.
            #[cfg(unix)] unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
            #[cfg(not(unix))] { let _ = child.kill(); }
            let deadline = Instant::now() + Duration::from_millis(750);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) { break; }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct ManagedChild { id: u64, child: ChildSlot, registry: ProcessRegistry }
impl ManagedChild {
    fn with_child<T>(&self, work: impl FnOnce(&mut Child) -> Result<T, String>) -> Result<T, String> {
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        work(child.as_mut().ok_or("Command cancelled because G-Code is exiting")?)
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        stop_child(&self.child);
        self.registry.0.lock().unwrap_or_else(|error| error.into_inner()).children.remove(&self.id);
    }
}

fn collect(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<Result<String, String>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut exceeded = false;
            loop {
                let count = stream.read(&mut chunk).map_err(|_| "Could not read the command output")?;
                if count == 0 { break; }
                if bytes.len() + count <= 4 * 1024 * 1024 { bytes.extend_from_slice(&chunk[..count]); }
                else { exceeded = true; } // Keep draining to avoid blocking the child.
            }
            if exceeded { return Err("Command output exceeded 4 MB".into()); }
            String::from_utf8(bytes).map_err(|_| "Command output was not UTF-8".into())
        })();
        let _ = tx.send(result);
    });
    rx
}

pub(crate) struct Output { pub(crate) status: ExitStatus, pub(crate) stdout: String, pub(crate) stderr: String }

/// Runs a bundled-CLI command (DSH status/install, `gcode mcp …`); G-Code exiting stops it.
pub(crate) fn run(command: Command, timeout: Duration) -> Result<Output, String> { run_in(registry(), command, timeout, None) }

/// The error of a command that `cancel` stopped.
pub(crate) const CANCELLED: &str = "The command was cancelled; its processes were stopped";
/// `run` that also ends, and stops the command, as soon as `cancel` is set.
pub(crate) fn run_cancellable(command: Command, timeout: Duration, cancel: &std::sync::atomic::AtomicBool) -> Result<Output, String> { run_in(registry(), command, timeout, Some(cancel)) }

fn run_in(registry: &ProcessRegistry, command: Command, timeout: Duration, cancel: Option<&std::sync::atomic::AtomicBool>) -> Result<Output, String> {
    let child = registry.spawn(command)?;
    let stdout = collect(child.with_child(|child| child.stdout.take().ok_or("Command stdout unavailable".into()))?);
    let stderr = collect(child.with_child(|child| child.stderr.take().ok_or("Command stderr unavailable".into()))?);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.with_child(|child| child.try_wait().map_err(|_| "Could not wait for the command".into()))? { break status; }
        if Instant::now() >= deadline { return Err("The command timed out; its processes were stopped".into()); }
        if cancel.is_some_and(|cancel| cancel.load(std::sync::atomic::Ordering::SeqCst)) { return Err(CANCELLED.into()); }
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(child); // Reap remaining same-group descendants before waiting for pipe EOF.
    let stdout = stdout.recv_timeout(Duration::from_secs(1)).map_err(|_| "Command stdout did not close")??;
    let stderr = stderr.recv_timeout(Duration::from_secs(1)).map_err(|_| "Command stderr did not close")??;
    Ok(Output { status, stdout, stderr })
}

fn error_line(output: &Output) -> String {
    output.stderr.lines().find(|line| !line.trim().is_empty()).map(|line| line.chars().take(500).collect())
        .unwrap_or_else(|| "DSH command failed; check the plugin settings".into())
}

pub fn status(app: &tauri::AppHandle, cwd: &str) -> Result<Value, String> {
    let cwd = crate::storage::validate_working_directory(cwd)?;
    let mut command = command(&crate::cli::executable(app)?, &cwd, Operation::Status);
    crate::path_env::configure_cli_path(&mut command);
    // The first run of the bundled CLI can wait on macOS; a kill restarts that wait.
    let output = run(command, Duration::from_secs(60))?;
    // A conflict/bridge failure deliberately exits 1 with useful structured status.
    if let Ok(value) = serde_json::from_str::<Value>(&output.stdout) {
        if value.get("state").is_some_and(Value::is_string) && value.get("plugins").is_some_and(Value::is_array) { return Ok(value); }
    }
    if !output.status.success() { return Err(error_line(&output)); }
    Err("DSH status returned invalid JSON".into())
}

pub fn install(app: &tauri::AppHandle, cwd: Option<&str>) -> Result<String, String> {
    // Recheck persisted state here and in the CLI, not only the button's cached state.
    if settings_view(&crate::settings::read_checked()?)["guillotine"] == true {
        return Err("DSH installation is unavailable while Guillotine Mode is enabled".into());
    }
    let cwd = match cwd {
        Some(cwd) => crate::storage::validate_working_directory(cwd)?,
        None => dirs::home_dir().ok_or("Home directory is unavailable")?,
    };
    let mut command = command(&crate::cli::executable(app)?, &cwd, Operation::Install);
    crate::path_env::configure_cli_path(&mut command);
    let output = run(command, Duration::from_secs(300))?;
    if output.status.success() { Ok(output.stdout.trim().to_string()) } else { Err(error_line(&output)) }
}
