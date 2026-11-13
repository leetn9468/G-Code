import type { NetworkIncident } from '../../../../src/shared/networkGuard'
import { budgetContinuation, budgetModelProblem, localBudgetEndpoint, normalizeBudget, type SessionBudget, type BudgetSettings, type BudgetHandoff } from '../../../../src/shared/sessionBudget'
import { mergeToolProgress, terminalTool, TOOL_LABELS, type ToolProgress, type ModelRuntimeStatus, type InferenceMetrics } from '../../../../src/shared/runtimeEvents'
import type { ContextStatus, SessionOutput, SessionPermission, Effort } from '../../../../src/shared/sessionControls'
import { useCallback, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { executionBlockReason, type ExecutionEnvironment } from '@/lib/environments'
import type { ProviderName } from '@/lib/providers'
import { isTauri, loadSavedSession, respondContextFull, respondToolApproval, sendMessage, sendSteer, startSession, stopBackgroundTask, stopSession } from '@/lib/tauri'
import { handoffContinuation, type ContextFullChoice } from '../../../../src/shared/execution'
import type { BackgroundShellInfo } from '../../../../src/shared/tasks'
import type { ChatMessage, ToolExecution } from './types'
import { nextGenerationSpeed, type GenerationSpeed } from '@/lib/generationSpeed'
import type { DesktopToolApprovalRequest } from '@/lib/tauri'
import { SessionCancelledError, SessionLifecycle } from '@/lib/sessionLifecycle'
import { sessionLock, sessionLockMessage } from '@/lib/sessionLock'
import { tokenCalibration, type TokenCalibration } from '../../../../src/shared/tokenCalibration'
import { parsePermissionRule } from '../../../../src/shared/permissionRules'
import { assistantCompleteUpdate, assistantTextUpdate, recordStreamed, streamedTrimUpdate, type StreamLog } from './assistantStream'
import { isSteerableText, nextResendCount, parseReplyRestart, parseSteerEvent, replyRestartStatus, resendText, resetsConversation, unsavedSteers } from './turnEvents'
import { beforeInterruptedTurn, savedConversation, savedTools } from './savedConversation'
import { attachmentRefsFrom, type AttachmentRef } from '../../../../src/shared/attachments'

type EventPayload = Record<string, unknown> & { timestamp?: number }
/** `typed`: the user's own words in the composer, which go back there if the turn never starts (not a continuation or a resend, whose callers keep their text). */
type PendingTurn = { id: string; text: string; attachments?: AttachmentRef[]; dispatched: boolean; historyAdded: boolean; typed?: boolean }
/**
 * Text sent while a turn ran, until the CLI adds it (it then leaves the list) or it comes back. `sending`: the frame is on its way.
 * `at`: when it was sent. `composer`: the user ended its turn at the context-full question, so it goes back to the composer
 * when it comes back, as on Stop, instead of starting a turn.
 */
type Steer = { id: string; text: string; state: 'sending' | 'queued' | 'returned'; at: number; composer?: boolean }
/**
 * The CLI asks what to do when the context window fills mid-turn. `reserved`: the output reserve
 * the context check added to `used` (CLIs from before it was sent leave it out).
 */
export interface ContextFullRequest { requestId: string; used: number; limit: number; reserved?: number }

/** A context-full event as the dialog reads it; null without a request id. */
export function parseContextFull(payload: Record<string, unknown>): ContextFullRequest | null {
  if (typeof payload.requestId !== 'string') return null
  const request: ContextFullRequest = { requestId: payload.requestId, used: Number(payload.used ?? 0), limit: Number(payload.limit ?? 0) }
  if (typeof payload.reserved === 'number' && Number.isFinite(payload.reserved) && payload.reserved >= 0) request.reserved = payload.reserved
  return request
}
const idOf = (value: unknown) => typeof value === 'string' && value ? value : undefined
/** The longest agent label the approval tray shows, in characters. */
const ORIGIN_LABEL_CHARS = 200

/**
 * A tool-approval event as the tray reads it; null without a request id. A workflow agent's
 * request keeps its runId and agentId, and `origin` (who asks) when the CLI sends it.
 */
export function parseToolApproval(payload: Record<string, unknown>): DesktopToolApprovalRequest | null {
  if (typeof payload.requestId !== 'string' || !payload.requestId) return null
  const source = payload.workflowSource as { kind?: unknown; path?: unknown } | undefined
  const workflowSource = source && typeof source.kind === 'string' && ['inline', 'session', 'project', 'global'].includes(source.kind)
    && (source.path === undefined || typeof source.path === 'string')
    ? { kind: source.kind, path: source.path } as DesktopToolApprovalRequest['workflowSource'] : undefined
  const request: DesktopToolApprovalRequest = {
    requestId: payload.requestId, workflowSource,
    toolName: String(payload.toolName ?? 'Tool'), description: String(payload.description ?? ''), reason: payload.reason ? String(payload.reason) : undefined,
    filePath: payload.filePath ? String(payload.filePath) : undefined, input: payload.input, source: payload.source ? String(payload.source) : undefined,
  }
  const network = payload.network as { hosts?: unknown; scope?: unknown } | undefined
  if (network && Array.isArray(network.hosts) && network.hosts.every(h => typeof h === 'string')) request.network = { hosts: network.hosts, scope: network.scope === 'session' ? 'session' : 'call' }
  if (typeof payload.suggestedRule === 'string' && parsePermissionRule(payload.suggestedRule, true)) request.suggestedRule = payload.suggestedRule
  if (typeof payload.projectRoot === 'string' && payload.projectRoot.length <= 4096 && !/[\x00-\x1f\x7f]/.test(payload.projectRoot)
    && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(payload.projectRoot)) request.projectRoot = payload.projectRoot
  const runId = idOf(payload.runId), agentId = idOf(payload.agentId)
  if (runId) request.runId = runId
  if (agentId) request.agentId = agentId
  const origin = payload.origin as { kind?: unknown; label?: unknown; runId?: unknown; agentId?: unknown } | null | undefined
  if (origin && typeof origin === 'object' && (origin.kind === 'workflow' || origin.kind === 'agent') && typeof origin.label === 'string' && origin.label.trim()) {
    request.origin = { kind: origin.kind, label: Array.from(origin.label.trim()).slice(0, ORIGIN_LABEL_CHARS).join('') }
    const originRun = idOf(origin.runId) ?? runId, originAgent = idOf(origin.agentId) ?? agentId
    if (originRun) request.origin.runId = originRun
    if (originAgent) request.origin.agentId = originAgent
  }
  return request
}
/** One node of a workflow run as the Tasks view shows it (src/workflow/events.ts WorkflowNode). */
export interface WorkflowNodeView { id: string; parentId: string | null; kind: 'run' | 'agent' | 'phase' | 'tool'; label: string; status: string; detail?: string; tokens?: number; awaitingApproval?: boolean }
/** A workflow run's nodes, in the order they first appeared, and its end status once done. */
export interface WorkflowRunView { runId: string; toolUseId?: string; nodes: WorkflowNodeView[]; status?: string }
const NODE_KINDS = ['run', 'agent', 'phase', 'tool']

/** A workflow-state event as the Tasks view keeps it; null for anything else. */
export function parseWorkflowNode(payload: Record<string, unknown>): { runId: string; toolUseId?: string; node: WorkflowNodeView } | null {
  const node = payload.node as Record<string, unknown> | undefined
  if (payload.type !== 'workflow-state' || !idOf(payload.runId) || !node || typeof node !== 'object' || !idOf(node.id) || !NODE_KINDS.includes(String(node.kind)) || typeof node.label !== 'string' || typeof node.status !== 'string') return null
  return {
    runId: payload.runId as string, toolUseId: idOf(payload.toolUseId),
    node: { id: node.id as string, parentId: idOf(node.parentId) ?? null, kind: node.kind as WorkflowNodeView['kind'], label: node.label, status: node.status,
      ...(typeof node.detail === 'string' && node.detail ? { detail: node.detail } : {}), ...(typeof node.tokens === 'number' && Number.isFinite(node.tokens) ? { tokens: node.tokens } : {}),
      ...(node.awaitingApproval === true ? { awaitingApproval: true } : {}) },
  }
}

/** Runs keyed by the Workflow call that runs them (by run id for a call the desktop does not know). */
export function mergeWorkflowEvent(runs: Readonly<Record<string, WorkflowRunView>>, payload: Record<string, unknown>): Readonly<Record<string, WorkflowRunView>> {
  if (payload.type === 'workflow-done' && idOf(payload.runId)) {
    const key = Object.keys(runs).find(key => runs[key]!.runId === payload.runId)
    return key ? { ...runs, [key]: { ...runs[key]!, status: String(payload.status ?? '') } } : runs
  }
  const parsed = parseWorkflowNode(payload)
  if (!parsed) return runs
  const key = parsed.toolUseId ?? parsed.runId
  const run = runs[key] ?? { runId: parsed.runId, ...(parsed.toolUseId ? { toolUseId: parsed.toolUseId } : {}), nodes: [] }
  const at = run.nodes.findIndex(node => node.id === parsed.node.id)
  const nodes = at < 0 ? [...run.nodes, parsed.node] : run.nodes.map((node, index) => index === at ? parsed.node : node)
  return { ...runs, [key]: { ...run, nodes } }
}

/** What a turn the CLI started on its own says in the conversation. */
const TURN_STARTED: Record<string, string> = {
  workflow: 'A background workflow finished. Continuing with its result.',
  budget: 'Budget added. Continuing from the saved progress.',
  network: 'Network attempt allowed. Continuing.',
}

/** A finished handoff: the work continues in a new session in the same folder. `request` is the user's request in the old session (older CLIs omit it). */
/** `attachments`: files attached to the handed-off request; the continuation sends them again, so the new session sees the images and may read the files. */
export interface SessionHandoff { summary: string; path: string; sessionId: string; request?: string; calibration?: TokenCalibration; budgetHandoff?: BudgetHandoff; stalls?: number; attachments?: AttachmentRef[] }
/** The composer's hint while the session that takes over from a handoff starts. */
export const HANDOFF_STARTING = 'Starting a new session from the handoff…'
/** The activity while the CLI writes the handoff, after the user chose to continue in a new session. */
export const HANDOFF_WRITING = 'Writing a handoff for the new session…'
/** The activity while the CLI compacts the conversation, after the user chose to compact and continue. */
export const CONTEXT_COMPACTING = 'Compacting the conversation…'
/** Shown when the continuation could not be handed to the new session. */
export function handoffRetryMessage(path: string): string {
  if (!path) return 'Couldn’t continue from the handoff in a new session, and the handoff could not be saved to a file. Open the previous chat from Recents to pick up from there.'
  return `Couldn’t continue from the handoff in a new session. It is saved at ${path}. To try again, send “Continue from ${path}”.`
}
/** What identifies a handoff's notice: its saved file, or for one that could not be saved, the session it came from. */
export function handoffKey(handoff: Pick<SessionHandoff, 'path' | 'sessionId'>): string {
  return handoff.path || `session:${handoff.sessionId}`
}
/**
 * A handoff whose continuation did not reach a new session. It lives outside
 * the conversation (App shows it with the shell alerts), so opening another
 * chat, a new chat or Stop, which replace the messages, cannot erase it.
 */
export interface HandoffNotice { path: string; message: string }
/** Adds the notice for a handoff that did not continue, after the older ones; one per handoff file. */
export function withHandoffNotice(notices: HandoffNotice[], notice: HandoffNotice): HandoffNotice[] {
  return [...notices.filter(existing => existing.path !== notice.path), notice]
}
/**
 * The notices a message that reached the CLI settles. A continuation settles
 * only its own handoff (its notes may quote the path of an earlier one); a
 * message the user sent settles each handoff it names, as the retry the notice
 * suggests does. The list is returned as is when nothing is settled.
 */
export function settleHandoffNotices(notices: HandoffNotice[], text: string, continued?: string): HandoffNotice[] {
  // A handoff that was never saved has no path to name, so only its own continuation settles it.
  const settled = (notice: HandoffNotice) => continued !== undefined ? notice.path === continued : !notice.path.startsWith('session:') && text.includes(notice.path)
  return notices.some(settled) ? notices.filter(notice => !settled(notice)) : notices
}
/** Stopping the CLI ends its background shells: running ones become stopped now. */
export function stoppedTasks(tasks: BackgroundShellInfo[], now = Date.now()): BackgroundShellInfo[] {
  return tasks.some(task => task.status === 'running') ? tasks.map(task => task.status === 'running' ? { ...task, status: 'stopped', endedAt: now } : task) : tasks
}
/** Resolves true once `ready()` holds; false when `cancelled()` holds first or `timeoutMs` passes. */
export async function waitUntil(ready: () => boolean, { cancelled = () => false, timeoutMs = 15_000, intervalMs = 50 }: { cancelled?: () => boolean; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cancelled()) return false
    if (ready()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
/**
 * How long streamed text waits after a render that took `renderMs`, so that rendering takes at most a
 * quarter of the time however long the reply gets (each render lays out all of its Markdown): at 1,500
 * chunks a second it took all of it, the queue grew, and Stop waited over two minutes for a turn.
 */
export function textRenderPause(renderMs: number): number {
  return renderMs < 16 ? 0 : Math.min(2000, renderMs * 3)
}
const configurationKey = (provider: ProviderName, model: string, ollamaHost?: string, localModelPath?: string, localRuntimePath?: string, cwd?: string, environment: ExecutionEnvironment = 'local') => JSON.stringify([provider, model, provider === 'ollama' ? ollamaHost : null, provider === 'local' ? localModelPath : null, provider === 'local' ? localRuntimePath : null, cwd, environment])

export function useChatSession(provider: ProviderName, model: string, ollamaHost?: string, localModelPath?: string, localRuntimePath?: string, cwd?: string, environment: ExecutionEnvironment = 'local', permission: SessionPermission = 'default', effort: Effort = 'medium', localContext?: number, budgetSettings?: BudgetSettings) {
  const [modelRuntime, setModelRuntime] = useState<ModelRuntimeStatus | null>(null)
  const [inferenceMetrics, setInferenceMetrics] = useState<InferenceMetrics | null>(null)
  // The local model's speed for the status strip: kept between replies, cleared with the session or model.
  const [generationSpeed, setGenerationSpeed] = useState<GenerationSpeed | null>(null)
  const [networkIncident, setNetworkIncident] = useState<NetworkIncident | null>(null)
  const [networkOpen, setNetworkOpen] = useState(false)
  const networkRef = useRef<NetworkIncident | null>(null)
  const setNetwork = (incident: NetworkIncident | null) => { networkRef.current = incident; setNetworkIncident(incident) }
  const [budget, setBudgetState] = useState<SessionBudget | null>(null)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const budgetRef = useRef<SessionBudget | null>(null)
  const setBudget = useCallback((next: SessionBudget | null) => { budgetRef.current = next; setBudgetState(next) }, [])
  const [context, setContext] = useState<ContextStatus | null>(null)
  const [outputs, setOutputs] = useState<SessionOutput[]>([])
  const [runtimePermission, setRuntimePermission] = useState<SessionPermission | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tools, setTools] = useState<ToolExecution[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  /** A saved chat is being opened: `streaming` is on for that too, but no work is running. */
  const [restoring, setRestoring] = useState(false)
  const restoreCall = useRef(0)
  const [activity, setActivity] = useState('')
  const [approval, setApprovalState] = useState<DesktopToolApprovalRequest | null>(null)
  const approvalRef = useRef<DesktopToolApprovalRequest | null>(null)
  /** Every approval waiting, oldest first, while more than one waits (the CLI announces each change). */
  const [approvalQueue, setApprovalQueue] = useState<DesktopToolApprovalRequest[]>([])
  const setApproval = useCallback((request: DesktopToolApprovalRequest | null) => {
    approvalRef.current = request
    setApprovalState(request)
    // The CLI sends the queue again after the head is answered or withdrawn.
    if (!request) setApprovalQueue([])
  }, [])
  const [workflowRuns, setWorkflowRuns] = useState<Readonly<Record<string, WorkflowRunView>>>({})
  const [sessionRunning, setSessionRunning] = useState(false)
  const [lockLostSessionId, setLockLostSessionId] = useState<string | null>(null)
  const lostSession = useRef<string | null>(null)
  const [contextFull, setContextFull] = useState<ContextFullRequest | null>(null)
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundShellInfo[]>([])
  const [handoff, setHandoff] = useState<SessionHandoff | null>(null)
  /** Set while the new session that takes over from a handoff is starting. */
  const [handoffFrom, setHandoffFrom] = useState<SessionHandoff | null>(null)
  /** Where each handoff that did not continue is saved, oldest first; conversation resets and later handoffs keep them. */
  const [handoffNotices, setHandoffNotices] = useState<HandoffNotice[]>([])
  const dismissHandoffNotice = useCallback((path: string) => setHandoffNotices(notices => notices.filter(notice => notice.path !== path)), [])
  const [sessionId, setSessionId] = useState('boot-0000')
  const activeAssistant = useRef<string | null>(null)
  const configuration = useRef(configurationKey(provider, model, ollamaHost, localModelPath, localRuntimePath, cwd, environment))
  const configurationVersion = useRef(0)
  const conversationVersion = useRef(0)
  const acceptingEvents = useRef(false)
  const sending = useRef(false)
  const lifecycle = useRef(new SessionLifecycle())
  const resumeId = useRef<string | undefined>(undefined)
  const activeSessionId = useRef<string | undefined>(undefined)
  const pendingTurn = useRef<PendingTurn | null>(null)
  const incompleteTurn = useRef<PendingTurn | null>(null)
  const listenersReady = useRef<Promise<void>>(Promise.resolve())
  /** True from a handoff's end until its continuation is handed to the new session (or fails). */
  const handoffStarting = useRef(false)
  const handoffCalibration = useRef<TokenCalibration>()
  const handoffSessionId = useRef<string>()
  /** What this turn's assistant text went to, so a replayed reply removes exactly its own part. */
  const streamLog = useRef<StreamLog>([])
  /** Tool cards of discarded replies: late progress for them must not bring a card back. */
  const discardedTools = useRef(new Set<string>())
  const steers = useRef<Steer[]>([])
  /** Settles once every steer frame written so far has reached the CLI (or failed). */
  const steerWrites = useRef<Promise<void>>(Promise.resolve())
  /** A steer came back and goes out as an ordinary message once the turn is over. */
  const [resendPending, setResendPending] = useState(false)
  const resending = useRef(false)
  /**
   * The queued bubbles of returned steers whose group has not gone out yet, while
   * an earlier group's turn runs: shown last, below that message and its reply,
   * so the chat reads in the order things are sent. Null outside a resend.
   */
  const [queuedLast, setQueuedLast] = useState<ReadonlySet<string> | null>(null)
  // Reordered once per change, so the list keeps its identity between renders.
  const shown = useRef<{ messages: ChatMessage[]; queuedLast: ReadonlySet<string> | null; value: ChatMessage[] }>()
  if (shown.current?.messages !== messages || shown.current.queuedLast !== queuedLast) {
    const queued = queuedLast?.size ? messages.filter(message => queuedLast.has(message.id)) : []
    shown.current = { messages, queuedLast, value: queued.length ? [...messages.filter(message => !queuedLast!.has(message.id)), ...queued] : messages }
  }
  const shownMessages = shown.current.value
  /** The user chose Stop at the context-full question; the turn is ending at their word. Cleared by the next turn. */
  const contextStopped = useRef(false)
  /** Text handed back to the composer (undelivered steers after Stop or a reset, a resend that was refused). */
  const [draft, setDraft] = useState<{ text: string; attachments?: AttachmentRef[] }>()
  const restoreDraft = useCallback((texts: string[], attachments?: AttachmentRef[]) => {
    // A new object each time: the composer puts it before whatever it holds then.
    if (texts.length || attachments?.length) setDraft({ text: resendText(texts.filter(Boolean)), ...(attachments?.length ? { attachments } : {}) })
  }, [])
  /** Undelivered steers come back to the desktop when the turn ends: the CLI adds nothing after that. */
  const returnUndelivered = useCallback(() => {
    let returned = false
    for (const steer of steers.current) if (steer.state !== 'returned') { steer.state = 'returned'; returned = true }
    if (returned) setResendPending(true)
  }, [])
  const endTurnStream = () => { streamLog.current = []; discardedTools.current.clear() }

  /** Streamed text not on screen yet, the time of its first chunk, and when the next render may start. */
  const heldText = useRef<{ text: string; at: number } | null>(null)
  const textTimer = useRef<ReturnType<typeof setTimeout>>()
  const textRender = useRef({ startedAt: 0, nextAt: 0 })
  const showHeldText = useCallback(() => {
    if (textTimer.current !== undefined) { clearTimeout(textTimer.current); textTimer.current = undefined }
    const held = heldText.current
    if (!held) return
    heldText.current = null
    const append = assistantTextUpdate(activeAssistant, held.text, held.at, id)
    recordStreamed(streamLog.current, append ? activeAssistant.current : null, held.text.length)
    if (!append) return
    textRender.current.startedAt = performance.now()
    setActivity('Generating…')
    setMessages(append)
  }, [])
  useEffect(() => {
    const render = textRender.current
    if (!render.startedAt) return
    const now = performance.now()
    render.nextAt = now + textRenderPause(now - render.startedAt)
    render.startedAt = 0
  }, [messages])
  const holdText = useCallback((text: string, at: number) => {
    if (heldText.current) heldText.current.text += text
    else heldText.current = { text, at }
    const wait = textRender.current.nextAt - performance.now()
    if (wait <= 0 && !textRender.current.startedAt) showHeldText()
    else textTimer.current ??= setTimeout(() => { textTimer.current = undefined; showHeldText() }, Math.max(wait, 16))
  }, [showHeldText])

  const stop = useCallback((afterStop?: () => Promise<void>) => {
    showHeldText()
    configurationVersion.current++
    acceptingEvents.current = false
    setApproval(null)
    // The question dies with the CLI. So do its background shells, and cli-exit
    // is no longer accepted to report that, so mark them stopped here.
    setContextFull(null)
    setBackgroundTasks(current => stoppedTasks(current))
    return lifecycle.current.cancel(() => isTauri() ? stopSession() : Promise.resolve(), afterStop)
  }, [setApproval, showHeldText])

  const discardUnsentTurn = useCallback(() => {
    const turn = pendingTurn.current
    if (turn && !turn.dispatched) setMessages((current) => current.filter((message) => message.id !== turn.id))
    pendingTurn.current = null
  }, [])

  const addSystem = useCallback((content: string, role: 'system' | 'error' = 'system', metadata?: ChatMessage['metadata']) => {
    setMessages((current) => [...current, { id: id(), role, content, timestamp: Date.now(), ...(metadata ? { metadata } : {}) }])
  }, [])
  /** A CLI or start error. A session open in another G-Code process is said plainly, with New chat. */
  const addCliError = useCallback((error: string) => {
    const lock = sessionLock(error)
    if (lock?.lost) {
      if (lostSession.current === lock.sessionId) return
      lostSession.current = lock.sessionId; setLockLostSessionId(lock.sessionId)
      sending.current = false; setStreaming(false); setActivity(''); setApproval(null); setContextFull(null)
    }
    if (lock) addSystem(sessionLockMessage(lock), 'error', lock.lost ? { action: 'resume-session', sessionId: lock.sessionId } : { action: 'new-chat' })
    else addSystem(error, 'error')
  }, [addSystem, setApproval])

  useEffect(() => {
    if (!isTauri()) return
    const unlisten: UnlistenFn[] = []
    let disposed = false
    let typedToolEvents = false
    // Any other event comes after the text before it, as the CLI sent them.
    const subscribe = (event: string, handler: (event: { payload: EventPayload }) => void) => listen<EventPayload>(event, (message) => { if (message.payload.kind !== 'assistant-text') showHeldText(); handler(message) }).then((callback) => {
      if (disposed) callback()
      else unlisten.push(callback)
    })
    const setup = Promise.all([
      subscribe('cli-output', ({ payload }) => {
        if (!acceptingEvents.current) return
        const kind = String(payload.kind ?? 'text')
        const text = String(payload.text ?? '')
        if (kind === 'session-started') {
          if (payload.sessionId) {
            activeSessionId.current = String(payload.sessionId)
            // IPC may dispatch the first prompt before this startup frame is
            // delivered. Adopt its durable identity once it actually arrives.
            if (incompleteTurn.current?.dispatched) resumeId.current = activeSessionId.current
            setSessionId(activeSessionId.current)
          }
          return
        }
        if (kind === 'status') { if (sending.current) setActivity(text); return }
        if (kind === 'system') { if (text) { if (sessionLock(text)) addCliError(text); else addSystem(text) } return }
        if (kind === 'generation-complete') {
          incompleteTurn.current = null
          endTurnStream(); returnUndelivered()
          sending.current = false
          const complete = assistantCompleteUpdate(activeAssistant)
          if (complete) setMessages(complete)
          setStreaming(false)
          setActivity('')
          return
        }
        if (kind !== 'assistant-text' || !text) return
        holdText(text, Number(payload.timestamp ?? Date.now()))
      }),
      subscribe('cli-runtime-state', ({ payload }) => {
        if (!acceptingEvents.current) return
        if (payload.kind === 'model') {
          setModelRuntime(payload as unknown as ModelRuntimeStatus)
          if (sending.current) setActivity(payload.phase === 'ready' ? 'Preparing response…' : String(payload.message ?? 'Loading model…'))
        }
        if (payload.kind === 'inference') {
          const metrics = payload as unknown as InferenceMetrics
          setInferenceMetrics(metrics)
          setGenerationSpeed(previous => nextGenerationSpeed(previous, metrics))
        }
      }),
      subscribe('cli-tool-state', ({ payload }) => {
        if (!acceptingEvents.current || typeof payload.id !== 'string' || typeof payload.name !== 'string' || !Object.hasOwn(TOOL_LABELS, String(payload.state))) return
        if (discardedTools.current.has(payload.id)) return
        typedToolEvents = true
        const progress = payload as unknown as ToolProgress
        setTools(current => mergeToolProgress(current, progress))
        if (sending.current) setActivity(`${progress.name} · ${terminalTool(progress.state) ? TOOL_LABELS[progress.state] : progress.detail || TOOL_LABELS[progress.state]}`)
      }),
      subscribe('cli-session-state', ({ payload }) => {
        if (!acceptingEvents.current) return
        if ((payload.type === 'network_incident' || payload.type === 'network-decision') && payload.incident && typeof payload.incident === 'object') {
          const incident = payload.incident as NetworkIncident
          if (typeof incident.id === 'string' && typeof incident.destination === 'string' && typeof incident.path === 'string') {
            const resuming = payload.type === 'network-decision' && incident.decision === 'continue'
            setNetwork(incident); setNetworkOpen(!incident.decision); setApproval(null); setContextFull(null); sending.current = resuming; setStreaming(resuming); setActivity(resuming ? 'Continuing…' : ''); setBackgroundTasks(tasks => stoppedTasks(tasks))
          }
        }
        if ((payload.type === 'budget-status' || payload.type === 'budget-reached') && payload.budget && typeof payload.budget === 'object') {
          const next = payload.budget as SessionBudget
          if (next.phase === 'held' && (budgetRef.current?.stage !== next.stage || budgetRef.current?.phase !== 'held')) setBudgetOpen(true)
          if (next.phase === 'active') setBudgetOpen(false)
          setBudget(next)
        }
        if (payload.type === 'context-status') setContext(payload as unknown as ContextStatus)
        if (payload.type === 'outputs' && Array.isArray(payload.outputs)) setOutputs(payload.outputs as SessionOutput[])
        if (payload.type === 'controls') setRuntimePermission(payload.permission as SessionPermission)
        if (payload.type === 'tasks' && Array.isArray(payload.tasks)) setBackgroundTasks(payload.tasks as BackgroundShellInfo[])
        if (payload.type === 'workflow-state' || payload.type === 'workflow-done') setWorkflowRuns(runs => mergeWorkflowEvent(runs, payload))
        if (payload.type === 'approval-queue' && Array.isArray(payload.pending)) {
          setApprovalQueue(payload.pending.flatMap(item => { const request = item && typeof item === 'object' ? parseToolApproval(item as Record<string, unknown>) : null; return request ? [request] : [] }))
        }
      }),
      subscribe('cli-turn-event', ({ payload }) => {
        if (!acceptingEvents.current) return
        // A turn the CLI started by itself: the conversation is busy again until it completes.
        if (payload.type === 'turn-started' && typeof payload.source === 'string' && TURN_STARTED[payload.source]) {
          addSystem(TURN_STARTED[payload.source]!)
          sending.current = true; setStreaming(true); setActivity('Continuing…')
          return
        }
        const steer = parseSteerEvent(payload)
        if (steer) {
          const entry = steers.current.find(item => item.id === steer.id)
          // Already handed back (the turn ended first), or not this conversation's.
          if (!entry || entry.state === 'returned') return
          if (steer.state === 'queued') entry.state = 'queued'
          else if (steer.state === 'returned') { entry.state = 'returned'; setResendPending(true) }
          else {
            // In the conversation from here: it moves after what the model saw before it,
            // and the reply continues below it in a new message.
            steers.current = steers.current.filter(item => item !== entry)
            const at = Date.now(), active = activeAssistant.current
            activeAssistant.current = null
            setMessages(current => current.map(message => message.id === entry.id ? { ...message, pending: false, timestamp: at } : message.id === active ? { ...message, streaming: false } : message))
            setHistory(current => [...current, entry.text])
          }
          return
        }
        const restart = parseReplyRestart(payload)
        if (!restart) return
        // The discarded reply's text and tool cards go; the replay streams in their place.
        const trim = streamedTrimUpdate(activeAssistant, streamLog.current, restart.text)
        if (trim) setMessages(trim)
        if (restart.tools.length) {
          const gone = new Set(restart.tools)
          gone.forEach(toolId => discardedTools.current.add(toolId))
          setTools(current => current.some(tool => gone.has(tool.id)) ? current.filter(tool => !gone.has(tool.id)) : current)
        }
        if (sending.current) setActivity(replyRestartStatus(restart))
      }),
      subscribe('cli-context-full', ({ payload }) => {
        const request = acceptingEvents.current ? parseContextFull(payload) : null
        if (request) setContextFull(request)
      }),
      subscribe('cli-handoff', ({ payload }) => {
        if (!acceptingEvents.current || typeof payload.summary !== 'string' || typeof payload.path !== 'string') return
        setContextFull(null)
        const attachments = attachmentRefsFrom(payload.attachments)
        setHandoff({ summary: payload.summary, path: payload.path, sessionId: String(payload.sessionId ?? ''), request: typeof payload.request === 'string' ? payload.request : undefined, calibration: tokenCalibration(payload.calibration), stalls: typeof payload.stalls === 'number' && Number.isInteger(payload.stalls) && payload.stalls > 0 ? payload.stalls : undefined, ...(attachments?.length ? { attachments } : {}) })
      }),
      subscribe('cli-tool-use', ({ payload }) => {
        if (!acceptingEvents.current || typedToolEvents) return
        if (activeAssistant.current) {
          const active = activeAssistant.current
          setMessages((current) => current.map((message) => message.id === active ? { ...message, streaming: false } : message))
          activeAssistant.current = null
        }
        const toolId = String(payload.id ?? id())
        setTools((current) => current.some(tool => tool.id === toolId) ? current : [...current, { id: toolId, name: String(payload.name ?? 'Tool'), state: 'running', input: payload.input, startedAt: Date.now() }])
      }),
      subscribe('cli-tool-result', ({ payload }) => {
        if (!acceptingEvents.current || typedToolEvents) return
        const toolId = payload.id ? String(payload.id) : null
        const name = String(payload.name ?? 'Tool')
        setTools((current) => {
          let index = toolId ? current.findIndex((tool) => tool.id === toolId) : -1
          if (index < 0) {
            for (let candidate = current.length - 1; candidate >= 0; candidate--) {
              if (current[candidate]?.name === name && current[candidate]?.state === 'running') { index = candidate; break }
            }
          }
          if (index < 0) return [...current, { id: id(), name, state: payload.success === false ? 'failed' : 'complete', output: payload.output, error: payload.error ? String(payload.error) : undefined, startedAt: Date.now(), completedAt: Date.now() }]
          return current.map((tool, toolIndex) => toolIndex === index && !terminalTool(tool.state) ? { ...tool, state: payload.success === false ? 'failed' : 'complete', output: payload.output, error: payload.error ? String(payload.error) : undefined, completedAt: Date.now() } : tool)
        })
      }),
      subscribe('cli-tool-approval', ({ payload }) => {
        if (!acceptingEvents.current) return
        const request = parseToolApproval(payload)
        if (request) setApproval(request)
      }),
      subscribe('cli-approval-withdrawn', ({ payload }) => {
        if (acceptingEvents.current && approvalRef.current?.requestId === payload.requestId) setApproval(null)
      }),
      subscribe('cli-error', ({ payload }) => {
        if (!acceptingEvents.current) return
        const error = String(payload.message ?? 'CLI error')
        const completedAt = Date.now()
        const complete = assistantCompleteUpdate(activeAssistant)
        if (complete) setMessages(complete)
        setTools((current) => current.map((tool) => !terminalTool(tool.state) ? { ...tool, state: 'failed', error, completedAt } : tool))
        setApproval(null); setContextFull(null); endTurnStream(); returnUndelivered()
        addCliError(error); sending.current = false; setStreaming(false); setActivity('')
      }),
      subscribe('cli-exit', ({ payload }) => {
        if (!acceptingEvents.current) return
        const unsent = pendingTurn.current
        lifecycle.current.exited(); discardUnsentTurn(); endTurnStream(); returnUndelivered()
        if (unsent?.typed && !unsent.dispatched) restoreDraft([unsent.text], unsent.attachments)
        const complete = assistantCompleteUpdate(activeAssistant)
        if (complete) setMessages(complete)
        // Nothing more will come for what was running: a card or Tasks row must not count on for good
        // (a running Agent or Workflow also keeps the Mac awake). As on resume, from the saved record.
        const endedAt = Date.now()
        setTools(current => current.some(tool => !terminalTool(tool.state)) ? current.map(tool => terminalTool(tool.state) ? tool : { ...tool, state: 'cancelled', error: 'The process ended before this call settled', completedAt: endedAt }) : current)
        setSessionRunning(false); sending.current = false; setStreaming(false); setActivity(''); setApproval(null); setContextFull(null)
        // The CLI's background shells ended with it.
        setBackgroundTasks(current => stoppedTasks(current))
        if (payload.success === false) addSystem(`CLI exited unexpectedly${payload.code != null ? ` (code ${String(payload.code)})` : ''}. Send another message to restart.`, 'error')
      }),
    ]).then(() => {})
    listenersReady.current = setup
    void setup.catch((error) => { if (!disposed) addSystem(`Could not subscribe to CLI events: ${String(error)}`, 'error') })
    return () => { disposed = true; unlisten.forEach((callback) => callback()); void stop().catch(() => {}) }
  }, [addSystem, addCliError, stop, discardUnsentTurn, returnUndelivered, restoreDraft, holdText, showHeldText])

  const resetConversation = useCallback(() => {
    conversationVersion.current++
    handoffCalibration.current = undefined; handoffSessionId.current = undefined; lostSession.current = null; setLockLostSessionId(null)
    activeAssistant.current = null; sending.current = false; pendingTurn.current = null; incompleteTurn.current = null
    resumeId.current = undefined; activeSessionId.current = undefined; contextStopped.current = false
    // Text that never reached this conversation goes back to the composer.
    restoreDraft(steers.current.map(steer => steer.text)); steers.current = []; setResendPending(false); setQueuedLast(null); endTurnStream()
    setSessionRunning(false); setStreaming(false); setActivity(''); setApproval(null)
    setModelRuntime(null); setInferenceMetrics(null); setGenerationSpeed(null)
    setNetwork(null); setNetworkOpen(false)
    setBudget(null); setBudgetOpen(false)
    setContext(null); setOutputs([]); setRuntimePermission(null); setContextFull(null); setBackgroundTasks([])
    setMessages([]); setTools([]); setWorkflowRuns({}); setHistory([]); setSessionId('boot-0000')
  }, [restoreDraft])

  useEffect(() => {
    const next = configurationKey(provider, model, ollamaHost, localModelPath, localRuntimePath, cwd, environment)
    if (configuration.current === next) return
    configuration.current = next
    resetConversation()
    const cancelled = stop()
    const version = configurationVersion.current
    void cancelled.catch((error) => { if (version === configurationVersion.current) addSystem(String(error), 'error') })
  }, [provider, model, ollamaHost, localModelPath, localRuntimePath, cwd, environment, addSystem, stop, resetConversation])

  const launchSession = useCallback(async () => {
    const version = configurationVersion.current
    const blocked = executionBlockReason(environment)
    if (blocked) throw new Error(blocked)
    if (!cwd) throw new Error('Open a project folder before starting a session.')
    if ((provider === 'ollama' || provider === 'local') && !model.trim()) throw new Error('Choose a local model in Provider (⌘P) before sending a message.')
    acceptingEvents.current = true
    try {
      await startSession(provider, model, cwd, resumeId.current, ollamaHost, localModelPath, localRuntimePath, environment, localContext, resumeId.current ? undefined : tokenCalibration(handoffCalibration.current, model), resumeId.current ? undefined : handoffSessionId.current)
      handoffCalibration.current = undefined; handoffSessionId.current = undefined
      if (version === configurationVersion.current) setSessionRunning(true)
    } catch (error) {
      if (version === configurationVersion.current) acceptingEvents.current = false
      throw error
    }
  }, [provider, model, ollamaHost, localModelPath, localRuntimePath, cwd, environment, localContext])

  const previousLocalContext = useRef(localContext)
  useEffect(() => {
    if (previousLocalContext.current === localContext) return
    previousLocalContext.current = localContext
    if (provider !== 'local') return
    const restart = sessionRunning
    resumeId.current = activeSessionId.current ?? resumeId.current
    setModelRuntime(null); setInferenceMetrics(null); setGenerationSpeed(null); setSessionRunning(false)
    discardUnsentTurn(); sending.current = false; setStreaming(false); setActivity('')
    const cancelled = stop()
    const version = configurationVersion.current
    void cancelled.then(async () => {
      if (restart && version === configurationVersion.current) await lifecycle.current.ensure(launchSession, listenersReady.current)
    }).catch(error => { if (version === configurationVersion.current) addSystem(String(error), 'error') })
  }, [localContext, provider, sessionRunning, stop, launchSession, addSystem, discardUnsentTurn])

  const newSession = useCallback(async () => {
    const cancelled = stop()
    const version = configurationVersion.current
    resetConversation()
    try { await cancelled } catch (error) { if (version === configurationVersion.current) addSystem(String(error), 'error') }
  }, [stop, resetConversation, addSystem])

  /** Resolves true once the text was handed to the CLI; false when it was refused, cancelled or failed. */
  /** `options.handoff`: this is the continuation of that handoff, the one message that may start the session taking over. */
  /** `options.resent`: the composer's resend of returned steers; it hands refused text back itself. */
  /** `options.attachments`: files attached in the composer; they go back to it with the text when the message cannot be sent. */
  const send = useCallback(async (text: string, options: { handoff?: SessionHandoff; resent?: boolean; attachments?: AttachmentRef[] } = {}): Promise<boolean> => {
    const typed = !options.handoff && !options.resent
    // The composer cleared itself when it handed this over. A typed message with files that is not
    // sent goes back to it, files and all: they exist nowhere else. (Text alone keeps its behaviour.)
    const refused = () => { if (typed && options.attachments?.length) restoreDraft([text], options.attachments); return false }
    if (sending.current) return refused()
    if (lostSession.current) return refused()
    if (networkRef.current && !networkRef.current.decision) { setNetworkOpen(true); return refused() }
    if (budgetRef.current && budgetRef.current.phase !== 'active' && !options.handoff) { setBudgetOpen(true); return refused() }
    if ((budgetRef.current || normalizeBudget(budgetSettings).enabled) && budgetModelProblem(provider, model, provider !== 'ollama' || localBudgetEndpoint(ollamaHost))) { addSystem(budgetModelProblem(provider, model, provider !== 'ollama' || localBudgetEndpoint(ollamaHost))!, 'error'); return refused() }
    // Only the continuation itself may start the session that takes over from a handoff.
    if (handoffStarting.current && !options.handoff) { addSystem(`${HANDOFF_STARTING} Send your message once it has started.`); return refused() }
    const blocked = executionBlockReason(environment)
    if (blocked) { addSystem(blocked, 'error'); return refused() }
    if (resetsConversation(text)) { await newSession(); return false }
    const commandOnly = /^\/(compact|context)(?:\s|$)/.test(text)
    if (!cwd) { addSystem('Open a project folder before sending a message.', 'error'); return refused() }
    if ((provider === 'ollama' || provider === 'local') && !model.trim()) {
      addSystem('Choose a local model in Provider (⌘P) before sending a message.', 'error')
      return refused()
    }
    const version = configurationVersion.current
    const conversation = conversationVersion.current
    let started: PendingTurn | undefined
    sending.current = true
    contextStopped.current = false
    setStreaming(true)
    setActivity('Preparing response…')
    try {
      // A Stop may still be restoring durable history. Wait before adding this
      // prompt, so the old snapshot cannot replace a newly submitted turn.
      await lifecycle.current.settled()
      if (version !== configurationVersion.current || conversation !== conversationVersion.current) throw new SessionCancelledError()
      const attachments = options.attachments?.length ? options.attachments : undefined
      const turn: PendingTurn = { id: id(), text, ...(attachments ? { attachments } : {}), dispatched: false, historyAdded: false, typed: typed && !commandOnly }
      started = turn
      pendingTurn.current = turn; incompleteTurn.current = turn
      if (!commandOnly) setMessages((current) => [...current, { id: turn.id, role: 'user', content: text, timestamp: Date.now(), ...(attachments ? { metadata: { attachments } } : {}) }])
      if (!isTauri()) {
        addSystem('CLI integration is available in the Tauri app. Run `bun run tauri dev` to start a native session.')
        pendingTurn.current = null; incompleteTurn.current = null; sending.current = false; setStreaming(false); setActivity('')
        return false
      }
      handoffCalibration.current = tokenCalibration(options.handoff?.calibration, model)
      handoffSessionId.current = options.handoff?.sessionId
      await lifecycle.current.run(launchSession, async () => {
        if (version !== configurationVersion.current) throw new SessionCancelledError()
        turn.dispatched = true
        // Keep the same saved session after Stop, including while send IPC is
        // still acknowledging a prompt already handed to the backend.
        resumeId.current = activeSessionId.current ?? resumeId.current
        await sendMessage(`/session-controls ${permission} ${effort}`)
        await sendMessage(text, attachments?.map(attachment => attachment.path))
        // A message that picks a handoff up (its continuation, or the retry a notice suggests) settles that notice only.
        setHandoffNotices((notices) => settleHandoffNotices(notices, text, options.handoff && handoffKey(options.handoff)))
        if (conversation === conversationVersion.current) {
          turn.historyAdded = true
          if (!commandOnly && text) setHistory((current) => [...current, text])
        }
        if (pendingTurn.current === turn) pendingTurn.current = null
      }, listenersReady.current)
      return true
    } catch (error) {
      if (version === configurationVersion.current) {
        if (!(error instanceof SessionCancelledError)) addCliError(String(error))
        if (provider === 'local') setModelRuntime({ phase: 'failed', message: String(error) })
        discardUnsentTurn(); sending.current = false; setStreaming(false); setActivity('')
        // It never reached the CLI, and the composer was cleared: the text exists nowhere else.
        if (typed && !started?.dispatched && !(error instanceof SessionCancelledError)) restoreDraft([text], options.attachments)
      }
      return false
    }
  }, [permission, effort, launchSession, addSystem, addCliError, provider, model, cwd, environment, newSession, discardUnsentTurn, budgetSettings, restoreDraft])

  const abort = useCallback(async () => {
    // Both model loading and active generation need a full stop barrier. A
    // signal alone returns before the CLI exits and can consume the next send.
    if (provider === 'local') setModelRuntime({ phase: 'cancelled', message: 'Stopped by user; send a message to reload' })
    setInferenceMetrics(null)
    const turn = incompleteTurn.current
    const savedId = resumeId.current
    const conversation = conversationVersion.current
    const version = configurationVersion.current + 1
    incompleteTurn.current = null
    // Stop ends the turn without starting another: undelivered steers go back to the composer.
    // Which ones is known once the CLI has saved: one it took just before Stop (its
    // 'delivered' event is no longer accepted) is in the saved turn already.
    const unsettled = steers.current.map(({ text, at }) => ({ text, at }))
    let handedBack = false
    const handBack = (saved?: ChatMessage[], first: string[] = [], attachments?: AttachmentRef[]) => { if (!handedBack) { handedBack = true; restoreDraft([...first, ...unsavedSteers(unsettled, saved)], attachments) } }
    steers.current = []; setResendPending(false); endTurnStream()
    setMessages((current) => current.some(message => message.pending) ? current.filter(message => !message.pending) : current)
    const cancelled = stop(async () => {
      let restored: ReturnType<typeof savedConversation> | undefined
      let restoreError: unknown
      if (savedId && cwd && isTauri()) {
        try { restored = savedConversation(await loadSavedSession(savedId, cwd), savedId, cwd, provider) }
        catch (error) { restoreError = error }
      }
      const here = version === configurationVersion.current && conversation === conversationVersion.current
      // The turn was not saved and goes from the chat below, so its words go back to the composer with
      // the rest (not when the user has moved on from this chat by choice).
      const giveBack = here && !restored && !!turn?.typed
      // Even when the user has moved on: steers exist nowhere else.
      handBack(restored?.messages, giveBack ? [turn!.text] : [], giveBack ? turn!.attachments : undefined)
      if (!here) return
      if (restored) {
        setMessages(restored.messages)
        setHistory(restored.history)
      } else {
        setMessages((current) => beforeInterruptedTurn(current, turn?.id))
        if (turn?.historyAdded) setHistory((current) => current.slice(0, -1))
      }
      setTools((current) => current.map((tool) => !terminalTool(tool.state) ? { ...tool, state: 'cancelled', error: 'Stopped by user', completedAt: Date.now() } : tool))
      addSystem(restored
        ? 'Stopped. Saved progress is restored; any interrupted turn is marked incomplete.'
        : giveBack ? 'Stopped. The unfinished turn was not saved and has been removed. Your message is back in the composer.' : 'Stopped. The unfinished turn was not saved and has been removed.')
      if (restoreError) addSystem(`Could not restore saved conversation: ${String(restoreError)}`, 'error')
    })
    discardUnsentTurn()
    activeSessionId.current = resumeId.current
    setSessionId(resumeId.current ?? 'boot-0000')
    setSessionRunning(false); setStreaming(false); setActivity(''); setApproval(null); sending.current = false
    if (activeAssistant.current) {
      const active = activeAssistant.current
      setMessages((current) => current.map((message) => message.id === active ? { ...message, streaming: false } : message))
      activeAssistant.current = null
    }
    try { await cancelled } catch (error) { if (version === configurationVersion.current) addSystem(String(error), 'error') }
    // The stop failed before anything was restored: nothing tells which steers the CLI took, so all come back.
    handBack()
  }, [addSystem, stop, discardUnsentTurn, cwd, provider, restoreDraft])

  const clear = newSession
  const resumeSession = useCallback(async (id: string) => {
    if (!isTauri()) return
    if (!cwd) { addSystem('Open this session’s project folder before resuming.', 'error'); return }
    const cancelled = stop()
    const version = configurationVersion.current
    const call = ++restoreCall.current
    resetConversation(); sending.current = true; setStreaming(true); setRestoring(true); setActivity('Preparing response…')
    try {
      await cancelled
      if (version !== configurationVersion.current) return
      const saved = await loadSavedSession(id, cwd)
      if (version !== configurationVersion.current) return
      const restored = savedConversation(saved, id, cwd, provider)
      resumeId.current = id
      activeSessionId.current = id
      setContext(saved.contextStatus ? { ...saved.contextStatus, usageTotals: saved.usageTotals ?? saved.contextStatus.usageTotals } : null); setOutputs(saved.outputs ?? []); setWorkflowRuns({}); setTools(savedTools(saved)); setRuntimePermission(saved.permissionContext?.mode ?? 'default')
      setNetwork(saved.networkHold?.incident ?? null); setNetworkOpen(saved.networkHold?.phase === 'held')
      setBudget(saved.budget ?? null); setBudgetOpen(false)
      setMessages(restored.messages)
      setHistory(restored.history)
      setSessionId(id)
      // Browsing saved chats does not start a model process; send() resumes it lazily.
    } catch (error) {
      if (version === configurationVersion.current && !(error instanceof SessionCancelledError)) {
        acceptingEvents.current = false; setSessionRunning(false); addSystem(String(error), 'error')
      }
    } finally {
      if (call === restoreCall.current) setRestoring(false)
      if (version === configurationVersion.current) { sending.current = false; setStreaming(false); setActivity('') }
    }
  }, [provider, cwd, launchSession, stop, resetConversation, addSystem])
  const answerContextFull = useCallback(async (choice: ContextFullChoice) => {
    const request = contextFull
    if (!request) return
    setContextFull(null)
    // Until the CLI reports more, say what the choice is doing now (the question paused the turn).
    const activity = choice === 'handoff' ? HANDOFF_WRITING : choice === 'compact' ? CONTEXT_COMPACTING : ''
    if (activity) setActivity(activity)
    // Stop here ends the turn as the Stop button does: steers it did not take go back to
    // the composer instead of starting a turn the user just declined. Marked before the
    // answer goes out, since the CLI hands them back as soon as it has it.
    const stopping = choice === 'stop'
    if (stopping) { contextStopped.current = true; for (const steer of steers.current) steer.composer = true }
    try { await respondContextFull(request.requestId, choice) }
    catch (error) {
      // The CLI never got the answer, so nothing is being written or compacted.
      if (activity) setActivity((current) => current === activity ? '' : current)
      if (stopping) { contextStopped.current = false; for (const steer of steers.current) delete steer.composer }
      addSystem(String(error), 'error')
    }
  }, [contextFull, addSystem])

  const stopTask = useCallback(async (taskId: string) => {
    try { await stopBackgroundTask(taskId) }
    catch (error) { addSystem(String(error), 'error') }
  }, [addSystem])

  // The handoff effect calls the latest send(), not the one from the render that
  // saw the handoff: starting the new session re-renders with fresh state.
  const sendRef = useRef(send)
  sendRef.current = send

  /** The composer's send while a turn runs: the text joins this turn at its next safe point, or goes out as a message after it. */
  const steer = useCallback(async (text: string): Promise<boolean> => {
    if (!sending.current) return sendRef.current(text)
    if (lostSession.current) return false
    if (handoffStarting.current) { addSystem(`${HANDOFF_STARTING} Send your message once it has started.`); return false }
    if (networkRef.current && !networkRef.current.decision) { setNetworkOpen(true); return false }
    const entry: Steer = { id: id(), text, state: 'sending', at: Date.now(), ...(contextStopped.current ? { composer: true } : {}) }
    steers.current = [...steers.current, entry]
    setMessages(current => [...current, { id: entry.id, role: 'user', content: text, timestamp: Date.now(), pending: true }])
    const handBack = () => { if (steers.current.includes(entry) && entry.state !== 'returned') { entry.state = 'returned'; setResendPending(true) } }
    if (!isSteerableText(text) || !acceptingEvents.current || !isTauri()) { handBack(); return true }
    const write = sendSteer(entry.id, text)
    steerWrites.current = steerWrites.current.then(() => write.then(() => {}, () => {}))
    try { await write } catch { handBack() }
    return true
  }, [addSystem])

  // A returned steer goes out once, as an ordinary message, when the turn is
  // over (not during a handoff's takeover: its reset hands the text back to the composer).
  // A command goes out alone and the texts after it wait for its turn to end, so
  // each runs as it would have if typed between turns.
  useEffect(() => {
    if (!resendPending || streaming || handoff || handoffFrom || resending.current) return
    resending.current = true
    const leave = (gone: Steer[]) => {
      steers.current = steers.current.filter(steer => !gone.includes(steer))
      const ids = new Set(gone.map(steer => steer.id))
      setMessages(current => current.filter(message => !ids.has(message.id)))
    }
    void (async () => {
      try {
        for (;;) {
          // A frame still being written must reach the CLI before the message that follows it.
          await steerWrites.current
          // A turn runs; when it is over `streaming` turns false and this runs again for the rest.
          if (sending.current) return
          const kept = steers.current.filter(steer => steer.state === 'returned' && steer.composer)
          if (kept.length) { leave(kept); restoreDraft(kept.map(steer => steer.text)) }
          const returned = steers.current.filter(steer => steer.state === 'returned')
          const group = returned.slice(0, nextResendCount(returned.map(steer => steer.text)))
          if (!group.length) { setResendPending(false); setQueuedLast(null); return }
          leave(group)
          // The texts after this group wait below its message and reply.
          const waiting = returned.slice(group.length).map(steer => steer.id)
          setQueuedLast(waiting.length ? new Set(waiting) : null)
          const text = resendText(group.map(steer => steer.text))
          const conversation = conversationVersion.current
          if (await sendRef.current(text, { resent: true })) continue
          // Refused: this and every text after it go back to the composer, in order. A new
          // chat (/clear, /reset) is not a refusal: send() ran it, and its reset already
          // handed the rest back. Whether it ran is told by the reset itself, not by the
          // text alone: a /clear that send() refused before running it (a lost session, a
          // held budget) goes back like any other refused text.
          const reset = resetsConversation(text) && conversation !== conversationVersion.current
          const rest = steers.current.filter(steer => steer.state === 'returned')
          leave(rest)
          restoreDraft([...reset ? [] : group, ...rest].map(steer => steer.text))
          setResendPending(false); setQueuedLast(null)
          return
        }
      } finally { resending.current = false }
    })()
  }, [resendPending, streaming, handoff, handoffFrom, restoreDraft])

  // After a handoff the turn completes; then a new session in the same folder
  // starts with the handoff as its first message. Other sends are refused until
  // then (the composer says why), and a continuation that does not reach the
  // new session (it failed, or another chat, Stop or a settings change moved
  // on) leaves a notice of where the handoff is saved, so nothing is lost silently.
  useEffect(() => {
    if (!handoff || streaming) return
    const next = handoff
    setHandoff(null)
    setHandoffFrom(next)
    handoffStarting.current = true
    void (async () => {
      let dispatched = false
      try {
        // newSession() stops the CLI and resets synchronously; anything that
        // moves on from here (another chat, a project, Stop) cancels the takeover.
        const reset = newSession()
        const conversation = conversationVersion.current, version = configurationVersion.current
        const current = () => conversation === conversationVersion.current && version === configurationVersion.current
        await reset
        if (await waitUntil(() => !sending.current, { cancelled: () => !current() })) {
          const attachments = next.budgetHandoff ? attachmentRefsFrom(next.budgetHandoff.attachments) : next.attachments
          dispatched = await sendRef.current(next.budgetHandoff ? budgetContinuation(next.budgetHandoff, next.sessionId) : handoffContinuation(next.summary, next.path, next.sessionId, next.request, next.stalls), { handoff: next, ...(attachments?.length ? { attachments } : {}) })
        }
      } catch { dispatched = false }
      finally {
        handoffStarting.current = false
        setHandoffFrom(null)
        // Not in the conversation: opening another chat replaces the messages after this.
        if (!dispatched) setHandoffNotices(notices => withHandoffNotice(notices, { path: handoffKey(next), message: handoffRetryMessage(next.path) }))
      }
    })()
  }, [handoff, streaming, newSession])

  const addBudget = useCallback(async (usd: number) => {
    if (sending.current || budgetRef.current?.phase !== 'held' || !Number.isFinite(usd) || usd <= 0) return
    sending.current = true
    setStreaming(true); setActivity('Adding budget…')
    const version = configurationVersion.current
    setBudgetOpen(false)
    try {
      await lifecycle.current.run(launchSession, () => {
        if (version !== configurationVersion.current) throw new SessionCancelledError()
        return sendMessage(`/budget-add ${usd}`)
      }, listenersReady.current)
    } catch (error) {
      if (version === configurationVersion.current) {
        sending.current = false; setStreaming(false); setActivity('')
        addCliError(String(error)); setBudgetOpen(true)
      }
    }
  }, [launchSession, addCliError])
  const continueBudget = useCallback((handoff: BudgetHandoff, previousSessionId: string) => {
    setBudgetOpen(false)
    setHandoff({ ...handoff, sessionId: previousSessionId, budgetHandoff: handoff })
  }, [])

  const respond = useCallback(async (allowed: boolean, allowAll: boolean, timedOut?: boolean, networkScope?: 'call' | 'session') => {
    const requestId = approval?.requestId
    if (!requestId || approvalRef.current?.requestId !== requestId) return
    setApproval(null)
    try { await respondToolApproval(requestId, allowed, allowAll, networkScope) }
    catch (error) { addSystem(String(error), 'error') }
    if (!allowed) addSystem(timedOut ? 'Tool approval timed out and was denied.' : 'Tool execution denied.')
  }, [approval?.requestId, addSystem, setApproval])

  /**
   * From the handoff on until the session that takes over has its continuation
   * (or the takeover ends): also the render between the end of the old turn and
   * the takeover's start, when `handoffFrom` is not set yet.
   */
  const decideNetwork = useCallback(async (choice: 'continue' | 'reject') => {
    const incident = networkRef.current
    if (sending.current || !incident || incident.decision || choice === 'continue' && !incident.canContinue) return
    sending.current = true
    setStreaming(true); setActivity('Saving decision…'); setNetworkOpen(false)
    const version = configurationVersion.current
    try {
      await lifecycle.current.run(launchSession, () => {
        if (version !== configurationVersion.current) throw new SessionCancelledError()
        return sendMessage(`/network-decision ${incident.id} ${choice}`)
      }, listenersReady.current)
    } catch (error) {
      if (version === configurationVersion.current) { sending.current = false; setStreaming(false); setActivity(''); addCliError(String(error)); setNetworkOpen(true) }
    }
  }, [launchSession, addCliError])
  const takeover = Boolean(handoffFrom || handoff)
  /** Why the composer cannot send right now (only the hook's own reasons; App adds the rest). From the handoff on, not just once the takeover starts. */
  const sendBlockedReason = networkIncident && !networkIncident.decision ? 'Network attempt blocked · Review the incident before continuing' : lockLostSessionId ? 'Resume this chat to load its latest saved progress, or start a new chat.' : takeover ? HANDOFF_STARTING : budget && budget.phase !== 'active' ? 'Budget reached · Choose how to continue' : (budget || normalizeBudget(budgetSettings).enabled) ? budgetModelProblem(provider, model, provider !== 'ollama' || localBudgetEndpoint(ollamaHost)) : undefined

  return { networkIncident, networkOpen, setNetworkOpen, decideNetwork, budget, budgetOpen, setBudgetOpen, addBudget, continueBudget, modelRuntime, inferenceMetrics, generationSpeed, context, outputs, runtimePermission, messages: shownMessages, tools, workflowRuns, history, streaming, restoring, activity, approval, approvalQueue, sessionRunning, sessionId, send, steer, resendPending, draft, abort, clear, newSession, resumeSession, respond, contextFull, answerContextFull, backgroundTasks, stopTask, handoffFrom, takeover, handoffNotices, dismissHandoffNotice, sendBlockedReason }
}
