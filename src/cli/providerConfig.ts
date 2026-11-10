import type { LLMClient } from '../llm/types.js'
import { autoDetectProvider, createLLMClient, type ProviderName } from '../llm/provider.js'
import { listOllamaModels, validateOllamaModel } from '../llm/ollama.js'

export interface ProviderCLIOptions {
  provider?: string
  model?: string
  baseUrl?: string
  fast?: boolean
}

export async function resolveCLIProvider(options: ProviderCLIOptions): Promise<{
  client?: LLMClient
  provider?: ProviderName
  model?: string
}> {
  const model = options.model?.trim()
  if (options.model !== undefined && !model) throw new Error('--model must be a non-empty model name.')
  if (options.fast && !model) {
    throw new Error('--fast requires --model <name>. Choose a fast model supported by the selected provider.')
  }
  // An empty value (an unset shell variable) is a mistake, not the option left out.
  if (options.provider !== undefined && !options.provider.trim()) throw new Error('--provider must be a non-empty provider name.')
  if (options.baseUrl !== undefined && !options.baseUrl.trim()) throw new Error('--base-url must be a non-empty address.')
  const detected = options.provider ? undefined : autoDetectProvider()
  const provider = (options.provider ?? detected?.provider) as ProviderName | undefined
  if (options.baseUrl && provider !== 'ollama' && provider !== 'local') throw new Error('--base-url is supported with --provider ollama or --provider local.')
  if (!provider) return { model }
  if (provider === 'ollama') {
    const models = await listOllamaModels(options.baseUrl)
    const selected = validateOllamaModel(model, models)
    return { provider, model: selected, client: createLLMClient(provider, selected, options.baseUrl) }
  }
  return { provider, model, client: createLLMClient(provider, model, options.baseUrl) }
}
