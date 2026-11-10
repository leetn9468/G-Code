import { currentGuard, inGuardCall, type GuardCall } from '../security/guard.js'
import { classifyNetwork } from '../security/classify.js'
import { boundedJSON, boundedText } from '../workflow/events.js'
/** Execute tool calls in model order, validating and checking live permissions. */
import type { ToolUseBlock, ToolResultBlock } from '../llm/types.js'
import type { ConfirmTool, Tool, ToolUseContext } from '../tools/tool.js'
import { approvalReason } from '../tools/tool.js'
import { evaluatePermission, hasAskRule } from '../tools/permissions.js'
import type { ToolPhase } from '../shared/runtimeEvents.js'
import { toolResultText } from '../llm/images.js'
import { maskSecrets, maskSecretsInContent } from '../security/secretValues.js'
import { callIdentity, type TurnFailureBudget } from './failureBudget.js'
import { formatInputIssues, normalizeToolInput } from '../tools/inputNormalization.js'
import { canonicalJSON } from '../utils/hash.js'
import { allowingModes } from '../shared/sessionControls.js'
import { suggestedPermissionRule } from '../tools/permissionMatcher.js'
import { toolJsonSchema, unwrapDeferredCall } from '../tools/impl/DeferredToolCallTool.js'
import type { PermissionDenial } from '../shared/permissionRules.js'

/**
 * A call that never ran: approval was refused or could not be asked for, a permission rule
 * denied it, the failure budget refused it, or its input was invalid. Its message is the
 * result as is (never "Tool execution error", since nothing executed).
 */
class NotRun extends Error {}

/**
 * Thrown by an approval handler that has nobody left to ask (its input has ended: piped input ran
 * out, Ctrl-D). The call counts as one nobody could approve, like a headless run, not as a user's
 * decline: declines never stop the main conversation, and nobody is there to press Stop. Its
 * message says why, for the model (e.g. "the input has ended").
 */
export class ApprovalUnavailable extends Error {}

/** Agent calls of one reply run at the same time, at most this many at once. */
export const AGENT_CONCURRENCY = 4
/** Consecutive concurrency-safe calls of one reply run at the same time, at most this many at once. */
export const READ_CONCURRENCY = 10

/**
 * Built-in tools without side effects. LSP is not one: its format action rewrites the file, and
 * diagnostics runs a project-wide type check. WebFetch's own session grant of its host happens only
 * after an approval, and an approved call never runs alongside others (see below).
 */
const CONCURRENCY_SAFE = new Set(['FileRead', 'Grep', 'Glob', 'ListDir', 'WebFetch', 'WebSearch', 'ToolSearch', 'TaskOutput', 'TaskGet', 'TaskList'])

/**
 * How a call runs alongside its neighbours in one reply: sub-agents with sub-agents (each has its
 * own engine and history), read-only calls with read-only calls. Groups never mix, so nothing else
 * runs alongside a sub-agent; any other call waits until the running ones have finished.
 */
type Kind = 'agent' | 'read'
const kindOf = (name: string, tool: Tool<unknown, unknown> | undefined): Kind | undefined =>
  name === 'Agent' ? 'agent' : (tool?.concurrencySafe ?? CONCURRENCY_SAFE.has(name)) ? 'read' : undefined

/**
 * Tools whose repeated identical result, within one turn, is replaced by a note pointing at the
 * first. FileRead has its own dedup; TaskOutput, TaskGet and TaskList are polled, and Bash runs.
 */
const DEDUP_TOOLS = new Set(['Grep', 'Glob', 'ListDir', 'WebSearch', 'WebFetch', 'LSP'])
const DEDUP_MIN_CHARS = 200
/** Per turn (one failure budget each, never shared with sub-agents): the last result of each identical call. */
const turnResults = new WeakMap<TurnFailureBudget, Map<string, { id: string; text: string }>>()

/**
 * Forget the turn's earlier results, so the next identical call is shown in full: once the
 * conversation no longer holds them (cleared to free context, or compacted away), a note pointing
 * at one would point at nothing, and the model could not get the data back.
 */
export function invalidateTurnResults(budget?: TurnFailureBudget): void {
  if (budget) turnResults.delete(budget)
}

/**
 * One event-loop turn. Stop arrives as a signal, and its handler only runs between macrotasks:
 * synchronous tools (FileWrite, FileEdit) never give it one, so without this a whole batch ran on
 * after Stop and the next shell command was spawned before the abort reached it.
 */
const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve))

/** What the model is told about a refused approval: who refused it, that nothing ran, and what to do instead. */
function approvalRefusal(tool: string, unavailable: boolean, headlessMode?: string, why = 'non-interactive'): string {
  // A -p run can never ask: the user allows calls with the permission mode they start it with.
  if (unavailable && headlessMode !== undefined) return `Not run: approval required for this ${tool} call, but this is a non-interactive run (gcode -p) in the '${headlessMode}' permission mode, so nothing was executed. Do not ask for approval: tell the user that re-running with ${allowingModes(headlessMode, [tool]).includes('acceptEdits') ? '--permission-mode acceptEdits allows file edits in the project, and ' : ''}--permission-mode bypass allows all tools; or choose an approach that needs no approval.`
  return unavailable
    ? `Not run: approval required for this ${tool} call, but nobody can approve tool calls in this run (${why}), so nothing was executed. Choose an approach that needs no approval, or tell the user what needs their approval.`
    : `Not run: the user declined approval for this ${tool} call, so nothing was executed or changed. Do not retry it or get around it with another tool; ask the user how to proceed, or offer an alternative.`
}

/** A denial reason as the end of a sentence. */
const reasonText = (reason: string | undefined) => { const text = (reason ?? 'not allowed').trim(); return /[.!?…]$/u.test(text) ? text : `${text}.` }

/**
 * How a call ended, as its card shows it; `started`: tool.call began, so it may have had effects.
 * `input`: the input as the tool received it once normalized (block.input stays as the model sent it).
 */
export interface CallOutcomeState { state: ToolPhase; started: boolean; denial?: PermissionDenial; input?: unknown; plainError?: string }

export interface ToolRunResult {
  results: ToolResultBlock[]
  toolCallCount: number
  errors: number
  stopped?: string
}

/** One call's progress through the runner. */
interface Call {
  block: ToolUseBlock
  /** What a card says instead of the result, when the result is meant for the model. */
  plainError?: string
  result: ToolResultBlock
  failure: ToolPhase
  cwd: string
  tool?: Tool<unknown, unknown>
  /** The input as the tool receives it once normalized; block.input stays as the model sent it. */
  input: unknown
  budgetInput: unknown
  budgetStopped: boolean
  /** The failure budget refused it as a repeat (it never ran). */
  budgetRefused: boolean
  /** Only a refused approval makes a call sticky; a failure can be retried after a success. */
  userDenied: boolean
  /** Refused without asking anyone: a headless run, or no approval handler at all. */
  approvalUnavailable: boolean
  /** tool.call began: an error from here on is an execution error. */
  started: boolean
  /** Its execution ran (it may still have been refused by the updated policy): the guard keeps its result. */
  executed: boolean
  /** It asked for approval: a read then runs alone, so what the approval granted holds for the calls after it. */
  asked: boolean
  networkCall?: GuardCall
  /** Its final state was already reported (a concurrent call reports it when it ends). */
  reported: boolean
  /** The result as text, once the call has ended. */
  text?: string
  denialReason?: string
  /** The tool's own check refused it (shown as Not run); still reported as a denial, as before. */
  toolRefused?: boolean
  suggestRule?: boolean
  denial?: PermissionDenial
  /** A DeferredToolCall whose own input names no call: why (its result). */
  wrapperError?: string
}

export async function runTools(
  toolUseBlocks: ToolUseBlock[],
  tools: ReadonlyArray<Tool<unknown, unknown>>,
  context: ToolUseContext,
  onGateConfirm?: ConfirmTool,
  beforeExecution?: (block: ToolUseBlock, input: unknown) => Promise<void>,
  onResult?: (block: ToolUseBlock, result: ToolResultBlock, outcome: CallOutcomeState) => void,
  onState?: (block: ToolUseBlock, state: ToolPhase, detail?: string) => void,
  /**
   * `hook`: project hooks run these calls; their successes do not reset the failure budget.
   * `budgetInput`: what tells this call apart for the failure budget when its visible input does
   * not. A hook runs the same command for every call it guards, so its identity and the guarded
   * call's data (its environment) are part of it: one failed guard must not refuse the next.
   */
  options: { hook?: boolean; budgetInput?: unknown } = {},
): Promise<ToolRunResult> {
  const results: ToolResultBlock[] = []
  const guard = currentGuard()

  const fail = (call: Call, error: unknown) => {
    const message = maskSecrets(error instanceof Error ? error.message : String(error))
    call.result.content = error instanceof NotRun ? message
      : !call.started && context.signal?.aborted ? `Not run: the turn was stopped before this ${call.block.name} call started, so nothing was executed.`
      // Anything else before tool.call (a preTool hook that blocks the call, a check that threw):
      // the call never ran, so it is no execution error.
      : !call.started ? `Not run: this ${call.block.name} call was blocked before it started, so nothing was executed. ${message}`
      : `Tool execution error: ${message}`
    call.result.is_error = true
  }

  const display = (call: Call) => {
    if (call.text !== undefined) return call.text
    if (call.block.name === 'Workflow') call.result.content = boundedText(toolResultText(call.result.content), 8000)
    return call.text = toolResultText(call.result.content)
  }
  /** A call that returned success completed, even when Stop landed as it returned; Stop cancels only what did not. */
  const outcome = (call: Call): ToolPhase => !call.result.is_error ? 'complete' : context.signal?.aborted ? 'cancelled' : call.failure
  const report = (call: Call) => {
    if (call.reported) return
    call.reported = true
    if (outcome(call) === 'denied' || (outcome(call) === 'refused' && call.toolRefused)) {
      const suggested = call.suggestRule ? suggestedPermissionRule(call.block.name, call.block.input, call.cwd) : undefined
      call.denial = { tool_name: call.block.name, tool_use_id: call.block.id, tool_input: call.block.input, reason: call.denialReason ?? 'This call was refused before it ran.', ...(suggested ? { suggested_rule: suggested } : {}) }
      context.onPermissionDenial?.(call.denial)
    }
    onState?.(call.block, outcome(call), call.denial?.reason ?? call.plainError ?? display(call))
  }
  /** A successful read whose result repeats the identical call's earlier in this turn: a note instead. */
  const dedup = (call: Call) => {
    const { block, result } = call
    if (options.hook || !context.failureBudget || !DEDUP_TOOLS.has(block.name) || !call.started || result.is_error || typeof result.content !== 'string') return
    if (block.name === 'LSP' && (call.input as { action?: unknown } | undefined)?.action === 'format') return
    let seen = turnResults.get(context.failureBudget)
    if (!seen) turnResults.set(context.failureBudget, seen = new Map())
    const key = canonicalJSON({ tool: block.name, input: call.input, cwd: call.cwd })
    const earlier = seen.get(key)
    if (earlier && earlier.text === result.content && result.content.length > DEDUP_MIN_CHARS) {
      result.content = `[Same result as the identical ${block.name} call earlier in this turn (${earlier.id}); nothing changed.]`
      call.text = undefined
      return
    }
    seen.set(key, { id: block.id, text: result.content })
  }
  /** Settle a call in model order: the guard's record, the budget, its final state, its result. */
  const finish = async (call: Call) => {
    if (call.executed) { guard?.remember('tool-result', { id: call.block.id, name: call.block.name, result: call.result }); await guard?.finishCall(call.networkCall) }
    // Before the note that replaces a repeated result: the budget compares what the call really returned.
    const returned = typeof call.result.content === 'string' ? call.result.content : undefined
    dedup(call)
    const text = display(call)
    if (!call.budgetStopped && !context.signal?.aborted) context.failureBudget?.record(call.block.name, call.budgetInput, call.cwd, call.result.is_error ? text : undefined, { result: returned, denied: call.userDenied, unavailable: call.approvalUnavailable, hook: options.hook, refused: call.budgetRefused })
    report(call)
    results.push(call.result)
    onResult?.(call.block, call.result, { state: outcome(call), started: call.started, input: call.input, ...(call.denial ? { denial: call.denial } : {}), ...(call.plainError ? { plainError: call.plainError } : {}) })
  }

  /**
   * Gate one call immediately before it can run: budget, permissions, approval, hooks. It
   * returns the execution, or undefined when the call was refused (its result already says why).
   * Preparing the entire batch first would let later writes bypass EnterPlanMode and ignore cwd
   * changes from worktrees, so each call is gated only once the calls before it were.
   */
  const prepare = async (call: Call): Promise<(() => Promise<void>) | undefined> => {
    const { block } = call
    let networkCall: GuardCall | undefined
    try {
      await guard?.check()
      onState?.(block, 'validating')
      // Stop sent while the previous call ran is handled before this one starts.
      if (context.signal) await yieldToLoop()
      context.signal?.throwIfAborted()
      const refusal = context.failureBudget?.check(block.name, call.budgetInput, call.cwd)
      if (refusal) {
        // A stop ends the turn; any other refusal is this call's error, and the model can react to it.
        if (refusal.stop) { call.budgetStopped = true; call.failure = 'cancelled' } else { call.budgetRefused = true; call.failure = refusal.denied ? 'denied' : 'refused'; if (refusal.denied) call.denialReason = 'This call repeats one that was already refused. Nothing was run.' }
        throw new NotRun(refusal.stop ? `Not run, the turn stopped: ${refusal.reason}` : refusal.reason)
      }
      const { tool } = call
      if (call.wrapperError) { call.failure = 'refused'; throw new NotRun(call.wrapperError) }
      if (!tool) {
        call.failure = 'refused'
        const deferred = [...context.deferredTools ?? []].filter(name => tools.some(candidate => candidate.name === name))
        throw new NotRun(`Not run: unknown tool "${block.name}".${deferred.length ? ` Tools loaded on demand: ${deferred.join(', ')}.` : ''}`)
      }
      const parsed = tool.inputSchema.safeParse(call.input)
      if (!parsed.success) {
        call.failure = 'refused'
        // A deferred tool's definition may never have been loaded: its schema lets the model fix the call at once.
        const schema = context.deferredTools?.has(block.name) ? `\nInput schema: ${JSON.stringify(toolJsonSchema(tool))}` : ''
        throw new NotRun(`Not run: invalid input for "${block.name}":\n${formatInputIssues(tool.inputSchema, parsed.error.issues)}${schema}`)
      }
      const input = parsed.data
      if (guard) {
        const classification = classifyNetwork(block.name, input as Record<string, unknown>, context.cwd)
        const network = { hosts: [...new Set([...classification.hosts, ...(tool.networkHosts ?? [])])], scope: 'call' as 'call' | 'session' }
        if (classification.capable) {
          // One line: the whole reason is escaped for display, so a line break would show as \u000a.
          const reason = `Network: ${network.hosts.join(', ') || 'No destination identified; unapproved traffic will stop the session.'} · ${classification.reason}`
          onState?.(block, 'awaiting_approval', reason)
          call.asked = true
          const approved = !context.isHeadless && onGateConfirm && await untilAborted(onGateConfirm(block.name, reason, input as Record<string, unknown>, { signal: context.signal, network, projectRoot: context.cwd }), context.signal)
          if (!approved) {
            call.failure = 'denied'; call.userDenied = true; call.approvalUnavailable = context.isHeadless || !onGateConfirm
            call.denialReason = context.isHeadless ? 'Network approval is required. Non-interactive runs cannot approve classified network calls in any permission mode.' : 'You declined this network call. Nothing was run.'
            throw new NotRun(call.denialReason)
          }
        }
        networkCall = await guard.call(block.name, block.id, block.input, classification.capable ? network.hosts : [], network.scope === 'session')
      }
      const intrinsic = await inGuardCall(guard, networkCall, () => tool.checkPermissions(input, context))
      const policyContext = context.getPermissionContext?.()
      const policy = policyContext ? evaluatePermission(block.name, policyContext, input, context.cwd) : undefined
      if (intrinsic.decision === 'deny' || policy?.decision === 'deny') {
        // A policy denial is the user's rule; a tool's own refusal is not a permission denial.
        call.failure = policy?.decision === 'deny' ? 'denied' : 'refused'
        call.toolRefused = policy?.decision !== 'deny'
        call.denialReason = policy?.decision === 'deny' ? policy.reason : intrinsic.reason
        // The policy denies a call; the tool itself refuses one it cannot do (a binary file, an invalid browser plan).
        throw new NotRun(policy?.decision === 'deny' ? `Not run: ${block.name} call denied: ${reasonText(policy.reason)} Nothing was executed.` : `Not run: ${block.name} call refused: ${reasonText(intrinsic.reason)} Nothing was executed.`)
      }
      const permissionRequiresApproval = (block.name === 'Workflow' && intrinsic.decision === 'ask') || policy?.decision !== 'allow' && (
        // A scoped ask (a read outside the project, a new web host) holds in default mode too; a mode default does not.
        // Workflow's own check decides in every mode: it asks for each script, even in bypass, and allows only the static guide.
        intrinsic.decision === 'ask' || (policy?.decision === 'ask' && ((policyContext?.mode !== 'default' && block.name !== 'Workflow') || policy.scoped)) || (policyContext && hasAskRule(block.name, policyContext, input, context.cwd))
      )
      if (permissionRequiresApproval) {
        // The reason of the check that asked: a tool that allowed the call must not label the approval.
        const reason = approvalReason((intrinsic.decision === 'ask' ? intrinsic.reason ?? policy?.reason : policy?.reason ?? intrinsic.reason) ?? 'Tool requires approval', intrinsic.workflowSource)
        onState?.(block, 'awaiting_approval', reason)
        call.asked = true
        // A handler with nobody left to ask (its input has ended) throws ApprovalUnavailable.
        let nobody: ApprovalUnavailable | undefined
        const approved = onGateConfirm ? await untilAborted(onGateConfirm(block.name, reason, input as Record<string, unknown>, { signal: context.signal, workflowSource: intrinsic.workflowSource, projectRoot: context.cwd, suggestedRule: suggestedPermissionRule(block.name, input, context.cwd, true) }), context.signal)
          .catch((error: unknown) => { if (error instanceof ApprovalUnavailable && !context.signal?.aborted) { nobody = error; return false } throw error }) : false
        if (!approved) {
          call.failure = 'denied'; call.userDenied = true; call.approvalUnavailable = !onGateConfirm || context.isHeadless || !!nobody
          call.denialReason = call.approvalUnavailable ? `${reasonText(reason)} ${context.isHeadless ? 'This non-interactive run cannot ask for approval.' : 'Nobody is available to approve this call.'}` : `You declined this ${block.name} call. Nothing was run.`
          call.suggestRule = true
          throw new NotRun(approvalRefusal(block.name, call.approvalUnavailable, context.isHeadless ? policyContext?.mode ?? 'default' : undefined, nobody?.message || undefined))
        }
      }
      context.signal?.throwIfAborted()
      if (beforeExecution) {
        await inGuardCall(guard, networkCall, () => beforeExecution(block, input))
        context.signal?.throwIfAborted()
      }
      call.networkCall = networkCall
      return async () => {
        call.executed = true
        try {
          const latest = context.getPermissionContext?.()
          if (latest && evaluatePermission(block.name, latest, input, context.cwd).decision === 'deny') { call.failure = 'denied'; call.denialReason = 'Blocked by the updated permission policy.'; throw new NotRun(`Not run: ${block.name} call denied by the updated permission policy. Nothing was executed.`) }
          if (context.signal) await yieldToLoop()
          context.signal?.throwIfAborted()
          call.started = true
          onState?.(block, 'running')
          const called = await inGuardCall(guard, networkCall, () => tool.call(input, { ...context, tools, toolUseId: context.toolCardId?.(block.id) ?? block.id, webFetchRuleHost: policy?.webRuleHost, onProgress: detail => onState?.(block, 'running', detail), onArtifacts: paths => context.onArtifacts?.(paths, block.name) }))
          const output = formatToolOutput(called.output)
          call.result.content = block.name === 'Workflow' ? boundedJSON(called.output ?? { error: called.error }) : called.success ? output : [
            `Error: ${called.error ?? 'Unknown error'}`, output,
          ].filter(Boolean).join('\n')
          if (called.success && called.contentBlocks) call.result.content = called.contentBlocks
          call.result.content = maskSecretsInContent(call.result.content)
          call.result.is_error = !called.success
          // The model reads a workflow's whole report; its card says what went wrong in words.
          if (block.name === 'Workflow' && !called.success && called.error) call.plainError = maskSecretsInContent(called.error) as string
        } catch (error) { fail(call, error) }
      }
    } catch (error) {
      fail(call, error)
      if (networkCall) await guard?.finishCall(networkCall)
      return undefined
    }
  }

  // Calls of one kind started and not settled yet, in model order, and their failure-budget
  // identities. Any other call waits for them, so results keep the model's order.
  let group: Array<Promise<Call>> = []
  let groupKind: Kind | undefined
  let groupKeys = new Set<string>()
  const slots = { agent: semaphore(AGENT_CONCURRENCY), read: semaphore(READ_CONCURRENCY) }
  const flush = async () => {
    const settled = group
    group = []; groupKind = undefined; groupKeys = new Set()
    for (const pending of settled) await finish(await pending)
  }

  // A reply's calls are one step for the main conversation's run of failures; a hook's are not a reply.
  if (!options.hook) context.failureBudget?.beginBatch()
  try {
    for (const sent of toolUseBlocks) {
      // A DeferredToolCall is the call it names from here on: every gate, the budget, the card and
      // the events see the real tool and input. Its result answers the same id; the history keeps
      // the block as sent.
      const unwrapped = unwrapDeferredCall(sent)
      const block = unwrapped && 'block' in unwrapped ? unwrapped.block : sent
      const wrapperError = unwrapped && 'error' in unwrapped ? unwrapped.error : undefined
      const tool = wrapperError ? undefined : tools.find((candidate) => candidate.name === block.name)
      const input = tool ? normalizeToolInput(tool.inputSchema, block.input) : block.input
      const call: Call = {
        block, result: { type: 'tool_result', tool_use_id: block.id, content: '' }, failure: 'failed', cwd: context.cwd, tool, input,
        budgetInput: options.budgetInput ?? callIdentity(block.name, input),
        budgetStopped: false, budgetRefused: false, userDenied: false, approvalUnavailable: false, started: false, executed: false, asked: false, reported: false,
        ...(wrapperError ? { wrapperError } : {}),
      }
      const kind = kindOf(block.name, tool)
      const key = kind ? canonicalJSON({ tool: block.name, input: call.budgetInput, cwd: call.cwd }) : undefined
      // Another kind, or a repeat of a call in the group: the group settles first, so the failure
      // budget has seen how that call ended (a repeated failing call is refused, as when serial).
      if (!kind || kind !== groupKind || groupKeys.has(key!)) await flush()
      // Under Guillotine Mode prepare() binds the call's own proxy port pair, from a finite pool,
      // and holds it until the call ends. A call joins the group only once one of its slots is free
      // (and the pair is freed as soon as it ends, below), so a long run of reads holds at most the
      // group's concurrency in pairs, not one per call: the 65th read no longer finds the pool full.
      const slot = guard && kind ? slots[kind] : undefined
      if (slot) await slot.acquire()
      const execute = await prepare(call)
      // An approved read runs alone: WebFetch grants its host to the session only as it runs, and
      // a network-classified call (always asked) stays serial. An approved sub-agent does not: its
      // approval grants nothing a later call's gate depends on (a session rule is in place before
      // the approval returns), so approved sub-agents run side by side, as the Agent tool promises.
      if (!execute || !kind || (call.asked && kind === 'read')) {
        slot?.release()
        if (execute) { await flush(); await execute() }
        // A refused call behind running calls: its card settles now, its result in model order.
        if (group.length) { report(call); group.push(Promise.resolve(call)); groupKeys.add(key!) } else await finish(call)
        continue
      }
      groupKind = kind; groupKeys.add(key!)
      const limit = slots[kind]
      group.push((async () => {
        if (!slot) await limit.acquire()
        // Its proxy pair is freed before its slot, so the next call gated for this group finds one.
        try { await execute() } finally { guard?.complete(call.networkCall); limit.release() }
        // Its card settles when it ends; the result follows in model order.
        report(call)
        return call
      })())
    }
    await flush()
    // A Stop sent during the last call (a synchronous one gives its handler no turn) is handled
    // before the caller sends the next model request.
    if (context.signal) await yieldToLoop()
  } finally { if (!options.hook) context.failureBudget?.endBatch() }
  await guard?.check()
  return { results, toolCallCount: toolUseBlocks.length, errors: results.filter((r) => r.is_error).length, stopped: context.failureBudget?.stopped }
}

/** At most `limit` holders at once; the others wait in order. */
function semaphore(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return {
    async acquire() { while (active >= limit) await new Promise<void>(resolve => waiting.push(resolve)); active++ },
    release() { active--; waiting.shift()?.() },
  }
}

/** A stopped agent must not stay parked on an approval nobody will answer. */
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  const cancelled = () => new Error('Query cancelled while waiting for approval')
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if ('content' in obj && typeof obj.content === 'string') return obj.content
    if ('stdout' in obj) {
      const parts: string[] = []
      if (obj.stdout) parts.push(String(obj.stdout))
      if (obj.stderr) parts.push(`STDERR: ${obj.stderr}`)
      if (obj.exitCode !== 0 && obj.exitCode !== null) {
        parts.push(`Exit code: ${obj.exitCode}`)
      }
      return parts.join('\n')
    }
    if ('entries' in obj && Array.isArray(obj.entries) && obj.entries.every(entry => typeof entry === 'string')) {
      // An empty result would leave the model guessing whether the call did anything.
      return obj.entries.length ? obj.entries.join('\n') : '[The folder is empty.]'
    }
    if ('filenames' in obj) {
      const fnames = obj.filenames as string[]
      return fnames.length > 0 ? fnames.join('\n') : (obj.content as string) ?? 'No results'
    }
    if ('answers' in obj) {
      const answers = obj.answers as Record<string, string>
      return Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')
    }
    return JSON.stringify(output, null, 2)
  }
  return String(output)
}
