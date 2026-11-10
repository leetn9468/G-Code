import type { TokenUsage } from '../llm/types.js'
import type { UsageTotals } from './usageTotals.js'
import { estimatedCost } from './pricing.js'

/** Cache reads are a subset of inclusive input, never added to its denominator. */
export function cacheReadRatio(usage: TokenUsage | undefined): number | undefined {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens <= 0 || usage.cacheReadTokens === undefined
    || !Number.isSafeInteger(usage.cacheReadTokens) || usage.cacheReadTokens < 0 || usage.cacheReadTokens > usage.inputTokens) return
  return usage.cacheReadTokens / usage.inputTokens
}

/** A mixed or older incomplete ledger cannot imply that unreported cache use was zero. */
export function sessionCacheRatio(usage: UsageTotals | undefined): number | undefined {
  if (!usage || !usage.requests || usage.incomplete || usage.unreportedRequests || usage.cacheUnreportedRequests
    || usage.cacheReportedRequests !== usage.requests || usage.partialRequests || usage.abortedRequests) return
  return cacheReadRatio(usage)
}

export const cachePercent = (ratio: number | undefined) => ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`

/** Net saving includes cache-write premiums; it can be negative on the first request. */
export function cacheSavings(usage: UsageTotals | undefined): number | undefined {
  if (!usage || sessionCacheRatio(usage) === undefined) return
  const actual = estimatedCost(usage)
  const uncached = estimatedCost({ ...usage, byModel: usage.byModel.map(row => ({ ...row, cacheReadTokens: 0, cacheWriteTokens: 0,
    ...(row.longPrompt ? { longPrompt: { ...row.longPrompt, cacheReadTokens: 0, cacheWriteTokens: 0 } } : {}) })) })
  return actual === undefined || uncached === undefined ? undefined : uncached - actual
}
