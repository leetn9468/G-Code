/**
 * An idle deadline for cloud model streams. A provider that stops sending mid-reply (a stuck
 * connection, a proxy that holds the socket open) would otherwise leave the turn waiting forever.
 * Any bytes count as life: SSE pings and comments, empty thinking deltas.
 *
 * Only time spent waiting for bytes counts, from the request's start to its headers and then for
 * each body read: a consumer that is slow to pull never trips the deadline. The managed local
 * runtime has its own progress check (localTransport.ts) and Ollama prefills for long, so neither
 * uses this.
 */

export const STREAM_IDLE_MS = 300_000

/**
 * For a streamed request's fetch. Bun's fetch has its own idle timeout of the same 300 s: it fired
 * alongside the deadline here and raised a TimeoutError, which is not replayed, so the turn failed
 * with "The operation timed out." The deadline here is the only one on a cloud stream; Ollama, which
 * prefills for long and has no deadline here, was cut off every 300 s and could never finish. A
 * one-shot chat() keeps Bun's timeout: nothing else bounds it. Managed local requests do not use fetch.
 */
export const NO_FETCH_TIMEOUT = { timeout: false } as RequestInit

/** The provider sent nothing for STREAM_IDLE_MS; the request was stopped. Safe to send again. */
export class StreamIdleTimeoutError extends Error {
  constructor(readonly idleMs = STREAM_IDLE_MS) {
    super(`The model stream sent nothing for ${Math.round(idleMs / 1000)} s; the request was stopped.`)
    this.name = 'StreamIdleTimeoutError'
  }
}

/** Wraps a response body so that each read refreshes the deadline. */
export type WatchBody = (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>

/**
 * Runs one streamed request under the idle deadline. `open` gets the signal to pass to fetch (the
 * caller's signal, plus the deadline) and `watch` for the response body. When the deadline passes
 * the request is aborted and whatever `open` throws becomes a StreamIdleTimeoutError; a caller's
 * abort stays an abort. One timer per request, re-armed only when it fires, so a busy stream costs
 * a timestamp per chunk.
 */
export async function* guardStreamIdle<T>(
  signal: AbortSignal | undefined,
  open: (signal: AbortSignal, watch: WatchBody) => AsyncGenerator<T>,
  idleMs = STREAM_IDLE_MS,
): AsyncGenerator<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const forward = () => controller.abort(signal!.reason)
  signal?.addEventListener('abort', forward, { once: true })
  // Waiting for the headers counts as waiting for bytes.
  let waiting = true
  let since = performance.now()
  let timedOut = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number) => { timer = setTimeout(check, ms); timer.unref?.() }
  function check() {
    const idle = waiting ? performance.now() - since : 0
    if (idle < idleMs) return arm(idleMs - idle)
    timedOut = true
    controller.abort(new StreamIdleTimeoutError(idleMs))
    // A pending read ends even where aborting the fetch does not reach its body.
    reader?.cancel().catch(() => {})
  }
  arm(idleMs)
  const watch: WatchBody = body => {
    reader = body.getReader()
    const source = reader
    waiting = false
    return new ReadableStream<Uint8Array>({
      async pull(stream) {
        waiting = true
        since = performance.now()
        try {
          const { done, value } = await source.read()
          if (timedOut) throw new StreamIdleTimeoutError(idleMs)
          if (done) stream.close()
          else stream.enqueue(value)
        } finally { waiting = false }
      },
      cancel(reason) { return source.cancel(reason) },
    }, { highWaterMark: 0 })
  }
  try {
    yield* open(controller.signal, watch)
  } catch (error) {
    if (timedOut && !signal?.aborted) throw error instanceof StreamIdleTimeoutError ? error : new StreamIdleTimeoutError(idleMs)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}
