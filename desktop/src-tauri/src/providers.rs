// Provider detection + Ollama health check.
//
// Mirrors the auto-detection logic in ../../../src/llm/provider.ts.
// Priority: Anthropic > OpenAI > Google > DeepSeek > DashScope (Qwen).
// Ollama is not auto-detected but has a live server ping.

use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;

const PROVIDER_KEYS: [(&str, &str); 5] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("gemini", "GOOGLE_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("qwen", "DASHSCOPE_API_KEY"),
];

fn saved_key(provider: &str) -> Option<String> {
    crate::settings::load()
        .pointer(&format!("/provider/apiKeys/{provider}"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn configured(provider: &str, env_var: &str) -> bool {
    env::var(env_var).ok().is_some_and(|value| !value.trim().is_empty())
        || saved_key(provider).is_some()
}

pub fn inject_saved_keys(command: &mut std::process::Command) {
    for (provider, env_var) in PROVIDER_KEYS {
        let env_is_set = env::var(env_var).ok().is_some_and(|value| !value.trim().is_empty());
        if !env_is_set {
            if let Some(key) = saved_key(provider) {
                command.env(env_var, key);
            }
        }
    }
}

/// Which provider env vars are set on the current process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEnvStatus {
    pub anthropic: bool,
    pub openai: bool,
    pub gemini: bool,
    pub deepseek: bool,
    pub qwen: bool,
    /// The provider that autoDetectProvider() would pick, if any.
    pub auto: Option<String>,
}

/// Ollama server ping result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub running: bool,
    pub host: String,
    /// Number of installed models (Ollama /api/tags returns models[]).
    pub model_count: Option<u32>,
    pub models: Vec<String>,
    pub error: Option<String>,
}

pub fn get_env_status() -> ProviderEnvStatus {
    let anthropic = configured("anthropic", "ANTHROPIC_API_KEY");
    let openai = configured("openai", "OPENAI_API_KEY");
    let gemini = configured("gemini", "GOOGLE_API_KEY");
    let deepseek = configured("deepseek", "DEEPSEEK_API_KEY");
    let qwen = configured("qwen", "DASHSCOPE_API_KEY");

    // Auto priority — first hit wins. Mirrors src/llm/provider.ts.
    let auto = if anthropic {
        Some("anthropic")
    } else if openai {
        Some("openai")
    } else if gemini {
        Some("gemini")
    } else if deepseek {
        Some("deepseek")
    } else if qwen {
        Some("qwen")
    } else {
        None
    }
    .map(String::from);

    ProviderEnvStatus {
        anthropic,
        openai,
        gemini,
        deepseek,
        qwen,
        auto,
    }
}

/// One endpoint resolver shared by discovery and the spawned CLI.
pub fn ollama_host(explicit: Option<String>) -> Result<String, String> {
    let saved = crate::settings::load();
    let candidate = explicit.or_else(|| saved.pointer("/provider/ollamaHost").and_then(|v| v.as_str()).map(String::from))
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env::var("OLLAMA_HOST").ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    normalize_ollama_host(&candidate)
}

fn normalize_ollama_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    let with_scheme = if host.contains("://") { host.to_string() } else { format!("http://{host}") };
    let mut url = reqwest::Url::parse(&with_scheme).map_err(|_| "Invalid Ollama server address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Use an HTTP(S) Ollama server address without credentials, query or fragment".to_string());
    }
    let path = url.path().trim_end_matches('/');
    let path = ["/v1/chat/completions", "/api/tags", "/v1"].iter()
        .find_map(|suffix| path.strip_suffix(suffix)).unwrap_or(path).to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// Fetch actual installed names. reqwest handles HTTP status, TLS, IPv6 and
/// chunked responses; a TCP connection alone is not a successful Ollama probe.
pub async fn check_ollama(host: Option<String>) -> OllamaStatus {
    let host = match ollama_host(host) {
        Ok(host) => host,
        Err(error) => return OllamaStatus { running: false, host: String::new(), model_count: None, models: vec![], error: Some(error) },
    };
    match fetch_models(&host).await {
        Ok(models) => OllamaStatus { running: true, host, model_count: Some(models.len() as u32), models, error: None },
        Err(error) => OllamaStatus { running: false, host, model_count: None, models: vec![], error: Some(error) },
    }
}

async fn fetch_models(host: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?;
    let response = client.get(format!("{host}/api/tags")).send().await
        .map_err(|e| format!("Cannot reach Ollama: {e}"))?;
    if !response.status().is_success() { return Err(format!("Ollama returned HTTP {}", response.status())); }
    let value: serde_json::Value = response.json().await.map_err(|e| format!("Invalid Ollama response: {e}"))?;
    let models = value.get("models").and_then(|v| v.as_array()).ok_or("Ollama response is missing its models list")?;
    let mut names = Vec::new();
    for model in models {
        let name = model.get("name").or_else(|| model.get("model")).and_then(|v| v.as_str())
            .map(str::trim).filter(|v| !v.is_empty()).ok_or("Ollama returned a model without a name")?;
        names.push(name.to_string());
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// The provider's key: the environment first (as the CLI sees it), then the saved settings. Never sent to the WebView.
fn provider_key(provider: &str) -> Result<String, String> {
    let env_var = PROVIDER_KEYS.iter().find(|(name, _)| *name == provider).map(|(_, var)| *var).ok_or("This provider has no API model list")?;
    env::var(env_var).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
        .or_else(|| saved_key(provider)).ok_or_else(|| format!("Add an API key for {provider} first"))
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())
}

/// One model the provider says this key can use.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderModel {
    pub id: String,
    pub name: Option<String>,
}

/// OpenAI lists embeddings, speech and image models too; only chat models can drive the agent.
fn openai_chat_model(id: &str) -> bool {
    let chat = ["gpt-", "o1", "o3", "o4", "o5", "chatgpt-"].iter().any(|prefix| id.starts_with(prefix));
    let other = ["embedding", "tts", "whisper", "dall-e", "image", "audio", "realtime", "transcribe", "moderation", "search", "computer-use"].iter().any(|word| id.contains(word));
    chat && !other
}

fn parse_models(provider: &str, value: &serde_json::Value) -> Result<Vec<ProviderModel>, String> {
    let mut models: Vec<ProviderModel> = if provider == "gemini" {
        value.get("models").and_then(|v| v.as_array()).ok_or("The model list is missing")?.iter()
            .filter(|model| model.get("supportedGenerationMethods").and_then(|v| v.as_array()).is_some_and(|methods| methods.iter().any(|m| m.as_str() == Some("generateContent"))))
            .filter_map(|model| Some(ProviderModel {
                id: model.get("name")?.as_str()?.trim_start_matches("models/").to_string(),
                name: model.get("displayName").and_then(|v| v.as_str()).map(String::from),
            })).collect()
    } else {
        value.get("data").and_then(|v| v.as_array()).ok_or("The model list is missing")?.iter()
            .filter_map(|model| Some(ProviderModel {
                id: model.get("id")?.as_str()?.trim().to_string(),
                name: model.get("display_name").or_else(|| model.get("name")).and_then(|v| v.as_str()).map(String::from),
            }))
            .filter(|model| !model.id.is_empty() && (provider != "openai" || openai_chat_model(&model.id)))
            .collect()
    };
    let mut seen = std::collections::HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    // Anthropic lists newest first; keep that order. The others read best sorted.
    if provider != "anthropic" { models.sort_by(|a, b| a.id.cmp(&b.id)); }
    Ok(models)
}

/// Asks the provider which models this key can use (like G-Code Lite's model picker).
pub async fn list_models(provider: &str) -> Result<Vec<ProviderModel>, String> {
    let key = provider_key(provider)?;
    let client = api_client()?;
    let request = match provider {
        "anthropic" => client.get("https://api.anthropic.com/v1/models?limit=1000").header("x-api-key", &key).header("anthropic-version", "2023-06-01"),
        "openai" => client.get("https://api.openai.com/v1/models").bearer_auth(&key),
        "gemini" => client.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000").header("x-goog-api-key", &key),
        "deepseek" => client.get("https://api.deepseek.com/models").bearer_auth(&key),
        "qwen" => client.get("https://dashscope.aliyuncs.com/compatible-mode/v1/models").bearer_auth(&key),
        _ => return Err("This provider has no API model list".into()),
    };
    let value = send_json(request, provider, "Invalid model list").await?;
    parse_models(provider, &value)
}

/// Sends the request and reads the reply as JSON. The status is checked first,
/// so a proxy's HTML 403 or 502 page reads as that error, not as bad JSON.
async fn send_json(request: reqwest::RequestBuilder, provider: &str, invalid: &str) -> Result<serde_json::Value, String> {
    let response = request.send().await.map_err(|e| format!("Could not reach {provider}: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("Could not read the reply from {provider}: {e}"))?;
    if !status.is_success() { return Err(api_error(provider, status, &body)); }
    serde_json::from_str(&body).map_err(|e| format!("{invalid} from {provider}: {e}"))
}

/// What an error body says: the JSON error message, an HTML page's title, or the first line of plain text.
fn error_message(body: &str) -> String {
    let body = body.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return value.pointer("/error/message").or_else(|| value.pointer("/error")).or_else(|| value.get("message"))
            .and_then(|v| v.as_str()).unwrap_or("").to_string();
    }
    if body.starts_with('<') {
        // ASCII lowercasing keeps byte offsets, so they index `body` too.
        let lower = body.to_ascii_lowercase();
        let title = lower.find("<title").and_then(|tag| {
            let open = tag + lower[tag..].find('>')? + 1;
            let close = open + lower[open..].find("</title")?;
            Some(body[open..close].to_string())
        });
        return title.unwrap_or_default();
    }
    body.lines().next().unwrap_or("").to_string()
}

fn api_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let message = error_message(body).split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{provider} returned HTTP {}{}{}", status.as_u16(), if message.is_empty() { "" } else { ": " }, message.chars().take(300).collect::<String>())
}

/// A Gemini model id goes into the URL path, so only plain id characters pass. A pasted "models/" prefix is dropped.
fn gemini_model(model: &str) -> Result<&str, String> {
    let id = model.strip_prefix("models/").unwrap_or(model);
    let plain = !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte));
    if plain { Ok(id) } else { Err("A Gemini model id uses only letters, digits, '.', '_', ':' and '-'".into()) }
}

/// Sends one tiny real request ("Reply with OK.") and reports what came back.
pub async fn test_provider(provider: &str, model: &str) -> Result<serde_json::Value, String> {
    let model = model.trim();
    if model.is_empty() { return Err("Choose a model first".into()); }
    let model = if provider == "gemini" { gemini_model(model)? } else { model };
    let key = provider_key(provider)?;
    let client = api_client()?;
    let prompt = "Reply with OK.";
    let chat = serde_json::json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "max_tokens": 16 });
    let request = match provider {
        "anthropic" => client.post("https://api.anthropic.com/v1/messages").header("x-api-key", &key).header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({ "model": model, "max_tokens": 16, "messages": [{ "role": "user", "content": prompt }] })),
        "openai" => client.post("https://api.openai.com/v1/chat/completions").bearer_auth(&key)
            .json(&serde_json::json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "max_completion_tokens": 64 })),
        "gemini" => client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")).header("x-goog-api-key", &key)
            .json(&serde_json::json!({ "contents": [{ "role": "user", "parts": [{ "text": prompt }] }], "generationConfig": { "maxOutputTokens": 16 } })),
        "deepseek" => client.post("https://api.deepseek.com/v1/chat/completions").bearer_auth(&key).json(&chat),
        "qwen" => client.post("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions").bearer_auth(&key).json(&chat),
        _ => return Err("This provider cannot be tested here".into()),
    };
    let started = std::time::Instant::now();
    let value = send_json(request, provider, "Invalid reply").await?;
    let reply = value.pointer("/content/0/text").or_else(|| value.pointer("/choices/0/message/content")).or_else(|| value.pointer("/candidates/0/content/parts/0/text"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(80).collect::<String>();
    let answered = value.get("model").or_else(|| value.get("modelVersion")).and_then(|v| v.as_str()).unwrap_or(model);
    Ok(serde_json::json!({ "model": answered, "reply": reply, "ms": started.elapsed().as_millis() as u64 }))
}
