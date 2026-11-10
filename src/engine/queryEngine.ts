import { disableAdvice } from '../mcp/surface.js'
import { currentGuard, NetworkStopped } from '../security/guard.js'
import { guardClient } from '../security/client.js'
import { BudgetReached, budgetClient, sessionBudgetController, type BudgetController } from '../session/budget.js'
import { budgetPrice, budgetSpent, budgetWriterRemaining, moneyLabel, MONEY_SCALE } from '../shared/sessionBudget.js'
import { toolResultText, estimateMessages, estimateImageTokens, withImageBudget } from '../llm/images.js'
import { APIError, STREAM_RETRIES, explainNetworkFailure, isReplayableStreamError, replayDelay, retryStream, retryStatus, sleep } from '../llm/retry.js'
import { StreamIdleTimeoutError } from '../llm/streamIdle.js'
import { oneShot } from '../llm/oneShot.js'
import { recoverRejectedRequest } from '../llm/recovery.js'
import { replyEnd, replyEndWords } from '../llm/replyEnd.js'
import { isPromptTooLongError, parsePromptTooLongTokenCounts } from '../utils/errorParsing.js'
import { EFFORTS, REPLY_RESERVE, type ContextStatus, type Effort } from '../shared/sessionControls.js'
import { ContextHandoff, fallbackHandoff, saveHandoff, writeHandoff } from '../session/handoff.js'
import { MIN_LEARNED_LIMIT, tokenCalibration, type TokenCalibration } from '../shared/tokenCalibration.js'
import type { ContextFullChoice, ContextFullInfo } from '../shared/execution.js'
import { continuationStalls } from '../shared/execution.js'
import { getTodos } from '../tools/impl/TodoWriteTool.js'
import { maxModelOutput, outputPlan, raisedOutput } from '../shared/outputLimits.js'
import { summarizeContext } from '../session/compact.js'
import { SNAPSHOT_FILES, baselineStillCurrent, captureBaseline, commandListing, commandOutputs, createdArtifact, generatedFolder, listedBaseline, outputKey, outputRecord, releaseDroppedSnapshots, projectSnapshot, rememberProjectContent } from '../session/outputs.js'
import { maskSecrets } from '../security/secretValues.js'
import { assertSessionOwner, saveSession, trackPendingTurn, wirePreview, type PendingTurn } from '../state/store.js'
import { trackUsage } from '../session/usage.js'
import { appendUsage, emptyUsage } from '../shared/usageTotals.js'
import { mergeToolProgress, terminalTool, type ReplyRestartEvent, type SteerEvent, type ToolPhase } from '../shared/runtimeEvents.js'
import { canonicalJSON, sha256 } from '../utils/hash.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import type { SessionOutput } from '../shared/sessionControls.js'
/**
 * @file queryEngine.ts
 * @brief Core agent loop: input → LLM (streaming) → tool_use → execute → loop
 *
 * Uses streaming for real-time text output. Collects tool_use blocks from
 * the stream, executes them, and feeds results back for the next iteration.
 */

import type {
  LLMClient,
  LLMMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  TextBlock,
  TokenCount,
} from '../llm/types.js'
import type { ConfirmTool, Tool } from '../tools/tool.js'
import type { ToolUseContext } from '../tools/tool.js'
import { createReadFileState, invalidateFileReadDedup } from '../tools/impl/FileReadTool.js'
import type { Store } from '../state/store.js'
import type { AppState, SessionContext } from '../types.js'
import { nodeEnvironment, nodeEnvironmentPrompt } from '../runtime/node.js'
import { CONTEXT_CLOSE, buildStableSystemPrompt, buildTurnContext, formatStandingMemory, withTurnContext, type TurnInvocation } from './systemPrompt.js'
import { headUnits, tailUnits } from '../utils/textUnits.js'
import { jsonFaultAt } from '../utils/jsonFault.js'
import { loadProjectMemory } from '../memory/projectMemory.js'
import { readTeamMemory } from '../memory/teamMemory.js'
import { invalidateTurnResults, runTools, type CallOutcomeState } from './toolRunner.js'
import { PLAN_TOOLS } from '../tools/permissions.js'
import { MAIN_CONVERSATION_BUDGET, TurnFailureBudget, repeatNote, type FailureBudgetLimits } from './failureBudget.js'
import { DEFERRED_CALL, DeferredToolCallTool, deferredCallDescription, deferredView, toolJsonSchema } from '../tools/impl/DeferredToolCallTool.js'
import { CORE_TOOLS, defersTools } from '../tools/toolLoading.js'
import { contextBudget, effectiveContextWindow, type ContextWindow } from './contextBudget.js'
import {
  COMPACTION_THRESHOLD,
  calculateContextBudget,
  contextLimitSource,
  conversationTokens,
  getContextLimit,
  initialTokenScale,
  localTokenEstimate,
  roughTokenCount,
} from './context.js'
import { EMPTY_REPLY, HANDOFF_READ, INCOMPLETE_TURN, clearOldToolResults, compactTurn } from './compact.js'
import { microcompactMessages, fitImages } from './microcompact.js'

/** Share of the window a mid-turn compaction aims for (the check triggers at 85%). */
const COMPACTION_TARGET = 0.6
/** The most of the context window the check keeps free for the reply (see replyReserve). */
const RESERVE_SHARE = 0.15
/** Compactions in one turn before the user is asked again. */
const MAX_TURN_COMPACTIONS = 8
/**
 * Compactions in a row with no progress between them (no new tool call succeeded, no file changed)
 * before the turn stops when nobody can be asked, or the user is asked again. A turn that keeps
 * making progress compacts as often as it needs to. A call repeated with the same input is not new:
 * a turn that keeps re-reading the same file is not getting anywhere.
 */
const MAX_STALLED_COMPACTIONS = 2
/**
 * A reply that shows nothing for `after` ms (long reasoning at a high effort can run for minutes
 * with no visible output) gets a status line saying the model is still working, again every
 * `every` ms, so a silent wait does not look like a hang. Exported for tests.
 */
export const HEARTBEAT = { after: 20_000, every: 15_000 }
/** 45s · 1m 05s · 12m 00s */
const elapsedLabel = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}
/**
 * The reply before a handoff that reads the latest results (see readBeforeHandoff): the smallest
 * output cap worth sending, and the room its note takes. Its cap is what an ordinary reply at the
 * session's effort sends (within the room left), so its reasoning has the same room (a fixed 4,096
 * cut a note mid-sentence after 2,726 tokens of reasoning at High).
 */
const HANDOFF_READ_MIN_TOKENS = 1024
const HANDOFF_READ_NOTE_TOKENS = 256
/** Room kept when the input size is only estimated (it can come out 2.3% low), so the reply before a handoff still fits. */
const HANDOFF_READ_ESTIMATE_MARGIN = 0.05
const HANDOFF_READ_NOTE = `[${HANDOFF_READ}, so this session hands off to a new session after this reply. Read the tool results above and write down what they show that the remaining work needs: the facts, with paths and line ranges, and what is still missing. Do not call any tools in this reply.]`
/** A managed local model's check: the reply room it keeps (its max_tokens is capped separately) and its safety margin. */
const LOCAL_CHECK_OUTPUT_TOKENS = 2048
const LOCAL_SAFETY_TOKENS = 1024
/** Tool calls in one turn the output limit may cut off at the largest budget before the turn stops. */
const MAX_CEILING_CUTOFFS = 3
/**
 * Replies in a row with a tool call whose arguments are not valid JSON before the turn stops. Each
 * such call is answered with an INVALID_JSON error so the model can redo it; a main conversation has
 * no step limit, so without this a model that keeps sending them is billed one request after another.
 */
const MAX_INVALID_JSON_REPLIES = 3
/**
 * A reply that fails after it began streaming (an overload, a server error or rate limit inside the
 * stream, a dropped connection, an idle stall) is discarded and requested again, at most `perReply`
 * times for one reply and `perTurn` times in a turn, after a backoff from `baseDelayMs`. No tool
 * runs until a reply has ended, so a replay re-runs nothing. Exported for tests.
 */
export const REPLAY = { perReply: 2, perTurn: 4, baseDelayMs: 1000 }
/** How the model is told of a message the user sent while the turn ran. */
const STEER_PREFIX = '[The user sent this while you were working:]'
/**
 * A request is measured exactly (the local runtime's tokenizer; the full calibrated estimate on
 * the cloud) when the estimate anchored on the last reply's reported usage is within this share of
 * the window of a decision: the compaction threshold, or the reply room a local window leaves.
 */
const EXACT_COUNT_MARGIN = 0.1
/** Pressure clearing avoids a compaction only when it leaves the request this far under the threshold. */
const CLEAR_MARGIN = 0.1
import { HookFailedError, createHookWarningReporter, loadHookSnapshot, runHooks, type HookType, type HookSnapshot, type HookWarningSink, type HookReloadScope } from './hooks.js'
import { BashTool } from '../tools/impl/BashTool.js'
import { takeEndedNotices, withEndedTasks } from '../tools/backgroundShells.js'
import {
  initSessionMemory,
  extractMemories,
  completeMemoryTurn,
  persistSessionMemory,
  saveSessionMemory,
  noteOutputChanges,
  noteToolOutcome,
  sessionMemoryLines,
  compactSessionMemory,
} from '../memory/sessionMemory.js'
import { formatLearnedPatterns, notePatternOutcome, readLearnedPatterns, saveLearnedPatterns } from '../memory/learnedPatterns.js'
import { TEAM_MEMORY_TOOL } from '../tools/impl/TeamMemoryWriteTool.js'
import { teamMemoryFile } from '../memory/teamMemory.js'

/** The file a TeamMemoryWrite call writes (relative to the project), for its Changes record. */
function teamMemoryTarget(cwd: string, input: unknown): string | undefined {
  const topic = input && typeof input === 'object' ? (input as { topic?: unknown }).topic : undefined
  return typeof topic === 'string' && topic.trim() ? teamMemoryFile(cwd, topic) : undefined
}
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ============================================================================
// Configuration
// ============================================================================

const activeEngines = new Set<QueryEngine>()
const querySettlements = new Map<QueryEngine, Promise<void>>()
const budgetWriterSettlements = new Map<QueryEngine, Promise<void>>()
/** Tool state changes within this long share one session save (each save rewrites the whole file). */
const SAVE_DELAY_MS = 250

/** Cancel pending model requests and tools before the CLI shuts down. */
export function abortActiveQueries(): void {
  // The process is closing. A caller that knows more (a user's Ctrl-C) names the cause itself.
  for (const engine of new Set([...activeEngines, ...budgetWriterSettlements.keys()])) engine.abort({ by: 'shutdown' }, false)
}

/** Why a running turn was cancelled: the user stopped it, or the session closed under it. */
export type AbortCause = { by: 'user' } | { by: 'shutdown'; signal?: string }

/** Give cancellation a bounded chance to record completed work before CLI exit. */
export async function settleActiveQueries(timeoutMs = 1500, options: { writersOnly?: boolean } = {}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.all([...(options.writersOnly ? [] : querySettlements.values()), ...budgetWriterSettlements.values()]).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

export interface QueryEngineOptions {
  client: LLMClient
  tools: ReadonlyArray<Tool<unknown, unknown>>
  store: Store<AppState>
  /** Charge child and workflow requests to their parent session. */
  usageStore?: Store<AppState>
  model?: string
  /** Calibration carried by a parent handoff; the next session persists it before its first request. */
  calibration?: TokenCalibration
  verbose?: boolean
  streaming?: boolean
  isHeadless?: boolean
  allowWorkflow?: boolean
  onPermissionDenial?: (denial: import('../shared/permissionRules.js').PermissionDenial) => void
  skipQueryHooks?: boolean
  hookSnapshot?: HookSnapshot
  hookWarning?: HookWarningSink
  hookReloadScope?: HookReloadScope
  /** Project-authored tool hooks use the parent authority, independently of model tools. */
  toolHookPolicy?: () => import('../types.js').ToolPermissionContext
  sessionMemory?: boolean
  /** Show the session's memory entries to the model (in each turn's context block). Defaults to `sessionMemory`. */
  includeSessionMemory?: boolean
  /** false: never write this store's session file (sub-agents keep their history in memory). */
  persist?: boolean
  /** Explicit child limit (sub-agents, workflows). A main conversation has none. */
  maxIterations?: number
  /** Asked when the context window fills mid-turn. Without it the conversation is compacted automatically. */
  onContextFull?: (info: ContextFullInfo, signal: AbortSignal) => Promise<ContextFullChoice>
  /** Limits for each turn's failed/denied tool budget. Without it and without maxIterations (a main conversation) there is no call cap and failures count in a row. */
  failureBudget?: FailureBudgetLimits
  onRuntime?: (event: Record<string, unknown>) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  onToolStart?: (name: string, id: string, input: Record<string, unknown>) => void
  onToolEnd?: (name: string, id: string, result: string, isError: boolean) => void
  onGateConfirm?: ConfirmTool
  /**
   * Record the files this engine's tools change into another session's outputs (a child engine's
   * parent). Defaults to `usageStore`'s session when this engine is not saved (`persist: false`).
   */
  outputs?: OutputLedger
}

/**
 * The outputs list (the Changes view) and snapshot folder that file changes are recorded into. A
 * sub-agent or workflow agent passes its parent's, so its baselines and versions are the session's.
 */
export interface OutputLedger {
  /** Names the snapshot folder: .gcode/outputs/<sha256(sessionId)>. */
  sessionId: string
  store: Store<AppState>
  /** After this engine changed `store`'s outputs: the owner saves the session and reports them. */
  changed?: () => void
}

/**
 * For each session store, how the engine that owns it saves and reports its outputs. A child engine
 * that records into that store (an Agent sub-agent) calls it, so the Changes view updates live.
 */
const outputReporters = new WeakMap<Store<AppState>, () => void>()
/** Workflow children may run before their parent has frozen a prompt. Share the
 * environment measurement by owning session, without caching across sessions. */
const sessionNodeInfo = new WeakMap<Store<AppState>, { sessionId: string; cwd: string; value: string }>()

export interface QueryResult {
  response: string
  toolCallCount: number
  iterations: number
}

// ============================================================================
// Query Engine
// ============================================================================

export class QueryEngine {
  private client: LLMClient
  private writerClient!: LLMClient
  private budget!: BudgetController
  private tools: ReadonlyArray<Tool<unknown, unknown>>
  private store: Store<AppState>
  private model: string
  private verbose: boolean
  private streaming: boolean
  private isHeadless: boolean
  private allowWorkflow: boolean
  private skipQueryHooks: boolean
  private hookSnapshot?: HookSnapshot
  private hookWarning?: HookWarningSink
  private hookReloadScope: HookReloadScope
  private onPermissionDenial?: QueryEngineOptions['onPermissionDenial']
  private toolHookPolicy?: QueryEngineOptions['toolHookPolicy']
  private sessionMemory: boolean
  private includeSessionMemory: boolean
  private persist: boolean
  private maxIterations: number
  private configuredMaxIterations?: number
  private failureBudget?: FailureBudgetLimits
  // Per-engine FileRead dedup/freshness: concurrent agents must each see file contents.
  private readFileState = createReadFileState()
  private onRuntime?: (event: Record<string, unknown>) => void
  private lastSystem = ''
  /** What the system prompt carries (see systemPrompt()). */
  private snapshot: NonNullable<AppState['promptSnapshot']> | null = null
  private nodeInfo?: string
  private nodeInfoOwner: Store<AppState>
  /** Provider tokens per estimated token. A new session starts from the model family's typical ratio (initialTokenScale). */
  private usageScale = 1
  /** Whether usageScale was learned from provider usage (this session's, or saved with it). */
  private scaleCalibrated = false
  /** usageScale starts from the saved session's calibration, read on first use. */
  private scaleSeeded = false
  private requestEstimate = 0
  /** The image tokens in requestEstimate: estimated by the provider's own formula, never scaled. */
  private requestImages = 0
  private lastToolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = []
  private onText?: (text: string) => void
  private onThinking?: (text: string) => void
  private onToolStart?: (name: string, id: string, input: Record<string, unknown>) => void
  private onToolEnd?: (name: string, id: string, result: string, isError: boolean) => void
  private onGateConfirm?: ConfirmTool
  private onContextFull?: QueryEngineOptions['onContextFull']
  private outputLedger?: OutputLedger
  /** Names this engine's writes in the project's write journal: a sibling agent's command must not take them for its own (see commandOutputs). */
  private readonly writer = randomUUID()
  private toolIds = new Map<string, string>()
  private aborted = false
  private abortCause: AbortCause | undefined
  /** The cause came from the caller, not from a generic shutdown path. */
  private abortCauseExplicit = false
  /** A new model round started; its first text is separated from the turn's earlier text. */
  private roundStart = false
  /** Text has been shown in this turn. */
  private turnHasText = false
  private abortController: AbortController | null = null
  /**
   * The running turn as a stop or a save records it. `tools` holds each call's last known outcome,
   * including calls that never ran (refused, denied, cut off, arguments not valid JSON); `ran` is
   * set once a call (or a project hook) reached execution, so its effects may exist.
   */
  /**
   * The running turn, for a save or a stop: `ran` (a call reached execution: there are results to
   * resume from), `mutating` (one that can change something did), and its unfinished FileWrite transfers.
   */
  /** The skills and MCP prompts the running turn's message ran (its context block carries them). */
  private turnInvocations: ReadonlyArray<TurnInvocation> = []
  /** The Changes notice for a project past the listing cap goes out once. */
  private toldListingCap = false
  private partialTurn: { input: string; text: string; tools: Map<string, string>; ran: boolean; mutating: boolean; startedAt: number; wire: LLMMessage[]; transfers?: Map<string, OpenTransfer>; steers: Array<{ text: string; at: number }> } | null = null
  /** Rounds of the running turn so far; with `failedTurn`, what a sub-agent's parent reports when it fails. */
  private turnIterations = 0
  private lastFailure: { text: string; iterations: number } | undefined
  /** Removes the running turn from the session's saves (see PendingTurn); set while a turn runs. */
  private untrackTurn?: () => void
  /** Told once that session notes could not be saved; a save that works again re-arms it. */
  private memorySaveWarned = false
  /** A save waiting to run (see saveSoon). */
  private saveTimer?: ReturnType<typeof setTimeout>
  /** Files already reported as holding a key (see sayNotKept). */
  private toldNotKept = new Set<string>()
  /** The context window of the running turn; the budget setting is read once per turn. */
  private turnWindow: ContextWindow | null = null
  /** Replies of the running turn replayed after a mid-stream failure (see REPLAY). */
  private turnReplays = 0
  /**
   * User messages sent while the turn runs (see steer): added to the conversation after the next
   * tool batch, or handed back when the turn ends first. `returned` runs it as a turn of its own.
   */
  private steers: Array<{ id: string; text: string; returned?: (text: string) => void }> = []
  /**
   * The tools this session does not send in full (deferred tool loading, see toolLoading.ts): the
   * model reaches them through ToolSearch and DeferredToolCall. Fixed with the prompt snapshot.
   */
  private deferredTools: ReadonlySet<string> = new Set()
  /** The provider kind, for the 'auto' tool loading mode (Ollama defers). */
  private provider?: string
  /** A child engine's parent session froze its tools in this mode; the child follows it. */
  private parentDefers?: boolean

  constructor(options: QueryEngineOptions) {
    this.client = options.client
    // A connection arriving during a turn becomes available in the next session.
    this.tools = [...options.tools]
    this.store = options.store
    this.nodeInfoOwner = options.usageStore ?? options.store
    this.model = options.model ?? this.client.modelIdentity?.('')?.model ?? ''
    const inherited = tokenCalibration(options.calibration, this.model)
    if (inherited && !this.store.getState().contextCalibration) this.store.setState(() => ({ contextCalibration: inherited }))
    this.verbose = options.verbose ?? false
    this.streaming = options.streaming ?? true
    this.isHeadless = options.isHeadless ?? false
    this.allowWorkflow = options.allowWorkflow ?? false
    this.skipQueryHooks = options.skipQueryHooks ?? false
    this.hookSnapshot = options.hookSnapshot
    this.hookWarning = options.hookWarning
    this.hookReloadScope = options.hookReloadScope ?? (this.isHeadless ? 'headless' : 'turn')
    this.toolHookPolicy = options.toolHookPolicy
    this.onPermissionDenial = options.onPermissionDenial
    this.sessionMemory = options.sessionMemory ?? true
    this.includeSessionMemory = options.includeSessionMemory ?? this.sessionMemory
    this.persist = options.persist ?? true
    this.configuredMaxIterations = options.maxIterations
    if (options.maxIterations !== undefined && (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1)) throw new Error('maxIterations must be a positive integer')
    this.maxIterations = options.maxIterations ?? Infinity
    // Sub-agents and workflows pass maxIterations and keep the default per-turn call cap.
    this.failureBudget = options.failureBudget ?? (options.maxIterations === undefined ? MAIN_CONVERSATION_BUDGET : undefined)
    this.onRuntime = options.onRuntime
    this.onText = options.onText
    this.onThinking = options.onThinking
    this.onToolStart = options.onToolStart
    this.onToolEnd = options.onToolEnd
    this.onGateConfirm = options.onGateConfirm
    this.onContextFull = options.onContextFull
    // A child engine (it charges its parent's usage and is never saved) records the files it
    // changes into that parent session, not into its throw-away store.
    const parentStore = options.usageStore
    const parentPrefix = parentStore?.getState().promptSnapshot
    this.provider = options.client.modelIdentity?.('')?.provider
    // Sub-agents and workflow agents load tools the way their parent's session does. A deferred
    // parent's definitions are not shared: the child's own deferred tools are listed in its own.
    if (parentPrefix?.cwd === options.store.getState().cwd && parentPrefix.tools) this.parentDefers = parentPrefix.tools.some(tool => tool.name === DEFERRED_CALL)
    if (parentPrefix?.cwd === options.store.getState().cwd && !this.parentDefers && !options.store.getState().promptSnapshot) {
      const names = new Set(this.tools.map(tool => tool.name))
      const shared = parentPrefix.tools?.filter(tool => names.has(tool.name))
      if (shared?.length === this.tools.length) {
        this.tools = shared.map(def => this.tools.find(tool => tool.name === def.name)!)
        options.store.setState(() => ({ promptSnapshot: { ...parentPrefix, tools: shared,
          ...(shared.length === parentPrefix.tools!.length ? {} : { system: undefined }) } }))
      }
    }
    this.outputLedger = options.outputs ?? (parentStore && options.persist === false
      ? { sessionId: parentStore.getState().sessionId, store: parentStore, changed: () => outputReporters.get(parentStore)?.() } : undefined)
    // This engine owns its store's outputs: it saves them and sends the outputs frame for its children.
    if (!this.outputLedger) outputReporters.set(this.store, () => { this.save(); this.onRuntime?.({ type: 'outputs', outputs: this.store.getState().outputs }) })
    // A resumed session's calibration, before anything (such as /compact) replaces its status.
    if (this.store.getState().contextStatus || this.store.getState().contextCalibration) this.seedScale()
    const usageStore = options.usageStore ?? this.store
    const incomplete = !usageStore.getState().usageTotals && usageStore.getState().messages.length > 0
    // A session that starts with this version records its usage from the start, even when its
    // first requests are never billed: saved without totals it would read as one from before
    // usage was recorded, and its cost would be hidden for good.
    if (!usageStore.getState().usageTotals && !incomplete) usageStore.setState(() => ({ usageTotals: emptyUsage() }))
    this.client = trackUsage(options.client, (identity, usage, flags) => {
      usageStore.setState(state => {
        const usageTotals = appendUsage(state.usageTotals ?? emptyUsage(incomplete), identity, usage, flags)
        return { usageTotals, ...(state.contextStatus ? { contextStatus: { ...state.contextStatus, usageTotals } } : {}) }
      })
      const status = usageStore.getState().contextStatus
      // This engine's own request: one frame with its usage and the totals that include it.
      if (this.ownsUsage) this.emitStatus()
      else if (status) this.sendStatus(status)
      // A reply arrived: a durable point (the running turn is in the save, see PendingTurn).
      if (options.usageStore) saveSession(usageStore.getState())
      else this.save()
    }, this.store.getState().sessionId)
    this.ownsUsage = usageStore === this.store
    this.client = guardClient(this.client)
    this.writerClient = this.client
    this.budget = sessionBudgetController(usageStore, () => {
      if (options.usageStore || this.persist) saveSession(usageStore.getState())
    })
    this.client = budgetClient(this.client, this.budget)
    if (this.ownsUsage || !this.budget.onReached) {
      this.budget.onChanged = budget => this.onRuntime?.({ type: budget.phase === 'held' ? 'budget-reached' : 'budget-status', budget, sessionId: usageStore.getState().sessionId })
      this.budget.onReached = pending => this.writeBudgetHandoff(pending)
    }
  }

  /** The parent owns the offer even when a background workflow reaches it after its turn ended. */
  private async writeBudgetHandoff(pending: string): Promise<void> {
    const controller = this.budgetWriterController = new AbortController()
    let settled!: () => void
    budgetWriterSettlements.set(this, new Promise<void>(resolve => { settled = resolve }))
    if (this.partialTurn && this.aborted) controller.abort()
    try { await this.performBudgetHandoff(pending, controller.signal) }
    finally { this.budgetWriterController = undefined; budgetWriterSettlements.delete(this); settled() }
  }

  private async performBudgetHandoff(pending: string, signal: AbortSignal): Promise<void> {
    const state = this.budget.store.getState(), before = state.budget!
    const messages = this.partialTurn?.wire ?? (state.contextMessages ?? state.messages).filter(m => m.role !== 'system').map(contextWire)
    const requests = state.messages.filter(m => m.role === 'user').map(m => m.content)
    const request = this.partialTurn?.input ?? requests.at(-1) ?? before.pendingRequest ?? pending
    const goal = requests[0] ?? request
    const remaining = budgetWriterRemaining(before)
    const identity = this.writerClient.modelIdentity?.(this.model) ?? { provider: 'unknown', model: this.model }
    const price = budgetPrice(identity.provider, identity.model)
    // Keep input small enough to leave useful output room; admission uses text and image token estimates.
    const transcriptTokens = price?.input ? Math.max(256, Math.floor((remaining / MONEY_SCALE * 1_000_000 / price.input - 20_000) / 8)) : 4000
    let author = `${identity.provider}:${identity.model}`, summary: string
    const material = { request, goal, pendingRequest: before.pendingRequest ?? request, changed: (state.outputs ?? []).map(o => o.path),
      recentRequests: [...requests, request], recentLog: (state.toolHistory ?? []).map(t => `${t.name} · ${t.state}: ${headUnits(JSON.stringify(t.input) ?? '', 300)}`),
      transcriptTokens, ledger: `${moneyLabel(budgetSpent(before))} spent of the ${moneyLabel(before.limit)} limit, with ${moneyLabel(before.reserve)} kept for this handoff`,
      onFallback: () => { author = 'G-Code (local)' } }
    this.onRuntime?.({ type: 'status', text: 'Budget reached · Writing a handoff…' })
    const beat = this.heartbeat(() => false)
    try {
      summary = await writeHandoff(messages.length ? messages : [{ role: 'user', content: goal }], oneShot(budgetClient(this.writerClient, this.budget, 'handoff')), this.model, this.contextWindow().limit, signal, material)
    } catch (error) {
      author = 'G-Code (local)'
      summary = fallbackHandoff(messages, material, error instanceof BudgetReached ? 'the remaining reserve cannot cover a writer request' : 'the writer did not finish')
    } finally { beat.stop() }
    let path = '', saveError: string | undefined
    try { path = saveHandoff(state.cwd, state.sessionId, summary) }
    catch (error) { saveError = error instanceof Error ? error.message : String(error) }
    const after = this.budget.state!
    const writerCost = after.requests.filter(r => r.stage === after.stage && r.purpose === 'handoff').reduce((n, r) => n + (r.charged ?? r.reserved), 0)
    this.budget.recordHandoff({ path, summary, request, author, writerCost, at: Date.now(), limit: after.limit, ...(saveError ? { saveError } : {}) })
    this.onRuntime?.({ type: 'system', text: path ? `Budget reached. Handoff saved to ${path} · ${author} · Writer ${moneyLabel(writerCost)}.` : saveError! })
  }

  /**
   * The last turn, when it ended in an error or a stop: the rounds it ran and the text it wrote. A
   * sub-agent's parent reports them, since a failed turn returns no QueryResult.
   */
  get failedTurn(): { text: string; iterations: number } | undefined { return this.lastFailure }

  /** Requests are charged to this engine's own store (a sub-agent's go to its parent's). */
  private ownsUsage = true
  private budgetWriterController?: AbortController
  /** A response is arriving: its context-status frames wait for it (statusPending says one is due). */
  private holdStatus = false
  private statusPending = false

  /**
   * One context-status frame per change. While a response arrives the frame waits, so its final
   * usage and the session totals that include it go out together, not as two frames back to back.
   */
  private emitStatus(): void {
    this.statusPending = true
    if (!this.holdStatus) this.flushStatus()
  }

  private flushStatus(): void {
    if (!this.statusPending) return
    this.statusPending = false
    const status = this.store.getState().contextStatus
    if (status) this.sendStatus(status)
  }

  /** The last context-status frame sent: a repeated 'next-turn' report that changes nothing is not sent again. */
  private lastStatusFrame = ''
  private sendStatus(status: ContextStatus): void {
    this.lastStatusFrame = JSON.stringify(status)
    this.onRuntime?.({ type: 'context-status', ...status })
  }

  /** A non-streaming request: the usage it reports and the totals' update go out as one frame. */
  private async heldChat(request: Parameters<LLMClient['chat']>[0]): ReturnType<LLMClient['chat']> {
    if (this.ownsUsage) this.holdStatus = true
    const beat = this.heartbeat(() => false)
    try { return await this.client.chat(request) } catch (error) { this.holdStatus = false; this.flushStatus(); throw error } finally { this.holdStatus = false; beat.stop() }
  }

  /**
   * While a reply shows nothing, say every so often that the model is still working (HEARTBEAT).
   * `thinking`: whether the reply is reasoning (the status then says thinking, not waiting).
   * `touch()` marks visible progress; `stop()` ends the heartbeat.
   */
  private heartbeat(thinking: () => boolean): { touch(): void; stop(): void } {
    const started = Date.now()
    let quietSince = started, lastBeat = 0
    const timer = setInterval(() => {
      const now = Date.now()
      if (this.aborted || now - quietSince < HEARTBEAT.after || now - lastBeat < HEARTBEAT.every) return
      lastBeat = now
      const elapsed = elapsedLabel(now - started)
      this.onRuntime?.({ type: 'status', text: thinking() ? `Still thinking (${elapsed}). Long reasoning can take several minutes.` : `Still waiting for the model (${elapsed}). Long reasoning can take several minutes.` })
    }, Math.max(10, Math.min(1000, HEARTBEAT.every)))
    timer.unref?.()
    return { touch: () => { quietSince = Date.now(); lastBeat = 0 }, stop: () => clearInterval(timer) }
  }

  /**
   * Before a handoff that comes right after tool results the model has not read (a batch of reads
   * whose results filled the context), the model gets one more reply, with no tool calls, to read
   * them and note what they show; the handoff then starts from what it has seen. Skipped when that
   * reply cannot fit in the window (`room`: tokens left after this request's input). A handoff
   * written from unseen results listed them as done, or the next session distrusted its notes and
   * read again.
   */
  private async readBeforeHandoff(systemPrompt: string, messages: LLMMessage[], toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>, room: number, inputTokens: number): Promise<void> {
    const last = messages.at(-1)
    if (last?.role !== 'user' || typeof last.content === 'string' || !last.content.some(block => block.type === 'tool_result')) return
    const maxTokens = Math.min(outputPlan(this.model, this.store.getState().effort ?? 'medium', this.client.maxOutputTokens, this.streaming).first, room - HANDOFF_READ_NOTE_TOKENS)
    if (maxTokens < HANDOFF_READ_MIN_TOKENS) return
    const length = messages.length
    // What the context check measured: a reply that does not complete leaves it as the session's status.
    const checked = this.store.getState().contextStatus
    messages[length - 1] = { ...last, content: [...last.content, { type: 'text', text: HANDOFF_READ_NOTE }] }
    this.onRuntime?.({ type: 'status', text: 'Reading the latest results before the handoff…' })
    const budgetInputTokens = Math.ceil((inputTokens + HANDOFF_READ_NOTE_TOKENS) * 1.25) + 1024
    // A new request: its text starts a new paragraph after the round before it (as in the turn loop).
    this.roundStart = true
    try {
      const reply = this.streaming
        ? await this.streamIteration(systemPrompt, messages, toolDefs, maxTokens, budgetInputTokens)
        : await this.heldChat({ model: this.model, system: systemPrompt, messages, tools: toolDefs, maxTokens, budgetInputTokens, effort: this.store.getState().effort ?? 'medium', signal: this.abortController?.signal }).then(response => {
          if (response.usageReported !== false) this.recordUsage(response.usage)
          this.flushStatus()
          const text = response.content.filter((block): block is TextBlock => block.type === 'text').map(block => block.text).join('')
          if (text) this.emitText(text)
          return { text, toolUseBlocks: response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use'), truncated: [] as CutOffCall[], invalid: [] as InvalidCall[], stopReason: response.stopReason }
        })
      // The session is ending: calls in this reply never run, and their cards say so.
      for (const call of [...reply.toolUseBlocks, ...reply.truncated, ...reply.invalid]) this.toolProgress({ id: call.id, name: call.name }, 'refused', 'The session was handing off; the reply before a handoff runs no tools. Nothing was executed')
      if (!reply.text.trim()) throw new Error('it had no text')
      // A note the output limit stopped says so, for the handoff writer and the next session.
      const end = replyEnd(reply.stopReason)
      const cut = end === 'output-limit' ? `\n\n[This note was cut off at the ${maxTokens.toLocaleString('en-US')}-token output limit before it finished.]`
        : end !== 'finished' ? `\n\n[The provider stopped this note before it finished (${replyEndWords(reply.stopReason)}).]` : ''
      if (cut) this.emitText(cut)
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply.text + cut }] })
    } catch (error) {
      if (this.aborted) throw error
      // Without the reply the handoff starts as before: the writer marks the latest results unseen.
      messages.length = length
      messages[length - 1] = last
      if (checked) { this.store.setState(() => ({ contextStatus: checked })); this.sendStatus(checked) }
      this.onRuntime?.({ type: 'system', text: `The reply that reads the latest results before the handoff did not complete (${error instanceof Error ? error.message : String(error)}), so the handoff lists those results as not read yet.` })
    }
    if (this.partialTurn) this.partialTurn.wire = copyWire(messages)
  }

  /** Sessions in a row, this one included, that handed off without progress: no file changed and no task finished here. */
  private handoffStalls(input: string): number {
    const state = this.store.getState()
    if (state.outputs?.length || getTodos(state.sessionId).some(todo => todo.status === 'completed')) return 0
    // The count the session's first message carries when that message is a continuation.
    const opening = state.messages.find(message => message.role === 'user')?.content
    return continuationStalls(typeof opening === 'string' ? opening : input) + 1
  }

  /**
   * Cancel the running turn. `cause` is recorded on the saved turn; a non-explicit cause (a
   * shutdown path that cannot tell why) never replaces one a caller gave.
   */
  abort(cause: AbortCause = { by: 'user' }, explicit = true): void {
    if (!this.abortCause || (explicit && !this.abortCauseExplicit)) { this.abortCause = cause; this.abortCauseExplicit = explicit }
    this.aborted = true
    this.abortController?.abort()
    this.budgetWriterController?.abort()
  }

  /**
   * A user message sent while a turn runs. It is added to the conversation the model sees after
   * the turn's next tool batch ('steer' event, state 'delivered'). Returns false when no turn is
   * running (the caller says 'returned'); a steer the turn ends before delivering is handed back
   * ('returned', then `returned` is called with its text, which the terminal runs as the next turn).
   */
  steer(id: string, text: string, returned?: (text: string) => void): boolean {
    if (!this.partialTurn || this.aborted || !activeEngines.has(this) || !id || !text.trim()) return false
    this.steers.push({ id, text: text.trim(), returned })
    this.onRuntime?.({ type: 'steer', id, state: 'queued' } satisfies SteerEvent)
    return true
  }

  /**
   * The queued steers as the model reads them, each reported delivered. The user gave new
   * information, so the turn's run of failures starts again (a call that failed may run again).
   * A stopped turn delivers none: the model will not read them in it, so returnSteers hands them back.
   */
  private deliverSteers(budget?: TurnFailureBudget): string[] {
    if (this.aborted) return []
    const delivered = this.steers.splice(0)
    for (const steer of delivered) {
      this.partialTurn?.steers.push({ text: steer.text, at: Date.now() })
      this.onRuntime?.({ type: 'steer', id: steer.id, state: 'delivered' } satisfies SteerEvent)
    }
    if (delivered.length) budget?.steered()
    return delivered.map(steer => `${STEER_PREFIX}\n${steer.text}`)
  }

  /** The turn ended: steers it did not deliver go back, in the order they came. */
  private returnSteers(): void {
    for (const steer of this.steers.splice(0)) {
      this.onRuntime?.({ type: 'steer', id: steer.id, state: 'returned' } satisfies SteerEvent)
      steer.returned?.(steer.text)
    }
  }

  /** Saves the session now; a save waiting in saveSoon is then not needed. */
  private save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    if (this.persist) saveSession(this.store.getState())
  }

  /**
   * Saves within SAVE_DELAY_MS, once for any number of calls: tool state changes come in bursts
   * (queued, validating, running, complete for each call). The turn's durable points (a model
   * reply, a tool result, the end of the turn) save at once.
   */
  private saveSoon(): void {
    if (!this.persist || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      try { this.save() } catch { /* The next save reports it. */ }
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  /** A tool call finished: save the session and its memory, so a process killed from here on keeps the result. */
  private checkpoint(): void {
    const sessionId = this.store.getState().sessionId
    // Best effort: the memory is saved again at the end of the turn.
    if (this.sessionMemory && this.persist) try { saveSessionMemory(sessionId) } catch { /* Reported by the turn's own save. */ }
    this.save()
  }

  /** Once per file: no copy of a version that held a known key is kept, so Changes cannot show it. Also for a terminal, which has no Changes view. */
  private sayNotKept(outputs: readonly SessionOutput[]): void {
    for (const output of outputs) {
      if (this.toldNotKept.has(output.path) || !(output.versions?.at(-1)?.notKept || output.baseline?.notKept)) continue
      this.toldNotKept.add(output.path)
      this.onRuntime?.({ type: 'system', text: `${escapeDisplayControls(output.path)} holds a known API key or token, so G-Code keeps no copy of that version: it cannot be shown or restored from Changes.` })
    }
  }

  /** The running turn as a save records it before the turn ends (see PendingTurn). */
  private pendingTurn(): PendingTurn | undefined {
    const partial = this.partialTurn
    if (!partial) return
    const now = Date.now()
    const note = 'Interrupted: the process ended before this turn finished'
    const { effects, resume } = incompleteSuffixes(partial)
    const content = [partial.text, `[${note}. This turn is incomplete.${effects}]`, ...partial.tools.values()].filter(Boolean).join('\n\n')
    const wire = answeredWire(partial.wire)
    wire.push({ role: 'user', content: `[The process ended before this turn finished. ${INCOMPLETE_TURN}${resume}]` })
    return {
      messages: [
        { id: randomUUID(), role: 'user', content: partial.input, timestamp: partial.startedAt }, ...steerMessages(partial.steers),
        { id: randomUUID(), role: 'assistant', content, timestamp: now, metadata: { interrupted: true, reason: note } },
      ],
      contextMessages: wire.map(message => storedMessage(message, now)),
    }
  }

  private toolProgress(block: Pick<ToolUseBlock, 'id' | 'name'> & { input?: unknown }, state: ToolPhase, detail?: string, partial?: string): void {
    const activityId = this.toolIds.get(block.id) ?? block.id
    const previous = this.store.getState().toolHistory?.find(tool => tool.id === activityId)
    if (previous && terminalTool(previous.state)) return
    const terminal = terminalTool(state)
    // When it began to execute: startedAt is when its arguments began to stream (the card's place in
    // the timeline), so a duration from it would include the rest of the reply and the queue. A call
    // that settles without running (refused, denied, invalid, stopped in the queue) ran for no time.
    const now = Date.now()
    const runningAt = (previous as { runningAt?: number } | undefined)?.runningAt ?? (state === 'running' || terminal ? now : undefined)
    const progress = { id: activityId, name: block.name, state, startedAt: previous?.startedAt ?? now, updatedAt: now, ...(runningAt !== undefined ? { runningAt } : {}),
      ...(block.input !== undefined ? { input: block.input } : {}),
      ...(partial !== undefined ? { inputPreview: headUnits(partial, 6000), inputChars: partial.length } : {}),
      ...(terminal ? { completedAt: now, output: state === 'complete' && detail !== undefined ? headUnits(detail, 12000) : undefined, error: state !== 'complete' && detail !== undefined ? headUnits(detail, 12000) : undefined } : { detail }) }
    // The saved card keeps a bounded copy of the input (the full input is in the turn's wire).
    this.store.setState(current => ({ toolHistory: mergeToolProgress(current.toolHistory ?? [], 'input' in progress ? { ...progress, input: savedInput(progress.input) } : progress) }))
    // Progress within one phase does not resend the input: every client keeps it from the earlier frame.
    const { input: _sent, ...update } = progress as typeof progress & { input?: unknown }
    this.onRuntime?.({ type: 'tool-state', ...(previous?.input !== undefined && previous.state === state ? update : progress) })
    if (state !== 'preparing' && (!previous || previous.state !== state)) this.saveSoon()
  }

  async reportContext(): Promise<void> {
    await this.client.refreshContextWindow?.(this.abortController?.signal)
    // Before the conversation's first message the snapshot is not taken: the desktop sets the
    // session's permission mode (/session-controls) only after the CLI has started and reported.
    const started = this.conversationStarted()
    if (!this.lastSystem || !started) {
      this.lastSystem = this.systemPrompt(started)
      this.lastToolDefs = this.toolDefinitions()
    }
    const state = this.store.getState()
    await this.publishContext(asSent((state.contextMessages ?? state.messages).filter(m => m.role !== 'system').map(m => m.wire ?? ({ role: m.role as 'user' | 'assistant', content: m.content }))), 'next-turn')
  }

  /** A managed local model: a small window, counted by the runtime's tokenizer. */
  private managedLocal(): boolean { return this.client.managedLocal === true }

  /** The conversation has a message (or a saved prompt snapshot): its system prompt is fixed. */
  private conversationStarted(): boolean {
    const state = this.store.getState()
    return !!this.snapshot || state.promptSnapshot?.cwd === state.cwd || (state.contextMessages ?? state.messages).some(message => message.role === 'user' || message.role === 'assistant')
  }

  /**
   * The conversation's system prompt. It is the same bytes on every request and turn
   * (and after a resume) until the tools or the working directory change: the memory and
   * permission mode it carries are a snapshot taken when the conversation started in this
   * directory. Anything that changes later goes into a turn's context block instead.
   */
  private systemPrompt(freeze = true): string {
    const state = this.store.getState()
    if (this.snapshot?.cwd !== state.cwd) {
      const saved = state.promptSnapshot
      // Probe once before any measurement or frozen request. Saved prefixes keep their bytes.
      const ownerId = this.nodeInfoOwner.getState().sessionId
      const measured = sessionNodeInfo.get(this.nodeInfoOwner)
      this.nodeInfo = saved?.cwd === state.cwd && (saved.nodeEnvironment !== undefined || saved.system)
        ? saved.nodeEnvironment ?? ''
        : measured?.sessionId === ownerId && measured.cwd === state.cwd ? measured.value
        : nodeEnvironmentPrompt(nodeEnvironment(process.env, state.cwd))
      sessionNodeInfo.set(this.nodeInfoOwner, { sessionId: ownerId, cwd: state.cwd, value: this.nodeInfo })
      const local = this.managedLocal()
      // Deferred tool loading only when there is something to defer: otherwise both modes send the same.
      const defer = (this.parentDefers ?? defersTools({ managedLocal: local, provider: this.provider })) && this.tools.some(tool => !CORE_TOOLS.has(tool.name))
      this.deferredTools = new Set(defer ? this.tools.filter(tool => !CORE_TOOLS.has(tool.name)).map(tool => tool.name) : [])
      const snapshot = saved?.cwd === state.cwd ? saved
        : { cwd: state.cwd, memory: formatStandingMemory(loadProjectMemory(state.cwd), readTeamMemory(state.cwd)), permissionMode: state.permissionContext.mode, nodeEnvironment: this.nodeInfo,
          // What earlier sessions learned: fixed for this conversation (later learning waits for the next one).
          ...(this.includeSessionMemory ? { learned: formatLearnedPatterns(readLearnedPatterns(state.cwd)) } : {}) }
      // Not frozen yet (only measured before the first request): the next call takes it again.
      // The prompt carries no tool catalog (each description goes once, in the tool definitions).
      if (!freeze && snapshot !== saved) return buildStableSystemPrompt([], snapshot.memory, snapshot.cwd, snapshot.permissionMode, snapshot.nodeEnvironment ?? this.nodeInfo, snapshot.learned)
      const available = new Set(this.tools.map(tool => tool.name))
      // A saved prompt is kept for the same kind of runtime, tools and tool loading: one saved by an older
      // version may still list the tools, which a cloud session keeps (its bytes are cached) and a
      // local one cannot spare. A deferred session keeps every tool it has now that it does not send in
      // full: deferred tools may come and go (an MCP server) without changing the sent definitions.
      const compatible = snapshot.local === local && (snapshot.tools?.some(tool => tool.name === DEFERRED_CALL) ?? false) === defer
        && snapshot.tools?.every(tool => tool.name === DEFERRED_CALL || available.has(tool.name))
      if (compatible && snapshot.tools) {
        const sent = snapshot.tools.filter(def => def.name !== DEFERRED_CALL).map(def => this.tools.find(tool => tool.name === def.name)!)
        const deferred = defer ? this.tools.filter(tool => !sent.includes(tool) && !CORE_TOOLS.has(tool.name)) : []
        this.tools = [...sent, ...deferred]
        this.deferredTools = new Set(deferred.map(tool => tool.name))
      }
      this.snapshot = { ...snapshot, nodeEnvironment: snapshot.nodeEnvironment ?? this.nodeInfo, local, tools: compatible ? snapshot.tools : this.toolDefinitions(false),
        system: compatible ? snapshot.system : undefined }
      this.snapshot.system ??= buildStableSystemPrompt([], snapshot.memory, snapshot.cwd, snapshot.permissionMode, snapshot.nodeEnvironment ?? this.nodeInfo, snapshot.learned)
      this.store.setState(() => ({ promptSnapshot: this.snapshot! }))
    }
    return this.snapshot.system!
  }

  private toolDefinitions(frozen = true): import('../llm/types.js').LLMToolDefinition[] {
    const frozenTools = frozen ? this.snapshot?.tools : undefined
    if (frozenTools) return frozenTools
    const definition = (tool: Tool<unknown, unknown>) => ({ name: tool.name, description: tool.prompt(), input_schema: structuredClone(toolJsonSchema(tool)) })
    if (!this.deferredTools.size) return this.tools.map(definition)
    // Deferred loading: the other tools are named once, in DeferredToolCall's description.
    const deferred = this.tools.filter(tool => this.deferredTools.has(tool.name))
    return [...this.tools.filter(tool => !this.deferredTools.has(tool.name)).map(definition),
      { ...definition(DeferredToolCallTool as Tool<unknown, unknown>), description: deferredCallDescription(deferred) }]
  }

  /** The model's or runtime's window, lowered to the user's context budget when that is smaller. */
  private contextWindow(): ContextWindow {
    if (this.turnWindow) return this.turnWindow
    const runtime = this.client.contextWindow
    if (this.managedLocal() && !runtime) throw new Error('The local server context window is unavailable.')
    const budget = contextBudget(this.managedLocal())
    // Passing undefined into effectiveContextWindow would re-read the cloud setting.
    if (this.managedLocal() && budget === undefined) return { limit: runtime!, source: 'runtime' }
    const model = runtime ?? getContextLimit(this.model), stated = this.statedLimit()
    if (stated !== undefined && stated < model) return effectiveContextWindow(stated, 'provider-limit', budget)
    return effectiveContextWindow(model, runtime ? 'runtime' : contextLimitSource(this.model), budget)
  }

  /** The window the provider stated when it refused a request (see learnLimit). A managed local runtime reports its own. */
  private statedLimit(): number | undefined {
    return this.managedLocal() ? undefined : tokenCalibration(this.store.getState().contextCalibration, this.model)?.limit
  }

  /**
   * The provider refused a request and stated its limit: a window smaller than the catalog's is what
   * the context check, /compact and the handoff writer work to from now on, in this session and the
   * one it hands off to. Only a scale was learned before, so the check stayed far under its threshold:
   * no compaction ever ran, and every message failed the same way.
   */
  private learnLimit(limit: number): void {
    const known = this.client.contextWindow ?? getContextLimit(this.model)
    if (this.managedLocal() || limit >= Math.min(known, this.statedLimit() ?? known) || limit < MIN_LEARNED_LIMIT) return
    this.store.setState(() => ({ contextCalibration: this.calibration(limit) }))
    this.turnWindow = null
  }

  /** A one-off request (a summary, a handoff) refused as too long states the same limit. */
  private learnLimitFrom(error: unknown): void {
    const counts = isPromptTooLongError(error) ? parsePromptTooLongTokenCounts((error as { providerMessage?: string }).providerMessage ?? String((error as Error).message)) : null
    if (counts) this.learnLimit(counts.limitTokens)
  }

  /** What is saved of the token calibration: the scale, and the provider's stated limit when there is one. */
  private calibration(limit = this.statedLimit()): TokenCalibration | undefined {
    return tokenCalibration({ model: this.model, scale: this.usageScale, ...(limit !== undefined ? { limit } : {}) })
  }

  /** Seed usageScale from the saved session (its calibration was learned by an earlier process). */
  private seedScale(): void {
    if (this.scaleSeeded) return
    this.scaleSeeded = true
    // Until a response calibrates it: chars/4 counted Claude's system prompt and tool schemas about
    // 1.6 times too low, so a new session's first request could pass the check at about 96%.
    this.usageScale = initialTokenScale(this.model)
    const state = this.store.getState()
    const inherited = tokenCalibration(state.contextCalibration, this.model)
    if (inherited) { this.usageScale = inherited.scale; this.scaleCalibrated = true; return }
    // An explicitly bound scale for a different model must not fall through to its old meter.
    if (state.contextCalibration) return
    const saved = state.contextStatus
    if (!saved) return
    const parts = saved.system + saved.tools + saved.conversation
    // Sessions saved before `scale` existed: a calibrated estimate is parts × scale, provider
    // usage was measured for the request those parts describe.
    const scale = saved.scale ?? (parts > 0 && saved.source === 'calibrated-estimate' ? saved.used / parts
      : parts > 0 && saved.source === 'provider-usage' && saved.lastUsage ? saved.lastUsage.inputTokens / parts : undefined)
    const learned = tokenCalibration({ model: this.model, scale })
    if (learned && (saved.source === 'calibrated-estimate' || saved.source === 'provider-usage')) {
      this.usageScale = learned.scale
      this.scaleCalibrated = true
      this.store.setState(() => ({ contextCalibration: learned }))
    }
  }

  /**
   * The output reserve the context check keeps free at the current effort, at most
   * RESERVE_SHARE of the window (never below the smallest reserve). At a small context budget the
   * largest reserve with G-Code's own prompt and tools filled the window before any conversation.
   * It only decides when to compact: the reply's max_tokens is set apart from it.
   */
  private replyReserve(): number {
    const reserve = Math.min(REPLY_RESERVE[this.store.getState().effort ?? 'medium'], maxModelOutput(this.model, this.client.maxOutputTokens))
    return this.managedLocal() ? reserve : Math.min(reserve, Math.max(REPLY_RESERVE.low, Math.floor(this.contextWindow().limit * RESERVE_SHARE)))
  }

  /**
   * What the context-full check adds to the request's input: the room for the reply and a safety
   * margin. A managed local model keeps a fixed room (its max_tokens is then capped to what is left).
   */
  private checkReserve(): { output: number; safety: number } {
    return this.managedLocal() ? { output: LOCAL_CHECK_OUTPUT_TOKENS, safety: LOCAL_SAFETY_TOKENS } : { output: this.replyReserve(), safety: 0 }
  }

  /**
   * The error for a reply that used its whole output budget before any tool call. Raising the
   * effort helps only when a higher level has a larger budget; otherwise more effort means more
   * reasoning in the same room.
   */
  private budgetExhausted(tokens: number, effort: Effort, plan: { ceiling: number }): TurnStopped {
    const reasoning = this.store.getState().contextStatus?.lastUsage?.reasoningTokens
    const spent = reasoning ? `, ${reasoning.toLocaleString('en-US')} of them on reasoning` : ''
    // A sub-agent's or workflow agent's error goes to the model that started it, which cannot change
    // the effort (the agent copies it) and saw it make other calls: it can only ask for less.
    if (!this.ownsUsage) return new TurnStopped(`Output budget exhausted: this agent's last reply used all ${tokens.toLocaleString('en-US')} output tokens${spent ? `${spent},` : ''} before it finished or made a tool call. Give it a smaller or narrower task, or ask it to keep its reasoning short.`,
      `The reply used all ${tokens} output tokens before making any tool call`)
    const higher = EFFORTS.slice(EFFORTS.indexOf(effort) + 1).some(level => outputPlan(this.model, level, this.client.maxOutputTokens, this.streaming).first > tokens)
    // Lowering the effort helps only when there is a lower level, and not when no reasoning was spent.
    const lower = EFFORTS.indexOf(effort) > 0 && reasoning !== 0 ? ', or lower the effort level so the model spends less on reasoning' : ''
    const message = higher && tokens < plan.ceiling && Number.isFinite(plan.ceiling)
      ? `Output budget exhausted before any tool call: the reply used all ${tokens.toLocaleString('en-US')} output tokens${spent}. Raise the effort level for a larger output budget, or ask for smaller steps.`
      : `Output budget exhausted before any tool call, even at the largest output budget available (${tokens.toLocaleString('en-US')} tokens${spent}). Ask for smaller steps or a narrower request${lower}.`
    return new TurnStopped(message, `The reply used all ${tokens} output tokens before making any tool call`)
  }

  /**
   * `count`: false keeps to the local estimate (no tokenizer or provider request), e.g. while a
   * turn is being stopped; a number (an estimate) or a TokenCount is a count already made for these
   * messages, so the tokenizer is not asked again.
   */
  private async publishContext(messages: LLMMessage[], phase: ContextStatus['phase'], reserved?: number, count: boolean | number | TokenCount = true): Promise<ContextStatus> {
    this.seedScale()
    const state = this.store.getState()
    const local = this.managedLocal()
    const estimate = local ? localTokenEstimate : roughTokenCount
    const window = this.contextWindow()
    const check = this.checkReserve()
    const status: ContextStatus = {
      used: 0, limit: window.limit,
      system: estimate(this.lastSystem), tools: estimate(JSON.stringify(this.lastToolDefs)), conversation: estimateMessages(messages, estimate, this.client.visionCapabilities?.(this.model)),
      reserved: reserved ?? (local ? 2048 : this.replyReserve()), safety: local ? 1024 : 0, checkReserved: check.output + check.safety,
      estimated: true, limitSource: window.source, phase, compactions: state.sessionContext.compaction_count,
      source: this.scaleCalibrated ? 'calibrated-estimate' : 'estimate', lastUsage: state.contextStatus?.lastUsage,
      usageTotals: state.usageTotals, scale: this.usageScale,
    }
    status.used = status.system + status.tools + status.conversation
    this.requestEstimate = status.used
    const images = this.requestImages = estimateImageTokens(messages, this.client.visionCapabilities?.(this.model))
    const counted = count === true ? await this.client.countTokens?.({ model: this.model, system: this.lastSystem, messages, tools: this.lastToolDefs, effort: state.effort ?? 'medium', maxTokens: reserved ?? this.replyReserve(), signal: this.abortController?.signal })
      : typeof count === 'object' ? count : undefined
    if (typeof count === 'number') status.used = count
    else if (counted) { status.used = counted.tokens; status.estimated = counted.estimated; status.source = counted.source }
    else status.used = Math.ceil((status.used - images) * this.usageScale) + images
    this.store.setState(() => ({ contextStatus: status, ...(this.scaleCalibrated ? { contextCalibration: this.calibration() } : {}) }))
    // The desktop's /session-controls reports again right after startup's report, mostly unchanged.
    if (phase !== 'next-turn' || JSON.stringify(status) !== this.lastStatusFrame) this.sendStatus(status)
    return status
  }

  /** `inFlight`: the reply is still arriving, so its output count is a partial one (see ContextStatus.inFlight). */
  private recordUsage(usage: import('../llm/types.js').TokenUsage, inFlight = false): void {
    if (![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return
    const current = this.store.getState().contextStatus
    if (!current) return
    const { inFlight: _was, ...previous } = current
    // The scale is learned from the text alone: image tokens follow the provider's formula, and an
    // image figure folded into the ratio would shift every later text estimate.
    const textEstimate = this.requestEstimate - this.requestImages, textUsage = usage.inputTokens - this.requestImages
    if (textEstimate > 0 && textUsage > 0) { this.usageScale = Math.min(4, Math.max(0.5, textUsage / textEstimate)); this.scaleCalibrated = true }
    // Like OpenCode, use the latest request, never accumulated session billing.
    // Provider adapters already include cache/reasoning in input/output totals.
    const status: ContextStatus = { ...previous, used: usage.inputTokens + usage.outputTokens, estimated: false, phase: 'response', source: 'provider-usage', lastUsage: usage, measuredAt: Date.now(), scale: this.usageScale, ...(inFlight ? { inFlight } : {}) }
    this.store.setState(() => ({ contextStatus: status, ...(this.scaleCalibrated ? { contextCalibration: this.calibration() } : {}) }))
    this.emitStatus()
  }

  async compact(focus = ''): Promise<void> {
    await currentGuard()?.check()
    if (activeEngines.has(this)) throw new Error('Wait for the current response before compacting.')
    activeEngines.add(this)
    this.abortController = new AbortController()
    let settled!: () => void
    querySettlements.set(this, new Promise<void>(resolve => { settled = resolve }))
    try {
      this.onRuntime?.({ type: 'status', text: 'Compacting conversation… Original history is retained.' })
      // Measure first: the summary and the kept turns must fit next to the system prompt, tools and output reserve.
      await this.reportContext()
      const measured = this.store.getState().contextStatus
      const state = this.store.getState()
      const previous = state.contextMessages ?? state.messages
      // The parts are raw estimates: calibrated like the total, or the summary is given too much room.
      const reserve = measured ? Math.ceil((measured.system + measured.tools) * (measured.scale ?? this.usageScale)) + measured.reserved + measured.safety : 0
      const beat = this.heartbeat(() => false)
      const next = await summarizeContext(previous, oneShot(this.client), this.model, this.contextWindow().limit, headUnits(focus, 2000), this.abortController.signal, { reserve }).catch(error => {
        // Refused as too long: the next /compact and the next message size themselves to what the provider said.
        this.learnLimitFrom(error)
        this.save()
        throw error
      }).finally(() => beat.stop())
      this.store.setState(current => ({ contextMessages: next, contextStatus: undefined, compactArchives: [...(current.compactArchives ?? []), { at: Date.now(), messages: previous }], sessionContext: { ...current.sessionContext, compaction_count: current.sessionContext.compaction_count + 1 } }))
      // The earlier file reads are summarised now: the next FileRead returns content again.
      invalidateFileReadDedup(this.readFileState)
      await this.reportContext()
      // The summary was checked with an estimate; a request measured no smaller keeps the original.
      const measuredAfter = this.store.getState().contextStatus?.used
      if (measured && measuredAfter !== undefined && measuredAfter >= measured.used) {
        this.store.setState(current => ({ contextMessages: state.contextMessages, compactArchives: current.compactArchives?.slice(0, -1), sessionContext: { ...current.sessionContext, compaction_count: Math.max(0, current.sessionContext.compaction_count - 1) } }))
        await this.reportContext()
        this.save()
        this.onRuntime?.({ type: 'system', text: `Nothing to compact: the summary would not make the conversation smaller (${measured.used.toLocaleString('en-US')} → ${measuredAfter.toLocaleString('en-US')} tokens). The original context was kept.` })
        return
      }
      this.save()
      const status = this.store.getState().contextStatus
      const after = status?.used
      const sizes = measured && after !== undefined ? `: ${measured.used.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens` : ''
      // The summary was checked against the threshold with an estimate; the measured request may still reach it.
      const share = status ? (status.used + status.reserved + status.safety) / status.limit : 0
      const still = share >= COMPACTION_THRESHOLD
        ? ` It is still ${Math.round(share * 100)}% of the context window with room for the reply, at or above the ${Math.round(COMPACTION_THRESHOLD * 100)}% where the next message compacts again: start a new chat, or choose Continue in a new session when asked.` : ''
      this.onRuntime?.({ type: 'system', text: `Compacted the conversation${sizes}. Original conversation and previous context are preserved in the saved session.${still}` })
    } finally { activeEngines.delete(this); querySettlements.delete(this); settled(); this.abortController = null }
  }

  // --------------------------------------------------------------------------
  // Main Entry Point
  // --------------------------------------------------------------------------

  /** `invocations`: skills and MCP prompts the user's message ran (see src/cli/slashCommands.ts). */
  async submitQuery(input: string, options: { invocations?: ReadonlyArray<TurnInvocation> } = {}): Promise<QueryResult> {
    await currentGuard()?.check()
    if (activeEngines.has(this)) throw new Error('A query is already running in this engine')
    this.turnInvocations = options.invocations ?? []
    currentGuard()?.beginTurn(input, this.ownsUsage)
    if (this.persist) { const state = this.store.getState(); assertSessionOwner(state.cwd, state.sessionId) }
    if (this.budget.state?.phase !== undefined && this.budget.state.phase !== 'active') {
      await this.budget.reach(input); throw new BudgetReached(this.budget.state!)
    }
    activeEngines.add(this)
    let settled!: () => void
    querySettlements.set(this, new Promise<void>((resolve) => { settled = resolve }))
    this.maxIterations = this.configuredMaxIterations ?? Infinity
    this.turnIterations = 0; this.lastFailure = undefined
    this.partialTurn = { input, text: '', tools: new Map(), ran: false, mutating: false, startedAt: Date.now(), steers: [], wire: [
      ...(this.store.getState().contextMessages ?? this.store.getState().messages).filter(m => m.role !== 'system').map(contextWire),
      { role: 'user', content: input },
    ] }
    // Until the turn ends, every save of the session carries it (a process killed mid-turn keeps it).
    if (this.persist) this.untrackTurn = trackPendingTurn(this.store.getState().sessionId, () => this.pendingTurn())
    try {
      // The user's message is on disk before the first request, which may run for minutes: a process
      // killed during it keeps the message. A save that fails here stops the turn before it costs anything.
      this.save()
      return await this.runQuery(input)
    } catch (error) {
      // The turn's own record replaces the one saves carried while it ran.
      this.untrackTurn?.()
      // A Stop at the context-full question is the user's stop too.
      const userStopped = this.aborted || error instanceof ContextStopped
      for (const tool of this.store.getState().toolHistory ?? []) if (!terminalTool(tool.state)) {
        // A failed turn is not a failed execution: streamed arguments and queued or gated calls
        // have not run. Keep user stops cancelled and reserve failed for calls that began running.
        const phase = userStopped ? 'cancelled' : tool.state === 'running' ? 'failed' : 'refused'
        this.toolProgress(tool, phase, phase === 'refused'
          ? `Not run: the turn ended before this call started, so nothing was executed. ${String(error)}`
          : String(error))
      }
      // Count a cancelled query when it actually settles as interrupted, not
      // each time Stop or process cleanup calls abort() for the same query.
      if (userStopped) this.store.setState((current) => ({ sessionContext: {
        ...current.sessionContext, abort_count: current.sessionContext.abort_count + 1,
      } }))
      const partial = this.partialTurn
      this.lastFailure = { text: partial?.text.trim() ?? '', iterations: this.turnIterations }
      // Keep already-visible, validated progress and real tool outcomes in
      // resume history, explicitly marked incomplete. Never save rejected or
      // still-buffered model text, and never turn interruption into success.
      if (partial) {
        // Content the provider refused (an image it cannot process, a prompt over the window) is
        // replaced by a note in the journal saved below: kept, every later turn would send it again.
        const recovered = this.aborted ? undefined : recoverRejectedRequest(error, partial.wire, { requestEstimate: this.requestEstimate, overheadChars: this.lastSystem.length + JSON.stringify(this.lastToolDefs).length, local: this.managedLocal(), agent: !this.ownsUsage })
        if (recovered) {
          error = recovered.error
          if (recovered.scale) { this.usageScale = Math.min(4, Math.max(0.5, recovered.scale)); this.scaleCalibrated = true }
          if (recovered.limit) this.learnLimit(recovered.limit)
        }
        // The note is for the user (it may advise what to do next); the marker tells the model.
        const { note, marker } = interruptionReason(error, this.aborted ? this.abortCause ?? { by: 'user' } : undefined)
        // A turn in which no call reached execution (none was made, or each was refused, denied, cut
        // off or not valid JSON) has no effects to roll back and no results to resume from.
        const { effects, resume } = incompleteSuffixes(partial)
        // Every stop says which chunked files were left unwritten, as a turn that ends normally does.
        const unwritten = unfinishedTransfers(partial.transfers)
        if (unwritten.length) this.onRuntime?.({ type: 'system', text: `Not written: ${unwritten.join('; ')}. The file changes only when all its chunks arrive.` })
        const content = [partial.text, `[${asSentence(note)} This turn is incomplete.${effects}]`, ...partial.tools.values()].filter(Boolean).join('\n\n')
        const timestamp = Date.now()
        // Complete the protocol before any next turn can reuse it. Only calls
        // without an observed result receive synthetic failure results.
        const wire = completeStoppedWire(partial.wire)
        wire.push({ role: 'user', content: `[${asSentence(marker)} ${INCOMPLETE_TURN}${resume}]` })
        this.store.setState((current) => ({ contextMessages: wire.map(message => storedMessage(message, timestamp)), messages: [...current.messages,
          { id: randomUUID(), role: 'user', content: input, timestamp: partial.startedAt }, ...steerMessages(partial.steers),
          { id: randomUUID(), role: 'assistant', content, timestamp, metadata: { interrupted: true, reason: note } },
        ] }))
        // The saved status describes the context as stored, which the next turn sends. Measured
        // locally: the turn may be cancelled, and nothing else is sent for it.
        // A context-full stop or handoff already saved what its check measured.
        // The journal keeps oversized results whole; the next request cuts them, so measure the cut copy.
        if (this.lastSystem && !(error instanceof ContextHandoff || error instanceof ContextStopped)) await this.publishContext(asSent(wire), 'next-turn', undefined, false).catch(() => undefined)
      }
      // What the stopped turn noted (files it changed, open errors) is kept for the next process.
      if (this.sessionMemory && this.persist) try { saveSessionMemory(this.store.getState().sessionId); saveLearnedPatterns(this.store.getState().cwd) } catch { /* The turn's own error is the one to report. */ }
      this.save()
      if (currentGuard()?.held) { await currentGuard()!.check() }
      throw error
    } finally {
      currentGuard()?.endTurn(this.ownsUsage)
      this.untrackTurn?.(); this.untrackTurn = undefined
      activeEngines.delete(this)
      querySettlements.delete(this)
      settled()
      this.partialTurn = null
      this.turnWindow = null
      this.abortController = null
      this.returnSteers()
    }
  }

  private async runQuery(input: string): Promise<QueryResult> {
    this.aborted = false
    this.abortCause = undefined; this.abortCauseExplicit = false
    this.roundStart = false; this.turnHasText = false
    this.turnReplays = 0
    this.seedScale()
    this.abortController = new AbortController()

    const state = this.store.getState()
    await this.client.refreshContextWindow?.(this.abortController.signal)
    const cwd = (state as AppState).cwd

    // Load user-defined hooks and session memory
    const hookSnapshot = (this.hookSnapshot ?? loadHookSnapshot(cwd)).filter(hook => !this.skipQueryHooks || !['preQuery', 'postQuery'].includes(hook.type))
    if (this.sessionMemory) initSessionMemory(state.sessionId, cwd)

    // Update session context
    const sessionContext: SessionContext = {
      ...state.sessionContext,
      turn_count: state.sessionContext.turn_count + 1,
    }
    this.store.setState(() => ({ sessionContext }))

    const hookWarning = this.hookWarning ?? createHookWarningReporter(this.onRuntime, this.isHeadless)
    // The turn's progress: the model's distinct tool calls that succeeded (a call repeated with the
    // same input counts once) and the files they changed. A turn that compacts again with none since
    // the last compaction is not getting anywhere.
    let turnProgress = 0
    // File changes recorded in this turn (a child engine's included): a new one starts the count of repeated calls again.
    let fileChanges = 0
    // The project listing taken before each running shell command or MCP tool, by call id.
    const beforeFiles = new Map<string, Map<string, string>>()
    const succeededCalls = new Set<string>()
    const noteSucceededCall = (name: string, input: unknown) => {
      const key = sha256(canonicalJSON({ tool: name, input, cwd: this.store.getState().cwd }))
      if (!succeededCalls.has(key)) { succeededCalls.add(key); turnProgress++ }
    }
    // Each file's content before a tool first changes it in this session (the Changes view's "A").
    const baselines = new Map<string, import('../shared/sessionControls.js').OutputBaseline>()
    // A child engine records into its parent's outputs and snapshot folder; its own store is never saved.
    const ledger: OutputLedger = this.outputLedger ?? { sessionId: state.sessionId, store: this.store }
    const outputsChanged = () => this.outputLedger ? this.outputLedger.changed?.() : this.onRuntime?.({ type: 'outputs', outputs: this.store.getState().outputs })
    // File changes go into the memory of the session they are recorded into: a child engine (it
    // keeps no memory of its own) notes them in its parent's, for the parent's later turns.
    const noteChanges = (outputs: readonly SessionOutput[], at: string) => {
      if (this.sessionMemory) noteOutputChanges(sessionContext.turn_count, outputs, at)
      else if (this.outputLedger) noteOutputChanges(ledger.store.getState().sessionContext.turn_count, outputs, at, ledger.sessionId)
    }
    const stateForTools = () => this.store.getState()
    const toolContext: ToolUseContext = {
      get cwd() { return stateForTools().cwd },
      toolCardId: callId => this.toolIds.get(callId) ?? callId,
      onPermissionDenial: denial => this.onPermissionDenial?.(denial),
      sessionId: state.sessionId, turnNumber: sessionContext.turn_count, isHeadless: this.isHeadless, allowWorkflow: this.allowWorkflow,
      // A child engine's store is never saved: its background shells belong to the session it records into.
      taskSessionId: ledger.sessionId,
      signal: this.abortController.signal,
      failureBudget: new TurnFailureBudget(this.failureBudget, { headless: this.isHeadless, permissionMode: () => this.store.getState().permissionContext.mode }),
      readFileState: this.readFileState,
      // With the images the next request already carries: a read that would go over a limit is refused.
      vision: withImageBudget(this.client.visionCapabilities?.(this.model), () => messages),
      hookSnapshot,
      hookWarning,
      hookReloadScope: this.hookReloadScope,
      toolHookPolicy: this.toolHookPolicy ?? (() => this.store.getState().permissionContext),
      getPermissionContext: () => this.store.getState().permissionContext,
      setPermissionMode: (mode) => this.store.setState((current) => ({ permissionContext: { ...current.permissionContext, mode } })),
      setCwd: (nextCwd) => this.store.setState(() => ({ cwd: nextCwd })),
      confirm: this.onGateConfirm,
      // An empty list records nothing new but still saves and reports the outputs: a child engine
      // (workflow agent, sub-agent) that recorded into this session's outputs calls it that way.
      onArtifacts: (paths, tool = 'BrowserVerify') => {
        const now = this.store.getState()
        const known = ledger.store.getState().outputs
        const outputs = paths.map(path => {
          const key = outputKey(path, now.cwd)
          const previous = known?.find(output => output.path === key)
          if (key && !previous && !baselines.has(key)) {
            // A file a running command or MCP tool changed: its bytes from before that call.
            const listed = listedBaseline(now.cwd, ledger.sessionId, path, beforeFiles.values())
            if (listed) baselines.set(key, listed)
            // A file only this tool can have created did not exist before it (the Changes view shows it as added).
            else if (createdArtifact(tool, key, now.cwd)) baselines.set(key, { absent: true, bytes: 0, createdAt: Date.now() })
          }
          return outputRecord(path, now.cwd, tool, ledger.sessionId, previous, baselines, this.writer)
        }).filter((item): item is NonNullable<typeof item> => !!item)
        ledger.store.setState(current => ({ outputs: [...(current.outputs ?? []).filter(old => !outputs.some(next => next.path === old.path)), ...outputs] }))
        const changed = changedFiles(outputs, known)
        turnProgress += changed
        // No paths: a child engine recorded into this session's outputs.
        if (changed || !paths.length) fileChanges++
        noteChanges(outputs, now.cwd)
        this.sayNotKept(outputs)
        this.save()
        outputsChanged()
        releaseDroppedSnapshots(now.cwd, ledger.sessionId, ledger.store.getState().outputs, baselines)
      },
    }
    let hookToolCalls = 0
    const queryHooks = (type: HookType, details: { toolName?: string; toolInput?: string; toolOutput?: string; query?: string; response?: string }) =>
      runHooks(type, { ...details, cwd: this.store.getState().cwd, hooks: hookSnapshot,
        reloadScope: this.hookReloadScope, warn: hookWarning, signal: this.abortController!.signal },
        async (command, timeout, description, execution) => {
          const block: ToolUseBlock = { type: 'tool_use', id: randomUUID(), name: 'Bash', input: { command, timeout, description } }
          const hookContext = this.toolHookPolicy ? { ...toolContext, getPermissionContext: this.toolHookPolicy } : toolContext
          // Recheck after approval, immediately before spawning. A revoked guard blocks the guarded call; it must never
          // become an implicit permission to execute without that guard.
          const hookTool: typeof BashTool = { ...BashTool, call: (args, context) => {
            if (!execution.assertCurrent()) return Promise.resolve({ success: true, output: {
              stdout: 'Hook skipped: definition changed before execution.', stderr: '', exitCode: 0, interrupted: false,
            } })
            return BashTool.call(args, { ...context, hookEnv: execution.env })
          } }
          const run = await runTools([block], [hookTool], hookContext, this.onGateConfirm,
            async (_block, parsed) => {
              this.recordToolStart(block.id, 'Bash (project hook)', parsed)
              this.onToolStart?.('Bash', block.id, parsed as Record<string, unknown>)
            }, (_block, result, outcome) => this.recordToolOutcome(block.id, 'Bash (project hook)', toolResultText(result.content), outcome),
            (call, phase, detail) => this.toolProgress(call, phase, detail),
            // A hook passing is not the model's progress: it must not reset the failure guard. The
            // hook and the call it guards (its environment) identify the run, not just the command.
            { hook: true, budgetInput: { ...block.input, env: execution.env } })
          const result = run.results[0]!
          hookToolCalls += run.toolCallCount
          this.store.setState((current) => ({ sessionContext: {
            ...current.sessionContext,
            tool_call_count: current.sessionContext.tool_call_count + run.toolCallCount,
            error_count: current.sessionContext.error_count + run.errors,
          } }))
          this.onToolEnd?.('Bash', block.id, toolResultText(result.content), !!result.is_error)
          if (run.stopped) throw new Error(run.stopped)
          return { success: !result.is_error, output: toolResultText(result.content), error: result.is_error ? toolResultText(result.content) : undefined }
        })

    // Tool availability cannot depend on an English keyword heuristic: Chinese
    // requests and short follow-ups still need the same configured capabilities.
    this.systemPrompt()
    toolContext.deferredTools = this.deferredTools
    const managedLocal = this.managedLocal()

    // Build tool definitions for the API
    const toolDefs = this.toolDefinitions()

    // Conversation messages. The turn's first user message carries what changes per turn
    // (permission mode, new session memory, memory-file edits), so the system
    // prompt and every earlier message stay the same bytes and the provider's cache holds.
    // It is saved and replayed as sent.
    const history = (state.contextMessages ?? state.messages)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map(contextWire)
    const liveTurns = new Set(history.filter(message => message.role === 'assistant').map(message => memoryTurns.get(message)).filter((turn): turn is number => turn !== undefined))
    const legacyAssistantText = history.filter(message => message.role === 'assistant' && !memoryTurns.has(message)).map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    this.systemPrompt() // Fixes the snapshot the system prompt carries before comparing with it.
    const budget = this.budget.state
    const turnContext = buildTurnContext({
      budget: [currentGuard() ? 'Guillotine Mode is active. Only user-approved destinations are allowed. Network-capable calls require an approval card in every mode. Reach a local server by 127.0.0.1: a program that looks up a name through the system resolver stops the work, localhost included.' : '', budget ? `Session budget: ${moneyLabel(budgetSpent(budget))} / ${moneyLabel(budget.limit)}; ${moneyLabel(budget.reserve)} reserved for handoff; stage ${budget.stage}.` : ''].filter(Boolean).join('\n') || undefined,
      permissionMode: { system: this.snapshot!.permissionMode, current: this.store.getState().permissionContext.mode },
      sessionMemory: this.includeSessionMemory ? sessionMemoryLines(sessionContext.turn_count, liveTurns, legacyAssistantText) : [],
      standingMemory: { system: this.snapshot!.memory, current: formatStandingMemory(loadProjectMemory(this.store.getState().cwd), readTeamMemory(this.store.getState().cwd)) },
      history,
      invocations: this.turnInvocations,
    })
    // A saved session also hears once of the background tasks that ended with its earlier process,
    // and of those this process ran that ended since the last tool batch told of them.
    const ownsTasks = this.persist && !this.outputLedger
    const endedHere = ownsTasks ? takeEndedNotices(state.sessionId) : undefined
    const contextBlock = this.persist ? withEndedTasks(turnContext, { id: state.sessionId, cwd: this.store.getState().cwd }) : turnContext
    const currentUserMessage: LLMMessage = { role: 'user', content: withTurnContext(endedHere ? withContextLine(contextBlock, endedHere) : contextBlock, input) }
    memoryTurns.set(currentUserMessage, sessionContext.turn_count)
    const messages: LLMMessage[] = [...history, currentUserMessage]
    // Keep an unabridged turn journal separate from context compaction.
    if (this.partialTurn) this.partialTurn.wire = copyWire(messages)
    const remember = (message: LLMMessage) => {
      memoryTurns.set(message, sessionContext.turn_count)
      messages.push(message)
      this.partialTurn?.wire.push(copyWire(message))
    }

    let totalText = ''
    // Set when the turn's last reply was cut off by the output limit after it was shown.
    let cutOffNote = ''
    let totalToolCalls = 0
    let iterations = 0
    let completed = false
    let plansSucceeded = true
    // A reply with no text and no tool call is asked to continue once per turn.
    let emptyNudged = false
    // Chunked FileWrite transfers this turn started and has not finished: the file is not written yet.
    // The turn's record keeps them, so a stop can say so too.
    const openTransfers = new Map<string, OpenTransfer>()
    if (this.partialTurn) this.partialTurn.transfers = openTransfers
    let compactChosen = false
    let turnCompactions = 0
    // A budget raised after a cut-off reply stays raised for the rest of the turn.
    let raisedTokens = 0
    // Rounds in a row whose tool call was cut off with no larger budget left.
    let cutOffAtCeiling = 0
    // Calls cut off at the largest budget in this turn, whatever else the replies did: a model that
    // pairs a small complete call with a huge cut-off one bills the whole budget every round.
    let ceilingCutOffs = 0
    const ceilingCutOffNames = new Set<string>()
    // Replies in a row with a call whose arguments were not valid JSON, and those calls' tools.
    let invalidReplies = 0
    const invalidNames = new Set<string>()
    // Compactions in a row with no progress between them, and the progress at the last one.
    let stalledCompactions = 0
    let progressAtCompaction = 0
    // The current request as the context holds it: a compaction may leave a copy cut to fit.
    let requestMessage = currentUserMessage
    let savedRequestPath: string | undefined

    this.turnWindow = null
    const window = this.turnWindow = this.contextWindow()
    const contextLimit = window.limit
    const estimate = managedLocal ? localTokenEstimate : roughTokenCount
    const safetyTokens = this.checkReserve().safety
    const budgetOptions: import('./context.js').ContextBudgetOptions = { contextLimit, tools: toolDefs, safetyTokens, conservative: managedLocal }
    // The last request's input as the provider reported it, with the messages it sent (see anchoredInput).
    // `historyEpoch` changes whenever earlier messages are rewritten in place (images removed,
    // results cleared, compaction, dropped turns): an anchor from before then no longer holds.
    let anchor: { tokens: number; sent: LLMMessage[]; epoch: number } | undefined
    let historyEpoch = 0
    // What the context check measured for the messages as they are now.
    let inputCount: TokenCount | number = 0

    // Agent loop: LLM → tools → LLM → ... until end_turn or max iterations
    while (iterations < this.maxIterations && !this.aborted) {
      iterations++
      this.turnIterations = iterations
      const systemPrompt = this.systemPrompt()
      const systemPromptTokens = estimate(systemPrompt)
      this.lastSystem = systemPrompt; this.lastToolDefs = toolDefs
      const effort = this.store.getState().effort ?? 'medium'
      // The room the context check keeps free for the reply: a typical reply at this effort.
      let maxOutputTokens = this.replyReserve()
      // max_tokens actually sent. Thinking counts against it and the model cannot see it, so it
      // is generous for a model with a known output limit; unused room is not billed.
      const plan = outputPlan(this.model, effort, this.client.maxOutputTokens, this.streaming)
      let requestTokens = Math.max(plan.first, raisedTokens)
      // Preserve useful local conversation history instead of dropping it just
      // to reserve the maximum answer length. Actual output is capped below.
      const compactionOutputTokens = this.checkReserve().output
      // The calibrated estimate: image tokens follow the provider's formula, only the rest is scaled.
      const scaledEstimate = () => {
        const vision = this.client.visionCapabilities?.(this.model), images = estimateImageTokens(messages, vision)
        return Math.ceil((systemPromptTokens + estimateMessages(messages, estimate, vision) + estimate(JSON.stringify(toolDefs)) - images) * this.usageScale) + images
      }
      // The exact count (the local runtime's tokenizer) or, without one, the full calibrated estimate.
      // `inputCount` keeps it for the request's context status, so the tokenizer is asked once.
      const countInput = async () => {
        inputCount = await this.client.countTokens?.({ model: this.model, system: systemPrompt, messages, tools: toolDefs, maxTokens: maxOutputTokens, effort: this.store.getState().effort ?? 'medium', signal: this.abortController!.signal }) ?? scaledEstimate()
        return budgetOptions.inputTokens = typeof inputCount === 'number' ? inputCount : inputCount.tokens
      }
      // The input of the last request as the provider reported it, plus an estimate of only the
      // messages added since; undefined when there is no such report or the history before them changed.
      // `upper` (managed local): the same with the added messages counted as one token per byte of
      // their JSON, a bound no byte-level or byte-fallback tokenizer exceeds (the JSON keys outweigh
      // the chat template's markers). The scaled estimate can fall far short on content unlike the
      // history it was calibrated on (digits, base64, CJK), and a small window has no margin for that.
      const anchoredInput = (): { tokens: number; upper: number } | undefined => {
        if (!anchor || anchor.epoch !== historyEpoch || messages.length < anchor.sent.length || anchor.sent.some((message, index) => messages[index] !== message)) return
        const added = messages.slice(anchor.sent.length), vision = this.client.visionCapabilities?.(this.model), images = estimateImageTokens(added, vision)
        const tokens = anchor.tokens + Math.ceil((estimateMessages(added, estimate, vision) - images) * this.usageScale) + images
        return { tokens, upper: managedLocal ? Math.max(tokens, anchor.tokens + estimateMessages(added, text => Buffer.byteLength(text, 'utf8'), vision)) : tokens }
      }
      // Within EXACT_COUNT_MARGIN of a decision: the compaction threshold, or (local) the point where
      // the window starts to cap the reply.
      const nearDecision = (tokens: number) =>
        calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, inputTokens: tokens, outputTokens: compactionOutputTokens }).utilizationPct >= COMPACTION_THRESHOLD - EXACT_COUNT_MARGIN
        || contextLimit - tokens - safetyTokens < (Number.isFinite(requestTokens) ? requestTokens : maxOutputTokens) + contextLimit * EXACT_COUNT_MARGIN
      // Pressure clearing (clearOldToolResults): old tool results become notes and the request is
      // counted again. With `margin` the clearing is kept only when it leaves the request at least
      // CLEAR_MARGIN under the threshold; otherwise the results come back and the check goes on as
      // before. Returns the new check when the clearing is kept.
      const relievePressure = async (from: number, margin: boolean) => {
        const before = budgetOptions.inputTokens ?? 0, beforeCount = inputCount
        const cleared = clearOldToolResults(messages, from, (original, copy) => { const turn = memoryTurns.get(original); if (turn !== undefined) memoryTurns.set(copy, turn) })
        if (!cleared.cleared) return
        await countInput()
        const after = calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, outputTokens: compactionOutputTokens })
        if (margin && after.utilizationPct > COMPACTION_THRESHOLD - CLEAR_MARGIN) {
          cleared.restore()
          inputCount = beforeCount; budgetOptions.inputTokens = before
          return
        }
        historyEpoch++
        if (cleared.reads) invalidateFileReadDedup(this.readFileState)
        // The note in a cleared result asks for the call again: a repeat must not be answered with
        // "same result as earlier", which points at the note.
        invalidateTurnResults(toolContext.failureBudget)
        const results = `${cleared.cleared} old tool ${cleared.cleared === 1 ? 'result' : 'results'}`
        this.onRuntime?.({ type: 'system', text: `Cleared ${results} to free context: ${before.toLocaleString('en-US')} → ${(budgetOptions.inputTokens ?? 0).toLocaleString('en-US')} tokens.` })
        return after
      }
      // Cut oversized tool results (and collapse very long turns) before measuring, so the
      // context check counts the request that is actually sent.
      // A local model's history keeps no tool results from earlier turns.
      if (managedLocal && iterations === 1) invalidateFileReadDedup(this.readFileState)
      const microTruncated = microcompactMessages(messages)
      if (microTruncated > 0) {
        invalidateFileReadDedup(this.readFileState)
        if (this.verbose) process.stderr.write(`[context] Microcompacted ${microTruncated} oversized tool results\n`)
      }
      // Images the provider would refuse, and the oldest ones over the model's image count or request
      // size, become notes: a request over a limit could never be sent, nor any turn after it.
      const imagesRemoved = fitImages(messages, this.client.visionCapabilities?.(this.model))
      if (imagesRemoved > 0) {
        historyEpoch++
        invalidateFileReadDedup(this.readFileState)
        invalidateTurnResults(toolContext.failureBudget)
        this.onRuntime?.({ type: 'system', text: `Removed ${imagesRemoved} ${imagesRemoved === 1 ? 'image' : 'images'} from the conversation that the model cannot take (damaged, or over its per-request image limits).` })
      }

      // History is rewritten only when the context budget requires a batched compaction.
      // Microcompaction above caps new tool results before their first send, then leaves them stable.
      // Far from any decision the anchored estimate is enough: on the managed local runtime each
      // exact count is two HTTP requests (apply the chat template, then tokenize it). Whether a
      // decision is near is judged on the upper bound; the estimate is what a skipped count uses.
      const anchored = anchoredInput()
      if (anchored === undefined || nearDecision(anchored.upper)) await countInput()
      else inputCount = budgetOptions.inputTokens = anchored.tokens

      // Context budget check — compact if approaching limit
      let budget = calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, outputTokens: compactionOutputTokens })
      // Before anyone is asked or anything is compacted: clearing old tool results may be enough.
      if (!managedLocal && budget.needsCompaction) {
        const relieved = await relievePressure(0, true)
        if (relieved) budget = relieved
      }
      // Show what the check measured before anyone is asked: the meter, the question and the
      // stop message then give the same figure, and a turn that ends here saves it.
      if (!managedLocal && budget.needsCompaction) await this.publishContext(messages, 'request', compactionOutputTokens, inputCount)
      if (managedLocal && budget.needsCompaction) {
        // Durable history contains complete user/assistant turns. Drop oldest
        // turns first; keep the current user request and its tool loop intact.
        let removed = 0
        while (messages.indexOf(currentUserMessage) > 0
          && calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, outputTokens: compactionOutputTokens }).needsCompaction) {
          const nextUser = messages.findIndex((message, index) => index > 0 && message.role === 'user')
          const count = nextUser > 0 ? nextUser : messages.indexOf(currentUserMessage)
          messages.splice(0, count)
          historyEpoch++
          await countInput()
          removed += count
        }
        if (removed && this.verbose) process.stderr.write(`[context] Removed ${removed} earlier messages to fit the local model context.\n`)
        // The current turn alone still does not fit: its old tool results go before the request fails.
        if (calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, outputTokens: compactionOutputTokens }).needsCompaction) await relievePressure(Math.max(0, messages.indexOf(currentUserMessage)), false)
      } else if (!managedLocal && budget.needsCompaction) {
        // G-Code's own prompt and tools with the reply reserve already reach the threshold: neither
        // compacting nor a new session (which starts with the same prefix) can make room. The prefix
        // is calibrated with the session's scale (a count of this request covers the conversation too).
        const toolTokens = estimate(JSON.stringify(toolDefs))
        const prefix = Math.ceil((systemPromptTokens + toolTokens) * this.usageScale) + compactionOutputTokens + safetyTokens
        // Most of a prefix this large is usually the project's own files, which G-Code's text would not name.
        const memoryTokens = Math.ceil(estimate(this.snapshot?.memory ?? '') * this.usageScale)
        const memoryShare = memoryTokens * 2 >= prefix ? ` About ${memoryTokens.toLocaleString('en-US')} of those tokens are this project's memory files and team notes (GCODE.md and the like, .gcode/team-memory): shortening them makes room.` : ''
        // So may it be the tools of MCP servers, which only the user can turn off.
        const serverTokens = new Map<string, number>()
        for (const def of toolDefs) {
          const server = /^mcp__(.+?)__/.exec(def.name)?.[1]
          if (server) serverTokens.set(server, (serverTokens.get(server) ?? 0) + Math.ceil(estimate(JSON.stringify(def)) * this.usageScale))
        }
        const mcpTokens = [...serverTokens.values()].reduce((sum, tokens) => sum + tokens, 0)
        const largest = [...serverTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([server, tokens]) => `"${server}" about ${tokens.toLocaleString('en-US')}`).join(', ')
        const advice = mcpTokens * 2 >= prefix
          ? ` About ${mcpTokens.toLocaleString('en-US')} of those tokens are the tool definitions of MCP servers (${largest}): ${disableAdvice('<name>').replace('turn it off', 'turn one off')}, then start a new chat.`
          : `${memoryShare} Raise the context budget in Settings${compactionOutputTokens > REPLY_RESERVE.low ? ', or lower the effort' : ''}.`
        if (prefix >= budget.limit * COMPACTION_THRESHOLD) throw new Error(`The ${budget.limit.toLocaleString('en-US')}-token context window is too small for this session: G-Code's instructions and tool definitions with room for the reply already fill ${Math.min(100, Math.floor(prefix * 100 / budget.limit))}% of it, and at ${Math.round(COMPACTION_THRESHOLD * 100)}% it has to make room. Compacting or a new session cannot help.${advice}`)
        // A turn never compacts in a loop. One that makes no progress between compactions stops when
        // nobody can be asked (sub-agents, -p, workflow agents) and asks the user again otherwise; the
        // user is also asked again after every MAX_TURN_COMPACTIONS. A turn without anyone to ask
        // keeps compacting while its tool calls keep succeeding.
        const stalled = turnCompactions > 0 && turnProgress === progressAtCompaction && stalledCompactions + 1 >= MAX_STALLED_COMPACTIONS
        if (stalled && !this.onContextFull) throw new Error(`This turn compacted the conversation ${turnCompactions} times and still needs more room, but no new tool call has succeeded (repeating a call with the same input does not count) and no file has changed since the compaction before last, so it stopped. ${this.ownsUsage ? 'Ask for smaller steps, or start a new chat.' : 'Give this agent a smaller or narrower task.'}`)
        if (compactChosen && (stalled || (turnCompactions > 0 && turnCompactions % MAX_TURN_COMPACTIONS === 0))) compactChosen = false
        // Once the user chose to compact, later refills in this turn compact without asking again.
        // `reserved`: the reply room the check added to the input, so the dialog can show the same share.
        const choice = compactChosen || !this.onContextFull ? 'compact' : await this.onContextFull({ used: budgetOptions.inputTokens ?? budget.used, limit: budget.limit, limitSource: window.source, reserved: compactionOutputTokens + safetyTokens }, this.abortController.signal)
        this.abortController.signal.throwIfAborted()
        if (choice === 'compact') compactChosen = true
        // The share the check stopped at: the prompt plus the reply reserve and safety margin it adds
        // (budget.used), rounded down, as the desktop meter and dialog count it (contextCheckPercent).
        if (choice === 'stop') throw new ContextStopped(`The context window is ${Math.min(100, Math.floor(budget.used * 100 / budget.limit))}% full, so the turn stopped. Send /compact to shrink it here, or start a new chat.`)
        if (choice === 'handoff') {
          invalidateFileReadDedup(this.readFileState)
          invalidateTurnResults(toolContext.failureBudget)
          const count = inputCount as TokenCount | number // Set inside countInput, which the compiler cannot see here.
          const counted = typeof count === 'object' && !count.estimated && count.tokens === budgetOptions.inputTokens
          const handoffInput = budgetOptions.inputTokens ?? scaledEstimate()
          await this.readBeforeHandoff(systemPrompt, messages, toolDefs, budget.limit - (budgetOptions.inputTokens ?? budget.used) - safetyTokens - (counted ? 0 : Math.ceil(handoffInput * HANDOFF_READ_ESTIMATE_MARGIN)), handoffInput)
          this.onRuntime?.({ type: 'status', text: 'Writing a handoff for the new session…' })
          // One-off requests (here and in compaction) are not cached: nothing reads their prefix back.
          // A writer reply that is not a handoff is never passed on: G-Code then builds one from the record, and says so.
          const beat = this.heartbeat(() => false)
          const summary = await writeHandoff(messages, oneShot(this.client), this.model, contextLimit, this.abortController.signal, {
            request: input, changed: (this.store.getState().outputs ?? []).map(output => output.path),
            onFallback: problem => this.onRuntime?.({ type: 'system', text: `The model's handoff could not be used (${problem}), so G-Code built a basic one from the session record: the request, the files changed and the latest tool results.` }),
          }).catch(error => {
            // The writer's failure, not the main request's: it must never reach the recovery that
            // removes this turn's results as what made "the request" too long.
            if (this.aborted || error instanceof BudgetReached || error instanceof NetworkStopped || currentGuard()?.held) throw error
            this.learnLimitFrom(error)
            const said = error instanceof Error ? error.message : String(error)
            throw new TurnStopped(said.startsWith('The handoff') ? said : `The handoff was not written, so nothing was handed off and this session keeps the conversation (${said.trim().replace(/\.$/, '')}). Send a message to try again, or choose Compact when asked.`,
              'The handoff to a new session failed, so this session goes on')
          }).finally(() => beat.stop())
          // A handoff that cannot be saved still moves on: its text goes to the new session in the message.
          let path = '', saveError: string | undefined
          try { path = saveHandoff(cwd, state.sessionId, summary) } catch (error) {
            saveError = error instanceof Error ? error.message : String(error)
            this.onRuntime?.({ type: 'system', text: `${saveError} The handoff is passed to the new session in its first message.` })
          }
          throw new ContextHandoff(summary, path, input, saveError, this.scaleCalibrated || this.statedLimit() !== undefined ? this.calibration() : undefined, this.handoffStalls(input))
        }
        // The target is in the rough estimate's units, scaled by what the check counted for this request.
        const roughInput = systemPromptTokens + conversationTokens(messages) + toolTokens
        const scale = Math.min(4, Math.max(0.5, (budgetOptions.inputTokens ?? roughInput) / Math.max(1, roughInput)))
        const reservedTokens = budget.used - (budgetOptions.inputTokens ?? 0) // the output reserve and safety margin the check adds
        const targetTokens = Math.max(0, Math.floor((budget.limit * COMPACTION_TARGET - reservedTokens) / scale) - systemPromptTokens - toolTokens)
        const before = messages.length, beforeTokens = budgetOptions.inputTokens ?? budget.used

        // Summarise the conversation so far (this turn's tool calls and results included) and keep
        // the newest rounds that fit; their largest results are cut, with a note, when even they do not.
        this.onRuntime?.({ type: 'status', text: 'Compacting the conversation…' })
        const summaryBeat = this.heartbeat(() => false)
        const compaction = await compactTurn(messages, targetTokens, oneShot(this.client), this.model, {
          signal: this.abortController.signal, summarize: !!this.onContextFull, keep: requestMessage, contextLimit,
          beforeRequest: () => queryHooks('preQuery', { query: input }),
          saveRequest: () => savedRequestPath ??= saveLongRequest(this.store.getState().cwd, state.sessionId, input),
        }).finally(() => summaryBeat.stop())
        this.abortController.signal.throwIfAborted()
        if (compaction.kind === 'note') this.onRuntime?.({ type: 'system', contextLost: 'note', text: `${compaction.problem ? `The model's summary could not be used (${compaction.problem}), so the` : 'The'} earlier messages were replaced by a short note without a model summary: the start of each message, and a list of the tool calls. What they said beyond that is no longer in the model's context${this.persist ? '; the saved conversation keeps them' : ''}.` })
        if (compaction.request) {
          memoryTurns.set(compaction.request, sessionContext.turn_count)
          requestMessage = compaction.request
          this.onRuntime?.({ type: 'system', contextLost: 'request', text: `Your message is too long to stay whole in the context, so the model keeps its start and end.${compaction.requestPath ? ` The whole message is saved at ${compaction.requestPath}.` : this.persist ? ' The saved conversation keeps it whole.' : ''}` })
        }
        if (compaction.messages !== messages) {
          messages.length = 0
          messages.push(...compaction.messages)
          historyEpoch++
          // The summary replaced this turn's earlier results too.
          invalidateFileReadDedup(this.readFileState)
          invalidateTurnResults(toolContext.failureBudget)
          microcompactMessages(messages)
          await countInput()
        }
        const after = calculateContextBudget(messages, systemPromptTokens, this.model, { ...budgetOptions, outputTokens: compactionOutputTokens })
        if (this.verbose) process.stderr.write(`[context] Compacted ${before} → ${messages.length} messages (${(budget.utilizationPct * 100).toFixed(0)}% → ${(after.utilizationPct * 100).toFixed(0)}%)\n`)
        // Never send a request larger than the window.
        if (after.used > after.limit) throw new Error(`Compacting could not make the conversation fit the ${after.limit.toLocaleString('en-US')}-token context window (with room for the reply it still needs ${after.used.toLocaleString('en-US')}), so the turn stopped without sending it. Send a message and choose Continue in a new session to carry on, or start a new chat.`)
        if (compaction.kind !== 'none' || compaction.clipped) {
          stalledCompactions = turnCompactions > 0 && turnProgress === progressAtCompaction ? stalledCompactions + 1 : 0
          progressAtCompaction = turnProgress
          turnCompactions++
          this.store.setState(current => ({ sessionContext: { ...current.sessionContext, compaction_count: current.sessionContext.compaction_count + 1 } }))
          this.onRuntime?.({ type: 'system', text: `Compacted the conversation: ${beforeTokens.toLocaleString('en-US')} → ${(budgetOptions.inputTokens ?? after.used).toLocaleString('en-US')} tokens.` })
        }
      }

      const requestContext = await this.publishContext(messages, 'request', maxOutputTokens, inputCount)
      if (managedLocal) {
        const available = Math.max(0, contextLimit - requestContext.used - safetyTokens)
        if (available < 256) {
          throw new Error(`The local model's ${contextLimit.toLocaleString('en-US')}-token context is full. The current request and tool results were not sent. Shorten the request, narrow file reads, or start a new chat.`)
        }
        maxOutputTokens = Math.min(maxOutputTokens, available)
      }
      // The reply cannot outgrow the model's own window (a context budget may set a smaller limit).
      const room = managedLocal ? Math.max(1, contextLimit - requestContext.used - safetyTokens)
        : Math.max(1, Math.min(this.client.contextWindow ?? getContextLimit(this.model), this.statedLimit() ?? Infinity) - requestContext.used - safetyTokens)
      requestTokens = Math.min(requestTokens, room)

      if (maxOutputTokens !== requestContext.reserved) {
        const capped = { ...requestContext, reserved: maxOutputTokens }
        this.store.setState(() => ({ contextStatus: capped })); this.sendStatus(capped)
      }

      let iterationText = ''
      let toolUseBlocks: ToolUseBlock[] = []
      // Calls the output limit cut off mid-arguments: never run, answered with an error result.
      let truncated: CutOffCall[] = []
      // Calls whose arguments are not valid JSON in a reply that ended normally: never run, answered with an INVALID_JSON error.
      let invalid: InvalidCall[] = []
      let stopReason = 'end_turn'
      // The turn goes on after a marked reply only when the user wrote while it arrived; this one may finish.
      cutOffNote = ''
      let continuation: import('../llm/types.js').ProviderContinuation | undefined
      const cutOffStop = () => replyEnd(stopReason) === 'output-limit'
      // The output limit (in tokens) that cut off a reply the user has already seen: it is kept as shown, marked.
      let shownCutOff = 0
      // The messages this request sends, and the input the provider reports for it (see anchoredInput).
      const sent = messages.slice()
      let reportedInput: number | undefined

      // Re-evaluate unchanged hooks before every model request. The frozen
      // definitions still skip (and warn about) files changed during this turn.
      for (let attempt = 0; attempt < 2; attempt++) {
        const attemptText: number | undefined = this.partialTurn?.text.length
        const attemptHadText: boolean = this.turnHasText
        await queryHooks('preQuery', { query: input })
        // A Stop that arrived since the last check (during the hooks or the context count) sends nothing.
        if (this.aborted) throw new Error('Query cancelled')
        // A new request: its text starts a new paragraph, and the last tool's label is stale.
        this.roundStart = true
        this.onRuntime?.({ type: 'status', text: 'Waiting for the model…' })
        if (this.streaming) {
          // ── Streaming path ──────────────────────────────────────────
          const result = await this.streamIteration(
            systemPrompt, messages, toolDefs, requestTokens, Math.ceil((budgetOptions.inputTokens ?? scaledEstimate()) * 1.25) + 1024,
          )
          iterationText = result.text
          toolUseBlocks = result.toolUseBlocks
          truncated = result.truncated
          invalid = result.invalid
          stopReason = result.stopReason
          continuation = result.continuation
          reportedInput = result.inputTokens
        } else {
          // ── Non-streaming fallback ──────────────────────────────────
          const response = await this.heldChat({
            model: this.model,
            system: systemPrompt,
            messages,
            tools: toolDefs,
            maxTokens: requestTokens,
            budgetInputTokens: Math.ceil((budgetOptions.inputTokens ?? scaledEstimate()) * 1.25) + 1024,
            effort: this.store.getState().effort ?? 'medium',
            signal: this.abortController.signal,
          })

          const textBlocks = response.content.filter(
            (b): b is TextBlock => b.type === 'text',
          )
          toolUseBlocks = response.content.filter(
            (b): b is ToolUseBlock => b.type === 'tool_use',
          )

          iterationText = textBlocks.map((b) => b.text).join('')
          if (iterationText) this.emitText(iterationText)
          stopReason = response.stopReason
          continuation = response.continuation
          if (response.usageReported !== false) { this.recordUsage(response.usage); reportedInput = response.usage.inputTokens }
          this.flushStatus()
          // The output limit stops a reply mid-block, so only the reply's final block can be cut off:
          // a call there is cut off when its arguments are incomplete. An adapter that can tell lists
          // the calls whose arguments did not parse or were still being written (never run with
          // arguments that did not parse); without that list a final call is not trusted. A complete
          // call followed by more text runs.
          const final = response.content.at(-1)
          const incomplete = response.incompleteToolUse
          const cut = cutOffStop() ? toolUseBlocks.filter(call => incomplete ? incomplete.includes(call.id) : call === final) : []
          truncated = cut.map(call => ({ id: call.id, name: call.name, chars: JSON.stringify(call.input ?? {}).length }))
          toolUseBlocks = toolUseBlocks.filter(call => !cut.includes(call))
        }

        if (this.budget.state && this.budget.state.phase !== 'active') { await this.budget.reach(input); throw new BudgetReached(this.budget.state!) }
        if (this.aborted || toolUseBlocks.length || truncated.length || !cutOffStop()) break
        // The user has already seen this reply's text. Regenerating it would show a second reply
        // after the first, and save only one of them: it stays as it was shown, marked as cut off.
        // Only text that reached someone counts: a sub-agent, a workflow agent or a -p run shows
        // nothing while it runs, so its cut-off reply is retried rather than returned as complete.
        const shown = !!this.onText && !this.isHeadless && !!iterationText.trim()
        if (shown) {
          this.onRuntime?.({ type: 'system', text: `The reply was cut off at the ${requestTokens.toLocaleString('en-US')}-token output limit before it finished. Ask to continue for the rest.` })
          shownCutOff = requestTokens
          break
        }
        // Nothing usable came back: the reply ran out of room, usually while it was still
        // thinking. Retry the same request once with the largest budget available.
        const raised = Math.min(raisedOutput(plan, requestTokens), room)
        if (attempt === 1 || raised <= requestTokens) {
          // Preserve the terminal incomplete reply, but never use the first
          // truncated attempt as an assistant prefill for the retry.
          if (iterationText) remember({ role: 'assistant', content: [{ type: 'text', text: iterationText }], continuation })
          throw this.budgetExhausted(requestTokens, effort, plan)
        }
        requestTokens = raisedTokens = raised
        // The retry replaces this attempt: a failed turn must not report its text twice.
        if (this.partialTurn && attemptText !== undefined) { this.partialTurn.text = this.partialTurn.text.slice(0, attemptText); this.turnHasText = attemptHadText }
        this.onRuntime?.({ type: 'system', text: iterationText.trim()
          ? `The reply was cut off by its output budget before it finished; retrying the same request once with up to ${requestTokens.toLocaleString('en-US')} output tokens.`
          : `The reply used its whole output budget before any text or tool call (usually on reasoning); retrying the same request once with up to ${requestTokens.toLocaleString('en-US')} output tokens.` })
      }

      // The next round's check starts from this report when it agrees with the estimate as far as the
      // calibration's own bounds allow (see recordUsage); a report outside them is not trusted cheaply.
      const ratio = reportedInput ? (reportedInput - this.requestImages) / Math.max(1, this.requestEstimate - this.requestImages) : 0
      anchor = reportedInput && ratio >= 0.5 && ratio <= 4 ? { tokens: reportedInput, sent, epoch: historyEpoch } : undefined

      // A cut-off call is part of the reply (a provider replays it); it gets an error result, never runs.
      const cutOffBlocks: ToolUseBlock[] = [...truncated, ...invalid].map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: {} }))

      if (this.aborted) {
        const content: ContentBlock[] = [...(iterationText ? [{ type: 'text' as const, text: iterationText }] : []), ...toolUseBlocks, ...cutOffBlocks]
        if (content.length) remember({ role: 'assistant', content, continuation })
        break
      }

      // Each round's text is its own paragraph, as it was shown.
      if (iterationText) totalText += (totalText ? '\n\n' : '') + iterationText

      // Build assistant content blocks for conversation history
      const assistantContent: ContentBlock[] = []
      if (iterationText) {
        assistantContent.push({ type: 'text', text: iterationText })
      }
      // The provider ended the reply for a reason that is neither a finish, nor the output limit, nor
      // a refusal, with no call to go on with. A reply the user has seen stays as shown, marked; one
      // nobody saw (a sub-agent, a workflow agent, a -p run) or with no text fails the turn: its reader
      // would take it for the finished answer.
      const endedEarly = replyEnd(stopReason) === 'incomplete' && !toolUseBlocks.length && !cutOffBlocks.length
      const endWords = replyEndWords(stopReason)
      const earlyShown = endedEarly && !!this.onText && !this.isHeadless && !!iterationText.trim()
      // The next turn's model sees that its reply did not finish (the saved reply says so too).
      if (shownCutOff) {
        cutOffNote = `[This reply was cut off at the ${shownCutOff.toLocaleString('en-US')}-token output limit before it finished.]`
        assistantContent.push({ type: 'text', text: `\n\n${cutOffNote}` })
      }
      if (earlyShown) {
        cutOffNote = `[The provider stopped this reply before it finished (${endWords}), so it may be incomplete.]`
        assistantContent.push({ type: 'text', text: `\n\n${cutOffNote}` })
        this.onRuntime?.({ type: 'system', text: `The provider stopped the reply before it finished (${endWords}), so it may be incomplete. Ask to continue for the rest.` })
      }
      for (const tu of toolUseBlocks) {
        assistantContent.push(tu)
      }
      assistantContent.push(...cutOffBlocks)
      if (assistantContent.length || !endedEarly) remember({ role: 'assistant', content: assistantContent, continuation })
      if (endedEarly && !earlyShown) throw new TurnStopped(`The provider stopped this reply before it finished (${endWords})${iterationText.trim() ? ', so what it wrote may be incomplete' : ' and it gave no answer'}. ${this.ownsUsage ? 'Send the request again to retry.' : 'Start the agent again to retry; what it already changed stays changed.'}`,
        `The provider stopped the reply before it finished (${endWords})`)

      // A refusal (Gemini reports its safety blocks as one) is not an answer: the turn did not finish.
      // A refused reply's tool calls never run, complete or not (a refusal can stop a call mid-arguments):
      // each is answered with an error result, so the saved turn stays valid to replay.
      if (replyEnd(stopReason) === 'refused') {
        const refused = [...toolUseBlocks, ...cutOffBlocks]
        if (refused.length) {
          const answers: ToolResultBlock[] = refused.map(call => ({ type: 'tool_result', tool_use_id: call.id, is_error: true,
            content: `Not run: the reply that made this ${call.name} call was refused, so nothing was executed.` }))
          remember({ role: 'user', content: answers })
          for (const [index, call] of refused.entries()) {
            this.recordToolOutcome(`${iterations}:${call.id}`, call.name, answers[index]!.content as string, NOT_RUN)
            this.toolProgress({ id: call.id, name: call.name }, 'cancelled', 'The reply was refused, so this call was not run; nothing was executed')
          }
        }
        const calls = refused.length === 1 ? 'Its tool call was not run.' : refused.length ? `Its ${refused.length} tool calls were not run.` : 'Nothing further ran.'
        const lead = stopReason === 'refusal' ? 'The model refused to continue this reply' : `The provider stopped this reply (${endWords})`
        throw new TurnStopped(`${lead}${iterationText.trim() || refused.length ? '' : ' and gave no answer'}. ${calls} Rephrase the request, or try another model.`,
          refused.length ? 'The provider ended the reply as a refusal, so its tool calls were not run' : 'The provider ended the reply as a refusal')
      }

      // Some compatible providers report end_turn while still returning calls.
      if (toolUseBlocks.length === 0 && cutOffBlocks.length === 0) {
        const unfinished = unfinishedTransfers(openTransfers)
        // The turn stays valid to replay: a reply needs some content.
        const fillEmptyReply = () => {
          if (assistantContent.length) return
          assistantContent.push({ type: 'text', text: '(no reply text)' })
          const journal = this.partialTurn?.wire.at(-1)
          if (journal?.role === 'assistant' && Array.isArray(journal.content) && !journal.content.length) journal.content.push({ type: 'text', text: '(no reply text)' })
        }
        // The user wrote while this reply was written: the turn goes on with their message instead of ending.
        if (this.steers.length && !this.aborted && iterations < this.maxIterations) {
          fillEmptyReply()
          remember({ role: 'user', content: this.deliverSteers(toolContext.failureBudget).join('\n\n') })
          continue
        }
        if (!iterationText.trim()) {
          // Only thinking, or nothing at all: that ends nothing. The model is asked once to go on.
          if (!emptyNudged && iterations < this.maxIterations) {
            emptyNudged = true
            fillEmptyReply()
            remember({ role: 'user', content: `[${EMPTY_REPLY} Continue the task where you left off${unfinished.length ? `; not written yet, because not all chunks have arrived: ${unfinished.join('; ')}` : ''}. If the task is done, reply with a short summary.]` })
            this.onRuntime?.({ type: 'system', text: 'The model replied without any text or tool call; asking it once to continue.' })
            continue
          }
          this.onRuntime?.({ type: 'system', text: `The model ended the turn without a reply.${unfinished.length ? ` Not written: ${unfinished.join('; ')}.` : ''}` })
        } else if (unfinished.length) this.onRuntime?.({ type: 'system', text: `Not written: ${unfinished.join('; ')}. The file changes only when all its chunks arrive.` })
        completed = true
        break
      }

      // The output limit cut a call off: give the next requests the largest budget available,
      // and stop when even that keeps cutting calls off with nothing else getting done.
      let cutOffNext = requestTokens
      if (truncated.length) {
        cutOffNext = Math.min(raisedOutput(plan, requestTokens), room)
        const atCeiling = cutOffNext <= requestTokens
        cutOffAtCeiling = !atCeiling || toolUseBlocks.length ? 0 : cutOffAtCeiling + 1
        if (atCeiling) { ceilingCutOffs += truncated.length; for (const call of truncated) ceilingCutOffNames.add(call.name) }
        if (ceilingCutOffs >= MAX_CEILING_CUTOFFS && cutOffAtCeiling < 2) {
          const names = [...ceilingCutOffNames].join(', ')
          throw new TurnStopped(
            `Output budget exhausted: ${ceilingCutOffs} tool calls in this turn (${names}) were cut off at the ${requestTokens.toLocaleString('en-US')}-token output limit, the largest available, so the turn stopped. No cut-off call was executed, and nothing in the last reply ran. The work needs smaller pieces: ask for smaller steps, such as writing a large file in parts.`,
            `The output limit (${requestTokens} tokens) cut off ${ceilingCutOffs} tool calls (${names}) in this turn before their arguments were complete; the work needs smaller pieces`)
        }
        if (cutOffAtCeiling >= 2) {
          const names = [...new Set(truncated.map(call => call.name))].join(', ')
          throw new TurnStopped(
            `Output budget exhausted while preparing ${names}: the call was cut off at the ${requestTokens.toLocaleString('en-US')}-token output limit again, and no larger budget is available. No incomplete tool was executed. Ask for smaller steps, such as writing a large file in parts.`,
            `The output limit (${requestTokens} tokens) cut off ${names} again before its arguments were complete`)
        }
        raisedTokens = Math.max(raisedTokens, cutOffNext)
        this.onRuntime?.({ type: 'system', text: `Output limit reached while the model was writing ${[...new Set(truncated.map(call => call.name))].join(', ')} arguments (${requestTokens.toLocaleString('en-US')} tokens). The cut-off call was not run; ${cutOffNext > requestTokens ? `the model may redo it whole with up to ${cutOffNext.toLocaleString('en-US')} output tokens, or in smaller pieces if it will not fit` : 'the model is asked to redo it in smaller pieces'}.` })
      } else cutOffAtCeiling = 0

      // Arguments that are not valid JSON are answered (INVALID_JSON) and the model redoes the call; a
      // model that keeps sending them stops the turn, before anything in that reply runs.
      if (invalid.length) {
        invalidReplies++
        for (const call of invalid) invalidNames.add(call.name)
        if (invalidReplies >= MAX_INVALID_JSON_REPLIES) {
          const names = [...invalidNames].join(', ')
          throw new TurnStopped(
            `The model sent tool call arguments that are not valid JSON (${names}) in ${invalidReplies} replies in a row, so the turn stopped. None of those calls was run, and nothing in the last reply ran. ${this.ownsUsage ? 'Send the request again, or try another model.' : 'Start the agent again, or try another model.'}`,
            `The arguments of ${names} were not valid JSON in ${invalidReplies} replies in a row`)
        }
      } else { invalidReplies = 0; invalidNames.clear() }

      // Run tools. A DeferredToolCall's card, hooks and memory name the tool it calls.
      const realNames = new Map(toolUseBlocks.map(block => [block.id, deferredView(block).name]))
      for (const block of toolUseBlocks) {
        const key = this.toolIds.get(block.id)
        if (!key || this.store.getState().toolHistory?.some(tool => tool.id === key && terminalTool(tool.state))) this.toolIds.set(block.id, randomUUID())
        this.toolProgress(deferredView(block), 'queued')
      }
      const executedTools = new Set<string>()
      /** The baseline each file call took before it ran, by call id. */
      const capturedFor = new Map<string, string>()
      const resultMessage: LLMMessage = { role: 'user', content: [] }
      remember(resultMessage)
      const journalResults = this.partialTurn?.wire.at(-1)?.content as ContentBlock[] | undefined
      // A durable point: from here on the calls can have effects, and a process killed while one runs
      // must leave the record of it, so the model is told not to repeat it.
      this.save()
      // Sub-agents and workflow agents charge their requests to this session while the tools run:
      // the meter follows them instead of jumping when the next request of this engine starts.
      let usageSeen = this.store.getState().usageTotals
      const stopUsageFrames = this.store.subscribe(current => {
        if (current.usageTotals === usageSeen) return
        usageSeen = current.usageTotals
        if (current.contextStatus) this.sendStatus(current.contextStatus)
      })
      const toolResults = await runTools(
        toolUseBlocks,
        this.tools as Tool<unknown, unknown>[],
        toolContext,
        this.onGateConfirm,
        async (block, parsed) => {
          await queryHooks('preTool', { toolName: block.name, toolInput: headUnits(JSON.stringify(parsed), 5000) })
          // A shell command or an MCP tool (DSH plugins included) can change any file: the
          // project's listing before and after it shows what it created, changed and deleted.
          if (block.name === 'Bash' || block.name.startsWith('mcp__')) {
            const outputs = ledger.store.getState().outputs
            const listing = commandListing(cwd, ledger.sessionId, outputs, this.writer)
            beforeFiles.set(block.id, listing)
            // The bytes of the files the command may change or delete, for their baselines.
            rememberProjectContent(cwd, listing, outputs)
          }
          const target = ['FileWrite', 'FileEdit', 'NotebookEdit'].includes(block.name) && parsed && typeof parsed === 'object'
            ? (parsed as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (parsed as { notebook_path?: unknown }).notebook_path
            : block.name === TEAM_MEMORY_TOOL ? teamMemoryTarget(cwd, parsed) : undefined
          if (typeof target === 'string') {
            const key = outputKey(resolve(cwd, target), cwd)
            if (key && !baselines.has(key) && !ledger.store.getState().outputs?.some(output => output.path === key)) {
              const captured = captureBaseline(resolve(cwd, target), cwd, ledger.sessionId)
              if (captured) { baselines.set(captured[0], captured[1]); capturedFor.set(block.id, captured[0]) }
            }
          }
          this.recordToolStart(`${iterations}:${block.id}`, block.name, parsed)
          this.onToolStart?.(block.name, block.id, parsed as Record<string, unknown>)
          executedTools.add(block.id)
        },
        (block, result, outcome) => {
          ;(resultMessage.content as ContentBlock[]).push(result)
          const journaled = copyWire(result)
          journalResults?.push(journaled)
          // The bookkeeping follows the input the tool ran with: normalization may have fixed what the
          // model sent (a JSON string for the whole input or one field). The block keeps it as sent.
          const input = (outcome.input && typeof outcome.input === 'object' ? outcome.input : block.input) as Record<string, unknown>
          if (!result.is_error && executedTools.has(block.id)) noteSucceededCall(block.name, input)
          // A chunked FileWrite writes its file only when the last chunk arrives.
          const chunk = block.name === 'FileWrite' && !result.is_error && executedTools.has(block.id) ? input.chunk as { transfer_id?: unknown; index?: unknown; total?: unknown } | undefined : undefined
          if (chunk && typeof chunk.transfer_id === 'string' && typeof chunk.index === 'number' && typeof chunk.total === 'number') {
            const transfer = `${chunk.transfer_id}\u0000${String(input.file_path)}`
            if (chunk.index + 1 >= chunk.total) openTransfers.delete(transfer)
            else openTransfers.set(transfer, { id: chunk.transfer_id, path: String(input.file_path), received: chunk.index + 1, total: chunk.total })
          }
          this.recordToolOutcome(`${iterations}:${block.id}`, block.name, outcome.denial?.reason ?? outcome.plainError ?? toolResultText(result.content), outcome)
          const candidates: string[] = []
          const edited = block.name === 'FileEdit' ? input.file_path : block.name === 'NotebookEdit' ? input.notebook_path : block.name === TEAM_MEMORY_TOOL ? teamMemoryTarget(cwd, input) : undefined
          if (!result.is_error && typeof edited === 'string') candidates.push(resolve(cwd, edited))
          // A failed call that changed its file all the same (a write that could not be undone) goes into Changes too, with the baseline it took.
          const captured = capturedFor.get(block.id)
          capturedFor.delete(block.id)
          if (captured && result.is_error && !baselineStillCurrent(captured, baselines.get(captured))) candidates.push(captured)
          const known = ledger.store.getState().outputs
          const outputs = candidates.map(path => outputRecord(path, cwd, block.name, ledger.sessionId, known?.find(output => output.path === outputKey(path, cwd)), baselines, this.writer)).filter((value): value is NonNullable<typeof value> => !!value)
          // A shell command or MCP tool: the files it created, changed and deleted, with their bytes from before it ran.
          const before = beforeFiles.get(block.id)
          if (before) {
            beforeFiles.delete(block.id)
            const after = projectSnapshot(cwd, known)
            outputs.push(...commandOutputs(cwd, ledger.sessionId, block.name, before, after, known, baselines, this.writer))
            // Past the cap a listing is partial: what the command did outside it is not seen.
            if ((before.size >= SNAPSHOT_FILES || after.size >= SNAPSHOT_FILES) && !this.toldListingCap) {
              this.toldListingCap = true
              this.onRuntime?.({ type: 'system', text: `Changes may be incomplete: this project has more than ${SNAPSHOT_FILES.toLocaleString('en-US')} files, and G-Code lists only that many when it checks what a command or MCP tool changed. Some of their changes and deletions may not be recorded.` })
            }
          }
          if (outputs.length) {
            ledger.store.setState(current => ({ outputs: [...(current.outputs ?? []).filter(old => !outputs.some(next => next.path === old.path)), ...outputs] }))
            const changed = changedFiles(outputs, known)
            turnProgress += changed
            if (changed) fileChanges++
            outputsChanged()
            noteChanges(outputs, cwd)
            this.sayNotKept(outputs)
          }
          // A file call that changed nothing (it failed or was refused) leaves no baseline: a later
          // attempt takes the file as it is then, other writers' changes in between included.
          if (captured && !ledger.store.getState().outputs?.some(output => output.path === captured)) baselines.delete(captured)
          if (this.sessionMemory) noteToolOutcome(sessionContext.turn_count, block.name, input, toolResultText(result.content), !!result.is_error, cwd, outcome.state === 'cancelled')
          if (this.sessionMemory && this.persist && executedTools.has(block.id)) notePatternOutcome(cwd, ledger.sessionId, block.name, input, toolResultText(result.content), !!result.is_error)
          // A call the model keeps repeating with no file changed: said in this result, every so often. It stops nothing.
          const repeats = !result.is_error && executedTools.has(block.id) ? toolContext.failureBudget?.noteRepeat(block.name, input, this.store.getState().cwd, fileChanges) : undefined
          if (repeats) for (const copy of [result, journaled]) appendToResult(copy, repeatNote(block.name, repeats))
          // A durable point: the result is in the turn's journal, which the save carries.
          this.checkpoint()
          // Only now: a record on disk never lists bytes that are gone.
          releaseDroppedSnapshots(cwd, ledger.sessionId, ledger.store.getState().outputs, baselines)
          // Finish this tool before the next tool can wait on user approval.
          this.onToolEnd?.(block.name, block.id, outcome.denial?.reason ?? toolResultText(result.content), !!result.is_error)
        },
        (block, phase, detail) => this.toolProgress(block, phase, detail),
      ).finally(stopUsageFrames)
      // The cut-off calls: nothing ran. Say so, and how to redo them, as their results.
      for (const call of truncated) {
        const result: ToolResultBlock = { type: 'tool_result', tool_use_id: call.id, is_error: true, content: cutOffResult(call, requestTokens, cutOffNext) }
        ;(resultMessage.content as ContentBlock[]).push(result)
        journalResults?.push(copyWire(result))
        this.recordToolOutcome(`${iterations}:${call.id}`, call.name, result.content as string, NOT_RUN)
        this.toolProgress({ id: call.id, name: call.name }, 'refused', 'Cut off by the output limit before its arguments were complete; nothing was executed')
      }
      // Arguments that are not valid JSON: nothing ran. The model gets them back and may redo the call.
      for (const call of invalid) {
        const result: ToolResultBlock = { type: 'tool_result', tool_use_id: call.id, is_error: true, content: invalidResult(call) }
        ;(resultMessage.content as ContentBlock[]).push(result)
        journalResults?.push(copyWire(result))
        this.recordToolOutcome(`${iterations}:${call.id}`, call.name, result.content as string, NOT_RUN)
        this.toolProgress({ id: call.id, name: call.name }, 'refused', 'Its arguments were not valid JSON; nothing was executed')
      }

      totalToolCalls += toolResults.toolCallCount

      // Update session context
      const updatedCtx: SessionContext = {
        ...this.store.getState().sessionContext,
        tool_call_count: this.store.getState().sessionContext.tool_call_count + toolResults.toolCallCount,
        error_count: this.store.getState().sessionContext.error_count + toolResults.errors,
      }
      this.store.setState(() => ({ sessionContext: updatedCtx }))
      if (toolResults.stopped) throw new Error(toolResults.stopped)

      // Run post-tool hooks after the batch. Tool results were already emitted
      // individually, at their actual completion boundaries. A hook that fails is reported and the
      // turn goes on: the tool already ran, and its result stands.
      for (const tr of toolResults.results) {
        const toolName = realNames.get(tr.tool_use_id) ?? 'unknown'
        if (executedTools.has(tr.tool_use_id)) await queryHooks('postTool', {
          toolName,
          toolOutput: headUnits(toolResultText(tr.content), 5000),
        }).catch(error => {
          if (this.aborted || !(error instanceof HookFailedError)) throw error
          const text = `[hook warning] postTool hook ${escapeDisplayControls(error.hook)} failed after ${toolName} (${escapeDisplayControls(headUnits(error.detail, 500), true)}); the turn goes on.`
          this.onRuntime?.({ type: 'system', text })
          if (this.isHeadless || process.env.GCODE_DESKTOP !== '1') process.stderr.write(text + '\n')
        })
      }

      // Extract memories from tool results
      if (toolResults.results.some(result => result.is_error)) plansSucceeded = false
      if (this.sessionMemory) extractMemories(
        sessionContext.turn_count,
        iterationText,
        toolResults.results.map((tr) => ({
          name: realNames.get(tr.tool_use_id) ?? 'unknown',
          content: toolResultText(tr.content),
          isError: !!tr.is_error,
        })),
      )

      // Background tasks that ended while the batch ran, then messages the user sent meanwhile: text
      // blocks after the results, before the model's next request (every adapter sends a user
      // message's results first). Not inside a result: microcompaction cuts an oversized result's
      // tail, and the notice, already marked reported, would go with it. A stopped turn takes neither:
      // the notices are told next turn, and the steers go back to the user.
      const ended = ownsTasks && !this.aborted ? takeEndedNotices(ledger.sessionId) : undefined
      const results = resultMessage.content as ContentBlock[]
      for (const text of [...(ended ? [ended] : []), ...this.deliverSteers(toolContext.failureBudget)]) {
        const block: TextBlock = { type: 'text', text }
        results.push(block)
        journalResults?.push(copyWire(block))
      }

      // Feed tool results back to LLM
    }

    if (this.aborted) throw new Error('Query cancelled')
    if (!completed) throw new Error(`Query reached the limit of ${this.maxIterations} iterations before completing.`)

    // Post-query hooks
    await queryHooks('postQuery', {
      response: headUnits(totalText, 5000),
    })
    this.abortController.signal.throwIfAborted()
    if (this.sessionMemory) {
      if (plansSucceeded && !cutOffNote && !unfinishedTransfers(openTransfers).length) completeMemoryTurn(sessionContext.turn_count)
      compactSessionMemory(sessionContext.turn_count)
      // The turn is finished and its own save below is the durable point: notes that cannot be saved are a warning.
      try { persistSessionMemory(cwd); this.memorySaveWarned = false } catch (error) {
        if (!this.memorySaveWarned) this.onRuntime?.({ type: 'system', saveWarning: true, text: `Session notes could not be saved: ${error instanceof Error ? error.message : String(error)}. The turn is not affected. A later resume of this chat may miss these notes.` })
        this.memorySaveWarned = true
      }
      if (this.persist) try { saveLearnedPatterns(cwd) } catch { /* Learning is best effort; the turn stands. */ }
    }

    // Persist conversational context for subsequent REPL turns and session
    // resume. Tool-loop details remain in the per-query message array; the
    // durable history stores the user prompt and final assistant response.
    const completedAt = Date.now()
    const savedText = cutOffNote ? `${totalText}\n\n${cutOffNote}` : totalText
    const activePrefix = messages.slice(0, Math.max(0, messages.indexOf(currentUserMessage))).filter(m => typeof m.content === 'string').map(m => storedMessage(m, completedAt))
    // The finished turn replaces the record saves carried while it ran.
    this.untrackTurn?.()
    // A local turn keeps only its request and final reply. What the user sent while it ran is part of
    // the request then: the next turn resends this turn from here on anyway (its tool rounds are gone).
    const steers = this.partialTurn?.steers ?? []
    const savedRequest: LLMMessage = steers.length && typeof currentUserMessage.content === 'string'
      ? { ...currentUserMessage, content: [currentUserMessage.content, ...steers.map(steer => `${STEER_PREFIX}\n${steer.text}`)].join('\n\n') } : currentUserMessage
    memoryTurns.set(savedRequest, sessionContext.turn_count)
    this.store.setState((current) => ({
      contextMessages: managedLocal ? [...activePrefix, storedMessage(savedRequest, this.partialTurn?.startedAt ?? completedAt), { id: randomUUID(), role: 'assistant', content: savedText, timestamp: completedAt, metadata: { turn: sessionContext.turn_count } }] : messages.map(message => storedMessage(message, completedAt)),
      messages: [
        ...current.messages,
        { id: randomUUID(), role: 'user', content: input, timestamp: this.partialTurn?.startedAt ?? completedAt }, ...steerMessages(steers),
        { id: randomUUID(), role: 'assistant', content: savedText, timestamp: completedAt, ...(cutOffNote ? { metadata: { cutOff: true, reason: cutOffNote.slice(1, -1) } } : {}) },
      ],
    }))

    if (this.store.getState().contextStatus?.source !== 'provider-usage') await this.reportContext()
    this.save()
    return {
      response: totalText,
      toolCallCount: totalToolCalls + hookToolCalls,
      iterations,
    }
  }

  // --------------------------------------------------------------------------
  // Streaming Iteration
  // --------------------------------------------------------------------------

  /** Shows reply text; returns how many characters went to onText (a replay drops as many). */
  private emitText(text: string): number {
    if (!text) return 0
    // A new round's text follows the earlier rounds' as its own paragraph, as it is saved.
    if (this.roundStart) { this.roundStart = false; if (this.turnHasText) text = `\n\n${text}` }
    this.turnHasText = true
    if (this.partialTurn) this.partialTurn.text += text
    this.onText?.(text)
    return text.length
  }

  /** A call passed its checks and is about to run: from here on it may have effects. */
  private recordToolStart(id: string, name: string, input: unknown): void {
    if (this.partialTurn) { this.partialTurn.ran = true; if (!READ_ONLY_TOOLS.has(name)) this.partialTurn.mutating = true }
    this.partialTurn?.tools.set(id, `[Tool ${name}: invocation requested; completion unverified]\n${headUnits(JSON.stringify(input) ?? '', 2000)}`)
  }

  /** `outcome`: how the call ended (see outcomeLabel); a stopped turn's record says it per call. */
  private recordToolOutcome(id: string, name: string, result: string, outcome: CallOutcomeState): void {
    if (!this.partialTurn) return
    const excerpt = headUnits(result, 2000) + (result.length > 2000 ? '\n[Tool result excerpt truncated]' : '')
    this.partialTurn.tools.set(id, `[Tool ${name}: ${outcomeLabel(outcome)}]\n${excerpt}`)
  }


  private async streamIteration(
    systemPrompt: string,
    messages: LLMMessage[],
    toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    maxOutputTokens: number,
    budgetInputTokens?: number,
  ): Promise<StreamedReply> {
    // A reply that fails after it began is replayed: the same request (system, messages and tools,
    // so the prompt cache holds), at most REPLAY.perReply times and within the turn's REPLAY.perTurn.
    const max = Math.max(0, Math.min(REPLAY.perReply, REPLAY.perTurn - this.turnReplays))
    for (let replays = 0; ; replays++) {
      const reply: PartialReply = { text: '', toolUseBlocks: [], shownText: 0, thinking: 0, tools: [] }
      const before = { text: this.partialTurn?.text.length ?? 0, roundStart: this.roundStart, turnHasText: this.turnHasText }
      try {
        return await this.streamAttempt(systemPrompt, messages, toolDefs, maxOutputTokens, budgetInputTokens, reply)
      } catch (error) {
        const delay = replays < max && !this.aborted && !currentGuard()?.held && isReplayableStreamError(error) ? replayDelay(replays, error, { baseDelayMs: REPLAY.baseDelayMs }) : undefined
        if (delay === undefined) {
          // As before: what the reply showed is kept (marked incomplete by the turn's record).
          const content: ContentBlock[] = [...(reply.text ? [{ type: 'text' as const, text: reply.text }] : []), ...reply.toolUseBlocks]
          if (content.length) {
            const message: LLMMessage = { role: 'assistant', content }
            messages.push(message); this.partialTurn?.wire.push(copyWire(message))
          }
          if (currentGuard()?.held) { await currentGuard()!.check() }
          if (!this.aborted && error instanceof Error) {
            const replayable = isReplayableStreamError(error)
            explainNetworkFailure(error)
            // A provider's own error reads as it is; a dropped connection or a stall says it was tried again.
            // A DOMException's message is read-only; the note must never replace the failure itself.
            if (replayable && replays > 0 && !(error instanceof APIError)) try { error.message = `${asSentence(error.message)} It was requested again ${replays} ${replays === 1 ? 'time' : 'times'}.` } catch { /* It keeps its own words. */ }
          }
          throw error
        }
        this.turnReplays++
        // Discard the reply: its text from the turn's record, its tool cards (none of them ran). Its
        // usage was already counted by the usage tracker.
        if (this.partialTurn) this.partialTurn.text = this.partialTurn.text.slice(0, before.text)
        this.roundStart = before.roundStart; this.turnHasText = before.turnHasText
        this.dropToolCards(reply.tools)
        const reason = replayReason(error)
        this.onRuntime?.({ type: 'reply-restart', attempt: replays + 1, max, reason, text: reply.shownText, thinking: reply.thinking, tools: reply.tools } satisfies ReplyRestartEvent)
        this.onRuntime?.({ type: 'status', text: `${reason}; requesting it again in ${Math.max(1, Math.round(delay / 1000))} s (${replays + 1}/${max})…` })
        try { await sleep(delay, this.abortController?.signal) } catch (stopped) { if (this.aborted) throw new Error('Query cancelled'); throw stopped }
        this.onRuntime?.({ type: 'status', text: 'Waiting for the model…' })
      }
    }
  }

  /** Removes tool cards a discarded reply announced: they never ran, and the reply that made them is gone. */
  private dropToolCards(ids: readonly string[]): void {
    if (!ids.length) return
    const gone = new Set(ids)
    for (const [call, activity] of this.toolIds) if (gone.has(activity)) this.toolIds.delete(call)
    this.store.setState(current => ({ toolHistory: (current.toolHistory ?? []).filter(tool => !gone.has(tool.id)) }))
    this.saveSoon()
  }

  /** One attempt at a streamed reply; `reply` holds what it produced, for a caller that keeps or discards it. */
  private async streamAttempt(
    systemPrompt: string,
    messages: LLMMessage[],
    toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
    maxOutputTokens: number,
    budgetInputTokens: number | undefined,
    reply: PartialReply,
  ): Promise<StreamedReply> {
    // A rate limit, an overload, a server or network error before any of the reply arrived is
    // retried with backoff (Retry-After honoured, Stop cancels the wait); a started reply is replayed
    // by streamIteration.
    const stream = retryStream(() => this.client.chatStream({
      model: this.model,
      system: systemPrompt,
      messages,
      tools: toolDefs,
      maxTokens: maxOutputTokens,
      budgetInputTokens,
      effort: this.store.getState().effort ?? 'medium',
      stream: true,
      signal: this.abortController?.signal,
    }), {
      signal: this.abortController?.signal,
      onRetry: (attempt, error, delayMs) => {
        // Thinking an attempt displayed before it failed is dropped too (no text or call had arrived).
        if (reply.thinking) {
          this.onRuntime?.({ type: 'reply-restart', attempt, max: STREAM_RETRIES, reason: replayReason(error), text: 0, thinking: reply.thinking, tools: [] } satisfies ReplyRestartEvent)
          reply.thinking = 0
        }
        this.onRuntime?.({ type: 'status', text: retryStatus(error, delayMs, attempt) })
      },
      onWaitEnd: () => this.onRuntime?.({ type: 'status', text: 'Waiting for the model…' }),
    })

    const toolUseBlocks = reply.toolUseBlocks
    let continuation: import('../llm/types.js').ProviderContinuation | undefined
    const toolInputBuffers = new Map<string, { name: string; input: string }>()
    let stopReason = 'end_turn'
    let receivedDone = false
    let inputTokens: number | undefined
    const malformed: InvalidCall[] = []
    let lastProgress = 0
    let lastStatus = ''

    // Usage frames wait while the reply arrives (one goes out with its first content); the final one
    // goes out once the stream has ended, with the session totals that include this request.
    if (this.ownsUsage) this.holdStatus = true
    const beat = this.heartbeat(() => lastStatus === 'Thinking…')
    try {
    for await (const event of stream) {
      if (this.aborted) break
      // Text, a tool call or displayed reasoning is visible progress; usage and hidden reasoning are not.
      if (event.type === 'text' || event.type.startsWith('tool_use') || (event.type === 'thinking' && event.text)) beat.touch()
      if (event.type !== 'usage' && event.type !== 'done' && event.type !== 'continuation') this.flushStatus()
      // A new kind of activity is shown at once; the same one at most every 500 ms.
      const activity = event.type === 'thinking' ? 'Thinking…' : event.type === 'tool_use_start' || event.type === 'tool_use_input' ? 'Preparing tool arguments…' : event.type === 'text' ? 'Generating response…' : ''
      if (activity && (activity !== lastStatus || Date.now() - lastProgress > 500)) {
        lastProgress = Date.now(); lastStatus = activity
        this.onRuntime?.({ type: 'status', text: activity })
      }

      switch (event.type) {
        // A stream reports usage as it starts and again as it ends: final only once the stream has ended.
        case 'usage': this.recordUsage(event.usage, true); inputTokens = event.usage.inputTokens; break
        case 'continuation': continuation = event.continuation; break
        case 'text':
          reply.text += event.text
          reply.shownText += this.emitText(event.text)
          break

        case 'thinking':
          // An empty event marks thinking that is not displayed (a block start, or an omitted block).
          if (event.text) { reply.thinking += event.text.length; this.onThinking?.(event.text) }
          break

        case 'tool_use_start':
          this.toolIds.set(event.id, randomUUID())
          reply.tools.push(this.toolIds.get(event.id)!)
          toolInputBuffers.set(event.id, { name: event.name, input: '' })
          this.toolProgress({ id: event.id, name: event.name }, 'preparing', 'Receiving arguments; nothing has executed', '')
          break

        case 'tool_use_input':
          const buf = toolInputBuffers.get(event.id)
          if (buf) {
            buf.input += event.partial
            if (Buffer.byteLength(buf.input) > 1024 * 1024) throw new Error(`Tool ${buf.name} arguments exceeded 1 MiB. Use FileWrite chunks of at most 8 KiB or split the operation. No incomplete call executed.`)
            const prior = this.store.getState().toolHistory?.find(tool => tool.id === this.toolIds.get(event.id))
            if (!prior?.updatedAt || Date.now() - prior.updatedAt > 500) this.toolProgress({ id: event.id, name: buf.name }, 'preparing', 'Receiving arguments; nothing has executed', buf.input)
          }
          break

        case 'tool_use_end': {
          const completed = toolInputBuffers.get(event.id)
          if (completed) {
            let parsedInput: Record<string, unknown> = {}
            try {
              if (completed.input.trim()) {
                parsedInput = JSON.parse(completed.input)
              }
            } catch (error) {
              malformed.push({ id: event.id, name: completed.name, chars: completed.input.length, input: completed.input, problem: error instanceof Error ? error.message : String(error) })
            }
            toolUseBlocks.push({
              type: 'tool_use',
              id: event.id,
              name: completed.name,
              input: parsedInput,
            })
            // The throttle above may have skipped the last deltas: the card shows the whole arguments.
            const parsed = !malformed.some(call => call.id === event.id)
            this.toolProgress(parsed ? deferredView(toolUseBlocks.at(-1)!) : { id: event.id, name: completed.name }, 'preparing', parsed ? 'Arguments received; it runs once the reply ends. Nothing has executed' : 'Arguments did not parse; nothing has executed', completed.input)
            toolInputBuffers.delete(event.id)
          }
          break
        }

        case 'done':
          stopReason = event.stopReason
          receivedDone = true
          break

        case 'error':
          throw new Error(event.error)
      }
    }

    // Stopped by the output limit: a call still open, or closed with arguments that do not
    // parse, was cut off mid-arguments. The caller answers it; it never runs.
    const cutOff = receivedDone && replyEnd(stopReason) === 'output-limit'
    // With eager input streaming the provider no longer checks that arguments are JSON. In a reply
    // that ended normally such a call is answered with an INVALID_JSON error result and the loop
    // goes on, so the model can redo it. A refused reply's calls, these included, are answered as
    // refused and never run (see runQuery).
    const invalid: InvalidCall[] = receivedDone && !cutOff ? malformed : []
    if (malformed.length && !cutOff && !invalid.length) throw new Error(`Tool ${malformed.map(call => call.name).join(', ')} returned malformed JSON input. No incomplete tool was executed.`)
    if (!this.aborted && !receivedDone) throw new Error('Model stream ended before completing its response or tool arguments')
    if (!this.aborted && toolInputBuffers.size && !cutOff) throw new Error(`Model response ended (${stopReason}) while ${[...toolInputBuffers.values()].map(buffer => buffer.name).join(', ')} arguments were still arriving. No incomplete tool was executed.`)
    if (this.aborted) throw new Error('Query cancelled')
    const truncated: CutOffCall[] = cutOff ? [...malformed, ...[...toolInputBuffers].map(([id, buffer]) => ({ id, name: buffer.name, chars: buffer.input.length }))] : []
    const complete = toolUseBlocks.filter(block => !truncated.some(call => call.id === block.id) && !invalid.some(call => call.id === block.id))
    return { text: reply.text, toolUseBlocks: complete, truncated, invalid, stopReason, continuation, inputTokens }
    } finally {
      // The reply has ended: its last usage is final, and goes out with the totals that include it.
      const status = this.store.getState().contextStatus
      if (status?.inFlight) {
        const { inFlight: _done, ...final } = status
        this.store.setState(() => ({ contextStatus: final }))
        this.statusPending = true
      }
      this.holdStatus = false; this.flushStatus()
      beat.stop()
    }
  }
}

/** A streamed reply: its text, the calls to run, the calls cut off or not valid JSON, and the input its request reported. */
interface StreamedReply { text: string; toolUseBlocks: ToolUseBlock[]; truncated: CutOffCall[]; invalid: InvalidCall[]; stopReason: string; continuation?: import('../llm/types.js').ProviderContinuation; inputTokens?: number }

/**
 * What one attempt at a reply produced so far: its text and complete calls (kept when it fails for
 * good), and what it showed (text and thinking characters, tool card ids), dropped when it is replayed.
 */
interface PartialReply { text: string; toolUseBlocks: ToolUseBlock[]; shownText: number; thinking: number; tools: string[] }

/** Why a reply is requested again, in a few plain words. */
function replayReason(error: unknown): string {
  if (error instanceof APIError) return error.statusCode === 429 ? 'Rate limited mid-reply'
    : error.statusCode === 529 ? 'The provider was overloaded mid-reply'
    : error.statusCode >= 500 ? 'Provider server error mid-reply'
    : 'The provider stopped the reply'
  if (error instanceof StreamIdleTimeoutError) return 'The model stream went silent mid-reply'
  return 'The connection dropped mid-reply'
}

/** A tool call the output limit cut off before its arguments were complete. */
interface CutOffCall { id: string; name: string; chars: number }
/** A tool call whose arguments are not valid JSON: the text received and why it does not parse. */
interface InvalidCall extends CutOffCall { input: string; problem: string }

/** Adds a line of G-Code's to a tool result, after what the tool returned. */
function appendToResult(result: ToolResultBlock, note: string): void {
  result.content = typeof result.content === 'string' ? `${result.content}\n\n${note}` : [...(result.content ?? []), { type: 'text', text: note }]
}

/**
 * How many output records changed a file, compared with the records the session had before: a
 * file new to the session, new content (its newest snapshot), or deleted or restored. A record
 * without a snapshot to compare (none taken, or this one failed) counts as a change.
 */
function changedFiles(outputs: readonly SessionOutput[], known: readonly SessionOutput[] | undefined): number {
  return outputs.filter(output => {
    const previous = known?.find(old => old.path === output.path)
    if (!previous || !!previous.deleted !== !!output.deleted || output.snapshotError) return true
    const before = previous.versions?.at(-1)?.sha256, after = output.versions?.at(-1)?.sha256
    return before === undefined || after === undefined || before !== after
  }).length
}

/**
 * The error result for arguments that are not valid JSON, in the shape the API guidance gives for
 * eager input streaming ({"INVALID_JSON": "<the text received>"}), the text cut to its first 2000
 * characters.
 */
function invalidResult(call: InvalidCall): string {
  const head = headUnits(call.input, 2000)
  const received = head.length < call.input.length ? `${head}… [${call.input.length - head.length} more characters]` : call.input
  return `Not run: the arguments of this ${call.name} call are not valid JSON (${call.problem}), so nothing was executed.${jsonFaultNote(call.input)} Make the call again with valid JSON arguments.\n${JSON.stringify({ INVALID_JSON: received })}`
}

/** Where the arguments break, in one line: the parser's message gives no place, and the echo may stop before it. */
function jsonFaultNote(input: string): string {
  const at = jsonFaultAt(input)
  if (at < 0) return ''
  const before = JSON.stringify(tailUnits(input.slice(0, at), 60))
  return at >= input.length
    ? ` The text ends before the JSON is complete, after ${before}.`
    : ` The JSON breaks at character ${(at + 1).toLocaleString('en-US')} of ${input.length.toLocaleString('en-US')}: after ${before} comes ${JSON.stringify(headUnits(input.slice(at), 20))}.`
}

/** The error result a cut-off call gets: what happened, that nothing ran, and how to redo it. */
function cutOffResult(call: CutOffCall, tokens: number, next: number): string {
  // The characters received say little: a provider may hold back a value until it is complete.
  const head = `Not run: this ${call.name} call was cut off by the output limit (${tokens} tokens for the whole reply, thinking included) before its arguments were complete, so nothing was executed.`
  const split = 'split the work into several calls (for a large file, write a first part, then add the rest with further edits)'
  // A larger budget comes next: the same call may well fit whole, and the user may have asked for one call.
  if (next > tokens) return `${head} The next reply may use up to ${next} output tokens. That is ${Number((next / tokens).toFixed(1))}x this reply's limit: if the call fits in it, make the same call again whole (always when the user asked for a single call); only if it may not fit, ${split}.`
  return `${head} No larger output budget is available: make the call again with smaller arguments, ${split}.`
}

/** Saves a request too long to stay whole in the context, where the model can read it; undefined when it cannot be saved. */
function saveLongRequest(cwd: string, sessionId: string, input: string): string | undefined {
  try {
    // Named so that the sweep of saved tool output (sweepToolOutput) removes it in time too.
    const path = join(generatedFolder(cwd, 'tool-output'), `request-${sessionId.slice(0, 8)}-${Date.now()}-${randomUUID().slice(0, 6)}.txt`)
    writeFileSync(path, maskSecrets(input), { flag: 'wx', mode: 0o600 })
    return path
  } catch { return undefined }
}

/** A turn the engine ended on purpose. `modelReason` is what the model is told; the message is for the user. */
export class TurnStopped extends Error {
  constructor(message: string, readonly modelReason: string) { super(message); this.name = 'TurnStopped' }
}

/** The user chose Stop when the context window filled up mid-turn. */
export class ContextStopped extends TurnStopped {
  constructor(message: string, modelReason = 'The user stopped this turn because the context window was nearly full') { super(message, modelReason); this.name = 'ContextStopped' }
}

/**
 * The endings of an incomplete turn's notes: for the user (`effects`) and for the model (`resume`).
 * A turn in which no call ran gets neither: a call that was refused, denied, cut off or not valid
 * JSON has no effects and no result to resume from. One that ran only read-only tools has results
 * but no effects. Both name the chunked files a transfer left unwritten.
 */
function incompleteSuffixes(turn: { ran: boolean; mutating: boolean; transfers?: ReadonlyMap<string, OpenTransfer> }): { effects: string; resume: string } {
  const unwritten = unfinishedTransfers(turn.transfers)
  const files = unwritten.length ? ` Not written: ${unwritten.join('; ')}. The file changes only when all its chunks arrive.` : ''
  return {
    effects: `${turn.mutating ? ' Tool effects have not been rolled back.' : ''}${files}`,
    resume: `${files}${turn.ran ? ' Resume from the recorded tool results; do not repeat completed effects.' : ''}`,
  }
}

/** A call answered without running (refused, cut off, not valid JSON). */
const NOT_RUN: CallOutcomeState = { state: 'refused', started: false }

/** How a stopped turn's record labels a call: what happened to it, not just whether it failed. */
function outcomeLabel({ state, started }: CallOutcomeState): string {
  return state === 'complete' ? 'completed' : state === 'denied' ? 'denied' : state === 'refused' || !started ? 'not run' : state === 'cancelled' ? 'stopped before it finished' : 'failed'
}

/** A chunked FileWrite the turn started and has not finished: its file is not written yet. */
interface OpenTransfer { id: string; path: string; received: number; total: number }

function unfinishedTransfers(transfers?: ReadonlyMap<string, OpenTransfer>): string[] {
  return [...transfers?.values() ?? []].map(transfer => `${transfer.path} (FileWrite transfer ${transfer.id}: ${transfer.received} of ${transfer.total} chunks staged)`)
}

/** Tools that cannot change anything: a stopped turn that ran only these has no effects to warn about. */
const READ_ONLY_TOOLS = new Set([...PLAN_TOOLS].filter(name => !['TodoWrite', 'EnterPlanMode', 'ExitPlanMode'].includes(name)))

/** `context` (a turn's context block, or '' for none) with `line` added at its end. */
function withContextLine(context: string, line: string): string {
  const end = context.lastIndexOf(`\n${CONTEXT_CLOSE}`)
  // A block of its own: the first line of buildTurnContext's block is free text.
  if (!context || end < 0) return [context, buildTurnContext({ budget: line, permissionMode: { system: '', current: '' } })].filter(Boolean).join('\n\n')
  return `${context.slice(0, end)}\n${line}${context.slice(end)}`
}

/** Ends a reason with exactly one sentence mark, so wrapping it never doubles the period. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?\u2026]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

/** Why a turn is incomplete: `note` for the user (saved with the turn), `marker` for the model. */
function interruptionReason(error: unknown, aborted: AbortCause | undefined): { note: string; marker: string } {
  if (aborted) return aborted.by === 'user'
    ? { note: 'Stopped by user', marker: 'The user stopped this turn before it finished' }
    : { note: `Stopped because the session closed${aborted.signal ? ` (${aborted.signal})` : ''}`, marker: 'The session closed before this turn finished' }
  if (error instanceof BudgetReached) return { note: 'Budget reached; this session is paused', marker: 'The session budget was reached. Resume only after the user explicitly adds budget or chooses a handoff model.' }
  if (error instanceof ContextHandoff) {
    const note = `Context window full; continued in a new session (${error.path ? `handoff: ${error.path}` : 'the handoff was not saved to a file'})`
    return { note, marker: note }
  }
  if (error instanceof ContextStopped) return { note: error.message, marker: error.modelReason }
  const message = error instanceof Error ? error.message : String(error)
  return { note: `Turn failed before completion: ${message}`, marker: `This turn failed before completion: ${error instanceof TurnStopped ? error.modelReason : message}` }
}

function completeStoppedWire(messages: LLMMessage[]): LLMMessage[] {
  const wire = copyWire(messages)
  for (let i = 0; i < wire.length; i++) {
    const message = wire[i]!
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (!calls.length) continue
    let next = wire[i + 1]
    if (next?.role !== 'user' || !Array.isArray(next.content)) {
      next = { role: 'user', content: [] }; wire.splice(i + 1, 0, next)
    }
    const results = next.content as ContentBlock[]
    for (const call of calls) if (!results.some(b => b.type === 'tool_result' && b.tool_use_id === call.id)) results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'turn stopped before this ran' })
  }
  return wire
}

/** Wire data is JSON; snapshot using the same representation as persistence. */
function copyWire<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const originals = Array.isArray(value) ? value : [value]
  const copies = Array.isArray(copy) ? copy : [copy]
  originals.forEach((message, index) => {
    const turn = message && typeof message === 'object' ? memoryTurns.get(message) : undefined
    if (turn !== undefined) memoryTurns.set(copies[index], turn)
  })
  return copy
}

type StoredMessage = NonNullable<AppState['contextMessages']>[number]
/** Provenance is local bookkeeping, never an extra property sent to a provider. */
const memoryTurns = new WeakMap<LLMMessage, number>()
function contextWire(message: StoredMessage): LLMMessage {
  const wire = message.wire ?? { role: message.role as 'user' | 'assistant', content: message.content }
  const turn = message.metadata?.turn
  if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0) memoryTurns.set(wire, turn)
  return wire
}

/** A wire message as contextMessages store it: the wire, with a short text preview as its content (see wirePreview). */
/** Messages the user sent while a turn ran, as the saved conversation shows them (after the turn's request). */
function steerMessages(steers: ReadonlyArray<{ text: string; at: number }>): StoredMessage[] {
  return steers.map(steer => ({ id: randomUUID(), role: 'user' as const, content: steer.text, timestamp: steer.at, metadata: { steer: true } }))
}

function storedMessage(message: LLMMessage, timestamp: number): StoredMessage {
  const turn = memoryTurns.get(message)
  return { id: randomUUID(), role: message.role, content: wirePreview(message.content), wire: message, timestamp, ...(turn !== undefined ? { metadata: { turn } } : {}) }
}

/**
 * The turn's wire with every tool call answered, as a save mid-turn records it: a call without a
 * result gets one that says its outcome is unknown. Nothing is copied (the save serialises it at
 * once); a message that gains results is a new object.
 */
function answeredWire(messages: LLMMessage[]): LLMMessage[] {
  const wire: LLMMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    wire.push(message)
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    const next = messages[index + 1]
    const results = next?.role === 'user' && Array.isArray(next.content) ? next.content : undefined
    const missing = calls.filter(call => !results?.some(block => block.type === 'tool_result' && block.tool_use_id === call.id))
    if (!missing.length) continue
    const unknown: ToolResultBlock[] = missing.map(call => ({ type: 'tool_result', tool_use_id: call.id, is_error: true,
      content: 'No result was recorded: the process ended before this call finished, so whether it ran or what it changed is unknown.' }))
    if (results) { wire.push({ ...next!, content: [...results, ...unknown] }); index++ }
    else wire.push({ role: 'user', content: unknown })
  }
  return wire
}

/** Characters of one string kept in a saved tool card's input. */
const SAVED_INPUT_CHARS = 4000

/** A tool input as its saved card keeps it: long strings shortened (the turn's wire keeps the whole input). */
function savedInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > SAVED_INPUT_CHARS ? `${headUnits(value, SAVED_INPUT_CHARS)}… [${(value.length - SAVED_INPUT_CHARS).toLocaleString('en-US')} more characters not saved]` : value
  if (!value || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) {
    const items = value.map(item => savedInput(item, depth + 1))
    return items.every((item, index) => item === value[index]) ? value : items
  }
  const entries = Object.entries(value).map(([key, item]) => [key, savedInput(item, depth + 1)] as const)
  return entries.every(([key, item]) => item === (value as Record<string, unknown>)[key]) ? value : Object.fromEntries(entries)
}

/**
 * The messages as the next request sends them: a copy with oversized tool results cut the way the
 * request cuts them (the saved turn journal keeps them whole), for measuring the next turn.
 */
function asSent(messages: LLMMessage[]): LLMMessage[] {
  const copy = copyWire(messages)
  microcompactMessages(copy)
  return copy
}
