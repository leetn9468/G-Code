/**
 * @file deepseek.ts
 * @brief DeepSeek API client (OpenAI-compatible endpoint)
 */

import { OpenAIClient, type OpenAIClientOptions } from './openai.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEFAULT_MODEL = 'deepseek-chat'

export class DeepSeekClient extends OpenAIClient {
  constructor(options?: Partial<OpenAIClientOptions>) {
    const apiKey = (options?.apiKey ?? process.env['DEEPSEEK_API_KEY'])?.trim()
    if (!apiKey) throw new Error('DeepSeek API key required. Set DEEPSEEK_API_KEY environment variable.')
    super({
      providerKind: 'deepseek',
      apiKey,
      baseUrl: options?.baseUrl ?? DEEPSEEK_URL,
      defaultModel: options?.defaultModel ?? DEFAULT_MODEL,
      retry: options?.retry,
    })
  }
}
