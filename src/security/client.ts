import type { LLMClient, LLMRequestOptions } from '../llm/types.js'
import { currentGuard } from './guard.js'

/** Admission is checked again after provider queues; a late log cannot start the next request. */
export function guardClient(client: LLMClient): LLMClient {
  const options = (request: LLMRequestOptions): LLMRequestOptions => {
    const guard = currentGuard()
    if (!guard) return request
    guard.assertReady()
    guard.remember('model-request', { model: request.model, contextMessages: request.messages.length, note: 'Prior-turn prompt context is not duplicated in this turn journal.' })
    return { ...request, signal: request.signal ? AbortSignal.any([request.signal, guard.signal]) : guard.signal,
      beforeSend: () => { guard.assertReady(); request.beforeSend?.() } }
  }
  return new Proxy(client, { get(target, key) {
    if (key === 'chat') return async (request: LLMRequestOptions) => { await currentGuard()?.fence(); const result = await target.chat(options(request)); currentGuard()?.remember('model-response', result.content); currentGuard()?.assertReady(); return result }
    if (key === 'chatStream') return async function* (request: LLMRequestOptions) { await currentGuard()?.fence(); for await (const event of target.chatStream(options(request))) { currentGuard()?.remember('model-event', event); currentGuard()?.assertReady(); yield event } }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
}
