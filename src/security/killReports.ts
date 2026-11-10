/**
 * @file killReports.ts
 * @brief The other witnesses of a denied network attempt, for the times `log stream` loses its record.
 *
 * A tool profile SIGKILLs a process that tries to connect, and the denial's log record is what trips
 * the incident. Some records never reach any `log stream`: about 1 in 300 on 2026-11-05, 4 in 600 on
 * 2026-11-06. The connection was blocked, but nothing says so. In all 4 of those, two others had it:
 *
 * - A crash report, written by another path within about 200 ms, with `termination.namespace` "SANDBOX".
 *   An out-of-memory kill, a user's `kill -9` and a tool's own kill leave none, so it tells these apart
 *   where the exit status alone (SIGKILL) cannot. It names the process and its parent, so it also covers
 *   descendants whose exit status G-Code never sees. It has no destination: an incident from it says
 *   "unknown". macOS writes reports for the first 25 kills of a process name, then none: still 0 of 5
 *   at 3, 6, 9 and 40 minutes and at 2 h 40 min on 2026-11-06 (when it returns was not measured). So
 *   a name that has used up its 25 (a test run, a retry loop) leaves this witness out. Within them: at
 *   about 2 kills a second each left one; at 5 a second macOS dropped 6 in 100, two in a row about every
 *   30 kills. A real attempt is held at once, so it makes no such burst.
 * - The log store, which `log show` reads: it had all 4 lost records, with their ports, but it can lag.
 *   A query a second after a kill found the record in 14 of 60 on a quiet machine, with half still
 *   missing after 10 s and some after 40 s, and in 25 of 30 on a busier one; waiting a second more did
 *   not help. So it is best effort. One query takes about a second of CPU, so it answers a question and
 *   never polls: when a kill has no explanation, when a turn ends, every two minutes in a long turn, and
 *   a minute after each of those for what still lags (see NetworkGuard.askStoreIfDue).
 *
 * If all three miss, the attempt was blocked but nothing holds the work and the tool result only says
 * "Killed: 9". Seen once in 240 real attempts on 2026-11-06, before the store was asked at a turn's end.
 *
 * The report format is Apple's and unpublished, seen on Darwin 24.6 only. A report for a real kill that
 * cannot be read here is noticed and the user told (NetworkGuard.checkReportFormat).
 *
 * Reports are read as hostile files: a sandboxed tool may write in this folder. A forged report can
 * only cause a hold, which the tool could cause anyway by connecting.
 */

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface KillReport { file: string; pid: number; parentPid?: number; process?: string; captureTime?: string; termination: unknown }

/** Real reports are 12 to 200 KB. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024
/** A report that does not parse yet is read again until it is this old. macOS renames complete ones into place, so this is a margin. */
const PARTIAL_RETRY_MS = 5000
/** `log show --last`, in minutes: it finds what `--start` finds (measured 2026-11-06), and costs more the further back it reads. */
const STORE_SPAN_MINUTES = 2
const STORE_MAX_SPAN_MINUTES = 30
/** A query normally takes about a second. A timer of its own: Bun can lose every event of a child (see src/utils/subprocess.ts). */
const STORE_TIMEOUT_MS = 5000
const STORE_MAX_CHARS = 1_000_000

/**
 * Where macOS writes this account's reports, whatever HOME says (Bun's os.userInfo() follows HOME). A
 * report lands in the folder and moves to Retired about a second later.
 */
export function killReportDirs(): string[] {
  let home: string | undefined
  try { home = execFileSync('/usr/bin/id', ['-P'], { encoding: 'utf8', timeout: 1000, env: { PATH: '/usr/bin:/bin' } }).trim().split(':').at(-2) } catch { /* homedir() below. */ }
  const root = join(home || homedir(), 'Library/Logs/DiagnosticReports')
  return [root, join(root, 'Retired')]
}

type Parsed = Omit<KillReport, 'file'> | { other: true; pid?: number; unreadable: boolean } | 'gone' | 'partial'
/** A new report that says nothing of a sandbox kill, in a form that may be why. */
export interface UnreadableReport { name: string; pid?: number }
const UNREADABLE_KEPT = 32
const NOT_A_REPORT = { other: true, unreadable: false } as const

function parseReport(path: string): Parsed {
  let fd: number
  // No symbolic link, and a planted FIFO must not block the engine.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : NOT_A_REPORT }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return NOT_A_REPORT
    const bytes = Buffer.alloc(stat.size)
    let read = 0, n: number
    while (read < bytes.length && (n = readSync(fd, bytes, read, bytes.length - read, read)) > 0) read += n
    const text = bytes.subarray(0, read).toString('utf8')
    let body: { pid?: unknown; parentPid?: unknown; procName?: unknown; captureTime?: unknown; termination?: { namespace?: unknown }; exception?: { signal?: unknown } }
    // One line of header, then the report.
    try { body = JSON.parse(text.slice(text.indexOf('\n') + 1)) }
    catch { return Date.now() - stat.mtimeMs < PARTIAL_RETRY_MS ? 'partial' : { other: true, unreadable: true } }
    if (body?.termination?.namespace !== 'SANDBOX' || body.exception?.signal !== 'SIGKILL' || !Number.isInteger(body.pid)) return { other: true, unreadable: true, ...(Number.isInteger(body?.pid) ? { pid: body.pid as number } : {}) }
    return {
      pid: body.pid as number, termination: body.termination,
      ...(Number.isInteger(body.parentPid) ? { parentPid: body.parentPid as number } : {}),
      ...(typeof body.procName === 'string' ? { process: body.procName } : {}),
      ...(typeof body.captureTime === 'string' ? { captureTime: body.captureTime } : {}),
    }
  } catch { return NOT_A_REPORT } finally { closeSync(fd) }
}

/** The kill reports that appear in `dirs` after it is made. */
export class KillReports {
  private readonly known = new Set<string>()
  /** The folder's modified time at its last complete read: unchanged means nothing to do, however large it is. */
  private readonly listed = new Map<string, number>()
  private unreadable: UnreadableReport[] = []

  constructor(private readonly dirs: string[]) {
    for (const dir of dirs) {
      try { const modified = statSync(dir).mtimeMs; for (const name of readdirSync(dir)) this.known.add(name); this.listed.set(dir, modified) } catch { /* Not there yet. */ }
    }
  }

  /** What arrived since the last call. Cheap when nothing did: one stat per folder. */
  read(): KillReport[] {
    const found: KillReport[] = []
    for (const dir of this.dirs) {
      let modified: number, names: string[]
      try { modified = statSync(dir).mtimeMs; if (this.listed.get(dir) === modified) continue; names = readdirSync(dir) } catch { continue }
      let complete = true
      for (const name of names) {
        // A dot name is one macOS is still writing.
        if (name.startsWith('.') || this.known.has(name)) continue
        // The folder's files have this extension today.
        if (!name.endsWith('.ips')) { this.known.add(name); this.noteUnreadable({ name }); continue }
        const file = join(dir, name), parsed = parseReport(file)
        // Moved to Retired after the listing: found there, whose time has changed too.
        if (parsed === 'gone') continue
        if (parsed === 'partial') { complete = false; continue }
        this.known.add(name)
        if ('other' in parsed) { if (parsed.unreadable) this.noteUnreadable({ name, ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}) }) }
        else found.push({ ...parsed, file })
      }
      if (complete) this.listed.set(dir, modified)
    }
    return found
  }

  private noteUnreadable(entry: UnreadableReport): void { this.unreadable.push(entry); if (this.unreadable.length > UNREADABLE_KEPT) this.unreadable.shift() }
  /** New reports read since the last call that are not sandbox kills, or not in a form this file can read. Most are other crashes: the caller knows which kill it expects. */
  takeUnreadable(): UnreadableReport[] { return this.unreadable.splice(0) }
}

/** `log show` arguments for the records of `tags` (ours: random hex). */
export function storeQuery(tags: string[], lookBackMs?: number): string[] {
  const minutes = lookBackMs === undefined ? STORE_SPAN_MINUTES : Math.min(STORE_MAX_SPAN_MINUTES, Math.max(STORE_SPAN_MINUTES, Math.ceil(lookBackMs / 60_000) + 1))
  return ['show', '--style', 'ndjson', '--last', `${minutes}m`, '--predicate', tags.map(tag => `eventMessage CONTAINS "${tag}"`).join(' OR ')]
}

/** The denial messages of `tags` in its output. The query's own run is logged with the tags in its arguments, so a tag alone is not enough. */
export function parseStoredDenials(text: string, tags: string[]): string[] {
  const messages: string[] = []
  for (const line of text.split('\n')) {
    try { const message = String(JSON.parse(line).eventMessage ?? ''); if (/deny\(\d+\)/.test(message) && tags.some(tag => message.includes(tag))) messages.push(message) } catch { /* Not a record. */ }
  }
  return messages
}

/** The denial messages the log store holds for `tags`. Empty when it holds none (yet) or cannot be asked. Never rejects. */
export function storedDenials(tags: string[], lookBackMs?: number): Promise<string[]> {
  return new Promise(resolve => {
    let text = '', done = false
    let child: ReturnType<typeof spawn> | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child?.kill('SIGKILL') } catch { /* Gone. */ }
      resolve(parseStoredDenials(text, tags))
    }
    const timer = setTimeout(finish, STORE_TIMEOUT_MS)
    try {
      child = spawn('/usr/bin/log', storeQuery(tags, lookBackMs), { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } })
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', data => { text += data; if (text.length > STORE_MAX_CHARS) finish() })
      child.once('close', finish); child.once('error', finish)
    } catch { finish() }
  })
}
