/**
 * @file index.ts
 * @brief Engine barrel export
 */

export { QueryEngine } from './queryEngine.js'
export type { QueryEngineOptions, QueryResult } from './queryEngine.js'
export { runTools } from './toolRunner.js'
export type { ToolRunResult } from './toolRunner.js'
export { buildSystemPrompt } from './systemPrompt.js'
export {
  roughTokenCount,
  messageTokens,
  conversationTokens,
  calculateContextBudget,
  getContextLimit,
  trimMessages,
} from './context.js'
export type { ContextBudget } from './context.js'
export { compactMessagesSimple, compactMessagesWithLLM } from './compact.js'
