/**
 * @file ollama.ts
 * @brief Ollama local model client (OpenAI-compatible API)
 */

import { OpenAIClient, type OpenAIClientOptions } from './openai.js'
import { directFetch } from './directFetch.js'

const DEFAULT_HOST = 'http://localhost:11434'

export function isLoopbackEndpoint(host: string): boolean {
  const hostname = new URL(host).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
}

/** Accept a server origin or one of the API URLs shown by local runtimes. */
export function normalizeOllamaHost(host = process.env['OLLAMA_HOST'] || DEFAULT_HOST): string {
  const value = host.trim()
  if (!value) throw new Error('Ollama server address is required.')
  let url: URL
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`)
  } catch {
    throw new Error('Invalid Ollama server address. Use http://localhost:11434.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Ollama server address must be an HTTP(S) URL without credentials, query, or fragment.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:v1(?:\/chat\/completions)?|api\/tags)$/, '')
  return url.toString().replace(/\/+$/, '')
}

/** Read installed models; this never pulls or downloads a model. */
export async function listOllamaModels(host?: string): Promise<string[]> {
  const baseUrl = normalizeOllamaHost(host)
  let response: Response
  try {
    const transport = isLoopbackEndpoint(baseUrl) ? directFetch : fetch
    response = await transport(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
  } catch {
    throw new Error(`Cannot connect to Ollama at ${baseUrl}. Start Ollama and check the server address.`)
  }
  if (!response.ok) throw new Error(`Ollama model discovery failed (HTTP ${response.status}) at ${baseUrl}.`)
  const data = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> }
  if (!Array.isArray(data.models)) throw new Error('Ollama returned an invalid model list.')
  return [...new Set(data.models.flatMap((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name : entry?.model
    return typeof name === 'string' && name.trim() ? [name.trim()] : []
  }))].sort()
}

export function validateOllamaModel(model: string | undefined, models: string[]): string {
  const selected = model?.trim()
  const choices = models.length ? ` Available models: ${models.join(', ')}.` : ' No models are installed on this Ollama server.'
  if (!selected) throw new Error(`Select an installed Ollama model with --model <name>.${choices}`)
  const canonical = models.find((name) => name === selected || name === `${selected}:latest`)
  if (!canonical) throw new Error(`Ollama model "${selected}" is not installed.${choices}`)
  return canonical
}

export class OllamaClient extends OpenAIClient {
  constructor(options?: Partial<OpenAIClientOptions>) {
    const model = options?.defaultModel?.trim()
    if (!model) throw new Error('Select an installed Ollama model with --model <name>; use --provider ollama --list-models to list models.')
    super({
      providerKind: 'ollama',
      apiKey: options?.apiKey ?? 'ollama', // Ollama doesn't need a real key
      baseUrl: `${normalizeOllamaHost(options?.baseUrl)}/v1/chat/completions`,
      defaultModel: model,
      retry: options?.retry,
      bypassProxy: options?.bypassProxy ?? isLoopbackEndpoint(normalizeOllamaHost(options?.baseUrl)),
    })
  }
}
