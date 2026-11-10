// Provider identity + display metadata.
//
// Mirrors src/llm/provider.ts in the CLI (kept as a hard 1:1 copy so future
// upstream tweaks land here too). The model-list cache and connection-test
// wording at the end are desktop-only.

import type { ProviderModel } from './tauri'

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'ollama'
  | 'local'

export const PROVIDERS: ProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'qwen',
  'local',
  'ollama',
]

export const PROVIDER_DISPLAY: Record<ProviderName, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  gemini: 'Google (Gemini)',
  deepseek: 'DeepSeek',
  qwen: 'Alibaba (Qwen)',
  ollama: 'Ollama (Local)',
  local: 'Local Model',
}

export const PROVIDER_SHORT_NAME: Record<ProviderName, string> = {
  anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek',
  qwen: 'Qwen', ollama: 'Ollama', local: 'Local Model',
}

export const PROVIDER_DESCRIPTION: Record<ProviderName, string> = {
  anthropic: 'Connect to Anthropic models with your API key.',
  openai: 'Connect to OpenAI models with your API key.',
  gemini: 'Connect to Google Gemini models with your API key.',
  deepseek: 'Connect to DeepSeek models with your API key.',
  qwen: 'Connect to Qwen models through Alibaba Cloud.',
  ollama: 'Choose an installed model from your Ollama server.',
  local: 'Run a downloaded GGUF or MLX model directly on your Mac.',
}

export const PROVIDER_ENV_VAR: Record<Exclude<ProviderName, 'ollama' | 'local'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
}

export const PROVIDER_DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-max',
  // A local model must be chosen from the server's installed inventory.
  ollama: '',
  local: '',
}

// ---- Row status (handover §8.2) ------------------------------------------

export type ProviderRowStatus =
  | 'current'
  | 'configured'
  | 'running'          // Ollama only
  | 'not-configured'
  | 'error'

export const STATUS_LABEL: Record<ProviderRowStatus, string> = {
  current: 'In use',
  configured: 'Configured',
  running: 'Server reachable',
  'not-configured': 'Setup needed',
  error: 'Needs attention',
}

// ---- API model lists (desktop only) --------------------------------------

/** Providers whose API can list the models a key may use. */
export type ApiProvider = Exclude<ProviderName, 'ollama' | 'local'>
export const MODEL_LIST_PROVIDERS: readonly ApiProvider[] = ['anthropic', 'openai', 'gemini', 'deepseek', 'qwen']
export const hasModelList = (provider: ProviderName): provider is ApiProvider =>
  (MODEL_LIST_PROVIDERS as readonly ProviderName[]).includes(provider)

/** How the provider's API is named in messages (the CLI reports lowercase ids). */
const API_NAME: Record<ApiProvider, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', qwen: 'Qwen',
}

/** A readable form of a model-list or connection-test error: "Add an API key
 *  for anthropic first" becomes "Add an API key for Anthropic first". Only the
 *  first mention is the message's own; later ones belong to the API's text. */
export function providerErrorMessage(provider: ProviderName, error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).replace(/^Error:\s*/, '').trim() || 'Unknown error'
  return hasModelList(provider) ? text.replace(new RegExp(`\\b${provider}\\b`), API_NAME[provider]) : text
}

export interface ModelListState {
  models: ProviderModel[] | null
  /** When the list currently shown was fetched (epoch ms). */
  fetchedAt: number | null
  loading: boolean
  error: string | null
}
export const EMPTY_MODEL_LIST: ModelListState = Object.freeze({ models: null, fetchedAt: null, loading: false, error: null })

/** Keeps each provider's model list in memory for this app session. A failed
 *  refresh keeps the last good list (with its fetch time) next to the error. */
function createModelListCache() {
  const lists = new Map<ApiProvider, ModelListState>()
  const pending = new Map<ApiProvider, Promise<ModelListState>>()
  const listeners = new Set<() => void>()
  const set = (provider: ApiProvider, next: ModelListState) => {
    lists.set(provider, next)
    for (const listener of listeners) listener()
  }
  return {
    get: (provider: ApiProvider): ModelListState => lists.get(provider) ?? EMPTY_MODEL_LIST,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh(provider: ApiProvider, fetch: (provider: ApiProvider) => Promise<unknown>, now: () => number = Date.now): Promise<ModelListState> {
      const running = pending.get(provider)
      if (running) return running
      const previous = lists.get(provider) ?? EMPTY_MODEL_LIST
      set(provider, { ...previous, loading: true, error: null })
      const request = (async () => {
        let next: ModelListState
        try {
          const models = normalizeModels(await fetch(provider))
          next = { models, fetchedAt: now(), loading: false, error: null }
        } catch (error) {
          next = { ...(lists.get(provider) ?? EMPTY_MODEL_LIST), loading: false, error: providerErrorMessage(provider, error) }
        }
        pending.delete(provider)
        set(provider, next)
        return next
      })()
      pending.set(provider, request)
      return request
    },
    /** Drops a provider's list (its key changed, so the list may no longer apply). */
    forget(provider: ApiProvider) {
      if (!lists.has(provider) || pending.has(provider)) return
      lists.delete(provider)
      for (const listener of listeners) listener()
    },
    clear() { lists.clear(); pending.clear(); for (const listener of listeners) listener() },
  }
}
export const modelListCache = createModelListCache()

/** Validates what the backend returned: ids are required and unique, names optional. */
function normalizeModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) throw new Error('The provider returned no model list')
  const seen = new Set<string>()
  const models: ProviderModel[] = []
  for (const entry of value) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null
    models.push({ id, name })
  }
  return models
}

/** "24 models · fetched at 14:32". */
export function modelListSummary(count: number, fetchedAt: number): string {
  const time = new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${count.toLocaleString()} ${count === 1 ? 'model' : 'models'} · fetched at ${time}`
}

/** One real test request's outcome: Connected · claude-opus-5-5 replied "OK" in 412 ms. */
export function connectionTestMessage(result: { model?: unknown; reply?: unknown; ms?: unknown }, requested: string): string {
  if (!result || typeof result.ms !== 'number') throw new Error('The provider returned no test result')
  const model = typeof result.model === 'string' && result.model.trim() ? result.model.trim() : requested
  const reply = typeof result.reply === 'string' ? result.reply.trim() : ''
  return `Connected · ${model} replied${reply ? ` "${reply}"` : ''} in ${Math.round(result.ms).toLocaleString()} ms`
}
