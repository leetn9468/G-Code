import { canonicalJSON, sha256 } from '../utils/hash.js'
import { headUnits } from '../utils/textUnits.js'
import { allowingModes } from '../shared/sessionControls.js'

export interface FailureBudgetLimits {
  /** Tool calls allowed in one turn (default 400, about four per reply at 100 replies; Infinity for no cap). */
  maxAttempts?: number
  /** Failed or denied calls before the turn stops (default 6). */
  maxFailures?: number
  /** Failed or denied calls of one tool before the turn stops (default 3). */
  maxFailuresPerTool?: number
  /**
   * Main-conversation rules. Failures count in a row: a successful model call
   * resets the total and every tool's count, and forgets the calls that failed
   * before it, so a test-fix-retest loop (tests fail, an edit succeeds, the same
   * tests run again) keeps going. One reply is one step: its failed calls add at
   * most one to each tool's count and one to the total, because one cause (a file
   * saved in an editor after it was read) often fails them all before the model
   * has seen any result. A call the user declined is not a failure: the turn goes
   * on, every other call is still asked, and the model gets to answer. Repeating a
   * failed call with no success in between, or a call the user declined, is refused
   * as a tool error instead of ending the turn. One tool's limit applies only once an
   * error comes back that an earlier reply already got: different errors one after
   * another are the model working through a problem (a missing command, then a bug in
   * its own script), and only the total limit bounds them. Without it (sub-agents,
   * workflows) a successful call resets the counts only when it is new work: a call and result not
   * seen before in this turn (an edit, a new search, a file that changed), so a real fix-and-test
   * loop finishes and one that repeats itself does not; the call cap and the round cap bound the
   * rest. Each call counts there, and repeating a failed call with no success in between, or a call
   * the user declined, ends the turn. One tool's limit there too applies only once an error
   * comes back that an earlier reply already got. After a success a failed call may run again
   * there: a sub-agent fixing its own failing tests reruns the same test command.
   */
  resetOnSuccess?: boolean
}

/** Who made a call and how it ended, as the budget needs to know it. */
export interface CallOutcome {
  /** Approval was refused: the call stays remembered and is not asked again this turn. */
  denied?: boolean
  /** With `denied`: nobody could be asked (a headless run, or no approval handler), so no user refused it. */
  unavailable?: boolean
  /** A project hook, not the model, made the call. Its failures count; its successes reset nothing. */
  hook?: boolean
  /** A successful call's result: the same call with another result is new work (a file that changed). */
  result?: string
  /** The budget refused it as a repeat of a failed or declined call: it counts, but never ran. */
  refused?: boolean
}

/** Why a call must not run. `stop` also ends the turn; otherwise the call returns this as its error. */
export interface CallRefusal { reason: string; stop: boolean; denied: boolean }

/**
 * A main conversation has no step limit, so it has no call cap either, and a
 * long build that fails now and then keeps going. A run of failures still stops
 * it. Sub-agents and workflows keep the defaults.
 */
export const MAIN_CONVERSATION_BUDGET: Readonly<FailureBudgetLimits> = Object.freeze({ maxAttempts: Infinity, resetOnSuccess: true })

/**
 * What tells two calls of a tool apart for the budget. A Bash `description` is only a label the
 * model rewrites on every call: the same command with a new description is the same call.
 */
export function callIdentity(tool: string, input: unknown): unknown {
  if (tool !== 'Bash' || !input || typeof input !== 'object' || Array.isArray(input) || !('description' in input)) return input
  const { description: _label, ...rest } = input as Record<string, unknown>
  return rest
}

/** After this many identical successful calls with no file changed, and every this many after, the result says so. */
export const REPEAT_NOTE_EVERY = 25
/** Calls counted at once: past this the least recently seen one is forgotten. */
const REPEAT_CALLS_KEPT = 1024

/**
 * What the model reads in the result of a call it keeps repeating. It stops nothing: a long wait on
 * real work goes on. G-Code knows only the changes it records, so the text claims no more than that.
 */
export function repeatNote(tool: string, count: number): string {
  return `[G-Code note: this exact ${tool} call has now succeeded ${count} times in this turn, and G-Code recorded no file change since the count began. It cannot see changes outside the project or in folders it does not list, or whether other work is moving (a build, a background task, a service). If you are waiting on real progress, carry on. If not, you are repeating yourself: change your approach, or say what is blocking you.]`
}

/** A declined call is the same request whatever time limit it asked for: the user said no to running it. */
function declinedIdentity(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('timeout' in input)) return input
  const { timeout: _limit, ...rest } = input as Record<string, unknown>
  return rest
}

/**
 * A failure's cause as the budget compares it: its result without numbers (times, line numbers,
 * pids and exit codes differ between runs of one cause) or runs of white space.
 */
function causeOf(result: string): string {
  return result.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

/**
 * A command that failed and printed nothing, in causeOf's form: grep finding no match, `test -f` on a
 * missing file. Its result says nothing about why, so two such commands share no known cause: a model
 * searching with different patterns was stopped as if it kept getting one error.
 */
const SILENT_FAILURE = /^Error: Command failed Exit code: #$/

/** A quoted result as one sentence: it never ends in a doubled period. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

interface FailedCall { result: string; denied: boolean; unavailable: boolean }

/** How the budget's texts address the run it is part of. */
export interface FailureBudgetOptions {
  /**
   * A non-interactive run (gcode -p): nobody can approve a call there, and the user allows calls
   * with the permission mode they start it with, so a refusal for want of approval says how.
   */
  headless?: boolean
  /** The permission mode now, for a -p run's advice on which mode allows the refused calls. Defaults to 'default'. */
  permissionMode?: () => string
}

/** For a -p run: how the user allows a call of `tool` that needed approval in `mode` (see allowingModes). */
function headlessHint(mode: string, tool: string): string {
  return allowingModes(mode, [tool]).includes('acceptEdits')
    ? 'To allow such calls, run gcode -p again with --permission-mode acceptEdits (file edits in the project) or --permission-mode bypass (all tools).'
    : 'To allow such calls, run gcode -p again with --permission-mode bypass (all tools).'
}

/** How a remembered call ended, for the person reading a stop message (never the model's instructions). `hint`: a -p run's advice. */
function outcomeLine(call: FailedCall, label: string, hint?: string): string {
  if (call.denied) return `${label} was not run: ${call.unavailable ? 'it needed approval, and nobody can approve calls in this run' : 'the user declined it'}.${call.unavailable && hint ? ` ${hint}` : ''}`
  return `${label === 'The last call' ? 'Last error' : 'Previous error'}: ${sentence(headUnits(quotedError(call.result), 1200))}`
}

/**
 * A result as a stop message quotes it: without its own "Error:" label (the line already says
 * "error"), and without a closing "Exit code: N" that its first line already gives.
 */
function quotedError(result: string): string {
  const text = result.replace(/^(Tool execution error|Error):\s*/, '')
  const code = /\n+Exit code: (-?\d+)\s*$/.exec(text)
  return code && text.includes(`exited with code ${code[1]}`) ? text.slice(0, code.index) : text
}

/** Says how many of the counted calls were refused repeats, which never ran. */
function refusedNote(refused: number): string {
  return refused === 1 ? ' (1 of them a refused repeat, which did not run)' : refused ? ` (${refused} of them refused repeats, which did not run)` : ''
}

/** When one reply failed several calls, the replies they came in: the count the limit applies to. */
function across(tally: { calls: number }, replies: number): string {
  return tally.calls > replies ? ` across ${replies} replies` : ''
}

/** One user turn owns one budget, shared by tools and project hooks. */
export class TurnFailureBudget {
  private failedCalls = new Map<string, FailedCall>()
  /** The declined calls again, keyed without their time limit. */
  private declinedCalls = new Map<string, FailedCall>()
  private toolFailures = new Map<string, number>()
  private failures = 0
  /**
   * The failed calls behind those counts, and the refused repeats among them: with resetOnSuccess
   * a count is of replies (one per reply), which a stop message must not call a number of calls.
   */
  private toolCalls = new Map<string, { calls: number; refused: number }>()
  private failedTally = { calls: 0, refused: 0 }
  private attempts = 0
  private maxAttempts: number
  private maxFailures: number
  private maxFailuresPerTool: number
  private resetOnSuccess: boolean
  /** The tools whose failure the open reply already counted, and whether it counted one toward the total. */
  private batch: Set<string> | null = null
  private batchCounted = false
  /** The reply (or, outside a reply, the call) being recorded, so a cause seen again in the same one is no repeat. */
  private step = 0
  /** Per tool, the causes of its current run of failures and the step each was first seen in. */
  private causes = new Map<string, Map<string, number>>()
  /** The tools whose current run got an error an earlier reply already got. */
  private repeating = new Set<string>()
  private headless: boolean
  private permissionMode: () => string
  /** Without resetOnSuccess: the successful calls and results seen, and whether one has reset the counts yet. */
  private succeeded = new Set<string>()
  private countsReset = false
  /** Identical successful calls since the last file change or user message (see noteRepeat). */
  private repeats = new Map<string, number>()
  private changesSeen = 0
  stopped?: string

  constructor(limits: FailureBudgetLimits = {}, options: FailureBudgetOptions = {}) {
    this.maxAttempts = limits.maxAttempts ?? 400
    this.maxFailures = limits.maxFailures ?? 6
    this.maxFailuresPerTool = limits.maxFailuresPerTool ?? 3
    this.resetOnSuccess = limits.resetOnSuccess ?? false
    this.headless = options.headless ?? false
    this.permissionMode = options.permissionMode ?? (() => 'default')
  }

  /** A -p run's advice on allowing a refused call of `tool`; undefined in any other run. */
  private hint(tool: string): string | undefined {
    return this.headless ? headlessHint(this.permissionMode(), tool) : undefined
  }

  private key(tool: string, input: unknown, cwd: string): string {
    return sha256(canonicalJSON({ tool, input, cwd }))
  }

  private declinedKey(tool: string, input: unknown, cwd: string): string {
    return this.key(tool, declinedIdentity(input), cwd)
  }

  /** The calls of one model reply start (main conversation: they count as one step). */
  beginBatch(): void { this.batch = new Set(); this.batchCounted = false; this.step++ }

  /** The reply's calls are done. */
  endBatch(): void { this.batch = null; this.batchCounted = false }

  /** Checked before a call runs or asks for approval; undefined lets it run. */
  check(tool: string, input: unknown, cwd: string): CallRefusal | undefined {
    if (this.stopped) return { reason: this.stopped, stop: true, denied: false }
    const previous = this.failedCalls.get(this.key(tool, input, cwd)) ?? this.declinedCalls.get(this.declinedKey(tool, input, cwd))
    if (previous && !this.resetOnSuccess) {
      this.stopped = `Stopped repeated failed or denied ${tool} call. The same arguments will not execute or ask for approval again in this turn. ${outcomeLine(previous, 'It', this.hint(tool))}`
      return { reason: this.stopped, stop: true, denied: previous.denied }
    }
    if (previous) return {
      reason: previous.denied && previous.unavailable
        ? `Not run: approval was not available for this exact ${tool} call earlier in this turn (nobody can approve calls in this run), so it is not tried again. ${this.headless
          ? `Choose an approach that needs no approval, or tell the user that running gcode -p again with ${allowingModes(this.permissionMode(), [tool]).includes('acceptEdits') ? '--permission-mode acceptEdits allows file edits in the project, and ' : ''}--permission-mode bypass allows all tools.`
          : 'Choose another approach.'} Previous result: ${previous.result}`
        : previous.denied
        ? `Not run: the user denied this exact ${tool} call earlier in this turn, so it is not asked again. Choose another approach or ask the user. Previous result: ${previous.result}`
        : `Not run: this exact ${tool} call failed and no other call has succeeded since. Fix the cause first, then retry it. Previous result: ${previous.result}`,
      stop: false, denied: previous.denied,
    }
    if (++this.attempts > this.maxAttempts) {
      this.stopped = `Stopped after the ${this.maxAttempts}-call tool budget for this turn.`
      return { reason: this.stopped, stop: true, denied: false }
    }
    return undefined
  }

  /**
   * The user sent a message into the running turn: new information, so the run of failures starts
   * again and a call that failed may run again, as after a success. A declined call stays declined.
   */
  steered(): void {
    this.repeats.clear()
    if (this.stopped) return
    for (const [key, call] of this.failedCalls) if (!call.denied) this.failedCalls.delete(key)
    this.failures = 0
    this.toolFailures.clear()
    this.toolCalls.clear(); this.failedTally = { calls: 0, refused: 0 }
    this.causes.clear(); this.repeating.clear()
  }

  /**
   * A call of the model's that ran and succeeded. Counted per tool and exact input, so a cycle of
   * calls and a success between failures both count. `fileChanges`: how many file changes the turn
   * has recorded so far; a new one starts the counts again. Returns how many identical calls there
   * have been when this result should carry the note (every REPEAT_NOTE_EVERY: not on each call, so
   * a long loop's transcript stays as it is), otherwise undefined.
   */
  noteRepeat(tool: string, input: unknown, cwd: string, fileChanges: number): number | undefined {
    if (fileChanges !== this.changesSeen) { this.changesSeen = fileChanges; this.repeats.clear(); return undefined }
    const key = this.key(tool, callIdentity(tool, input), cwd)
    const count = (this.repeats.get(key) ?? 0) + 1
    this.repeats.delete(key)
    if (this.repeats.size >= REPEAT_CALLS_KEPT) this.repeats.delete(this.repeats.keys().next().value!)
    this.repeats.set(key, count)
    return count % REPEAT_NOTE_EVERY === 0 ? count : undefined
  }

  /** The reason a call must not run, or undefined. `stopped` says whether the turn ends too. */
  before(tool: string, input: unknown, cwd: string): string | undefined {
    return this.check(tool, input, cwd)?.reason
  }

  record(tool: string, input: unknown, cwd: string, error?: string, outcome: CallOutcome = {}): void {
    if (this.stopped) return
    if (!error) {
      // Only the model's own calls show that work moved on; a project hook passing does not.
      if (outcome.hook) return
      // Any tool: an edit that succeeds between two failing test runs is progress, so the failed
      // calls may run again. A declined call stays declined. In a sub-agent only new work resets the counts.
      for (const [key, call] of this.failedCalls) if (!call.denied) this.failedCalls.delete(key)
      let newWork = false
      if (!this.resetOnSuccess) {
        const done = sha256(`${this.key(tool, input, cwd)}\n${outcome.result ?? ''}`)
        newWork = !this.succeeded.has(done)
        this.succeeded.add(done)
        if (newWork && this.failures) this.countsReset = true
      }
      if (this.resetOnSuccess || newWork) {
        this.failures = 0
        this.toolFailures.clear()
        this.toolCalls.clear(); this.failedTally = { calls: 0, refused: 0 }
        this.causes.clear(); this.repeating.clear()
        if (this.batch) { this.batch.clear(); this.batchCounted = false }
      }
      return
    }
    const key = this.key(tool, input, cwd)
    const previous = this.failedCalls.get(key)
    // A refused repeat keeps the original result, so the next refusal does not quote a refusal.
    const call = previous ?? { result: headUnits(error, 1200), denied: !!outcome.denied, unavailable: !!outcome.denied && !!outcome.unavailable }
    if (!previous) this.failedCalls.set(key, call)
    else if (outcome.denied) { previous.denied = true; previous.unavailable = !!outcome.unavailable }
    if (call.denied) this.declinedCalls.set(this.declinedKey(tool, input, cwd), call)
    // A person who said no made a choice, not a mistake: the turn goes on so the model can answer.
    if (this.resetOnSuccess && outcome.denied && !outcome.unavailable) return
    // One reply is one step: its failures of a tool most often share one cause.
    const counted = this.resetOnSuccess && this.batch && !outcome.hook
    const countTool = !counted || !this.batch!.has(tool)
    const countTotal = !counted || !this.batchCounted
    if (counted) { this.batch!.add(tool); this.batchCounted = true }
    const count = (this.toolFailures.get(tool) ?? 0) + (countTool ? 1 : 0)
    this.toolFailures.set(tool, count)
    const total = countTotal ? ++this.failures : this.failures
    const ofTool = this.toolCalls.get(tool) ?? { calls: 0, refused: 0 }
    for (const tally of [ofTool, this.failedTally]) { tally.calls++; if (outcome.refused) tally.refused++ }
    this.toolCalls.set(tool, ofTool)
    // A refused repeat is compared by the error of the call it repeats. Where each call counts
    // (sub-agents), each is its own step: one error again with new arguments is a repeat.
    if (!this.batch || !this.resetOnSuccess) this.step++
    const seen = this.causes.get(tool) ?? new Map<string, number>()
    const said = causeOf(call.result)
    const cause = SILENT_FAILURE.test(said) ? `${said} ${key}` : said, first = seen.get(cause)
    if (first === undefined) seen.set(cause, this.step)
    else if (first !== this.step) this.repeating.add(tool)
    this.causes.set(tool, seen)
    // Sub-agents too: three different errors of one tool are work going on (a missing script, then a
    // failed command, then a bug in its own check), and only the total bounds them.
    const toolStop = count >= this.maxFailuresPerTool && this.repeating.has(tool)
    if (total < this.maxFailures && !toolStop) return
    const why = !this.resetOnSuccess ? `${total} failed/denied calls ${this.countsReset ? 'since its last new successful call' : 'in this turn'} (${count} for ${tool})`
      : total >= this.maxFailures ? `${this.failedTally.calls} failed/denied calls${across(this.failedTally, total)} in a row in this turn${refusedNote(this.failedTally.refused)}`
      : `${ofTool.calls} failed/denied ${tool} calls${across(ofTool, count)} in a row in this turn${refusedNote(ofTool.refused)}`
    this.stopped = `Stopped after ${why}. ${outcomeLine(call, 'The last call', this.hint(tool))}`
  }
}
