import type { Effort } from './sessionControls.js'

/**
 * max_tokens per effort, as a percentage of the model's official output limit. Adaptive thinking
 * counts against max_tokens and the model cannot see the cap, so a cap sized for the answer alone
 * cuts replies off while they are still thinking. max_tokens only caps a reply; unused room is not
 * billed.
 */
export const OUTPUT_BUDGET_PERCENT: Record<Effort, number> = { low: 52, medium: 61, high: 72, extra: 85, max: 100 }
/** The runtime limit of local inference (GGUF, Ollama): no per-effort cap, only the context window bounds the reply. */
export const NO_OUTPUT_LIMIT = Number.POSITIVE_INFINITY
/**
 * The size of a typical reply per effort: the room the context check keeps free for it, and the
 * cap for a model whose output limit is unknown (an unknown provider may reject a larger one).
 */
export const REPLY_RESERVE: Record<Effort, number> = { low: 4096, medium: 8192, high: 12288, extra: 16384, max: 32768 }

// Official output limits, checked 2026-11-09. Unknown models use the application's conservative
// 32k ceiling; a runtime may supply its own limit. No family extrapolation.
const OUTPUT_LIMITS: Record<string, number> = {
  'claude-fable-5-1': 128000,
  'claude-fable-5': 128000,
  'claude-opus-5-5': 128000,
  'claude-sonnet-5-5': 128000,
  'claude-haiku-5-5': 128000,
  'claude-opus-5': 128000,
  'claude-sonnet-5': 128000,
  'claude-opus-4-8': 128000,
  'claude-opus-4-7': 128000,
  'claude-opus-4-6': 128000,
  'claude-sonnet-4-6': 128000,
  'claude-opus-4-5': 64000,
  'claude-opus-4-5-20251101': 64000,
  'claude-haiku-4-5': 64000,
  'claude-haiku-4-5-20251001': 64000,
  'claude-sonnet-4-20250514': 64000,
  'claude-opus-4-20250514': 32000,
  'gpt-6.1-terra': 128000,
  'gpt-6.1-sol': 128000,
  'gpt-6-astra': 128000,
  'gpt-6-luna': 128000,
  'gpt-5.6-sol': 128000,
  'gpt-5.5': 128000,
  'gpt-5': 128000,
  'gpt-4.1': 32768,
  'gpt-4o': 16384,
  'gpt-4o-2024-08-06': 16384,
  'gpt-4o-mini': 16384,
  // The synchronous limit; Gemini 4 Argon's 1,048,576 needs long decode, which G-Code does not use.
  'gemini-4-argon': 65536,
  'gemini-3.8-flash': 65536,
  'gemini-3.6-flash': 65536,
  'gemini-3.5-flash-lite': 65536,
  'gemini-3.1-pro-preview': 65536,
  'gemini-3.1-flash-lite': 65536,
  'gemini-3-flash-preview': 65536,
  'gemini-2.5-pro': 65536,
  'gemini-2.5-flash': 65536,
  'gemini-2.5-flash-lite': 65536,
  'gemini-2.0-flash': 8192,
  'deepseek-flash': 393216,
  'deepseek-v4-pro': 393216,
  'deepseek-v4-flash': 393216,
  'qwen3.8-max': 131072,
  'qwen3.8-flash': 131072,
  'qwen3.7-max': 131072,
  'qwen3.7-plus': 131072,
  'qwen-plus': 32768,
  'qwen-flash': 32768,
  'qwen-max': 8192,
}
export function maxModelOutput(model: string, runtimeLimit?: number): number {
  return runtimeLimit ?? OUTPUT_LIMITS[model] ?? 32768
}

/** Whether the model's output limit is published (or set by the runtime), so a large cap is safe to send. */
export function knownOutputLimit(model: string, runtimeLimit?: number): boolean {
  return runtimeLimit !== undefined || Object.hasOwn(OUTPUT_LIMITS, model)
}

/**
 * A non-streaming reply arrives in one piece at the end; keep it short enough to finish within
 * ordinary HTTP timeouts (the first request uses the lower value, a retry may use the higher).
 */
export const NON_STREAMING_OUTPUT = { first: 16000, most: 32000 } as const

/** Output tokens for a one-off request to a model whose output limit is unknown (an unknown provider may reject more). */
const UNKNOWN_ONE_SHOT_OUTPUT = 8192

/**
 * max_tokens for a one-off request (a compaction summary, a handoff), and for its single retry
 * after a cut-off reply. A reasoning model thinks before it writes, and the thinking counts against
 * max_tokens: a budget sized for the text alone was cut off, paid for and thrown away on most
 * requests. Unused room is not billed. `input` (estimated tokens) and the reply stay within
 * `contextLimit` together, never below `floor`.
 */
export function oneShotBudgets(model: string, runtimeLimit: number | undefined, contextLimit: number, input: number, floor = 4096): number[] {
  const known = knownOutputLimit(model, runtimeLimit)
  const ceiling = Math.min(maxModelOutput(model, runtimeLimit), Math.max(floor, contextLimit - input - 1024))
  if (runtimeLimit === NO_OUTPUT_LIMIT && Number.isFinite(ceiling)) return [ceiling]
  const first = Math.min(known ? NON_STREAMING_OUTPUT.first : UNKNOWN_ONE_SHOT_OUTPUT, ceiling)
  const retry = Math.min(known ? NON_STREAMING_OUTPUT.most : UNKNOWN_ONE_SHOT_OUTPUT, ceiling)
  return retry > first ? [first, retry] : [first]
}

/**
 * max_tokens for a request at this effort: the effort's share of a known output limit, the typical
 * reply size otherwise.
 */
export function outputBudget(model: string, effort: Effort, runtimeLimit?: number): number {
  const ceiling = maxModelOutput(model, runtimeLimit)
  return knownOutputLimit(model, runtimeLimit) ? Math.floor(ceiling * OUTPUT_BUDGET_PERCENT[effort] / 100) : Math.min(REPLY_RESERVE[effort], ceiling)
}

/**
 * The output budget of one model request: `first` is sent first, `ceiling` is the most a retry
 * may raise it to. A known limit lets a retry go straight to the ceiling; an unknown one doubles.
 */
export function outputPlan(model: string, effort: Effort, runtimeLimit: number | undefined, streaming: boolean): { first: number; ceiling: number; known: boolean } {
  if (runtimeLimit === NO_OUTPUT_LIMIT) return { first: NO_OUTPUT_LIMIT, ceiling: NO_OUTPUT_LIMIT, known: true }
  const known = knownOutputLimit(model, runtimeLimit)
  const modelCeiling = maxModelOutput(model, runtimeLimit)
  const first = outputBudget(model, effort, runtimeLimit)
  if (streaming) return { first, ceiling: Math.max(first, modelCeiling), known }
  const ceiling = Math.min(modelCeiling, Math.max(NON_STREAMING_OUTPUT.most, 2 * REPLY_RESERVE[effort]))
  return { first: Math.min(first, Math.max(NON_STREAMING_OUTPUT.first, REPLY_RESERVE[effort]), ceiling), ceiling, known }
}

/** The budget a retry gets after `current` ran out. */
export function raisedOutput(plan: { ceiling: number; known: boolean }, current: number): number {
  return Math.max(current, plan.known ? plan.ceiling : Math.min(current * 2, plan.ceiling))
}
