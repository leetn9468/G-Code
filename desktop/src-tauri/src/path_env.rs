use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Inherited empty entries deliberately retain cwd; discovery never creates one.

#[cfg(unix)]
fn trusted_owner_mode(owner: u32, mode: u32, user: u32, ancestor: bool) -> bool {
    let sticky_root = ancestor && owner == 0 && mode & 0o1000 != 0;
    (owner == user || owner == 0) && (mode & 0o022 == 0 || sticky_root)
}

#[cfg(unix)]
fn trusted_parent(path: &Path, owner: u32, mode: u32, user: u32) -> bool {
    // macOS's root-owned application container is normally root:admin 0775.
    // It is a system trust anchor, not a discovered executable directory.
    let applications = cfg!(target_os = "macos") && path == Path::new("/Applications") && owner == 0 && mode & 0o002 == 0;
    applications || trusted_owner_mode(owner, mode, user, true)
}

fn trusted_metadata(metadata: &fs::Metadata, ancestor: bool) -> bool {
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        // A root-owned sticky ancestor (/tmp) cannot replace a user's child.
        trusted_owner_mode(metadata.uid(), metadata.mode(), uid, ancestor)
    }
    #[cfg(not(unix))] { let _ = (metadata, ancestor); false }
}

/// Check the symlink target and all parents, including writable manager roots.
fn safe_path(path: &Path, directory: bool) -> Option<PathBuf> {
    if !path.is_absolute() { return None; }
    let resolved = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&resolved).ok()?;
    if metadata.is_dir() != directory || (!directory && !metadata.is_file()) || !trusted_metadata(&metadata, false) { return None; }
    for parent in resolved.ancestors().skip(1).chain(path.ancestors().skip(1)) {
        let metadata = fs::metadata(parent).ok()?;
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            if !trusted_parent(parent, metadata.uid(), metadata.mode(), unsafe { libc::geteuid() }) { return None; }
        }
        #[cfg(not(unix))] if !trusted_metadata(&metadata, true) { return None; }
    }
    Some(resolved)
}

fn version(value: &str) -> Option<[u32; 3]> {
    let mut result = [0; 3];
    let parts: Vec<_> = value.strip_prefix('v').unwrap_or(value).split('.').collect();
    if parts.len() != 3 { return None; }
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
        result[index] = part.parse().ok()?;
    }
    Some(result)
}

/// Alias text is a bounded token, never a shell fragment. LTS aliases must have
/// a local nvm mapping; guessing that an installed release is LTS is unsafe.
fn nvm_default(home: &Path) -> Option<PathBuf> {
    let nvm = home.join(".nvm");
    let aliases = safe_path(&nvm.join("alias"), true)?;
    let mut alias = "default".to_string();
    let mut seen = HashSet::new();
    for _ in 0..8 {
        if !seen.insert(alias.clone()) { return None; }
        let file = safe_path(&aliases.join(&alias), false)?;
        if !file.starts_with(&aliases) || fs::metadata(&file).ok()?.len() > 512 { return None; }
        let text = fs::read_to_string(file).ok()?;
        let token = text.trim();
        if token.starts_with("lts/") {
            let name = &token[4..];
            if name != "*" && (name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphabetic() || c == b'-')) { return None; }
            alias = token.to_string(); continue;
        }
        let prefix = token.strip_prefix('v').unwrap_or(token);
        let components: Vec<_> = prefix.split('.').collect();
        let wanted = if token == "node" { Vec::new() } else {
            if components.is_empty() || components.len() > 3 { return None; }
            let mut values = Vec::new();
            for part in components {
                if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
                values.push(part.parse::<u32>().ok()?);
            }
            values
        };
        let versions = safe_path(&nvm.join("versions/node"), true)?;
        let mut matches = Vec::new();
        for entry in fs::read_dir(versions).ok()?.flatten() {
            let name = entry.file_name();
            let Some(release) = name.to_str().and_then(version) else { continue; };
            if !release.iter().zip(&wanted).all(|(a, b)| a == b) { continue; }
            if safe_path(&entry.path().join("bin"), true).is_some() { matches.push((release, entry.path().join("bin"))); }
        }
        matches.sort_by_key(|(release, _)| *release);
        return matches.pop().map(|(_, bin)| bin);
    }
    None
}

fn managers(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![home.join(".volta/bin")];
    if let Some(nvm) = nvm_default(home) { candidates.push(nvm); }
    for path in [".local/share/fnm/aliases/default/bin", "Library/Application Support/fnm/aliases/default/bin", ".asdf/shims", ".local/share/mise/shims", "Library/pnpm", ".bun/bin"] {
        candidates.push(home.join(path));
    }
    candidates.into_iter().filter(|path| safe_path(path, true).is_some()).collect()
}

/// Resource location is independent of cwd and the user's Node installation.
pub(crate) fn bundled_node_root() -> Option<PathBuf> {
    if let Ok(executable) = std::env::current_exe() {
        let parent = executable.parent()?;
        let bundled = if cfg!(target_os = "macos") { parent.join("../Resources/node-runtime") } else { parent.join("node-runtime") };
        if bundled.join("bin/node").is_file() { return fs::canonicalize(bundled).ok(); }
    }
    #[cfg(debug_assertions)] {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.join("runtime/node");
        if source.join("bin/node").is_file() { return fs::canonicalize(source).ok(); }
    }
    None
}

fn discovered_path(current: Option<&OsStr>, helper: Option<&OsStr>, homebrew: &[PathBuf], home: Option<&Path>, bundled: Option<&Path>) -> OsString {
    let bundle_bin = bundled.map(|path| path.join("bin"));
    let bundle_identity = bundle_bin.as_ref().and_then(|path| fs::canonicalize(path).ok());
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let mut add = |path: PathBuf, discovered: bool| {
        let path = if discovered { let Some(safe) = safe_path(&path, true) else { return; }; safe } else { path };
        let identity = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if bundle_bin.as_ref().is_some_and(|bin| bin == &path) || bundle_identity.as_ref().is_some_and(|bin| bin == &identity) { return; }
        if seen.insert(identity) { paths.push(path); }
    };
    for path in current.into_iter().flat_map(std::env::split_paths) { add(path, false); }
    // path_helper's entries and the fixed Homebrew/system list are where the user installed their
    // tools, not discovered locations. Homebrew's own prefix is user:admin 0775 by default, so the
    // strict check below would drop it for every Dock-launched app (and the Terminal panel).
    for path in helper.into_iter().flat_map(std::env::split_paths) { add(path, false); }
    for path in homebrew { add(path.clone(), false); }
    if let Some(home) = home { for path in managers(home) { add(path, true); } }
    if let Some(bin) = bundle_bin.and_then(|path| safe_path(&path, true)) { paths.push(bin); }
    std::env::join_paths(paths).unwrap_or_else(|_| current.unwrap_or_default().to_os_string())
}

fn helper_path() -> Option<OsString> {
    #[cfg(target_os = "macos")] {
        // Parse the one PATH assignment. Never execute/evaluate helper output.
        let out = Command::new("/usr/libexec/path_helper").arg("-s").output().ok()?;
        if !out.status.success() { return None; }
        let text = String::from_utf8(out.stdout).ok()?;
        text.strip_prefix("PATH=\"")?.split_once("\";").map(|(value, _)| OsString::from(value))
    }
    #[cfg(not(target_os = "macos"))] { None }
}

pub(crate) fn gui_path(current: Option<&OsStr>) -> OsString {
    let homebrew: Vec<_> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(PathBuf::from).collect();
    discovered_path(current, helper_path().as_deref(), &homebrew, dirs::home_dir().as_deref(), bundled_node_root().as_deref())
}

pub(crate) fn configure_cli_path(command: &mut Command) {
    let current = command.get_envs().find(|(key, _)| *key == OsStr::new("PATH"))
        .map(|(_, value)| value.map(OsStr::to_os_string)).unwrap_or_else(|| std::env::var_os("PATH"));
    command.env("PATH", gui_path(current.as_deref()));
}

/// A direct native MCP probe is a tool too. Terminals never call this helper.
pub(crate) fn configure_tool_command(command: &mut Command) {
    configure_cli_path(command);
    for (key, value) in [("npm_config_yes", "true"), ("npm_config_fund", "false"), ("npm_config_update_notifier", "false"), ("npm_config_progress", "false")] {
        let explicit = command.get_envs().any(|(name, value)| name.to_string_lossy().eq_ignore_ascii_case(key) && value.is_some());
        let inherited = std::env::vars_os().any(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case(key));
        if !explicit && !inherited { command.env(key, value); }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeEnvironment { version: Option<String>, path: Option<String>, built_in: bool }

fn executable_in_path(path: &OsStr, name: &str, cwd: &Path) -> Option<PathBuf> {
    for directory in std::env::split_paths(path) {
        let file = cwd.join(directory).join(name);
        let Ok(metadata) = fs::metadata(&file) else { continue; };
        if !metadata.is_file() { continue; }
        #[cfg(unix)] {
            use std::os::unix::ffi::OsStrExt;
            let Ok(path) = std::ffi::CString::new(file.as_os_str().as_bytes()) else { continue; };
            if unsafe { libc::access(path.as_ptr(), libc::X_OK) } != 0 { continue; }
        }
        return Some(file);
    }
    None
}

fn node_version(node: &Path, path: &OsStr, cwd: &Path) -> Option<String> {
    let mut command = Command::new(node);
    command.arg("--version").env("PATH", path).env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .current_dir(cwd)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    #[cfg(unix)] {
        use std::os::fd::AsRawFd;
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); } let _ = child.kill(); let _ = child.wait(); return None;
        }
    }
    let deadline = Instant::now() + Duration::from_millis(2500);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // A shim may leave descendants holding stdout. Reap the owned
                // group and read only bytes already available, never wait for EOF.
                #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                if !status.success() { return None; }
                let mut bytes = Vec::new(); let mut buffer = [0; 512];
                loop {
                    match stdout.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => { bytes.extend_from_slice(&buffer[..count]); if bytes.len() > 4096 { return None; } }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => return None,
                    }
                }
                let text = String::from_utf8(bytes).ok()?;
                let value = text.trim();
                let numeric = value.split_once('-').map(|(numeric, _)| numeric).unwrap_or(value);
                return (version(numeric).is_some() && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')).then(|| value.to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => { #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); } let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
}

pub(crate) fn node_environment(cwd: Option<&Path>) -> NodeEnvironment {
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let cwd = cwd.unwrap_or(&current);
    let path = gui_path(std::env::var_os("PATH").as_deref());
    let executable = executable_in_path(&path, "node", cwd);
    let built_in = executable.as_ref().and_then(|file| fs::canonicalize(file).ok()).is_some_and(|file|
        bundled_node_root().and_then(|root| fs::canonicalize(root.join("bin/node")).ok()).as_ref() == Some(&file));
    NodeEnvironment { version: executable.as_deref().and_then(|node| node_version(node, &path, cwd)),
        path: executable.and_then(|file| file.parent().map(|parent| parent.to_string_lossy().into_owned())), built_in }
}
