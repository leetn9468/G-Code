import { request, type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { ensureDirectHost } from './directFetch.js'

/** How a request's progress is watched. A test may shorten these. */
export interface InferenceTiming { pollMs: number; firstProbeMs: number; stallMs: number }
const INFERENCE_TIMING: InferenceTiming = { pollMs: 15_000, firstProbeMs: 4_000, stallMs: 600_000 }

/** Owned loopback requests may prefill for minutes before headers or a token arrives.
 * node:http has no hidden fetch header/idle deadline. User cancellation still destroys
 * the request and its response socket, including while the body is being consumed.
 */
export function localInferenceFetch(url: string, init: RequestInit, timing: InferenceTiming = INFERENCE_TIMING): Promise<Response> {
  const target = new URL(url)
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password) {
    return Promise.reject(new Error('Managed local inference requires a loopback HTTP server.'))
  }
  if (init.body !== undefined && typeof init.body !== 'string') return Promise.reject(new Error('Local inference requires a JSON request body.'))
  // Bun applies the environment's proxy to a GET here, so /slots and /props would leave for HTTP_PROXY.
  ensureDirectHost(target.hostname)
  return new Promise((resolve, reject) => {
    const activity = new LocalInferenceActivity(Date.now, timing.stallMs)
    let polling = false
    /**
     * A server deep in a batch answers /slots only when the batch ends, which can take minutes. After a
     * short probe goes unanswered, the next one waits up to the limit. A frozen server never answers it,
     * so it still ends at the limit.
     */
    let busy = false
    let finished = false
    let timer: ReturnType<typeof setInterval> | undefined
    let incoming: IncomingMessage | undefined
    let probe: AbortController | undefined
    const fail = (error: Error) => { clean(); incoming?.destroy(error); req.destroy(error); reject(error) }
    const abort = () => {
      const error = init.signal?.reason instanceof Error ? init.signal.reason : new DOMException('Request cancelled', 'AbortError')
      fail(error)
    }
    const clean = () => { finished = true; if (timer) clearInterval(timer); probe?.abort(); init.signal?.removeEventListener('abort', abort) }
    const req = request(target, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined, agent: false, timeout: 0 }, response => {
      incoming = response
      response.on('data', () => activity.received())
      response.once('close', clean)
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      const status = response.statusCode ?? 500
      try {
        if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })) }
        else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
    req.once('error', error => { clean(); reject(error) })
    // Bun's node:http compatibility closes a pre-header socket on signal without
    // reliably emitting request.error. Settle explicitly as well as destroying it.
    init.signal?.addEventListener('abort', abort, { once: true })
    if (init.signal?.aborted) { abort(); return }
    if (init.method === 'POST' && target.pathname.endsWith('/chat/completions')) {
      const check = (slots: unknown) => { if (!finished && activity.stalled(slots)) fail(new Error(`Local model made no observable progress for ${Math.round(timing.stallMs / 60_000)} minutes. It may be stopped or very slow. Stop and restart the model.`)) }
      timer = setInterval(() => {
        if (polling) return
        polling = true
        probe = new AbortController()
        const timeout = AbortSignal.timeout(busy ? timing.stallMs : timing.firstProbeMs)
        void localInferenceFetch(new URL('/slots', target).href, { signal: AbortSignal.any([probe.signal, timeout]) })
          .then(async response => response.ok ? response.json() : undefined)
          .catch(() => { if (timeout.aborted) busy = true; return undefined })
          .then(check)
          .finally(() => { polling = false })
      }, timing.pollMs)
      timer.unref?.()
    }
    req.end(init.body ?? undefined)
  })
}

/** Keep a progressing prefill alive without treating a frozen is_processing bit as progress.
 * Some llama.cpp releases expose no prefill counter in /slots; while they explicitly
 * report processing we cannot prove a stall, so user cancellation remains the escape.
 */
export class LocalInferenceActivity {
  private lastProgress: number
  private counters = new Map<string, number>()
  constructor(private readonly now = Date.now, private readonly stallMs = 600_000) { this.lastProgress = now() }
  received(): void { this.lastProgress = this.now() }
  stalled(data: unknown): boolean {
    const processing = Array.isArray(data) ? data.filter(slot => slot?.is_processing === true) : []
    let observable = false
    for (const slot of processing) {
      const id = String(slot.id ?? 0)
      const values = [slot.n_prompt_tokens_processed, slot.n_past, slot.prompt_progress?.processed,
        (slot.n_decoded ?? slot.next_token?.n_decoded ?? slot.next_token?.[0]?.n_decoded) > 0 ? (slot.n_decoded ?? slot.next_token?.n_decoded ?? slot.next_token?.[0]?.n_decoded) : undefined]
      values.forEach((value, index) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return
        observable = true
        const key = `${id}:${index}`, previous = this.counters.get(key)
        if (previous === undefined || value > previous) this.received()
        this.counters.set(key, value)
      })
    }
    if (processing.length && !observable) return false
    return this.now() - this.lastProgress >= this.stallMs
  }
}

/** A server's slot window, never an aggregate across its slots. Invalid data cannot raise a limit. */
export function serverContextWindow(data: unknown): number | undefined {
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 1_048_576
  if (Array.isArray(data)) {
    if (!data.length || data.length > 256) return
    const sizes = data.map(slot => slot?.n_ctx)
    return sizes.every(valid) ? Math.min(...sizes) : undefined
  }
  const n = (data as { default_generation_settings?: { n_ctx?: unknown } } | null)?.default_generation_settings?.n_ctx
  return valid(n) ? n : undefined
}
