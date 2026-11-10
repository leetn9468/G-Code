/**
 * Qwen uses DashScope's OpenAI-compatible API so tool definitions, tool calls,
 * and tool results use the same complete protocol as the other agent providers.
 * Default region remains Beijing (dashscope.aliyuncs.com).
 * https://www.alibabacloud.com/help/en/model-studio/model-calling-in-sub-workspace
 */
import { OpenAIClient, type OpenAIClientOptions } from './openai.js'

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const DEFAULT_MODEL = 'qwen-max'

export interface QwenClientOptions extends OpenAIClientOptions {}

export class QwenClient extends OpenAIClient {
  constructor(options?: QwenClientOptions) {
    const apiKey = (options?.apiKey ?? process.env['DASHSCOPE_API_KEY'])?.trim()
    if (!apiKey) throw new Error('DashScope API key required. Set DASHSCOPE_API_KEY environment variable.')
    let baseUrl = options?.baseUrl ?? process.env['DASHSCOPE_BASE_URL'] ?? DASHSCOPE_URL
    baseUrl = baseUrl.replace(/\/+$/, '')
    if (baseUrl.endsWith('/v1')) baseUrl += '/chat/completions'
    super({
      providerKind: 'qwen',
      apiKey,
      baseUrl,
      defaultModel: options?.defaultModel ?? DEFAULT_MODEL,
      retry: options?.retry,
    })
  }
}
