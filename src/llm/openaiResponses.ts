/**
 * OpenAI's Responses API, for the models whose tool calls with reasoning effort Chat Completions
 * refuses (gpt-6.1-terra: "Function tools with reasoning_effort are not supported ... in
 * /v1/chat/completions"; gpt-6-astra and gpt-6.1-sol need it for any tool call).
 *
 * Stateless (`store: false`): every request sends the whole conversation, so prompt caching and
 * G-Code's own history work as with Chat Completions. Encrypted reasoning items are kept as the
 * assistant message's continuation and sent back with it, so the model keeps its reasoning
 * across tool calls.
 */
import { providerFetch } from './providerFetch.js'
import type { ContentBlock, ImageBlock, LLMMessage, LLMRequestOptions, LLMResponse, StreamEvent, TextBlock, ToolUseBlock } from './types.js'
import { withRetry, classifyHTTPError, streamErrorEvent, StreamEndedError, type RetryOptions } from './retry.js'
import { NO_FETCH_TIMEOUT, guardStreamIdle, type WatchBody } from './streamIdle.js'
import { USER_AGENT } from './ua.js'
import { readSSEData } from './sse.js'
import { directFetch } from './directFetch.js'
import { toolResultText, visionCapabilities, validateImages, validateImageRequestSize } from './images.js'
import { nativeEffort } from '../shared/effort.js'
import { responsesUsage } from './usage.js'

/** OpenAI models served through the Responses API (gpt-6 family). */
export const usesResponsesApi = (model: string): boolean => /^gpt-6(?:[.-]|$)/.test(model)

type Item = Record<string, unknown>
/** What an assistant message keeps for the next request: the provider's own output items. */
interface ResponsesContinuation { output: Item[] }

const image = (block: ImageBlock): Item => ({ type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` })

/**
 * The input items for one assistant message. Reasoning items from its continuation are put back in
 * their places when the message still matches what the model produced (same text and calls);
 * text and calls always come from G-Code's history, which may have been edited since.
 */
function assistantItems(message: LLMMessage, native: ResponsesContinuation | undefined): Item[] {
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as TextBlock] : message.content
  const texts = blocks.filter((b): b is TextBlock => b.type === 'text').map(b => b.text)
  const text = texts.join('\n')
  const calls = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
  const call = (tool: ToolUseBlock): Item => ({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.input) })
  const said = (value: string): Item => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
  const output = native?.output ?? []
  const nativeTexts = output.filter(i => i.type === 'message').map(i => ((i.content as Item[] | undefined) ?? []).filter(p => p.type === 'output_text').map(p => String(p.text ?? '')).join(''))
  const nativeCalls = output.filter(i => i.type === 'function_call').map(i => String(i.call_id))
  // A streamed reply keeps all its text as one run and a non-streamed one a block per message item,
  // so the text is compared without separators: a reply of several text parts still replays.
  const matches = output.length > 0 && nativeTexts.join('') === texts.join('') && nativeCalls.length === calls.length && nativeCalls.every((id, n) => id === calls[n]!.id)
  if (!matches) return [...(text ? [said(text)] : []), ...calls.map(call)]
  let next = 0
  return output.flatMap((item): Item[] => {
    if (item.type === 'reasoning' && typeof item.encrypted_content === 'string') return [{ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: Array.isArray(item.summary) ? item.summary : [] }]
    // The same words as history, each back in its own place among the reasoning and calls.
    if (item.type === 'message') { const value = nativeTexts[next++]; return value ? [said(value)] : [] }
    if (item.type === 'function_call') { const tool = calls.find(c => c.id === item.call_id); return tool ? [call(tool)] : [] }
    return []
  })
}

/** Tool outputs first, right after the calls they answer; then any text and images. */
function userItems(message: LLMMessage): Item[] {
  if (typeof message.content === 'string') return [{ role: 'user', content: message.content }]
  const items: Item[] = []
  for (const block of message.content) if (block.type === 'tool_result') items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolResultText(block.content) })
  const parts: Item[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text) parts.push({ type: 'input_text', text: block.text })
    else if (block.type === 'image') parts.push(image(block))
    else if (block.type === 'tool_result' && Array.isArray(block.content)) for (const inner of block.content) if (inner.type === 'image') parts.push(image(inner))
  }
  if (parts.length) items.push({ role: 'user', content: parts })
  return items
}

export class OpenAIResponsesClient {
  constructor(private readonly options: { apiKey: string; url: string; retry: RetryOptions; bypassProxy: boolean; cacheHints: (model: string, key: string) => Record<string, unknown> }) {}

  buildBody(options: LLMRequestOptions, model: string): Record<string, unknown> {
    const vision = visionCapabilities('openai', model)
    validateImages(options, vision)
    const input: Item[] = []
    for (const message of options.messages) {
      if (message.role === 'assistant') {
        const native = message.continuation?.provider === 'openai' && message.continuation.model === model ? message.continuation.payload as ResponsesContinuation : undefined
        input.push(...assistantItems(message, Array.isArray(native?.output) ? native : undefined))
      } else input.push(...userItems(message))
    }
    const effort = options.effort ? nativeEffort('openai', model, options.effort, options.maxTokens ?? 8192).reasoning_effort : undefined
    const body: Record<string, unknown> = {
      model, input, store: false, max_output_tokens: options.maxTokens ?? 8192,
      // Without stored responses, reasoning travels back only in its encrypted form.
      ...(effort ? { reasoning: { effort }, include: ['reasoning.encrypted_content'] } : {}),
      ...(options.system ? { instructions: options.system } : {}),
      ...(options.cache !== false && options.cacheKey ? this.options.cacheHints(model, options.cacheKey) : {}),
    }
    if (options.temperature !== undefined && !effort) body.temperature = options.temperature
    if (options.tools?.length) body.tools = options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false }))
    validateImageRequestSize(body, vision)
    return body
  }

  private post(body: Record<string, unknown>, signal?: AbortSignal, extra: RequestInit = {}): Promise<Response> {
    const init: RequestInit = { ...extra, method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}`, 'User-Agent': USER_AGENT }, body: JSON.stringify(body) }
    return providerFetch(this.options.url, init, this.options.bypassProxy ? directFetch : undefined)
  }

  async chat(options: LLMRequestOptions, model: string): Promise<LLMResponse> {
    return withRetry(async () => {
      options.beforeSend?.()
      const response = await this.post(this.buildBody(options, model), options.signal)
      if (!response.ok) throw classifyHTTPError(response.status, await response.text(), response.headers)
      return parseResponse(await response.json() as Item, model)
    }, { ...this.options.retry, ...(options.noRetry ? { maxRetries: 0 } : {}), signal: options.signal })
  }

  chatStream(options: LLMRequestOptions, model: string): AsyncGenerator<StreamEvent> {
    return guardStreamIdle(options.signal, (signal, watch) => this.stream(options, model, signal, watch))
  }

  private async *stream(options: LLMRequestOptions, model: string, signal: AbortSignal, watch: WatchBody): AsyncGenerator<StreamEvent> {
    options.beforeSend?.()
    const response = await this.post({ ...this.buildBody(options, model), stream: true }, signal, NO_FETCH_TIMEOUT)
    if (!response.ok) throw classifyHTTPError(response.status, await response.text(), response.headers)
    if (!response.body) { yield { type: 'error', error: 'No response body' }; return }
    const calls = new Map<string, { callId: string; ended: boolean }>()
    const output: Item[] = []
    for await (const data of readSSEData(watch(response.body))) {
      if (!data.trim() || data.trim() === '[DONE]') continue
      let event: Item
      try { event = JSON.parse(data) as Item } catch { throw new Error('Invalid JSON in model response stream.') }
      const item = event.item as Item | undefined
      switch (event.type) {
        case 'response.output_item.added':
          if (item?.type === 'function_call') {
            const callId = String(item.call_id ?? item.id)
            calls.set(String(item.id), { callId, ended: false })
            yield { type: 'tool_use_start', id: callId, name: String(item.name ?? 'Tool') }
          }
          break
        case 'response.function_call_arguments.delta': {
          const call = calls.get(String(event.item_id))
          if (call && typeof event.delta === 'string' && event.delta) yield { type: 'tool_use_input', id: call.callId, partial: event.delta }
          break
        }
        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta) yield { type: 'text', text: event.delta }
          break
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof event.delta === 'string' && event.delta) yield { type: 'thinking', text: event.delta }
          break
        case 'response.output_item.done':
          if (item) {
            output.push(item)
            const call = item.type === 'function_call' ? calls.get(String(item.id)) : undefined
            if (call && !call.ended) { call.ended = true; yield { type: 'tool_use_end', id: call.callId } }
          }
          break
        case 'response.completed':
        case 'response.incomplete': {
          const result = event.response as Item | undefined
          for (const call of calls.values()) if (!call.ended) { call.ended = true; yield { type: 'tool_use_end', id: call.callId } }
          const usage = responsesUsage(result?.usage)
          if (usage) yield { type: 'usage', usage }
          if (output.length) yield { type: 'continuation', continuation: { provider: 'openai', model, payload: { output } satisfies ResponsesContinuation } }
          yield { type: 'done', stopReason: stopReason(result, calls.size > 0) }
          return
        }
        case 'response.failed':
        case 'error': {
          // An `error` event carries its code on itself, beside its own type 'error'.
          const failure = ((event.response as Item | undefined)?.error ?? event.error ?? event) as Item
          throw streamErrorEvent({ type: failure.code ?? (failure === event ? undefined : failure.type), message: failure.message })
        }
      }
    }
    throw new StreamEndedError('Model response stream ended before completion.')
  }
}

/** 'length' when the output limit cut the reply, as Chat Completions reports it. */
function stopReason(response: Item | undefined, calledTools: boolean): string {
  const incomplete = response?.incomplete_details as Item | undefined
  if (response?.status === 'incomplete') return incomplete?.reason === 'max_output_tokens' ? 'length' : String(incomplete?.reason ?? 'incomplete')
  return calledTools ? 'tool_calls' : 'stop'
}

function parseResponse(data: Item, model: string): LLMResponse {
  if (data.error) throw new Error(String((data.error as Item).message ?? 'Model request failed.'))
  const output = (data.output as Item[] | undefined) ?? []
  const cutOff = stopReason(data, false) === 'length'
  const incomplete: string[] = []
  const content: ContentBlock[] = []
  for (const item of output) {
    if (item.type === 'message') {
      const text = ((item.content as Item[] | undefined) ?? []).filter(p => p.type === 'output_text').map(p => String(p.text ?? '')).join('')
      if (text) content.push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      const id = String(item.call_id ?? item.id ?? '')
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(String(item.arguments ?? '{}')) as Record<string, unknown> }
      catch {
        if (!cutOff) throw new Error(`Model returned invalid JSON arguments for tool ${String(item.name ?? 'unknown')}.`)
        incomplete.push(id)
      }
      content.push({ type: 'tool_use', id, name: String(item.name ?? 'Tool'), input })
    }
  }
  const usage = responsesUsage(data.usage)
  return {
    content, stopReason: stopReason(data, content.some(b => b.type === 'tool_use')),
    usage: usage ?? { inputTokens: 0, outputTokens: 0 }, usageReported: !!usage,
    ...(output.length ? { continuation: { provider: 'openai', model, payload: { output } satisfies ResponsesContinuation } } : {}),
    ...(cutOff ? { incompleteToolUse: incomplete } : {}),
  }
}
