import { providerFetch } from './providerFetch.js'
import { localBudgetEndpoint } from '../shared/sessionBudget.js'
import { LOCAL_THINKING_BUDGET } from '../shared/sessionControls.js'
import { NO_OUTPUT_LIMIT } from '../shared/outputLimits.js'
import { nativeEffort } from '../shared/effort.js'
import { openAIUsage } from './usage.js'
/**
 * @file openai.ts
 * @brief OpenAI-compatible API client (GPT-4, GPT-4o, etc.)
 *
 * Also works with any OpenAI-compatible API (e.g. Azure, Together, Groq).
 */

import type {
  ContentBlock,
  LLMClient,
  LLMRequestOptions,
  LLMResponse,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from './types.js'
import { withRetry, classifyHTTPError, streamErrorEvent, StreamEndedError, type RetryOptions } from './retry.js'
import { NO_FETCH_TIMEOUT, guardStreamIdle, type WatchBody } from './streamIdle.js'
import { USER_AGENT } from './ua.js'
import { EndMarker, readSSEData } from './sse.js'
import { directFetch } from './directFetch.js'
import { localInferenceFetch, serverContextWindow } from './localTransport.js'
import { toolResultText, visionCapabilities, validateImages, validateImageRequestSize } from './images.js'
import { OpenAIResponsesClient, usesResponsesApi } from './openaiResponses.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-4o'

/** Chat Completions retention is model-specific; compatible vendors get no OpenAI fields. */
export function cacheHints(model: string, key: string): Record<string, unknown> {
  const name = model.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const generation = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(name)
  if (generation && (Number(generation[1]) > 5 || Number(generation[1]) === 5 && Number(generation[2]) >= 6)) return { prompt_cache_key: key, prompt_cache_options: { mode: 'implicit', ttl: '30m' } }
  const extended = new Set(['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-chat-latest', 'gpt-5', 'gpt-5-codex', 'gpt-4.1'])
  return { prompt_cache_key: key, ...(extended.has(name) ? { prompt_cache_retention: '24h' } : {}) }
}

export interface OpenAIClientOptions {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  retry?: RetryOptions
  contextWindow?: number
  managedLocal?: boolean
  bypassProxy?: boolean
  chatTemplateKwargs?: { enable_thinking: boolean }
  providerKind?: 'openai' | 'deepseek' | 'qwen' | 'ollama' | 'local' | 'compatible'
}

export class OpenAIClient implements LLMClient {
  modelIdentity(model: string) { return { provider: this.providerKind, model: model || this.defaultModel } }
  visionCapabilities(model: string) { return visionCapabilities(this.providerKind, model || this.defaultModel) }
  private actualContextWindow?: number
  get contextWindow(): number | undefined { return this.actualContextWindow }
  get budgetLocal(): boolean | undefined { return this.providerKind === 'local' || this.providerKind === 'ollama' ? localBudgetEndpoint(this.baseUrl) : undefined }
  /** Local inference is not billed: only the context window bounds a reply. */
  get maxOutputTokens(): number | undefined { return this.providerKind === 'local' || this.providerKind === 'ollama' ? NO_OUTPUT_LIMIT : undefined }
  readonly managedLocal: boolean
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private retryOptions: RetryOptions
  private bypassProxy: boolean
  private chatTemplateKwargs?: { enable_thinking: boolean }
  private providerKind: string
  private responsesClient?: OpenAIResponsesClient

  constructor(options?: OpenAIClientOptions) {
    this.apiKey = (options?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '').trim()
    this.baseUrl = options?.baseUrl ?? OPENAI_API_URL
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL
    this.retryOptions = options?.retry ?? {}
    this.actualContextWindow = options?.contextWindow
    this.managedLocal = options?.managedLocal ?? false
    this.bypassProxy = options?.bypassProxy ?? false
    this.chatTemplateKwargs = options?.chatTemplateKwargs
    this.providerKind = options?.providerKind ?? (this.managedLocal ? 'local' : 'openai')

    if (!this.apiKey) {
      throw new Error('OpenAI API key required. Set OPENAI_API_KEY environment variable.')
    }
  }

  /** The official endpoint's gpt-6 models go through the Responses API (see openaiResponses.ts). */
  private responses(model: string): OpenAIResponsesClient | undefined {
    if (this.providerKind !== 'openai' || this.baseUrl !== OPENAI_API_URL || !usesResponsesApi(model)) return
    return this.responsesClient ??= new OpenAIResponsesClient({ apiKey: this.apiKey, url: OPENAI_API_URL.replace(/\/chat\/completions$/, '/responses'), retry: this.retryOptions, bypassProxy: this.bypassProxy, cacheHints })
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const responses = this.responses(options.model || this.defaultModel)
    if (responses) return responses.chat(options, options.model || this.defaultModel)
    return withRetry(async () => {
      options.beforeSend?.()
      const body = this.buildBody(options)
      const response = await this.fetchResponse({
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw classifyHTTPError(response.status, await response.text(), response.headers)
      }

      const data = await response.json() as Record<string, unknown>
      return this.parseResponse(data, options.model || this.defaultModel)
    }, { ...this.retryOptions, ...(options.noRetry ? { maxRetries: 0 } : {}), signal: options.signal })
  }

  async *chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent> {
    const responses = this.responses(options.model || this.defaultModel)
    if (responses) { yield* responses.chatStream(options, options.model || this.defaultModel); return }
    // Local runtimes prefill for minutes without sending a byte; the managed one has its own progress check.
    if (this.managedLocal || this.providerKind === 'ollama') yield* this.stream(options, options.signal)
    else yield* guardStreamIdle(options.signal, (signal, watch) => this.stream(options, signal, watch))
  }

  private async *stream(options: LLMRequestOptions, signal: AbortSignal | undefined, watch: WatchBody = body => body): AsyncGenerator<StreamEvent> {
    options.beforeSend?.()
    const body = { ...this.buildBody(options), stream: true, stream_options: { include_usage: true }, ...(this.managedLocal ? { return_progress: true } : {}) }
    const response = await this.fetchResponse({
      ...NO_FETCH_TIMEOUT,
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw classifyHTTPError(response.status, await response.text(), response.headers)
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    // `held`: arguments that came before the call's name; its start waits for the name.
    const pendingTools = new Map<number, { id: string; named: boolean; name: string; started: boolean; ended: boolean; held: string }>()
    let stopReason: string | undefined
    let reasoning = ''
    const openTool = function* (tool: { id: string; name: string; started: boolean; held: string }): Generator<StreamEvent> {
      if (tool.started) return
      tool.started = true
      yield { type: 'tool_use_start', id: tool.id, name: tool.name || 'Tool' }
      if (tool.held) { yield { type: 'tool_use_input', id: tool.id, partial: tool.held }; tool.held = '' }
    }
    const endTool = function* (tool: { id: string; name: string; started: boolean; ended: boolean; held: string }): Generator<StreamEvent> {
      if (tool.ended) return
      yield* openTool(tool)
      tool.ended = true
      yield { type: 'tool_use_end', id: tool.id }
    }
    const finishTools = function* (): Generator<StreamEvent> {
      for (const tool of pendingTools.values()) yield* endTool(tool)
    }

    const end = new EndMarker()
    for await (const data of readSSEData(watch(response.body), end)) {
      if (data.trim() === '[DONE]') {
        yield* finishTools()
        if (reasoning) yield { type: 'continuation', continuation: { provider: this.providerKind, model: options.model || this.defaultModel, payload: { reasoning_content: reasoning } } }
        if (!stopReason) yield { type: 'done', stopReason: pendingTools.size ? 'tool_calls' : 'stop' }
        return
      }
      if (!data.trim()) continue
      let chunk: Record<string, unknown>
      try { chunk = JSON.parse(data) as Record<string, unknown> }
      catch { throw new Error('Invalid JSON in model response stream.') }
      if (chunk.error) {
        const error = chunk.error as Record<string, unknown>
        throw streamErrorEvent({ type: error.type ?? error.code, message: error.message })
      }
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined
      const usage = openAIUsage(chunk.usage, this.managedLocal ? chunk.timings : undefined)
      if (usage) yield { type: 'usage', usage }
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (typeof delta?.reasoning_content === 'string') { reasoning += delta.reasoning_content; yield { type: 'thinking', text: delta.reasoning_content } }
      if (typeof delta?.content === 'string') yield { type: 'text', text: delta.content }
      const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      for (const call of toolCalls ?? []) {
        const index = Number(call.index ?? 0)
        const fn = call.function as Record<string, unknown> | undefined
        const id = call.id === undefined || call.id === null || call.id === '' ? undefined : String(call.id)
        const name = fn?.name === undefined || fn.name === null || fn.name === '' ? undefined : String(fn.name)
        let tool = pendingTools.get(index)
        // Some servers give every call index 0: a new id with a name is a new call, not more of this one.
        if (tool?.named && id && id !== tool.id && name) { yield* endTool(tool); tool = undefined }
        if (!tool) {
          tool = { id: id ?? `tool-${index}`, named: !!id, name: name ?? '', started: false, ended: false, held: '' }
          pendingTools.set(index, tool)
        } else if (!tool.started) {
          if (id && !tool.named) { tool.id = id; tool.named = true }
          if (name) tool.name = name
        }
        if (tool.name) yield* openTool(tool)
        const partial = typeof fn?.arguments === 'string' ? fn.arguments : ''
        if (partial) {
          if (tool.started) yield { type: 'tool_use_input', id: tool.id, partial }
          else tool.held += partial
        }
      }
      const finishReason = choices?.[0]?.finish_reason as string | null | undefined
      if (finishReason && !stopReason) {
        stopReason = finishReason
        end.seen()
        yield* finishTools()
        yield { type: 'done', stopReason }
      }
    }
    if (!stopReason) throw new StreamEndedError('Model response stream ended before completion.')
    if (reasoning) yield { type: 'continuation', continuation: { provider: this.providerKind, model: options.model || this.defaultModel, payload: { reasoning_content: reasoning } } }
  }

  private fetchResponse(options: RequestInit): Promise<Response> {
    return this.managedLocal ? localInferenceFetch(this.baseUrl, options) : providerFetch(this.baseUrl, options, this.bypassProxy ? directFetch : undefined)
  }

  private buildBody(options: LLMRequestOptions): Record<string, unknown> {
    const vision = this.visionCapabilities(options.model)
    validateImages(options, vision)
    const messages: Array<Record<string, unknown>> = []
    const model = options.model || this.defaultModel
    if (this.providerKind === 'openai' && /^(gpt-6-astra|gpt-6\.1-sol)/.test(model) && options.tools?.length) throw new Error(`${model} requires the Responses API for tool calling. This provider connection currently uses Chat Completions; select a compatible model.`)

    if (options.system) {
      messages.push({ role: 'system', content: options.system })
    }

    for (const msg of options.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
      } else if (msg.role === 'assistant') {
        const text = msg.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n')
        const toolCalls = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use').map((tool) => ({
          id: tool.id,
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        }))
        const continuation = msg.continuation?.provider === this.providerKind && msg.continuation.model === model ? msg.continuation.payload as Record<string, unknown> : undefined
        messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(typeof continuation?.reasoning_content === 'string' ? { reasoning_content: continuation.reasoning_content } : {}) })
      } else {
        // The tool messages must follow the assistant's tool_calls directly: a user message between
        // them is rejected. Tool messages take text only, so the user's text and every image
        // (a tool result's too) follow in one user message.
        for (const result of msg.content) {
          if (result.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: toolResultText(result.content) })
        }
        const text = msg.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n')
        const images = msg.content.flatMap(block => block.type === 'image' ? [block] : block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(b => b.type === 'image') : [])
        const parts = images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.source.media_type};base64,${image.source.data}` } }))
        if (parts.length) messages.push({ role: 'user', content: text ? [{ type: 'text', text }, ...parts] : parts })
        else if (text) messages.push({ role: 'user', content: text })
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 8192,
      ...(this.managedLocal ? { cache_prompt: true } : {}),
      ...(this.providerKind === 'openai' && options.cache !== false && options.cacheKey ? cacheHints(model, options.cacheKey) : {}),
    }
    if (options.effort) Object.assign(body, nativeEffort(this.providerKind, model, options.effort, options.maxTokens ?? 8192))
    if (this.providerKind === 'openai' && /^(o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(model)) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens }
    if (this.chatTemplateKwargs) {
      body.chat_template_kwargs = options.effort ? { ...this.chatTemplateKwargs, enable_thinking: true } : this.chatTemplateKwargs
      if (options.effort) body.thinking_budget_tokens = Math.min(LOCAL_THINKING_BUDGET[options.effort], Math.max(0, (options.maxTokens ?? 8192) - 1024))
    }

    if (options.temperature !== undefined && !body.reasoning_effort) body.temperature = options.temperature
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: this.managedLocal ? localToolSchema(tool.input_schema) : tool.input_schema,
        },
      }))
    }

    validateImageRequestSize(body, vision)
    return body
  }

  private parseResponse(data: Record<string, unknown>, model: string): LLMResponse {
    if (data.error) throw new Error(String((data.error as Record<string, unknown>).message ?? 'Model request failed.'))
    const choices = data.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const message = choice?.message as Record<string, unknown> | undefined
    if (!message) throw new Error('Model returned an invalid chat response (missing message).')
    const text = (message?.content as string) ?? ''
    const cutOff = choice?.finish_reason === 'length'
    const incomplete: string[] = []
    const toolUse = ((message?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []).map((call) => {
      const fn = call.function as Record<string, unknown> | undefined
      const id = String(call.id ?? '')
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(String(fn?.arguments ?? '{}')) as Record<string, unknown> }
      catch {
        // Arguments cut off by the output limit: the engine reports the call as cut off and never runs it.
        if (!cutOff) throw new Error(`Model returned invalid JSON arguments for tool ${String(fn?.name ?? 'unknown')}.`)
        incomplete.push(id)
      }
      return { type: 'tool_use' as const, id, name: String(fn?.name ?? 'Tool'), input }
    })
    const usage = openAIUsage(data.usage, this.managedLocal ? data.timings : undefined)

    return {
      content: [...(text ? [{ type: 'text', text } as TextBlock] : []), ...toolUse],
      stopReason: (choice?.finish_reason as string) ?? 'stop',
      usage: usage ?? { inputTokens: 0, outputTokens: 0 }, usageReported: !!usage,
      continuation: typeof message.reasoning_content === 'string' ? { provider: this.providerKind, model, payload: { reasoning_content: message.reasoning_content } } : undefined,
      // Arguments that parse are whole JSON, so only the calls that did not parse were cut off.
      ...(cutOff ? { incompleteToolUse: incomplete } : {}),
    }
  }

  async refreshContextWindow(parentSignal?: AbortSignal): Promise<number | undefined> {
    if (!this.managedLocal) return this.contextWindow
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000)
    for (const endpoint of ['/slots', '/props']) {
      try {
        const response = await localInferenceFetch(new URL(endpoint, this.baseUrl).href, { signal })
        if (!response.ok) continue
        const window = serverContextWindow(await response.json())
        if (window) return this.actualContextWindow = window
      } catch { parentSignal?.throwIfAborted() }
    }
    // A stale or guessed limit must never be used after a server restart.
    this.actualContextWindow = undefined
    throw new Error('Local server did not report its actual context window. Restart the local model.')
  }

  async countTokens(options: LLMRequestOptions): Promise<import('./types.js').TokenCount | undefined> {
    if (!this.managedLocal) return
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000)
    const request = async (path: string, body: unknown) => {
      const response = await directFetch(new URL(path, this.baseUrl).href, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(`Tokenizer HTTP ${response.status}`)
      return response.json() as Promise<Record<string, unknown>>
    }
    // Chat templates such as Qwen's raise "No user query found" for a conversation without a user
    // message (the context measurement before the first message): nothing to count yet.
    if (!options.messages.some(message => message.role === 'user')) return
    try {
      const template = await request('/apply-template', this.buildBody(options))
      if (typeof template.prompt !== 'string') return
      const tokenized = await request('/tokenize', { content: template.prompt, add_special: true, parse_special: true })
      if (!Array.isArray(tokenized.tokens) || !tokenized.tokens.every(token => Number.isInteger(token))) return
      return { tokens: tokenized.tokens.length, source: 'runtime-tokenizer', estimated: false }
    } catch { options.signal?.throwIfAborted(); return undefined }
  }
}

/**
 * A tool schema llama.cpp can compile into a grammar. Its compiler rejects escapes that JSON Schema
 * regexes carry (BrowserPlan's `^\\/.*$`: "unknown escape at \\/") and expands length bounds into
 * repetitions it refuses past a small limit (`char{0,4000}`: "number of repetitions exceeds sane
 * defaults"); one bad rule drops the whole tool-call grammar. So regexes go, and so do large length
 * and array bounds; small ones (an MCP tool's minLength 1) stay. The tools still validate their input.
 */
export function localToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const dropped = (key: string, value: unknown) => key === 'pattern' && typeof value === 'string'
    || (key === 'minLength' || key === 'maxLength') && typeof value === 'number' && value > LOCAL_LENGTH_LIMIT
    || (key === 'minItems' || key === 'maxItems') && typeof value === 'number' && value > LOCAL_ITEMS_LIMIT
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key, item]) => !dropped(key, item)).map(([key, item]) => [key, key === 'properties' ? Object.fromEntries(Object.entries(item as object).map(([name, prop]) => [name, strip(prop)])) : strip(item)]))
    : value
  return strip(schema) as Record<string, unknown>
}
/** Bounds up to these stay: they expand into few rules and keep small inputs honest. */
const LOCAL_LENGTH_LIMIT = 256
const LOCAL_ITEMS_LIMIT = 32
