/**
 * @file gemini.ts
 * @brief Google Gemini API client (generativelanguage.googleapis.com)
 *
 * Maps G-Code LLMClient interface to Gemini's generateContent API.
 * Supports streaming via SSE and function calling (tool use).
 */

import { providerFetch } from './providerFetch.js'
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
import { nativeEffort } from '../shared/effort.js'
import { geminiUsage } from './usage.js'
import { randomUUID } from 'node:crypto'
import { toolResultText, visionCapabilities, validateImages, validateImageRequestSize } from './images.js'

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemini-2.0-flash'

/** Gemini finish reasons that mean the response was blocked rather than finished. */
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'LANGUAGE'])

/**
 * Gemini's finishReason in the shared vocabulary the engine and the handoff
 * writer read (max_tokens, end_turn, tool_use, refusal), so a cut-off reply is
 * retried or reported the same way as on every other provider.
 */
export function geminiStopReason(finishReason: string | undefined, toolCalls: number): string {
  const reason = finishReason?.toUpperCase()
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  if (reason && BLOCKED.has(reason)) return 'refusal'
  // Only STOP is a finish. OTHER, MALFORMED_FUNCTION_CALL and the like stay as they are: see replyEnd.
  if (reason && reason !== 'STOP') return reason
  return toolCalls ? 'tool_use' : 'end_turn'
}

/** Gemini's report that it blocked the prompt, which comes with no candidates. */
const promptBlocked = (data: Record<string, unknown>) => !!(data.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason

export interface GeminiClientOptions {
  apiKey?: string
  defaultModel?: string
  retry?: RetryOptions
}

export class GeminiClient implements LLMClient {
  modelIdentity(model: string) { return { provider: 'gemini', model: model || this.defaultModel } }
  visionCapabilities(model: string) { return visionCapabilities('gemini', model || this.defaultModel) }
  private apiKey: string
  private defaultModel: string
  private retryOptions: RetryOptions

  constructor(options?: GeminiClientOptions) {
    this.apiKey = (options?.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '').trim()
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL
    this.retryOptions = options?.retry ?? {}

    if (!this.apiKey) {
      throw new Error('Google API key required. Set GOOGLE_API_KEY environment variable.')
    }
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      options.beforeSend?.()
      const model = options.model || this.defaultModel
      const url = `${GEMINI_API_URL}/${model}:generateContent?key=${this.apiKey}`
      const body = this.buildBody(options)

      const response = await providerFetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw classifyHTTPError(response.status, await response.text(), response.headers)
      }

      const data = await response.json() as Record<string, unknown>
      return this.parseResponse(data, model)
    }, { ...this.retryOptions, ...(options.noRetry ? { maxRetries: 0 } : {}), signal: options.signal })
  }

  chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent> {
    return guardStreamIdle(options.signal, (signal, watch) => this.stream(options, signal, watch))
  }

  private async *stream(options: LLMRequestOptions, signal: AbortSignal, watch: WatchBody): AsyncGenerator<StreamEvent> {
    options.beforeSend?.()
    const model = options.model || this.defaultModel
    const url = `${GEMINI_API_URL}/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`
    const body = this.buildBody(options)

    const response = await providerFetch(url, {
      ...NO_FETCH_TIMEOUT,
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw classifyHTTPError(response.status, await response.text(), response.headers)
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    let toolCallIdCounter = 0
    let stopReason: string | undefined
    const nativeParts: Record<string, unknown>[] = []
    const end = new EndMarker()
    for await (const data of readSSEData(watch(response.body), end)) {
      if (!data.trim()) continue
      let chunk: Record<string, unknown>
      try { chunk = JSON.parse(data) as Record<string, unknown> }
      catch { throw new Error('Invalid JSON in Gemini response stream.') }
      if (chunk.error) { const error = chunk.error as Record<string, unknown>; throw streamErrorEvent({ type: error.status, message: error.message }) }
      const usage = geminiUsage(chunk.usageMetadata)
      if (usage) yield { type: 'usage', usage }
      const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined
      const candidate = candidates?.[0]
      // The prompt itself was blocked: no candidate will come, and sending it again changes nothing.
      if (!candidate && promptBlocked(chunk)) { stopReason = 'refusal'; end.seen() }
      const content = candidate?.content as Record<string, unknown> | undefined
      const parts = content?.parts as Array<Record<string, unknown>> | undefined
      for (const part of parts ?? []) {
        nativeParts.push(part)
        if (typeof part.text === 'string') yield part.thought === true ? { type: 'thinking', text: part.text } : { type: 'text', text: part.text }
        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>
          const id = typeof fc.id === 'string' ? fc.id : `gemini-tool-${randomUUID()}`
          toolCallIdCounter++
          yield { type: 'tool_use_start', id, name: fc.name as string }
          yield { type: 'tool_use_input', id, partial: JSON.stringify(fc.args ?? {}) }
          yield { type: 'tool_use_end', id }
        }
      }
      const finishReason = candidate?.finishReason as string | undefined
      if (finishReason) { stopReason = geminiStopReason(finishReason, toolCallIdCounter); end.seen() }
    }
    if (!stopReason) throw new StreamEndedError('Gemini response stream ended before completion.')
    yield { type: 'continuation', continuation: { provider: 'gemini', model, payload: nativeParts } }
    yield { type: 'done', stopReason }
  }

  // --------------------------------------------------------------------------
  // Internal: Build Gemini request body
  // --------------------------------------------------------------------------

  private buildBody(options: LLMRequestOptions): Record<string, unknown> {
    const vision = this.visionCapabilities(options.model)
    validateImages(options, vision)
    const contents: Array<Record<string, unknown>> = []

    // System instruction
    const systemInstruction = options.system
      ? { parts: [{ text: options.system }] }
      : undefined

    const toolNames = new Map<string, string>()
    const nativeCallIds = new Set<string>()
    for (const message of options.messages) {
      if (message.continuation?.provider === 'gemini' && message.continuation.model === (options.model || this.defaultModel) && Array.isArray(message.continuation.payload)) {
        for (const part of message.continuation.payload) {
          if (typeof part?.functionCall?.id === 'string') nativeCallIds.add(part.functionCall.id)
        }
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_use') toolNames.set(block.id, block.name)
        }
      }
    }

    // Messages → Gemini contents
    for (const msg of options.messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user'
      const parts: Array<Record<string, unknown>> = []
      if (role === 'model' && msg.continuation?.provider === 'gemini' && msg.continuation.model === (options.model || this.defaultModel) && Array.isArray(msg.continuation.payload)) { contents.push({ role, parts: msg.continuation.payload }); continue }

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else {
        // Function responses first, right after the calls they answer; then text and images.
        for (const block of msg.content) if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              ...(nativeCallIds.has(block.tool_use_id) ? { id: block.tool_use_id } : {}),
              name: toolNames.get(block.tool_use_id) ?? block.tool_use_id,
              response: { content: toolResultText(block.content) },
            },
          })
        }
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: { name: block.name, args: block.input },
            })
          } else if (block.type === 'image') {
            parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } })
          }
        }
        // Inline image parts also work with older Gemini function-response
        // schemas, which cannot carry media inside response JSON.
        for (const block of msg.content) if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const image of block.content) if (image.type === 'image') parts.push({ inlineData: { mimeType: image.source.media_type, data: image.source.data } })
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts })
      }
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 8192,
        temperature: options.temperature,
        ...(options.effort ? nativeEffort('gemini', options.model || this.defaultModel, options.effort, options.maxTokens ?? 8192) : {}),
      },
    }

    if (systemInstruction) body.systemInstruction = systemInstruction

    // Tools → Gemini function declarations
    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      }]
    }

    validateImageRequestSize(body, vision)
    return body
  }

  private parseResponse(data: Record<string, unknown>, model: string): LLMResponse {
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined
    const candidate = candidates?.[0]
    const content = candidate?.content as Record<string, unknown> | undefined
    const parts = content?.parts as Array<Record<string, unknown>> | undefined
    const usage = geminiUsage(data.usageMetadata)

    const blocks: ContentBlock[] = []
    let toolCallIdCounter = 0

    if (parts) {
      for (const part of parts) {
        if (part.text && part.thought !== true) {
          blocks.push({ type: 'text', text: part.text as string })
        }
        if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>
          blocks.push({
            type: 'tool_use',
            id: typeof fc.id === 'string' ? fc.id : `gemini-tool-${randomUUID()}`,
            name: fc.name as string,
            input: (fc.args as Record<string, unknown>) ?? {},
          })
          toolCallIdCounter++
        }
      }
    }

    const finishReason = candidate?.finishReason as string | undefined

    return {
      content: blocks,
      stopReason: !candidate && promptBlocked(data) ? 'refusal' : geminiStopReason(finishReason, toolCallIdCounter),
      usage: usage ?? { inputTokens: 0, outputTokens: 0 }, usageReported: !!usage,
      continuation: { provider: 'gemini', model, payload: parts ?? [] },
    }
  }
}
