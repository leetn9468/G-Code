//! `gcode mcp …` for the MCP manager: official-registry search and add, remote server probes,
//! and OAuth sign-in. The bundled CLI does the work (it validates and writes ~/.gcode/mcp.json and
//! keeps sign-ins in ~/.gcode/auth), so the desktop and the terminal share one implementation;
//! it also refuses network actions while Guillotine Mode is on.

use serde_json::Value;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Server names become part of tool names (mcp__<server>__<tool>); "dsh" is the built-in bridge's.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name != "dsh" && name != "__proto__" && !name.starts_with('-') && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A registry name ("io.github.owner/server") or search words: no option can be smuggled in.
fn valid_text(text: &str, max: usize) -> bool {
    !text.starts_with('-') && text.len() <= max && !text.chars().any(char::is_control)
}

fn command(executable: &Path, cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(executable);
    command.arg("mcp").args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Never accept a JavaScript preload inherited by the desktop process.
    for key in ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"] { command.env_remove(key); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    crate::path_env::configure_cli_path(&mut command);
    // What the CLI tells the person to do next names the app's buttons, not a command.
    command.env("GCODE_DESKTOP", "1");
    command
}

fn run(app: &tauri::AppHandle, args: &[&str], timeout: Duration) -> Result<crate::dsh::Output, String> {
    let home = dirs::home_dir().ok_or("Home directory is unavailable")?;
    crate::dsh::run(command(&crate::cli::executable(app)?, &home, args), timeout)
}

/// The CLI's own message ("gcode mcp add: …"), without its prefix.
fn failure(output: &crate::dsh::Output) -> String {
    output.stderr.lines().rev().find(|line| !line.trim().is_empty())
        .map(|line| line.split_once(": ").map_or(line, |(_, rest)| rest).chars().take(500).collect())
        .unwrap_or_else(|| "The MCP command failed".into())
}

fn json_output(output: crate::dsh::Output) -> Result<Value, String> {
    // `test --json` reports a failed connection as JSON and exits 1.
    match serde_json::from_str::<Value>(output.stdout.trim()) {
        Ok(value) if value.is_object() => Ok(value),
        _ if !output.status.success() => Err(failure(&output)),
        _ => Err("The MCP command returned invalid JSON".into()),
    }
}

pub fn search(app: &tauri::AppHandle, query: &str) -> Result<Value, String> {
    let query = query.trim();
    if !valid_text(query, 200) { return Err("Search words cannot start with \"-\" or hold control characters.".into()); }
    let mut args = vec!["search", "--json"];
    if !query.is_empty() { args.extend(["--", query]); }
    // Limits leave room for the first run of the bundled CLI, which can wait on macOS; a kill restarts that wait.
    json_output(run(app, &args, Duration::from_secs(60))?)
}

/// Adds a registry entry under `name`; returns what the CLI said (what to fill in, notes).
pub fn add(app: &tauri::AppHandle, name: &str, registry_name: &str, remote: bool) -> Result<String, String> {
    if !valid_name(name) { return Err("The server name must be 1-32 letters, digits, \"_\" or \"-\", and not \"dsh\".".into()); }
    if registry_name.is_empty() || !valid_text(registry_name, 200) { return Err("Choose a registry entry to add.".into()); }
    let mut args = vec!["add"];
    if remote { args.push("--remote"); }
    args.extend(["--", name, registry_name]);
    let output = run(app, &args, Duration::from_secs(60))?;
    if output.status.success() { Ok(output.stdout.trim().to_string()) } else { Err(failure(&output)) }
}

/// Connects the way a session will (remote transports and sign-ins included) and lists what it offers.
pub fn test(app: &tauri::AppHandle, name: &str) -> Result<Value, String> {
    if !valid_name(name) { return Err("Invalid MCP server name".into()); }
    json_output(run(app, &["test", "--json", "--", name], Duration::from_secs(90))?)
}

static CANCEL_LOGIN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Stops the sign-in that is waiting. The panel runs one at a time.
pub fn cancel_login() { CANCEL_LOGIN.store(true, std::sync::atomic::Ordering::SeqCst); }

/// Opens the browser to sign in (OAuth) and waits for it, up to five minutes, or until Cancel.
pub fn login(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    if !valid_name(name) { return Err("Invalid MCP server name".into()); }
    CANCEL_LOGIN.store(false, std::sync::atomic::Ordering::SeqCst);
    let home = dirs::home_dir().ok_or("Home directory is unavailable")?;
    let output = match crate::dsh::run_cancellable(command(&crate::cli::executable(app)?, &home, &["login", "--", name]), Duration::from_secs(330), &CANCEL_LOGIN) {
        Err(error) if error == crate::dsh::CANCELLED => return Ok("Sign-in cancelled.".into()),
        other => other?,
    };
    if output.status.success() { Ok(output.stdout.lines().last().unwrap_or("Signed in.").trim().to_string()) } else { Err(failure(&output)) }
}

pub fn logout(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    if !valid_name(name) { return Err("Invalid MCP server name".into()); }
    let output = run(app, &["logout", "--", name], Duration::from_secs(60))?;
    if output.status.success() { Ok(output.stdout.trim().to_string()) } else { Err(failure(&output)) }
}
