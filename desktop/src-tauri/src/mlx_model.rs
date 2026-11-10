//! Bounded inspection of an MLX model folder, without loading tensors. The result feeds the same
//! context admission as a GGUF file (gguf_context::plan).
use crate::gguf_context::{Metadata, DEFAULT_CONTEXT, MAX_CONTEXT};
use serde_json::Value;
use std::io::Read;
use std::path::Path;

const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
/// A model with recurrent layers keeps up to 16 snapshots of their state to rewind to (about 150 MB
/// each for Qwen3.8-27B), so that memory is counted beside the weights.
const RECURRENT_SNAPSHOT_BYTES: u64 = 3 * 1024 * 1024 * 1024;

fn config(dir: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(dir.join("config.json")).map_err(|_| "This folder is not an MLX model: config.json is missing".to_string())?;
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES).read_to_string(&mut text).map_err(|e| format!("Cannot read config.json: {e}"))?;
    serde_json::from_str(&text).map_err(|_| "config.json in this folder is not valid JSON".to_string())
}

pub fn read(dir: &Path) -> Result<Metadata, String> {
    let config = config(dir)?;
    if !dir.join("tokenizer.json").is_file() { return Err("This folder is not a complete MLX model: tokenizer.json is missing".into()); }
    let mut weights = 0_u64;
    let mut found = false;
    for entry in std::fs::read_dir(dir).map_err(|e| format!("Cannot read the model folder: {e}"))? {
        let entry = entry.map_err(|e| format!("Cannot read the model folder: {e}"))?;
        if !entry.file_name().to_string_lossy().ends_with(".safetensors") { continue; }
        let meta = entry.metadata().map_err(|e| format!("Cannot read the model weights: {e}"))?;
        if meta.is_file() { found = true; weights = weights.saturating_add(meta.len()); }
    }
    if !found { return Err("This folder has no .safetensors weights".into()); }
    metadata(&config, weights)
}

/// The numbers the memory estimate needs. A multimodal config keeps them under text_config.
pub fn metadata(config: &Value, file_bytes: u64) -> Result<Metadata, String> {
    let text = config.get("text_config").filter(|v| v.is_object()).unwrap_or(config);
    let number = |key: &str| text.get(key).or_else(|| config.get(key)).and_then(Value::as_u64).filter(|n| *n > 0);
    let layers = number("num_hidden_layers").filter(|n| *n <= 4096).ok_or("config.json has no valid num_hidden_layers")?;
    let heads = number("num_attention_heads").filter(|n| *n <= 65_536).ok_or("config.json has no valid num_attention_heads")?;
    // Only full-attention layers keep a cache that grows with the context; recurrent layers have a fixed state.
    let growing = match text.get("layer_types").and_then(Value::as_array) {
        Some(types) if !types.is_empty() => types.iter().filter(|t| t.as_str() == Some("full_attention")).count() as u64,
        _ => layers,
    };
    let kv_heads = number("num_key_value_heads").unwrap_or(heads).min(heads);
    let head_length = number("head_dim").or_else(|| number("hidden_size").map(|size| size.div_ceil(heads))).filter(|n| *n <= 65_536).ok_or("config.json has no usable head size")?;
    let trained = number("max_position_embeddings").unwrap_or(DEFAULT_CONTEXT).min(64 * MAX_CONTEXT);
    let snapshots = if growing < layers { RECURRENT_SNAPSHOT_BYTES } else { 0 };
    Ok(Metadata { trained_context: trained, max_context: trained.min(MAX_CONTEXT), layers: growing, kv_heads, key_length: head_length, value_length: head_length, file_bytes: file_bytes.saturating_add(snapshots) })
}
