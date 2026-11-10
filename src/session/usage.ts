import { AsyncLocalStorage } from 'node:async_hooks'
const usageScope = new AsyncLocalStorage<boolean>()
import type { LLMClient, LLMRequestOptions, StreamEvent, TokenUsage } from '../llm/types.js'
import { APIError, RequestNotSentError, neverConnected } from '../llm/retry.js'

/** How a request ended, for the session's usage: `partial` when its stream stopped before the end. */
export interface UsageRecordFlags { partial?: boolean; aborted?: boolean; cacheInvalidation?: boolean }

/**
 * A request that was never processed: refused before it was sent (a local check), never sent
 * because no connection could be made, answered with an HTTP error status, or stopped by an
 * overload or rate limit before the model generated anything. Providers do not bill those, so they
 * are not counted, and they must not hide the session's cost as usage that was never reported.
 */
export function notBilled(error: unknown, usage: TokenUsage | undefined, generated = false): boolean {
  if (error instanceof RequestNotSentError) return true
  if (!usage && !generated && neverConnected(error)) return true
  if (!(error instanceof APIError)) return false
  // An overload or rate limit the stream reported before the model generated anything is the same
  // refusal as its HTTP status (and is retried). Once it has generated (thinking counts, shown or
  // not), the request may be billed: it is kept, as partial.
  return error.midStream ? !generated && error.retryable : !usage
}

/** Cancellation is separate from a completed request whose provider omitted usage. */
function wasAborted(request: LLMRequestOptions, error: unknown): boolean {
  return !!request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
}

/** Events that mean the model generated part of a reply: thinking (shown or not), text or a tool call. */
const GENERATED = new Set<StreamEvent['type']>(['thinking', 'text', 'tool_use_start', 'tool_use_input'])

/** Characters of reply a stream delivered: what a request cut off before its final usage produced at least. */
function replyChars(event: StreamEvent): number {
  if (event.type === 'text' || event.type === 'thinking') return event.text.length
  if (event.type === 'tool_use_input') return event.partial.length
  return 0
}

/**
 * Count the last snapshot once per actual client request, including partial failures.
 * countTokens is measurement only, and is intentionally not charged here.
 *
 * A stream that ends before it completes (an error event mid-reply, a dropped connection, Stop)
 * carries only the usage reported when it started, whose output count is provisional: it is
 * recorded as partial, with at least the output its delivered text implies (about four
 * characters per token).
 */
export function trackUsage(client: LLMClient, record: (identity: { provider: string; model: string }, usage?: TokenUsage, flags?: UsageRecordFlags) => void, cacheKey?: string): LLMClient {
  const identity = (request: LLMRequestOptions) => client.modelIdentity?.(request.model) ?? { provider: 'unknown', model: request.model }
  let previous: { prefix: string; messages: string; count: number } | undefined
  const prepare = (request: LLMRequestOptions) => {
    if (request.cache === false) return { request, cacheInvalidation: false, remember: () => {} }
    const prefix = JSON.stringify([request.model, request.system, request.tools])
    const history = request.messages.map(({ role, content }) => ({ role, content }))
    const cacheInvalidation = !!previous && (previous.prefix !== prefix || previous.count > history.length || JSON.stringify(history.slice(0, previous.count)) !== previous.messages)
    const next = { prefix, messages: JSON.stringify(history), count: history.length }
    return { request: { ...request, ...(cacheKey && !request.cacheKey ? { cacheKey } : {}) }, cacheInvalidation, remember: () => { previous = next } }
  }
  return {
    get contextWindow() { return client.contextWindow },
    get managedLocal() { return client.managedLocal },
    get budgetLocal() { return client.budgetLocal },
    refreshContextWindow: client.refreshContextWindow?.bind(client),
    maxOutputTokens: client.maxOutputTokens,
    visionCapabilities: client.visionCapabilities?.bind(client), modelIdentity: client.modelIdentity?.bind(client),
    countTokens: client.countTokens?.bind(client),
    async chat(request) {
      if (usageScope.getStore()) return client.chat(request)
      const prepared = prepare(request); request = prepared.request
      let usage: TokenUsage | undefined, failure: unknown
      try { const response = await usageScope.run(true, () => client.chat(request)); if (response.usageReported !== false) usage = response.usage; return response }
      catch (error) { failure = error; throw error }
      finally { if (!notBilled(failure, usage)) {
        if (!failure || usage) prepared.remember()
        const flags = { ...(!usage && wasAborted(request, failure) ? { aborted: true } : {}), ...(prepared.cacheInvalidation && (!failure || usage) ? { cacheInvalidation: true } : {}) }
        record(identity(request), usage, Object.keys(flags).length ? flags : undefined)
      } }
    },
    async *chatStream(request) {
      if (usageScope.getStore()) { yield* client.chatStream(request); return }
      const prepared = prepare(request); request = prepared.request
      let usage: TokenUsage | undefined, failure: unknown, completed = false, chars = 0, generated = false
      try {
        const stream = client.chatStream(request)
        try { for (;;) {
          const next = await usageScope.run(true, () => stream.next())
          if (next.done) break
          const event = next.value
          if (event.type === 'usage') usage = { ...event.usage }
          if (GENERATED.has(event.type)) generated = true
          chars += replyChars(event)
          yield event
        } } finally { await usageScope.run(true, () => stream.return(undefined)) }
        completed = !request.signal?.aborted
      } catch (error) { failure = error; throw error }
      finally {
        if (!notBilled(failure, usage, generated)) {
          if (completed || usage || generated) prepared.remember()
          const partial = !completed && !!usage
          const flags = { ...(partial ? { partial } : !usage && wasAborted(request, failure) ? { aborted: true } : {}), ...(prepared.cacheInvalidation && (completed || usage || generated) ? { cacheInvalidation: true } : {}) }
          record(identity(request), partial ? { ...usage!, outputTokens: Math.max(usage!.outputTokens, Math.ceil(chars / 4)) } : usage, Object.keys(flags).length ? flags : undefined)
        }
      }
    },
  }
}
