/**
 * @file httpTransport.ts
 * @brief MCP transports for remote servers: Streamable HTTP (2025-03-26 and later) and the older
 *        HTTP+SSE transport (2024-11-05). "auto" tries Streamable HTTP first and falls back to
 *        HTTP+SSE when the server refuses the first POST with 400, 404 or 405, as the MCP
 *        specification's backwards-compatibility section describes.
 */

import { guardedFetch, refuseBlockedRedirect } from '../security/guard.js'
import { NO_FETCH_TIMEOUT } from '../llm/streamIdle.js'

/** A connected remote transport: one JSON-RPC request or notification at a time per call. */
export interface RemoteTransport {
  readonly kind: 'http' | 'sse'
  /** Set when the connection is gone for good (a dropped event stream). */
  readonly closed?: Error
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal, limit?: RequestLimit): Promise<unknown>
  notify(method: string, params: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

/** One request's own limit, and what its timeout message adds (how to change it). */
export interface RequestLimit { timeoutMs: number; hint?: string }

export interface RemoteOptions {
  url: string
  transport: 'auto' | 'http' | 'sse'
  /** Headers for every request (custom headers and the current credentials); waiting for them ends with `signal`. */
  headers: (signal?: AbortSignal) => Promise<Record<string, string>>
  timeoutMs: number
}

/** A server answered 401: the credentials are missing, expired or refused. */
export class MCPAuthRequired extends Error {
  constructor(readonly resourceMetadata?: string) { super('The MCP server requires authentication (HTTP 401).') }
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

/** The server no longer knows this session (a 404 on a request that carried its id): the request did not run. */
export class MCPSessionExpired extends Error {
  constructor() { super('MCP session expired.') }
}

/** A request's limit ran out. For a call, the model must not take this as "nothing happened". */
export const timedOut = (method: string, hint?: string) => new Error(`${method === 'tools/call'
  ? 'MCP request timed out: tools/call. G-Code asked the server to cancel it, but the call may still have finished: check before repeating it.'
  : `MCP request timed out: ${method}`}${hint ? ` ${hint}` : ''}`)
export const timedOutError = (error: unknown) => error instanceof Error && error.message.startsWith('MCP request timed out')

/** The most one message may hold, on every transport. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024

/** Parses a text/event-stream body into events, calling `onEvent` for each until it returns true or the body ends. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => boolean | void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', event = 'message', data: string[] = [], size = 0
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1))
        if (line === '') {
          if (data.length && onEvent(event, data.join('\n')) === true) return stop()
          event = 'message'; data = []; size = 0
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          const text = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') event = text
          else if (field === 'data') {
            size += text.length
            if (size > MAX_MESSAGE_BYTES) throw new Error('MCP server sent an event larger than 32 MB')
            data.push(text)
          }
        }
      }
      if (buffer.length > MAX_MESSAGE_BYTES) throw new Error('MCP server sent a line larger than 32 MB')
    }
  } finally { signal?.removeEventListener('abort', stop) }
}

/** The body as text, up to `limit` bytes: past it the read stops and `tooLarge` is thrown, before anything is parsed. */
export async function readLimited(response: Response, limit: number, tooLarge: string, signal?: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      // A cancelled read reports the end of the body: what came so far is not the whole reply.
      signal?.throwIfAborted()
      if (done) break
      size += value.length
      if (size > limit) { stop(); throw new Error(tooLarge) }
      chunks.push(value)
    }
  } finally { signal?.removeEventListener('abort', stop) }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** A redirect that was not followed; `status` is the one the server sent. */
export class RedirectRefused extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface SameOriginOptions {
  /** What sends each request; guardedFetch unless the caller has its own transport. */
  send?: (url: string, init: RequestInit) => Promise<Response>
  /** What would go to the other origin, and what the person can do about it, for the message. */
  carries?: string
  moved?: string
}

/** How many redirects on one origin a request follows (a trailing slash, a moved path). */
const MAX_REDIRECTS = 10
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/**
 * A request that carries a server's credentials, custom headers or session: a redirect is followed
 * only on the same origin (scheme, host and port). fetch would send everything but Authorization and
 * cookies to any address a server names, https to plain http included, so another origin ends the
 * request here, naming only that origin, and nothing goes there. Under Guillotine Mode a target off
 * the allowlist is still an incident (see refuseBlockedRedirect).
 */
export async function sameOriginFetch(url: string | URL, init: RequestInit, options: SameOriginOptions = {}): Promise<Response> {
  const send = options.send ?? guardedFetch
  let current = new URL(url), method = init.method ?? 'GET', body = init.body, headers = init.headers
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await send(current.href, { ...init, method, headers, body, redirect: 'manual' })
    const location = REDIRECT_STATUS.has(response.status) ? response.headers.get('location') : null
    if (!location) return response
    void response.body?.cancel().catch(() => {})
    let next: URL
    try { next = new URL(location, current) } catch { throw new RedirectRefused(`The server at ${current.origin} redirected to an invalid address (HTTP ${response.status}). Not followed.`, response.status) }
    if (next.origin !== current.origin || next.username || next.password) {
      await refuseBlockedRedirect(next)
      throw new RedirectRefused(`The server at ${current.origin} redirected to ${next.origin === 'null' ? next.protocol : next.origin} (HTTP ${response.status}). Not followed: ${options.carries ?? "this request's credentials and headers"} would go to another origin. ${options.moved ?? 'If the server has moved, change its address in mcp.json.'}`, response.status)
    }
    // As fetch does: these turn a POST into a GET with no body.
    if ((response.status === 301 || response.status === 302) && method === 'POST' || response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET'; body = undefined
      const kept = new Headers(headers)
      for (const header of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) kept.delete(header)
      headers = kept
    }
    current = next
  }
  throw new RedirectRefused(`The server at ${current.origin} redirected more than ${MAX_REDIRECTS} times.`, 310)
}

const parse = (text: string): Message | Message[] | undefined => { try { return JSON.parse(text) } catch { return undefined } }

/** The reply G-Code gives a request the server sends it: ping only, like the stdio client. */
const serverReply = (message: Message) => message.method === 'ping'
  ? { jsonrpc: '2.0', id: message.id, result: {} }
  : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability not supported' } }

async function authError(response: Response): Promise<Error> {
  void response.body?.cancel().catch(() => {})
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? ''
    return new MCPAuthRequired(/resource_metadata="([^"]+)"/.exec(challenge)?.[1])
  }
  return new Error(`MCP server returned HTTP ${response.status}`)
}

/**
 * A signal for one request's fetch that also ends when `release` is called. In Bun, cancelling a body's
 * reader does not end the connection: the server goes on sending and the bytes keep arriving (measured:
 * 256 MB after a cancel at 32 MB, none after an abort). So what stops reading a body must abort too.
 */
export function connectionSignal(...signals: AbortSignal[]): { connection: AbortSignal; release: () => void } {
  const own = new AbortController()
  return { connection: AbortSignal.any([...signals, own.signal]), release: () => own.abort() }
}

/**
 * A deadline and the caller's signal as one signal, released when the request settles. `connection` is
 * for the request's own fetch, which ends with the request. A reply to a server's ping sent on the
 * way uses `signal`: it may still be going out when the request is done.
 */
function deadline(timeoutMs: number, method: string, signal?: AbortSignal, hint?: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(timedOut(method, hint)), timeoutMs)
  const onAbort = () => controller.abort(new Error(`MCP request aborted: ${method}`))
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true })
  const { connection, release } = connectionSignal(controller.signal)
  return { signal: controller.signal, connection, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release() } }
}
const reason = (signal: AbortSignal, error: unknown) => signal.aborted && signal.reason instanceof Error ? signal.reason : error

// ============================================================================
// Streamable HTTP
// ============================================================================

class StreamableHttp implements RemoteTransport {
  readonly kind = 'http' as const
  private nextId = 1
  private session?: string
  protocolVersion?: string
  constructor(private options: RemoteOptions) {}

  private async post(body: Message, signal: AbortSignal, connection = signal, session = this.session): Promise<Response> {
    const headers: Record<string, string> = { ...await this.options.headers(signal), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (session) headers['Mcp-Session-Id'] = session
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion
    // Bun's fetch gives up on a silent server after 300 s (measured). The request's own limit decides here: it may be longer.
    return sameOriginFetch(this.options.url, { method: 'POST', headers, body: JSON.stringify(body), signal: connection, ...NO_FETCH_TIMEOUT })
  }

  async request(method: string, params: Record<string, unknown>, outer?: AbortSignal, limit?: RequestLimit): Promise<unknown> {
    const id = this.nextId++
    const { signal, connection, done } = deadline(limit?.timeoutMs ?? this.options.timeoutMs, method, outer, limit?.hint)
    try {
      // The session this request carries decides what a 404 means, not the one held when the answer comes:
      // a parallel call that met the same 404 may have ended it meanwhile.
      const sent = this.session
      const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal, connection, sent)
      if (!response.ok) {
        if (response.status === 404 && sent) { void response.body?.cancel().catch(() => {}); throw new MCPSessionExpired() }
        throw await authError(response)
      }
      const session = response.headers.get('mcp-session-id')
      if (session && method === 'initialize') this.session = session
      const type = response.headers.get('content-type') ?? ''
      let reply: Message | undefined
      const take = (message: Message) => {
        if (message.method !== undefined && message.id !== undefined && message.id !== null) { void this.post(serverReply(message), signal).then(r => r.body?.cancel(), () => {}); return false }
        if (message.id === id && message.method === undefined) { reply = message; return true }
        return false
      }
      if (type.includes('text/event-stream') && response.body) {
        await readEvents(response.body, (event, data) => {
          if (event !== 'message') return
          const parsed = parse(data)
          return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).some(take)
        }, signal)
      } else {
        const parsed = parse(await readLimited(response, MAX_MESSAGE_BYTES, 'MCP server response is larger than 32 MB', signal))
        for (const message of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) if (take(message)) break
      }
      if (!reply) throw new Error(`MCP server sent no response to ${method}`)
      if (reply.error) throw new Error(`MCP error: ${reply.error.message ?? 'unknown error'}`)
      return reply.result
    } catch (error) {
      if (signal.aborted && method !== 'initialize') void this.notify('notifications/cancelled', { requestId: id, reason: String((signal.reason as Error)?.message ?? 'aborted') })
      throw reason(signal, error)
    } finally { done() }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const { signal, connection, done } = deadline(this.options.timeoutMs, method)
    try { const response = await this.post({ jsonrpc: '2.0', method, params }, signal, connection); void response.body?.cancel().catch(() => {}) }
    catch { /* A notification has no reply to wait for. */ }
    finally { done() }
  }

  async close(): Promise<void> {
    if (!this.session) return
    const { signal, connection, done } = deadline(5000, 'close')
    try {
      const response = await sameOriginFetch(this.options.url, { method: 'DELETE', headers: { ...await this.options.headers(signal), 'Mcp-Session-Id': this.session }, signal: connection })
      void response.body?.cancel().catch(() => {})
    } catch { /* The server may not support explicit session ends. */ }
    finally { done(); this.session = undefined }
  }
}

// ============================================================================
// HTTP+SSE (protocol version 2024-11-05)
// ============================================================================

class LegacySse implements RemoteTransport {
  readonly kind = 'sse' as const
  private nextId = 1
  private endpoint?: string
  private stream = new AbortController()
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  closed?: Error
  constructor(private options: RemoteOptions) {}

  /** Opens the event stream and waits for the server's `endpoint` event. */
  async open(outer?: AbortSignal): Promise<void> {
    const { signal, done } = deadline(this.options.timeoutMs, 'connect', outer)
    const abortStream = () => this.stream.abort()
    signal.addEventListener('abort', abortStream, { once: true })
    try {
      // The replies come on this stream, which is silent while a call runs: each call's own limit decides, not Bun's 300 s.
      const response = await sameOriginFetch(this.options.url, { headers: { ...await this.options.headers(signal), Accept: 'text/event-stream' }, signal: this.stream.signal, ...NO_FETCH_TIMEOUT })
      if (!response.ok || !response.body) throw await authError(response)
      let ready!: () => void, failed!: (error: Error) => void
      const endpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
      void readEvents(response.body, (event, data) => {
        if (event === 'endpoint') {
          const next = new URL(data, this.options.url)
          // The POST endpoint must stay on the server's origin: credentials go there too.
          if (next.origin !== new URL(this.options.url).origin) { failed(new Error('MCP server named a POST endpoint on another origin')); return true }
          this.endpoint = next.href; ready()
        } else if (event === 'message') {
          const parsed = parse(data)
          for (const message of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) this.deliver(message)
        }
      }, this.stream.signal).then(
        () => this.fail(new Error('MCP server closed the event stream')),
        error => this.fail(error instanceof Error ? error : new Error(String(error))),
      ).finally(() => failed(this.closed ?? new Error('MCP server closed the event stream')))
      await endpoint
    } catch (error) { this.stream.abort(); throw reason(signal, error) }
    finally { done(); signal.removeEventListener('abort', abortStream) }
  }

  private deliver(message: Message): void {
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) void this.postMessage(serverReply(message)).catch(() => {})
      return
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!pending) return
    this.pending.delete(message.id as number)
    if (message.error) pending.reject(new Error(`MCP error: ${message.error.message ?? 'unknown error'}`))
    else pending.resolve(message.result)
  }

  private fail(error: Error): void {
    this.closed ??= error
    // An event past the size limit ends the read here: the connection goes with it.
    this.stream.abort()
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  private async postMessage(body: unknown, signal?: AbortSignal): Promise<void> {
    if (!this.endpoint) throw new Error('MCP server has not named its POST endpoint')
    const { connection, release } = signal ? connectionSignal(signal) : connectionSignal()
    try {
      const response = await sameOriginFetch(this.endpoint, { method: 'POST', headers: { ...await this.options.headers(signal), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: connection })
      if (!response.ok) throw await authError(response)
      void response.body?.cancel().catch(() => {})
    } finally { release() }
  }

  async request(method: string, params: Record<string, unknown>, outer?: AbortSignal, limit?: RequestLimit): Promise<unknown> {
    if (this.closed) throw this.closed
    const id = this.nextId++
    const { signal, done } = deadline(limit?.timeoutMs ?? this.options.timeoutMs, method, outer, limit?.hint)
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        signal.addEventListener('abort', () => { this.pending.delete(id); reject(signal.reason) }, { once: true })
        this.postMessage({ jsonrpc: '2.0', id, method, params }, signal).catch(error => { this.pending.delete(id); reject(error) })
      })
    } catch (error) {
      if (signal.aborted) void this.notify('notifications/cancelled', { requestId: id })
      throw reason(signal, error)
    } finally { done() }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try { await this.postMessage({ jsonrpc: '2.0', method, params }) } catch { /* No reply to wait for. */ }
  }

  async close(): Promise<void> { this.fail(new Error('MCP server disconnected')); this.stream.abort() }
}

/**
 * Connects to a remote server and sends `initialize`. Returns the transport and the server's
 * initialize result. In "auto" mode a 400/404/405 answer to the first POST means the server only
 * has the older HTTP+SSE transport.
 */
export async function connectRemote(options: RemoteOptions, initialize: Record<string, unknown>, signal?: AbortSignal): Promise<{ transport: RemoteTransport; result: unknown }> {
  if (options.transport !== 'sse') {
    const http = new StreamableHttp(options)
    try {
      const result = await http.request('initialize', initialize, signal) as { protocolVersion?: string }
      http.protocolVersion = result?.protocolVersion
      return { transport: http, result }
    } catch (error) {
      const fallback = options.transport === 'auto' && error instanceof Error && /HTTP (400|404|405)$/.test(error.message)
      if (!fallback) throw error
    }
  }
  const sse = new LegacySse(options)
  await sse.open(signal)
  try { return { transport: sse, result: await sse.request('initialize', initialize, signal) } }
  catch (error) { await sse.close(); throw error }
}
