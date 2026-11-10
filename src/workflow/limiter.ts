import { availableParallelism } from 'node:os'
import type { LLMClient, LLMRequestOptions, StreamEvent } from '../llm/types.js'
import { APIError, withRetry, withRateLimitObserver, type RetryOptions } from '../llm/retry.js'

export class ProviderLimiter {
  private active = 0
  private foregroundStreak = 0
  private queue: Array<{ priority: 'foreground' | 'workflow'; start: () => void; signal?: AbortSignal; abort: () => void }> = []
  private ceiling = 1
  private lastDecrease = -Infinity
  private lastRecovery = -Infinity
  constructor(public limit: number, private timing = { now: Date.now, cooldownMs: 30_000 }) { this.configure(limit) }
  configure(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Provider concurrency must be an integer from 1 to 256')
    this.limit = this.ceiling = limit
    this.lastDecrease = this.lastRecovery = -Infinity
    this.drain()
  }
  rateLimited(): void {
    const now = this.timing.now()
    if (now - this.lastDecrease < this.timing.cooldownMs) return
    this.lastDecrease = this.lastRecovery = now
    this.limit = Math.max(1, Math.floor(this.limit / 2))
  }
  succeeded(): void {
    const now = this.timing.now()
    if (this.limit >= this.ceiling || now - this.lastRecovery < this.timing.cooldownMs) return
    this.lastRecovery = now
    this.limit++
    this.drain()
  }
  acquire(signal?: AbortSignal, priority: 'foreground' | 'workflow' = 'foreground'): Promise<() => void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const entry = {
        signal, priority,
        abort: () => { this.queue = this.queue.filter(item => item !== entry); reject(signal?.reason ?? new Error('Request cancelled')) },
        start: () => {
          signal?.removeEventListener('abort', entry.abort)
          this.active++
          let released = false
          resolve(() => { if (!released) { released = true; this.active--; this.drain() } })
        },
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const foreground = this.queue.findIndex(entry => entry.priority === 'foreground')
      const workflow = this.queue.findIndex(entry => entry.priority === 'workflow')
      const index = foreground >= 0 && (this.foregroundStreak < 4 || workflow < 0) ? foreground : workflow >= 0 ? workflow : 0
      const [entry] = this.queue.splice(index, 1)
      this.foregroundStreak = entry!.priority === 'foreground' ? this.foregroundStreak + 1 : 0
      entry!.start()
    }
    if (!this.queue.length) this.foregroundStreak = 0
  }
}
const limiters = new Map<string, ProviderLimiter>()
export function providerLimiter(provider: string): ProviderLimiter {
  let limiter = limiters.get(provider)
  if (!limiter) {
    const limit = provider === 'local' ? 1 : provider === 'ollama' ? 2 : ['deepseek', 'qwen'].includes(provider) ? 4 : Math.max(1, Math.min(16, availableParallelism() - 2))
    limiters.set(provider, limiter = new ProviderLimiter(limit))
  }
  return limiter
}
export function configureProviderLimits(limits: Record<string, number>): void {
  for (const [provider, limit] of Object.entries(limits)) providerLimiter(provider).configure(limit)
}
const wrapped = new WeakMap<LLMClient, Map<string, LLMClient>>()
const originals = new WeakMap<LLMClient, LLMClient>()
/** All model requests, including the parent conversation, share these slots. */
export function limitClient(client: LLMClient, provider: string, priority: 'foreground' | 'workflow' = 'foreground'): LLMClient {
  client = originals.get(client) ?? client
  const key = `${provider}:${priority}`
  const previous = wrapped.get(client)?.get(key)
  if (previous) return previous
  const limiter = providerLimiter(provider)
  const result: LLMClient = {
    maxOutputTokens: client.maxOutputTokens,
    visionCapabilities: client.visionCapabilities?.bind(client),
    modelIdentity: client.modelIdentity?.bind(client),
    get contextWindow() { return client.contextWindow },
    get managedLocal() { return client.managedLocal },
    get budgetLocal() { return client.budgetLocal },
    refreshContextWindow: client.refreshContextWindow?.bind(client),
    countTokens: client.countTokens ? async options => {
      const release = await limiter.acquire(options.signal, priority)
      let observed = false
      try { const result = await withRateLimitObserver(() => { observed = true; limiter.rateLimited() }, () => client.countTokens!(options)); limiter.succeeded(); return result }
      catch (error) { if (!observed && error instanceof APIError && error.statusCode === 429 && error.retryable) limiter.rateLimited(); throw error }
      finally { release() }
    } : undefined,
    async chat(options) {
      const release = await limiter.acquire(options.signal, priority)
      let observed = false
      try { const result = await withRateLimitObserver(() => { observed = true; limiter.rateLimited() }, () => client.chat(options)); limiter.succeeded(); return result }
      catch (error) { if (!observed && error instanceof APIError && error.statusCode === 429 && error.retryable) limiter.rateLimited(); throw error }
      finally { release() }
    },
    async *chatStream(options) {
      const release = await limiter.acquire(options.signal, priority)
      let observed = false
      const stream = client.chatStream(options)
      try {
        for (;;) {
          const next = await withRateLimitObserver(() => { observed = true; limiter.rateLimited() }, () => stream.next())
          if (next.done) { limiter.succeeded(); return }
          yield next.value
        }
      } catch (error) { if (!observed && error instanceof APIError && error.statusCode === 429 && error.retryable) limiter.rateLimited(); throw error }
      finally { try { await stream.return(undefined) } finally { release() } }
    },
  }
  const cache = wrapped.get(client) ?? new Map<string, LLMClient>()
  cache.set(key, result); wrapped.set(client, cache)
  originals.set(result, client)
  return result
}

/** Retry only before the first event; never replay a partially consumed stream. */
export async function* streamWithRetry(client: LLMClient, options: LLMRequestOptions, retry?: RetryOptions): AsyncGenerator<StreamEvent> {
  if (options.noRetry) { yield* client.chatStream(options); return }
  let stream: AsyncGenerator<StreamEvent> | undefined
  try {
    const first = await withRetry(async () => {
      stream = client.chatStream({ ...options, stream: true })
      try { return await stream.next() }
      catch (error) {
        await stream.return(undefined)
        // Only establishing a stream is safe to retry after a headers timeout.
        if ((error as { name?: string })?.name === 'TimeoutError') throw new APIError(String(error), 408, true)
        throw error
      }
    }, { ...retry, signal: options.signal })
    if (first.done) return
    yield first.value
    yield* stream!
  } finally { await stream?.return(undefined) }
}
