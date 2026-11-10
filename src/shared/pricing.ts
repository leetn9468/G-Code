import type { ModelUsage, UsageTotals } from './usageTotals.js'

type Rates = { input: number; output: number; read: number; write: number }

/** USD / million tokens. Offline estimate, not an invoice or a live price feed.
 * Opus 5.5 and Sonnet 5.5 rates are supplied by the 2026-10-25 task briefs; Haiku 5.5's two rate
 * cards come from the Claude API reference; other entries are public standard-tier snapshots.
 * Unknown aliases, tiers and providers stay unpriced.
 * Cache write assumes the default five-minute Anthropic TTL used by this client.
 */
export const PRICING: Record<string, Rates> = {
  'anthropic:claude-opus-5-5': { input: 4, output: 20, read: 0.2, write: 5 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10, read: 0.2, write: 2.5 },
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
  'anthropic:claude-sonnet-4-20250514': { input: 3, output: 15, read: 0.3, write: 3.75 },
  'openai:gpt-4o': { input: 2.5, output: 10, read: 1.25, write: 0 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6, read: 0.075, write: 0 },
  // GPT-6.1 Terra, standard tier (2026-10 aggregator listings: llmgateway, LiteLLM, Apidog agree);
  // cache writes at the 30-minute TTL G-Code requests (cacheHints).
  'openai:gpt-6.1-terra': { input: 1, output: 5, read: 0.05, write: 1.25 },
}

/**
 * Models billed on a second rate card for a request whose prompt (input with cache reads and
 * writes) is over `threshold` tokens. PRICING holds the card at or under it. Claude Haiku 5.5:
 * $0.50 / $2.50 above 100K tokens, cache reads 0.1x and five-minute writes 1.25x of that input rate.
 */
export const LONG_PROMPT_PRICING: Record<string, Rates & { threshold: number }> = {
  'anthropic:claude-haiku-5-5': { threshold: 100_000, input: 0.5, output: 2.5, read: 0.05, write: 0.625 },
  // Over 272K input tokens the whole request is billed at 2x input/cache and 1.5x output.
  'openai:gpt-6.1-terra': { threshold: 272_000, input: 2, output: 7.5, read: 0.1, write: 2.5 },
}

/** The prompt size above which a request of this model is billed on its long-prompt card. */
export function longPromptThreshold(provider: string, model: string): number | undefined {
  return LONG_PROMPT_PRICING[`${provider}:${model}`]?.threshold
}

const cost = (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, price: Rates) => {
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
  return ((usage.inputTokens - read - write) * price.input + usage.outputTokens * price.output + read * price.read + write * price.write) / 1_000_000
}

/**
 * One model row at list prices. A row of a model with a long-prompt card prices the requests over
 * its threshold on that card. A row recorded before requests were told apart has no split; it is
 * priced on the first card, which is exact when the row's whole input stays under the threshold.
 */
function rowCost(row: ModelUsage, price: Rates): number {
  const long = LONG_PROMPT_PRICING[`${row.provider}:${row.model}`]
  if (!long || !row.longPrompt?.requests) return cost(row, price)
  const over = row.longPrompt
  const under = { inputTokens: row.inputTokens - over.inputTokens, outputTokens: row.outputTokens - over.outputTokens,
    cacheReadTokens: (row.cacheReadTokens ?? 0) - (over.cacheReadTokens ?? 0), cacheWriteTokens: (row.cacheWriteTokens ?? 0) - (over.cacheWriteTokens ?? 0) }
  return cost(under, price) + cost(over, long)
}

export function estimatedCost(totals: UsageTotals): number | undefined {
  if (totals.incomplete || totals.unreportedRequests || totals.partialRequests || totals.abortedRequests || !totals.byModel.length) return
  let total = 0
  for (const row of totals.byModel) {
    if (row.provider === 'local' || row.provider === 'ollama') continue
    const price = PRICING[`${row.provider}:${row.model}`]
    if (!price) return
    total += rowCost(row, price)
  }
  return total
}
