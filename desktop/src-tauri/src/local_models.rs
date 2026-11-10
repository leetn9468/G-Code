//! Direct model loading through a managed, loopback-only server: llama.cpp for a GGUF file, G-Code's
//! own MLX server (desktop/mlx-server) for an MLX model folder. Both answer the same local API.
use serde::Serialize;
use crate::gguf_context::{self, Metadata, Features};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
pub struct LocalModelStatus {
    pub model_path: Option<String>,
    pub runtime_path: Option<String>,
    pub ready: bool,
    pub error: Option<String>,
    pub metadata: Option<Metadata>,
    pub applied_context: Option<u64>,
    pub context_reason: Option<String>,
}

fn setting_path(explicit: Option<String>, key: &str) -> Option<String> {
    explicit.or_else(|| crate::settings::load().pointer(key).and_then(|v| v.as_str()).map(String::from))
        .filter(|v| !v.trim().is_empty())
}

fn validate_model(path: &Path) -> Result<Metadata, String> {
    if !path.is_absolute() { return Err("Choose a model using its full path".into()); }
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot open the model: {e}"))?;
    if meta.is_dir() { return crate::mlx_model::read(path); }
    if !meta.is_file() { return Err("Select a GGUF file or an MLX model folder".into()); }
    let file = File::open(path).map_err(|e| format!("Cannot open GGUF file: {e}"))?;
    gguf_context::read(file, meta.len())
}

// A separate owned process makes a blocked file open cancellable. It never
// enters Tauri or starts a model; timeout kills/reaps it before another attempt.
pub fn run_model_check_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--gcode-check-model") { return; }
    let result = args.get(2).ok_or("Missing model path".to_string()).and_then(|path| validate_model(Path::new(path)));
    println!("{}", serde_json::to_string(&result).unwrap());
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn validate_model_bounded(path: &Path, cancelled: impl Fn() -> bool) -> Result<Metadata, String> {
    #[cfg(test)] { if cancelled() { return Err("Model loading cancelled".into()); } return validate_model(path); }
    #[cfg(not(test))] {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let child = Command::new(exe).arg("--gcode-check-model").arg(path)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("Cannot start model file check: {e}"))?;
        await_file_check(child, cancelled, Duration::from_secs(15))
    }
}

fn await_file_check(mut child: Child, cancelled: impl Fn() -> bool, timeout: Duration) -> Result<Metadata, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let stop = cancelled();
        if stop || Instant::now() >= deadline {
            let _ = child.kill(); let _ = child.wait();
            return Err(if stop { "Model loading cancelled; file check stopped".into() } else { "Timed out reading the model. The file-check process was stopped. Reselect it and check macOS access before retrying.".into() });
        }
        if let Some(_) = child.try_wait().map_err(|e| e.to_string())? {
            let mut data = String::new();
            if let Some(stdout) = child.stdout.take() { stdout.take(8192).read_to_string(&mut data).map_err(|e| e.to_string())?; }
            return serde_json::from_str::<Result<Metadata, String>>(data.trim()).map_err(|_| "Model file check exited without a valid result".to_string())?;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn executable(path: &Path) -> bool {
    if !path.is_file() { return false; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))] { true }
}

fn bundled_runtime(exe: &Path) -> Option<PathBuf> { bundled_file(exe, "llama-runtime/bin/llama-server") }

const MLX_RUNTIME: &str = "mlx-runtime/bin/gcode-mlx-server";

fn bundled_file(exe: &Path, relative: &str) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" { return None; }
    let contents = contents.canonicalize().ok()?;
    let resources = contents.join("Resources").canonicalize().ok()?;
    if !resources.starts_with(&contents) { return None; }
    let runtime = resources.join(relative).canonicalize().ok()?;
    // A packaged default must be self-contained, including when its resource
    // happens to be a symlink. Explicit user-selected paths are separate.
    (runtime.starts_with(&resources) && executable(&runtime)).then_some(runtime)
}

fn find_runtime(explicit: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = setting_path(explicit, "/provider/localRuntimePath") {
        let path = PathBuf::from(path);
        if path.is_absolute() && executable(&path) { return Ok(path); }
        return Err("The selected llama-server executable is missing or not executable".into());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(runtime) = bundled_runtime(&exe) { return Ok(runtime); }
    }
    #[cfg(debug_assertions)] {
        let mut candidates = Vec::new();
        if let Ok(path) = std::env::var("GCODE_LLAMA_SERVER") { candidates.push(PathBuf::from(path)); }
        if let Some(desktop) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            candidates.push(desktop.join("runtime/llama.cpp/bin/llama-server"));
        }
        candidates.extend([PathBuf::from("/opt/homebrew/bin/llama-server"), PathBuf::from("/usr/local/bin/llama-server")]);
        if let Some(paths) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&paths).map(|dir| dir.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" })));
        }
        if let Some(runtime) = candidates.into_iter().find(|path| path.is_absolute() && executable(path)) { return Ok(runtime); }
    }
    Err("The bundled llama-server runtime is missing or not executable. Reinstall the complete G-Code app, or choose a llama-server executable in Local GGUF settings.".into())
}

/// G-Code's MLX server is part of the app: unlike llama-server there is no other copy to choose.
fn find_mlx_runtime() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(runtime) = bundled_file(&exe, MLX_RUNTIME) { return Ok(runtime); }
    }
    #[cfg(debug_assertions)] {
        if let Some(desktop) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            let candidate = desktop.join("runtime/mlx/bin/gcode-mlx-server");
            if executable(&candidate) { return Ok(candidate); }
        }
    }
    Err("The bundled MLX runtime is missing or not executable. Reinstall the complete G-Code app.".into())
}

fn is_mlx_model(path: &str) -> bool { Path::new(path).is_dir() }

pub fn check(model_path: Option<String>, runtime_path: Option<String>) -> LocalModelStatus {
    check_cancellable(model_path, runtime_path, || false)
}

fn check_cancellable(model_path: Option<String>, runtime_path: Option<String>, cancelled: impl Fn() -> bool) -> LocalModelStatus {
    let model_path = setting_path(model_path, "/provider/localModelPath");
    let runtime = if model_path.as_deref().is_some_and(is_mlx_model) { find_mlx_runtime() } else { find_runtime(runtime_path) };
    let validation = model_path.as_deref().ok_or("Choose a downloaded GGUF file or MLX model folder".to_string())
        .and_then(|path| validate_model_bounded(Path::new(path), cancelled));
    let error = validation.as_ref().err().cloned().or_else(|| runtime.as_ref().err().cloned());
    LocalModelStatus { model_path, runtime_path: runtime.ok().map(|p| p.to_string_lossy().into_owned()), ready: error.is_none(), error, metadata: validation.ok(), applied_context: None, context_reason: None }
}

pub struct LocalRuntime {
    child: Child,
    pub base_url: String,
    pub model_path: String,
    pub applied_context: u64,
    pub context_reason: Option<String>,
    log: Arc<Mutex<std::collections::VecDeque<String>>>,
    log_done: Arc<std::sync::atomic::AtomicBool>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
    watchdog: Option<Child>,
}

/// The same watch the CLI keeps on its MCP servers and background shells (src/utils/watchdog.ts): a tiny
/// bash in a group of its own with its stdio on /dev/null. Once a second it checks that this process and
/// the server's group are there. When this process is gone (Force Quit, a crash, so no Drop ran) it
/// stops that group and nothing else: nobody could reach the server and it holds the model's memory.
const WATCHDOG: &str = r#"parent=$1 group=$2
while kill -0 "$parent" 2>/dev/null; do
  kill -0 -- "-$group" 2>/dev/null || exit 0
  /bin/sleep 1
done
kill -0 -- "-$group" 2>/dev/null || exit 0
kill -TERM -- "-$group" 2>/dev/null
/bin/sleep 2
kill -KILL -- "-$group" 2>/dev/null
exit 0"#;

/// Supervision is best effort: a normal stop still goes through Drop.
fn watch_group(parent: u32, group: u32) -> Option<Child> {
    let mut command = Command::new("/bin/bash");
    command.args(["-c", WATCHDOG, "gcode-watchdog", &parent.to_string(), &group.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    command.spawn().ok()
}

impl LocalRuntime {
    fn await_log_tail(&self) {
        let deadline = Instant::now() + Duration::from_millis(200);
        while !self.log_done.load(std::sync::atomic::Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(2)); }
    }
    pub fn exit_error(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.await_log_tail();
                let detail = self.log.lock().map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
                Some(format!("The local model server exited ({status}). {detail}"))
            }
            Ok(None) => None,
            Err(error) => Some(format!("Cannot check the local model server: {error}")),
        }
    }
}

impl Drop for LocalRuntime {
    fn drop(&mut self) {
        self.monitor_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(mut watchdog) = self.watchdog.take() {
            // It leads a group of its own: just it and its sleep.
            #[cfg(unix)] unsafe { libc::kill(-(watchdog.id() as i32), libc::SIGKILL); }
            let _ = watchdog.kill();
            let _ = watchdog.wait();
        }
    }
}

fn slot_metrics(value: &serde_json::Value) -> Option<serde_json::Value> {
    let slots = value.as_array()?;
    let slot = slots.iter().find(|slot| slot.get("is_processing").and_then(|v| v.as_bool()) == Some(true));
    Some(match slot {
        Some(slot) => serde_json::json!({"kind":"inference", "processing":true,
            "promptTokens":slot.get("n_prompt_tokens").and_then(|v| v.as_u64()),
            "generatedTokens":slot.get("n_decoded").or_else(|| slot.pointer("/next_token/0/n_decoded")).and_then(|v| v.as_u64()),
            "contextSize":slot.get("n_ctx").and_then(|v| v.as_u64())}),
        None => serde_json::json!({"kind":"inference", "processing":false}),
    })
}

type Progress = Arc<dyn Fn(serde_json::Value) + Send + Sync>;
fn model_progress(progress: &Progress, phase: &str, message: &str, elapsed: Duration, deadline: Option<u64>) {
    progress(serde_json::json!({"kind":"model", "phase":phase, "message":message, "elapsedMs":elapsed.as_millis(), "deadlineMs":deadline}));
}

pub fn start(model_path: Option<String>, runtime_path: Option<String>, local_context: Option<u64>, cancelled: impl Fn() -> bool, progress: impl Fn(serde_json::Value) + Send + Sync + 'static) -> Result<LocalRuntime, String> {
    let progress: Progress = Arc::new(progress);
    let started = Instant::now();
    let result = start_inner(model_path, runtime_path, local_context, &cancelled, progress.clone());
    if let Err(error) = &result { model_progress(&progress, if cancelled() { "cancelled" } else { "failed" }, error, started.elapsed(), None); }
    result
}

fn start_inner(model_path: Option<String>, runtime_path: Option<String>, local_context: Option<u64>, cancelled: impl Fn() -> bool, progress: Progress) -> Result<LocalRuntime, String> {
    let started = Instant::now();
    model_progress(&progress, "file_check", "Checking model file access", started.elapsed(), Some(15000));
    let status = check_cancellable(model_path, runtime_path, &cancelled);
    if let Some(error) = status.error { return Err(error); }
    let wanted = gguf_context::requested(local_context.or_else(|| crate::settings::load().pointer("/provider/localContext").and_then(|v| v.as_u64())));
    let metadata = status.metadata.ok_or("Model metadata is unavailable")?;
    let runtime_path = status.runtime_path.ok_or("Local runtime is unavailable")?;
    let model_path = status.model_path.ok_or("Model path is unavailable")?;
    // The MLX server is ours: its context needs no feature probing, and none of llama.cpp's flags apply.
    let features = if is_mlx_model(&model_path) { Features::default() } else { runtime_features(&runtime_path, &cancelled, &progress, RUNTIME_CHECK_LIMIT)? };
    let ram = physical_ram()?;
    let mut ceiling = None;
    let runtime = loop {
        if cancelled() { return Err("Model loading cancelled".into()); }
        let plan = gguf_context::plan(&metadata, wanted, ram, features, ceiling)?;
        progress(serde_json::json!({"kind":"model", "phase":"server_start", "message":context_message(&plan, plan.applied), "requestedContext":wanted, "appliedContext":plan.applied, "contextReason":plan.reason, "kvBytes":plan.kv_bytes}));
        match spawn_runtime(&runtime_path, &model_path, &plan, &cancelled, progress.clone()) {
            Ok(runtime) => break runtime,
            Err(error) if gguf_context::allocation_error(&error) && gguf_context::lower(plan.applied).is_some() => {
                ceiling = gguf_context::lower(plan.applied);
                model_progress(&progress, "server_start", "Allocation failed; retrying a smaller owned context", started.elapsed(), None);
            },
            Err(error) => return Err(error),
        }
    };
    progress(serde_json::json!({"kind":"model", "phase":"ready", "message":format!("Model loaded · {} tokens applied (requested {}){}", runtime.applied_context, wanted, runtime.context_reason.as_ref().map(|r| format!(" · {r}")).unwrap_or_default()), "requestedContext":wanted, "appliedContext":runtime.applied_context, "contextReason":runtime.context_reason}));
    let stop = runtime.monitor_stop.clone();
    let origin = runtime.base_url.trim_end_matches("/v1").to_owned();
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder().timeout(Duration::from_millis(750)).no_proxy().build() else { return; };
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            if let Ok(response) = client.get(format!("{origin}/slots")).send() {
                if let Ok(value) = response.json::<serde_json::Value>() {
                    if let Some(metrics) = slot_metrics(&value) { if !stop.load(std::sync::atomic::Ordering::SeqCst) { progress(metrics); } }
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    Ok(runtime)
}

fn physical_ram() -> Result<u64, String> {
    #[cfg(target_os = "macos")]
    {
        let mut ram: u64 = 0; let mut size = std::mem::size_of::<u64>();
        let result = unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut ram as *mut u64).cast(), &mut size, std::ptr::null_mut(), 0) };
        if result == 0 && ram > 0 { return Ok(ram); }
    }
    Err("Cannot determine physical RAM; local model was not started".into())
}
fn clean_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("LLAMA_ARG_") || ["http_proxy", "https_proxy", "all_proxy"].contains(&key.to_string_lossy().to_ascii_lowercase().as_str()) { command.env_remove(key); }
    }
    command.env("NO_PROXY", "*").env("no_proxy", "*");
}
/// macOS can hold a program the first time it runs, before its first output (about 12 seconds
/// measured). Killing it restarts that check, so a short limit fails on every retry.
const RUNTIME_CHECK_LIMIT: Duration = Duration::from_secs(120);
const RUNTIME_CHECK_NOTICE_AFTER: Duration = Duration::from_secs(2);

fn runtime_features(path: &str, cancelled: impl Fn() -> bool, progress: &Progress, limit: Duration) -> Result<Features, String> {
    let mut command = Command::new(path);
    command.arg("--help").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()); clean_environment(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Cannot inspect llama-server flags: {e}"))?;
    let stdout = child.stdout.take().ok_or("Runtime help stdout unavailable")?;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || { let mut text = String::new(); let _ = stdout.take(512 * 1024).read_to_string(&mut text); let _ = send.send(text); });
    let started = Instant::now();
    let deadline = started + limit;
    let mut told = false;
    loop {
        if cancelled() { let _ = child.kill(); let _ = child.wait(); return Err("Local model loading cancelled".into()); }
        if Instant::now() >= deadline {
            let _ = child.kill(); let _ = child.wait();
            return Err(format!("llama-server did not answer within {} seconds, so it was stopped. macOS can hold a program the first time it runs. Run it once in Terminal with --help, let it finish, then try again.", limit.as_secs()));
        }
        if !told && started.elapsed() >= RUNTIME_CHECK_NOTICE_AFTER {
            told = true;
            model_progress(progress, "server_start", "Checking llama-server. The first run on this Mac can take a minute…", started.elapsed(), Some(limit.as_millis() as u64));
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() { return Err("llama-server --help failed".into()); }
            let text = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_secs(1))).map_err(|_| "Runtime help output did not close")?;
            return Ok(Features::from_help(&text));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn context_message(plan: &gguf_context::Plan, actual: u64) -> String {
    format!("{} tokens applied (requested {}){}", actual, plan.requested, plan.reason.as_ref().map(|r| format!(" · {r}")).unwrap_or_default())
}
fn spawn_runtime(path: &str, model: &str, plan: &gguf_context::Plan, cancelled: impl Fn() -> bool, progress: Progress) -> Result<LocalRuntime, String> {
    // Only a child we spawned is probed. This never searches or attaches to a user's runtime.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port(); drop(listener);
    let mut command = Command::new(path);
    command.args(["--model", model, "--host", "127.0.0.1", "--port", &port.to_string(), "--alias", "local-gguf"]);
    if !is_mlx_model(model) { command.args(["--parallel", "1", "--jinja", "--no-webui", "--slots"]); }
    command.args(&plan.flags).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    clean_environment(&mut command);
    // Its own group, so its watchdog can tell it (and only it) from anything else.
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|e| format!("Failed to start the local model server: {e}"))?;
    let watchdog = watch_group(std::process::id(), child.id());
    let stderr = child.stderr.take().ok_or("Local server stderr unavailable")?;
    let tail = Arc::new(Mutex::new(std::collections::VecDeque::<String>::new()));
    let log = tail.clone();
    let log_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completed_log = log_done.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut lines) = log.lock() { if lines.len() == 64 { lines.pop_front(); } lines.push_back(line.chars().take(1000).collect()); }
        }
        completed_log.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let runtime = LocalRuntime { child, base_url: format!("http://127.0.0.1:{port}/v1"), model_path: model.into(), applied_context: plan.applied, context_reason: plan.reason.clone(), log: tail.clone(), log_done, monitor_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)), watchdog };
    let mut runtime = await_ready(runtime, tail, cancelled, progress)?;
    let actual = actual_context(&runtime.base_url)?;
    if actual > plan.applied { return Err("Local server exceeded the admitted context; stopped to protect RAM".into()); }
    if actual != plan.applied { runtime.context_reason = Some(format!("{}server applied a smaller window", runtime.context_reason.as_ref().map(|r| format!("{r}; ")).unwrap_or_default())); }
    runtime.applied_context = actual;
    Ok(runtime)
}
fn context_from_json(value: &serde_json::Value) -> Option<u64> {
    let valid = |v: &serde_json::Value| v.as_u64().filter(|n| *n > 0 && *n <= gguf_context::MAX_CONTEXT);
    if let Some(slots) = value.as_array() {
        if slots.is_empty() { return None; }
        return slots.iter().map(|v| v.get("n_ctx").and_then(valid)).collect::<Option<Vec<_>>>()?.into_iter().min();
    }
    value.pointer("/default_generation_settings/n_ctx").and_then(valid)
}
fn actual_context(base_url: &str) -> Result<u64, String> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).no_proxy().build().map_err(|e| e.to_string())?;
    for endpoint in ["slots", "props"] {
        if let Ok(response) = client.get(format!("{}/{endpoint}", base_url.trim_end_matches("/v1"))).send() {
            if !response.status().is_success() { continue; }
            if let Ok(value) = response.json::<serde_json::Value>() { if let Some(n) = context_from_json(&value) { return Ok(n); } }
        }
    }
    Err("Local server did not report its actual context window; stopped safely".into())
}

fn await_ready(mut runtime: LocalRuntime, tail: Arc<Mutex<std::collections::VecDeque<String>>>, cancelled: impl Fn() -> bool, progress: Progress) -> Result<LocalRuntime, String> {
    let started = Instant::now();
    let mut last_progress = Instant::now() - Duration::from_secs(2);
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).no_proxy().build().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if cancelled() { return Err("Local model loading cancelled".into()); }
        if let Some(status) = runtime.child.try_wait().map_err(|e| e.to_string())? {
            runtime.await_log_tail();
            let detail = tail.lock().map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
            return Err(format!("The local model server exited ({status}) while loading the model. {detail}"));
        }
        if last_progress.elapsed() >= Duration::from_secs(1) {
            model_progress(&progress, "model_loading", "Loading weights and waiting for server health", started.elapsed(), Some(180000));
            last_progress = Instant::now();
        }
        let healthy = client.get(format!("{}/health", runtime.base_url.trim_end_matches("/v1"))).send().ok()
            .filter(|response| response.status().is_success())
            .and_then(|response| response.json::<serde_json::Value>().ok())
            .is_some_and(|value| value.get("status").and_then(|v| v.as_str()) == Some("ok"));
        if healthy && !cancelled() && runtime.child.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok(runtime); }
        if Instant::now() >= deadline { return Err("Timed out after 180 seconds loading the model".into()); }
        std::thread::sleep(Duration::from_millis(250));
    }
}
