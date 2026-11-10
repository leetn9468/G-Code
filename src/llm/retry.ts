import { AsyncLocalStorage } from 'node:async_hooks'
import type { StreamEvent } from './types.js'
import { StreamIdleTimeoutError } from './streamIdle.js'
const rateLimitObserver = new AsyncLocalStorage<() => void>()
export function withRateLimitObserver<T>(observer: () => void, work: () => T): T { return rateLimitObserver.run(observer, work) }
/**
 * @file retry.ts
 * @brief Exponential backoff retry wrapper for API calls
 *
 * Handles 408, 429, 500, 502, 503, 504 and 529 (overloaded) with exponential
 * backoff, honouring the server's Retry-After. Fatal errors (400, 401, 403,
 * 404) are not retried. Aborting cancels a pending backoff.
 */

// ============================================================================
// Error Classification
// ============================================================================

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529])

/** What the provider said about a failed request, kept apart from the readable message. */
export interface APIErrorDetails {
  /** The provider's error type or code, e.g. rate_limit_error, overloaded_error, invalid_request_error. */
  type?: string
  /** The provider's own message, without the JSON envelope. */
  providerMessage?: string
  requestId?: string
  /** The raw response body (cut), for logs. */
  body?: string
  /** The error arrived inside a stream that had already started, so the request may be billed. */
  midStream?: boolean
}

export class APIError extends Error {
  readonly type?: string
  readonly providerMessage?: string
  readonly requestId?: string
  readonly body?: string
  readonly midStream?: boolean
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    details: APIErrorDetails = {},
  ) {
    super(message)
    this.name = 'APIError'
    Object.assign(this, details)
  }
}

/**
 * A request refused before anything was sent (an image the model cannot take, a request over the
 * provider's size limit). Nothing was billed, and sending it again unchanged fails the same way.
 */
export class RequestNotSentError extends Error {
  constructor(message: string, readonly reason: 'image' | 'size' = 'image') {
    super(message)
    this.name = 'RequestNotSentError'
  }
}

/**
 * A model stream that ended without its end marker: the connection closed early. While nothing of
 * the reply has been passed on, the request is sent again like any other dropped connection.
 */
export class StreamEndedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamEndedError'
  }
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** Connection failures that come and go. Bun's fetch throws a plain Error with one of these codes (ConnectionRefused, ECONNRESET); Node's puts it on the cause of a TypeError. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
  'ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])
/** The ones where no connection was made at all: the provider never saw the request. */
const NOT_CONNECTED_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ConnectionRefused', 'FailedToOpenSocket', 'UND_ERR_CONNECT_TIMEOUT'])

function networkCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 3; current = (current as { cause?: unknown }).cause, depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return code
  }
  return undefined
}

/** A request that failed before any connection was made (refused, unreachable): nothing was sent, so nothing was billed. */
export function neverConnected(error: unknown): boolean {
  const code = networkCode(error)
  return code !== undefined && NOT_CONNECTED_CODES.has(code)
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false
  if ((error as { name?: string } | null)?.name === 'TimeoutError') return false
  if (error instanceof APIError) return error.retryable
  if (error instanceof StreamEndedError || error instanceof StreamIdleTimeoutError) return true
  if (networkCode(error)) return true
  if (error instanceof TypeError) return true // Network errors
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('timeout') ||
      msg.includes('socket hang up') ||
      // Bun's wording, for an error that lost its code on the way
      msg.includes('socket connection was closed unexpectedly') ||
      msg.includes('unable to connect. is the computer able to access the url')
    )
  }
  return false
}

type HeaderSource = Pick<Headers, 'get'>

/** Server-requested wait: `retry-after-ms`, else `Retry-After` as delta-seconds or an HTTP date. */
export function parseRetryAfter(headers?: HeaderSource | null, now = Date.now()): number | undefined {
  if (!headers) return undefined
  const milliseconds = headers.get('retry-after-ms')?.trim()
  if (milliseconds && /^\d+(\.\d+)?$/.test(milliseconds)) return Math.ceil(Number(milliseconds))
  const value = headers.get('retry-after')?.trim()
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** The provider's error envelope: Anthropic {error:{type,message}}, OpenAI {error:{type|code,message}}, Gemini {error:{status,message}}. */
function providerError(body: string): { type?: string; message?: string; requestId?: string } {
  try {
    let data = JSON.parse(body) as any
    if (Array.isArray(data)) data = data[0]
    const error = data?.error && typeof data.error === 'object' ? data.error : data
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined
    return { type: text(error?.type) ?? text(error?.status) ?? text(error?.code), message: text(error?.message), requestId: text(data?.request_id) }
  } catch { return {} }
}

/** A short, readable snippet of a body that is not a JSON error (an HTML gateway page says nothing useful). */
function bodySnippet(body: string): string | undefined {
  const text = body.replace(/\s+/g, ' ').trim()
  if (!text || /^<(!doctype|html|\?xml)/i.test(text)) return undefined
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * An account out of quota or credit. OpenAI sends it as a 429, so it read as a rate limit and was
 * retried four times, though no wait brings the quota back.
 */
function outOfQuota(status: number, type: string | undefined, body: string): boolean {
  return status === 429 && (type === 'insufficient_quota' || /"code"\s*:\s*"insufficient_quota"/.test(body))
}

/** What a failed status means, in a few words, for the message the user sees. */
function statusLead(status: number, type: string | undefined, message: string, quota = false): string {
  if (quota) return 'The provider refused the request: this API key has no quota or credit left'
  if (status === 429 || type === 'rate_limit_error') return 'Rate limited by the provider'
  if (status === 529 || type === 'overloaded_error') return 'The provider is overloaded'
  if (status === 401 || type === 'authentication_error') return 'The provider rejected the API key'
  if (status === 402 || type === 'billing_error') return 'The provider refused the request for a billing reason'
  if (status === 403 || type === 'permission_error') return 'The provider refused the request'
  if (status === 404 || type === 'not_found_error') return 'The provider could not find the model or endpoint'
  if (status === 413 || type === 'request_too_large') return 'The request is too large for the provider'
  if (status === 408) return 'The provider timed out'
  if (/prompt is too long|context.length|too many (input )?tokens|maximum context|context window|exceeds the maximum number of tokens|exceeds the available context size/i.test(message)) return 'The conversation is too long for the model'
  if (/image/i.test(message) && status === 400) return 'The provider could not process an image'
  if (status >= 500) return 'Provider server error'
  if (status === 400) return 'The provider rejected the request'
  return 'Provider error'
}

const SUGGESTION: Record<number, string> = {
  401: ' Check the API key in Settings or in the provider\'s environment variable.',
}

export function classifyHTTPError(status: number, body: string, headers?: HeaderSource | null): APIError {
  // The provider's message without its JSON envelope; the raw body stays on the error for logs.
  const parsed = providerError(body)
  const quota = outOfQuota(status, parsed.type, body)
  if (status === 429 && !quota) rateLimitObserver.getStore()?.()
  const retryable = !quota && RETRYABLE_STATUS_CODES.has(status)
  let retryAfterMs = retryable ? parseRetryAfter(headers) : undefined

  // Some gateways only put the hint in the error body.
  if (retryAfterMs === undefined && retryable && status === 429) {
    const match = body.match(/retry.after['":\s]+(\d+)/i)
    if (match) {
      retryAfterMs = parseInt(match[1]!, 10) * 1000
    }
  }

  const said = parsed.message ?? bodySnippet(body)
  const detail = said ? `: ${said.length > 300 ? `${said.slice(0, 300)}…` : said}` : ''
  const message = `${statusLead(status, parsed.type, said ?? '', quota)} (HTTP ${status}${parsed.type && !/^\d+$/.test(parsed.type) ? `, ${parsed.type}` : ''})${detail}`
  return new APIError(
    `${/[.!?…]$/.test(message) ? message : `${message}.`}${SUGGESTION[status] ?? ''}`,
    status,
    retryable,
    retryAfterMs,
    { type: parsed.type, providerMessage: parsed.message, requestId: parsed.requestId, body: body.slice(0, 2000) },
  )
}

/** Error types sent inside a stream, as the HTTP status each stands for: Anthropic, OpenAI, Gemini. */
const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529, rate_limit_error: 429, rate_limit_exceeded: 429, RESOURCE_EXHAUSTED: 429,
  api_error: 500, server_error: 500, INTERNAL: 500, UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, request_too_large: 413,
}

/**
 * An error event inside a stream (Anthropic `event: error`, an OpenAI chunk's `error`, a Gemini
 * chunk's `error.status`). Overload, rate limit and server errors are retryable like their HTTP
 * statuses; the caller retries only while nothing has streamed.
 */
export function streamErrorEvent(error: { type?: unknown; message?: unknown } | undefined, started = true): APIError {
  const type = typeof error?.type === 'string' && error.type ? error.type : undefined
  const said = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : undefined
  const status = (type ? STREAM_ERROR_STATUS[type] : undefined) ?? 400
  const lead = status === 529 ? 'The provider is overloaded and stopped the reply'
    : status === 429 ? 'Rate limited by the provider; it stopped the reply'
    : status >= 500 ? 'Provider server error; it stopped the reply'
    : 'The provider stopped the reply'
  const message = `${lead}${type ? ` (${type})` : ''}${said ? `: ${said}` : ''}`
  // `started`: the provider had begun the reply (message_start), so the request may be billed.
  return new APIError(/[.!?…]$/.test(message) ? message : `${message}.`, status, RETRYABLE_STATUS_CODES.has(status), undefined, { type, providerMessage: said, midStream: started })
}

// ============================================================================
// Retry Wrapper
// ============================================================================

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Longest Retry-After to wait for; a longer one fails immediately instead of stalling. */
  maxRetryAfterMs?: number
  /** Aborting cancels a pending backoff and stops further attempts. */
  signal?: AbortSignal
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'signal'>> = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
}

/** The retries retryStream makes by default before a reply begins. */
export const STREAM_RETRIES = DEFAULT_RETRY_OPTIONS.maxRetries

/** A wait that aborting ends early, rejecting with the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Retryable errors a retry loop already gave up on: an outer loop must not retry them again. */
const retried = new WeakSet<object>()

/**
 * The wait before retry `attempt + 1` (attempt 0 is the first retry): exponential from
 * baseDelayMs, capped at maxDelayMs, ±25% jitter against a thundering herd. A server's Retry-After
 * is a floor, so jitter never retries earlier than asked.
 */
export function backoffDelay(attempt: number, options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'> = {}, retryAfterMs?: number): number {
  const delay = Math.min((options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs) * Math.pow(2, attempt), options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs)
  const jittered = Math.round(delay + delay * 0.25 * (Math.random() * 2 - 1))
  return retryAfterMs !== undefined ? Math.max(jittered, retryAfterMs) : jittered
}

/** Network failures that cut a reply already under way; Bun and undici words for one that lost its code. */
const CUT_OFF = /\bterminated\b|socket hang up|socket connection was closed unexpectedly|other side closed|econnreset/i

/**
 * A failure after a reply began streaming that sending the same request again may get past: an
 * overload, server error or 529 inside the stream, a rate limit the stream reported (not one out of
 * quota), a dropped or reset connection, a body or idle timeout. Not an abort, any other 4xx, an
 * invalid request, a refusal or a context that is too long, and not an error a retry loop already
 * gave up on. G-Code runs no tool until a reply ends, so a replay has no side effects; the caller
 * bounds how often it replays (and waits replayDelay first).
 */
export function isReplayableStreamError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || retried.has(error)) return false
  const name = (error as { name?: unknown }).name
  if (name === 'AbortError' || name === 'TimeoutError') return false
  if (error instanceof StreamIdleTimeoutError || error instanceof StreamEndedError) return true
  // Only what retryStream would retry too: a 5xx it calls permanent (501, 505) fails the same way again.
  if (error instanceof APIError) return error.retryable && (error.statusCode >= 500 || (error.statusCode === 429 && error.midStream === true))
  if (networkCode(error)) return true
  return error instanceof Error && (CUT_OFF.test(error.message) || (error.cause instanceof Error && CUT_OFF.test(error.cause.message)))
}

/**
 * The wait before replay `attempt + 1` of a reply that failed mid-stream (attempt 0 is the first):
 * backoffDelay with the error's Retry-After as a floor. Undefined when the provider asked for a
 * longer wait than a retry would wait (maxRetryAfterMs): the caller then gives up at once.
 */
export function replayDelay(attempt: number, error: unknown, options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'maxRetryAfterMs'> = {}): number | undefined {
  const retryAfter = error instanceof APIError ? error.retryAfterMs : undefined
  if (retryAfter !== undefined && retryAfter > (options.maxRetryAfterMs ?? DEFAULT_RETRY_OPTIONS.maxRetryAfterMs)) return undefined
  return backoffDelay(attempt, options, retryAfter)
}

/** A wait in words: seconds under 90 s, minutes under 90 min, hours after that. */
function waitWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

/**
 * A network failure in a sentence about the provider, in place of the runtime's wording ("pass
 * `verbose: true` in the second argument to fetch()"), which told the user and the model nothing.
 * Only at a failure's last stop: the retry and replay checks read the original wording of an error
 * that lost its code. Anything else stays as it is.
 */
export function explainNetworkFailure(failure: Error): void {
  if (failure instanceof APIError || failure instanceof StreamEndedError || failure instanceof StreamIdleTimeoutError) return
  const code = networkCode(failure), named = code ? ` (${code})` : ''
  const text = neverConnected(failure) || /unable to connect/i.test(failure.message) ? `Could not connect to the provider${named}. Check the network and the provider address.`
    : code || CUT_OFF.test(failure.message) ? `The connection to the provider was lost before the reply finished${named}.` : undefined
  // A DOMException's message is read-only. The explanation must never replace the failure itself.
  if (text) try { failure.message = text } catch { /* It keeps its own words. */ }
}

/** Bun's fetch timeout on a one-shot request, as the error the user reads: its own message cannot be changed. */
const answerTimedOut = (failure: Error) => {
  const error = new Error('The provider did not answer in time, so the request was stopped.', { cause: failure })
  error.name = failure.name
  return error
}

/**
 * Ends the message of a failure the retries stop at: that the provider asked for a longer wait
 * than G-Code allows (so it did not retry), or that the retries ran out, with the wait the
 * provider asked for last. Before, the error read like any other rate limit.
 */
function gaveUp(failure: Error, attempt: number, retryAfter: number | undefined, maxRetryAfter: number): void {
  const retries = `${attempt} ${attempt === 1 ? 'retry' : 'retries'}`
  const note = retryAfter !== undefined && retryAfter > maxRetryAfter
    ? `The provider asked to wait ${waitWords(retryAfter)} before retrying; G-Code waits at most ${waitWords(maxRetryAfter)}, so it ${attempt > 0 ? `stopped after ${retries}` : 'did not retry'}. Try again later.`
    : attempt > 0 ? `Gave up after ${retries}.${retryAfter !== undefined ? ` The provider last asked to wait ${waitWords(retryAfter)}.` : ''}` : ''
  if (note && !failure.message.includes(note)) failure.message = `${failure.message.replace(/\s+$/, '')} ${note}`
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * Backoff schedule: 1s, 2s, 4s, 8s (capped at maxDelayMs).
 * Jitter: ±25% to prevent thundering herd. A Retry-After from the server is a
 * floor on the wait, so jitter never retries earlier than requested.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries
  const maxRetryAfter = options?.maxRetryAfterMs ?? DEFAULT_RETRY_OPTIONS.maxRetryAfterMs
  const signal = options?.signal

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted()
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't retry on final attempt, after cancellation or for non-retryable errors
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(error)) {
        if (!signal?.aborted && isRetryableError(error)) retried.add(lastError)
        if (!signal?.aborted) {
          if (lastError.name === 'TimeoutError') lastError = answerTimedOut(lastError)
          else explainNetworkFailure(lastError)
        }
        throw lastError
      }

      const retryAfter = error instanceof APIError ? error.retryAfterMs : undefined
      if (retryAfter !== undefined && retryAfter > maxRetryAfter) { gaveUp(lastError, attempt, retryAfter, maxRetryAfter); retried.add(lastError); throw lastError }
      const delayMs = backoffDelay(attempt, options, retryAfter)

      options?.onRetry?.(attempt + 1, lastError, delayMs)

      await sleep(delayMs, signal)
    }
  }

  throw lastError ?? new Error('withRetry: exhausted retries')
}

// ============================================================================
// Streams
// ============================================================================

/** What a retry is waiting out, for the status line: "Rate limited, retrying in 8 s…". */
export function retryStatus(error: unknown, delayMs: number, attempt: number, maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries): string {
  const status = error instanceof APIError ? error.statusCode : undefined
  const cause = status === 429 ? 'Rate limited'
    : status === 529 ? 'The provider is overloaded'
    : status === 408 ? 'The provider timed out'
    : status !== undefined ? `Provider error (HTTP ${status})`
    : 'Connection failed'
  return `${cause}, retrying in ${Math.max(1, Math.round(delayMs / 1000))} s (retry ${attempt} of ${maxRetries})…`
}

/** Events that can be dropped with a failed attempt: nothing of the reply has been shown yet. */
const HELD_EVENTS = new Set<StreamEvent['type']>(['usage'])
/**
 * Events passed on at once that still leave the attempt open to a retry: thinking is never part
 * of the reply that is shown as text or saved (it only sets the "Thinking…" status), so a reply
 * that fails while the model is still thinking can be discarded cleanly. With the thinking display
 * omitted (the default on current Claude models) its events are empty, and the thinking phase is
 * most of the wait before the first text or tool call. The usage held so far goes out with the
 * first one, as it did before, so the context meter is measured while the model thinks: a retry
 * sends the same input.
 */
const PASSED_EVENTS = new Set<StreamEvent['type']>(['thinking'])

/**
 * A model stream that retries rate limits, overloads, server and network errors with backoff
 * (Retry-After as a floor, jitter, abort-aware waits) as long as nothing of the reply has
 * arrived. A request that fails after part of the reply (text or a tool call) was passed on is
 * never replayed; thinking alone does not count. Each attempt opens its own stream (and so takes
 * its own concurrency slot); a failed one is closed before the wait. When the retries run out,
 * the error says so.
 */
export async function* retryStream(open: () => AsyncGenerator<StreamEvent>, options: RetryOptions & { onWaitEnd?: () => void } = {}): AsyncGenerator<StreamEvent> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries
  const maxRetryAfter = options.maxRetryAfterMs ?? DEFAULT_RETRY_OPTIONS.maxRetryAfterMs
  const signal = options.signal
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    const stream = open()
    const held: StreamEvent[] = []
    let committed = false
    try {
      try {
        for (;;) {
          const next = await stream.next()
          if (next.done) { if (!committed) { committed = true; yield* held } return }
          if (!committed && HELD_EVENTS.has(next.value.type)) { held.push(next.value); continue }
          if (!committed && PASSED_EVENTS.has(next.value.type)) { yield* held.splice(0); yield next.value; continue }
          if (!committed) { committed = true; yield* held }
          yield next.value
        }
      } catch (error) {
        // Close the failed attempt (its concurrency slot, its usage record) before waiting.
        await stream.return(undefined).catch(() => undefined)
        // Only establishing a stream is safe to retry after a timeout.
        const failure = !committed && (error as { name?: string } | null)?.name === 'TimeoutError' ? new APIError('The provider did not answer in time, so the request was stopped.', 408, true) : error
        // A stream that retries itself (a workflow agent's) already waited out this failure.
        if (committed || signal?.aborted || !isRetryableError(failure) || (failure instanceof Object && retried.has(failure))) throw error
        const retryAfter = failure instanceof APIError ? failure.retryAfterMs : undefined
        if (attempt >= maxRetries || (retryAfter !== undefined && retryAfter > maxRetryAfter)) {
          if (failure instanceof Error) { explainNetworkFailure(failure); gaveUp(failure, attempt, retryAfter, maxRetryAfter) }
          if (failure instanceof Object) retried.add(failure)
          throw failure
        }
        const delayMs = backoffDelay(attempt, options, retryAfter)
        options.onRetry?.(attempt + 1, failure instanceof Error ? failure : new Error(String(failure)), delayMs)
        await sleep(delayMs, signal)
        options.onWaitEnd?.()
      }
    } finally {
      await stream.return(undefined).catch(() => undefined)
    }
  }
}
