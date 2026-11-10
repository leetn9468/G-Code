//! Native-only, read-only evidence access. Tool paths never grant authority here.
use std::{fs, path::{Path, PathBuf}, process::Command};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)] use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn root() -> Result<PathBuf, String> { Ok(dirs::home_dir().ok_or("Home unavailable")?.join(".gcode/incidents")) }
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() })
}
fn safe_root(root: &Path) -> Result<(), String> {
    for path in [root.parent().ok_or("Invalid incident root")?, root] {
        let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !m.is_dir() || m.file_type().is_symlink() { return Err("Incident storage must be a real directory".into()) }
    }
    Ok(())
}
fn directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("Invalid incident ID".into()) }
    safe_root(root)?;
    let path = root.join(id);
    let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !m.is_dir() || m.file_type().is_symlink() || path.canonicalize().map_err(|e|e.to_string())?.parent() != Some(root.canonicalize().map_err(|e|e.to_string())?.as_path()) { return Err("Invalid incident directory".into()) }
    Ok(path)
}
fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let m = fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > 2_000_000 { return Err("Unsafe incident file".into()) }
    #[cfg(unix)] if m.nlink() != 1 { return Err("Incident file has an unsafe hard link".into()) }
    fs::read(path).map_err(|e|e.to_string())
}
fn read_in(root: &Path, id: &str) -> Result<String, String> {
    let dir = directory(root, id)?;
    let index: Value = serde_json::from_slice(&read_file(&root.join("index.json"))?).map_err(|e|e.to_string())?;
    let bytes = read_file(&dir.join("evidence.md"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if index.get(id).and_then(|v|v.get("files")).and_then(|v|v.get("evidence.md")).and_then(Value::as_str) != Some(digest.as_str()) { return Err("Evidence integrity check failed".into()) }
    String::from_utf8(bytes).map_err(|e|e.to_string())
}
pub fn read(id: &str) -> Result<String, String> { read_in(&root()?, id) }
pub fn list() -> Result<Value, String> { list_in(&root()?) }
/// One folder that cannot be read (a crash during its save) is left out and counted: the others can still be reviewed.
fn list_in(root: &Path) -> Result<Value, String> {
    if !root.exists() { return Ok(json!({"rows":[],"unreadable":0})) }
    safe_root(root)?;
    let mut rows = vec![];
    let mut unreadable = 0;
    for entry in fs::read_dir(root).map_err(|e|e.to_string())? {
        let Ok(entry) = entry else { unreadable += 1; continue };
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) { continue }
        let Ok(dir) = directory(root, &id) else { unreadable += 1; continue };
        let Ok(mut value) = read_file(&dir.join("evidence.json")).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e|e.to_string())) else { unreadable += 1; continue };
        if let Ok(bytes) = read_file(&dir.join("decision.json")) { if let Ok(decision) = serde_json::from_slice::<Value>(&bytes) { value["decision"] = decision["decision"].clone(); } }
        rows.push(json!({"id":id,"at":value["at"],"model":value["model"],"destination":value["destination"],"decision":value["decision"]}));
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row["at"].as_u64().unwrap_or(0)));
    Ok(json!({"rows":rows,"unreadable":unreadable}))
}
pub fn reveal(id: &str) -> Result<(), String> {
    let path = directory(&root()?, id)?;
    if !Command::new("/usr/bin/open").arg("-R").arg(path).status().map_err(|e|e.to_string())?.success() { return Err("Could not show incident in Finder".into()) }
    Ok(())
}
fn trash_in(root: &Path, trash: &Path, id: &str) -> Result<(), String> {
    let path = directory(root, id)?;
    if !trash.exists() { fs::create_dir(trash).map_err(|e|e.to_string())?; #[cfg(unix)] fs::set_permissions(trash, fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?; }
    let m = fs::symlink_metadata(trash).map_err(|e|e.to_string())?;
    if !m.is_dir() || m.file_type().is_symlink() { return Err("Trash must be a real directory".into()) }
    let target = trash.join(format!("G-Code-Incident-{id}"));
    if target.exists() { return Err("An incident with this ID is already in Trash".into()) }
    fs::rename(path, target).map_err(|e|e.to_string())
}
pub fn delete(id: &str, confirmed: bool) -> Result<(), String> {
    if !confirmed { return Err("Confirm moving this incident to Trash".into()) }
    trash_in(&root()?, &dirs::home_dir().ok_or("Home unavailable")?.join(".Trash"), id)
}
