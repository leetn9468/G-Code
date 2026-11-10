import { estimateMessages } from '../llm/images.js'
import { localTokenEstimate, initialTokenScale } from '../engine/context.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LLMClient, LLMRequestOptions, TokenUsage } from '../llm/types.js'
import { RequestNotSentError } from '../llm/retry.js'
import { notBilled } from './usage.js'
import { budgetPrice, budgetSpent, budgetWriterRemaining, moneyUnits, validateBudget, type BudgetHandoff, type BudgetRequest, type SessionBudget } from '../shared/sessionBudget.js'
import { validUsage } from '../shared/usageTotals.js'
import type { AppState } from '../types.js'
import type { Store } from '../state/store.js'

type Identity = { provider: string; model: string }
export class BudgetReached extends RequestNotSentError {
  constructor(readonly budget: SessionBudget) { super('Budget reached. Choose how to continue.', 'size'); this.name = 'BudgetReached' }
}
class BudgetUnavailable extends RequestNotSentError {
  constructor(message: string) { super(message, 'size'); this.name = 'BudgetUnavailable' }
}

/** One controller per durable parent store; synchronous reservations precede every await. */
export class BudgetController {
  onReached?: (pending: string) => Promise<void>
  onChanged?: (budget: SessionBudget) => void
  private writing?: Promise<void>
  constructor(readonly store: Store<AppState>, private save: () => void) { if (this.state) validateBudget(this.state) }
  get state() { return this.store.getState().budget }
  private commit(budget: SessionBudget) {
    validateBudget(budget)
    this.store.setState(() => ({ budget }))
    // A failed save refuses transport. The in-memory hold remains conservative.
    this.save()
    this.onChanged?.(budget)
  }
  inputCost(request: LLMRequestOptions, identity: Identity): number {
    const price = budgetPrice(identity.provider, identity.model, this.inputTokens(request, identity))
    if (!price) throw new BudgetUnavailable(`No price is available for ${identity.model}. Choose a priced or local model to use Session budget.`)
    // Share the engine's text/image estimator; encoded image bytes are never treated as text tokens.
    // A 25% margin and 1024 framing tokens protect an estimate. Reserve at the highest input/cache tier.
    return moneyUnits(this.inputTokens(request, identity) * (request.cache === false ? price.input : Math.max(price.input, price.write)) / 1_000_000)
  }
  private inputTokens(request: LLMRequestOptions, identity: Identity) {
    return request.budgetInputTokens ?? Math.ceil((localTokenEstimate(request.system ?? '') + localTokenEstimate(JSON.stringify(request.tools ?? [])) + estimateMessages(request.messages, localTokenEstimate)) * initialTokenScale(identity.model) * 1.25) + 1024
  }
  admit(request: LLMRequestOptions, identity: Identity, purpose: 'task' | 'handoff' = 'task'): BudgetRequest {
    const state = this.state!
    validateBudget(state)
    if (purpose === 'task' && state.phase !== 'active') throw new BudgetReached(state)
    const input = this.inputCost(request, identity), price = budgetPrice(identity.provider, identity.model, this.inputTokens(request, identity))!
    const spent = budgetSpent(state), ceiling = purpose === 'handoff' ? spent + budgetWriterRemaining(state) : state.limit
    if (purpose === 'task' && spent + input > state.limit - state.reserve || spent + input > ceiling) throw new BudgetReached(state)
    const desired = Math.max(1, Math.floor(request.maxTokens ?? 4096))
    const outputLimit = price.output === 0 ? desired : Math.min(desired, Math.floor((ceiling - spent - input) / (price.output * 1000)))
    if (outputLimit < (purpose === 'handoff' ? 128 : 1)) throw new BudgetReached(state)
    const reserved = input + moneyUnits(outputLimit * price.output / 1_000_000)
    if (reserved + spent > ceiling) throw new BudgetReached(state)
    const receipt: BudgetRequest = { id: randomUUID(), stage: state.stage, at: Date.now(), ...identity, purpose, reserved, outputLimit, status: 'reserved' }
    this.commit({ ...state, requests: [...state.requests, receipt] })
    return receipt
  }
  settle(id: string, usage: TokenUsage | undefined, complete: boolean, rejected = false) {
    const state = this.state!, receipt = state.requests.find(r => r.id === id)
    if (!receipt || receipt.charged !== undefined) return
    let charged: number | undefined
    if (rejected) charged = 0
    else if (complete && validUsage(usage)) {
      const price = budgetPrice(receipt.provider, receipt.model, usage.inputTokens)
      if (!price) throw new BudgetUnavailable('The request price is unavailable; its reservation is retained.')
      const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
      // The current provider adapters request five-minute writes; complete receipts use the same offline rates as Context.
      charged = moneyUnits(((usage.inputTokens - read - write) * price.input + read * price.read + write * price.write + usage.outputTokens * price.output) / 1_000_000)
    }
    const next: SessionBudget = { ...state, requests: state.requests.map(r => r.id !== id ? r : { ...r, charged, ...(usage && validUsage(usage) ? { usage } : {}), status: rejected ? 'rejected' : charged === undefined ? 'unconfirmed' : 'settled' }) }
    const stageSpent = (stage: number) => next.initialSpent + next.requests.filter(r => r.stage <= stage).reduce((sum, r) => sum + (r.charged ?? r.reserved), 0)
    next.stages = next.stages.map(s => ({ ...s, spentAtStart: s.number === 1 ? next.initialSpent : stageSpent(s.number - 1), ...(s.spentAtEnd === undefined ? {} : { spentAtEnd: stageSpent(s.number) }) }))
    this.commit(next)
  }
  async reach(pending: string): Promise<void> {
    if (this.writing) return this.writing
    const state = this.state!
    if (state.phase === 'held') return
    const resumed = state.phase === 'writing'
    this.commit({ ...state, phase: 'writing', pendingRequest: state.pendingRequest ?? pending,
      writerLimit: resumed ? budgetSpent(state) : Math.min(state.limit, budgetSpent(state) + state.reserve),
      writerAllowance: resumed ? 0 : Math.max(0, Math.min(state.reserve, state.limit - budgetSpent(state))) })
    this.writing = (async () => {
      try { await this.onReached?.(pending) }
      finally {
        const latest = this.state!
        this.commit({ ...latest, phase: 'held', stages: latest.stages.map(s => s.number === latest.stage ? { ...s, spentAtEnd: budgetSpent(latest), handoff: latest.handoff } : s) })
      }
    })()
    try { await this.writing } finally { this.writing = undefined }
  }
  recordHandoff(handoff: BudgetHandoff) { this.commit({ ...this.state!, handoff }) }
  add(usd: number) {
    const state = this.state!, extra = moneyUnits(usd)
    if (!state || !extra || state.phase !== 'held' || this.writing) throw new Error('Add budget only after the session is paused.')
    const limit = state.limit + extra, stage = state.stage + 1
    this.commit({ ...state, limit, stage, phase: 'active', handoff: undefined, pendingRequest: undefined, writerLimit: undefined, writerAllowance: undefined,
      stages: [...state.stages, { number: stage, limit, reserve: state.reserve, spentAtStart: budgetSpent(state) }] })
  }
}

const controllers = new WeakMap<Store<AppState>, BudgetController>()
export function sessionBudgetController(store: Store<AppState>, save: () => void): BudgetController {
  let controller = controllers.get(store)
  if (!controller) { controller = new BudgetController(store, save); controllers.set(store, controller) }
  return controller
}
/** Nested wrappers share one admission, but sibling requests have independent scopes. */
const admitted = new AsyncLocalStorage<Set<BudgetController>>()
export function budgetClient(client: LLMClient, controller: BudgetController, purpose: 'task' | 'handoff' = 'task'): LLMClient {
  const beforeSend = (request: LLMRequestOptions) => {
    request.beforeSend?.()
    if (purpose === 'task' && controller.state?.phase !== 'active') throw new BudgetReached(controller.state!)
  }
  const enter = async (request: LLMRequestOptions) => {
    request.signal?.throwIfAborted()
    let identity = client.modelIdentity?.(request.model) ?? { provider: 'unknown', model: request.model }
    if (client.budgetLocal === false && (identity.provider === 'local' || identity.provider === 'ollama')) identity = { ...identity, provider: 'remote-unpriced' }
    const text = (value: string) => Math.ceil(localTokenEstimate(value) * initialTokenScale(identity.model) * 1.25)
    request.budgetInputTokens ??= text(request.system ?? '') + text(JSON.stringify(request.tools ?? [])) + estimateMessages(request.messages, text, client.visionCapabilities?.(request.model)) + 1024
    try { return controller.admit(request, identity, purpose) }
    catch (error) {
      if (error instanceof BudgetReached && purpose === 'task') {
        const last = request.messages.at(-1)?.content
        const pending = typeof last === 'string' ? last : last?.filter(block => block.type === 'text').map(block => block.text).join('\n')
        await controller.reach(pending || 'Continue the pending request from the saved transcript.')
        throw new BudgetReached(controller.state!)
      }
      throw error
    }
  }
  return {
    get contextWindow() { return client.contextWindow }, get managedLocal() { return client.managedLocal },
    get budgetLocal() { return client.budgetLocal },
    maxOutputTokens: client.maxOutputTokens, refreshContextWindow: client.refreshContextWindow?.bind(client),
    modelIdentity: client.modelIdentity?.bind(client), visionCapabilities: client.visionCapabilities?.bind(client), countTokens: client.countTokens?.bind(client),
    async chat(request) {
      if (!controller.state || admitted.getStore()?.has(controller)) return client.chat(request)
      const receipt = await enter(request)
      let usage: TokenUsage | undefined, complete = false, failure: unknown
      try {
        const response = await admitted.run(new Set([...(admitted.getStore() ?? []), controller]), () => client.chat({ ...request, maxTokens: receipt.outputLimit, noRetry: true, beforeSend: () => beforeSend(request) }))
        usage = response.usageReported === false ? undefined : response.usage; complete = true
        return response
      } catch (error) { failure = error; throw error }
      finally { controller.settle(receipt.id, usage, complete, notBilled(failure, usage)) }
    },
    async *chatStream(request) {
      if (!controller.state || admitted.getStore()?.has(controller)) { yield* client.chatStream(request); return }
      const receipt = await enter(request)
      let usage: TokenUsage | undefined, complete = false, done = false, failure: unknown, generated = false
      const scope = new Set([...(admitted.getStore() ?? []), controller])
      const stream = client.chatStream({ ...request, maxTokens: receipt.outputLimit, noRetry: true, beforeSend: () => beforeSend(request) })
      try {
        for (;;) {
          const next = await admitted.run(scope, () => stream.next())
          if (next.done) { complete = done && !request.signal?.aborted; break }
          const event = next.value
          if (event.type === 'usage') usage = event.usage
          if (event.type === 'done') done = true
          if (['text', 'thinking', 'tool_use_start', 'tool_use_input'].includes(event.type)) generated = true
          if (event.type === 'error') throw new Error(event.error)
          yield event
        }
      } catch (error) { failure = error; throw error }
      finally { try { await stream.return(undefined) } finally { controller.settle(receipt.id, usage, complete, notBilled(failure, usage, generated)) } }
    },
  }
}
