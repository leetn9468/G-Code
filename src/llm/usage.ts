import type { TokenUsage } from './types.js'
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const optional = (value: unknown) => count(value) ?? 0

/** Input/output totals include their cached/reasoning subsets exactly once. */
export function openAIUsage(value: any, timings?: any): TokenUsage | undefined {
  const read = count(value?.prompt_tokens_details?.cached_tokens ?? value?.prompt_cache_hit_tokens ?? timings?.cache_n)
  const input = count(value?.prompt_tokens) ?? (read !== undefined && count(timings?.prompt_n) !== undefined ? read + timings.prompt_n : undefined)
  const output = count(value?.completion_tokens) ?? count(timings?.predicted_n)
  if (input === undefined || output === undefined) return
  const write = count(value?.prompt_tokens_details?.cache_write_tokens ?? value?.cache_creation_input_tokens)
  return { inputTokens: input, outputTokens: output,
    ...(read !== undefined ? { cacheReadTokens: read, cacheWriteTokens: write ?? 0 } : write !== undefined ? { cacheWriteTokens: write } : {}),
    reasoningTokens: optional(value?.completion_tokens_details?.reasoning_tokens) }
}
/** The Responses API reports input including its cached and cache-written parts, like Chat Completions. */
export function responsesUsage(value: any): TokenUsage | undefined {
  const input = count(value?.input_tokens), output = count(value?.output_tokens)
  if (input === undefined || output === undefined) return
  const read = count(value?.input_tokens_details?.cached_tokens), write = count(value?.input_tokens_details?.cache_write_tokens)
  return { inputTokens: input, outputTokens: output,
    ...(read !== undefined ? { cacheReadTokens: read, cacheWriteTokens: write ?? 0 } : write !== undefined ? { cacheWriteTokens: write } : {}),
    reasoningTokens: optional(value?.output_tokens_details?.reasoning_tokens) }
}
export function anthropicUsage(value: any): TokenUsage | undefined {
  if (!value || count(value.input_tokens) === undefined || count(value.output_tokens) === undefined) return
  const read = optional(value.cache_read_input_tokens), write = optional(value.cache_creation_input_tokens)
  // Thinking is part of output_tokens; the stream reports it in message_delta's usage.
  const thinking = count(value.output_tokens_details?.thinking_tokens)
  const reported = count(value.cache_read_input_tokens) !== undefined
  return { inputTokens: value.input_tokens + read + write, outputTokens: value.output_tokens,
    ...(reported ? { cacheReadTokens: read, cacheWriteTokens: write } : count(value.cache_creation_input_tokens) !== undefined ? { cacheWriteTokens: write } : {}),
    ...(thinking !== undefined ? { reasoningTokens: Math.min(thinking, value.output_tokens) } : {}) }
}
export function geminiUsage(value: any): TokenUsage | undefined {
  if (!value || count(value.promptTokenCount) === undefined) return
  const reasoning = optional(value.thoughtsTokenCount)
  const read = count(value.cachedContentTokenCount)
  return { inputTokens: value.promptTokenCount, outputTokens: optional(value.candidatesTokenCount) + reasoning,
    ...(read !== undefined ? { cacheReadTokens: read, cacheWriteTokens: 0 } : {}), reasoningTokens: reasoning }
}
