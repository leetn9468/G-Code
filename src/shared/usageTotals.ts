import type { TokenUsage } from '../llm/types.js'
import { longPromptThreshold } from './pricing.js'

export interface ModelUsage extends TokenUsage {
  provider: string; model: string; requests: number
  cacheReportedRequests?: number
  cacheUnreportedRequests?: number
  /**
   * The part of this row from requests whose prompt was over the model's long-prompt threshold,
   * for a model priced by prompt length (Claude Haiku 5.5 above 100K tokens). Rows recorded before
   * it existed have none.
   */
  longPrompt?: TokenUsage & { requests: number }
}
export interface UsageTotals extends TokenUsage {
  requests: number
  unreportedRequests: number
  /** Requests whose stream stopped before the provider's final usage: their output is a lower bound. */
  partialRequests?: number
  /** Cancelled before any usable usage arrived; their cost is unknown. */
  abortedRequests?: number
  incomplete: boolean
  byModel: ModelUsage[]
  /** Separate from token usage: some providers report totals but no cache data. */
  cacheReportedRequests?: number
  cacheUnreportedRequests?: number
  /** Requests that rewrote an already-sent history prefix; a potential full cache miss. */
  cacheInvalidations?: number
}

export function emptyUsage(incomplete = false): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, unreportedRequests: 0, incomplete, byModel: [], cacheReportedRequests: 0, cacheUnreportedRequests: 0 }
}

/** Provider usage is inclusive of cached input and reasoning output. */
export function validUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  return !!usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.reasoningTokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)
    && (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= usage.inputTokens
    && (usage.reasoningTokens ?? 0) <= usage.outputTokens
}

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
})

/**
 * Add one request's usage. A model priced by prompt length keeps the requests over its threshold
 * apart (their prompt, input with cache reads and writes, decides the rate), since a sum cannot
 * tell them apart later. `partial`: the request's stream stopped before its final usage.
 */
export function appendUsage(previous: UsageTotals, identity: { provider: string; model: string }, usage?: TokenUsage, flags: { partial?: boolean; aborted?: boolean; cacheInvalidation?: boolean } = {}): UsageTotals {
  if (flags.cacheInvalidation) previous = { ...previous, cacheInvalidations: (previous.cacheInvalidations ?? 0) + 1 }
  if (!validUsage(usage)) return flags.aborted
    ? { ...previous, abortedRequests: (previous.abortedRequests ?? 0) + 1 }
    : { ...previous, unreportedRequests: previous.unreportedRequests + 1 }
  const row = previous.byModel.find(item => item.provider === identity.provider && item.model === identity.model)
  const threshold = longPromptThreshold(identity.provider, identity.model)
  const sums = add(row ?? emptyUsage(), usage)
  const next: ModelUsage = { ...identity, ...sums, requests: (row?.requests ?? 0) + 1,
    cacheReportedRequests: (row?.cacheReportedRequests ?? 0) + (usage.cacheReadTokens !== undefined ? 1 : 0),
    cacheUnreportedRequests: (row?.cacheUnreportedRequests ?? row?.requests ?? 0) + (usage.cacheReadTokens === undefined ? 1 : 0) }
  if (threshold !== undefined) {
    const long = row?.longPrompt ?? { ...add(emptyUsage(), { inputTokens: 0, outputTokens: 0 }), requests: 0 }
    next.longPrompt = usage.inputTokens > threshold ? { ...add(long, usage), requests: long.requests + 1 } : long
  } else if (row?.longPrompt) next.longPrompt = row.longPrompt
  return { ...previous, ...add(previous, usage), requests: previous.requests + 1,
    cacheReportedRequests: (previous.cacheReportedRequests ?? 0) + (usage.cacheReadTokens !== undefined ? 1 : 0),
    cacheUnreportedRequests: (previous.cacheUnreportedRequests ?? previous.requests) + (usage.cacheReadTokens === undefined ? 1 : 0),
    ...(flags.partial || previous.partialRequests ? { partialRequests: (previous.partialRequests ?? 0) + (flags.partial ? 1 : 0) } : {}),
    byModel: row ? previous.byModel.map(item => item === row ? next : item) : [...previous.byModel, next] }
}
