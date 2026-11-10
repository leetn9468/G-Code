/**
 * @file context.ts
 * @brief Token counting and context window management
 *
 * Rough token estimation (chars/4) for context budget tracking.
 * Triggers compaction when approaching the model's context limit.
 */

import type { LLMMessage, ContentBlock, LLMToolDefinition } from '../llm/types.js'
import { estimateMessages } from '../llm/images.js'

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Rough token count: ~4 characters per token for English text.
 * This is a fast heuristic — the API returns exact counts after each call.
 */
export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimate tokens for a content block.
 */
function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return roughTokenCount(block.text)
    case 'tool_use':
      return roughTokenCount(block.name) + roughTokenCount(JSON.stringify(block.input))
    case 'tool_result':
      return typeof block.content === 'string' ? roughTokenCount(block.content) : block.content.reduce((sum, child) => sum + blockTokens(child), 0)
    case 'image':
      return estimateMessages([{ role: 'user', content: [block] }], roughTokenCount)
    case 'thinking':
      return roughTokenCount(block.thinking)
    default:
      return 0
  }
}

/**
 * Estimate tokens for a message.
 */
export function messageTokens(message: LLMMessage): number {
  const overhead = 4 // Role marker + structure
  if (typeof message.content === 'string') {
    return overhead + roughTokenCount(message.content)
  }
  return overhead + message.content.reduce((sum, b) => sum + blockTokens(b), 0)
}

/**
 * Estimate total tokens for a conversation.
 */
export function conversationTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

// ============================================================================
// Context Budget
// ============================================================================

export { getContextLimit, contextLimitSource } from '../shared/contextWindows.js'
import { getContextLimit } from '../shared/contextWindows.js'

/**
 * Provider input tokens per rough estimated token (chars/4) to assume before a response
 * calibrates the ratio. Claude's tokenizer counted G-Code's system prompt and tool schemas about
 * 1.6 times the rough estimate, a conversation about 1.4-1.5 times; other models start at 1.
 */
export function initialTokenScale(model: string): number {
  return model.startsWith('claude-') ? 1.5 : 1
}


export interface ContextBudget {
  used: number
  limit: number
  remaining: number
  utilizationPct: number
  needsCompaction: boolean
}

export interface ContextBudgetOptions {
  inputTokens?: number
  contextLimit?: number
  tools?: LLMToolDefinition[]
  outputTokens?: number
  safetyTokens?: number
  conservative?: boolean
}

/** Byte-based estimate leaves more room for JSON schemas and non-English text. */
export function localTokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

/** The share of the window, the output reserve included, at which a conversation is compacted. */
export const COMPACTION_THRESHOLD = 0.85

/**
 * Calculate context budget for the current conversation.
 */
export function calculateContextBudget(
  messages: LLMMessage[],
  systemPromptTokens: number,
  model: string,
  options: ContextBudgetOptions = {},
): ContextBudget {
  const limit = options.contextLimit ?? getContextLimit(model)
  const estimate = options.conservative ? localTokenEstimate : roughTokenCount
  const messageTokenCount = options.conservative ? estimateMessages(messages, estimate) : conversationTokens(messages)
  const toolTokens = options.tools?.length ? estimate(JSON.stringify(options.tools)) : 0
  const used = (options.inputTokens ?? (systemPromptTokens + messageTokenCount + toolTokens)) + (options.outputTokens ?? 0) + (options.safetyTokens ?? 0)
  const remaining = Math.max(0, limit - used)
  const utilizationPct = used / limit

  return {
    used,
    limit,
    remaining,
    utilizationPct,
    needsCompaction: utilizationPct >= COMPACTION_THRESHOLD,
  }
}

// ============================================================================
// Context Trimming (simple oldest-first drop)
// ============================================================================

/**
 * Trim messages to fit within a target token budget.
 * Keeps the most recent messages, drops oldest first.
 * Always preserves the first user message (original query) and last 4 messages.
 */
export function trimMessages(
  messages: LLMMessage[],
  targetTokens: number,
): LLMMessage[] {
  if (messages.length <= 4) return messages

  const currentTokens = conversationTokens(messages)
  if (currentTokens <= targetTokens) return messages

  // Always keep first message and last 4
  const first = messages[0]!
  const tail = messages.slice(-4)
  const middle = messages.slice(1, -4)

  const result: LLMMessage[] = [first]
  let budget = targetTokens - messageTokens(first) - conversationTokens(tail)

  // Add middle messages from most recent backwards
  const kept: LLMMessage[] = []
  for (let i = middle.length - 1; i >= 0; i--) {
    const tokens = messageTokens(middle[i]!)
    if (budget - tokens >= 0) {
      kept.unshift(middle[i]!)
      budget -= tokens
    } else {
      break // Drop all remaining older messages
    }
  }

  result.push(...kept, ...tail)
  return result
}
