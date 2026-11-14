use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn gcode_dir() -> Result<PathBuf, String> {
    dirs::home_dir().map(|home| home.join(".gcode")).ok_or("home directory unavailable".to_string())
}

pub fn validate_working_directory(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if path.trim().is_empty() || !candidate.is_absolute() {
        return Err("Select an existing project folder before starting a chat".to_string());
    }
    let canonical = fs::canonicalize(candidate).map_err(|error| format!("Project folder is unavailable: {error}"))?;
    if !canonical.is_dir() { return Err("Project path must be a directory".to_string()); }
    Ok(canonical)
}

fn normalized_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(path) };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => { result.pop(); }
            std::path::Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/** Resolve existing ancestors before normalizing `..`: a symlink can change
 * what its parent means. Only a missing path permits this fallback. */
fn canonical_saved_path(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(ancestor) {
            Ok(mut resolved) => {
                if !resolved.is_dir() { return Err("Project path must be a directory".to_string()); }
                for part in suffix.iter().rev() { resolved.push(part); }
                return Ok(normalized_path(&resolved));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let part = ancestor.components().next_back().ok_or_else(|| "Invalid project path".to_string())?;
                suffix.push(part.as_os_str().to_os_string());
                ancestor = ancestor.parent().ok_or_else(|| "Invalid project path".to_string())?;
            }
            Err(error) => return Err(format!("Project folder is unavailable: {error}")),
        }
    }
}

/** Saved chats outlive their folders. Search only equivalent spellings of
 * that absolute path, never nearby namespaces or project directories. */
fn saved_path_candidates(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("Select an existing project folder before starting a chat".to_string());
    }
    let resolved = canonical_saved_path(path)?;
    let mut paths = vec![resolved.clone()];
    let plain = normalized_path(path);
    if canonical_saved_path(&plain).is_ok_and(|value| value == resolved) && !paths.contains(&plain) { paths.push(plain); }
    // macOS keeps /tmp as a symlink. Records written with either spelling
    // remain discoverable after the last directory has disappeared.
    if fs::canonicalize("/tmp").is_ok_and(|value| value == Path::new("/private/tmp")) {
        if let Ok(tail) = resolved.strip_prefix("/private/tmp") {
            let alias = Path::new("/tmp").join(tail);
            if !paths.contains(&alias) { paths.push(alias); }
        }
    }
    Ok(paths)
}

fn project_hash(cwd: &Path) -> String {
    format!("{:x}", Sha256::digest(normalized_path(cwd).to_string_lossy().as_bytes()))
}

fn legacy_project_hash(cwd: &Path) -> String {
    URL_SAFE_NO_PAD.encode(cwd.to_string_lossy().as_bytes()).chars().take(32).collect()
}

fn validate_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') { Ok(()) }
    else { Err("invalid identifier".to_string()) }
}

/// One saved record as a list holds it: where it belongs, whether its folder's name is the current
/// kind, and what the list keeps of it.
struct Listed { cwd: PathBuf, id: String, canonical: bool, value: Value }

/// Reads one record of a project folder. Err: it cannot be read (counted). Ok(None): it belongs to another namespace.
fn read_listed(path: &Path, namespace: &str, keep: fn(Value) -> Value) -> Result<Option<Listed>, ()> {
    let text = fs::read_to_string(path).map_err(|_| ())?;
    let mut value = serde_json::from_str::<Value>(&text).map_err(|_| ())?;
    let id = value.get("sessionId").and_then(Value::as_str).map(str::to_owned).ok_or(())?;
    let saved_cwd = value.get("cwd").and_then(Value::as_str).ok_or(())?;
    if validate_id(&id).is_err() || path.file_stem().and_then(|stem| stem.to_str()) != Some(id.as_str()) || !Path::new(saved_cwd).is_absolute() { return Err(()); }
    let cwd = normalized_path(Path::new(saved_cwd));
    let canonical = namespace == project_hash(&cwd);
    if !canonical && namespace != legacy_project_hash(&cwd) { return Ok(None); }
    if !value.get("messages").is_some_and(Value::is_array) { return Err(()); }
    value["cwd"] = json!(cwd.to_string_lossy());
    Ok(Some(Listed { cwd, id, canonical, value: keep(value) }))
}

/// The most of a first message a row keeps. A handoff's continuation quotes the request (at most
/// 20,000 characters) at its start, so its title is inside this too.
const SUMMARY_FIRST_MESSAGE_BYTES: usize = 64 * 1024;

fn cut(text: &str, bytes: usize) -> String {
    if text.len() <= bytes { return text.to_owned(); }
    let mut end = bytes;
    while !text.is_char_boundary(end) { end -= 1; }
    text[..end].to_owned()
}

/// What the chat list shows of a record, not the record: with 300 MB of history, a list of whole
/// records put 1.4 GB more in the webview on every turn. A chat loads whole when it is opened.
fn session_summary(record: Value) -> Value {
    let messages = record.get("messages").and_then(Value::as_array);
    let count = messages.map_or(0, |list| list.iter().filter(|message| message.is_object()).count());
    let first = messages.and_then(|list| list.iter().find(|message| message.get("role").and_then(Value::as_str) == Some("user") && message.get("content").is_some_and(Value::is_string)));
    let shown: Vec<Value> = first.iter().map(|message| json!({
        "id": message.get("id").cloned().unwrap_or(Value::Null), "role": "user",
        "content": cut(&title_text(message), SUMMARY_FIRST_MESSAGE_BYTES),
        "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null),
    })).collect();
    let mut summary = json!({ "sessionId": record.get("sessionId"), "cwd": record.get("cwd"), "savedAt": record.get("savedAt"), "messages": shown, "messageCount": count });
    if let Some(provider) = record.get("provider").filter(|provider| provider.is_string()) { summary["provider"] = provider.clone(); }
    summary
}

/// A user message's words; a message of attached files only is named by its files.
fn title_text(message: &Value) -> String {
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    if !text.trim().is_empty() { return text.to_string(); }
    message.pointer("/metadata/attachments").and_then(Value::as_array)
        .map(|files| files.iter().filter_map(|file| file.get("name").and_then(Value::as_str)).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

/// What chat search reads: the text of every chat, and nothing else of them. Only while search is open.
fn searchable_record(record: Value) -> Value {
    let messages: Vec<Value> = record.get("messages").and_then(Value::as_array).map(|list| list.iter().filter(|message| message.get("content").is_some_and(Value::is_string))
        .map(|message| json!({ "id": message.get("id").cloned().unwrap_or(Value::Null), "role": message.get("role").cloned().unwrap_or(Value::Null), "content": message.get("content"), "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null) })).collect()).unwrap_or_default();
    let count = record.get("messages").and_then(Value::as_array).map_or(0, |list| list.iter().filter(|message| message.is_object()).count());
    let mut kept = json!({ "sessionId": record.get("sessionId"), "cwd": record.get("cwd"), "savedAt": record.get("savedAt"), "messages": messages, "messageCount": count });
    if let Some(provider) = record.get("provider").filter(|provider| provider.is_string()) { kept["provider"] = provider.clone(); }
    kept
}

/// A list only re-reads the records that changed since the last one (each turn lists twice).
#[derive(Default)]
struct SummaryCache(std::collections::HashMap<PathBuf, ((u64, u128), Option<Listed>)>);

fn file_stamp(path: &Path) -> Option<(u64, u128)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos()))
}

impl Clone for Listed {
    fn clone(&self) -> Self { Listed { cwd: self.cwd.clone(), id: self.id.clone(), canonical: self.canonical, value: self.value.clone() } }
}

// Global inventory reads saved records only; it never scans project folders. A project folder or a
// record that cannot be read is left out and counted: the others are still listed.
fn scan_sessions(root: &Path, read: &mut dyn FnMut(&Path, &str) -> Result<Option<Listed>, ()>) -> Result<(Vec<Value>, usize), String> {
    let mut sessions: std::collections::HashMap<(PathBuf, String), (bool, Value)> = std::collections::HashMap::new();
    let mut unreadable = 0;
    let namespaces = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((vec![], 0)),
        Err(error) => return Err(error.to_string()),
    };
    for namespace in namespaces.flatten() {
        if !namespace.file_type().map(|kind| kind.is_dir()).unwrap_or(false) { continue; }
        let name = namespace.file_name().to_string_lossy().into_owned();
        let Ok(entries) = fs::read_dir(namespace.path()) else { unreadable += 1; continue; };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) { continue; }
            if entry.path().extension().and_then(|extension| extension.to_str()) != Some("json") { continue; }
            let listed = match read(&entry.path(), &name) {
                Ok(Some(listed)) => listed,
                Ok(None) => continue,
                Err(()) => { unreadable += 1; continue; }
            };
            let key = (listed.cwd, listed.id);
            if sessions.get(&key).is_some_and(|(canonical, _)| *canonical) { continue; }
            sessions.insert(key, (listed.canonical, listed.value));
        }
    }
    let mut records: Vec<_> = sessions.into_values().map(|(_, value)| value).collect();
    records.sort_by_key(|value| std::cmp::Reverse(value.get("savedAt").and_then(Value::as_u64).unwrap_or(0)));
    Ok((records, unreadable))
}

/// What the last list left out because it could not be read (see unreadable_session_count).
static UNREADABLE_SESSIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

static SUMMARIES: std::sync::OnceLock<std::sync::Mutex<SummaryCache>> = std::sync::OnceLock::new();

fn list_summaries_in(root: &Path, cache: &mut SummaryCache) -> Result<(Vec<Value>, usize), String> {
    let mut seen = std::collections::HashSet::new();
    let listed = scan_sessions(root, &mut |path, namespace| {
        seen.insert(path.to_path_buf());
        let stamp = file_stamp(path);
        if let (Some(stamp), Some((held, listed))) = (stamp, cache.0.get(path)) { if *held == stamp { return Ok(listed.clone()); } }
        let listed = read_listed(path, namespace, session_summary)?;
        // A record that cannot be read is read again next time: it may be mid-repair.
        if let Some(stamp) = stamp { cache.0.insert(path.to_path_buf(), (stamp, listed.clone())); }
        Ok(listed)
    })?;
    cache.0.retain(|path, _| seen.contains(path));
    Ok(listed)
}

pub fn list_all_sessions() -> Result<Vec<Value>, String> {
    let mut cache = SUMMARIES.get_or_init(Default::default).lock().map_err(|_| "session list lock poisoned")?;
    let (records, unreadable) = list_summaries_in(&gcode_dir()?.join("projects"), &mut cache)?;
    UNREADABLE_SESSIONS.store(unreadable, std::sync::atomic::Ordering::Relaxed);
    Ok(records)
}

/// The text of every chat, for search while it is open.
pub fn list_searchable_sessions() -> Result<Vec<Value>, String> {
    Ok(scan_sessions(&gcode_dir()?.join("projects"), &mut |path, namespace| read_listed(path, namespace, searchable_record))?.0)
}

pub fn unreadable_session_count() -> usize { UNREADABLE_SESSIONS.load(std::sync::atomic::Ordering::Relaxed) }

pub fn create_project(parent: &str, name: &str) -> Result<String, String> {
    let parent = validate_working_directory(parent)?;
    if name.trim().is_empty() || name != name.trim() || name == "." || name == ".." || name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err("Enter a folder name without slashes or leading/trailing spaces".to_string());
    }
    let path = parent.join(name);
    fs::create_dir(&path).map_err(|error| format!("Could not create project folder: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn create_chat_workspace() -> Result<String, String> {
    let root = gcode_dir()?.join("workspaces");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    let path = root.join(format!("chat-{}-{nonce}", std::process::id()));
    fs::create_dir(&path).map_err(|error| error.to_string())?;
    Ok(fs::canonicalize(path).map_err(|error| error.to_string())?.to_string_lossy().into_owned())
}

fn find_sessions_in(root: &Path, cwd: &Path, id: &str) -> Result<Vec<PathBuf>, String> {
    validate_id(id)?;
    if !fs::symlink_metadata(root).is_ok_and(|metadata| metadata.is_dir()) { return Err("session storage is unavailable or unsafe".to_string()); }
    let mut paths = Vec::new();
    let spellings = saved_path_candidates(cwd)?;
    let resolved = &spellings[0];
    for spelling in &spellings {
      for namespace in [project_hash(spelling), legacy_project_hash(spelling)] {
        let directory = root.join(namespace);
        if !fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir()) { continue; }
        let candidate = directory.join(format!("{id}.json"));
        if !fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) { continue; }
        if let Ok(text) = fs::read_to_string(&candidate) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let bound = value.get("cwd").and_then(Value::as_str).filter(|saved| Path::new(saved).is_absolute())
                    .is_some_and(|saved| canonical_saved_path(Path::new(saved)).is_ok_and(|value| &value == resolved));
                if bound && value.get("sessionId").and_then(Value::as_str) == Some(id) && !paths.contains(&candidate) { paths.push(candidate); }
            }
        }
      }
    }
    if paths.is_empty() { Err("session not found".to_string()) } else { Ok(paths) }
}

fn find_session(id: &str, cwd: &Path) -> Result<PathBuf, String> {
    let root = gcode_dir()?.join("projects");
    find_sessions_in(&root, cwd, id)?.into_iter().next().ok_or("session not found".to_string())
}

pub fn load_session(id: &str, cwd: &str) -> Result<Value, String> {
    let canonical = validate_working_directory(cwd).map_err(|error| {
        if Path::new(cwd).is_absolute() && fs::metadata(cwd).is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
            format!("This chat's folder no longer exists: {cwd}. You can still delete the chat.")
        } else { error }
    })?;
    let path = find_session(id, &canonical)?;
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

/// What deleting a chat could not remove: `failed` keeps the chat (it can be tried again), `linked` does not.
#[derive(Default)]
struct ChatLeftovers { failed: Vec<String>, linked: Vec<String> }

/// Removes one file or folder made for one chat, at `parts` under `base`. Every part must be a real
/// entry: a symbolic link on the way, or the entry itself, is left and reported, never followed.
fn remove_chat_part(base: &Path, parts: &[&str], left: &mut ChatLeftovers) {
    let mut path = base.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => { left.failed.push(format!("{} ({error})", path.display())); return; }
        };
        if metadata.file_type().is_symlink() { left.linked.push(path.display().to_string()); return; }
        if index + 1 < parts.len() && !metadata.is_dir() { return; }
        if index + 1 == parts.len() {
            let removed = if metadata.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            if let Err(error) = removed { if error.kind() != io::ErrorKind::NotFound { left.failed.push(format!("{} ({error})", path.display())); } }
        }
    }
}

/// The folders of a project's personal store, which a session id (a valid name) must not be taken for.
const STORE_FOLDERS: [&str; 4] = ["outputs", "session-memory", "tool-output", "learned"];

/// A chat's own data: its snapshots (each session has its own folder, named by a hash of its id: see
/// storeSnapshot in src/session/outputs.ts), its session notes, and its task records, with the older
/// copies a project may hold. The write journal and tool output are shared by the project's chats and stay.
fn remove_chat_data(store: &Path, project: &Path, id: &str, left: &mut ChatLeftovers) {
    let snapshots = format!("{:x}", Sha256::digest(id.as_bytes()));
    let record = format!("{id}.json");
    remove_chat_part(store, &["outputs", &snapshots], left);
    remove_chat_part(store, &["session-memory", &record], left);
    if !STORE_FOLDERS.contains(&id) { remove_chat_part(store, &[id], left); }
    remove_chat_part(project, &[".gcode", "outputs", &snapshots], left);
    remove_chat_part(project, &[".gcode", "session-memory", &record], left);
    remove_chat_part(project, &[".gcode", "todos", &record], left);
}

/// Deletes a chat and its data. The record goes last: a part that cannot be removed keeps the chat in
/// the list, says which, and can be tried again. Returns what stays for a reason of its own, if anything.
fn delete_session_in(root: &Path, cwd: &Path, id: &str) -> Result<Option<String>, String> {
    // A resumed legacy session may have a newer SHA-256 copy. Remove both
    // bound records so deleting the new copy cannot resurrect the old one.
    let records = find_sessions_in(root, cwd, id)?;
    let project = saved_path_candidates(cwd)?.swap_remove(0);
    // A running G-Code process has this chat open: it goes on using these files, and its next save brings the chat back.
    let open = records.iter().any(|path| session_lock_is_live(&path.with_extension("lock")));
    let mut left = ChatLeftovers::default();
    if !open {
        for path in &records { if let Some(store) = path.parent() { remove_chat_data(store, &project, id, &mut left); } }
    }
    if !left.failed.is_empty() {
        return Err(format!("This chat was not deleted, because part of its data could not be removed: {}. It stays in the list, so you can try again.", left.failed.join(", ")));
    }
    for path in &records {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        remove_session_lock(path);
    }
    if open { return Ok(Some("This chat is open in another G-Code process, so its snapshots, session notes and task records were left for that process.".to_string())); }
    if !left.linked.is_empty() { return Ok(Some(format!("The chat was deleted. These are symbolic links, so G-Code did not follow or remove them: {}.", left.linked.join(", ")))); }
    Ok(None)
}

/// Removes the `<id>.lock` beside a deleted session file (see acquireSessionLock in
/// src/state/store.ts), unless a running G-Code process still holds it: that owner removes its
/// own lock when it closes, and until then a second process must not open the session.
fn remove_session_lock(session_path: &Path) {
    let lock = session_path.with_extension("lock");
    if !session_lock_is_live(&lock) { let _ = fs::remove_file(lock); }
}

/// The engine's rule for a live lock: its pid runs on this machine and it was refreshed within
/// 5 minutes; a lock that cannot be read yet is live for 10 s (its owner may still be writing it).
fn session_lock_is_live(lock: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(lock) else { return false };
    if !metadata.is_file() { return false; }
    let age = metadata.modified().ok().and_then(|time| time.elapsed().ok()).unwrap_or_default();
    let pid = fs::read_to_string(lock).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|owner| owner.get("pid").and_then(Value::as_i64))
        .filter(|pid| *pid > 0 && *pid <= i64::from(i32::MAX));
    match pid {
        None => age < Duration::from_secs(10),
        Some(_) if age > Duration::from_secs(5 * 60) => false,
        Some(pid) => process_exists(pid as i32),
    }
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    // Signal 0 checks without signalling; EPERM means it exists under another user.
    unsafe { libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}
#[cfg(not(unix))]
fn process_exists(_pid: i32) -> bool { true }

pub fn delete_session(id: &str, cwd: &str) -> Result<Option<String>, String> {
    delete_session_in(&gcode_dir()?.join("projects"), Path::new(cwd), id)
}

fn mcp_path() -> Result<PathBuf, String> { Ok(gcode_dir()?.join("mcp.json")) }
pub fn read_mcp() -> Result<Value, String> {
    let path = mcp_path()?;
    if !path.exists() { return Ok(json!({ "mcpServers": {} })); }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

/// The lock `gcode mcp` and every session take to write a file (withWriteLock in
/// src/tools/impl/safeWrite.ts): ~/.gcode/locks/<sha-256 of the file's real path>.lock holding the
/// pid. Where the folder cannot be written it goes without, as they do.
struct FileLock(Option<PathBuf>);
impl Drop for FileLock { fn drop(&mut self) { if let Some(file) = self.0.take() { let _ = fs::remove_file(file); } } }

fn real_target(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| match (path.parent().and_then(|parent| fs::canonicalize(parent).ok()), path.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    })
}

fn lock_file_for(folder: &Path, path: &Path) -> PathBuf {
    folder.join(format!("{:x}.lock", Sha256::digest(real_target(path).to_string_lossy().as_bytes())))
}

fn lock_is_stale(file: &Path) -> bool {
    if fs::metadata(file).ok().and_then(|metadata| metadata.modified().ok()).and_then(|time| time.elapsed().ok()).is_some_and(|age| age > FILE_LOCK_STALE) { return true; }
    // Unreadable or holding no pid: not known to be stale. A pid is stale only when it is known to be gone.
    let Some(pid) = fs::read_to_string(file).ok().and_then(|text| text.trim().parse::<i32>().ok()).filter(|pid| *pid > 0) else { return false };
    !process_exists(pid)
}
const FILE_LOCK_STALE: Duration = Duration::from_secs(30);
const FILE_LOCK_WAIT: Duration = Duration::from_secs(5);

fn take_file_lock(folder: &Path, path: &Path, wait: Duration) -> Result<FileLock, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = lock_file_for(folder, path);
    let deadline = Instant::now() + wait;
    loop {
        match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file) {
            Ok(mut opened) => { let _ = write!(opened, "{}", std::process::id()); return Ok(FileLock(Some(file))); }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                use std::os::unix::fs::DirBuilderExt;
                if fs::DirBuilder::new().recursive(true).mode(0o700).create(folder).is_err() { return Ok(FileLock(None)); }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&file) { let _ = fs::remove_file(&file); }
                else if Instant::now() > deadline { return Err("Another G-Code process has been writing mcp.json for over 5 seconds, so nothing was changed. Try again.".into()); }
                else { std::thread::sleep(Duration::from_millis(10)); }
            }
            Err(_) => return Ok(FileLock(None)),
        }
    }
}

/// `current` with what the panel changed since it read `base` applied. A server `gcode mcp` added or
/// changed meanwhile stays; only a server this save names is replaced.
fn merge_mcp(current: &Value, base: &Value, next: &Value) -> Result<Value, String> {
    let empty = serde_json::Map::new();
    let servers = |value: &Value| value.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_else(|| empty.clone());
    let (base_servers, next_servers) = (servers(base), servers(next));
    let mut merged = servers(current);
    for name in next_servers.keys().chain(base_servers.keys()) {
        match (base_servers.get(name), next_servers.get(name)) {
            (before, after) if before == after => {}
            (_, None) => { merged.remove(name); }
            (before, Some(after)) => {
                if before.is_none() && merged.get(name).is_some_and(|there| there != after) { return Err(format!("A server named \"{name}\" was added elsewhere just now, so nothing was changed. Press Refresh.")); }
                merged.insert(name.clone(), after.clone());
            }
        }
    }
    let mut result = current.as_object().cloned().unwrap_or_default();
    if let (Some(before), Some(after)) = (base.as_object(), next.as_object()) {
        for (key, value) in after { if key != "mcpServers" && before.get(key) != Some(value) { result.insert(key.clone(), value.clone()); } }
    }
    result.insert("mcpServers".into(), Value::Object(merged));
    Ok(Value::Object(result))
}

fn write_mcp_at(path: &Path, folder: &Path, config: &Value, base: Option<&Value>) -> Result<Value, String> {
    let _lock = take_file_lock(folder, path, FILE_LOCK_WAIT)?;
    let merged = match base {
        // Read under the lock: a file that cannot be used is refused, not replaced.
        Some(base) => {
            let current = if path.exists() { serde_json::from_str::<Value>(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())? } else { json!({ "mcpServers": {} }) };
            merge_mcp(&current, base, config)?
        }
        None => config.clone(),
    };
    crate::settings::write_json_atomic(path, &merged).map_err(|error| error.to_string())?;
    Ok(merged)
}

/// `base`: the file as the panel read it, so a change made elsewhere since then survives. Returns the file as written.
pub fn write_mcp(config: &Value, base: Option<&Value>) -> Result<Value, String> {
    write_mcp_at(&mcp_path()?, &gcode_dir()?.join("locks"), config, base)
}
fn mcp_server(server_name: &str) -> Result<Value, String> {
    let config = read_mcp()?;
    config.pointer(&format!("/mcpServers/{}", server_name.replace('~', "~0").replace('/', "~1"))).cloned().ok_or_else(|| "MCP server not found".to_string())
}
/// Whether the server is reached at a URL (it has no local command).
pub fn mcp_server_is_remote(server_name: &str) -> Result<bool, String> {
    Ok(mcp_server(server_name)?.get("url").is_some_and(Value::is_string))
}
pub fn test_mcp(server_name: &str) -> Result<Value, String> {
    let config = read_mcp()?;
    let server = config.pointer(&format!("/mcpServers/{}", server_name.replace('~', "~0").replace('/', "~1"))).ok_or("MCP server not found")?;
    Ok(test_server(server))
}

/// A disabled server is not started, not even to test it: a registry entry runs only once the user has enabled it.
fn test_server(server: &Value) -> Value {
    if server.get("enabled").and_then(Value::as_bool) == Some(false) {
        return json!({ "status": "disabled", "error": "This server is disabled, so it was not started. Enable it first.", "tools": [] });
    }
    match probe_mcp(server) {
        Ok(tools) => json!({ "status": "connected", "tools": tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect::<Vec<_>>() }),
        Err(error) => json!({ "status": "error", "error": error, "tools": [] }),
    }
}

fn probe_mcp(server: &Value) -> Result<Vec<Value>, String> {
    let executable = server.get("command").and_then(Value::as_str).ok_or("MCP command missing")?;
    let mut command = Command::new(executable);
    if let Some(args) = server.get("args").and_then(Value::as_array) {
        for arg in args { command.arg(arg.as_str().ok_or("MCP args must be strings")?); }
    }
    if let Some(env) = server.get("env").and_then(Value::as_object) {
        for (key, value) in env { command.env(key, value.as_str().ok_or("MCP environment values must be strings")?); }
    }
    crate::path_env::configure_tool_command(&mut command);
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("MCP stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("MCP stdout unavailable")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if tx.send(line).is_err() { break; }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut send = |value: Value| -> Result<(), String> {
            writeln!(stdin, "{}", value).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
        };
        send(json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":"2024-11-05", "capabilities":{}, "clientInfo":{"name":"g-code-desktop", "version":"0.1.1"}}}))?;
        let initialized = receive_rpc(&rx, 1, deadline)?;
        if initialized.get("protocolVersion").and_then(Value::as_str).is_none() || !initialized.get("capabilities").is_some_and(Value::is_object) {
            return Err("Invalid MCP initialize response".to_string());
        }
        send(json!({"jsonrpc":"2.0", "method":"notifications/initialized"}))?;
        if initialized.pointer("/capabilities/tools").is_none() { return Ok(vec![]); }
        send(json!({"jsonrpc":"2.0", "id":2, "method":"tools/list", "params":{}}))?;
        let listed = receive_rpc(&rx, 2, deadline)?;
        listed.get("tools").and_then(Value::as_array).cloned().ok_or("Invalid MCP tools/list response".to_string())
    })();
    // Reap the test process on success, failure and timeout.
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn receive_rpc(rx: &mpsc::Receiver<io::Result<String>>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or("MCP handshake timed out")?;
        let line = rx.recv_timeout(remaining).map_err(|_| "MCP server exited or handshake timed out")?.map_err(|e| e.to_string())?;
        // A log line before the handshake is not a failed server: a chat connects to it (src/mcp/client.ts).
        let Ok(response) = serde_json::from_str::<Value>(&line) else { continue };
        if response.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return Err("Invalid JSON-RPC version".to_string()); }
        if let Some(error) = response.get("error") { return Err(format!("MCP request failed: {error}")); }
        return response.get("result").cloned().ok_or("MCP response has no result".to_string());
    }
}

/// Preview only tracked outputs of the bound session, never execute an output.
pub fn read_session_output(cwd: &str, session_id: &str, path: &str, version_id: Option<&str>) -> Result<Value, String> {
    let root = validate_working_directory(cwd)?;
    let session = load_session(session_id, cwd)?;
    preview_output_version(&root, &session, path, version_id)
}

pub fn tracked_output_path(root: &Path, session: &Value, path: &str, version_id: Option<&str>) -> Result<PathBuf, String> {
    let personal = dirs::home_dir().and_then(|home| home.canonicalize().ok()).map(|home| home.join(".gcode/projects").join(project_hash(root)).join("outputs"));
    tracked_output_path_in(root, personal.as_deref(), session, path, version_id)
}

/// Accept only the personal project's snapshot root and the original project root.
fn tracked_output_path_in(root: &Path, personal: Option<&Path>, session: &Value, path: &str, version_id: Option<&str>) -> Result<PathBuf, String> {
    let tracked = session.get("outputs").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item.get("path").and_then(Value::as_str) == Some(path))).ok_or("This file is not a tracked output of this session")?;
    let version = match version_id {
        // The file before this session first changed it (written by the engine as a snapshot).
        Some("baseline") => Some(tracked.get("baseline").filter(|b| b.get("absent").and_then(Value::as_bool) != Some(true)).ok_or("No copy from before this session's first change was saved")?),
        Some(id) => Some(tracked.get("versions").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id))).ok_or(
            if tracked.get("droppedVersions").is_some() { "This version is no longer kept: G-Code keeps the copy from before the session and the last 20 versions of each file." } else { "Output version is not part of this session" })?),
        None => None,
    };
    if version.is_some_and(|version| version.get("notKept").is_some()) { return Err("This copy was not kept: the file held a known API key or token, so G-Code saved no copy of it.".into()); }
    let selected = if let Some(version) = version { version.get("snapshotPath").and_then(Value::as_str).ok_or("Snapshot path missing")? } else { path };
    let canonical = fs::canonicalize(selected).map_err(|e| format!("Output is unavailable: {e}"))?;
    if !canonical.is_file() || (version.is_none() && !canonical.starts_with(root)) { return Err("Output must remain inside this project".into()); }
    if let Some(version) = version {
        use sha2::{Digest, Sha256};
        let legacy = root.join(".gcode/outputs");
        let selected = Path::new(selected);
        let allowed = [Some(legacy.as_path()), personal].into_iter().flatten().any(|folder| {
            selected.starts_with(folder) && canonical.starts_with(folder)
                && fs::canonicalize(folder).ok().as_deref() == Some(folder)
        });
        if !allowed || selected.components().any(|part| matches!(part, std::path::Component::ParentDir)) { return Err("Invalid output snapshot location".into()); }
        if fs::metadata(&canonical).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 { return Err("Snapshot exceeds 64 MiB".into()); }
        let digest = format!("{:x}", Sha256::digest(fs::read(&canonical).map_err(|e| e.to_string())?));
        if version.get("sha256").and_then(Value::as_str) != Some(&digest) { return Err("Output snapshot integrity check failed".into()); }
    }
    Ok(canonical)
}

fn preview_output_version(root: &Path, session: &Value, path: &str, version_id: Option<&str>) -> Result<Value, String> {
    if version_id == Some("baseline") {
        let tracked = session.get("outputs").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item.get("path").and_then(Value::as_str) == Some(path)));
        if tracked.and_then(|item| item.pointer("/baseline/absent")).and_then(Value::as_bool) == Some(true) {
            return Ok(json!({ "content": "", "bytes": 0, "truncated": false, "binary": false, "absent": true }));
        }
    }
    let canonical = tracked_output_path(root, session, path, version_id)?;
    use std::io::Read;
    let extension = canonical.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let file = fs::File::open(canonical).map_err(|e| e.to_string())?;
    let bytes = file.metadata().map_err(|e| e.to_string())?.len();
    let mut buffer = Vec::new();
    let image = matches!(extension.as_str(), "png" | "jpg" | "jpeg") && bytes <= 5 * 1024 * 1024;
    file.take(if image { 5 * 1024 * 1024 } else { 256 * 1024 }).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    let mime = if image && buffer.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
        else if image && buffer.starts_with(&[0xff, 0xd8, 0xff]) { Some("image/jpeg") } else { None };
    if let Some(mime) = mime {
        return Ok(json!({"content":"", "bytes":bytes, "truncated":false, "binary":true, "imageDataUrl":format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buffer))}));
    }
    let binary = buffer.contains(&0);
    Ok(json!({ "content": if binary { String::new() } else { String::from_utf8_lossy(&buffer).into_owned() }, "bytes": bytes, "truncated": bytes > buffer.len() as u64, "binary": binary }))
}
