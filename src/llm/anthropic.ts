/**
 * @file anthropic.ts
 * @brief Claude API client — zero @anthropic-ai/* dependencies
 *
 * Direct HTTP integration with the Anthropic Messages API.
 * Supports both streaming and non-streaming modes.
 */

import { disableAdvice } from '../mcp/surface.js'
import { providerFetch } from './providerFetch.js'
import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  LLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  ProviderContinuation,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from './types.js'
import { withRetry, classifyHTTPError, streamErrorEvent, StreamEndedError, type RetryOptions } from './retry.js'
import { USER_AGENT } from './ua.js'
import { EndMarker, readSSEData } from './sse.js'
import { NO_FETCH_TIMEOUT, guardStreamIdle, type WatchBody } from './streamIdle.js'
import { nativeEffort } from '../shared/effort.js'
import { anthropicUsage } from './usage.js'
import { visionCapabilities, validateImages, validateImageRequestSize } from './images.js'
import { ANTHROPIC_LAYOUT_PROVIDER, isNativeLayout, nativeContent, nativeLayout } from './nativeBlocks.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MODEL = 'claude-opus-5-5'

// Canonical schema objects prevent equivalent tool definitions from invalidating
// the cached prefix. Array order (including enum/required) remains meaningful.
function stableKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableKeys)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stableKeys(child)]),
  )
  return value
}

// ----------------------------------------------------------------------------
// Replaying thinking across an edited history
// ----------------------------------------------------------------------------

/**
 * Native assistant blocks plus a digest of everything the request that produced
 * them sent before them: the system prompt, the tool set and each message as sent.
 * The payload is a NativeLayout (src/llm/nativeBlocks.ts): the thinking blocks and
 * their places, the text and tool calls being in the saved message's content; its
 * provider is ANTHROPIC_LAYOUT_PROVIDER. A session saved before that holds the whole
 * native list (an array) under 'anthropic'.
 */
export type AnthropicContinuation = ProviderContinuation & { prefixDigest?: string }

const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking'])
const isThinking = (block: unknown) => !!block && typeof block === 'object' && THINKING_BLOCKS.has(String((block as { type?: unknown }).type))
const canonical = (value: unknown) => JSON.stringify(stableKeys(value))

/**
 * The history as sent, with each turn's native blocks (signed thinking included)
 * only where that turn's prefix is unchanged.
 *
 * On models with preserved thinking a thinking block's signature binds the system
 * prompt, the tool set and every message before it, and a request that replays
 * a block whose prefix was edited is rejected with a 400 (Anthropic's model migration notes). G-Code edits that prefix when it compacts (keep-tail),
 * collapses old tool rounds, resumes an interrupted turn from its journal, or
 * rebuilds the system prompt. The documented client-side remedy for kept turns
 * is to strip their thinking and keep their text and tool calls, as a
 * deterministic function of the stored transcript (same file, keep-tail
 * compaction; shared/preserved-thinking-migration.md, "Compact in a shape the
 * check honours"). A turn keeps its thinking only when its recorded digest
 * matches what this request sends before it. Earlier strips are part of that
 * digest, so a stripped block never comes back once later turns were produced
 * without it ("Remove thinking only as a contiguous run").
 */
export function replayHistory(history: LLMMessage[], model: string, system: string | undefined, tools: unknown[] | undefined): { messages: Array<{ role: LLMMessage['role']; content: unknown }>; prefixDigest: string } {
  const hash = createHash('sha256').update(canonical({ system: system ?? '', tools: tools ?? [] }))
  const messages = history.map(message => {
    const native = message.role === 'assistant' ? replayable(message.continuation, model) : undefined
    // The native blocks: rebuilt from the saved content and the stored thinking, or (a session saved
    // before the layout) the whole native list as it was saved.
    const blocks = native ? isNativeLayout(native.payload) ? nativeContent(message.content, native.payload) : native.payload : undefined
    let content: unknown = native ? blocks : message.role === 'user' ? toolResultsFirst(message.content) : message.content
    if (native && Array.isArray(blocks) && blocks.some(isThinking) && native.prefixDigest !== hash.copy().digest('hex')) {
      const kept = blocks.filter(block => !isThinking(block))
      // A reply that was only thinking still needs content to stay a valid turn.
      content = kept.length ? kept : message.content.length ? message.content : [{ type: 'text', text: '(no reply text)' }]
    }
    const sent = { role: message.role, content }
    hash.update('\n').update(canonical(sent))
    return sent
  })
  return { messages, prefixDigest: hash.digest('hex') }
}

/** The API rejects a user message whose tool results do not come first: text and images go after them. */
function toolResultsFirst(content: LLMMessage['content']): LLMMessage['content'] {
  if (typeof content === 'string') return content
  const other = content.findIndex(block => block.type !== 'tool_result')
  if (other < 0 || !content.some((block, index) => index > other && block.type === 'tool_result')) return content
  return [...content.filter(block => block.type === 'tool_result'), ...content.filter(block => block.type !== 'tool_result')]
}

/**
 * A saved continuation this model's requests replay: the layout form under its own provider, or
 * under 'anthropic' the whole native list (sessions saved before the layout) or a layout (saved by
 * the first runtime that wrote one). Anything else is sent as the message's content.
 */
function replayable(continuation: LLMMessage['continuation'], model: string): AnthropicContinuation | undefined {
  if (!continuation || continuation.model !== model) return undefined
  const { provider, payload } = continuation
  const known = provider === ANTHROPIC_LAYOUT_PROVIDER ? isNativeLayout(payload) : provider === 'anthropic' && (Array.isArray(payload) || isNativeLayout(payload))
  return known ? continuation as AnthropicContinuation : undefined
}

export interface AnthropicClientOptions {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  retry?: RetryOptions
}

/** "tools.31.custom.input_schema…" tells a person nothing: name the tool, and for an MCP tool how to turn off the server that offers it. */
function withToolName<E extends Error>(error: E, tools: unknown): E {
  const index = /\btools\.(\d+)\b/.exec(error.message)?.[1]
  const name = index !== undefined && Array.isArray(tools) ? (tools[Number(index)] as { name?: unknown } | undefined)?.name : undefined
  if (typeof name !== 'string') return error
  const server = /^mcp__(.+?)__/.exec(name)?.[1]
  error.message += server ? ` That is the tool ${name}, from the MCP server "${server}". Every request carries it, so ${disableAdvice(server).replace('turn it off', 'turn the server off')} and start a new chat.` : ` That is the tool ${name}.`
  return error
}

export class AnthropicClient implements LLMClient {
  modelIdentity(model: string) { return { provider: 'anthropic', model: model || this.defaultModel } }
  visionCapabilities(model: string) { return visionCapabilities('anthropic', model || this.defaultModel) }
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private retryOptions: RetryOptions
  /** One boundary per conversation, since children and writers share this client. */
  private cacheBoundaries = new Map<string, { prefix: string; count: number; digest: string }>()

  constructor(options?: AnthropicClientOptions) {
    // A blank key is no key: it must fail here, not as an HTTP 401 after a session was started.
    this.apiKey = (options?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '').trim()
    this.baseUrl = options?.baseUrl ?? ANTHROPIC_API_URL
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL
    this.retryOptions = options?.retry ?? {}

    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key required. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.',
      )
    }
  }

  // --------------------------------------------------------------------------
  // Non-streaming
  // --------------------------------------------------------------------------

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      options.beforeSend?.()
      const { body, prefixDigest, remember } = this.buildRequestBody(options, false)
      const response = await providerFetch(this.baseUrl, {
        method: 'POST',
        signal: options.signal,
        headers: this.headers(),
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text()
        throw withToolName(classifyHTTPError(response.status, text, response.headers), body.tools)
      }

      const data = await response.json() as Record<string, unknown>
      const result = this.parseResponse(data, options.model || this.defaultModel, prefixDigest)
      remember?.()
      return result
    }, { ...this.retryOptions, ...(options.noRetry ? { maxRetries: 0 } : {}), signal: options.signal })
  }

  // --------------------------------------------------------------------------
  // Streaming
  // --------------------------------------------------------------------------

  chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent> {
    return guardStreamIdle(options.signal, (signal, watch) => this.stream(options, signal, watch))
  }

  private async *stream(options: LLMRequestOptions, signal: AbortSignal, watch: WatchBody): AsyncGenerator<StreamEvent> {
    options.beforeSend?.()
    const { body, prefixDigest, remember } = this.buildRequestBody(options, true)
    const response = await providerFetch(this.baseUrl, {
      ...NO_FETCH_TIMEOUT,
      method: 'POST',
      signal,
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw withToolName(classifyHTTPError(response.status, text, response.headers), body.tools)
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    const state = { toolId: '', toolName: '', inputBuffer: '', stopReason: 'end_turn' }
    let complete = false
    let usageFields: Record<string, unknown> = {}
    // The reply's native blocks, for its continuation (tool calls are kept there by id only).
    const nativeBlocks = new Map<number, Record<string, unknown>>()
    const end = new EndMarker()
    for await (const data of readSSEData(watch(response.body), end)) {
      if (!data.trim() || data === '[DONE]') continue
      let event: Record<string, unknown>
      try { event = JSON.parse(data) as Record<string, unknown> }
      catch { throw new Error('Invalid JSON in Anthropic response stream.') }
      // An error event ends the reply: overloads, rate limits and server errors are retryable while nothing has streamed.
      if (event.type === 'error') throw streamErrorEvent(event.error as { type?: unknown; message?: unknown } | undefined, Object.keys(usageFields).length > 0)
      if (event.type === 'message_start') usageFields = (event.message as any)?.usage ?? {}
      if (event.type === 'message_delta') usageFields = { ...usageFields, ...((event.usage as Record<string, unknown>) ?? {}) }
      if (event.type === 'message_start' || event.type === 'message_delta') { const usage = anthropicUsage(usageFields); if (usage) yield { type: 'usage', usage } }
      const index = Number(event.index ?? 0)
      if (event.type === 'content_block_start') nativeBlocks.set(index, { ...(event.content_block as Record<string, unknown>) })
      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>, block = nativeBlocks.get(index)
        if (block && delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '')
        if (block && delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
        if (block && delta.type === 'signature_delta') block.signature = String(block.signature ?? '') + String(delta.signature ?? '')
        // A block kept whole that streams its input (a server tool call); a tool_use is kept by id.
        if (block && block.type !== 'tool_use' && delta.type === 'input_json_delta') block.partial = String(block.partial ?? '') + String(delta.partial_json ?? '')
      }
      if (event.type === 'content_block_stop') {
        const block = nativeBlocks.get(index)
        if (block && typeof block.partial === 'string') { try { block.input = JSON.parse(block.partial) } catch { block.input = {} } delete block.partial }
      }
      if (event.type === 'message_stop') { complete = true; end.seen() }
      yield* this.processSSEEvent(event, state)
    }
    if (!complete) throw new StreamEndedError('Anthropic response stream ended before completion.')
    remember?.()
    // A thinking block cut off by max_tokens has no signature and can never be sent back. The text
    // and tool calls are kept by reference: the engine saves them in the message's content.
    const payload = nativeLayout([...nativeBlocks.entries()].sort(([a], [b]) => a - b).map(([, { partial: _cut, ...block }]) => block)
      .filter(block => block.type !== 'thinking' || !!block.signature))
    const continuation: AnthropicContinuation = { provider: ANTHROPIC_LAYOUT_PROVIDER, model: options.model || this.defaultModel, payload, prefixDigest }
    yield { type: 'continuation', continuation }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'User-Agent': USER_AGENT,
    }
  }

  private buildRequestBody(
    options: LLMRequestOptions,
    stream: boolean,
  ): { body: Record<string, unknown>; prefixDigest: string; remember?: () => void } {
    const vision = this.visionCapabilities(options.model)
    validateImages(options, vision)
    const model = options.model || this.defaultModel
    const cache = options.cache !== false
    // Streamed tool arguments arrive as they are written (eager input streaming); without it the API
    // holds a large argument, such as a file's content, until all of it is written. Only on the
    // official endpoint: proxies may reject the field. The engine parses and validates the arguments.
    const eager = stream && this.baseUrl === ANTHROPIC_API_URL
    // Engines provide a frozen, inherited conversation order. Standalone callers
    // without a conversation identity retain the canonical ordering they used before.
    const ordered = options.tools?.length ? options.cacheKey ? options.tools : [...options.tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : undefined
    // A cache breakpoint at the end of the tools (the stable start of every request), one at the end
    // of the system prompt, and the automatic one at the end: a request whose messages differ from
    // the start, the first after a compaction or in a new session, still reads the tools from the cache.
    const tools = ordered?.map((tool, index) => stableKeys({ ...tool, ...(eager ? { eager_input_streaming: true } : {}), ...(cache && index === ordered.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }))
    const { messages, prefixDigest } = replayHistory(options.messages, model, options.system || undefined, tools)
    let remember: (() => void) | undefined
    if (cache && options.cacheKey && messages.length) {
      const key = `${model}:${options.cacheKey}`
      const prefix = canonical({ system: options.system ?? '', tools, effort: options.effort })
      const previous = this.cacheBoundaries.get(key)
      // Hash unannotated history: cache markers do not alter signed-thinking replay digests.
      const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
      const next = { prefix, count: messages.length, digest: digest(messages) }
      if (previous?.prefix === prefix && previous.count < messages.length && previous.digest === digest(messages.slice(0, previous.count))) {
        const last = messages[previous.count - 1]!
        const blocks: any[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : Array.isArray(last.content) ? [...last.content] : []
        // The previous request's last cacheable block remains visible beyond the 20-block scan.
        const index = blocks.map(block => ['text', 'image', 'tool_use', 'tool_result'].includes(block.type)).lastIndexOf(true)
        if (index >= 0) { blocks[index] = { ...blocks[index], cache_control: { type: 'ephemeral' } }; last.content = blocks }
      }
      remember = () => {
        this.cacheBoundaries.delete(key); this.cacheBoundaries.set(key, next)
        if (this.cacheBoundaries.size > 128) this.cacheBoundaries.delete(this.cacheBoundaries.keys().next().value!)
      }
    }
    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream,
      // A one-off request nothing repeats is not written to the cache (a write costs 1.25x input).
      ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
    }

    // The system prompt is frozen per session: a breakpoint at its end lets a request whose messages
    // differ from the start (the first after a compaction, a handoff session) read it from the cache
    // instead of writing it again. With the tools and the automatic one, three of the four allowed.
    if (options.system) body.system = cache ? [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }] : options.system
    if (tools) body.tools = tools
    // Anthropic no longer accepts sampling parameters. Other adapters retain
    // their own model-specific settings.
    if (options.effort) Object.assign(body, nativeEffort('anthropic', options.model || this.defaultModel, options.effort, options.maxTokens ?? DEFAULT_MAX_TOKENS))

    validateImageRequestSize(body, vision)
    return { body, prefixDigest, remember }
  }

  private parseResponse(data: Record<string, unknown>, model: string, prefixDigest: string): LLMResponse {
    const rawContent = data.content as Array<Record<string, unknown>> | undefined
    const content: ContentBlock[] = (rawContent ?? []).filter(block => block.type === 'text' || block.type === 'tool_use').map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text as string } as TextBlock
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id as string,
          name: block.name as string,
          input: block.input as Record<string, unknown>,
        } as ToolUseBlock
      }
      return { type: 'text', text: JSON.stringify(block) } as TextBlock
    })

    const usage = anthropicUsage(data.usage)
    // max_tokens stops the reply inside its last block: a tool_use there was still being written.
    // Every earlier call is complete, and so is a final one when the reply ended any other way.
    const last = rawContent?.at(-1)
    const cutOff = data.stop_reason === 'max_tokens'

    return {
      content,
      ...(cutOff ? { incompleteToolUse: last?.type === 'tool_use' ? [String(last.id)] : [] } : {}),
      stopReason: (data.stop_reason as string) ?? 'end_turn',
      usage: usage ?? { inputTokens: 0, outputTokens: 0 }, usageReported: !!usage,
      // As in a stream: a thinking block cut off by max_tokens has no signature and cannot be sent back.
      continuation: { provider: ANTHROPIC_LAYOUT_PROVIDER, model, payload: nativeLayout((rawContent ?? []).filter(block => block.type !== 'thinking' || !!block.signature)), prefixDigest } as AnthropicContinuation,
    }
  }

  private *processSSEEvent(
    event: Record<string, unknown>,
    state: { toolId: string; toolName: string; inputBuffer: string; stopReason: string },
  ): Generator<StreamEvent> {
    const eventType = event.type as string

    switch (eventType) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          state.toolId = block.id as string
          state.toolName = block.name as string
          state.inputBuffer = ''
          yield { type: 'tool_use_start', id: state.toolId, name: state.toolName }
        } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          // With thinking display omitted the only delta is an empty one at the end of the
          // block, so its start is the only sign the model is thinking.
          yield { type: 'thinking', text: '' }
        }
        break
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          yield { type: 'text', text: delta.text as string }
        } else if (delta?.type === 'input_json_delta') {
          const partial = delta.partial_json as string ?? ''
          state.inputBuffer += partial
          yield { type: 'tool_use_input', id: state.toolId, partial }
        } else if (delta?.type === 'thinking_delta') {
          yield { type: 'thinking', text: String(delta.thinking ?? '') }
        }
        break
      }

      case 'content_block_stop': {
        if (state.toolId) {
          yield { type: 'tool_use_end', id: state.toolId }
          state.toolId = ''
          state.toolName = ''
          state.inputBuffer = ''
        }
        break
      }

      case 'message_delta': {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) {
          state.stopReason = delta.stop_reason as string
        }
        break
      }

      case 'message_stop':
        yield { type: 'done', stopReason: state.stopReason }
        break

      case 'error': {
        const error = event.error as Record<string, unknown> | undefined
        yield { type: 'error', error: (error?.message as string) ?? 'Unknown error' }
        break
      }
    }
  }
}
