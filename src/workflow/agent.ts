import type { HookSnapshot, HookWarningSink, HookReloadScope } from '../engine/hooks.js'
import { QueryEngine, type OutputLedger } from '../engine/queryEngine.js'
import { createAppStore, type Store } from '../state/store.js'
import type { AppState } from '../types.js'
import type { LLMClient } from '../llm/types.js'
import type { ProviderName } from '../llm/provider.js'
import { APIError, type RetryOptions } from '../llm/retry.js'
import type { ConfirmTool, PermissionResult, Tool, ToolUseContext } from '../tools/tool.js'
import { PLAN_TOOLS } from '../tools/permissions.js'
import { isSubAgentTool } from '../tools/impl/AgentTool.js'
import { lspReadOnlyRefusal } from '../tools/impl/LSPTool.js'
import { EFFORTS, type Effort } from '../shared/sessionControls.js'
import { limitClient, streamWithRetry } from './limiter.js'
import { lastJSONObject, schemaValidator } from './structured.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { truncateCodePoints, type ApprovalOrigin } from './events.js'

export interface AgentOptions { label?: string; phase?: string; schema?: Record<string, unknown> | null; model?: string | null; effort?: Effort | null; readOnly?: boolean | null }
export interface AgentContext {
  runId: string
  agentId: string
  client: LLMClient
  provider: ProviderName
  model?: string
  store: Store<AppState>
  tools: ReadonlyArray<Tool>
  isHeadless?: boolean
  onPermissionDenial?: (denial: import('../shared/permissionRules.js').PermissionDenial) => void
  maxIterations?: number
  hooks: HookSnapshot
  hookWarning?: HookWarningSink
  hookReloadScope?: HookReloadScope
  toolHookPolicy?: () => import('../types.js').ToolPermissionContext
  signal: AbortSignal
  confirm?: ConfirmTool
  onRuntime?: (event: Record<string, unknown>) => void
  onTokens: (tokens: number) => void
  retry?: RetryOptions
  /** The parent session's outputs; without it the agent records into `store`'s session. */
  outputs?: OutputLedger
  /** How a failed or stopped agent ended: why, and what it had written so far. Scripts get null or a throw; the run keeps this. */
  onEnded?: (reason: string, text?: string) => void
}
/**
 * LSP for a read-only agent: its format action rewrites the file and its diagnostics start the
 * project's own programs, so they are refused in every mode, never asked. The agent copies the
 * session's mode, and acceptEdits, auto and bypass would allow them.
 * Only the permission check changes, so the tool's definition stays the same.
 */
function readOnlyLSP(tool: Tool): Tool {
  return {
    ...tool,
    checkPermissions: (input: unknown, toolContext: ToolUseContext) => {
      const refusal = lspReadOnlyRefusal(input, 'A read-only workflow agent')
      return refusal ? Promise.resolve<PermissionResult>({ decision: 'deny', reason: refusal }) : tool.checkPermissions(input, toolContext)
    },
  }
}

export async function executeAgent(prompt: string, options: AgentOptions, context: AgentContext): Promise<unknown> {
  const effort = options.effort ?? context.store.getState().effort ?? 'medium'
  if (!EFFORTS.includes(effort)) throw new Error(`Invalid workflow effort: ${effort}`)
  const store = createAppStore(undefined, context.store.getState().cwd)
  const label = options.label === undefined ? undefined : escapeDisplayControls(truncateCodePoints(options.label, 200))
  const phase = options.phase === undefined ? undefined : escapeDisplayControls(truncateCodePoints(options.phase, 200))
  const origin: ApprovalOrigin = { kind: 'workflow', label: [label ?? context.agentId, phase].filter(Boolean).join(' · '), runId: context.runId, agentId: context.agentId }
  store.setState(() => ({ effort, permissionContext: { ...context.store.getState().permissionContext } }))
  const limited = limitClient(context.client, context.provider, 'workflow')
  const client: LLMClient = {
    maxOutputTokens: limited.maxOutputTokens,
    visionCapabilities: limited.visionCapabilities?.bind(limited),
    modelIdentity: limited.modelIdentity?.bind(limited),
    contextWindow: limited.contextWindow,
    managedLocal: limited.managedLocal,
    budgetLocal: limited.budgetLocal,
    refreshContextWindow: limited.refreshContextWindow?.bind(limited),
    countTokens: limited.countTokens?.bind(limited),
    async chat(request) { const response = await limited.chat(request); context.onTokens(response.usage.outputTokens); return response },
    async *chatStream(request) {
      let lastOutput = 0
      try {
        for await (const event of streamWithRetry(limited, request, context.retry)) {
          if (event.type === 'usage') lastOutput = event.usage.outputTokens
          yield event
        }
      } finally { context.onTokens(lastOutput) }
    },
  }
  const engine = new QueryEngine({
    isHeadless: context.isHeadless, onPermissionDenial: context.onPermissionDenial,
    client, store, model: context.model, usageStore: context.store,
    tools: context.tools.filter(tool => isSubAgentTool(tool.name) && tool.name !== 'Workflow' && (!options.readOnly || PLAN_TOOLS.has(tool.name)))
      .map(tool => options.readOnly && tool.name === 'LSP' ? readOnlyLSP(tool) : tool),
    persist: false, sessionMemory: false, includeSessionMemory: false,
    // Project hooks keep the parent's live authority and the run's fixed definitions.
    toolHookPolicy: context.toolHookPolicy ?? (() => context.store.getState().permissionContext),
    hookSnapshot: context.hooks,
    hookWarning: context.hookWarning,
    hookReloadScope: context.hookReloadScope,
    skipQueryHooks: true, streaming: true, maxIterations: context.maxIterations ?? 100,
    // Without a host that can ask, there is no handler: a refusal then reads "approval was not available".
    onGateConfirm: context.confirm && ((name, reason, input, request) => context.confirm!(name, reason, input, { ...request, runId: context.runId, agentId: context.agentId, origin })),
    onRuntime: event => context.onRuntime?.({ ...event, runId: context.runId, agentId: context.agentId, label, phase }),
    // Changed files go to the parent session's outputs and snapshot folder, never to this throw-away store.
    outputs: context.outputs ?? { sessionId: context.store.getState().sessionId, store: context.store },
  })
  const abort = () => engine.abort()
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    context.signal.throwIfAborted()
    const schema = options.schema && schemaValidator(options.schema)
    let query = schema ? `${prompt}\n\nReturn your final answer as one JSON object matching this JSON Schema, without prose:\n${JSON.stringify(options.schema)}` : prompt
    for (let attempt = 0; attempt <= 3; attempt++) {
      const result = await engine.submitQuery(query)
      if (context.signal.aborted) return null
      if (!schema) return result.response
      let error: string
      try {
        const object = lastJSONObject(result.response)
        if (schema.validate(object)) return object
        error = schema.errors()
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
      if (attempt === 3) throw new Error(`Structured output failed after 3 corrections: ${error}`)
      query = `Your last JSON object failed validation: ${error}\nCorrect it and return only the complete JSON object matching the original schema.`
    }
  } catch (error) {
    context.onEnded?.(error instanceof Error ? error.message : String(error), engine.failedTurn?.text)
    if (context.signal.aborted || error instanceof APIError && !error.retryable) return null
    throw error
  } finally { context.signal.removeEventListener('abort', abort) }
}
