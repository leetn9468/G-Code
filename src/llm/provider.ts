import { limitClient } from '../workflow/limiter.js'
/**
 * @file provider.ts
 * @brief Provider auto-detection, factory, and display names
 *
 * Priority: ANTHROPIC > OPENAI > GOOGLE > DEEPSEEK > DASHSCOPE > Ollama
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LLMClient } from './types.js'
import { AnthropicClient } from './anthropic.js'
import { OpenAIClient } from './openai.js'
import { OllamaClient, normalizeOllamaHost } from './ollama.js'
import { GeminiClient } from './gemini.js'
import { DeepSeekClient } from './deepseek.js'
import { QwenClient } from './qwen.js'

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'qwen' | 'ollama' | 'local'
export type KeyedProvider = Exclude<ProviderName, 'ollama' | 'local'>

/** Each cloud provider's key variable, in auto-detection priority order. */
export const PROVIDER_KEY_ENV: Readonly<Record<KeyedProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
}

/** A key saved by the desktop's Settings (provider.apiKeys in ~/.gcode/settings.json). */
function savedKey(provider: KeyedProvider): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.gcode', 'settings.json'), 'utf8')) as { provider?: { apiKeys?: Record<string, unknown> } }
    const value = settings?.provider?.apiKeys?.[provider]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch { return undefined /* No settings file, or one that is not JSON: no saved key. */ }
}

/**
 * The provider's API key: its environment variable when that is set and not blank, else the key
 * the desktop saved (as the desktop's inject_saved_keys does for the sessions it starts). The key
 * is passed to the client only: it is never logged or copied into process.env, so tools and their
 * child processes do not inherit a saved key.
 */
export function providerApiKey(provider: KeyedProvider): string | undefined {
  const value = process.env[PROVIDER_KEY_ENV[provider]]?.trim()
  return value ? value : savedKey(provider)
}

/**
 * Create an LLM client for the specified provider.
 */
function createRawClient(
  provider: ProviderName,
  model?: string,
  baseUrl?: string,
): LLMClient {
  // providerApiKey decides: '' (no key) stops each client from reading the raw variable again.
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient({ defaultModel: model, apiKey: providerApiKey('anthropic') ?? '' })
    case 'openai':
      return new OpenAIClient({ defaultModel: model, apiKey: providerApiKey('openai') ?? '' })
    case 'gemini':
      return new GeminiClient({ defaultModel: model, apiKey: providerApiKey('gemini') ?? '' })
    case 'deepseek':
      return new DeepSeekClient({ defaultModel: model, apiKey: providerApiKey('deepseek') ?? '' })
    case 'qwen':
      return new QwenClient({ defaultModel: model, apiKey: providerApiKey('qwen') ?? '' })
    case 'ollama':
      return new OllamaClient({ defaultModel: model, baseUrl })
    case 'local':
      if (!baseUrl?.trim()) throw new Error('Local model server requires --base-url <url>.')
      if (!model?.trim()) throw new Error('Local model server requires --model <name>.')
      return new OpenAIClient({
        apiKey: 'local',
        baseUrl: `${normalizeOllamaHost(baseUrl)}/v1/chat/completions`,
        defaultModel: model.trim(),
        managedLocal: true,
        providerKind: 'local',
        bypassProxy: true,
        chatTemplateKwargs: { enable_thinking: false },
      })
    default:
      throw new Error(`Unknown provider: ${provider}. Available: anthropic, openai, gemini, deepseek, qwen, ollama, local`)
  }
}

export function createLLMClient(provider: ProviderName, model?: string, baseUrl?: string): LLMClient {
  return limitClient(createRawClient(provider, model, baseUrl), provider)
}

/**
 * Auto-detect provider from API keys: environment variables first, then keys saved by the desktop.
 * Priority: Anthropic > OpenAI > Google > DeepSeek > DashScope.
 * Ollama not auto-detected (requires running server).
 */
export function autoDetectProvider(): { provider: ProviderName; client: LLMClient } | null {
  for (const provider of Object.keys(PROVIDER_KEY_ENV) as KeyedProvider[]) {
    if (providerApiKey(provider)) {
      try { return { provider, client: createLLMClient(provider) } } catch { /* skip */ }
    }
  }

  return null
}

/**
 * Human-readable provider name.
 */
export function getProviderDisplayName(provider: ProviderName): string {
  const names: Record<ProviderName, string> = {
    anthropic: 'Anthropic (Claude)',
    openai: 'OpenAI (GPT)',
    gemini: 'Google (Gemini)',
    deepseek: 'DeepSeek',
    qwen: 'Alibaba (Qwen)',
    ollama: 'Ollama (Local)',
    local: 'Local GGUF',
  }
  return names[provider] ?? provider
}

