//! Files attached to a message in the composer ([+], drop or paste).
//!
//! The composer sends absolute paths with the message (src/shared/attachments.ts); the CLI shows
//! images to a vision model and lets the model read other files with FileRead. Here the desktop
//! learns what a picked or dropped path is before it is attached (an image with a preview, a text
//! file, or why it cannot be attached), and a pasted image gets a file of its own.
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Paths one inspect call takes: a drop of a whole folder's files is cut down by the composer.
const MAX_INSPECT: usize = 200;
/// Images up to this size come back whole, for the composer's thumbnail (it scales them down).
const PREVIEW_LIMIT: u64 = 8 * 1024 * 1024;
/// A pasted image above this is refused: no provider takes an inline image this large.
const PASTE_LIMIT: usize = 20 * 1024 * 1024;
/// Bytes read to tell an image, a text file and a binary file apart.
const HEAD_BYTES: usize = 8192;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub path: String,
    pub name: String,
    /// "image" (PNG, JPEG, GIF or WebP) or "file".
    pub kind: &'static str,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<&'static str>,
    /// The whole image as base64, for a thumbnail; only for images up to PREVIEW_LIMIT.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Why it cannot be attached; the composer shows it and leaves the file out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// PNG, JPEG, GIF or WebP by the first bytes: the formats the providers take inline.
pub fn image_type(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("image/png"); }
    if head.starts_with(&[0xff, 0xd8, 0xff]) { return Some("image/jpeg"); }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") { return Some("image/gif"); }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" { return Some("image/webp"); }
    None
}

/// Why a file that is not an image cannot go to the model as text, if it cannot.
fn binary_problem(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"%PDF-") { return Some("PDF files cannot be attached yet"); }
    if head.len() >= 12 && &head[4..8] == b"ftyp" && matches!(&head[8..12], b"heic" | b"heix" | b"mif1" | b"msf1" | b"avif") {
        return Some("this image format cannot be attached: use PNG, JPEG, GIF or WebP");
    }
    // UTF-16 text starts with its byte-order mark and holds zero bytes; FileRead reads it.
    if head.starts_with(&[0xff, 0xfe]) || head.starts_with(&[0xfe, 0xff]) { return None; }
    if head.contains(&0) { return Some("it is a binary file: attach text files or PNG, JPEG, GIF or WebP images"); }
    None
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn refused(path: &str, problem: &str) -> AttachmentInfo {
    AttachmentInfo { path: path.to_string(), name: name_of(Path::new(path)), kind: "file", bytes: 0, media_type: None, preview: None, problem: Some(problem.to_string()) }
}

/// What `path` is now. Follows links (the CLI reads through them too).
pub fn inspect(path: &str) -> AttachmentInfo {
    let target = Path::new(path);
    if !target.is_absolute() || path.contains('\0') || path.contains('\n') || path.contains('\r') { return refused(path, "it is not an absolute file path"); }
    let meta = match fs::metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return refused(path, "the file does not exist"),
        Err(_) => return refused(path, "G-Code cannot read it"),
    };
    if meta.is_dir() { return refused(path, "folders cannot be attached: attach the files in it, or open it as a project"); }
    if !meta.is_file() { return refused(path, "it is not a regular file"); }
    let mut head = Vec::with_capacity(HEAD_BYTES);
    match fs::File::open(target) {
        Ok(file) => { if file.take(HEAD_BYTES as u64).read_to_end(&mut head).is_err() { return refused(path, "G-Code cannot read it"); } }
        Err(_) => return refused(path, "G-Code cannot read it"),
    }
    let bytes = meta.len();
    if let Some(media_type) = image_type(&head) {
        let preview = if bytes <= PREVIEW_LIMIT { fs::read(target).ok().map(|data| base64::engine::general_purpose::STANDARD.encode(data)) } else { None };
        return AttachmentInfo { path: path.to_string(), name: name_of(target), kind: "image", bytes, media_type: Some(media_type), preview, problem: None };
    }
    let problem = binary_problem(&head).map(str::to_string);
    AttachmentInfo { path: path.to_string(), name: name_of(target), kind: "file", bytes, media_type: None, preview: None, problem }
}

/// A folder of G-Code's that must be a real folder, not a link that could send the file elsewhere.
fn own_folder(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!("{} is not a folder G-Code can use", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700)); }
            Ok(())
        }
        Err(error) => Err(format!("Cannot use {}: {error}", path.display())),
    }
}

/// Saves a pasted image under `home`/.gcode/attachments/pasted, readable by the user only.
pub fn save_pasted_in(home: &Path, data: &str) -> Result<AttachmentInfo, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "The pasted image could not be read.".to_string())?;
    if bytes.len() > PASTE_LIMIT { return Err(format!("The pasted image is {:.1} MB; images up to {} MB can be attached.", bytes.len() as f64 / 1e6, PASTE_LIMIT / 1_000_000)); }
    let media_type = image_type(&bytes).ok_or_else(|| "Only PNG, JPEG, GIF or WebP images can be pasted.".to_string())?;
    let extension = match media_type { "image/png" => "png", "image/jpeg" => "jpg", "image/gif" => "gif", _ => "webp" };
    let gcode = home.join(".gcode");
    let attachments = gcode.join("attachments");
    let folder = attachments.join("pasted");
    for part in [&gcode, &attachments, &folder] { own_folder(part)?; }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    for attempt in 0..100u32 {
        let name = format!("pasted-{}-{:04x}.{extension}", now.as_millis(), (now.subsec_nanos() ^ attempt.wrapping_mul(0x9e37)) & 0xffff);
        let path: PathBuf = folder.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        match options.open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&path);
                    return Err(format!("The pasted image could not be saved: {error}"));
                }
                return Ok(inspect(&path.to_string_lossy()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("The pasted image could not be saved: {error}")),
        }
    }
    Err("The pasted image could not be saved: no free file name.".to_string())
}

/// Deletes a pasted image the user removed before sending: only a file this module named, directly in
/// `home`/.gcode/attachments/pasted (a real folder), and never through a link. Already gone is fine.
pub fn discard_pasted_in(home: &Path, path: &str) -> Result<(), String> {
    let folder = home.join(".gcode").join("attachments").join("pasted");
    let target = Path::new(path);
    let name = target.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let named = name.strip_prefix("pasted-").and_then(|rest| rest.rsplit_once('.')).is_some_and(|(stem, extension)| {
        matches!(extension, "png" | "jpg" | "gif" | "webp") && stem.split_once('-').is_some_and(|(ms, tag)| !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) && tag.len() == 4 && tag.bytes().all(|b| b.is_ascii_hexdigit()))
    });
    if !named || target.parent() != Some(folder.as_path()) { return Err("Only a pasted image G-Code saved can be discarded.".to_string()); }
    for part in [home.join(".gcode"), home.join(".gcode").join("attachments"), folder.clone()] {
        if !fs::symlink_metadata(&part).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) { return Ok(()); }
    }
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => fs::remove_file(target).map_err(|e| format!("The pasted image could not be discarded: {e}")),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn discard_pasted_image(path: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("home directory unavailable")?;
    tauri::async_runtime::spawn_blocking(move || discard_pasted_in(&home, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_attachments(paths: Vec<String>) -> Result<Vec<AttachmentInfo>, String> {
    if paths.len() > MAX_INSPECT { return Err(format!("Too many files at once ({}); attach at most 20 to one message.", paths.len())); }
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|path| inspect(path)).collect()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_pasted_image(data: String) -> Result<AttachmentInfo, String> {
    let home = dirs::home_dir().ok_or("home directory unavailable")?;
    tauri::async_runtime::spawn_blocking(move || save_pasted_in(&home, &data)).await.map_err(|e| e.to_string())?
}
