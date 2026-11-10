// The right side panel's native helpers: the Files tree, opening a file or
// showing it in Finder, keeping the Mac awake, a static server for the
// Browser view, and a file's last committed copy for the Changes view.
// Every path is resolved and must stay inside the project folder.

use std::borrow::Cow;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::storage::validate_working_directory;

/// `path` resolved inside `root` (symlinks followed), or an error.
fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    let canonical = fs::canonicalize(&candidate).map_err(|e| format!("{}: {e}", candidate.display()))?;
    if !canonical.starts_with(root) { return Err("That path is outside the project folder".into()); }
    Ok(canonical)
}

const SKIP: [&str; 2] = [".DS_Store", ".localized"];
const MAX_ENTRIES: usize = 3000;

/// One folder level for the Files tree: folders first, then files, by name.
pub fn list_directory(cwd: &str, path: Option<&str>) -> Result<Value, String> {
    let root = validate_working_directory(cwd)?;
    let directory = match path { Some(path) => inside(&root, path)?, None => root.clone() };
    if !directory.is_dir() { return Err("Not a folder".into()); }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP.contains(&name.as_str()) { continue; }
        if entries.len() >= MAX_ENTRIES { truncated = true; break; }
        let link = entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false);
        let metadata = fs::metadata(entry.path()).ok();
        let folder = metadata.as_ref().is_some_and(|meta| meta.is_dir());
        let modified = metadata.as_ref().and_then(|meta| meta.modified().ok()).and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
        entries.push(json!({
            "name": name, "path": entry.path().to_string_lossy(), "dir": folder, "link": link,
            "size": metadata.as_ref().filter(|meta| meta.is_file()).map(|meta| meta.len()), "modified": modified,
        }));
    }
    entries.sort_by(|a, b| {
        let folder = |v: &Value| v["dir"].as_bool().unwrap_or(false);
        folder(b).cmp(&folder(a)).then_with(|| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()))
    });
    Ok(json!({ "path": directory.to_string_lossy(), "entries": entries, "truncated": truncated }))
}

/// `path` opened for reading, only when it is a regular file. Opening a FIFO
/// waits for a writer and a device can act on open, so the type is checked
/// first; O_NONBLOCK keeps one swapped in after the check from blocking the
/// open (regular files ignore the flag), and the opened handle is checked again.
fn open_regular(path: &Path) -> std::io::Result<fs::File> {
    if !fs::metadata(path)?.is_file() { return Err(not_regular()); }
    open_nonblocking(path)
}

fn not_regular() -> std::io::Error { std::io::Error::new(std::io::ErrorKind::InvalidInput, "Not a regular file") }

/// `path` opened for reading with O_NONBLOCK, kept only when the handle is a regular file.
fn open_nonblocking(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { return Err(not_regular()); }
    // Back to ordinary reads: the flag was only there to keep the open itself from blocking.
    #[cfg(unix)] {
        use std::os::fd::AsRawFd;
        let fd = file.as_raw_fd();
        // SAFETY: fcntl on a descriptor this function owns, changing only its status flags.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags >= 0 { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK); }
        }
    }
    Ok(file)
}

/// Text (first 256 KB), a PNG/JPEG/GIF/WebP/SVG image, or a binary notice.
pub fn preview_file(file: &Path) -> Result<Value, String> {
    let extension = file.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let handle = open_regular(file).map_err(|e| e.to_string())?;
    let bytes = handle.metadata().map_err(|e| e.to_string())?.len();
    let image_mime = match extension.as_str() { "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "gif" => Some("image/gif"), "webp" => Some("image/webp"), "svg" => Some("image/svg+xml"), _ => None };
    let image = image_mime.is_some() && bytes <= 8 * 1024 * 1024;
    let mut buffer = Vec::new();
    handle.take(if image { 8 * 1024 * 1024 } else { 256 * 1024 }).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    if let (true, Some(mime)) = (image, image_mime) {
        use base64::Engine;
        let text = if extension == "svg" { String::from_utf8_lossy(&buffer).into_owned() } else { String::new() };
        return Ok(json!({ "content": text, "bytes": bytes, "truncated": false, "binary": extension != "svg", "imageDataUrl": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buffer)) }));
    }
    let binary = buffer.contains(&0);
    Ok(json!({ "content": if binary { String::new() } else { String::from_utf8_lossy(&buffer).into_owned() }, "bytes": bytes, "truncated": bytes > buffer.len() as u64, "binary": binary }))
}

pub fn read_project_file(cwd: &str, path: &str) -> Result<Value, String> {
    let root = validate_working_directory(cwd)?;
    let file = inside(&root, path)?;
    if !file.is_file() { return Err("Not a file".into()); }
    preview_file(&file)
}

/// Extensions whose default handler runs, installs or loads the file.
const PROGRAM_EXTENSIONS: [&str; 44] = [
    // Apps, installers, automation, and links Finder follows.
    "app", "command", "tool", "terminal", "workflow", "action", "scpt", "scptd", "applescript", "pkg", "mpkg", "jar", "webloc", "inetloc", "fileloc", "mobileconfig",
    // Scripts an interpreter may run when opened.
    "py", "pyw", "rb", "pl", "sh", "zsh", "bash", "fish", "ksh", "csh", "tcl", "lua", "php", "swift",
    // Bundles and plug-ins that install or load themselves.
    "saver", "qlgenerator", "plugin", "bundle", "appex", "service", "wdgt", "osax", "component", "xpc", "framework", "dylib", "kext", "prefpane",
];

/// A Finder alias: bookmark data starts with "book", with "mark" at byte 8. Only regular files are read.
fn is_finder_alias(path: &Path) -> bool {
    let mut header = Vec::with_capacity(16);
    let read = open_regular(path).and_then(|file| file.take(16).read_to_end(&mut header));
    read.is_ok() && header.len() >= 12 && header.starts_with(b"book") && &header[8..12] == b"mark"
}

/// Bundles, installers, scripts and aliases that run (or lead somewhere else) when opened stay behind "Show in Finder",
/// and so does anything that is neither a regular file nor a folder (a FIFO, a socket, a device).
fn opens_as_program(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if PROGRAM_EXTENSIONS.contains(&extension.as_str()) { return true; }
    let Ok(metadata) = fs::metadata(path) else { return true };
    // Any folder with an Info.plist in Contents is a bundle, whatever its name.
    if metadata.is_dir() { return path.join("Contents").join("Info.plist").exists(); }
    if !metadata.is_file() { return true; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 { return true; }
    }
    is_finder_alias(path)
}

/// Opens a project file in its default app (like a double-click in Finder).
pub fn open_path(cwd: &str, path: &str) -> Result<(), String> {
    let root = validate_working_directory(cwd)?;
    let target = inside(&root, path)?;
    let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
    if !metadata.is_file() && !metadata.is_dir() { return Err("Only files and folders can be opened.".into()); }
    if opens_as_program(&target) { return Err("This file would run as a program. Use Show in Finder to open it yourself.".into()); }
    run_open(Command::new("/usr/bin/open").arg("--").arg(&target))
}

/// Selects a project file or folder in a Finder window.
pub fn reveal_path(cwd: &str, path: &str) -> Result<(), String> {
    let root = validate_working_directory(cwd)?;
    let target = inside(&root, path)?;
    run_open(Command::new("/usr/bin/open").arg("-R").arg("--").arg(&target))
}

fn run_open(command: &mut Command) -> Result<(), String> {
    let output = command.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

/// git's output up to `limit` bytes (then it is stopped: a blob can be hundreds of MB), within `timeout`:
/// a stalled mount or a blocked pipe in a repository must not leave the Changes view waiting for good.
fn git_bounded(mut command: Command, limit: u64, timeout: Duration) -> Result<(bool, Vec<u8>), String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("git stdout unavailable")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let mut bytes = Vec::new(); let read = stdout.take(limit).read_to_end(&mut bytes); let _ = send.send(read.map(|_| bytes)); });
    let stop = |child: &mut Child| {
        #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();
        let _ = child.wait();
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match receive.recv_timeout(Duration::from_millis(20)) {
            Ok(read) => {
                let bytes = read.map_err(|e| e.to_string())?;
                // Everything it had or all that is wanted: wait for its status only if it can still exit by itself.
                if bytes.len() as u64 >= limit { stop(&mut child); return Ok((true, bytes)); }
                while std::time::Instant::now() < deadline {
                    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Ok((status.success(), bytes)); }
                    std::thread::sleep(Duration::from_millis(5));
                }
                stop(&mut child);
                return Err(GIT_TIMEOUT.into());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if std::time::Instant::now() >= deadline => { stop(&mut child); return Err(GIT_TIMEOUT.into()); }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => { stop(&mut child); return Err("git output was lost".into()); }
        }
    }
}
const GIT_TIMEOUT: &str = "git did not answer in time, so this file's last committed version is not shown.";
const GIT_HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_HEAD_BYTES: usize = 256 * 1024;

/// The file as of the last commit, when the project is a git repository.
pub fn git_head_file(cwd: &str, path: &str) -> Result<Value, String> { git_head_file_within(cwd, path, GIT_HEAD_TIMEOUT) }

fn git_head_file_within(cwd: &str, path: &str, timeout: Duration) -> Result<Value, String> {
    let root = validate_working_directory(cwd)?;
    let candidate = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    let parent = candidate.parent().and_then(|p| fs::canonicalize(p).ok()).ok_or("The file's folder is missing")?;
    if !parent.starts_with(&root) { return Err("That path is outside the project folder".into()); }
    let target = parent.join(candidate.file_name().ok_or("Not a file")?);
    let git = |args: &[&str], at: &Path| { let mut command = Command::new("/usr/bin/git"); command.arg("-C").arg(at).args(args); command };
    let (ok, top) = git_bounded(git(&["rev-parse", "--show-toplevel"], &root), 64 * 1024, timeout)?;
    if !ok { return Err("Not a git repository".into()); }
    let top = fs::canonicalize(String::from_utf8_lossy(&top).trim()).map_err(|e| e.to_string())?;
    let relative = target.strip_prefix(&top).map_err(|_| "Outside the repository")?;
    let spec = format!("HEAD:{}", relative.to_string_lossy());
    let (ok, size) = git_bounded(git(&["cat-file", "-s", &spec], &top), 64, timeout)?;
    if !ok { return Ok(json!({ "absent": true, "content": "", "bytes": 0 })); }
    let bytes = String::from_utf8_lossy(&size).trim().parse::<usize>().map_err(|_| "git gave no size for this file")?;
    let (_, shown) = git_bounded(git(&["show", &spec], &top), (GIT_HEAD_BYTES + 1) as u64, timeout)?;
    let shown = &shown[..shown.len().min(GIT_HEAD_BYTES)];
    let binary = shown.contains(&0);
    let content = if binary { String::new() } else { String::from_utf8_lossy(shown).into_owned() };
    Ok(json!({ "content": content, "bytes": bytes, "truncated": bytes > GIT_HEAD_BYTES, "binary": binary }))
}

// ---------------------------------------------------------------------------
// Keep awake: `caffeinate` holds off idle and system sleep (the display may
// still sleep) and exits on its own if G-Code goes away (-w).
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct KeepAwakeState(Mutex<Option<Child>>);

pub fn set_keep_awake(state: &KeepAwakeState, active: bool) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|_| "Keep-awake lock poisoned")?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().ok().flatten().is_some() { *guard = None; }
    }
    match (active, guard.is_some()) {
        (true, false) => {
            let child = Command::new("/usr/bin/caffeinate").args(["-i", "-m", "-s", "-w", &std::process::id().to_string()])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not keep the Mac awake: {e}"))?;
            *guard = Some(child);
        }
        (false, true) => {
            if let Some(mut child) = guard.take() { let _ = child.kill(); let _ = child.wait(); }
        }
        _ => {}
    }
    Ok(guard.is_some())
}

pub fn release_keep_awake(state: &KeepAwakeState) { let _ = set_keep_awake(state, false); }

// ---------------------------------------------------------------------------
// Browser view: a static file server on 127.0.0.1 for built pages (dist/,
// index.html). HTML pages get a small script that reports their address and
// errors to the panel; nothing else is changed. Dotfiles and dot-folders are
// never served, and only requests addressed to 127.0.0.1 or localhost on the
// server's own port are answered (a DNS-rebinding page names another host).
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct PreviewState(Mutex<Option<(PathBuf, u16, tauri::async_runtime::JoinHandle<()>)>>);

const REPORTER: &str = r#"<script>(function(){if(parent===window)return;function s(t,d){try{parent.postMessage(Object.assign({source:'gcode-preview',type:t},d),'*')}catch(e){}}function l(){s('location',{href:location.href,title:document.title})}addEventListener('load',l);addEventListener('hashchange',l);addEventListener('popstate',l);var p=history.pushState,r=history.replaceState;history.pushState=function(){p.apply(this,arguments);l()};history.replaceState=function(){r.apply(this,arguments);l()};addEventListener('error',function(e){s('error',{message:String(e.message||e)})});addEventListener('unhandledrejection',function(e){s('error',{message:'Unhandled rejection: '+String(e.reason&&e.reason.message||e.reason)})});var c=console.error;console.error=function(){s('error',{message:Array.prototype.map.call(arguments,String).join(' ')});return c.apply(console,arguments)}})();</script>"#;

/// Connections served at once; the next ones get 503 (see turn_away).
const MAX_CONNECTIONS: usize = 32;
/// Connections being turned away at once. Each may hold its socket for up to
/// BUSY_DEADLINE, so past this many a connection is closed as soon as it is
/// accepted: a crowd of silent clients cannot use up the app's file
/// descriptors (256 by default on macOS).
const MAX_TURN_AWAYS: usize = 16;
/// How long a turned-away client has to send its request head before the 503 goes out.
const BUSY_WAIT: Duration = Duration::from_millis(500);
/// The most time and bytes a turned-away connection is given in all.
const BUSY_DEADLINE: Duration = Duration::from_secs(2);
const BUSY_READ_LIMIT: usize = 8 * 1024;
/// HTML up to this size gets the reporter; larger pages are streamed as they are.
const MAX_REPORTED_HTML: u64 = 16 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
/// A client that takes no bytes for this long (a paused video, say) is dropped; it can resume with a Range request.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
const BUSY: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nRetry-After: 1\r\nConnection: close\r\n\r\nBusy";

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        // An HTML page's charset comes from its own bytes: see html_type.
        "html" | "htm" => "text/html", "css" => "text/css; charset=utf-8", "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json", "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
        "webp" => "image/webp", "avif" => "image/avif", "ico" => "image/x-icon", "woff" => "font/woff", "woff2" => "font/woff2", "ttf" => "font/ttf", "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8", "xml" => "application/xml", "wasm" => "application/wasm", "mp4" => "video/mp4", "webm" => "video/webm",
        "mov" => "video/quicktime", "m4v" => "video/x-m4v", "ogv" => "video/ogg", "ogg" | "oga" => "audio/ogg", "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg", "wav" => "audio/wav", "pdf" => "application/pdf", _ => "application/octet-stream",
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) { out.push(high * 16 + low); index += 3; continue; }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Dotfiles and dot-folders (.env, .git, .npmrc, .gcode, also . and ..) stay private; .well-known is public by design.
fn hidden(name: &[u8]) -> bool { name.starts_with(b".") && name != b".well-known" }

/// `candidate` with symlinks followed, when that is a file inside `root` with no hidden part.
fn served(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let path = fs::canonicalize(candidate).ok()?;
    let relative = path.strip_prefix(root).ok()?;
    if relative.components().any(|part| hidden(part.as_os_str().as_encoded_bytes())) { return None; }
    path.is_file().then_some(path)
}

/// Which file answers a request path: the file, a folder's index.html, or the
/// root index.html for client-side routes (paths without an extension).
fn resolve_request(root: &Path, request_path: &str) -> Option<PathBuf> {
    let clean = percent_decode(request_path.split(['?', '#']).next().unwrap_or("/"));
    let relative = clean.trim_start_matches('/');
    if relative.split('/').any(|part| hidden(part.as_bytes())) { return None; }
    let candidate = root.join(relative);
    match fs::metadata(&candidate) {
        Ok(metadata) if metadata.is_dir() => served(root, &candidate.join("index.html")),
        Ok(_) => served(root, &candidate),
        Err(_) if Path::new(relative).extension().is_none() => served(root, &root.join("index.html")),
        Err(_) => None,
    }
}

fn starts_with_ignore_case(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `name` (any case) ending where a tag name ends: at whitespace, `/` or `>`.
fn names(bytes: &[u8], name: &[u8]) -> bool {
    starts_with_ignore_case(bytes, name) && bytes.get(name.len()).is_some_and(|next| next.is_ascii_whitespace() || matches!(next, b'/' | b'>'))
}

/// `<name` as a whole tag name (so `<head` and `<head/` match, `<header` does not).
fn opens_tag(bytes: &[u8], name: &[u8]) -> bool {
    bytes.first() == Some(&b'<') && names(&bytes[1..], name)
}

/// Just past the `>` that closes the tag starting at `start` (`<name` or
/// `</name`), read the way the HTML tokenizer reads attributes: a quote opens
/// a value only right after `=` (`alt="a>b"`); anywhere else (`alt=don't`)
/// it is an ordinary character.
fn tag_end(html: &[u8], start: usize) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum At { TagName, BeforeName, Name, AfterName, BeforeValue, Unquoted, Quoted(u8) }
    let mut state = At::TagName;
    // An end tag's name starts after its '/', which must not be read as the
    // end of the name: `</script ="a>b">` ends at the first '>', where the
    // `="a` is an attribute name, not a quoted value.
    let name = if html.get(start + 1) == Some(&b'/') { start + 2 } else { start + 1 };
    for (offset, &byte) in html.iter().enumerate().skip(name) {
        let space = byte.is_ascii_whitespace();
        if byte == b'>' && !matches!(state, At::Quoted(_)) { return Some(offset + 1); }
        state = match state {
            At::Quoted(quote) => if byte == quote { At::BeforeName } else { state },
            At::TagName => if space || byte == b'/' { At::BeforeName } else { state },
            At::BeforeName => if space || byte == b'/' { state } else { At::Name },
            At::Name => if space { At::AfterName } else if byte == b'/' { At::BeforeName } else if byte == b'=' { At::BeforeValue } else { state },
            At::AfterName => if space { state } else if byte == b'/' { At::BeforeName } else if byte == b'=' { At::BeforeValue } else { At::Name },
            At::BeforeValue => if space { state } else if byte == b'"' || byte == b'\'' { At::Quoted(byte) } else { At::Unquoted },
            At::Unquoted => if space { At::BeforeName } else { state },
        };
    }
    None
}

/// Just past the comment starting at `start` (`<!--`): at `-->`, at once for
/// `<!-->` and `<!--->`, or at `--!>` whose dashes come after the opener's
/// own. In `<!--!>` and `<!---!>` the `!>` is comment text, so the comment
/// goes on.
fn comment_end(html: &[u8], start: usize) -> Option<usize> {
    (start + 2..html.len()).find_map(|at| {
        let rest = &html[at..];
        if rest.starts_with(b"-->") { Some(at + 3) } else if at >= start + 4 && rest.starts_with(b"--!>") { Some(at + 4) } else { None }
    })
}

/// Elements whose contents are text up to their own end tag, not markup.
const RAW_TEXT: [&[u8]; 9] = [b"script", b"style", b"textarea", b"title", b"xmp", b"iframe", b"noembed", b"noframes", b"noscript"];

/// Just past the end tag of the raw-text element `name` whose text starts at `from`.
fn raw_text_end(html: &[u8], from: usize, name: &[u8]) -> Option<usize> {
    let mut at = from;
    while let Some(found) = html[at..].windows(2).position(|pair| pair == b"</") {
        let tag = at + found;
        if names(&html[tag + 2..], name) { return tag_end(html, tag); }
        at = tag + 2;
    }
    None
}

/// Just past the `</script>` that ends a script whose text starts at `from`,
/// following the tokenizer's script data states. After a `<!--`, a `<script`
/// starts a double-escaped stretch in which `</script>` does not end the
/// script (an old-style `<!-- document.write('<script></script>') -->`);
/// the stretch ends at its own `</script>`, and `-->` ends both.
fn script_end(html: &[u8], from: usize) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum At { Data, Escaped, DoubleEscaped }
    let (mut state, mut dashes, mut at) = (At::Data, 0usize, from);
    while at < html.len() {
        let rest = &html[at..];
        let closes = rest.starts_with(b"</") && names(&rest[2..], b"script");
        match state {
            At::Data if rest.starts_with(b"<!--") => { state = At::Escaped; dashes = 2; at += 4; continue; }
            At::Data | At::Escaped if closes => return tag_end(html, at),
            At::Data => {}
            _ if rest[0] == b'-' => { dashes += 1; at += 1; continue; }
            _ if rest[0] == b'>' && dashes >= 2 => state = At::Data,
            At::Escaped if opens_tag(rest, b"script") => { state = At::DoubleEscaped; at += b"<script".len(); dashes = 0; continue; }
            At::DoubleEscaped if closes => { state = At::Escaped; at += b"</script".len(); dashes = 0; continue; }
            _ => {}
        }
        dashes = 0;
        at += 1;
    }
    None
}

/// Where the reporter goes: just inside <head>, else after the <html> tag or
/// the doctype, else at the start (after a byte-order mark). Comments,
/// attribute values and the text of <script>, <style>, <title>, <textarea>
/// and the other raw-text elements are skipped, so a "<head>" in them is not
/// taken for the tag. Never before the doctype, which would put the page in
/// quirks mode: a doctype with no '>' runs to the end of the page, so there
/// is nowhere safe for the reporter and the result is None.
fn reporter_offset(html: &[u8]) -> Option<usize> {
    let mut floor = if html.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
    let (mut root, mut doctype) = (None, false);
    let mut at = floor;
    while let Some(found) = html[at..].iter().position(|byte| *byte == b'<') {
        let tag = at + found;
        let rest = &html[tag..];
        if rest.starts_with(b"<!--") {
            let Some(end) = comment_end(html, tag) else { break };
            at = end;
            continue;
        }
        if starts_with_ignore_case(rest, b"<!doctype") {
            // Every doctype state ends at the first '>', quoted identifiers included.
            let Some(close) = rest.iter().position(|byte| *byte == b'>') else {
                if doctype { break } else { return None }
            };
            floor = floor.max(tag + close + 1);
            doctype = true;
            at = tag + close + 1;
            continue;
        }
        let start_tag = rest.get(1).is_some_and(u8::is_ascii_alphabetic);
        let end_tag = rest.get(1) == Some(&b'/') && rest.get(2).is_some_and(u8::is_ascii_alphabetic);
        if !start_tag && !end_tag {
            // `<!x>`, `<?xml ...?>` and `</ x>` are bogus comments up to the first '>'; any other '<' is text.
            if rest.starts_with(b"<!") || rest.starts_with(b"<?") || rest.starts_with(b"</") {
                let Some(close) = rest.iter().position(|byte| *byte == b'>') else { break };
                at = tag + close + 1;
            } else {
                at = tag + 1;
            }
            continue;
        }
        if start_tag && (opens_tag(rest, b"body") || opens_tag(rest, b"plaintext")) { break; }
        let Some(end) = tag_end(html, tag) else { break };
        if !start_tag { at = end; continue; }
        if opens_tag(rest, b"head") { return Some(end.max(floor)); }
        if root.is_none() && opens_tag(rest, b"html") { root = Some(end); }
        at = match RAW_TEXT.iter().find(|name| opens_tag(rest, name)) {
            Some(name) => {
                let close = if *name == b"script" { script_end(html, end) } else { raw_text_end(html, end, name) };
                let Some(close) = close else { break };
                close
            }
            None => end,
        };
    }
    Some(root.unwrap_or(0).max(floor))
}

/// The page with the reporter added; every other byte is left as it was, whatever the encoding.
fn with_reporter(html: &[u8]) -> Vec<u8> {
    // ASCII bytes would corrupt a UTF-16 page, so it goes out unreported.
    if html.starts_with(b"\xFF\xFE") || html.starts_with(b"\xFE\xFF") { return html.to_vec(); }
    match reporter_offset(html) {
        Some(at) => [&html[..at], REPORTER.as_bytes(), &html[at..]].concat(),
        None => html.to_vec(),
    }
}

/// How far into a page the browser's prescan looks for a <meta> naming its encoding.
const PRESCAN: usize = 1024;

/// Every encoding of the WHATWG Encoding Standard with the labels that name
/// it. A <meta> with any other label is passed over, as the browser does.
const ENCODINGS: &[(&str, &[&str])] = &[
    ("UTF-8", &["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"]),
    ("IBM866", &["866", "cp866", "csibm866", "ibm866"]),
    ("ISO-8859-2", &["csisolatin2", "iso-8859-2", "iso-ir-101", "iso8859-2", "iso88592", "iso_8859-2", "iso_8859-2:1987", "l2", "latin2"]),
    ("ISO-8859-3", &["csisolatin3", "iso-8859-3", "iso-ir-109", "iso8859-3", "iso88593", "iso_8859-3", "iso_8859-3:1988", "l3", "latin3"]),
    ("ISO-8859-4", &["csisolatin4", "iso-8859-4", "iso-ir-110", "iso8859-4", "iso88594", "iso_8859-4", "iso_8859-4:1988", "l4", "latin4"]),
    ("ISO-8859-5", &["csisolatincyrillic", "cyrillic", "iso-8859-5", "iso-ir-144", "iso8859-5", "iso88595", "iso_8859-5", "iso_8859-5:1988"]),
    ("ISO-8859-6", &["arabic", "asmo-708", "csiso88596e", "csiso88596i", "csisolatinarabic", "ecma-114", "iso-8859-6", "iso-8859-6-e", "iso-8859-6-i", "iso-ir-127", "iso8859-6", "iso88596", "iso_8859-6", "iso_8859-6:1987"]),
    ("ISO-8859-7", &["csisolatingreek", "ecma-118", "elot_928", "greek", "greek8", "iso-8859-7", "iso-ir-126", "iso8859-7", "iso88597", "iso_8859-7", "iso_8859-7:1987", "sun_eu_greek"]),
    ("ISO-8859-8", &["csiso88598e", "csisolatinhebrew", "hebrew", "iso-8859-8", "iso-8859-8-e", "iso-ir-138", "iso8859-8", "iso88598", "iso_8859-8", "iso_8859-8:1988", "visual"]),
    ("ISO-8859-8-I", &["csiso88598i", "iso-8859-8-i", "logical"]),
    ("ISO-8859-10", &["csisolatin6", "iso-8859-10", "iso-ir-157", "iso8859-10", "iso885910", "l6", "latin6"]),
    ("ISO-8859-13", &["iso-8859-13", "iso8859-13", "iso885913"]),
    ("ISO-8859-14", &["iso-8859-14", "iso8859-14", "iso885914"]),
    ("ISO-8859-15", &["csisolatin9", "iso-8859-15", "iso8859-15", "iso885915", "iso_8859-15", "l9"]),
    ("ISO-8859-16", &["iso-8859-16"]),
    ("KOI8-R", &["cskoi8r", "koi", "koi8", "koi8-r", "koi8_r"]),
    ("KOI8-U", &["koi8-ru", "koi8-u"]),
    ("macintosh", &["csmacintosh", "mac", "macintosh", "x-mac-roman"]),
    ("windows-874", &["dos-874", "iso-8859-11", "iso8859-11", "iso885911", "tis-620", "windows-874"]),
    ("windows-1250", &["cp1250", "windows-1250", "x-cp1250"]),
    ("windows-1251", &["cp1251", "windows-1251", "x-cp1251"]),
    ("windows-1252", &["ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252"]),
    ("windows-1253", &["cp1253", "windows-1253", "x-cp1253"]),
    ("windows-1254", &["cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9", "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254"]),
    ("windows-1255", &["cp1255", "windows-1255", "x-cp1255"]),
    ("windows-1256", &["cp1256", "windows-1256", "x-cp1256"]),
    ("windows-1257", &["cp1257", "windows-1257", "x-cp1257"]),
    ("windows-1258", &["cp1258", "windows-1258", "x-cp1258"]),
    ("x-mac-cyrillic", &["x-mac-cyrillic", "x-mac-ukrainian"]),
    ("GBK", &["chinese", "csgb2312", "csiso58gb231280", "gb2312", "gb_2312", "gb_2312-80", "gbk", "iso-ir-58", "x-gbk"]),
    ("gb18030", &["gb18030"]),
    ("Big5", &["big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5"]),
    ("EUC-JP", &["cseucpkdfmtjapanese", "euc-jp", "x-euc-jp"]),
    ("ISO-2022-JP", &["csiso2022jp", "iso-2022-jp"]),
    ("Shift_JIS", &["csshiftjis", "ms932", "ms_kanji", "shift-jis", "shift_jis", "sjis", "windows-31j", "x-sjis"]),
    ("EUC-KR", &["cseuckr", "csksc56011987", "euc-kr", "iso-ir-149", "korean", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "windows-949"]),
    ("replacement", &["csiso2022kr", "hz-gb-2312", "iso-2022-cn", "iso-2022-cn-ext", "iso-2022-kr", "replacement"]),
    ("UTF-16BE", &["unicodefffe", "utf-16be"]),
    ("UTF-16LE", &["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"]),
    ("x-user-defined", &["x-user-defined"]),
];

/// The label a <meta> gives, as the prescan settles it and as a header can
/// repeat it: surrounding whitespace dropped, a UTF-16 label read as UTF-8
/// and x-user-defined as windows-1252. None for a label the Encoding
/// Standard does not know.
fn prescan_label(label: &[u8]) -> Option<&'static str> {
    let start = label.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(label.len());
    let end = label.iter().rposition(|byte| !byte.is_ascii_whitespace()).map_or(start, |last| last + 1);
    let label = &label[start..end];
    let (encoding, known) = ENCODINGS.iter().find_map(|(encoding, labels)| {
        labels.iter().find(|known| known.as_bytes().eq_ignore_ascii_case(label)).map(|known| (*encoding, *known))
    })?;
    Some(match encoding { "UTF-16BE" | "UTF-16LE" => "utf-8", "x-user-defined" => "windows-1252", _ => known })
}

/// One attribute of the tag being prescanned, from `*at`: the name and value
/// lowercased, as the HTML spec's "get an attribute" reads them. None at the
/// tag's `>` (left at `*at`) or at the end of the bytes.
fn prescan_attribute(bytes: &[u8], at: &mut usize) -> Option<(Vec<u8>, Vec<u8>)> {
    let space = |byte: u8| byte.is_ascii_whitespace();
    while *at < bytes.len() && (space(bytes[*at]) || bytes[*at] == b'/') { *at += 1; }
    if *at >= bytes.len() || bytes[*at] == b'>' { return None; }
    let (mut name, mut value) = (Vec::new(), Vec::new());
    loop {
        let byte = *bytes.get(*at)?;
        if byte == b'=' && !name.is_empty() { *at += 1; break; }
        if space(byte) {
            while bytes.get(*at).is_some_and(|byte| space(*byte)) { *at += 1; }
            if bytes.get(*at) != Some(&b'=') { return Some((name, value)); }
            *at += 1;
            break;
        }
        if byte == b'/' || byte == b'>' { return Some((name, value)); }
        name.push(byte.to_ascii_lowercase());
        *at += 1;
    }
    while bytes.get(*at).is_some_and(|byte| space(*byte)) { *at += 1; }
    match *bytes.get(*at)? {
        quote @ (b'"' | b'\'') => {
            *at += 1;
            loop {
                let byte = *bytes.get(*at)?;
                *at += 1;
                if byte == quote { return Some((name, value)); }
                value.push(byte.to_ascii_lowercase());
            }
        }
        b'>' => Some((name, value)),
        _ => {
            while let Some(&byte) = bytes.get(*at) {
                if space(byte) || byte == b'>' { break; }
                value.push(byte.to_ascii_lowercase());
                *at += 1;
            }
            Some((name, value))
        }
    }
}

/// The label after `charset=` in a Content-Type value, as a <meta content> gives it.
fn content_charset(content: &[u8]) -> Option<&[u8]> {
    let mut at = 0;
    loop {
        at += content.get(at..)?.windows(7).position(|window| window.eq_ignore_ascii_case(b"charset"))? + 7;
        while content.get(at).is_some_and(u8::is_ascii_whitespace) { at += 1; }
        if content.get(at) != Some(&b'=') { continue; }
        at += 1;
        while content.get(at).is_some_and(u8::is_ascii_whitespace) { at += 1; }
        let rest = &content[at..];
        return match *rest.first()? {
            quote @ (b'"' | b'\'') => rest[1..].iter().position(|byte| *byte == quote).map(|close| &rest[1..1 + close]),
            _ => Some(&rest[..rest.iter().position(|byte| byte.is_ascii_whitespace() || *byte == b';').unwrap_or(rest.len())]),
        };
    }
}

/// The label of the encoding that the meta tag whose attributes start at
/// `*at` names, as the prescan reads it (see prescan_label), if it names one.
fn meta_label(bytes: &[u8], at: &mut usize) -> Option<&'static str> {
    // The label found (None for an unknown one) and whether it needs http-equiv="Content-Type" beside it.
    let (mut seen, mut pragma, mut found): (Vec<Vec<u8>>, bool, Option<(Option<&'static str>, bool)>) = (Vec::new(), false, None);
    while let Some((name, value)) = prescan_attribute(bytes, at) {
        if seen.contains(&name) { continue; }
        match name.as_slice() {
            b"http-equiv" => pragma |= value == b"content-type",
            b"content" if found.is_none() => {
                if let Some(label) = content_charset(&value).and_then(prescan_label) { found = Some((Some(label), true)); }
            }
            b"charset" => found = Some((prescan_label(&value), false)),
            _ => {}
        }
        seen.push(name);
    }
    match found { Some((Some(label), needs_pragma)) if pragma || !needs_pragma => Some(label), _ => None }
}

/// The label of the encoding the page names in a <meta charset> or <meta
/// http-equiv="Content-Type" content="...; charset=..."> where the browser's
/// prescan finds it: in the first 1024 bytes, outside comments and other
/// tags. A <meta> whose label is not a known one is passed over.
fn declared_label(html: &[u8]) -> Option<&'static str> {
    let bytes = &html[..html.len().min(PRESCAN)];
    let mut at = 0;
    while at < bytes.len() {
        let rest = &bytes[at..];
        if rest.starts_with(b"<!--") {
            // The comment ends at the first '>' after "--", which may be the opener's own dashes.
            let close = rest[2..].windows(3).position(|window| window == b"-->")?;
            at += 2 + close + 3;
        } else if rest[0] == b'<' && names(&rest[1..], b"meta") {
            at += 5;
            if let Some(label) = meta_label(bytes, &mut at) { return Some(label); }
            at += 1;
        } else if rest[0] == b'<' && (rest.get(1).is_some_and(u8::is_ascii_alphabetic) || (rest.get(1) == Some(&b'/') && rest.get(2).is_some_and(u8::is_ascii_alphabetic))) {
            // Another tag: its attribute values are not markup.
            at += rest.iter().position(|byte| byte.is_ascii_whitespace() || *byte == b'>').unwrap_or(rest.len());
            while prescan_attribute(bytes, &mut at).is_some() {}
            at += 1;
        } else if rest.starts_with(b"<!") || rest.starts_with(b"</") || rest.starts_with(b"<?") {
            let close = rest.iter().position(|byte| *byte == b'>')?;
            at += close + 1;
        } else {
            at += 1;
        }
    }
    None
}

/// Whether bytes that name no encoding are best read as UTF-8: they are
/// UTF-8, or nearly so. A damaged UTF-8 page (a character cut in half
/// somewhere) still has far more good multi-byte characters than bad
/// sequences, and few bad bytes; a legacy page (windows-1252 with the odd
/// accented letter, GBK, Shift_JIS) has more bad sequences than good ones,
/// and is left for the browser. A character cut off at the very end (a
/// truncated file, or a sample of a larger one) never counts against them.
fn reads_as_utf8(bytes: &[u8]) -> bool {
    // A byte from 0xC0 up in valid UTF-8 always starts a multi-byte character.
    let starts = |valid: &[u8]| valid.iter().filter(|byte| **byte >= 0xC0).count();
    let (mut multibyte, mut bad, mut bad_bytes, mut rest) = (0, 0, 0, bytes);
    loop {
        match std::str::from_utf8(rest) {
            Ok(_) => { multibyte += starts(rest); break; }
            Err(error) => {
                multibyte += starts(&rest[..error.valid_up_to()]);
                let Some(length) = error.error_len() else { break };
                bad += 1;
                bad_bytes += length;
                rest = &rest[error.valid_up_to() + length..];
            }
        }
    }
    bad == 0 || (bad_bytes * 100 < bytes.len() && bad < multibyte)
}

/// The Content-Type of an HTML page from its bytes (or, for a page too large
/// to read whole, from its start). A charset in the header beats the page's
/// own <meta>, and the reporter added after <head> can push that <meta> past
/// the 1024 bytes the browser's prescan reads, so the label the page names
/// goes in the header and the <meta>'s place no longer matters. A byte-order
/// mark beats the header, so the page needs nothing more. A page that names
/// no encoding is labelled UTF-8 when it reads as UTF-8 (see reads_as_utf8);
/// anything else is left for the browser to read.
fn html_type(page: &[u8]) -> Cow<'static, str> {
    if page.starts_with(b"\xEF\xBB\xBF") || page.starts_with(b"\xFF\xFE") || page.starts_with(b"\xFE\xFF") { return "text/html".into(); }
    match declared_label(page) {
        Some(label) => format!("text/html; charset={label}").into(),
        None if reads_as_utf8(page) => "text/html; charset=utf-8".into(),
        None => "text/html".into(),
    }
}

fn response(status: &str, content_type: &str, body: &[u8], head: bool) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    if !head { out.extend_from_slice(body); }
    out
}

struct Request<'a> { method: &'a str, target: &'a str, host: Option<&'a str>, range: Option<&'a str> }

/// The request line plus the Host (only when sent exactly once) and Range headers.
fn parse_request(head: &str) -> Request<'_> {
    let mut lines = head.lines();
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (mut hosts, mut range) = (Vec::new(), None);
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case("host") { hosts.push(value.trim()); }
        else if name.trim().eq_ignore_ascii_case("range") { range = Some(value.trim()); }
    }
    Request { method, target, host: if hosts.len() == 1 { Some(hosts[0]) } else { None }, range }
}

fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
}

#[derive(Debug, PartialEq)]
enum ByteRange { Whole, Part(u64, u64), Unsatisfiable }

/// One `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Anything else (several
/// ranges, other units, bad syntax) is ignored and the whole file is sent.
fn byte_range(header: Option<&str>, length: u64) -> ByteRange {
    let Some(header) = header.map(str::trim) else { return ByteRange::Whole };
    if !starts_with_ignore_case(header.as_bytes(), b"bytes=") || header.contains(',') { return ByteRange::Whole; }
    let Some((first, last)) = header[6..].split_once('-') else { return ByteRange::Whole };
    let (first, last) = (first.trim(), last.trim());
    let number = |value: &str| value.bytes().all(|byte| byte.is_ascii_digit()).then(|| value.parse::<u64>().ok()).flatten();
    match (first.is_empty(), last.is_empty()) {
        (false, _) => {
            let Some(start) = number(first) else { return ByteRange::Whole };
            let end = if last.is_empty() { Some(u64::MAX) } else { number(last) };
            match end {
                Some(end) if end >= start => if start >= length { ByteRange::Unsatisfiable } else { ByteRange::Part(start, end.min(length - 1)) },
                _ => ByteRange::Whole,
            }
        }
        (true, false) => match number(last) {
            Some(0) => ByteRange::Unsatisfiable,
            Some(_) if length == 0 => ByteRange::Unsatisfiable,
            Some(suffix) => ByteRange::Part(length - suffix.min(length), length - 1),
            None => ByteRange::Whole,
        },
        (true, true) => ByteRange::Whole,
    }
}

async fn write_timed(socket: &mut tokio::net::TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    tokio::time::timeout(WRITE_TIMEOUT, socket.write_all(bytes)).await.map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))?
}

/// Streams the file (or the requested byte range) in chunks; HTML is read whole to add the reporter.
async fn send_file(socket: &mut tokio::net::TcpStream, file: &Path, range: Option<&str>, head: bool) -> std::io::Result<()> {
    let failed = response("500 Internal Server Error", "text/plain", b"Could not read the file", head);
    let mut kind: Cow<'static, str> = mime(file).into();
    // Only a regular file is opened: one replaced by a FIFO since it was resolved would hold this connection forever.
    let opened = { let file = file.to_path_buf(); tokio::task::spawn_blocking(move || open_regular(&file)).await };
    let Ok(Ok(handle)) = opened else { return write_timed(socket, &failed).await };
    let mut handle = tokio::fs::File::from_std(handle);
    let Ok(length) = handle.metadata().await.map(|metadata| metadata.len()) else { return write_timed(socket, &failed).await };
    if kind == "text/html" {
        if length <= MAX_REPORTED_HTML {
            let mut body = Vec::with_capacity(length as usize);
            if handle.read_to_end(&mut body).await.is_err() { return write_timed(socket, &failed).await; }
            return write_timed(socket, &response("200 OK", &html_type(&body), &with_reporter(&body), head)).await;
        }
        // Too large to read whole: its start decides the label, and the file is sent from its beginning again below.
        let mut sample = Vec::with_capacity(CHUNK);
        if (&mut handle).take(CHUNK as u64).read_to_end(&mut sample).await.is_err() { return write_timed(socket, &failed).await; }
        kind = html_type(&sample);
    }
    let (status, start, count) = match byte_range(range, length) {
        ByteRange::Whole => ("200 OK", 0, length),
        ByteRange::Part(start, end) => ("206 Partial Content", start, end - start + 1),
        ByteRange::Unsatisfiable => {
            let refused = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nAccept-Ranges: bytes\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
            return write_timed(socket, refused.as_bytes()).await;
        }
    };
    let content_range = if status.starts_with("206") { format!("Content-Range: bytes {start}-{}/{length}\r\n", start + count - 1) } else { String::new() };
    let header = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\n{content_range}Cache-Control: no-store\r\nConnection: close\r\n\r\n");
    write_timed(socket, header.as_bytes()).await?;
    if head { return Ok(()); }
    handle.seek(std::io::SeekFrom::Start(start)).await?;
    let mut buffer = vec![0u8; CHUNK.min(count as usize).max(1)];
    let mut remaining = count;
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = handle.read(&mut buffer[..want]).await?;
        // The file shrank while it was being sent; the client sees a short body.
        if read == 0 { break; }
        write_timed(socket, &buffer[..read]).await?;
        remaining -= read as u64;
    }
    Ok(())
}

async fn serve_one(root: PathBuf, mut socket: tokio::net::TcpStream) {
    let Ok(port) = socket.local_addr().map(|address| address.port()) else { return };
    let mut request = Vec::new();
    let mut chunk = [0u8; 4096];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") && request.len() < 64 * 1024 {
        match tokio::time::timeout(Duration::from_secs(10), socket.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return,
            Ok(Ok(count)) => request.extend_from_slice(&chunk[..count]),
        }
    }
    let text = String::from_utf8_lossy(&request).into_owned();
    let parsed = parse_request(&text);
    let head = parsed.method == "HEAD";
    let _ = if !host_allowed(parsed.host, port) {
        write_timed(&mut socket, &response("403 Forbidden", "text/plain", b"Forbidden", head)).await
    } else if parsed.method != "GET" && !head {
        write_timed(&mut socket, &response("405 Method Not Allowed", "text/plain", b"Method not allowed", head)).await
    } else if !parsed.target.starts_with('/') {
        write_timed(&mut socket, &response("400 Bad Request", "text/plain", b"Bad request", head)).await
    } else if let Some(file) = resolve_request(&root, parsed.target) {
        send_file(&mut socket, &file, parsed.range, head).await
    } else {
        let page = format!("<!doctype html><meta charset=\"utf-8\">{REPORTER}<p style=\"font:14px -apple-system\">Not found: {}</p>", parsed.target.replace('&', "&amp;").replace('<', "&lt;"));
        write_timed(&mut socket, &response("404 Not Found", "text/html; charset=utf-8", page.as_bytes(), head)).await
    };
    let _ = socket.shutdown().await;
}

/// Answers a connection past the cap with 503. Closing a socket before the
/// client's request has been read, or before it has arrived, makes the kernel
/// answer with a reset, and the client reports that instead of the 503. So
/// the request head is read first (for up to BUSY_WAIT), the write side is
/// shut down after the reply, and whatever else the client sends is read
/// until it closes. All of it stops at BUSY_DEADLINE and BUSY_READ_LIMIT bytes
/// read in all, and nothing read is kept.
async fn turn_away<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut socket: S) {
    let _ = tokio::time::timeout(BUSY_DEADLINE, async {
        let mut chunk = [0u8; 1024];
        // Bytes read so far, and how much of "\r\n\r\n" the last of them match.
        let (mut read, mut matched) = (0, 0);
        let _ = tokio::time::timeout(BUSY_WAIT, async {
            while read < BUSY_READ_LIMIT {
                let want = chunk.len().min(BUSY_READ_LIMIT - read);
                let count = match socket.read(&mut chunk[..want]).await { Ok(0) | Err(_) => break, Ok(count) => count };
                read += count;
                for &byte in &chunk[..count] {
                    matched = if byte == b"\r\n\r\n"[matched] { matched + 1 } else if byte == b'\r' { 1 } else { 0 };
                    if matched == 4 { return; }
                }
            }
        }).await;
        if socket.write_all(BUSY).await.is_err() { return; }
        let _ = socket.shutdown().await;
        while read < BUSY_READ_LIMIT {
            let want = chunk.len().min(BUSY_READ_LIMIT - read);
            match socket.read(&mut chunk[..want]).await { Ok(0) | Err(_) => break, Ok(count) => read += count }
        }
    }).await;
}

/// Where connections come from: the preview listener, or a stand-in in tests.
trait Incoming: Send + 'static {
    fn next(&mut self) -> impl std::future::Future<Output = std::io::Result<tokio::net::TcpStream>> + Send + '_;
}

impl Incoming for tokio::net::TcpListener {
    fn next(&mut self) -> impl std::future::Future<Output = std::io::Result<tokio::net::TcpStream>> + Send + '_ {
        async move { self.accept().await.map(|(socket, _)| socket) }
    }
}

/// One of `limit` places (MAX_CONNECTIONS or MAX_TURN_AWAYS), given back when the connection ends.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn claim(taken: &Arc<AtomicUsize>, limit: usize) -> Option<Slot> {
        taken.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| (count < limit).then_some(count + 1)).ok().map(|_| Slot(taken.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); }
}

async fn accept_loop(mut incoming: impl Incoming, root: PathBuf) {
    let (active, turning_away) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    loop {
        let socket = match incoming.next().await {
            Ok(socket) => socket,
            // Out of file descriptors and the like: wait rather than spin.
            Err(_) => { tokio::time::sleep(ACCEPT_BACKOFF).await; continue; }
        };
        if let Some(slot) = Slot::claim(&active, MAX_CONNECTIONS) {
            let root = root.clone();
            tokio::spawn(async move { let _slot = slot; serve_one(root, socket).await });
        } else if let Some(slot) = Slot::claim(&turning_away, MAX_TURN_AWAYS) {
            // A short-lived task, so a client that never reads cannot stall accepting.
            tokio::spawn(async move { let _slot = slot; turn_away(socket).await });
        } else {
            // Already turning MAX_TURN_AWAYS away: this one is closed unanswered.
            drop(socket);
        }
    }
}

fn address(port: u16) -> String { format!("http://127.0.0.1:{port}/") }

fn running_port(state: &PreviewState, folder: &Path) -> Result<Option<u16>, String> {
    let guard = state.0.lock().map_err(|_| "Preview lock poisoned")?;
    Ok(guard.as_ref().filter(|(served, _, _)| served == folder).map(|(_, port, _)| *port))
}

/// Serves `folder` (inside the project) and returns its address; reuses a running server for the same folder.
pub async fn preview_serve(state: &PreviewState, cwd: String, folder: Option<String>) -> Result<String, String> {
    let root = validate_working_directory(&cwd)?;
    let folder = match folder.as_deref() { Some(path) if !path.is_empty() => inside(&root, path)?, _ => root };
    if !folder.is_dir() { return Err("Choose a folder to serve".into()); }
    if let Some(port) = running_port(state, &folder)? { return Ok(address(port)); }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Check and set under one lock: when a concurrent call for the same folder
    // got there first, keep its server and close this listener unused.
    let mut guard = state.0.lock().map_err(|_| "Preview lock poisoned")?;
    if let Some((served, running, _)) = guard.as_ref() { if *served == folder { return Ok(address(*running)); } }
    if let Some((_, _, task)) = guard.take() { task.abort(); }
    let task = tauri::async_runtime::spawn(accept_loop(listener, folder.clone()));
    *guard = Some((folder, port, task));
    Ok(address(port))
}

pub fn preview_stop(state: &PreviewState) {
    if let Ok(mut guard) = state.0.lock() { if let Some((_, _, task)) = guard.take() { task.abort(); } }
}

/// Whether anything answers at an address the Browser view is about to show,
/// and whether the page forbids being shown inside another page
/// (X-Frame-Options, or CSP frame-ancestors without a wildcard).
pub async fn probe_url(url: &str) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid address".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err("Only http and https addresses can be checked".into()); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())?;
    match client.get(parsed).header("Accept", "text/html,*/*").send().await {
        Ok(response) => Ok(json!({ "reachable": true, "status": response.status().as_u16(), "frameBlocked": frame_blocked(response.headers()) })),
        Err(error) => Ok(json!({ "reachable": false, "error": error.to_string().chars().take(200).collect::<String>() })),
    }
}

fn frame_blocked(headers: &reqwest::header::HeaderMap) -> bool {
    let header = |name: &str| headers.get_all(name).iter().filter_map(|v| v.to_str().ok()).map(str::to_ascii_lowercase).collect::<Vec<_>>();
    let xfo = header("x-frame-options").iter().any(|v| v.contains("deny") || v.contains("sameorigin"));
    let ancestors = header("content-security-policy").iter().any(|policy| policy.split(';').map(str::trim)
        .any(|directive| directive.starts_with("frame-ancestors") && !directive.split_whitespace().skip(1).any(|source| source == "*")));
    xfo || ancestors
}
