// G-Code Desktop — Tauri v2 backend.
//
// Exposes a minimal Rust IPC surface for the React UI:
//   - get_env_status: which LLM provider env vars are set
//   - check_ollama: ping localhost Ollama server
//   - read_settings / write_settings: read/write ~/.gcode/settings.json
//
// Everything above is stateless. The CLI subprocess integration lives in cli.rs.

use serde_json::Value;

mod providers;
mod settings;
mod permissions;
mod cli;
mod dsh;
mod mcp_cli;
mod storage;
mod incidents;
mod browser_tools;
mod local_models;
mod gguf_context;
mod mlx_model;
mod terminal;
mod path_env;
mod workbench;
mod webview;
pub use local_models::run_model_check_if_requested;

use providers::{check_ollama as probe_ollama, get_env_status as detect_env, OllamaStatus, ProviderEnvStatus};

// ============================================================================
// Commands
// ============================================================================

#[tauri::command]
fn get_env_status() -> ProviderEnvStatus {
    detect_env()
}

#[tauri::command]
async fn get_node_environment(cwd: Option<String>) -> Result<path_env::NodeEnvironment, String> {
    let cwd = cwd.map(|path| storage::validate_working_directory(&path)).transpose()?;
    tauri::async_runtime::spawn_blocking(move || path_env::node_environment(cwd.as_deref())).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_ollama(host: Option<String>) -> OllamaStatus {
    probe_ollama(host).await
}

#[tauri::command]
async fn check_local_model(app: tauri::AppHandle, model_path: Option<String>, runtime_path: Option<String>) -> Result<local_models::LocalModelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || { let mut status = local_models::check(model_path, runtime_path); cli::apply_local_status(&cli::state(&app), &mut status); status }).await.map_err(|e| e.to_string())
}

// Settings and storage commands touch files under ~/.gcode. Sync commands run
// on the main thread, where WKWebView paints no frames until they return, so
// these are async and do their file work on the blocking pool; results and
// error strings are unchanged.
async fn off_main<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

// A failed read is an error, never empty settings: React keeps its last values and shows it.
#[tauri::command]
async fn read_settings() -> Result<Value, String> {
    off_main(settings::read_checked).await
}

#[tauri::command]
async fn write_settings(settings: Value) -> Result<(), String> {
    off_main(move || settings::save(&settings)).await
}

#[tauri::command]
async fn read_permissions(cwd: Option<String>) -> Result<Value, String> {
    off_main(move || permissions::read(cwd.as_deref())).await
}

#[tauri::command]
async fn change_permission(cwd: Option<String>, rule: String, deny: bool, remove: bool) -> Result<Value, String> {
    off_main(move || permissions::change(cwd.as_deref(), &rule, deny, remove)).await
}

fn validate_execution_environment(environment: Option<&str>) -> Result<(), String> {
    match environment.unwrap_or("local") {
        "local" => Ok(()),
        "cloud" => Err("Cloud execution is not configured. Select Local to run on this Mac.".to_string()),
        _ => Err("Unknown execution environment".to_string()),
    }
}

#[tauri::command]
async fn start_session(app: tauri::AppHandle, provider: String, model: String, resume_id: Option<String>, ollama_host: Option<String>, local_model_path: Option<String>, local_runtime_path: Option<String>, local_context: Option<u64>, context_calibration: Option<serde_json::Value>, handoff_session_id: Option<String>, cwd: String, execution_environment: Option<String>) -> Result<u32, String> {
    validate_execution_environment(execution_environment.as_deref())?;
    let working_directory = storage::validate_working_directory(&cwd)?;
    // Keys and the Guillotine setting are in there: a chat must not start as if they were not set.
    off_main(|| settings::read_checked().map(|_| ())).await?;
    if let Some(id) = &resume_id { storage::load_session(id, &working_directory.to_string_lossy())?; }
    let host = if provider == "ollama" {
        if model.trim().is_empty() { return Err("Select an installed Ollama model in Provider settings first".to_string()); }
        let status = probe_ollama(ollama_host).await;
        if !status.running { return Err(status.error.unwrap_or_else(|| "Ollama is unavailable".to_string())); }
        if !status.models.iter().any(|name| name == model.trim() || name == &format!("{}:latest", model.trim())) {
            return Err(format!("Model '{}' is not installed on {}. Refresh the model list and select an installed model.", model, status.host));
        }
        Some(status.host)
    } else { None };
    tauri::async_runtime::spawn_blocking(move || cli::start(app.clone(), cli::state(&app), provider, model, resume_id, host, local_model_path, local_runtime_path, local_context, context_calibration, handoff_session_id, working_directory))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command] async fn list_network_incidents() -> Result<Value, String> { off_main(incidents::list).await }
#[tauri::command] async fn read_network_evidence(id: String) -> Result<String, String> { off_main(move || incidents::read(&id)).await }
#[tauri::command] async fn reveal_network_incident(id: String) -> Result<(), String> { off_main(move || incidents::reveal(&id)).await }
#[tauri::command] async fn delete_network_incident(id: String, confirmed: bool) -> Result<(), String> { off_main(move || incidents::delete(&id, confirmed)).await }
#[tauri::command] async fn read_session_output(cwd: String, session_id: String, path: String, version_id: Option<String>) -> Result<Value, String> { off_main(move || storage::read_session_output(&cwd, &session_id, &path, version_id.as_deref())).await }
// Side panel: Files, Changes, Browser, keep-awake, and models.
#[tauri::command] async fn list_directory(cwd: String, path: Option<String>) -> Result<Value, String> { off_main(move || workbench::list_directory(&cwd, path.as_deref())).await }
#[tauri::command] async fn read_project_file(cwd: String, path: String) -> Result<Value, String> { off_main(move || workbench::read_project_file(&cwd, &path)).await }
#[tauri::command] async fn open_path(cwd: String, path: String) -> Result<(), String> { off_main(move || workbench::open_path(&cwd, &path)).await }
#[tauri::command] async fn reveal_path(cwd: String, path: String) -> Result<(), String> { off_main(move || workbench::reveal_path(&cwd, &path)).await }
#[tauri::command] async fn git_head_file(cwd: String, path: String) -> Result<Value, String> { off_main(move || workbench::git_head_file(&cwd, &path)).await }
#[tauri::command] async fn set_keep_awake(state: tauri::State<'_, workbench::KeepAwakeState>, active: bool) -> Result<bool, String> { workbench::set_keep_awake(&state, active) }
#[tauri::command] async fn preview_serve(state: tauri::State<'_, workbench::PreviewState>, cwd: String, folder: Option<String>) -> Result<String, String> { workbench::preview_serve(&state, cwd, folder).await }
#[tauri::command] async fn probe_url(url: String) -> Result<Value, String> { workbench::probe_url(&url).await }
#[tauri::command] async fn preview_stop(state: tauri::State<'_, workbench::PreviewState>) -> Result<(), String> { workbench::preview_stop(&state); Ok(()) }
#[tauri::command] async fn list_provider_models(provider: String) -> Result<Vec<providers::ProviderModel>, String> { providers::list_models(&provider).await }
#[tauri::command] async fn test_provider(provider: String, model: String) -> Result<Value, String> { providers::test_provider(&provider, &model).await }

#[tauri::command] fn browser_mcp_preset(app: tauri::AppHandle) -> Result<Value, String> { browser_tools::preset(&app) }
#[tauri::command] async fn open_browser_trace(app: tauri::AppHandle, cwd: String, session_id: String, path: String, version_id: Option<String>) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || browser_tools::open(&app, &cwd, &session_id, &path, version_id.as_deref())).await.map_err(|e| e.to_string())? }
#[tauri::command] async fn close_browser_trace(app: tauri::AppHandle) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || browser_tools::close(&app)).await.map_err(|e| e.to_string())? }

#[tauri::command] async fn validate_working_directory(path: String) -> Result<String, String> { off_main(move || Ok(storage::validate_working_directory(&path)?.to_string_lossy().into_owned())).await }
#[tauri::command] async fn list_all_sessions() -> Result<Vec<Value>, String> { off_main(storage::list_all_sessions).await }
#[tauri::command] async fn list_searchable_sessions() -> Result<Vec<Value>, String> { off_main(storage::list_searchable_sessions).await }
#[tauri::command] fn unreadable_session_count() -> usize { storage::unreadable_session_count() }
#[tauri::command] async fn create_project(parent: String, name: String) -> Result<String, String> { off_main(move || storage::create_project(&parent, &name)).await }
#[tauri::command] async fn create_chat_workspace() -> Result<String, String> { off_main(storage::create_chat_workspace).await }
#[tauri::command] async fn load_session(id: String, cwd: String) -> Result<Value, String> { off_main(move || storage::load_session(&id, &cwd)).await }
#[tauri::command] async fn delete_session(id: String, cwd: String) -> Result<Option<String>, String> { off_main(move || storage::delete_session(&id, &cwd)).await }
#[tauri::command] async fn read_mcp_config() -> Result<Value, String> { off_main(storage::read_mcp).await }
#[tauri::command] async fn write_mcp_config(config: Value, base: Option<Value>) -> Result<Value, String> { off_main(move || storage::write_mcp(&config, base.as_ref())).await }
/// A local server is probed here (spawn, handshake, tools/list); a remote one through `gcode mcp test`,
/// which speaks its transports and sign-ins as a session does.
#[tauri::command] async fn test_mcp_connection(app: tauri::AppHandle, server_name: String) -> Result<Value, String> {
    off_main(move || if storage::mcp_server_is_remote(&server_name)? { mcp_cli::test(&app, &server_name) } else { storage::test_mcp(&server_name) }).await
}
#[tauri::command] async fn mcp_registry_search(app: tauri::AppHandle, query: String) -> Result<Value, String> { off_main(move || mcp_cli::search(&app, &query)).await }
#[tauri::command] async fn mcp_registry_add(app: tauri::AppHandle, name: String, registry_name: String, remote: bool) -> Result<String, String> { off_main(move || mcp_cli::add(&app, &name, &registry_name, remote)).await }
#[tauri::command] async fn mcp_login(app: tauri::AppHandle, server_name: String) -> Result<String, String> { off_main(move || mcp_cli::login(&app, &server_name)).await }
#[tauri::command] fn mcp_login_cancel() { mcp_cli::cancel_login() }
#[tauri::command] async fn mcp_logout(app: tauri::AppHandle, server_name: String) -> Result<String, String> { off_main(move || mcp_cli::logout(&app, &server_name)).await }
#[tauri::command] async fn read_dsh_settings() -> Result<Value, String> { off_main(dsh::read_settings).await }
#[tauri::command] async fn write_dsh_settings(config: Value) -> Result<(), String> { off_main(move || dsh::write_settings(config)).await }
#[tauri::command] async fn dsh_status(app: tauri::AppHandle, cwd: String) -> Result<Value, String> { off_main(move || dsh::status(&app, &cwd)).await }
#[tauri::command] async fn dsh_install(app: tauri::AppHandle, cwd: Option<String>) -> Result<String, String> { off_main(move || dsh::install(&app, cwd.as_deref())).await }

// A long message written while the CLI is not reading stdin waits for the pipe, so it must not run on
// the main thread: the whole app, Stop included, would wait with it. stop kills first, which releases
// the write. Frames stay whole (the stdin lock) and the UI awaits each one that must follow another.
#[tauri::command]
async fn send_message(app: tauri::AppHandle, text: String) -> Result<(), String> {
    off_main(move || cli::send(&cli::state(&app), &text)).await
}

#[tauri::command]
async fn stop_session(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cli::stop(&cli::state(&app))).await.map_err(|e| e.to_string())?
}

// Embedded terminal (one PTY per tab). Async so input and resizes never run
// on the main thread.
#[tauri::command] async fn terminal_open(state: tauri::State<'_, terminal::TerminalState>, cwd: Option<String>, cols: u16, rows: u16, on_event: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> Result<u32, String> { terminal::open(&state, cwd, cols, rows, on_event) }
#[tauri::command] async fn terminal_write(state: tauri::State<'_, terminal::TerminalState>, id: u32, data: String) -> Result<(), String> { terminal::write(&state, id, data) }
#[tauri::command] async fn terminal_resize(state: tauri::State<'_, terminal::TerminalState>, id: u32, cols: u16, rows: u16) -> Result<(), String> { terminal::resize(&state, id, cols, rows) }
#[tauri::command] async fn terminal_ack(state: tauri::State<'_, terminal::TerminalState>, id: u32, bytes: usize) -> Result<(), String> { terminal::ack(&state, id, bytes); Ok(()) }
#[tauri::command] async fn terminal_close(state: tauri::State<'_, terminal::TerminalState>, id: u32) -> Result<(), String> { terminal::close(&state, id); Ok(()) }
#[tauri::command] async fn terminal_close_all(state: tauri::State<'_, terminal::TerminalState>) -> Result<(), String> { terminal::close_all(&state); Ok(()) }

// ============================================================================
// Entry
// ============================================================================

/// SIGTERM (a shutdown, `kill`, a supervisor) runs the same cleanup as a normal quit: on its own it
/// ends the process with no RunEvent::Exit. The handler only writes to a pipe, which is all a signal
/// handler may do; a thread does the work. If the main thread is stuck, the process still ends.
#[cfg(unix)]
mod terminate {
    use std::sync::atomic::{AtomicI32, Ordering};
    static WRITE_END: AtomicI32 = AtomicI32::new(-1);
    extern "C" fn on_terminate(_signal: libc::c_int) {
        let fd = WRITE_END.load(Ordering::SeqCst);
        if fd >= 0 { unsafe { libc::write(fd, b"t".as_ptr().cast(), 1); } }
    }
    pub fn watch(app: tauri::AppHandle) {
        let mut ends = [0 as libc::c_int; 2];
        if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 { return; }
        // Children must not hold it.
        for end in ends { unsafe { libc::fcntl(end, libc::F_SETFD, libc::FD_CLOEXEC); } }
        WRITE_END.store(ends[1], Ordering::SeqCst);
        std::thread::spawn(move || {
            let mut byte = 0_u8;
            if unsafe { libc::read(ends[0], (&mut byte as *mut u8).cast(), 1) } != 1 { return; }
            std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(8)); std::process::exit(143); });
            let _ = crate::cli::close(&crate::cli::state(&app));
            app.exit(143);
        });
        unsafe { libc::signal(libc::SIGTERM, on_terminate as *const () as libc::sighandler_t); }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(cli::CliState::default())
        .manage(browser_tools::TraceState::default())
        .manage(terminal::TerminalState::default())
        .manage(workbench::KeepAwakeState::default())
        .manage(workbench::PreviewState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") { webview::configure(&window); }
            #[cfg(unix)] terminate::watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_network_incidents, read_network_evidence, reveal_network_incident, delete_network_incident,
            get_env_status,
            get_node_environment,
            check_ollama,
            check_local_model,
            read_permissions,
            change_permission,
            read_settings,
            write_settings,
            start_session,
            read_session_output,
            browser_mcp_preset,
            open_browser_trace,
            close_browser_trace,
            validate_working_directory,
            send_message,
            stop_session,
            list_all_sessions,
            list_searchable_sessions,
            create_project,
            create_chat_workspace,
            load_session,
            delete_session,
            unreadable_session_count,
            read_mcp_config,
            write_mcp_config,
            test_mcp_connection,
            mcp_registry_search,
            mcp_registry_add,
            mcp_login,
            mcp_login_cancel,
            mcp_logout,
            read_dsh_settings,
            write_dsh_settings,
            dsh_status,
            dsh_install,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_ack,
            terminal_close,
            terminal_close_all,
            list_directory,
            read_project_file,
            open_path,
            reveal_path,
            git_head_file,
            set_keep_awake,
            preview_serve,
            preview_stop,
            probe_url,
            list_provider_models,
            test_provider,
        ])
        .build(tauri::generate_context!())
        .expect("error while building G-Code Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                dsh::stop_all(); // Also stops a running `gcode mcp` command.
                let _ = cli::stop(&cli::state(app));
                let _ = browser_tools::close(app);
                terminal::close_all_now(&tauri::Manager::state::<terminal::TerminalState>(app));
                workbench::release_keep_awake(&tauri::Manager::state::<workbench::KeepAwakeState>(app));
                workbench::preview_stop(&tauri::Manager::state::<workbench::PreviewState>(app));
            }
        });
}
