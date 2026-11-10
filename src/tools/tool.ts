/**
 * @file tool.ts
 * @brief Core Tool interface and ToolResult type
 *
 * Every tool in G-Code implements this interface. Tools are the primary
 * mechanism for the AI agent to interact with the environment.
 */

import { type ZodType, type ZodTypeDef } from 'zod'
import type { PermissionMode, ToolPermissionContext } from '../types.js'
import { escapeDisplayControls } from '../shared/displayText.js'

// ============================================================================
// Tool Result
// ============================================================================

export interface ToolResult<T = unknown> {
  success: boolean
  output?: T
  error?: string
  contentBlocks?: (import('../llm/types.js').TextBlock | import('../llm/types.js').ImageBlock)[]
}

// ============================================================================
// Permission Result
// ============================================================================

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export interface WorkflowSource { kind: 'inline' | 'session' | 'project' | 'global'; path?: string }

/** Terminal provenance is textual; desktop renders the separate host-owned field. */
export function approvalReason(reason: string, origin?: WorkflowSource): string {
  if (!origin || process.env.GCODE_DESKTOP === '1') return escapeDisplayControls(reason)
  const path = origin.path // Already escaped when the host constructs provenance.
  const suffix = `\n[Workflow source: ${origin.kind}${path ? '; path: ' + path : ''}]`
  return escapeDisplayControls(reason.endsWith(suffix) ? reason.slice(0, -suffix.length) : reason) + suffix
}

export interface PermissionResult {
  workflowSource?: WorkflowSource
  decision: PermissionDecision
  reason?: string
}

// ============================================================================
// Tool Use Context
// ============================================================================

/** What one agent last read of a file: FileRead dedup and FileEdit/FileWrite freshness checks. */
export interface FileReadRecord { mtime: number; offset: number; limit: number; size?: number }
export type ReadFileState = Map<string, FileReadRecord>

/** Extra details for an approval request; the signal cancels a request that is still waiting. */
export interface ApprovalRequestOptions { network?: { hosts: string[]; scope?: 'call' | 'session' }; suggestedRule?: string; projectRoot?: string; workflowSource?: WorkflowSource; signal?: AbortSignal; runId?: string; agentId?: string }
export type ConfirmTool = (toolName: string, reason: string, input?: Record<string, unknown>, options?: ApprovalRequestOptions) => Promise<boolean>

export interface ToolUseContext {
  vision?: import('../llm/types.js').VisionCapabilities
  cwd: string
  sessionId: string
  /**
   * The saved session that keeps the records of background shells this call starts (see TaskRecord
   * in src/tools/backgroundShells.ts). A sub-agent or workflow agent has a throw-away session of its
   * own; its shells belong to the session it works for. Defaults to `sessionId`.
   */
  taskSessionId?: string
  turnNumber: number
  isHeadless: boolean
  allowWorkflow?: boolean
  onPermissionDenial?: (denial: import('../shared/permissionRules.js').PermissionDenial) => void
  webFetchRuleHost?: string
  signal?: AbortSignal
  /** Host-created hook context only; never part of model-supplied Bash input. */
  hookEnv?: Readonly<Record<string, string>>
  /** Frozen definitions and authority inherited by engines started in this turn. */
  hookSnapshot?: import('../engine/hooks.js').HookSnapshot
  hookWarning?: import('../engine/hooks.js').HookWarningSink
  hookReloadScope?: import('../engine/hooks.js').HookReloadScope
  toolHookPolicy?: () => ToolPermissionContext
  failureBudget?: import('../engine/failureBudget.js').TurnFailureBudget
  onProgress?: (detail: string) => void
  /** The id of the tool call this context runs (set by the tool runner). */
  toolUseId?: string
  /** The id of this call's card in the desktop's chat, when it differs from the provider's call id (a replay gives a call a new card). */
  toolCardId?: (callId: string) => string
  onArtifacts?: (paths: string[], tool?: string) => void
  getPermissionContext?: () => ToolPermissionContext
  setPermissionMode?: (mode: PermissionMode) => void
  setCwd?: (cwd: string) => void
  confirm?: ConfirmTool
  /** Owned by one engine, so sibling and parent/child agents never share read dedup. */
  readFileState?: ReadFileState
  /** The tool set of the agent making this call (set by the tool runner), e.g. for ToolSearch. */
  tools?: Tools
  /** The tools this session does not send in full (deferred tool loading): ToolSearch returns their definitions. */
  deferredTools?: ReadonlySet<string>
}

// ============================================================================
// Tool Interface
// ============================================================================

export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name */
  readonly name: string

  /** Human-readable description for the model */
  readonly description: string

  /** Zod schema for input validation */
  readonly inputSchema: ZodType<TInput, ZodTypeDef, unknown>
  /** Original JSON Schema for dynamically discovered tools. */
  readonly networkHosts?: string[]
  readonly inputJsonSchema?: Record<string, unknown>
  /**
   * No side effects: consecutive calls of such tools in one reply run at the same time. Built-in
   * read tools are listed in the tool runner; set it for others (e.g. read-only MCP tools).
   */
  readonly concurrencySafe?: boolean

  /** Execute the tool */
  call(input: TInput, context: ToolUseContext): Promise<ToolResult<TOutput>>

  /** Check if this tool is allowed under current permissions */
  checkPermissions(input: TInput, context: ToolUseContext): Promise<PermissionResult>

  /** Generate the system prompt description for this tool */
  prompt(): string
}

// ============================================================================
// Tool Collection Type
// ============================================================================

export type Tools = ReadonlyArray<Tool<unknown, unknown>>
