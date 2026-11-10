//! Personal permission rules are isolated from settings (which contains credentials).
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};
use std::sync::Mutex;
#[cfg(unix)] use std::os::unix::{fs::{MetadataExt, OpenOptionsExt}, io::{AsRawFd, FromRawFd}};

const LIMIT: u64 = 256 * 1024;
static WRITER: Mutex<()> = Mutex::new(());
fn empty() -> Value { json!({"version": 1, "allow": [], "deny": [], "projects": {}}) }
fn bad() -> String { "Invalid permissions file. Use version 1 with allow, deny and projects lists.".into() }

fn balanced_command(command: &str) -> bool {
    let mut quote = None; let mut depth = 0i32; let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' && quote != Some('\'') { if chars.next().is_none() { return false; } continue; }
        if let Some(end) = quote { if ch == end { quote = None; } continue; }
        if matches!(ch, '\'' | '"' | '`') { quote = Some(ch); }
        else if ch == '(' { depth += 1; }
        else if ch == ')' { depth -= 1; if depth < 0 { return false; } }
    }
    quote.is_none() && depth == 0
}

fn valid_rule(rule: &str, project: bool) -> bool {
    if rule.is_empty() || rule.len() > 4096 || rule.trim() != rule || rule.chars().any(|c| c.is_control()) { return false; }
    if rule.as_bytes()[0].is_ascii_alphabetic() && rule.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return true; }
    let Some((tool, body)) = rule.split_once('(') else { return false; };
    let Some(value) = body.strip_suffix(')') else { return false; };
    if value.is_empty() || value.trim() != value { return false; }
    match tool {
        "Bash" => { let command = value.strip_suffix(":*").unwrap_or(value); !command.is_empty() && command.trim() == command && balanced_command(command) },
        "Read" | "Edit" => (value.starts_with('/') || value.starts_with("~/") || project && !value.starts_with('~'))
            && !value.contains(['\\', '?', '[', ']', '{', '}']) && !value.split('/').any(|part| part == ".."),
        "WebFetch" => {
            let Some(domain) = value.strip_prefix("domain:") else { return false; };
            let host = domain.strip_prefix("*.").unwrap_or(domain);
            if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.chars().any(|c| c.is_whitespace() || "/@?#\\%*".contains(c)) { return false; }
            reqwest::Url::parse(&format!("https://{host}")).map(|url| {
                let authority = url.port().map(|port| format!("{}:{port}", url.host_str().unwrap_or_default())).unwrap_or_else(|| url.host_str().unwrap_or_default().to_string());
                authority.eq_ignore_ascii_case(host) && url.path() == "/"
            }).unwrap_or(false)
        },
        _ => false,
    }
}

fn validate(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or_else(bad)?;
    if object.get("version").and_then(Value::as_u64) != Some(1) { return Err(bad()); }
    let mut count = 0;
    let mut lists = |value: &Value, project: bool| -> Result<(), String> {
        for key in ["allow", "deny"] {
            let list = value.get(key).and_then(Value::as_array).ok_or_else(bad)?;
            count += list.len();
            if count > 1000 { return Err("Too many permission rules (maximum 1000).".into()); }
            for rule in list { if !rule.as_str().is_some_and(|rule| valid_rule(rule, project)) { return Err("Invalid permission rule. Check the rule syntax.".into()); } }
        }
        Ok(())
    };
    lists(value, false)?;
    let projects = object.get("projects").and_then(Value::as_object).ok_or_else(bad)?;
    if projects.len() > 1000 { return Err(bad()); }
    for (root, rules) in projects {
        let path = Path::new(root);
        if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) { return Err(bad()); }
        if let Ok(real) = fs::canonicalize(path) { if real != path { return Err("Project rules must use the project's real absolute path.".into()); } }
        lists(rules, true)?;
    }
    Ok(())
}

/** Keep an opened directory handle: replacing .gcode with a link cannot redirect a write. */
#[cfg(unix)]
fn directory(home: &Path, create: bool) -> Result<File, String> {
    let path = home.join(".gcode");
    if create { match fs::create_dir(&path) { Ok(()) => (), Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (), Err(_) => return Err("Could not create the permissions folder.".into()) } }
    OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path).map_err(|_| "Could not safely open the permissions folder.".into())
}

#[cfg(unix)]
fn load_from(dir: &File) -> Result<Value, String> {
    let name = std::ffi::CString::new("permissions.json").unwrap();
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
    if fd < 0 { return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound { Ok(empty()) } else { Err("Could not safely open permissions.json.".into()) }; }
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| bad())?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > LIMIT { return Err("permissions.json must be a regular file of at most 256 KiB, without links.".into()); }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| bad())?;
    if bytes.len() as u64 > LIMIT { return Err(bad()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    validate(&value)?;
    Ok(value)
}

#[cfg(unix)]
fn save_to(dir: &File, value: &Value) -> Result<(), String> {
    validate(value)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| bad())?;
    if bytes.len() as u64 > LIMIT { return Err("Permissions exceed 256 KiB.".into()); }
    // create_new through openat refuses a planted temp link; rename never follows the destination.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let name = std::ffi::CString::new(format!(".gcode-permissions-{}-{stamp}.tmp", std::process::id())).unwrap();
    let target = std::ffi::CString::new("permissions.json").unwrap();
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
    if fd < 0 { return Err("Could not create a permission update.".into()); }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Could not save permissions.".to_string())?;
        if unsafe { libc::renameat(dir.as_raw_fd(), name.as_ptr(), dir.as_raw_fd(), target.as_ptr()) } != 0 { return Err("Could not replace permissions.json.".into()); }
        dir.sync_all().map_err(|_| "Could not finish saving permissions.".to_string())
    })();
    if result.is_err() { unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0); } }
    result
}

#[cfg(unix)]
fn read_in(home: &Path, cwd: Option<&str>) -> Result<Value, String> {
    let rules = if !home.join(".gcode").try_exists().map_err(|_| bad())? { empty() } else { load_from(&directory(home, false)?)? };
    let project = cwd.map(crate::storage::validate_working_directory).transpose()?.map(|path| path.to_string_lossy().into_owned());
    Ok(json!({"rules": rules, "projectRoot": project}))
}

#[cfg(unix)]
fn change_in(home: &Path, cwd: Option<&str>, rule: &str, deny: bool, remove: bool) -> Result<Value, String> {
    let _guard = WRITER.lock().map_err(|_| "Permission writer is unavailable.".to_string())?;
    let project = cwd.map(crate::storage::validate_working_directory).transpose()?.map(|path| path.to_string_lossy().into_owned());
    if !valid_rule(rule, project.is_some()) { return Err("Invalid permission rule. Check the rule syntax.".into()); }
    let dir = directory(home, true)?;
    let mut rules = load_from(&dir)?;
    let scope = if let Some(root) = &project { rules["projects"].as_object_mut().ok_or_else(bad)?.entry(root.clone()).or_insert_with(|| json!({"allow": [], "deny": []})) } else { &mut rules };
    let list = scope[if deny { "deny" } else { "allow" }].as_array_mut().ok_or_else(bad)?;
    if remove { list.retain(|value| value.as_str() != Some(rule)); }
    else if !list.iter().any(|value| value.as_str() == Some(rule)) { list.push(Value::String(rule.into())); }
    save_to(&dir, &rules)?;
    Ok(json!({"rules": rules, "projectRoot": project}))
}

pub fn read(cwd: Option<&str>) -> Result<Value, String> {
    #[cfg(unix)] { read_in(&dirs::home_dir().ok_or("Home directory unavailable")?, cwd) }
    #[cfg(not(unix))] { let _ = cwd; Err("Permission editing is unavailable on this platform.".into()) }
}
pub fn change(cwd: Option<&str>, rule: &str, deny: bool, remove: bool) -> Result<Value, String> {
    #[cfg(unix)] { change_in(&dirs::home_dir().ok_or("Home directory unavailable")?, cwd, rule, deny, remove) }
    #[cfg(not(unix))] { let _ = (cwd, rule, deny, remove); Err("Permission editing is unavailable on this platform.".into()) }
}
