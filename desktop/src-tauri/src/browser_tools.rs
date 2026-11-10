use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct TraceState(pub Mutex<Option<Child>>);

fn runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app.path().resource_dir().map_err(|e| e.to_string())?.join("browser-runtime");
    if bundled.join("mcp.mjs").is_file() { return Ok(bundled); }
    #[cfg(debug_assertions)] {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().ok_or("Missing runtime directory")?.join("runtime/browser"));
    }
    #[cfg(not(debug_assertions))]
    Err("Bundled browser runtime is missing".into())
}

pub fn preset(app: &AppHandle) -> Result<Value, String> {
    let root = runtime(app)?;
    if !root.join("mcp.mjs").is_file() { return Err("Bundled browser adapter is missing".into()); }
    let node = crate::path_env::bundled_node_root().ok_or("Bundled Node runtime is missing")?.join("bin/node");
    Ok(json!({ "name":"gcode_browser", "command":node, "args":[root.join("mcp.mjs")], "enabled":true }))
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)] unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) { return; }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill(); let _ = child.wait();
}

pub fn close(app: &AppHandle) -> Result<(), String> {
    if let Some(mut child) = app.state::<TraceState>().0.lock().map_err(|e| e.to_string())?.take() { stop_child(&mut child); }
    Ok(())
}

pub fn open(app: &AppHandle, cwd: &str, session_id: &str, path: &str, version_id: Option<&str>) -> Result<(), String> {
    let root = crate::storage::validate_working_directory(cwd)?;
    let session = crate::storage::load_session(session_id, cwd)?;
    let trace = crate::storage::tracked_output_path(&root, &session, path, version_id)?;
    if !path.ends_with("trace.zip") || trace.extension().and_then(|s| s.to_str()) != Some("zip") { return Err("Select a tracked Playwright trace.zip".into()); }
    let resources = runtime(app)?;
    close(app)?;
    let mut command = Command::new(crate::path_env::bundled_node_root().ok_or("Bundled Node runtime is missing")?.join("bin/node"));
    // In pinned Playwright, --host/--port switches to the user's browser-tab
    // mode (and can suppress opening under an agent). The default app mode
    // binds localhost and launches its own temporary Chromium profile.
    command.arg(resources.join("driver/playwright-core/cli.js")).arg("show-trace").arg(&trace).args(["--browser", "chromium"])
        .env("PLAYWRIGHT_BROWSERS_PATH", resources.join("browsers")).env_remove("NODE_OPTIONS")
        .current_dir(&root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child = command.spawn().map_err(|e| format!("Could not open trace viewer: {e}"))?;
    *app.state::<TraceState>().0.lock().map_err(|e| e.to_string())? = Some(child);
    Ok(())
}
