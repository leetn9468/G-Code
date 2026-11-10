import { prepareToolProcess, trackToolProcess } from '../security/process.js'
/**
 * @file subprocess.ts
 * @brief Runs a command to its end and always settles.
 *
 * Under heavy CPU load, Bun 1.3's node:child_process sometimes delivers none of an exited child's
 * events: no 'exit', no 'end' or 'close' on its pipes, no 'close'. The child was spawned and
 * reaped, so a caller that waits for 'close' waits forever. Bun.spawn (its `exited` promise and
 * its streams) does not lose them, so under Bun the command runs with Bun.spawn; elsewhere it runs
 * with node:child_process. Either way a liveness poll (kill(pid, 0) returning ESRCH) settles the
 * run with the output collected so far once the command is gone, and the timeout and the abort
 * settle it even when no event ever arrives.
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { endWatchdog, watchGroup } from './watchdog.js'
import { toolEnv } from '../runtime/node.js'
import { tailUnits } from './textUnits.js'

export interface SubprocessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** SIGTERM (to the group), then SIGKILL after `killGraceMs`, once this long has passed. */
  timeoutMs: number
  signal?: AbortSignal
  /** POSIX: the command leads its own process group, so a stop reaches all it started. */
  group?: boolean
  /** Per stream, in UTF-16 units; output past it is still read (the pipe must drain) and dropped. */
  maxOutput?: number
  /** Per stream, in UTF-16 units: the end of the output kept in `tail`, past `maxOutput` too. */
  keepTail?: number
  /** Called with every chunk read, before `maxOutput` drops any (to save all of a long output). */
  onData?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => void
  /** Between SIGTERM and SIGKILL. */
  killGraceMs?: number
  /**
   * Kill the command (group) with SIGKILL when this process exits. For a group, a detached
   * watchdog (see watchGroup) also ends it when this process dies without exiting (SIGKILL, a
   * crash), so it is never left running unsupervised.
   */
  killOnExit?: boolean
  /**
   * On a timeout or abort, report in `leftGroup` the processes it started that left the group, which
   * the stop cannot reach. They are not signalled: some tools daemonize on purpose.
   */
  reportLeftGroup?: boolean
  /** Tests only: a spawner standing in for Bun.spawn or node:child_process. */
  backend?: SubprocessBackend
}

export interface SubprocessResult {
  stdout: string
  stderr: string
  /** Null when it died of a signal, was stopped, or its exit status never arrived. */
  exitCode: number | null
  signal: string | null
  /** Ended by the timeout or the abort signal. */
  interrupted: boolean
  timedOut: boolean
  /** It ended, but its exit status was never reported (see the file comment). */
  statusLost: boolean
  /** Set when the command could not be started. */
  spawnError?: string
  /** The command's pid (for a group, also its process group id). */
  pid?: number
  /** Bytes read from each stream, including any `maxOutput` dropped. */
  bytes: { stdout: number; stderr: number }
  /** True for a stream whose text was cut at `maxOutput`. */
  truncated: { stdout: boolean; stderr: boolean }
  /** With `keepTail`: the last `keepTail` units (or fewer) of each stream, however long it was. */
  tail?: { stdout: string; stderr: string }
  /**
   * A group only: the command exited, but processes it started are still in its group (a
   * `server > log 2>&1 &`). They are not stopped, and no exit hook or watchdog guards them any
   * more: the caller takes them over (BashTool tracks them as a background task).
   */
  groupLeft?: boolean
  /** With reportLeftGroup: the pids that left the group (setsid, a daemon) and were still running when the run settled. */
  leftGroup?: number[]
  /**
   * With groupLeft: the output pipes, when what was left running still holds them (a `server &`
   * with no redirect). They are still read, so a write to them never fails; the caller must
   * attach() to get the rest of the output, or release() them.
   */
  pipes?: LeftPipes
}

/** The pipes of a run that settled while processes it left running still hold them. */
export interface LeftPipes {
  /** The rest of the output (what came since the run settled first), then `end` once both pipes have closed. */
  attach(handlers: { data(stream: 'stdout' | 'stderr', chunk: Uint8Array): void; end(): void }): void
  /** Stops reading them: what still writes to them may then fail (SIGPIPE). */
  release(): void
}

/** What the run needs from a started process, whichever API started it. */
export interface StartedProcess {
  pid: number | undefined
  /** Calls the handlers as the process reports; any of them may never be called. */
  wire(handlers: {
    data(stream: 'stdout' | 'stderr', chunk: Uint8Array): void
    end(stream: 'stdout' | 'stderr'): void
    exit(code: number | null, signal: string | null): void
    error(error: Error): void
  }): void
  /** Lets go of the pipes once the run has settled without them ending. */
  release(): void
  /** Signal for the process itself when it is not a group leader. */
  kill(signal: NodeJS.Signals): void
}

export type SubprocessBackend = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; group: boolean }) => StartedProcess

/** How often a running command is checked for having gone without a word. */
export const LIVENESS_POLL_MS = 100
/** Checks in a row that find it gone and bring no new output before the run settles anyway. */
const QUIET_CHECKS = 3
/** After the SIGKILL, the longest a stopped run waits for anything before it settles. */
const AFTER_KILL_MS = 500
/** Once the command has exited, how long processes it started may take to leave its group before they count as left running. */
const LEFTOVER_GRACE_MS = 250
const LEFTOVER_CHECK_MS = 50
/**
 * The longest a pipe is read without a turn of the event loop. While a pipe holds data, Bun's
 * stream reads resolve as microtasks, so a command that prints without pause (`yes`) would
 * otherwise hold back timers (the timeout), signal handlers (Stop) and other output for as long
 * as it prints.
 */
const READ_TURN_MS = 10
/** Output held for left-over pipes until the caller attaches (see LeftPipes). */
const LEFT_PIPES_BUFFER = 1024 * 1024
/** Left-over pipes nobody attached to are released after this long. */
const LEFT_PIPES_UNCLAIMED_MS = 5000

/** The most UTF-8 bytes one UTF-16 unit takes: a byte tail this many times `keepTail` decodes to at least `keepTail` units. */
const BYTES_PER_UNIT = 3

/**
 * The last bytes of a stream past its head (`maxOutput`), in one buffer of twice the kept size:
 * a chunk is copied in, and only when the buffer is full is its end moved to the front, so a
 * command that prints without end costs no allocation per chunk.
 */
class ByteTail {
  private buffer: Buffer
  private length = 0
  /** Bytes between the head and what is kept were dropped. */
  dropped = false
  constructor(private readonly keep: number) { this.buffer = Buffer.allocUnsafe(keep * 2) }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.keep) {
      if (this.length > 0 || chunk.byteLength > this.keep) this.dropped = true
      this.buffer.set(chunk.subarray(chunk.byteLength - this.keep))
      this.length = this.keep
      return
    }
    if (this.length + chunk.byteLength > this.buffer.length) {
      const start = this.length + chunk.byteLength - this.keep
      this.buffer.copyWithin(0, start, this.length)
      this.length -= start
      this.dropped = true
    }
    this.buffer.set(chunk, this.length)
    this.length += chunk.byteLength
  }

  bytes(): Buffer { return this.buffer.subarray(0, this.length) }
}

/** A turn of the event loop: timers, I/O and signal handlers that are due run first. */
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

export { endWatchdog, watchGroup } from './watchdog.js'

interface BunSubprocess {
  pid: number
  stdout: ReadableStream<Uint8Array> | undefined
  stderr: ReadableStream<Uint8Array> | undefined
  exited: Promise<number>
  exitCode: number | null
  signalCode: string | null
  kill(signal?: string | number): void
}
type BunSpawn = (argv: string[], options: Record<string, unknown>) => BunSubprocess

function bunSpawn(): BunSpawn | undefined {
  const bun = (globalThis as { Bun?: { spawn?: BunSpawn } }).Bun
  return typeof bun?.spawn === 'function' ? bun.spawn : undefined
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value
  return out
}

/** Bun.spawn: its `exited` promise and stream reads. */
export const bunBackend: SubprocessBackend = (argv, options) => {
  const spawn = bunSpawn()
  if (!spawn) throw new Error('Bun.spawn is not available')
  const proc = spawn(argv, { cwd: options.cwd, env: cleanEnv(options.env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: options.group, windowsHide: true })
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = []
  return {
    pid: proc.pid,
    wire(handlers) {
      const pump = async (stream: ReadableStream<Uint8Array> | undefined, name: 'stdout' | 'stderr') => {
        if (!stream) { handlers.end(name); return }
        const reader = stream.getReader()
        readers.push(reader)
        try {
          let turn = performance.now()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value?.byteLength) handlers.data(name, value)
            if (performance.now() - turn >= READ_TURN_MS) { await nextTurn(); turn = performance.now() }
          }
        } catch { /* Cancelled or broken: the stream has ended either way. */ }
        handlers.end(name)
      }
      void pump(proc.stdout, 'stdout')
      void pump(proc.stderr, 'stderr')
      proc.exited.then(() => handlers.exit(proc.exitCode, proc.signalCode), error => handlers.error(error instanceof Error ? error : new Error(String(error))))
    },
    release() { for (const reader of readers) reader.cancel().catch(() => { /* Already closed. */ }) },
    kill(signal) { try { proc.kill(signal) } catch { /* Gone. */ } },
  }
}

/** node:child_process, for Node (and a fallback). */
export const nodeBackend: SubprocessBackend = (argv, options) => {
  const child: ChildProcess = nodeSpawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: options.group })
  return {
    pid: child.pid,
    wire(handlers) {
      for (const name of ['stdout', 'stderr'] as const) {
        const stream = child[name]
        if (!stream) { handlers.end(name); continue }
        stream.on('data', (chunk: Buffer) => handlers.data(name, chunk))
        stream.on('end', () => handlers.end(name))
        stream.on('close', () => handlers.end(name))
        stream.on('error', () => handlers.end(name))
      }
      child.on('exit', (code, signal) => handlers.exit(code, signal))
      child.on('close', (code, signal) => { handlers.end('stdout'); handlers.end('stderr'); handlers.exit(code, signal) })
      child.on('error', error => handlers.error(error))
    },
    release() { child.stdout?.destroy(); child.stderr?.destroy() },
    kill(signal) { try { child.kill(signal) } catch { /* Gone. */ } },
  }
}

/** Whether `target` (a pid, or a negative process group id) still exists. EPERM: it does, as someone else's (or a zombie group). */
export function processExists(target: number): boolean {
  try { process.kill(target, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * The running processes descended from process group `pgid` that are in no such group any more: they
 * started a session or a group of their own, so a signal to the group does not reach them. One whose
 * parent has already gone (a daemon that forked twice) cannot be told from any other process, and is
 * not found. Best effort: empty when `ps` cannot say. POSIX only.
 */
export function leftTheGroup(pgid: number): number[] {
  try {
    const listing = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/bin:/usr/bin' } })
    const rows = (listing.stdout ?? '').split('\n').flatMap(line => { const [pid, ppid, group] = line.trim().split(/\s+/).map(Number); return pid && group !== undefined ? [{ pid, ppid: ppid!, group }] : [] })
    const children = new Map<number, number[]>()
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
    const seen = new Set(rows.filter(row => row.group === pgid).map(row => row.pid))
    const found: number[] = []
    for (const next of [...seen]) {
      for (const child of children.get(next) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
      }
    }
    // Their own children, whatever group those are in.
    for (let index = 0; index < found.length; index++) {
      for (const child of children.get(found[index]!) ?? []) { if (!seen.has(child)) { seen.add(child); found.push(child) } }
    }
    return found
  } catch { return [] }
}

/** Says which processes a stop did not reach (see leftTheGroup); '' when there are none. */
export function leftGroupNote(pids: readonly number[] | undefined): string {
  if (!pids?.length) return ''
  const shown = pids.slice(0, 8).join(', ') + (pids.length > 8 ? `, and ${pids.length - 8} more` : '')
  return ` ${pids.length === 1 ? 'A process it started' : `${pids.length} processes it started`} left its process group (setsid, or a daemon), so the stop did not reach ${pids.length === 1 ? 'it' : 'them'} and ${pids.length === 1 ? 'it is' : 'they are'} still running, not tracked by G-Code: pid ${shown}. Stop ${pids.length === 1 ? 'it' : 'them'} with kill if ${pids.length === 1 ? 'it' : 'they'} should not keep running.`
}

/**
 * Runs `argv` (no shell of its own: pass `bash -c …` to get one) to its end. Resolves once the
 * command has exited and its pipes have closed; once it is gone, even if no event said so; or,
 * after a timeout or an abort, once it has been stopped (at most `killGraceMs` + 500 ms later).
 * A group whose command exited while processes it started stay in it resolves too, with
 * `groupLeft` set. Never rejects.
 */
export function runSubprocess(argv: string[], options: SubprocessOptions): Promise<SubprocessResult> {
  const posix = process.platform !== 'win32'
  const group = posix && (!options.backend || options.group === true)
  const maxOutput = options.maxOutput ?? Infinity
  const keepTail = options.keepTail !== undefined && options.keepTail > 0 ? Math.floor(options.keepTail) : 0
  const killGraceMs = options.killGraceMs ?? 2000
  const chosenBackend = options.backend ?? (bunSpawn() ? bunBackend : nodeBackend)
  let guard: ReturnType<typeof prepareToolProcess>['guard']
  const backend: SubprocessBackend = (args, opts) => {
    if (options.backend) return chosenBackend(args, opts)
    const launch = prepareToolProcess(args, opts.env, opts.cwd)
    guard = launch.guard
    const child = chosenBackend(launch.argv, { ...opts, env: launch.env, group: opts.group })
    trackToolProcess(launch.call, child.pid, args, opts.cwd)
    return child
  }

  return new Promise(resolve => {
    const text = { stdout: '', stderr: '' }
    const full = { stdout: false, stderr: false }
    const ended = { stdout: false, stderr: false }
    const bytes = { stdout: 0, stderr: 0 }
    const truncated = { stdout: false, stderr: false }
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    // Made once a stream passes maxOutput: most commands never need one.
    const tails: { stdout?: ByteTail; stderr?: ByteTail } = {}
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let exited = false
    let interrupted = false
    let timedOut = false
    let settled = false
    let freshOutput = false
    let goneChecks = 0
    let leftoverSince: number | undefined
    let leftoverTimer: ReturnType<typeof setTimeout> | undefined
    let started: StartedProcess | undefined
    let leftGroup: number[] = []
    let watchdog: ChildProcess | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const later = (ms: number, run: () => void) => { const timer = setTimeout(run, ms); timers.push(timer); return timer }

    const kill = (signal: NodeJS.Signals) => {
      const pid = started?.pid
      if (group && pid) { try { process.kill(-pid, signal) } catch { /* The group is gone. */ } }
      else started?.kill(signal)
    }
    const onProcessExit = () => kill('SIGKILL')
    const interrupt = (why: 'timeout' | 'abort') => {
      if (interrupted || settled) return
      interrupted = true
      timedOut = why === 'timeout'
      // Looked up first: once the group has gone, nothing leads to them.
      if (options.reportLeftGroup && group && started?.pid) leftGroup = leftTheGroup(started.pid)
      kill('SIGTERM')
      later(killGraceMs, () => { kill('SIGKILL'); later(AFTER_KILL_MS, () => finish()) })
    }
    const onAbort = () => interrupt('abort')

    /** Once the run has settled with its pipes still held by what it left running (see LeftPipes). */
    type Left = { held: Array<['stdout' | 'stderr', Uint8Array]>; heldBytes: number; handlers?: Parameters<LeftPipes['attach']>[0]; released: boolean }
    let left: Left | undefined
    const pipesEnded = () => ended.stdout && ended.stderr
    const leftPipes = (): LeftPipes => {
      const state: Left = left = { held: [], heldBytes: 0, released: false }
      const release = () => { if (!state.released) { state.released = true; state.held = []; started?.release() } }
      const unclaimed = setTimeout(() => { if (!state.handlers) release() }, LEFT_PIPES_UNCLAIMED_MS)
      ;(unclaimed as { unref?: () => void }).unref?.()
      return {
        attach(handlers) {
          clearTimeout(unclaimed)
          if (state.released || state.handlers) return
          state.handlers = handlers
          for (const [name, chunk] of state.held.splice(0)) handlers.data(name, chunk)
          state.heldBytes = 0
          if (pipesEnded()) handlers.end()
        },
        release() { clearTimeout(unclaimed); release() },
      }
    }

    const finish = (spawnError?: string) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (pollTimer) clearTimeout(pollTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (options.killOnExit) process.removeListener('exit', onProcessExit)
      endWatchdog(watchdog)
      // Bytes of an unfinished character at the very end.
      for (const name of ['stdout', 'stderr'] as const) if (!full[name]) text[name] += decoders[name].end()
      const tailOf = (name: 'stdout' | 'stderr'): string => {
        const kept = tails[name]
        if (!kept) return tailUnits(text[name], keepTail)
        const bytes = kept.bytes()
        // Nothing dropped: the kept bytes go on from the head, so its decoder (with any half character it holds) goes on too.
        if (!kept.dropped) return tailUnits(text[name] + decoders[name].write(bytes) + decoders[name].end(), keepTail)
        let start = 0
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
        const decoder = new StringDecoder('utf8')
        return tailUnits(decoder.write(bytes.subarray(start)) + decoder.end(), keepTail)
      }
      const pid = started?.pid
      // Not by this run, so perhaps by the sandbox, whose denial record macOS can lose: see NetworkGuard.noteKilled.
      if (!interrupted && !spawnError && (exitSignal === 'SIGKILL' || exitCode === 137 || !exited)) guard?.noteKilled(pid)
      // A stopped run had its whole group killed; anything else still in the group was left running by the command.
      const groupLeft = group && !interrupted && !spawnError && pid !== undefined && processExists(-pid)
      const stillRunning = leftGroup.filter(other => processExists(other))
      // What was left running may still write to the pipes: they are handed over, not closed under it.
      const pipes = !pipesEnded() && started ? groupLeft ? leftPipes() : (started.release(), undefined) : undefined
      resolve({
        stdout: text.stdout, stderr: text.stderr, exitCode, signal: exitSignal, interrupted, timedOut, statusLost: !exited && !spawnError,
        ...(spawnError ? { spawnError } : {}), ...(pid !== undefined ? { pid } : {}), bytes, truncated,
        ...(keepTail ? { tail: { stdout: tailOf('stdout'), stderr: tailOf('stderr') } } : {}), ...(groupLeft ? { groupLeft } : {}), ...(pipes ? { pipes } : {}), ...(stillRunning.length ? { leftGroup: stillRunning } : {}),
      })
    }
    /**
     * Once the command has exited. Processes it started may still be in its group (`server &`, or
     * ones on their way out): a moment for those to go, then the run settles and reports what is
     * left, even while those still hold the pipes. Otherwise it settles once the pipes have closed.
     */
    const check = () => {
      if (settled || !exited) return
      const pid = started?.pid
      if (group && pid !== undefined && processExists(-pid)) {
        // Being stopped: the SIGKILL that follows (and its settle) must not be cancelled by settling now.
        if (interrupted) return
        leftoverSince ??= Date.now()
        if (Date.now() - leftoverSince < LEFTOVER_GRACE_MS) {
          leftoverTimer ??= later(LEFTOVER_CHECK_MS, () => { leftoverTimer = undefined; check() })
          return
        }
        return finish()
      }
      if (pipesEnded()) finish()
    }

    /**
     * The liveness poll. The command is gone once its pid is (it has been reaped) and, for a
     * group, once nothing is left in the group or its pipes have closed (what it left running in
     * the group is then reported as groupLeft). A pipe still open after the group is gone belongs
     * to a process that left the group (a daemon); its output is not waited for. A few quiet
     * checks in a row first, so output and the exit status still on their way arrive.
     */
    const poll = () => {
      if (settled) return
      const pid = started?.pid
      const leaderGone = pid !== undefined && !processExists(pid)
      // The command has been reaped (its exit event may be lost) but left processes in its group:
      // settled after the same grace as check() gives, however much they print.
      if (group && leaderGone && !interrupted && processExists(-pid!)) {
        leftoverSince ??= Date.now()
        if (Date.now() - leftoverSince >= LEFTOVER_GRACE_MS) return finish()
        goneChecks = 0
      } else {
        // While being stopped, a group that still has processes is not gone: its SIGKILL is on the way.
        const gone = leaderGone && (!group || !processExists(-pid!))
        if (gone && !freshOutput) goneChecks++
        else goneChecks = 0
      }
      freshOutput = false
      if (goneChecks >= QUIET_CHECKS) return finish()
      pollTimer = setTimeout(poll, LIVENESS_POLL_MS)
    }

    try { started = backend(argv, { cwd: options.cwd, env: toolEnv(options.env), group }) }
    catch (error) { return finish(error instanceof Error ? error.message : String(error)) }
    if (options.killOnExit) process.once('exit', onProcessExit)
    // The exit hook does not run when this process is SIGKILLed or crashes; the watchdog does.
    // (A stand-in backend from a test has no real group to guard.)
    if (options.killOnExit && group && started.pid !== undefined && !options.backend) watchdog = watchGroup(started.pid)
    started.wire({
      data(name, chunk) {
        freshOutput = true
        if (settled) {
          if (!left || left.released) return
          if (left.handlers) left.handlers.data(name, chunk)
          else if (left.heldBytes < LEFT_PIPES_BUFFER) { left.held.push([name, chunk]); left.heldBytes += chunk.byteLength }
          return
        }
        bytes[name] += chunk.byteLength
        options.onData?.(name, chunk)
        if (full[name]) {
          truncated[name] = true
          if (keepTail) (tails[name] ??= new ByteTail(keepTail * BYTES_PER_UNIT)).push(chunk)
          return
        }
        text[name] += decoders[name].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        full[name] = text[name].length >= maxOutput
      },
      end(name) {
        if (ended[name]) return
        ended[name] = true
        if (settled) { if (pipesEnded() && left?.handlers && !left.released) left.handlers.end(); return }
        check()
      },
      exit(code, signal) {
        if (exited) return
        exited = true
        exitCode = code
        exitSignal = signal
        check()
      },
      error(error) {
        // No pid: it never started. Otherwise (a failed kill) the run goes on.
        if (started?.pid === undefined) finish(error.message)
      },
    })
    // No pid: it did not start, and its 'error' is on the way (or lost: then this settles it).
    if (started.pid === undefined) { later(1000, () => finish('the process did not start')); return }
    later(options.timeoutMs, () => interrupt('timeout'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) interrupt('abort')
    pollTimer = setTimeout(poll, LIVENESS_POLL_MS)
  })
}
