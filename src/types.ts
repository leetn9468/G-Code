/**
 * @file types.ts
 * @brief Core type definitions for G-Code
 *
 * Defines the session counters, permission system, application state and CLI
 * option types.
 */

// ============================================================================
// Session Context (per-session counters)
// ============================================================================

export interface SessionContext {
  turn_count: number
  tool_call_count: number
  error_count: number
  compaction_count: number
  abort_count: number
  memory_access_count: number
  context_utilization: number
  reasoning_chain_length: number
}

export function createEmptySessionContext(): SessionContext {
  return {
    turn_count: 0,
    tool_call_count: 0,
    error_count: 0,
    compaction_count: 0,
    abort_count: 0,
    memory_access_count: 0,
    context_utilization: 0,
    reasoning_chain_length: 0,
  }
}

// ============================================================================
// Permission System
// ============================================================================

export type PermissionMode = import('./shared/sessionControls.js').SessionPermission

export type PermissionRuleSource = 'cli' | 'settings' | 'project' | 'hook'

export interface PermissionRule {
  tool: string
  pattern?: string
  /** Input-aware syntax from permissions.json or --allow/--deny. */
  rule?: string
  projectRoot?: string
  source: PermissionRuleSource
}

export interface ToolPermissionContext {
  mode: PermissionMode
  alwaysAllowRules: PermissionRule[]
  alwaysDenyRules: PermissionRule[]
  alwaysAskRules: PermissionRule[]
  /** Only the CLI enables personal rule loading; embedded callers keep their existing policy. */
  loadUserRules?: boolean
}

export function createDefaultPermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    alwaysAskRules: [],
  }
}

// ============================================================================
// Messages
// ============================================================================

export type MessageRole = 'user' | 'assistant' | 'system'

export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
  wire?: import('./llm/types.js').LLMMessage
}

// ============================================================================
// Application State
// ============================================================================

export interface AppState {
  sessionId: string
  cwd: string
  messages: Message[]
  permissionContext: ToolPermissionContext
  sessionContext: SessionContext
  contextMessages?: Message[]
  contextStatus?: import('./shared/sessionControls.js').ContextStatus
  contextCalibration?: import('./shared/tokenCalibration.js').TokenCalibration
  networkHold?: import('./shared/networkGuard.js').NetworkHold
  budget?: import('./shared/sessionBudget.js').SessionBudget
  usageTotals?: import('./shared/usageTotals.js').UsageTotals
  outputs?: import('./shared/sessionControls.js').SessionOutput[]
  toolHistory?: import('./shared/sessionControls.js').SessionTool[]
  compactArchives?: Array<{ at: number; messages: Message[] }>
  effort?: import('./shared/sessionControls.js').Effort
  /**
   * What the conversation's system prompt carries, fixed when the conversation started in `cwd`:
   * the project memory and the permission mode of that moment. The system prompt then stays the
   * same bytes (also after a resume); later memory edits and mode changes reach the model in a
   * turn's context block.
   */
  promptSnapshot?: { cwd: string; memory: string; permissionMode: string; nodeEnvironment?: string; learned?: string; system?: string; tools?: import('./llm/types.js').LLMToolDefinition[]; local?: boolean }
}

// ============================================================================
// CLI Options
// ============================================================================

export interface CLIOptions {
  verbose: boolean
  print: string | boolean
  model?: string
  permissionMode: PermissionMode
  provider?: string
  baseUrl?: string
  allowWorkflow?: boolean
  allow?: string[]
  deny?: string[]
  networkGuard?: boolean
  /** --effort: the reasoning effort for a headless run. */
  effort?: string
  budgetUsd?: number
  budgetReserveUsd?: number
  handoffModel?: string
  failOnDenial?: boolean
  fast?: boolean
  listModels?: boolean
  continue?: boolean
  resume?: string
}
