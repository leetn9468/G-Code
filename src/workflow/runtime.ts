import { createHookWarningReporter, loadHookSnapshot, type HookSnapshot, type HookWarningSink, type HookReloadScope } from '../engine/hooks.js'
import { randomUUID } from 'node:crypto'
import type { Store } from '../state/store.js'
import type { AppState } from '../types.js'
import type { LLMClient } from '../llm/types.js'
import { createLLMClient, type ProviderName } from '../llm/provider.js'
import type { Tool, ConfirmTool } from '../tools/tool.js'
import { runSandbox, type SandboxOptions } from './sandbox.js'
import { executeAgent, type AgentOptions } from './agent.js'
import { boundedJSON, truncateCodePoints, workflowReport, type AgentEnd, type AgentFailure, type WorkflowEvent, type WorkflowReport, type WorkflowStatus } from './events.js'
import { EFFORTS } from '../shared/sessionControls.js'
import { schemaValidator } from './structured.js'
import type { RetryOptions } from '../llm/retry.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import type { OutputLedger } from '../engine/queryEngine.js'

const display = (text: string, limit: number) => escapeDisplayControls(truncateCodePoints(text, limit))

export interface WorkflowRuntimeOptions {
  runId?: string
  client: LLMClient
  provider: ProviderName
  model?: string
  store: Store<AppState>
  tools: ReadonlyArray<Tool>
  isHeadless?: boolean
  onPermissionDenial?: (denial: import('../shared/permissionRules.js').PermissionDenial) => void
  hookSnapshot?: HookSnapshot
  hookWarning?: HookWarningSink
  hookReloadScope?: HookReloadScope
  toolHookPolicy?: () => import('../types.js').ToolPermissionContext
  maxIterations?: number
  maxAgents?: number
  confirm?: ConfirmTool
  onEvent?: (event: WorkflowEvent) => void
  onRuntime?: (event: Record<string, unknown>) => void
  /** Where the agents record the files they change; defaults to `store`'s own session. */
  outputs?: OutputLedger
  createClient?: typeof createLLMClient
  retry?: RetryOptions
}
export interface WorkflowResult { runId: string; status: WorkflowStatus; value: unknown; error?: string; tokens: number; report?: WorkflowReport }
export class WorkflowRuntime {
  readonly runId: string
  status: WorkflowStatus = 'running'
  tokens = 0
  private controller = new AbortController()
  private agents = new Map<string, { controller: AbortController; tokens: number; options: AgentOptions }>()
  private pending = new Set<Promise<unknown>>()
  private clients = new Map<string, LLMClient>()
  private count = 0
  private fatalError?: Error
  private started = false
  private hooks?: HookSnapshot
  private hookWarning: HookWarningSink
  private phaseTitle?: string
  private phases = new Set<string>()
  /** Why agents failed, whatever the script did with their null or their throw. */
  private failures: AgentFailure[] = []
  /** Each agent's end, for a run that does not complete: a script's own record dies with its worker. */
  private ends: AgentEnd[] = []
  private contextLost = new Set<string>()
  /** The files the run's agents changed, by path; true when deleted. */
  private changed = new Map<string, boolean>()
  private outputs: OutputLedger
  constructor(private options: WorkflowRuntimeOptions) {
    if (options.maxAgents !== undefined && (!Number.isSafeInteger(options.maxAgents) || options.maxAgents < 1 || options.maxAgents > 10000)) throw new Error('maxAgents must be between 1 and 10000')
    this.runId = options.runId ?? randomUUID()
    this.hooks = options.hookSnapshot
    this.hookWarning = options.hookWarning ?? createHookWarningReporter(options.onRuntime)
    // As the Agent tool does: the same outputs, and a note of which files this run's agents changed.
    const ledger = options.outputs ?? { sessionId: options.store.getState().sessionId, store: options.store }
    this.outputs = { ...ledger, store: {
      getState: () => ledger.store.getState(),
      subscribe: listener => ledger.store.subscribe(listener),
      setState: updater => ledger.store.setState(state => {
        const next = updater(state)
        for (const output of next.outputs ?? []) if (!state.outputs?.includes(output)) this.changed.set(output.path, !!output.deleted)
        return next
      }),
    } }
  }
  private snapshotHooks(): HookSnapshot { return this.hooks ??= loadHookSnapshot(this.options.store.getState().cwd) }
  stop(): void { this.controller.abort(); for (const agent of this.agents.values()) agent.controller.abort() }
  skip(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent || agent.controller.signal.aborted) return false
    agent.controller.abort()
    return true
  }
  private state(id: string, label: string, status: WorkflowStatus, detail?: string, tokens?: number, kind: 'run' | 'agent' | 'phase' = 'agent'): void {
    this.options.onEvent?.({ type: 'workflow-state', runId: this.runId, node: { id, parentId: kind === 'run' ? null : this.runId, kind, label: display(label, 200), status, detail: detail === undefined ? undefined : display(detail, 2000), tokens } })
  }
  agent(prompt: string, options: AgentOptions | null = {}, defaultPhase: string | null | undefined = this.phaseTitle): Promise<unknown> {
    options ??= {}
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('agent prompt must be a nonempty string')
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('agent options must be an object')
    for (const key of ['label', 'phase'] as const) {
      const value = options[key]
      if (value != null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`agent ${key} must be a string or finite number`)
    }
    if (options.effort != null && !EFFORTS.includes(options.effort)) throw new Error('Invalid workflow effort')
    if (options.readOnly != null && typeof options.readOnly !== 'boolean') throw new Error('agent readOnly must be boolean')
    if (options.schema != null) schemaValidator(options.schema)
    if (options.model != null) {
      if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('Invalid model override')
      const [provider, model] = options.model.includes('/') ? options.model.split('/') : [this.options.provider, options.model]
      if (!['anthropic','openai','gemini','deepseek','qwen','ollama','local'].includes(provider!) || !model) throw new Error('Invalid provider/model override')
      if (this.options.provider === 'local' || provider === 'local') throw new Error('local provider does not support model overrides')
    }
    if (++this.count > (this.options.maxAgents ?? 1000)) {
      this.fatalError ??= new Error(`Workflow exceeds ${this.options.maxAgents ?? 1000} agents per run`)
      this.stop()
      throw this.fatalError
    }
    const hooks = this.snapshotHooks()
    const agentId = `agent-${this.count}`
    const controller = new AbortController()
    const record = { controller, tokens: 0, options: { ...options, label: String(options.label ?? agentId), phase: options.phase == null ? (defaultPhase == null ? undefined : truncateCodePoints(defaultPhase, 200)) : String(options.phase) } }
    this.agents.set(agentId, record)
    if (this.controller.signal.aborted) controller.abort()
    let reason: string | undefined, partial: string | undefined
    const task = (async () => {
      try {
        this.state(agentId, record.options.label, 'running')
        if (controller.signal.aborted) return null
        let provider = this.options.provider, model = this.options.model, client = this.options.client
        if (options.model != null) {
          if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('Invalid model override')
          const slash = options.model.indexOf('/')
          provider = slash < 0 ? provider : options.model.slice(0, slash) as ProviderName
          model = slash < 0 ? options.model : options.model.slice(slash + 1)
          if (!['anthropic','openai','gemini','deepseek','qwen','ollama','local'].includes(provider) || !model) throw new Error('Invalid provider/model override')
          if (this.options.provider === 'local' || provider === 'local') throw new Error('local provider does not support model overrides')
          if (provider !== this.options.provider) {
            const key = `${provider}/${model}`
            client = this.clients.get(key) ?? (this.options.createClient ?? createLLMClient)(provider, model)
            this.clients.set(key, client)
          }
        }
        const value = await executeAgent(prompt, record.options, {
          ...this.options, hooks, hookWarning: this.hookWarning,
          hookReloadScope: this.options.hookReloadScope ?? (this.options.hookSnapshot === undefined ? `run:${this.runId}` : 'turn'),
          runId: this.runId, agentId, client, provider, model, signal: controller.signal, outputs: this.outputs,
          onEnded: (why, text) => { reason = why; partial = text },
          onRuntime: event => {
            this.options.onRuntime?.(event)
            if (typeof event.contextLost === 'string') this.contextLost.add(record.options.label)
            if (event.type === 'tool-state') this.options.onEvent?.({ type: 'workflow-state', runId: this.runId, node: {
              id: `${agentId}/${event.id}`, parentId: agentId, kind: 'tool', label: display(String(event.name), 200),
              status: event.state === 'complete' ? 'complete' : event.state === 'cancelled' ? 'skipped' : ['failed', 'denied', 'refused'].includes(String(event.state)) ? 'failed' : 'running',
              detail: display(String(event.detail ?? event.error ?? event.state), 2000),
              ...(event.state === 'awaiting_approval' ? { awaitingApproval: true as const } : {}),
            } })
          },
          onTokens: tokens => {
            record.tokens += tokens; this.tokens += tokens
            this.state(agentId, record.options.label, 'running', undefined, record.tokens)
            this.state(this.runId, 'Workflow', 'running', undefined, this.tokens, 'run')
          },
        })
        const status = controller.signal.aborted ? 'skipped' : value === null ? 'failed' : 'complete'
        this.state(agentId, record.options.label, status, status === 'failed' ? reason : undefined, record.tokens)
        if (status === 'failed') this.failures.push({ label: record.options.label, reason: reason ?? 'The agent ended without a result.' })
        this.ends.push({ label: record.options.label, status, ...(status === 'failed' ? { reason } : {}), text: status === 'complete' ? typeof value === 'string' ? value : JSON.stringify(value) : partial })
        return value
      } catch (error) {
        const stopped = controller.signal.aborted
        this.state(agentId, record.options.label, stopped ? 'skipped' : 'failed', String(error), record.tokens)
        const why = error instanceof Error ? error.message : String(error)
        if (!stopped) this.failures.push({ label: record.options.label, reason: why })
        this.ends.push({ label: record.options.label, status: stopped ? 'skipped' : 'failed', ...(stopped ? {} : { reason: why }), text: partial })
        if (stopped) return null
        throw error
      } finally { this.agents.delete(agentId) }
    })()
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => {})
    return task
  }
  async run(script: string, args?: unknown, sandbox: Omit<SandboxOptions, 'onCall' | 'args'> = {}): Promise<WorkflowResult> {
    if (this.started) throw new Error('Workflow runtime can only run once')
    this.started = true
    const abort = () => this.stop()
    sandbox.signal?.addEventListener('abort', abort, { once: true })
    if (sandbox.signal?.aborted) this.stop()
    let value: unknown = null, error: string | undefined
    try {
      this.snapshotHooks()
      this.state(this.runId, 'Workflow', 'running', undefined, 0, 'run')
      value = await runSandbox(script, { ...sandbox, args, signal: this.controller.signal, onCall: (method, values) => {
        if (method === 'agent') {
          try { return this.agent(values[0] as string, values[1] as AgentOptions, typeof values[2] === 'string' ? values[2] : null) }
          catch (invalid) {
            // Refused before it started: parallel and pipeline turn the throw into null, so the reason is kept here too.
            // The script's own value: a label that cannot become text is one reason to be here.
            const label = values[1] && typeof values[1] === 'object' ? (values[1] as AgentOptions).label : undefined
            this.failures.push({ label: typeof label === 'string' || typeof label === 'number' ? String(label) : 'agent', reason: invalid instanceof Error ? invalid.message : String(invalid) })
            throw invalid
          }
        }
        if (method === 'agentFailures') return this.failures.map(failure => ({ ...failure }))
        if (method === 'phase') {
          this.phaseTitle = truncateCodePoints(String(values[0]), 200)
          this.phases.add(this.phaseTitle)
          this.state(`phase-${this.phaseTitle}`, this.phaseTitle, 'running', undefined, undefined, 'phase')
        } else if (method === 'log') this.state(this.runId, 'Workflow', 'running', truncateCodePoints(String(values[0]), 2000), this.tokens, 'run')
        else throw new Error(`Unknown workflow API: ${method}`)
        return null
      } })
      if (this.fatalError) throw this.fatalError
      this.status = this.controller.signal.aborted ? 'stopped' : 'complete'
    } catch (failure) {
      error = this.fatalError?.message ?? (failure instanceof Error ? failure.message : String(failure))
      this.status = this.fatalError ? 'failed' : this.controller.signal.aborted ? 'stopped' : 'failed'
    } finally {
      // Unawaited calls belong to this run too; never leave orphan engines.
      this.stop()
      await Promise.allSettled([...this.pending])
      sandbox.signal?.removeEventListener('abort', abort)
    }
    for (const title of this.phases) this.state(`phase-${title}`, title, this.status, undefined, undefined, 'phase')
    const report = workflowReport({ status: this.status, failures: this.failures, ends: this.ends, agents: this.count, changed: this.changed, contextLost: this.contextLost, cwd: this.options.store.getState().cwd })
    this.state(this.runId, 'Workflow', this.status, error ?? report.agentFailures?.note, this.tokens, 'run')
    this.options.onEvent?.({ type: 'workflow-done', runId: this.runId, status: this.status, summary: boundedJSON(error ? { error } : report.agentFailures ? { result: value, agentFailures: report.agentFailures } : value) })
    return { runId: this.runId, status: this.status, value, error, tokens: this.tokens, ...(Object.keys(report).length ? { report } : {}) }
  }
}
