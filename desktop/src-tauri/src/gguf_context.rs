//! Bounded GGUF metadata inspection and conservative context admission, without loading tensors.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::{Read, BufReader}};

pub const DEFAULT_CONTEXT: u64 = 262_144;
pub const MAX_CONTEXT: u64 = 1_048_576;
pub const CONTEXTS: [u64; 7] = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub trained_context: u64,
    pub max_context: u64,
    pub layers: u64,
    pub kv_heads: u64,
    pub key_length: u64,
    pub value_length: u64,
    pub file_bytes: u64,
}

#[derive(Debug)]
enum Value { Number(u64), Text(String), Other }
fn bytes<const N: usize>(r: &mut impl Read) -> Result<[u8; N], String> {
    let mut b = [0; N]; r.read_exact(&mut b).map_err(|_| "Truncated or oversized GGUF metadata")?; Ok(b)
}
fn u32v(r: &mut impl Read) -> Result<u32, String> { Ok(u32::from_le_bytes(bytes(r)?)) }
fn u64v(r: &mut impl Read) -> Result<u64, String> { Ok(u64::from_le_bytes(bytes(r)?)) }
fn skip(r: &mut impl Read, size: u64) -> Result<(), String> {
    if size > 256 * 1024 * 1024 { return Err("GGUF metadata value is too large".into()); }
    let read = std::io::copy(&mut r.take(size), &mut std::io::sink()).map_err(|e| e.to_string())?;
    if read != size { return Err("Truncated GGUF metadata".into()); } Ok(())
}
fn string(r: &mut impl Read, keep: bool) -> Result<String, String> {
    let size = u64v(r)?;
    if !keep { skip(r, size)?; return Ok(String::new()); }
    if size > 1024 { return Err("GGUF metadata key or selected text is too long".into()); }
    let mut b = vec![0; size as usize]; r.read_exact(&mut b).map_err(|_| "Truncated GGUF string")?;
    String::from_utf8(b).map_err(|_| "Invalid UTF-8 in GGUF metadata".into())
}
fn value(r: &mut impl Read, kind: u32, keep: bool, array: bool, items: &mut u64) -> Result<Value, String> {
    Ok(match kind {
        0 => Value::Number(bytes::<1>(r)?[0] as u64),
        1 => { let n = bytes::<1>(r)?[0] as i8; if n >= 0 { Value::Number(n as u64) } else { Value::Other } },
        2 => Value::Number(u16::from_le_bytes(bytes(r)?) as u64),
        3 => { let n = i16::from_le_bytes(bytes(r)?); if n >= 0 { Value::Number(n as u64) } else { Value::Other } },
        4 => Value::Number(u32v(r)? as u64),
        5 => { let n = i32::from_le_bytes(bytes(r)?); if n >= 0 { Value::Number(n as u64) } else { Value::Other } },
        6 => { bytes::<4>(r)?; Value::Other },
        7 => { if bytes::<1>(r)?[0] > 1 { return Err("Invalid GGUF boolean".into()); } Value::Other },
        8 => Value::Text(string(r, keep)?),
        9 if !array => {
            let ty = u32v(r)?; let count = u64v(r)?;
            *items = items.checked_add(count).ok_or("GGUF array count overflow")?;
            if *items > 4_000_000 || ty == 9 { return Err("Unsupported or oversized GGUF array".into()); }
            // Per-layer head counts occur in hybrid models. Max × layers deliberately overestimates.
            let mut max = 0; let mut numeric = count > 0;
            for _ in 0..count { match value(r, ty, keep, true, items)? { Value::Number(n) => max = max.max(n), _ => numeric = false } }
            if numeric { Value::Number(max) } else { Value::Other }
        },
        10 => Value::Number(u64v(r)?),
        11 => { let n = i64::from_le_bytes(bytes(r)?); if n >= 0 { Value::Number(n as u64) } else { Value::Other } },
        12 => { bytes::<8>(r)?; Value::Other },
        _ => return Err("Unsupported GGUF metadata type".into()),
    })
}
pub fn read(reader: impl Read, file_bytes: u64) -> Result<Metadata, String> {
    let mut r = BufReader::new(reader.take(256 * 1024 * 1024));
    if &bytes::<4>(&mut r)? != b"GGUF" { return Err("The selected file is not a GGUF model".into()); }
    let version = u32v(&mut r)?;
    if !(2..=3).contains(&version) { return Err(format!("Unsupported GGUF version {version}")); }
    let _tensors = u64v(&mut r)?; let count = u64v(&mut r)?;
    if count > 100_000 { return Err("Too many GGUF metadata entries".into()); }
    let mut fields = HashMap::new(); let mut items = 0;
    const SUFFIXES: [&str; 9] = [".context_length", ".block_count", ".attention.head_count", ".attention.head_count_kv", ".attention.key_length", ".attention.value_length", ".embedding_length", ".rope.scaling.type", ".rope.scaling.original_context_length"];
    for _ in 0..count {
        let key = string(&mut r, true)?; let ty = u32v(&mut r)?;
        let keep = key == "general.architecture" || key == "split.count" || SUFFIXES.iter().any(|s| key.ends_with(s));
        let val = value(&mut r, ty, keep, false, &mut items)?;
        if keep && fields.insert(key, val).is_some() { return Err("Duplicate GGUF context metadata".into()); }
    }
    if matches!(fields.get("split.count"), Some(Value::Number(n)) if *n > 1) {
        return Err("Split GGUF weights need a combined-file memory estimate; select a single-file GGUF model".into());
    }
    let arch = match fields.get("general.architecture") { Some(Value::Text(s)) if !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) => s, _ => return Err("Missing GGUF architecture metadata".into()) };
    let number = |name: &str| match fields.get(&format!("{arch}.{name}")) { Some(Value::Number(n)) if *n > 0 => Some(*n), _ => None };
    let trained = number("context_length").filter(|n| *n <= 64 * MAX_CONTEXT).ok_or("Missing or invalid GGUF context_length")?;
    let layers = number("block_count").filter(|n| *n <= 4096).ok_or("Missing or invalid GGUF block_count")?;
    let heads = number("attention.head_count").filter(|n| *n <= 65_536).ok_or("Missing or invalid GGUF attention head count")?;
    let kv_heads = number("attention.head_count_kv").unwrap_or(heads);
    if kv_heads > heads { return Err("Invalid GGUF KV head count".into()); }
    let fallback = number("embedding_length").filter(|n| n % heads == 0).map(|n| n / heads);
    let key_length = number("attention.key_length").or(fallback).filter(|n| *n <= 65_536).ok_or("Missing GGUF key length for memory estimate")?;
    let value_length = number("attention.value_length").or(fallback).filter(|n| *n <= 65_536).ok_or("Missing GGUF value length for memory estimate")?;
    let yarn = matches!(fields.get(&format!("{arch}.rope.scaling.type")), Some(Value::Text(s)) if s == "yarn")
        || number("rope.scaling.original_context_length").is_some_and(|n| n <= trained);
    Ok(Metadata { trained_context: trained, max_context: (if yarn { trained.saturating_mul(4) } else { trained }).min(MAX_CONTEXT), layers, kv_heads, key_length, value_length, file_bytes })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Features { pub quantized_kv: bool, pub yarn: bool, pub cache_reuse: bool }
impl Features {
    pub fn from_help(help: &str) -> Self {
        Self { quantized_kv: ["--flash-attn", "--cache-type-k", "--cache-type-v", "q8_0"].iter().all(|s| help.contains(s)),
            yarn: ["--rope-scaling", "--rope-scale", "--yarn-orig-ctx"].iter().all(|s| help.contains(s)), cache_reuse: help.contains("--cache-reuse") }
    }
}
#[derive(Clone, Debug)]
pub struct Plan { pub requested: u64, pub applied: u64, pub kv_bytes: u64, pub reason: Option<String>, pub flags: Vec<String> }
pub fn requested(value: Option<u64>) -> u64 { value.filter(|v| CONTEXTS.contains(v)).unwrap_or(DEFAULT_CONTEXT) }
pub fn lower(context: u64) -> Option<u64> { CONTEXTS.iter().rev().copied().find(|v| *v < context) }
pub fn plan(meta: &Metadata, wanted: u64, ram: u64, features: Features, ceiling: Option<u64>) -> Result<Plan, String> {
    if ram == 0 { return Err("Cannot determine physical RAM; local model was not started".into()); }
    let supported = if features.yarn { meta.max_context } else { meta.max_context.min(meta.trained_context) };
    let mut applied = wanted.min(supported).min(ceiling.unwrap_or(MAX_CONTEXT));
    if applied == 0 { return Err("The model has no usable context window".into()); }
    let budget = (ram as u128) * 3 / 4;
    loop {
        let quantized = features.quantized_kv && applied > 32_768;
        // q8_0 stores 32 values + a two-byte scale. Round each head up to a block.
        let per_head = if quantized { ((meta.key_length + 31) / 32 + (meta.value_length + 31) / 32) as u128 * 34 }
            else { (meta.key_length as u128 + meta.value_length as u128) * 2 };
        let kv = per_head * meta.layers as u128 * meta.kv_heads as u128 * applied as u128;
        if meta.file_bytes as u128 + kv <= budget {
            let mut reasons = Vec::new();
            if wanted > supported { reasons.push("model/runtime context support"); }
            if ceiling.is_some() { reasons.push("allocation failure at a larger context"); }
            if applied < wanted.min(supported).min(ceiling.unwrap_or(MAX_CONTEXT)) { reasons.push("75% physical RAM budget"); }
            let mut flags = vec!["--ctx-size".into(), applied.to_string()];
            if features.cache_reuse { flags.extend(["--cache-reuse", "256"].map(String::from)); }
            if quantized { flags.extend(["--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"].map(String::from)); }
            if applied > meta.trained_context {
                flags.extend(["--rope-scaling".into(), "yarn".into(), "--rope-scale".into(), format!("{}", applied as f64 / meta.trained_context as f64), "--yarn-orig-ctx".into(), meta.trained_context.to_string()]);
            }
            return Ok(Plan { requested: wanted, applied, kv_bytes: kv as u64, reason: (!reasons.is_empty()).then(|| reasons.join("; ")), flags });
        }
        applied = lower(applied).ok_or("Model weights and minimum KV cache exceed 75% of physical RAM; choose a smaller model")?;
    }
}
pub fn allocation_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    ["out of memory", "failed to allocate", "allocation failed", "cannot allocate", "not enough memory", "insufficient memory"].iter().any(|s| msg.contains(s))
}
