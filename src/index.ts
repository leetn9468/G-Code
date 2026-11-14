/**
 * @file index.ts
 * @brief G-Code barrel export
 *
 * Public API surface for @o-research/g-code.
 * Consumers can import types and utilities from this module.
 */

// ── Types ──────────────────────────────────────────────────────────────────
export type {
  AppState,
  CLIOptions,
  Message,
  MessageRole,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  SessionContext,
  ToolPermissionContext,
} from './types.js'

export {
  createDefaultPermissionContext,
  createEmptySessionContext,
} from './types.js'

// ── State ──────────────────────────────────────────────────────────────────
export type { Store, StateUpdater, SessionData } from './state/store.js'
export {
  createStore,
  createAppStore,
  createDefaultAppState,
  saveSession,
  loadSession,
} from './state/store.js'

// ── Tools ──────────────────────────────────────────────────────────────────
export type { Tool, ToolResult, PermissionResult, PermissionDecision, ToolUseContext, Tools } from './tools/tool.js'
export { evaluatePermission } from './tools/permissions.js'
export { getTools, findTool, registerTool, unregisterTool } from './tools/registry.js'

// ── LLM ────────────────────────────────────────────────────────────────────
export type { LLMClient, LLMMessage, LLMResponse, LLMRequestOptions, ContentBlock, StreamEvent } from './llm/types.js'
export { AnthropicClient } from './llm/anthropic.js'

// ── Engine ─────────────────────────────────────────────────────────────────
export { QueryEngine } from './engine/queryEngine.js'
export type { QueryEngineOptions, QueryResult } from './engine/queryEngine.js'
export { runTools } from './engine/toolRunner.js'
export { buildSystemPrompt } from './engine/systemPrompt.js'

// ── Tool Implementations ───────────────────────────────────────────────────
export { BashTool } from './tools/impl/BashTool.js'
export { FileReadTool } from './tools/impl/FileReadTool.js'
export { FileWriteTool } from './tools/impl/FileWriteTool.js'
export { FileEditTool } from './tools/impl/FileEditTool.js'
export { GrepTool } from './tools/impl/GrepTool.js'
export { GlobTool } from './tools/impl/GlobTool.js'
export { ListDirTool } from './tools/impl/ListDirTool.js'

// ── CLI ────────────────────────────────────────────────────────────────────
export { getVersion, printBanner, printVersion } from './cli/branding.js'
