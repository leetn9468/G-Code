import { currentGuard, NetworkStopped } from '../security/guard.js'
import { BudgetReached, sessionBudgetController } from '../session/budget.js'
import { ignoredProjectWorkflowSetting, workflowSettings } from '../workflow/settings.js'
import { frameJSON } from './frames.js'
import { cachePercent, sessionCacheRatio } from '../shared/cache.js'
import { terminalTextWriter } from './terminalText.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { workflowTasks, workflowResultMessage } from '../workflow/tasks.js'
import { EFFORTS, PERMISSIONS, type Effort, type SessionPermission } from '../shared/sessionControls.js'
import { saveSession } from '../state/store.js'
import { tidyInBackground } from '../session/leftovers.js'
import { resolveSlashCommand, turnInvocations, userCommandHelp } from './slashCommands.js'
/**
 * @file repl.ts
 * @brief Interactive REPL mode with full agent loop
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { parseContextChoice, parseInputMessage, parseSteerFrame, parseTaskControl, parseWorkflowControl } from './input.js'
import { ContextHandoff } from '../session/handoff.js'
import { backgroundShells } from '../tools/backgroundShells.js'
import { guardOutputStreams, isClosedOutputError, writeQuietly } from './headless.js'
import type { ContextFullChoice } from '../shared/execution.js'
import type { Store } from '../state/store.js'
import type { AppState } from '../types.js'
import { printBanner } from './branding.js'
import { QueryEngine, type AbortCause, type QueryEngineOptions } from '../engine/queryEngine.js'
import { ApprovalUnavailable } from '../engine/toolRunner.js'
import type { LLMClient } from '../llm/types.js'
import type { ReplyRestartEvent } from '../shared/runtimeEvents.js'
import { getTools } from '../tools/registry.js'
import { approvalReason } from '../tools/tool.js'
import { createEmptySessionContext } from '../types.js'
import { formatTodos, loadTodos } from '../tools/impl/TodoWriteTool.js'

// ============================================================================
// REPL
// ============================================================================

export interface REPLOptions {
  store: Store<AppState>
  llmClient?: LLMClient
  model?: string
  verbose?: boolean
}

/** Signals that end the session: input closes, running work is cancelled, background shells stop. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
/**
 * How long an unannounced end of input under the desktop waits for a signal sent with it (startREPL).
 * Short: the turn runs on meanwhile, and a tool takes longer than this to start another request.
 */
const UNANNOUNCED_END_WAIT_MS = 25

/**
 * Why a signal cancels the running turn, as the saved turn and the model are told. Ctrl-C (SIGINT)
 * is the user stopping. Under the desktop, SIGTERM is too: the app sends it only for the user's own
 * actions (Stop, a new chat, switching sessions, quitting). Any other signal (a closed terminal's
 * SIGHUP, SIGQUIT, or SIGTERM from outside the desktop) closes the session under the turn.
 */
export function signalAbortCause(signal: NodeJS.Signals, desktop: boolean): AbortCause {
  return signal === 'SIGINT' || (desktop && signal === 'SIGTERM') ? { by: 'user' } : { by: 'shutdown', signal }
}

/**
 * Input shaped like a command ("/name" then a space or the end), not any text that starts with "/":
 * a message that opens with a path such as /Users/x/file.ts goes to the model. The desktop's
 * isCommandText (desktop/src/components/chat/turnEvents.ts) uses the same pattern.
 */
export const COMMAND_TEXT = /^\/[A-Za-z][\w-]*(?:\s|$)/

export function isCommandText(input: string): boolean {
  return COMMAND_TEXT.test(input)
}

export function emitDesktopEvent(event: Record<string, unknown>): void {
  // Shutdown emits frames too (withdrawn approvals); a hung-up terminal must not stop it.
  writeQuietly(process.stdout, `\u001e${frameJSON(event)}\u001e`)
}

// ============================================================================
// Tool Approvals
// ============================================================================

interface PendingApproval { requestId: string; frame: Record<string, unknown>; resolve: (allowed: boolean) => void }

/**
 * Approvals waiting for an answer, keyed by requestId. Concurrent agents can
 * each wait on their own request without overwriting another's resolver.
 *
 * Only the oldest request is presented as a `tool-approval` frame;
 * the next one is presented when it settles. When more than one request is
 * waiting, an `approval-queue` frame lists them all, and a client can answer
 * any of them with `\x1e{"type":"approval","requestId":…,"allowed":…}\x1e`.
 */
export class ApprovalQueue {
  private pending: PendingApproval[] = []
  private presented: string | null = null
  private announced = 0

  constructor(
    private emit: (event: Record<string, unknown>) => void,
    private prompt: (frame: Record<string, unknown>, waiting: number) => void = () => {},
    private notice: (message: string) => void = () => {},
  ) {}

  get size(): number { return this.pending.length }
  get workflowPending(): boolean { return !!this.pending[0]?.frame.runId }

  request(toolName: string, reason: string, input?: Record<string, unknown>, signal?: AbortSignal, identity?: Omit<import('../tools/tool.js').ApprovalRequestOptions, 'signal'>): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    const requestId = randomUUID()
    reason = approvalReason(reason, identity?.workflowSource)
    const description = reason
    return new Promise<boolean>((resolve) => {
      // A cancelled agent's request leaves the queue so the next one can be shown.
      const onAbort = () => this.settle(requestId, false, true)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.push({
        requestId,
        frame: { type: 'tool-approval', requestId, toolName, reason, description, input, ...identity,
          // NotebookEdit names its file notebook_path.
          filePath: typeof (input?.file_path ?? input?.notebook_path) === 'string' ? escapeDisplayControls(String(input?.file_path ?? input?.notebook_path)) : undefined, source: 'Permission' },
        resolve: (allowed) => { signal?.removeEventListener('abort', onAbort); resolve(allowed) },
      })
      this.changed()
    })
  }

  /** Settle one request; without a requestId the presented (oldest) request is answered. */
  answer(requestId: string | undefined, allowed: boolean, networkScope?: 'call' | 'session'): boolean {
    const entry = this.pending.find(p => p.requestId === requestId) ?? (requestId === undefined ? this.pending[0] : undefined)
    if (entry && allowed && networkScope && entry.frame.network) (entry.frame.network as { scope?: string }).scope = networkScope
    return this.settle(requestId, allowed, false)
  }

  private settle(requestId: string | undefined, allowed: boolean, withdrawn: boolean): boolean {
    const index = requestId === undefined ? 0 : this.pending.findIndex((item) => item.requestId === requestId)
    const entry = index >= 0 ? this.pending[index] : undefined
    if (!entry) return false
    this.pending.splice(index, 1)
    if (this.presented === entry.requestId) this.presented = null
    if (withdrawn) this.emit({ type: 'approval-withdrawn', requestId: entry.requestId })
    entry.resolve(allowed)
    this.changed()
    return true
  }

  answerText(input: string): boolean {
    const reply = input.trim().toLowerCase()
    if (!this.pending.length) return false
    const requestId = /^(?:y|yes|n|no)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/.exec(reply)?.[1]
    if (requestId && !this.pending.some(item => item.requestId === requestId)) {
      this.notice(`No pending approval ${requestId}.`)
      return true
    }
    const addressed = /^(y|yes|n|no)\s+(\S+)(?:\s|$)/.exec(reply)
    if (addressed && this.pending.some(item => item.requestId === addressed[2])) return this.answer(addressed[2], addressed[1]!.startsWith('y'))
    if (this.workflowPending) return false
    return this.answer(undefined, /^(y|yes)\b/.test(reply))
  }

  denyAll(): void {
    const entries = this.pending.splice(0)
    this.presented = null
    for (const entry of entries) {
      this.emit({ type: 'approval-withdrawn', requestId: entry.requestId })
      entry.resolve(false)
    }
    if (entries.length) this.changed()
  }

  private changed(): void {
    // A lone approval keeps the historical frame sequence. Once a queue was
    // announced, every change (down to empty) is announced too.
    if (this.pending.length > 1 || this.announced > 0) {
      this.announced = this.pending.length
      this.emit({ type: 'approval-queue', pending: this.pending.map((item) => item.frame) })
    }
    const head = this.pending[0]
    if (!head || this.presented === head.requestId) return
    this.presented = head.requestId
    this.emit(head.frame)
    this.prompt(head.frame, this.pending.length - 1)
  }
}

/** A requestId-addressed answer from a client; null when the line is not an approval frame. */
export function parseApprovalFrame(line: string): { requestId?: string; allowed: boolean; networkScope?: 'call' | 'session' } | null {
  if (line.length < 2 || !line.startsWith('\x1e') || !line.endsWith('\x1e')) return null
  let frame: unknown
  try { frame = JSON.parse(line.slice(1, -1)) } catch { return null }
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'approval') return null
  const { requestId, allowed } = frame as { requestId?: unknown; allowed?: unknown }
  if (requestId !== undefined && (typeof requestId !== 'string' || !requestId) || typeof allowed !== 'boolean') throw new Error('Invalid approval frame')
  const networkScope = (frame as { networkScope?: unknown }).networkScope
  if (networkScope !== undefined && networkScope !== 'call' && networkScope !== 'session') throw new Error('Invalid network approval scope')
  return { requestId, allowed, ...(networkScope ? { networkScope } : {}) }
}

export async function startREPL(options: REPLOptions): Promise<void> {
  const { store, llmClient, model, verbose } = options
  // After a terminal hangup every write fails with EIO; the shutdown below must still run.
  guardOutputStreams()
  const approvals = new ApprovalQueue(emitDesktopEvent, (frame, waiting) => {
    process.stderr.write(`\n[approval] Tool "${frame.toolName}" requires confirmation: ${frame.reason}\n`)
    process.stderr.write(`[approval] Input: ${escapeDisplayControls(JSON.stringify(frame.input ?? {}))}\n`)
    if (frame.origin) {
      const from = frame.origin as import('../workflow/events.js').ApprovalOrigin
      process.stderr.write(`[approval] From ${from.kind === 'workflow' ? 'workflow agent' : 'sub-agent'} ${from.label}${from.runId ? ` (run ${from.runId.slice(0, 8)})` : ''}\n`)
    }
    if (waiting) process.stderr.write(`[approval] ${waiting} more waiting after this one\n`)
    if (frame.workflowSource) {
      const origin = frame.workflowSource as import('../tools/tool.js').WorkflowSource
      process.stderr.write(`[approval] Workflow source: ${origin.kind}${origin.path ? '; path: ' + origin.path : ''}\n`)
    }
    process.stderr.write(process.env.GCODE_DESKTOP === '1' ? `[approval] Reply with an approval frame carrying requestId ${frame.requestId}.\n`
      : frame.runId ? `[approval] Answer y ${frame.requestId} / n ${frame.requestId}: ` : '[approval] Allow? (y/n): ')
  }, message => process.stderr.write(`[approval] ${message}\n`))
  let inputClosed = false
  let quitting = false
  // A plain /exit is queued behind the running turn; a steer that turn hands back would queue
  // behind the /exit and never run.
  let quitQueued = false
  // The signal that is closing the session, so a turn it cut off is reported as stopped.
  let closingSignal: NodeJS.Signals | undefined

  printBanner()
  if (store.getState().networkHold?.phase === 'held') emitDesktopEvent({ type: 'network_incident', incident: store.getState().networkHold!.incident, sessionId: store.getState().sessionId })

  const hasLLM = !!llmClient

  if (hasLLM) {
    process.stderr.write(`  LLM: connected (${model ?? 'default'})\n`)
  } else {
    process.stderr.write('  LLM: not configured (set a provider API key or use --provider ollama --model <installed-name>)\n')
  }

  process.stderr.write('\n')

  // Load persisted todos
  loadTodos(store.getState().cwd, store.getState().sessionId)

  const terminalText = terminalTextWriter(text => process.stdout.write(text))

  // The desktop asks the user what to do when the context window fills mid-turn.
  const contextRequests = new Map<string, (choice: ContextFullChoice) => void>()
  const askContextFull: QueryEngineOptions['onContextFull'] = process.env.GCODE_DESKTOP === '1'
    ? (info, signal) => new Promise<ContextFullChoice>(resolve => {
      const requestId = randomUUID()
      const settle = (choice: ContextFullChoice) => { contextRequests.delete(requestId); signal.removeEventListener('abort', onAbort); resolve(choice) }
      const onAbort = () => settle('stop')
      contextRequests.set(requestId, settle)
      signal.addEventListener('abort', onAbort, { once: true })
      terminalText.flush()
      emitDesktopEvent({ type: 'context-full', requestId, used: info.used, limit: info.limit, ...(info.limitSource ? { limitSource: info.limitSource } : {}), ...(info.reserved !== undefined ? { reserved: info.reserved } : {}) })
    })
    : undefined

  // Background shells: the desktop's Tasks panel gets the list on every change (at most every 250 ms).
  // A terminal user reads them with TaskOutput instead, so the TTY REPL gets no frames.
  let tasksTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribeShells = process.env.GCODE_DESKTOP === '1' ? backgroundShells.onChange(() => {
    if (tasksTimer) return
    tasksTimer = setTimeout(() => { tasksTimer = undefined; emitDesktopEvent({ type: 'tasks', tasks: backgroundShells.list() }) }, 250)
  }) : () => {}
  let shellsStopped: Promise<void> = Promise.resolve()

  // Build query engine if LLM is available
  let engine: QueryEngine | null = null
  if (llmClient) {
    const tools = getTools(store.getState().permissionContext, store.getState().cwd)
    engine = new QueryEngine({
      client: llmClient,
      tools,
      store,
      model,
      verbose,
      // A terminal cannot take back what a discarded reply printed (the desktop trims it by the
      // event's `text`): say so before the replayed reply prints its text again.
      onRuntime: (event) => {
        if (event.type === 'reply-restart' && process.stdout.isTTY) {
          const restart = event as unknown as ReplyRestartEvent
          terminalText.flush()
          // Only reply text was printed (thinking and tool calls are not), so only then is any discarded.
          const reason = escapeDisplayControls(restart.reason, true), count = `(${restart.attempt}/${restart.max})`
          if (restart.text > 0) {
            process.stdout.write('\n')
            writeQuietly(process.stderr, `[reply] ${reason}; the reply text above is discarded and the reply is requested again ${count}.\n`)
          } else writeQuietly(process.stderr, `[reply] ${reason}; requesting the reply again ${count}.\n`)
        }
        emitDesktopEvent(event)
      },
      // JSON escaping prevents model-produced record separators from forging
      // control frames in the native desktop's stdout parser.
      onText: (text) => process.stdout.isTTY ? terminalText.write(text) : emitDesktopEvent({ type: 'assistant-text', text }),
      onToolStart: (name, id, input) => {
        terminalText.flush()
        emitDesktopEvent({ type: 'tool-use', id, name, input })
      },
      // The engine has saved the session (with the running turn) before it reports a tool's end.
      onToolEnd: (name, id, result, isError) => {
        emitDesktopEvent({ type: 'tool-result', id, name, success: !isError, output: isError ? undefined : result, error: isError ? result : undefined })
      },
      onContextFull: askContextFull,
      onGateConfirm: async (toolName, reason, input, request) => {
        terminalText.flush()
        const allowed = !inputClosed && await approvals.request(toolName, reason, input, request?.signal, request && { network: request.network, runId: request.runId, agentId: request.agentId, workflowSource: request.workflowSource, origin: request.origin, suggestedRule: request.suggestedRule, projectRoot: request.projectRoot })
        // Once input has ended (piped input ran out, Ctrl-D), nobody is left to answer: that is
        // no user's decline, so the failure budget still stops a model that keeps asking.
        if (!allowed && inputClosed) throw new ApprovalUnavailable('the input has ended')
        return allowed
      },
    })
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: 'gcode> ',
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  })
  // Closes the input once. readline's close() resets raw mode first, and after a terminal hangup
  // that reset fails (EBADF) and emits 'error' synchronously, inside close(): closing again from
  // that error recursed until the stack overflowed, the process exited 1, and the exit hook
  // SIGKILLed the background shells without their SIGTERM grace. A close() that throws before it
  // announces 'close' still runs the shutdown below.
  let closing = false
  const closeInput = () => {
    if (closing || inputClosed) return
    closing = true
    try { rl.close() } catch { if (!inputClosed) rl.emit('close') }
  }
  // A failed read (EIO once the terminal has hung up, or a raw-mode reset that fails) ends the
  // session the way EOF does, instead of an uncaught exception that skips the shutdown. Once the
  // input is closing, its errors are expected and dropped.
  const onInputError = (error: unknown) => {
    if (closing || inputClosed) return
    if (!isClosedOutputError(error)) writeQuietly(process.stderr, `\n[session] Input failed: ${escapeDisplayControls(error instanceof Error ? error.message : String(error), true)}\n`)
    closeInput()
  }
  process.stdin.on('error', onInputError)
  rl.on('error', onInputError)
  // At end of input readline closes by itself; ahead of its listener, mark the input closing so
  // the raw-mode reset failing inside that close is dropped too.
  process.stdin.prependListener('end', () => { closing = true })
  // readline also closes by itself (end of input) and resets raw mode as it does. Leaving raw mode
  // is best effort: if the reset throws instead of emitting 'error', it becomes an input error too,
  // never an exception out of readline's own close that would skip the shutdown.
  const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => unknown }
  const rawMode = typeof stdin.setRawMode === 'function' ? stdin.setRawMode : undefined
  const ownRawMode = Object.prototype.hasOwnProperty.call(stdin, 'setRawMode')
  if (rawMode) stdin.setRawMode = function (this: unknown, mode: boolean) {
    try { return rawMode.call(this, mode) } catch (error) { if (mode) throw error; onInputError(error); return this }
  }

  const prompt = () => { if (!inputClosed && !quitting) rl.prompt() }
  prompt()

  // The last permission:effort pair sent as a 'controls' frame. Declared before any input can be
  // handled: /session-controls reads it to send exactly one frame per command.
  let lastControls = ''
  let turnQueue = Promise.resolve()
  // Turns queued or running: a typed line steers only a turn with nothing queued behind it, so it
  // never overtakes lines already queued as turns.
  let pendingTurns = 0
  // `attachments`: files the desktop attached to the message (absolute paths; see src/shared/attachments.ts).
  const enqueueTurn = (input: string, source?: 'workflow' | 'budget' | 'network', workflowNotice?: string, attachments: string[] = []) => {
    pendingTurns++
    turnQueue = turnQueue.then(async () => {
      if (quitting) return
      if (!input && !attachments.length) {
        prompt()
        return
      }

      // A skill or MCP prompt run by name ("/commit", "/mcp__docs__summary topic=x") is a model turn.
      const target = source ? undefined : resolveSlashCommand(input)

      // Handle REPL commands
      if (isCommandText(input) && !target) {
        if (['/exit', '/quit'].includes(input.toLowerCase())) {
          quitting = true
          closeInput()
          return
        }
        try {
          const [command, ...args] = input.split(/\s+/)
          let continuing = false
          if (command === '/workflows' && workflowSettings(store.getState().cwd).enabled) {
            if (workflowNotice) emitDesktopEvent({ type: 'system', text: workflowNotice })
            else if (!args.length) {
              const tasks = workflowTasks.list(store.getState().sessionId)
              emitDesktopEvent({ type: 'system', text: tasks.map(task => `${task.runId} ${task.result?.status ?? 'running'} ${task.scriptPath}`).join('\n') || 'No workflows' })
            } else throw new Error('Usage: /workflows [stop <runId>]')
          } else if (command === '/session-controls') {
            const [permission, effort] = args
            if (!PERMISSIONS.includes(permission as SessionPermission) || !EFFORTS.includes(effort as Effort)) throw new Error('Invalid session controls')
            // One frame per command, also when nothing changed (it acknowledges the command);
            // marking it sent first keeps the store subscriber below from sending it again.
            lastControls = `${permission}:${effort}`
            store.setState(current => ({ permissionContext: { ...current.permissionContext, mode: permission as SessionPermission }, effort: effort as Effort }))
            emitDesktopEvent({ type: 'controls', permission, effort })
            await engine?.reportContext()
          } else if (command === '/network-decision') {
            if (args.length !== 2 || !['continue', 'reject'].includes(args[1]!)) throw new Error('Use /network-decision <incident-id> continue|reject.')
            const guard = currentGuard(); if (!guard) throw new Error('Resume the incident with its local model to decide.')
            const continuation = await guard.decide(args[0]!, args[1] as 'continue' | 'reject')
            emitDesktopEvent({ type: 'network-decision', incident: guard.incident, sessionId: store.getState().sessionId })
            if (continuation) { enqueueTurn(continuation, 'network'); continuing = true }
            else emitDesktopEvent({ type: 'system', text: guard.evidenceIncomplete ? `You rejected the network attempt. Its evidence could not be fully saved; whatever could be kept is at ${guard.incident?.path}.` : `You rejected the network attempt. Evidence kept (read-only) at ${guard.incident?.path}.` })
          } else if (command === '/budget-add') {
            const amount = Number(args[0])
            if (args.length !== 1 || !Number.isFinite(amount) || amount <= 0) throw new Error('Add budget requires a positive USD amount.')
            const pending = store.getState().budget?.handoff?.request ?? store.getState().budget?.pendingRequest
            sessionBudgetController(store, () => saveSession(store.getState())).add(amount)
            if (pending) { enqueueTurn(`Continue from the saved progress without repeating completed tool effects.\n\n${pending}`, 'budget'); continuing = true }
          } else if (command === '/compact') {
            if (!engine) throw new Error('A model must be connected to compact.')
            await engine.compact(args.join(' '))
          } else if (command === '/context') await engine?.reportContext()
          else await handleCommand(input, store)
          saveSession(store.getState())
          if (command !== '/session-controls' && !continuing) emitDesktopEvent({ type: 'turn-complete' })
        } catch (error) {
          emitDesktopEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
          if (input.split(/\s+/)[0] === '/workflows' && workflowSettings(store.getState().cwd).enabled) emitDesktopEvent({ type: 'turn-complete' })
        }
        prompt()
        return
      }

      // Process input through query engine
      if (engine) {
        try {
          process.stderr.write('\n')
          if (source) emitDesktopEvent({ type: 'turn-started', source })
          if (!source) currentGuard()?.nextUserMessage()
          const invocations = source ? [] : await turnInvocations(input, target)
          const result = await engine.submitQuery(input, { invocations, attachments })
          terminalText.flush()
          if (process.stdout.isTTY) process.stdout.write('\n')
          saveSession(store.getState())
          emitDesktopEvent({ type: 'turn-complete' })
          process.stderr.write('[turn] Complete\n')

          if (verbose) {
            process.stderr.write(
              `[${result.iterations} iteration(s), ${result.toolCallCount} tool call(s)]\n`,
            )
          }
        } catch (err) {
          terminalText.flush()
          if (err instanceof NetworkStopped) {
            await currentGuard()?.check().catch(() => {})
            const incident = currentGuard()?.incident ?? store.getState().networkHold?.incident
            if (!incident || currentGuard()?.notified !== incident.id) emitDesktopEvent({ type: 'network_incident', incident, sessionId: store.getState().sessionId })
            emitDesktopEvent({ type: 'turn-complete' }); prompt(); return
          }
          if (err instanceof BudgetReached) {
            saveSession(store.getState())
            emitDesktopEvent({ type: 'budget-reached', budget: store.getState().budget, sessionId: store.getState().sessionId })
            emitDesktopEvent({ type: 'turn-complete' })
            prompt()
            return
          }
          if (err instanceof ContextHandoff) {
            saveSession(store.getState())
            emitDesktopEvent({ type: 'handoff', summary: err.summary, path: err.path, request: (err as { request?: string }).request ?? '', sessionId: store.getState().sessionId, ...(err.calibration ? { calibration: err.calibration } : {}), ...(err.stalls ? { stalls: err.stalls } : {}), ...(err.attachments.length ? { attachments: err.attachments } : {}) })
            emitDesktopEvent({ type: 'turn-complete' })
            process.stderr.write(err.path ? `[session] Handoff saved to ${err.path}\n` : `[session] ${err.saveError ?? 'The handoff was not saved.'}\n`)
            prompt()
            return
          }
          // A signal aborts the turn: say so, not "The operation was aborted."
          const msg = closingSignal ? signalAbortCause(closingSignal, process.env.GCODE_DESKTOP === '1').by === 'user' ? 'Stopped before this turn finished.' : `G-Code was closed (${closingSignal}) before this turn finished.`
            : err instanceof Error ? err.message : String(err)
          if (process.stdout.isTTY) process.stderr.write(`\nError: ${escapeDisplayControls(msg, true)}\n`)
          else emitDesktopEvent({ type: 'error', message: msg })
        }
      } else {
        process.stderr.write(`[G-Code] No LLM configured. Set a provider API key or use --provider ollama --model <installed-name>.\n`)
        process.stderr.write(`[G-Code] Tools available: ${getTools(store.getState().permissionContext, store.getState().cwd).map((t) => t.name).join(', ')}\n`)
      }

      prompt()
    }).finally(() => { pendingTurns-- })
  }
  // A steer the turn ended before reading runs as the next turn, unless the session is ending:
  // a turn queued then never runs, so the user is told instead of promised.
  const runReturnedSteer = (text: string) => {
    if (quitting || quitQueued || closing || inputClosed) { writeQuietly(process.stderr, '[steer] The session is ending; your message was not run.\n'); return }
    process.stderr.write('[steer] The turn ended before reading your message; it runs as the next turn.\n')
    enqueueTurn(text)
  }
  const unsubscribeWorkflows = workflowTasks.onDone(task => {
    if (task.background && task.sessionId === store.getState().sessionId && !quitting && !inputClosed && process.env.GCODE_DESKTOP !== '1') {
      enqueueTurn(workflowResultMessage(task), 'workflow')
    }
  })
  rl.on('line', (line) => {
    let input: string
    let attachments: string[] = []
    try {
      const choice = parseContextChoice(line)
      if (choice) {
        const settle = contextRequests.get(choice.requestId)
        if (settle) settle(choice.choice)
        else emitDesktopEvent({ type: 'system', text: `No pending context request ${choice.requestId}` })
        return
      }
      const task = parseTaskControl(line)
      if (task) {
        if (!backgroundShells.stop(task.id)) emitDesktopEvent({ type: 'system', text: `Background task ${task.id} is not running` })
        return
      }
      // A message sent while a turn runs: delivered into that turn, or returned. The desktop then
      // sends it as an ordinary message once the turn ends; the terminal runs it as the next turn.
      const steer = parseSteerFrame(line)
      if (steer) {
        const terminal = process.env.GCODE_DESKTOP !== '1'
        // A skill or prompt run by name waits for its own turn, as a command does.
        if (resolveSlashCommand(steer.text) || !engine?.steer(steer.id, steer.text, terminal ? runReturnedSteer : undefined)) { emitDesktopEvent({ type: 'steer', id: steer.id, state: 'returned' }); if (terminal) enqueueTurn(steer.text) }
        return
      }
      const control = parseWorkflowControl(line)
      if (control) {
        if (!workflowTasks.control(control, store.getState().sessionId)) emitDesktopEvent({ type: 'error', message: `No active workflow ${control.runId}` })
        return
      }
      const answer = parseApprovalFrame(line)
      if (answer) {
        if (answer.requestId === undefined && (process.env.GCODE_DESKTOP === '1' || approvals.workflowPending)) {
          emitDesktopEvent({ type: 'system', text: 'Approval frame requires requestId' })
        } else if (!approvals.answer(answer.requestId, answer.allowed, answer.networkScope)) {
          // A late response is a protocol notice, not a failure of another run
          // or its newly presented approval.
          const message = `No pending approval ${answer.requestId ?? '(unaddressed)'}`
          emitDesktopEvent(process.env.GCODE_DESKTOP === '1' ? { type: 'system', text: message } : { type: 'error', message })
        }
        return
      }
      const message = parseInputMessage(line)
      input = message.text; attachments = message.attachments
    } catch (error) {
      emitDesktopEvent({ type: 'error', message: String(error) })
      return
    }
    // A command (workflow controls and /exit included) runs no model turn, so files sent with one
    // would go nowhere: say so instead of dropping them. A skill or prompt run by name takes them.
    if (attachments.length && isCommandText(input) && !resolveSlashCommand(input)) {
      emitDesktopEvent({ type: 'error', message: `${input.split(/\s+/)[0]} does not take attachments. Send the files with an ordinary message.` })
      emitDesktopEvent({ type: 'turn-complete' })
      prompt()
      return
    }
    if (['/exit', '/quit'].includes(input.toLowerCase())) {
      const activeWorkflow = workflowTasks.list(store.getState().sessionId).some(task => task.background && !task.result)
      if (activeWorkflow || approvals.size) {
        void workflowTasks.shutdown(store.getState().sessionId)
        quitting = true
        engine?.abort()
        approvals.denyAll()
        closeInput()
      } else {
        // A piped final prompt followed by /quit must still finish and persist.
        quitQueued = true
        enqueueTurn(input)
      }
      return
    }
    if (workflowSettings(store.getState().cwd).enabled && /^\/workflows stop \S+$/.test(input)) {
      const runId = input.split(/\s+/)[2]!
      const stopped = workflowTasks.control({ type: 'workflow-control', runId, action: 'stop' }, store.getState().sessionId)
      // Cancellation is immediate; command output and completion own a queued turn.
      enqueueTurn('/workflows', undefined, stopped ? `Stopping workflow ${runId}` : `No active workflow ${runId}`)
      return
    }
    if (workflowSettings(store.getState().cwd).enabled && (input === '/workflows' || input.startsWith('/workflows '))) { enqueueTurn(input); return }
    if (process.env.GCODE_DESKTOP === '1') {
      if (approvals.size) process.stderr.write('[approval] Input queued for the next turn. Desktop approval requires an approval frame carrying requestId.\n')
      enqueueTurn(input, undefined, undefined, attachments)
      return
    }
    // A message with files is a message, never an approval answer.
    if (!attachments.length && approvals.answerText(input)) return
    if (!attachments.length && approvals.workflowPending && /^(y|yes|n|no)$/i.test(input)) {
      process.stderr.write('[approval] Include requestId: y <requestId> / n <requestId>. Reply was not queued.\n')
      return
    }
    // In the terminal, a line typed while a turn runs goes into that turn at its next safe point; one
    // the turn ends before taking runs as the next turn. While an approval waits, a line that is not
    // its answer keeps being queued with the hint below. Piped input keeps queueing turns.
    if (process.stdin.isTTY && !attachments.length && !approvals.size && pendingTurns <= 1 && !isCommandText(input) && !resolveSlashCommand(input) && engine?.steer(randomUUID(), input, runReturnedSteer)) {
      process.stderr.write('[steer] Sent to the running turn; the model reads it after its current step.\n')
      return
    }
    if (approvals.workflowPending) process.stderr.write(process.stdin.isTTY
      ? '[approval] Input queued for the next turn. Workflow approval requires y <requestId> / n <requestId>.\n'
      : '[approval] Input queued for the next turn. Workflow approval requires y/n followed by requestId, or an approval frame.\n')
    enqueueTurn(input, undefined, undefined, attachments)
  })

  const closeForSignal = (signal: NodeJS.Signals) => {
    quitting = true
    closingSignal ??= signal
    engine?.abort(signalAbortCause(signal, process.env.GCODE_DESKTOP === '1'))
    void workflowTasks.shutdown(store.getState().sessionId)
    approvals.denyAll()
    closeInput()
  }
  // A closed terminal (SIGHUP) or SIGQUIT ends the session the same way as SIGTERM.
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, closeForSignal)
  // An end of input nobody announced waits briefly before it ends the turn as a closed session: a
  // signal sent with it says why instead. Bun can run readline's 'close' before a signal that came
  // first (SIGINT then end of input could read as SIGHUP: the signal can come
  // 0.3-0.5 ms after the close, always before a setImmediate queued by the close).
  let unannouncedEnd: ReturnType<typeof setTimeout> | undefined
  const closed = new Promise<void>((resolve) => {
    rl.once('close', () => {
      // The desktop holds this pipe open for as long as it runs and signals before it closes it, so
      // an end of input nobody announced means the app is gone (Force Quit, a crash). Nobody can see
      // or stop this turn any more: it ends as a closed session, as SIGHUP does, and saves what it
      // has. An explicit /exit (quitQueued) still finishes what was queued before it.
      if (process.env.GCODE_DESKTOP === '1' && !quitting && !quitQueued && !closingSignal) {
        // Nothing queued starts meanwhile, as when the signal is handled first.
        quitting = true
        // Then one more turn of the event loop, so a signal pending behind a late timer is handled first.
        unannouncedEnd = setTimeout(() => setImmediate(() => { if (!closingSignal) closeForSignal('SIGHUP') }), UNANNOUNCED_END_WAIT_MS)
      }
      inputClosed = true
      process.stdin.pause()
      workflowTasks.stopBackground(store.getState().sessionId)
      unsubscribeShells(); if (tasksTimer) clearTimeout(tasksTimer)
      // SIGTERM first so servers can clean up; startREPL waits for them (SIGKILL after 1.5 s).
      shellsStopped = backgroundShells.stopAll()
      for (const settle of contextRequests.values()) settle('stop')
      if (quitting) void workflowTasks.shutdown(store.getState().sessionId)
      approvals.denyAll()
      // After a hangup this write fails; the shutdown that follows must still run.
      writeQuietly(process.stderr, '\n')
      resolve()
    })
  })
  // Readiness is emitted only after input and cancellation handlers are live.
  emitDesktopEvent({ type: 'session-started', sessionId: store.getState().sessionId })
  emitDesktopEvent({ type: 'outputs', outputs: store.getState().outputs ?? [] })
  void tidyInBackground(store.getState().cwd, notice => {
    // The desktop shows no stderr line but errors and its own tags: a 'system' frame shows it there.
    writeQuietly(process.stderr, `[session] ${notice}\n`)
    emitDesktopEvent({ type: 'system', text: notice })
  })
  // The terminal already has this on stderr (from the tool registry); the desktop shows it in the chat.
  const ignoredWorkflowSetting = process.env.GCODE_DESKTOP === '1' ? ignoredProjectWorkflowSetting(store.getState().cwd) : undefined
  if (ignoredWorkflowSetting) emitDesktopEvent({ type: 'system', text: ignoredWorkflowSetting })
  await engine?.reportContext()
  const unsubscribeControls = store.subscribe(state => {
    const key = `${state.permissionContext.mode}:${state.effort ?? 'medium'}`
    if (key === lastControls) return
    lastControls = key
    emitDesktopEvent({ type: 'controls', permission: state.permissionContext.mode, effort: state.effort ?? 'medium' })
  })

  // Keep the CLI lifecycle alive until stdin actually closes. Previously this
  // async function returned immediately after registering handlers, so cli.ts
  // ran cleanup before the desktop could submit its first message.
  await closed

  // EOF can arrive while the final submitted turn is still running. Let it
  // finish before cli.ts persists the session and shuts down.
  try {
    await Promise.all([turnQueue, shellsStopped])
    // A final turn that ran on after EOF may have started more.
    await backgroundShells.stopAll()
    await workflowTasks.shutdown(store.getState().sessionId)
  }
  finally {
    clearTimeout(unannouncedEnd)
    unsubscribeWorkflows()
    unsubscribeControls()
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, closeForSignal)
    if (rawMode) { if (ownRawMode) stdin.setRawMode = rawMode; else delete stdin.setRawMode }
  }
}

// ============================================================================
// Command Handling
// ============================================================================

async function handleCommand(cmd: string, store: Store<AppState>): Promise<void> {
  const parts = cmd.split(/\s+/)
  const command = parts[0]!.toLowerCase()

  switch (command) {
    case '/reset':
      store.setState(() => ({
        messages: [],
        // What the model is sent, too: a reset that kept it would resend the old conversation.
        contextMessages: undefined,
        contextStatus: undefined,
        sessionContext: createEmptySessionContext(),
      }))
      process.stderr.write('Session reset.\n')
      break

    case '/status': {
      const state = store.getState()
      process.stderr.write(`Session: ${state.sessionId}\n`)
      process.stderr.write(`Turn: ${state.sessionContext.turn_count}\n`)
      process.stderr.write(`Tools: ${state.sessionContext.tool_call_count}\n`)
      process.stderr.write(`Cache: ${cachePercent(sessionCacheRatio(state.usageTotals))}\n`)
      break
    }

    case '/tools': {
      const tools = getTools(store.getState().permissionContext, store.getState().cwd)
      for (const tool of tools) {
        process.stderr.write(escapeDisplayControls(`  ${tool.name}: ${tool.description}\n`, true))
      }
      break
    }

    case '/todos':
      process.stderr.write(escapeDisplayControls(formatTodos(store.getState().sessionId), true) + '\n')
      break

    case '/help':
      process.stderr.write([
        'Commands:',
        '  /exit       Exit G-Code',
        '  /reset      Reset the session',
        '  /status     Show session status',
        '  /tools      List available tools',
        '  /todos      Show current task list',
        '  /compact    Compact the conversation; optional text focuses the summary',
        '  /context    Show context usage',
        ...(workflowSettings(store.getState().cwd).enabled ? ['  /workflows  List workflows; /workflows stop <runId> stops one'] : []),
        '  /help       Show this help',
        ...userCommandHelp(),
        '',
      ].join('\n'))
      break

    default: {
      // The desktop shows no stderr line but errors and its own tags: a 'system' frame shows it there.
      const notice = `Unknown command: ${command}. Type /help for available commands.`
      process.stderr.write(`${notice}\n`)
      emitDesktopEvent({ type: 'system', text: notice })
    }
  }
}
