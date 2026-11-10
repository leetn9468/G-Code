/**
 * @file backgroundShells.ts
 * @brief Shell commands started with Bash `run_in_background` (dev servers,
 * watchers, long builds). They keep running after the tool returns; the agent
 * reads them with TaskOutput and stops them with TaskStop, and the desktop's
 * Tasks panel watches and stops them too. Processes a foreground Bash command
 * leaves running in its group are taken over as tasks too (see adopt). All of
 * them end with the process, even when it is killed without a chance to clean
 * up (see watchGroup in src/utils/subprocess.ts). What became of a session's
 * shells is kept with the session, so a resumed session is told which of them
 * ended with the process before (see TaskRecord).
 */

import { maskedTail, maskSecrets, withoutUnfinishedKey } from '../security/secretValues.js'
import { type ChildProcess } from 'node:child_process'
import { guardedSpawn as spawn } from '../security/process.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { toolEnv } from '../runtime/node.js'
import type { BackgroundShellInfo } from '../shared/tasks.js'
import { getSessionDirectory } from '../state/store.js'
import { CONTEXT_CLOSE, CONTEXT_OPEN } from '../engine/systemPrompt.js'
import { headUnits, tailOutput, tailOutputBytes } from '../utils/textUnits.js'
import { endWatchdog, leftTheGroup, processExists, watchGroup, type LeftPipes } from '../utils/subprocess.js'
export type { BackgroundShellInfo } from '../shared/tasks.js'
/** Surrogate-safe trims; they live in src/utils/textUnits.ts. */
export { headUnits, tailOutput, tailUnits } from '../utils/textUnits.js'

interface Entry {
  info: Omit<BackgroundShellInfo, 'tail'>
  output: string
  trimmed: boolean
  /** The command's own process; none for an adopted group. */
  child?: ChildProcess
  /** POSIX: its process group, which a stop signals as a whole. */
  pgid?: number
  stopping: boolean
  watchdog?: ChildProcess
  /** Checks the group: for what the command left running, and for an end no event reported. */
  poll?: ReturnType<typeof setInterval>
  /** Why it never ran: the spawn error. */
  startError?: string
  /** It ended, but no exit status was ever reported. */
  statusLost?: boolean
  /** Processes a foreground Bash command left running (see adopt): their own exit status is unknown. */
  adopted?: boolean
  /** Where the session it was started for keeps its record (see TaskRecord). */
  recordFile?: string
  /** Found when it was told to stop: processes it started that left its group, which the stop does not reach. */
  leftGroup?: number[]
  /** It was still running when stopAll or shutdown stopped every shell: its process was ending. */
  endedWithProcess?: boolean
  /** Rewrites its record with the output that came since (see RECORD_REFRESH_MS). */
  recordTimer?: ReturnType<typeof setTimeout>
  /** The id of the session it was started for (see takeEndedNotices). */
  session?: string
  /** The model knows it ended, or that it is being stopped: no notice of its end is due (see markSeen). */
  seen?: boolean
}

/** The session a shell is started for. */
export interface ShellSession { id: string; cwd: string }

/**
 * The session a tool call's shells are recorded under: the saved session it works for (a sub-agent's
 * or workflow agent's own session is never saved, so nothing would read their records there).
 */
export function taskSession(context: { sessionId: string; taskSessionId?: string; cwd: string }): ShellSession {
  return { id: context.taskSessionId || context.sessionId, cwd: context.cwd }
}

/**
 * What a session keeps of one of its background shells, so that a later G-Code process of the
 * session can say what became of it: shells end with the process that started them (the session
 * was closed, stopped or restarted). Written when a shell starts and ends and when every shell is
 * stopped, one JSON line per shell in the session's folder. A record still "running" from a process
 * that is gone means that process died: its watchdog then ended the shell.
 */
export interface TaskRecord {
  id: string
  command: string
  description?: string
  startedAt: number
  status: BackgroundShellInfo['status']
  /** As shellState gave it when the record was last written, e.g. "failed, exit code 1". */
  state: string
  /** It was still running when its G-Code process stopped every shell. */
  endedWithProcess?: boolean
  /** The end of its output. */
  tail: string
  /** The G-Code process that ran it (PROCESS_ID). */
  process: string
  /** The model was told how it ended: by a later process (see takeEndedTaskNotice), or by its own (see markSeen). */
  reported?: boolean
}

/** This G-Code process, in the records it writes: only another process's records are about shells that are gone. */
const PROCESS_ID = randomUUID()
const RECORD_FILE = 'background-tasks.jsonl'
/** Records a session keeps, the most recently started ones. */
const MAX_RECORDS = 20
const RECORD_TAIL_BYTES = 4 * 1024
/**
 * After output, a running shell's record is rewritten at most this often, so a process that dies
 * without a word (SIGKILL, a crash) leaves the shell's recent output, not the empty tail of its start.
 */
const RECORD_REFRESH_MS = 1000
/** Shells named in a turn's context block; TaskOutput gives the rest. */
const NOTICE_TASKS = 10
/** The same header as the turn context block's (buildTurnContext in src/engine/systemPrompt.ts). */
const CONTEXT_HEADER = 'Runtime context from G-Code, not written by the user:'

function recordFile(session: ShellSession | undefined): string | undefined {
  if (typeof session?.id !== 'string' || !session.id || typeof session.cwd !== 'string' || !session.cwd) return undefined
  try { return join(getSessionDirectory(session.cwd, session.id), RECORD_FILE) } catch { return undefined }
}

function readRecords(file: string | undefined): TaskRecord[] {
  if (!file) return []
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const records: TaskRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as TaskRecord
      if (record && typeof record.id === 'string' && typeof record.command === 'string' && typeof record.process === 'string' && typeof record.startedAt === 'number') records.push(record)
    } catch { /* A line that is not a record. */ }
  }
  return records
}

function writeRecords(file: string, records: TaskRecord[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    // A record holds the command line and the end of its output: private, like the session file.
    writeFileSync(temporary, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
    throw error
  }
}

/**
 * What a session's earlier G-Code process recorded of background shell `id`, which is gone with
 * that process; undefined when it recorded nothing (or the shell is this process's own).
 */
export function endedTask(session: ShellSession, id: string): TaskRecord | undefined {
  return readRecords(recordFile(session)).find(record => record.id === id && record.process !== PROCESS_ID)
}

/** Whether the record's shell was still running when its process ended (and so was stopped by it). */
export function stoppedWithProcess(record: TaskRecord): boolean { return record.status === 'running' || !!record.endedWithProcess }

/** A command on one line, short, and unable to open or close a section of the context block. */
function quotedCommand(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  const short = line.length > 120 ? `${headUnits(line, 119)}…` : line
  return short.replace(/<(\/?)(context|project-memory)>/gi, '<\\$1$2>')
}

/**
 * The lines about background shells an earlier G-Code process of the session ran, which ended with
 * it, for the next turn's context block; each is told once (it is then marked reported).
 */
export function takeEndedTaskNotice(session: ShellSession): string[] {
  const file = recordFile(session)
  const records = readRecords(file)
  const fresh = records.filter(record => record.process !== PROCESS_ID && !record.reported)
  if (!file || !fresh.length) return []
  try { writeRecords(file, records.map(record => fresh.includes(record) ? { ...record, reported: true } : record)) } catch { /* Told again next turn. */ }
  const line = (record: TaskRecord) => `- ${record.id} (${quotedCommand(record.command)}): ${stoppedWithProcess(record) ? 'it was still running, so it was stopped then' : `it had already ended${record.state === 'ended' ? '' : ` (${record.state})`}`}`
  const shown = fresh.slice(-NOTICE_TASKS)
  return [
    'Background tasks of this session ended with the G-Code process that ran them (the session was closed, stopped or restarted since). None of them is running now; start one again if you still need it:',
    ...shown.map(line),
    ...(fresh.length > shown.length ? [`- … and ${fresh.length - shown.length} more; TaskOutput tells what became of each`] : []),
  ]
}

/**
 * One note on the background shells of session `taskSessionId` (taskSession(context).id) that
 * ended in this G-Code process since the last call and whose end the model has not seen (see
 * BackgroundShells.markSeen); undefined when there are none. Each shell is told once, here or by a
 * tool result that showed its end, and never again by takeEndedTaskNotice in a later process.
 */
export function takeEndedNotices(taskSessionId: string): string | undefined { return backgroundShells.takeEndedNotices(taskSessionId) }

/** How a shell ended, for a notice: "exited with code 0", "was stopped". */
function endedPhrase(info: Omit<BackgroundShellInfo, 'tail'>, entry: Entry): string {
  if (entry.startError !== undefined) return `failed to start (${entry.startError})`
  if (info.status === 'stopped') return 'was stopped'
  if (info.exitCode !== null) return `exited with code ${info.exitCode}`
  return entry.statusLost ? 'ended, exit status unknown' : 'ended'
}

/**
 * `context` (a turn's context block, or '' for none) with the lines takeEndedTaskNotice gives for
 * `session` added at its end.
 */
export function withEndedTasks(context: string, session: ShellSession): string {
  const end = context.lastIndexOf(`\n${CONTEXT_CLOSE}`)
  if (context && end < 0) return context
  const lines = takeEndedTaskNotice(session)
  if (!lines.length) return context
  if (!context) return [CONTEXT_OPEN, CONTEXT_HEADER, ...lines, CONTEXT_CLOSE].join('\n')
  return `${context.slice(0, end)}\n${lines.join('\n')}${context.slice(end)}`
}

/** What happened to a shell beyond its status and exit code, for the texts the agent reads. */
export interface ShellDetails {
  stopping: boolean
  startError?: string
  statusLost?: boolean
  adopted?: boolean
  /** Processes it started that left its group and are still running: its stop did not reach them. */
  leftGroup?: number[]
}

/**
 * The end of a shell's output as the model reads it, with what a cut left out said by `omitted`.
 * Masked before it is cut: a key across the cut would no longer read as a key. `trimmed`: the output
 * kept in memory no longer has its start (BackgroundShells.trimmed). `running`: more may follow, so
 * an end that may be a key still being printed waits for the rest.
 */
export function shownTail(output: string, units: number, trimmed: boolean, running = false): { text: string; omitted: boolean } {
  const omitted = tailOutput(output, units).length < output.length || trimmed
  if (omitted) return { text: maskedTail(output, units, trimmed, running), omitted }
  return { text: running ? withoutUnfinishedKey(maskSecrets(output)) : maskSecrets(output), omitted }
}

/** Output kept while a shell runs, in UTF-16 units. */
const KEEP_RUNNING = 256 * 1024
/** Output kept once a shell has finished, in UTF-8 bytes. */
const KEEP_FINISHED_BYTES = 32 * 1024
const TAIL = 4 * 1024
const MAX_RUNNING = 8
/** Finished shells kept for TaskOutput and the Tasks panel; older ones are forgotten. */
const MAX_FINISHED = 20
/** A graceful stop sends SIGTERM and waits this long before SIGKILL. */
const SHUTDOWN_GRACE_MS = 1500
/** How often a running shell's group is checked: for what the command left in it, and for a command that ended without a word. */
const LIVENESS_POLL_MS = 500
/** Ids of finished shells that were forgotten (see MAX_FINISHED), so TaskOutput can say why they are gone. */
const MAX_FORGOTTEN = 500

/**
 * The command runs as `bash -c command`, detached: it leads its own process group, so `$$` is
 * the group id, and `trap 'kill -- -$$' EXIT` or `pkill -g $$` reach everything it started.
 * Nothing else is in that group, so a program that reaps children until ECHILD
 * (`1 while wait != -1`) finishes, and a SIGTERM to the group reaches only the command's own
 * processes.
 *
 * Each shell also gets a watchdog (watchGroup in src/utils/subprocess.ts): a separate tiny
 * bash in a group of its own that ends the command's group when the CLI is gone (SIGKILLed or
 * crashed, so no exit hook ran), so dev servers are not left behind.
 */

/** Whether any process of the group is left: a cheap kill(-pgid, 0), no process listing. */
function groupAlive(pgid: number | undefined): boolean {
  if (!pgid) return false
  try { process.kill(-pgid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** bash reports a command that died of a signal as 128 + its number; so does the shell list. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code
  const number = signal ? constants.signals[signal] : undefined
  return number ? 128 + number : null
}

/** After a line that says the command is up, the start look waits this long for the lines right after it. */
const READY_SETTLE_MS = 150
/** Terminal colour and title sequences; a coloured URL is still a URL. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/**
 * A line that announces a server or watcher is up. A bare host:port is not enough: an error line
 * ("EADDRINUSE 127.0.0.1:3000") carries one too, and treating it as ready ends the start wait
 * early and reports a server that in fact failed. The line must say it is up — Local:, listening
 * on/at, ready, started server, running at, serving, server running/started, available on.
 */
const READY_LINE = /\bLocal:|\blistening\b|\bready\b|\bstarted\s+server\b|\bserver\s+(?:running|started|listening|is\s+running)\b|\brunning\s+at\b|\bserving\b|\bavailable\s+on\b/i
const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>`]+/gi
const LOCAL_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i

function startedLine(text: string): boolean { return READY_LINE.test(text.replace(ANSI, '')) }

/**
 * The address a command printed: its first http(s) URL on this machine (localhost, 127.0.0.1,
 * 0.0.0.0, [::1]); undefined when it printed none. A non-local URL (a docs link in an error
 * message, a public address) is never shown as the server's address.
 */
export function serverAddress(output: string): string | undefined {
  const urls = [...output.replace(ANSI, '').matchAll(URL_PATTERN)].map(match => match[0].replace(/[.,;:)\]]+$/, ''))
  return urls.find(url => LOCAL_URL.test(url))
}

/**
 * A shell's state as the agent reads it: "running (process group 123)", "stopped, exit code 143",
 * "failed to start (…)". The number is the process group (POSIX): the command's bash, which for
 * `cd x && server` is not the server's own pid, so only a signal to the whole group reaches it.
 */
export function shellState(shell: BackgroundShellInfo, details?: ShellDetails): string {
  const group = shell.pid && process.platform !== 'win32' ? ` (process group ${shell.pid})` : ''
  if (shell.status === 'running') return `${details?.stopping ? 'stopping' : 'running'}${group}`
  if (details?.startError !== undefined) return `failed to start (${details.startError})`
  if (shell.exitCode !== null) return `${shell.status}, exit code ${shell.exitCode}`
  if (details?.statusLost) return 'ended, exit status unknown'
  if (details?.adopted && shell.status === 'completed') return 'ended'
  return shell.status
}

export class BackgroundShells {
  /** `spawnCommand` starts the command itself; tests pass a stand-in. */
  constructor(private readonly spawnCommand: typeof spawn = spawn) {}
  private shells = new Map<string, Entry>()
  private forgotten = new Set<string>()
  private listeners = new Set<() => void>()
  private exitHook = false

  /**
   * Starts a command in its own process group; throws when too many are running. Shells being
   * stopped do not count: they are on their way out (SIGKILL follows within two seconds).
   * `session`: the session it is started for, which keeps a record of it (see TaskRecord).
   */
  start(command: string, cwd: string, env: NodeJS.ProcessEnv, description?: string, session?: ShellSession): BackgroundShellInfo {
    if (this.running().filter(entry => !entry.stopping).length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} background tasks are already running. Stop one with TaskStop first.`)
    }
    // stdout is a pipe, so Python would hold back what it prints (a server's "Serving HTTP on …"
    // line) in its buffer; the user's own setting wins.
    env = { PYTHONUNBUFFERED: '1', ...env }
    const windows = process.platform === 'win32'
    const child = windows
      ? this.spawnCommand('cmd.exe', ['/c', command], { cwd, env: toolEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : this.spawnCommand('bash', ['-c', command], { cwd, env: toolEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const id = `bg-${randomUUID().slice(0, 8)}`
    const entry: Entry = { info: { id, kind: 'shell', command, description, cwd, pid: child.pid, status: 'running', exitCode: null, startedAt: Date.now(), outputBytes: 0 }, output: '', trimmed: false, child, pgid: windows ? undefined : child.pid, stopping: false, recordFile: recordFile(session), session: session?.id }
    if (!windows && child.pid) entry.watchdog = watchGroup(child.pid)
    // One decoder per stream: a character split across two reads must not turn into U+FFFD.
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')] as const
    const append = (decoder: StringDecoder) => (chunk: Buffer) => this.append(entry, decoder.write(chunk), chunk.length)
    child.stdout?.on('data', append(decoders[0]))
    child.stderr?.on('data', append(decoders[1]))
    child.on('error', error => {
      // A missing working folder makes posix_spawn report ENOENT for bash itself.
      entry.startError = existsSync(cwd) ? error.message : `its working folder ${cwd} does not exist`
      entry.output += `\n[failed to start: ${entry.startError}]\n`
      this.settle(entry, null)
    })
    // The command's exit status, once its bash has exited (undefined before).
    let exited: number | null | undefined
    let closed = false
    let goneOnce = false
    // The entry stays running while anything the command left in its group (`server &`) lives,
    // so TaskStop and shutdown still reach it. Once the group is gone, the output is complete
    // when the pipes close; a process outside the group that still holds them (it left the
    // group) does not keep the entry running past the next check. Bun under heavy load can lose
    // every event of an exited child (see src/utils/subprocess.ts), so the same checks run from
    // the start: a group that is gone settles the entry even when no 'exit' or 'close' came.
    const finish = () => {
      if (entry.info.status !== 'running') return
      if (windows ? (child.pid !== undefined && processExists(child.pid)) : groupAlive(child.pid)) { goneOnce = false; return }
      if (exited === undefined && !closed) {
        // Gone without a word: give the events one more check to arrive.
        if (!goneOnce) { goneOnce = true; return }
        entry.output += '\n[the command ended, but its exit status was not reported]\n'
        entry.statusLost = true
        return this.settle(entry, null)
      }
      if (closed || goneOnce) this.settle(entry, exited ?? null)
      else goneOnce = true
    }
    child.on('exit', (code, signal) => {
      exited = exitStatus(code, signal)
      if (!windows) finish()
    })
    child.on('close', (code, signal) => {
      // Bytes of an unfinished character at the very end.
      for (const decoder of decoders) entry.output += decoder.end()
      closed = true
      if (exited === undefined) exited = exitStatus(code, signal)
      if (windows) this.settle(entry, exited)
      else finish()
    })
    if (child.pid !== undefined) { entry.poll = setInterval(finish, LIVENESS_POLL_MS); entry.poll.unref() }
    // A running shell must not keep the process alive (a headless run would wait forever for a
    // dev server); the exit hook below kills it when the process ends.
    child.unref()
    for (const stream of [child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.()
    return this.track(entry)
  }

  /**
   * Takes over process group `pgid`: what a foreground Bash command (`command`, already exited)
   * left running in it, such as a `server > log 2>&1 &`. From here it is a background
   * task like any other: in the Tasks panel, read with TaskOutput, stopped with TaskStop, and
   * stopped when the session ends (a watchdog covers a CLI that dies). `pipes`: the command's
   * output pipes, when what it left running still holds them (a `server &` with no redirect); the
   * task reads them from here on. Otherwise its output went where the command sent it, and none is
   * captured. Undefined when the group is already gone. POSIX only; not limited by MAX_RUNNING,
   * since the processes already run.
   */
  adopt(pgid: number, command: string, cwd: string, description?: string, session?: ShellSession, pipes?: LeftPipes): BackgroundShellInfo | undefined {
    if (process.platform === 'win32' || !groupAlive(pgid)) return undefined
    const id = `bg-${randomUUID().slice(0, 8)}`
    const entry: Entry = {
      info: { id, kind: 'shell', command, description, cwd, pid: pgid, status: 'running', exitCode: null, startedAt: Date.now(), outputBytes: 0 },
      output: pipes ? '' : '[Left running by a Bash command. Its output goes where that command sent it, so none is shown here.]\n',
      trimmed: false, pgid, stopping: false, adopted: true, recordFile: recordFile(session), session: session?.id,
    }
    entry.watchdog = watchGroup(pgid)
    let pipesOpen = !!pipes
    let goneOnce = false
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const end = () => {
      if (pipes) { pipes.release(); pipes = undefined }
      for (const decoder of Object.values(decoders)) entry.output += decoder.end()
      this.settle(entry, null)
    }
    // Once the group is gone: when the pipes have closed too, or a check later (what still holds them left the group).
    const check = () => {
      if (entry.info.status !== 'running') return
      if (groupAlive(pgid)) { goneOnce = false; return }
      if (!pipesOpen || goneOnce) end()
      else goneOnce = true
    }
    pipes?.attach({
      data: (stream, chunk) => {
        if (entry.info.status !== 'running') return
        this.append(entry, decoders[stream].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), chunk.byteLength)
      },
      end: () => { pipesOpen = false; check() },
    })
    entry.poll = setInterval(check, LIVENESS_POLL_MS)
    entry.poll.unref()
    return this.track(entry)
  }

  private track(entry: Entry): BackgroundShellInfo {
    this.shells.set(entry.info.id, entry)
    if (!this.exitHook) {
      this.exitHook = true
      process.once('exit', () => this.shutdown())
    }
    // A record from the start: a process that dies without a word leaves it running (see TaskRecord).
    this.record([entry])
    this.changed()
    return this.info(entry)
  }

  /**
   * Writes the records of the sessions `entries` belong to: every shell of each such session that
   * this process still knows, merged into what the session's file already holds. Best effort: a
   * session folder that cannot be written costs only the explanation a later process could give.
   */
  private record(entries: Iterable<Entry>): void {
    const files = new Set<string>()
    for (const entry of entries) if (entry.recordFile) files.add(entry.recordFile)
    for (const file of files) {
      try {
        const records = new Map(readRecords(file).map(record => [record.id, record]))
        for (const entry of this.shells.values()) {
          if (entry.recordFile !== file) continue
          const info = { ...entry.info, tail: '' }
          records.set(info.id, {
            id: info.id, command: info.command, ...(info.description ? { description: info.description } : {}), startedAt: info.startedAt,
            status: info.status, state: shellState(info, this.details(info.id)), ...(entry.endedWithProcess ? { endedWithProcess: true } : {}),
            tail: tailOutputBytes(maskedTail(entry.output, RECORD_TAIL_BYTES, entry.trimmed, info.status === 'running'), RECORD_TAIL_BYTES), process: PROCESS_ID,
            // Seen here: a later process must not tell it again (stopped with the process is news, though).
            ...(entry.seen && !entry.endedWithProcess ? { reported: true } : {}),
          })
        }
        writeRecords(file, [...records.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RECORDS))
      } catch { /* See above. */ }
    }
  }

  /** Every running shell and the 20 most recently finished ones, in start order. */
  list(): BackgroundShellInfo[] { return [...this.shells.values()].map(entry => this.info(entry)) }

  get(id: string): BackgroundShellInfo | undefined {
    const entry = this.shells.get(id)
    return entry && this.info(entry)
  }

  /** Combined output kept in memory: the last 256 KB while running, the last 32 KB once finished. */
  output(id: string): string | undefined { return this.shells.get(id)?.output }

  /** True when earlier output was dropped to stay within those limits. */
  trimmed(id: string): boolean { return this.shells.get(id)?.trimmed ?? false }

  /** Whether it is being stopped, and why it ended without an exit code, if it did. */
  details(id: string): ShellDetails | undefined {
    const entry = this.shells.get(id)
    if (!entry) return undefined
    const leftGroup = entry.leftGroup?.filter(pid => processExists(pid))
    return { stopping: entry.stopping, ...(entry.startError !== undefined ? { startError: entry.startError } : {}), ...(entry.statusLost ? { statusLost: true } : {}), ...(entry.adopted ? { adopted: true } : {}), ...(leftGroup?.length ? { leftGroup } : {}) }
  }

  /**
   * The model has seen that shell `id` ended (TaskOutput after its end, a start that already
   * ended) or is ending (its own TaskStop): takeEndedNotices does not tell it.
   */
  markSeen(id: string): void {
    const entry = this.shells.get(id)
    if (!entry || entry.seen) return
    entry.seen = true
    // A running one is recorded so when it settles.
    if (entry.info.status !== 'running') this.record([entry])
  }

  /** See the exported takeEndedNotices. */
  takeEndedNotices(taskSessionId: string): string | undefined {
    if (!taskSessionId) return undefined
    const ended = [...this.shells.values()].filter(entry => entry.session === taskSessionId && entry.info.status !== 'running' && !entry.seen)
    if (!ended.length) return undefined
    for (const entry of ended) entry.seen = true
    this.record(ended)
    const about = (entry: Entry) => `${entry.info.id} (${quotedCommand(entry.info.command)}) ${endedPhrase(entry.info, entry)}`
    if (ended.length === 1) return `[Background task ${about(ended[0]!)} while you worked; TaskOutput ${ended[0]!.info.id} shows its output.]`
    const shown = ended.slice(-NOTICE_TASKS)
    const more = ended.length > shown.length ? `; and ${ended.length - shown.length} more` : ''
    return `[Background tasks ended while you worked: ${shown.map(about).join('; ')}${more}. TaskOutput shows their output.]`
  }

  /** A shell that finished long ago and was forgotten to stay within MAX_FINISHED. */
  forgot(id: string): boolean { return this.forgotten.has(id) }

  /**
   * SIGTERM to the whole process group, SIGKILL after two seconds. The entry stays running until
   * the command and whatever it left in the group have ended. False when it is not running. A
   * shell already being stopped is not signalled again (true).
   */
  stop(id: string): boolean {
    const entry = this.shells.get(id)
    if (!entry || entry.info.status !== 'running') return false
    if (entry.stopping) return true
    entry.stopping = true
    // Looked up first: once the group has gone, nothing leads to them.
    if (entry.pgid) entry.leftGroup = leftTheGroup(entry.pgid)
    this.signal(entry, 'SIGTERM')
    setTimeout(() => { if (entry.info.status === 'running') this.signal(entry, 'SIGKILL') }, 2000).unref()
    return true
  }

  /** Resolves once the shell is no longer running (true), or after `maxMs` or an abort (false). */
  waitForEnd(id: string, maxMs: number, signal?: AbortSignal): Promise<boolean> {
    const ended = () => this.shells.get(id)?.info.status !== 'running'
    if (ended()) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', done)
        resolve(ended())
      }
      const timer = setTimeout(done, maxMs)
      const unsubscribe = this.onChange(() => { if (ended()) done() })
      if (signal?.aborted) return done()
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * Graceful shutdown (session end, SIGTERM): SIGTERM to every running group, then SIGKILL to
   * the ones still running after `graceMs`. Resolves once all have ended or been killed.
   */
  stopAll(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    const entries = this.running()
    for (const entry of entries) {
      entry.endedWithProcess = true
      if (!entry.stopping) { entry.stopping = true; this.signal(entry, 'SIGTERM') }
    }
    // Recorded now, while the process may still be cut short; each end is recorded as it comes.
    this.record(this.shells.values())
    const ended = () => entries.every(entry => entry.info.status !== 'running')
    if (ended()) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); unsubscribe(); resolve() }
      const timer = setTimeout(() => {
        for (const entry of entries) if (entry.info.status === 'running') this.signal(entry, 'SIGKILL')
        finish()
      }, graceMs)
      const unsubscribe = this.onChange(() => { if (ended()) finish() })
    })
  }

  /** Kills everything still running at once; for the process 'exit' hook, which cannot wait. */
  shutdown(): void {
    const entries = this.running()
    for (const entry of entries) this.signal(entry, 'SIGKILL')
    const unrecorded = entries.filter(entry => !entry.endedWithProcess)
    for (const entry of unrecorded) entry.endedWithProcess = true
    this.record(unrecorded)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The start look of a Bash `run_in_background` call. Resolves once the shell has ended, or
   * `settleMs` after it printed a line that says it is up (a URL or host:port, "listening",
   * "ready"; see READY_LINE) so the lines right after it are in too, or after `maxMs`, or on
   * abort, whichever comes first. Other output does not end the wait: a start that prints a banner
   * and fails a moment later (a dev server whose port is taken) is seen exiting, not running.
   */
  waitForStart(id: string, options: { maxMs: number; settleMs?: number; signal?: AbortSignal }): Promise<void> {
    const settleMs = options.settleMs ?? READY_SETTLE_MS
    return new Promise(resolve => {
      let settle: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = () => {}
      // Output bytes already looked at; only what arrived since is scanned again.
      let scanned = 0
      const done = () => {
        clearTimeout(cap)
        if (settle) clearTimeout(settle)
        unsubscribe()
        options.signal?.removeEventListener('abort', done)
        // What the start shows is in the record at once, should this process die right after.
        const entry = this.shells.get(id)
        if (entry?.info.status === 'running' && entry.info.outputBytes > 0) this.record([entry])
        resolve()
      }
      const check = () => {
        const entry = this.shells.get(id)
        if (!entry || entry.info.status !== 'running') return done()
        if (settle || entry.info.outputBytes === scanned) return
        // New text is at most as many UTF-16 units as it has bytes; a little before it catches a line split across reads.
        const fresh = entry.info.outputBytes - scanned
        scanned = entry.info.outputBytes
        if (startedLine(entry.output.slice(Math.max(0, entry.output.length - fresh - 512)))) settle = setTimeout(done, settleMs)
      }
      const cap = setTimeout(done, options.maxMs)
      if (options.signal?.aborted) return done()
      options.signal?.addEventListener('abort', done, { once: true })
      unsubscribe = this.onChange(check)
      check()
    })
  }

  /** Output that arrived from a running shell: `bytes` of it, decoded as `text`. */
  private append(entry: Entry, text: string, bytes: number): void {
    entry.info.outputBytes += bytes
    entry.output += text
    if (entry.output.length > KEEP_RUNNING) { entry.output = tailOutput(entry.output, KEEP_RUNNING); entry.trimmed = true }
    if (entry.recordFile && !entry.recordTimer) {
      entry.recordTimer = setTimeout(() => { entry.recordTimer = undefined; if (entry.info.status === 'running') this.record([entry]) }, RECORD_REFRESH_MS)
      entry.recordTimer.unref?.()
    }
    this.changed()
  }

  private running(): Entry[] { return [...this.shells.values()].filter(entry => entry.info.status === 'running') }

  private info(entry: Entry): BackgroundShellInfo { return { ...entry.info, tail: maskedTail(entry.output, TAIL, entry.trimmed, entry.info.status === 'running') } }

  private signal(entry: Entry, signal: NodeJS.Signals) {
    try {
      if (entry.pgid) process.kill(-entry.pgid, signal)
      else entry.child?.kill(signal)
    } catch { /* Already gone. */ }
  }

  private settle(entry: Entry, code: number | null) {
    if (entry.info.status !== 'running') return
    if (entry.poll) clearInterval(entry.poll)
    if (entry.recordTimer) { clearTimeout(entry.recordTimer); entry.recordTimer = undefined }
    // The group is gone: its watchdog has nothing left to guard (it would exit within a second).
    endWatchdog(entry.watchdog)
    entry.info.exitCode = code
    entry.info.endedAt = Date.now()
    // An adopted group's processes were not started here: how they ended is not known.
    entry.info.status = entry.stopping ? 'stopped' : entry.adopted || code === 0 ? 'completed' : 'failed'
    const kept = tailOutputBytes(entry.output, KEEP_FINISHED_BYTES)
    if (kept.length < entry.output.length) { entry.output = kept; entry.trimmed = true }
    const finished = [...this.shells.values()].filter(other => other.info.status !== 'running').sort((a, b) => a.info.endedAt! - b.info.endedAt!)
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.shells.delete(old.info.id)
      this.forgotten.add(old.info.id)
      if (this.forgotten.size > MAX_FORGOTTEN) this.forgotten.delete(this.forgotten.values().next().value!)
    }
    this.record([entry])
    this.changed()
  }

  private changed() { for (const listener of this.listeners) listener() }
}

export const backgroundShells = new BackgroundShells()
