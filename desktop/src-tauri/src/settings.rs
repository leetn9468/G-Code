// Settings persistence for G-Code Desktop.
//
// Writes to ~/.gcode/settings.json (design brief §11 / handover §8.5).
// Stored as a generic serde_json::Value so schema evolution stays additive —
// the React side owns the schema shape.

use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gcode").join("settings.json"))
}

/// A file that exists but cannot be read or is not a JSON object. Never treated as empty: the next
/// write of "defaults" would replace every key, project and the Guillotine setting.
fn checked_at(path: &Path) -> Result<Option<Value>, String> {
    let shown = path.display();
    let advice = "G-Code did not change it. Fix the file, or restore settings.json.bak beside it.";
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{shown} could not be read ({error}). {advice}")),
    };
    // serde's message gives a line and column; it never quotes the file, which holds keys.
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| format!("{shown} is not valid JSON ({error}). {advice}"))?;
    if !value.is_object() { return Err(format!("{shown} is not a JSON object. {advice}")); }
    Ok(Some(value))
}

/// The file's values, `{}` when there is no file; an error when it exists and cannot be used.
pub fn read_checked() -> Result<Value, String> {
    let path = settings_path().ok_or("Home directory is unavailable")?;
    Ok(checked_at(&path)?.unwrap_or_else(|| Value::Object(Default::default())))
}

/// For lookups that only read one field (a saved key, a model path): a file that cannot be used has
/// no such field. Anything that writes, or decides by a setting, uses read_checked.
pub fn load() -> Value {
    read_checked().unwrap_or_else(|_| Value::Object(Default::default()))
}

pub fn save(settings: &Value) -> Result<(), String> {
    let path = settings_path().ok_or("Home directory is unavailable")?;
    save_at(&path, settings)
}

/// A failed read never becomes a write: an existing file that cannot be used stays as it is. The file
/// being replaced is kept beside it, without any key this save removes or changes: a removed
/// credential does not outlive the removal in the backup.
fn save_at(path: &Path, settings: &Value) -> Result<(), String> {
    if !settings.is_object() { return Err("Settings must be a JSON object".into()); }
    if let Some(mut previous) = checked_at(path)? {
        forget_replaced_keys(&mut previous, settings);
        if let Err(error) = write_json_atomic(&backup_path(path), &previous) { eprintln!("[settings] Could not keep a backup: {error}"); }
    }
    write_json_atomic(path, settings).map_err(|error| error.to_string())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".bak");
    PathBuf::from(name)
}

fn forget_replaced_keys(previous: &mut Value, next: &Value) {
    let Some(keys) = previous.pointer_mut("/provider/apiKeys").and_then(Value::as_object_mut) else { return };
    let kept = next.pointer("/provider/apiKeys");
    keys.retain(|name, value| kept.and_then(|kept| kept.get(name)) == Some(value));
}

// Create the replacement with private permissions before any credential bytes
// are written, then atomically replace the old file only after a successful sync.
pub(crate) fn write_json_atomic(path: &Path, settings: &Value) -> io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "settings path needs a parent"))?;
    fs::create_dir_all(parent)?;
    let pretty = serde_json::to_vec_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temporary = parent.join(format!(".gcode-settings-{}-{}-{}.tmp", std::process::id(), nonce, SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&pretty)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)] fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}
