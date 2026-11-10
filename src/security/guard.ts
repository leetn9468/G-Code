import { directFetch } from '../llm/directFetch.js'
import { sandboxMembers, verifySandboxMembership, type SandboxMember } from './membership.js'
import { assertRuntimeLinks } from './resources.js'
import { withUserPermissionRules } from '../session/permissionFiles.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BROWSER_PROBE_MESSAGE, incidentRoot, ensureIncidentRoot, assertIncidentLinks, toolProfile } from './protection.js'
import { callProxy, type CallProxy, type Observation } from './proxy.js'
import { KillReports, killReportDirs, storedDenials, type KillReport } from './killReports.js'
import { destinationAllowed, destinationAuthority, userProxyPort, guardEligible, loopbackHost, type NetworkIncident, type NetworkGuardSettings, type NetworkHold, CLOUD_GUARD_REASON } from '../shared/networkGuard.js'
import type { AppState } from '../types.js'
import { saveSession, type Store } from '../state/store.js'
import { endWatchdog, watchGroup } from '../utils/watchdog.js'

export class NetworkStopped extends Error { constructor(readonly incident?: NetworkIncident) { super(incident ? `Stopped by Guillotine Mode. Evidence: ${incident.path}` : 'Guillotine Mode is held.') } }
export class NetworkGuardFailure extends Error {}
// Shared across processes: every guarded profile denies the entire range except its own pair.
// Port reuse happens only after a listener closes; background process groups retain their pair.
export const GUARD_PROXY_PORTS = Array.from({ length: 128 }, (_, i) => 17800 + i)
/**
 * The monitor probes of one fence. The first is a plain denial, so an ordinary step leaves no macOS
 * crash report. Its report arrives in about 20 ms, also at load 50, or not at all: macOS lost about 1
 * in 100 (measured 2026-11-05). The later probes are SIGKILLed, which forces the report (and leaves
 * one curl crash report, no dialog). Work stays blocked meanwhile.
 */
const FENCE_PROBES = [{ kill: false, waitMs: 3_000 }, { kill: true, waitMs: 15_000 }, { kill: true, waitMs: 30_000 }] as const
/**
 * How long a fence waits for the crash report of a SIGKILL nobody has explained (see killReports.ts),
 * before it asks the log store. Only such a fence waits. Reports took 150 to 280 ms on 2026-11-06.
 */
const KILL_REPORT_WAIT_MS = 1_000
const KILL_REPORT_POLL_MS = 50
const KILL_REPORT_LAYER = 'seatbelt-kill-report'
/** A long turn asks the log store at least this often, so a query never has to read far back. */
const STORE_ASK_MS = 120_000
/** The store can lag by over 40 s (killReports.ts), so what it did not have yet gets one more look. */
const STORE_RELOOK_MS = 60_000
/** The attribution kept per guard. Only calls whose processes have all ended are ever dropped: see call(). */
const CALL_LIMIT = 4096
/** Proxy credentials to scrub from evidence. Those of dropped calls were closed long ago. */
const SECRET_LIMIT = 16_384
/** How long a report of a real kill can take to appear before the format check gives up (see watchReportFormat). */
const FORMAT_CHECK_MS = 6_000
export interface GuardProcess { pid: number; argv: string[]; cwd: string; stopped?: boolean; identity?: string; kernelIdentity?: string; trusted?: boolean; group?: boolean; ancestry?: Array<{ pid: number; ppid: number; pgid: number; identity: string }>; ancestryStatus?: string }
interface GuardTurn { id: string; userInput: string; journal: Array<{ kind: string; data: unknown }>; bytes: number; trimmed: boolean }
export interface GuardCall { turn?: GuardTurn; id: string; name: string; input: unknown; grants: string[]; proxy?: CallProxy; tag: string; processes: GuardProcess[]; completed?: boolean; retired?: boolean; /** A hold stopped it: its records are that hold's. */ cut?: boolean }
/** Absolute, engine-owned ps: no model args, environment, or executable can replace this probe. */
export function processIdentity(pid: number): string | undefined {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, env: { PATH: '/usr/bin:/bin' } }).trim() || undefined } catch { return }
}
/** Read only numeric ownership and creation time, never other processes' argv/environment. */
export function processAncestry(pid: number): Array<{ pid: number; ppid: number; pgid: number; identity: string }> {
  try {
    const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 1000, env: { PATH: '/usr/bin:/bin' } })
    const records = new Map<number, { pid: number; ppid: number; pgid: number; identity: string }>()
    for (const line of text.split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line); if (m) records.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), identity: m[4]!.trim() }) }
    const chain: Array<{ pid: number; ppid: number; pgid: number; identity: string }> = []
    while (records.has(pid) && chain.length < 16 && !chain.some(p => p.pid === pid)) { const p = records.get(pid)!; chain.push(p); pid = p.ppid }
    return chain
  } catch { return [] }
}
const scope = new AsyncLocalStorage<{ guard?: NetworkGuard; call?: GuardCall }>()
function groupAlive(pid: number): boolean { try { process.kill(-pid, 0); return true } catch { return false } }
let configured: NetworkGuard | undefined
export function currentGuard(): NetworkGuard | undefined { return scope.getStore()?.guard ?? configured }
export function currentCall(): GuardCall | undefined { return scope.getStore()?.call }
export function setNetworkGuard(guard?: NetworkGuard): void { configured = guard }
export function inGuardCall<T>(guard: NetworkGuard | undefined, call: GuardCall | undefined, run: () => T): T { return scope.run({ guard, call }, run) }
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
/** The files that make up a model: a GGUF is one file; an MLX folder is its config, tokenizer and weights, in a stable order. */
export function modelFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).filter(name => /\.(safetensors|json|jinja)$/.test(name)).sort().map(name => join(path, name))
}

export interface GuardOptions { store: Store<AppState>; provider: string; model: string; baseUrl?: string; settings: NetworkGuardSettings; modelFile?: string; modelDigest?: string; onIncident?: (incident: NetworkIncident) => void; stop?: () => Promise<void>; /** Tests only: stand-ins for the system's crash reports and log store. */ killReportDirs?: string[]; storedDenials?: typeof storedDenials }

export class NetworkGuard {
  readonly calls = new Map<string, GuardCall>()
  readonly grants = new Set<string>()
  readonly forbiddenPorts = new Set<number>()
  private monitor?: ChildProcess
  private monitorWatchdog?: ChildProcess
  private monitorReady = false
  private closed = false
  private buffer = ''
  private barriers = new Map<string, () => void>()
  private incidentWork?: Promise<void>
  private latched = false
  private cut?: () => Promise<void>
  private notify?: (incident: NetworkIncident) => void
  private controller = new AbortController()
  private secrets = new Set<string>()
  private fault?: NetworkGuardFailure
  /** The hold's evidence is not on disk. Deny is still possible, so one failed write cannot end a chat. */
  private incomplete = false
  private noticeSink?: (text: string) => void
  private notices: string[] = []
  /** The incident already sent to the desktop when its evidence was saved; the turn's end need not repeat it. */
  notified?: string
  /** The fault is a monitor timeout, not an observed attempt: the next user message may retry. */
  private recoverable = false
  /** A sandboxed tool process started since the last proved fence; until then none needs one. */
  private activity = true
  private killReports?: KillReports
  private get storedDenials(): typeof storedDenials { return this.options.storedDenials ?? storedDenials }
  /** Tool processes that ended by a SIGKILL G-Code did not send, not yet explained (see settleKills). */
  private suspects = new Set<number>()
  private reaper?: ReturnType<typeof setInterval>
  /** Calls with a sandboxed process that the log store has not answered for: asks made, and when. Cleared by a hold. */
  private storeWatch = new Map<string, { asks: number; since: number; at: number }>()
  private storeBusy = false
  private storeEpoch = 0
  private turnEnded = false
  private lastStoreAsk = Date.now()
  /** A real kill whose crash report should appear; a report that does and cannot be read means the format changed. */
  private formatWatch?: { pid: number; process: string; until: number }
  private turn: GuardTurn = { id: 'startup', userInput: '', journal: [], bytes: 0, trimmed: false }
  get signal(): AbortSignal { return this.controller.signal }
  beginTurn(input: string, owner = true): void {
    if (owner) this.turn = { id: randomUUID(), userInput: input, journal: [], bytes: 0, trimmed: false }
    this.remember(owner ? 'user-turn' : 'child-turn', { input })
  }
  remember(kind: string, data: unknown): void {
    const turn = currentCall()?.turn ?? this.turn, size = (JSON.stringify(data) ?? 'null').length
    turn.journal.push({ kind, data: structuredClone(data) }); turn.bytes += size
    while (turn.bytes > 250000 && turn.journal.length > 1) { turn.bytes -= (JSON.stringify(turn.journal.shift()!.data) ?? 'null').length; turn.trimmed = true }
  }
  constructor(readonly options: GuardOptions) {
    if (!guardEligible(options.provider, options.baseUrl)) throw new Error(CLOUD_GUARD_REASON)
    this.cut = options.stop; this.notify = options.onIncident
    for (const h of [...options.settings.allowlist, ...(options.store.getState().networkHold?.grants ?? [])]) this.grants.add(h)
    const state = options.store.getState()
    const rules = withUserPermissionRules(state.permissionContext, state.cwd).alwaysAllowRules
    for (const r of rules) { const m = /^WebFetch\(domain:(.+)\)$/.exec(r.rule ?? ''); if (m) this.grants.add(m[1]!) }
    this.latched = ['held', 'rejected'].includes(options.store.getState().networkHold?.phase ?? '')
    const saved = options.store.getState().networkHold
    if (saved?.phase === 'held' && saved.evidenceSaved === false) {
      // The hold is saved before the evidence. The folder appears whole, so if it is there it is complete.
      if (existsSync(join(saved.incident.path, 'evidence.json'))) options.store.setState(current => ({ networkHold: { ...current.networkHold!, evidenceSaved: true } }))
      else { this.incomplete = true; this.fault = new NetworkGuardFailure(`This session stopped before incident evidence finished saving. It remains held; no verified evidence is claimed. Deny goes on without it; Continue is unavailable.`) }
    }
  }
  get incident(): NetworkIncident | undefined { return this.options.store.getState().networkHold?.incident }
  get held(): boolean { return this.latched }
  bind(stop: () => Promise<void>, notify?: (incident: NetworkIncident) => void): void { this.cut = stop; if (notify) this.notify = notify }
  /** Where something the user should know, outside any turn, goes. What came before the sink is delivered to it. */
  bindNotices(sink: (text: string) => void): void { this.noticeSink = sink; for (const text of this.notices.splice(0)) sink(text) }
  private notice(text: string): void { if (this.noticeSink) this.noticeSink(text); else if (this.notices.length < 16) this.notices.push(text) }
  /** The hold's evidence never reached disk: Deny says so instead of pointing at it. */
  get evidenceIncomplete(): boolean { return this.incomplete }
  /** No tool/model starts without a live monitor and a proved denial round trip. */
  async start(): Promise<void> {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') || !existsSync('/usr/bin/log')) throw new Error('Guillotine Mode requires macOS Seatbelt and the system violation monitor.')
    ensureIncidentRoot(); assertIncidentLinks(); assertRuntimeLinks()
    this.killReports = new KillReports(this.options.killReportDirs ?? killReportDirs())
    for (const [name, value] of Object.entries(process.env)) if (/^(?:http|https|all|ftp|socks)_proxy$/i.test(name) && value) { const port = userProxyPort(value); if (!port) throw new NetworkGuardFailure(`Cannot safely identify ${name}; Guillotine Mode startup refused.`); this.forbiddenPorts.add(port) }
    const proxies = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } })
    for (const m of proxies.matchAll(/(?:HTTP|HTTPS|SOCKS|FTP|Gopher|RTSP)Port\s*:\s*(\d+)/g)) this.forbiddenPorts.add(Number(m[1]))
    // In a group of its own under the watchdog: a crashed or SIGKILLed G-Code never runs close(), and
    // an orphaned `log stream` outlives it for good.
    const monitor = this.monitor = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', 'eventMessage CONTAINS "GCODE_GUARD_"'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, detached: true })
    if (monitor.pid) this.monitorWatchdog = watchGroup(monitor.pid)
    monitor.stdout?.setEncoding('utf8'); monitor.stderr?.resume()
    monitor.stdout?.on('data', data => this.consume(String(data)))
    const failed = () => {
      this.monitorReady = false
      if (this.closed || this.fault) return
      this.failClosed('The violation monitor stopped. No further work is allowed. Close this chat and open it again to continue.')
      // Said now: nothing else would say it until the next message.
      this.notice(`Guillotine Mode unavailable: the violation monitor stopped. Close this chat and open it again to continue.`)
    }
    monitor.on('error', failed); monitor.on('exit', failed)
    await new Promise(r => setTimeout(r, 200))
    try { await verifySandboxMembership(); await this.fence(true); this.monitorReady = true; this.reaper = setInterval(() => { this.reap(); this.readKillReports(); this.askStoreIfDue(); this.checkReportFormat() }, 250); this.reaper.unref() } catch (error) { await this.close(); throw error }
  }
  /** Every JSON log record is processed, including DNS and records delivered in one chunk. */
  consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > 2_000_000) { this.failClosed('Violation monitor buffer overflow.'); this.buffer = ''; return }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
      let message: string
      try { message = String(JSON.parse(line).eventMessage ?? '') } catch { continue }
      this.consumeMessage(message, 'seatbelt')
    }
  }
  private consumeMessage(message: string, layer: string): void {
    const tag = /GCODE_GUARD_[a-f0-9_]+/.exec(message)?.[0]
    if (!tag) return
    const barrier = this.barriers.get(tag)
    if (barrier) {
      // curl may first log unrelated Mach denials. Only the requested TEST-NET
      // socket denial proves the network reporting path and ordering fence.
      if (/deny\(\d+\) network-outbound[^\n]*remote:\*:9(?:\s|$)/.test(message)) { this.barriers.delete(tag); barrier() }
      return
    }
    const call = this.calls.get(tag)
    if (!call || !/deny\(\d+\) (?:network-\S+|system-socket)/.test(message)) return
    // Chromium's own reachability test: denied and no packet sent. See browserProfile.
    if (message.includes(`${tag} ${BROWSER_PROBE_MESSAGE}`)) return
    // A denied local diagnostic write is not an external network attempt.
    if (/deny\(\d+\) network-outbound \/private\/var\/run\/syslog(?:\s|$)/.test(message)) return
    const port = /remote:\*:(\d+)/.exec(message)?.[1]
    const pid = /\((\d+)\).*deny/s.exec(message)?.[1]
    // A live record of a process this profile kills: its crash report should follow, if macOS still writes them.
    if (layer === 'seatbelt' && pid && !this.latched && !call.processes.some(p => p.trusted)) { this.killReports?.takeUnreadable(); this.formatWatch = { pid: Number(pid), process: /^Sandbox: (.+?)\(\d+\)/.exec(message)?.[1] ?? '', until: Date.now() + FORMAT_CHECK_MS } }
    // The resolver's socket says nothing about the name. An attempt on it is held whatever the name was.
    const lookup = /network-outbound \S*mDNSResponder/.test(message)
    void this.trip(call, { layer, raw: message, ...(port ? { port: Number(port) } : {}), ...(pid ? { pid: Number(pid) } : {}), reason: lookup ? 'A tool asked the system resolver to look up a name. Nothing was sent, but G-Code cannot see the name, so every lookup stops the work, localhost included. Use 127.0.0.1 for a local server. Continue cannot grant an unknown endpoint.' : 'The OS summary does not reliably identify the remote address. Raw OS diagnostics are retained; a command literal is not an observed destination. Continue cannot grant an unknown endpoint.' })
  }
  /** Called for every sandboxed launch: the next fence must prove its reports arrived. */
  noteActivity(): void { this.activity = true }
  /** A sandboxed process of this call started: the log store will be asked about it (see askStoreIfDue). */
  watchInStore(tag: string): void { if (!this.storeWatch.has(tag)) this.storeWatch.set(tag, { asks: 0, since: Date.now(), at: 0 }) }
  /** An owning turn ended, however it ended: time to ask the log store about what ran in it. */
  endTurn(owner = true): void { if (owner) this.turnEnded = true }
  /**
   * The third witness, when `log stream` lost a record and macOS wrote no crash report (it stops after
   * 25 kills per process name, for hours at least): a shell that exits 0 raises no suspect, so nothing
   * else would ask. Asked once when a turn ends, every STORE_ASK_MS in a long one, and once more after
   * STORE_RELOOK_MS for records still lagging. Never polled: one query costs about a second of CPU.
   * A record that the store only gets after that is still blocked but not held.
   */
  private askStoreIfDue(): void {
    if (!this.storeWatch.size) this.turnEnded = false
    if (this.storeBusy || this.closed || this.latched || !this.storeWatch.size) return
    const now = Date.now(), first = this.turnEnded || now - this.lastStoreAsk >= STORE_ASK_MS
    const due = [...this.storeWatch.entries()].filter(([, w]) => w.asks === 0 ? first : now - w.at >= STORE_RELOOK_MS)
    if (!due.length) return
    this.turnEnded = false; this.lastStoreAsk = now; this.storeBusy = true
    const epoch = this.storeEpoch, tags = due.map(([tag]) => tag)
    const oldest = Math.min(...due.map(([, w]) => w.since))
    for (const [tag, watch] of due) { watch.at = now; if (++watch.asks >= 2) this.storeWatch.delete(tag) }
    void this.storedDenials(tags, now - oldest).then(messages => {
      // A hold since the question was asked has already dealt with these calls.
      if (epoch === this.storeEpoch) for (const message of messages) this.consumeMessage(message, 'seatbelt-log-store')
    }).catch(() => {}).finally(() => { this.storeBusy = false })
  }
  /** Tells the user when macOS wrote a crash report for a real kill and G-Code could not read it: this witness has gone with an OS update. */
  private checkReportFormat(): void {
    const watch = this.formatWatch
    if (!watch) return
    const unreadable = this.killReports?.takeUnreadable().find(entry => entry.pid === watch.pid || entry.pid === undefined && watch.process && entry.name.startsWith(`${watch.process}-`))
    if (unreadable) {
      this.formatWatch = undefined
      this.remember('report-format', { file: unreadable.name, reason: 'Not a form G-Code can read.' })
      this.notice(`Guillotine Mode: macOS wrote a crash report G-Code cannot read (${unreadable.name}), so its format has changed. This attempt was still caught through the system log, which is still watched, but an attempt whose log record is lost may now be blocked without a hold.`)
    } else if (Date.now() >= watch.until) this.formatWatch = undefined
  }
  /**
   * A tool process ended by a SIGKILL G-Code did not send, or its shell said one of its commands did
   * (exit 137), or how it ended is not known: the next fence waits for what its crash report says.
   */
  noteKilled(pid: number | undefined): void { if (pid && !this.latched) { this.suspects.add(pid); this.activity = true } }
  /**
   * A crash report says Seatbelt killed a process of a call: a denied attempt, whether or not its log
   * record ever arrives. Normally that record has already tripped the incident and this does nothing.
   * A report of a process no call knows is not this guard's: a fence probe's own kill, or another
   * session's. A process the 250 ms tracker never saw, whose parent it never saw either, cannot be told
   * from those, so it stays blocked without an incident.
   */
  private readKillReports(): void {
    for (const report of this.killReports?.read() ?? []) {
      if (report.pid === this.formatWatch?.pid) this.formatWatch = undefined
      if (this.latched) continue
      const call = [...this.calls.values()].find(c => c.processes.some(p => p.pid === report.pid || p.pid === report.parentPid))
      if (call) void this.trip(call, killObservation(report))
    }
  }
  /**
   * After a fence has shown no denial record came: a suspect's crash report takes about 200 ms more.
   * macOS can drop a report in a burst of kills, so the log store is asked too, though it can lag. With
   * nothing in either, the kill is taken as not Seatbelt's (out of memory, a user's kill -9) and work
   * goes on, about 2 s later. A report that is merely late still holds the work: readKillReports.
   */
  private async settleKills(): Promise<void> {
    if (!this.suspects.size) return
    const deadline = Date.now() + KILL_REPORT_WAIT_MS
    for (;;) {
      this.readKillReports()
      if (this.latched || Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, KILL_REPORT_POLL_MS))
    }
    if (!this.latched) {
      const tags = [...this.calls.values()].filter(c => c.processes.some(p => this.suspects.has(p.pid))).map(c => c.tag)
      if (tags.length) for (const message of await this.storedDenials(tags)) this.consumeMessage(message, 'seatbelt-log-store')
    }
    if (!this.latched) this.remember('unexplained-kill', { pids: [...this.suspects], reason: 'SIGKILL not sent by G-Code, with no denial record, sandbox crash report or stored record: not treated as a network attempt.' })
    this.suspects.clear()
  }
  private liveProcesses(): boolean { return [...this.calls.values()].some(c => !c.retired && c.processes.some(p => !p.stopped)) }
  /**
   * Proves every earlier denial report that macOS delivered has been read: a probe's own TEST-NET
   * denial arrives after them. A report macOS lost cannot be proved (about 1 denied attempt in 300,
   * killed but never logged, measured 2026-11-05): settleKills covers those whose kill the launcher saw,
   * and readKillReports the rest, up to half a second after this fence has passed. Skipped when no sandboxed process ran or
   * runs since the last proof (model requests and in-process tools start none). A probe's own report
   * can be lost too, so further probes follow (FENCE_PROBES) before work stops.
   */
  async fence(startup = false): Promise<void> {
    if (this.latched && !startup) { await this.check(); return }
    if (!startup && !this.activity && !this.liveProcesses()) { await this.check(); return }
    if (this.closed || !this.monitor || this.monitor.exitCode !== null || this.monitor.signalCode !== null) throw new Error('Guillotine Mode monitor is unavailable.')
    this.activity = false
    let failure: unknown
    for (const probe of FENCE_PROBES) {
      try { await this.probe(probe.kill, probe.waitMs); failure = undefined; break } catch (error) { failure = error }
    }
    if (failure) { this.activity = true; if (!startup) this.failClosed(String(failure instanceof Error ? failure.message : failure), true); throw failure }
    if (!startup) { await this.settleKills(); await this.check() }
  }
  private async probe(kill: boolean, waitMs: number): Promise<void> {
    const tag = `GCODE_GUARD_${randomUUID().replaceAll('-', '')}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<void>((resolve, reject) => { this.barriers.set(tag, resolve); timer = setTimeout(() => { this.barriers.delete(tag); reject(new Error('macOS did not confirm the network monitor in time.')) }, waitMs) })
    const probe = spawn('/usr/bin/sandbox-exec', ['-p', toolProfile(tag, true, [], [], kill), '/usr/bin/curl', '--noproxy', '*', '--connect-timeout', '1', '--max-time', '1', 'http://203.0.113.5:9'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, detached: true })
    try { await done; await new Promise(r => setImmediate(r)) }
    finally { if (timer) clearTimeout(timer); if (probe.exitCode === null && probe.signalCode === null && probe.pid) { try { process.kill(-probe.pid, 'SIGKILL') } catch {} } }
  }
  async check(): Promise<void> { if (this.incidentWork) await this.incidentWork; if (this.fault) throw this.fault; if (this.latched) throw new NetworkStopped(this.incident) }
  assertReady(): void { if (this.fault) throw this.fault; if (this.latched) throw new NetworkStopped(); if (!this.monitorReady || this.closed) throw new NetworkGuardFailure('Guillotine Mode monitor is unavailable; tool refused.') }
  private failClosed(reason: string, recoverable = false): void {
    if (this.fault) return
    this.recoverable = recoverable
    this.fault = new NetworkGuardFailure(recoverable
      ? `Guillotine Mode paused this turn: ${reason} No network attempt was detected. Send your message again to retry.`
      : `Guillotine Mode unavailable: ${reason} No verified network incident is claimed.`)
    this.latched = true; this.controller.abort(this.fault); this.stopProcesses()
    void this.cut?.().catch(() => {})
  }
  private reap(): void {
    const calls = [...this.calls.values()].filter(c => !c.retired)
    let members: SandboxMember[]
    try { members = sandboxMembers(calls.filter(c => c.processes.length).map(c => c.tag)) }
    catch (error) { this.failClosed(`Sandbox process tracking failed: ${String(error)}`); return }
    for (const call of calls) {
      const live = members.filter(p => p.tag === call.tag)
      this.recordMembers(call, live)
      for (const p of call.processes) {
        if (p.trusted) { if (!p.stopped && !(p.group === false ? processIdentity(p.pid) === p.identity : groupAlive(p.pid))) p.stopped = true }
        else if (!live.some(m => m.pid === p.pid && (!p.kernelIdentity || p.kernelIdentity === m.start))) p.stopped = true
      }
      if (call.completed && !live.length && call.processes.every(p => p.stopped)) {
        call.proxy?.close(); call.proxy = undefined; call.retired = true
        // A long-lived process has outlived its questions: one more, about how it ended. A hold has already dealt with what it cut.
        if (call.processes.length && !call.cut && !this.storeWatch.has(call.tag)) this.storeWatch.set(call.tag, { asks: 1, since: Date.now() - STORE_RELOOK_MS, at: Date.now() })
      }
    }
  }
  private recordMembers(call: GuardCall, members: SandboxMember[]): void {
    for (const member of members) {
      const known = call.processes.find(p => !p.stopped && p.pid === member.pid)
      if (known) { known.kernelIdentity = member.start; continue }
      call.processes.push({ pid: member.pid, argv: [], cwd: '', kernelIdentity: member.start, identity: processIdentity(member.pid), group: false,
        ancestry: [{ pid: member.pid, ppid: member.ppid, pgid: member.pgid, identity: member.start }],
        ancestryStatus: 'Inherited sandbox membership observed by the native tracker. Descendant argv/cwd were not collected; see the originating tool call.' })
    }
  }
  private stopProcesses(): void {
    const active = [...this.calls.values()].filter(c => !c.retired && c.processes.length)
    try {
      const members = sandboxMembers(active.map(c => c.tag), true)
      for (const call of active) this.recordMembers(call, members.filter(p => p.tag === call.tag))
    } catch (error) { this.fault ??= new NetworkGuardFailure(`Could not verify sandbox descendant cleanup: ${String(error)}`) }
    for (const c of this.calls.values()) { c.proxy?.close(); for (const p of c.processes) {
      if (p.stopped) continue
      // A still-live leader must keep its creation identity. Once a group becomes empty it is
      // permanently retired, so a later pid reuse cannot turn it into a kill target.
      const identity = processIdentity(p.pid)
      if (identity && p.identity && identity !== p.identity) { p.stopped = true; continue }
      // The native tracker already revalidated and killed detached descendants.
      // Keep group cleanup for a root still between spawn and sandbox activation.
      if (!p.kernelIdentity) try { process.kill(p.group === false ? p.pid : -p.pid, 'SIGKILL') } catch {}
      p.stopped = true
    } }
  }
  async finishCall(call: GuardCall | undefined): Promise<void> { if (call) call.completed = true; try { await this.fence() } finally { this.reap() } }
  /**
   * A call's execution ended, before its result settles in model order: its proxy port pair is
   * freed now, not when finishCall runs for it, so calls that ran side by side do not hold the
   * finite pool until the whole group settles. finishCall still journals, fences and reaps it. A
   * call that started no sandboxed process is retired at once (reap would do the same without
   * asking the tracker); one that did is reaped like any other and stays until its processes end.
   */
  complete(call: GuardCall | undefined): void {
    if (!call || call.retired) return
    call.completed = true
    // No process means its tag is in no profile: nothing can ever arrive for it.
    if (!call.processes.length) { call.proxy?.close(); call.proxy = undefined; call.retired = true; this.calls.delete(call.tag) } else this.reap()
  }
  allowed(call: GuardCall | undefined, host: string, port: number, _address?: string): boolean {
    // Conservative port-wide exclusion also covers DNS/IPv4-mapped aliases and rebinding.
    if (this.latched || this.forbiddenPorts.has(port) || GUARD_PROXY_PORTS.includes(port)) return false
    return loopbackHost(host) || destinationAllowed(host, port, [...this.grants, ...(call?.grants ?? [])])
  }
  /**
   * Attribution outlives a call, for a late denial, but a chat must not die of a counter. A call whose
   * processes have all ended goes first, oldest first: its fence has already read what macOS delivered,
   * so only a record lost and then found very late could need it, and then that attempt stays blocked
   * without a hold. Only with thousands of calls actually running is a new one refused, and the chat goes on.
   */
  private boundCalls(): void {
    if (this.calls.size < CALL_LIMIT) return
    for (const [tag, call] of this.calls) { if (this.calls.size < CALL_LIMIT) break; if (call.retired) this.calls.delete(tag) }
    if (this.calls.size >= CALL_LIMIT) throw new NetworkGuardFailure(`Guillotine Mode is tracking ${CALL_LIMIT} running calls. Wait for background work to stop before starting another.`)
  }
  async call(name: string, id: string, input: unknown, hosts: string[] = [], session = false): Promise<GuardCall> {
    this.assertReady()
    this.boundCalls()
    if (session) hosts.forEach(h => this.grants.add(h))
    const call: GuardCall = { id, name, input: structuredClone(input), turn: currentCall()?.turn ?? this.turn, grants: [...hosts], tag: `GCODE_GUARD_${randomUUID().replaceAll('-', '')}`, processes: [] }
    for (let i = 0; i < GUARD_PROXY_PORTS.length; i += 2) {
      const ports = [GUARD_PROXY_PORTS[i]!, GUARD_PROXY_PORTS[i + 1]!] as const
      if (ports.some(p => this.forbiddenPorts.has(p))) continue
      try { call.proxy = await callProxy((h, p, a) => this.allowed(call, h, p, a), o => { void this.trip(call, o).catch(() => {}) }, ports); break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error }
    }
    if (!call.proxy) throw new NetworkGuardFailure('Guillotine Mode proxy port pool is full. Wait for background work to stop before starting another call.')
    if (call.proxy) {
      this.secrets.add(call.proxy.secret); this.secrets.add(Buffer.from(`gcode:${call.proxy.secret}`).toString('base64'))
      for (const secret of this.secrets) { if (this.secrets.size <= SECRET_LIMIT) break; this.secrets.delete(secret) }
    }
    this.calls.set(call.tag, call)
    return call
  }
  /** Latch synchronously, cut all owned work, then write immutable evidence before any notification. */
  trip(call: GuardCall | undefined, observation: Observation): Promise<void> {
    if (this.latched) return this.incidentWork ?? Promise.resolve()
    this.latched = true
    this.suspects.clear()
    this.storeWatch.clear(); this.storeEpoch++; this.turnEnded = false
    for (const c of this.calls.values()) c.cut = true
    this.controller.abort(new NetworkStopped())
    this.stopProcesses()
    const state = this.options.store.getState()
    const id = randomUUID(), path = join(incidentRoot(), id), at = Date.now()
    const authority = observation.host ? destinationAuthority(observation.host, observation.port ?? 443) : undefined
    const destination = authority ?? (observation.port ? `Unknown address, port ${observation.port}` : 'Unknown destination')
    const forbidden = !!observation.forbiddenTarget || this.forbiddenPorts.has(observation.port ?? 443) || GUARD_PROXY_PORTS.includes(observation.port ?? 443)
    const turn = call?.turn ?? this.turn
    const text = JSON.stringify(turn.journal.filter(e => e.kind === 'model-event').slice(-40))
    const incident: NetworkIncident = { id, path, at, sessionId: state.sessionId, destination, model: `${this.options.provider}:${this.options.model}`, layer: observation.layer, tool: call?.name ?? 'Runtime monitor', input: call?.input ?? {}, intent: text.slice(-8000), canContinue: !!authority && !forbidden, reason: forbidden ? 'This port is reserved for a user proxy or another guarded call. It cannot be approved.' : observation.reason }
    this.options.store.setState(() => ({ networkHold: { incident, phase: 'held', evidenceSaved: false, grants: [...this.grants] } }))
    // On disk at once: whatever happens from here, a resume finds the hold. Any failure is reported when the evidence is saved below.
    try { saveSession(this.options.store.getState(), { force: true }) } catch { /* The save below reports it. */ }
    this.incidentWork = (async () => {
      let cutError: string | undefined
      try { await this.cut?.() } catch (error) { cutError = String(error) }
      if (this.fault) throw this.fault
      if (cutError) throw new NetworkGuardFailure(`Guillotine Mode stopped work but could not settle its owners: ${cutError}`)
      // The stream lost the record, but the log store may already have it, with its port.
      const storedRecords = observation.layer === KILL_REPORT_LAYER && call ? await this.storedDenials([call.tag]) : undefined
      const model: Record<string, unknown> = { provider: this.options.provider, name: this.options.model, digest: this.options.modelDigest ?? null, identityStatus: this.options.provider === 'ollama' ? this.options.modelDigest ? 'Ollama digest reported by the local server' : 'Unavailable: the local server did not report a matching model digest' : this.options.modelFile ? `The GGUF hash follows in ${MODEL_IDENTITY_FILE} next to this file. A large file takes seconds to hash, so the hold does not wait for it; no such file means G-Code stopped first or the file could not be read.` : 'Unavailable: no GGUF path was configured' }
      if (this.options.modelFile) { model.path = this.options.modelFile; try { model.size = modelFiles(this.options.modelFile).reduce((total, file) => total + statSync(file).size, 0) } catch { model.size = 'Unavailable' } }
      const chain = JSON.stringify({ turnId: turn.id, userInput: turn.userInput, events: turn.journal })
      const evidence = { ...incident, permissionMode: state.permissionContext.mode, project: state.cwd, settings: this.options.settings, model, observation: { host: null, ip: null, sni: null, ...observation, ...(storedRecords ? { storedRecords } : {}) }, process: call?.processes ?? [], toolCall: call && { id: call.id, name: call.name, input: call.input }, chain: chain.slice(0, 180000), trimmed: turn.trimmed || chain.length > 180000, precursors: [...chain.matchAll(/.{0,80}(?:resolv\.conf|\/etc\/hosts|which (?:curl|wget|nc)|169\.254\.169\.254|proxy|credential).{0,80}/gi)].map(m => m[0]).slice(0, 40), approvals: { session: [...this.grants], call: call?.grants ?? [] }, conclusion: `No approval covered ${destination}.`, cutError }
      let json = JSON.stringify(evidence, null, 2)
      for (const secret of this.secrets) json = json.replaceAll(secret, '[proxy credential omitted]')
      await saveEvidence(incident, json)
      this.options.store.setState(current => ({ networkHold: { ...current.networkHold!, evidenceSaved: true } }))
      saveSession(this.options.store.getState(), { force: true }); this.notify?.(incident); if (this.notify) this.notified = incident.id
      if (this.options.modelFile) void this.saveModelIdentity(this.options.modelFile, path)
    })().catch(error => {
      this.fault = new NetworkGuardFailure(`Guillotine Mode stopped work, but evidence was not fully saved: ${String(error)}. The session remains held. Deny goes on without full evidence; Continue is unavailable.`)
      this.incomplete = true
      try { saveSession(this.options.store.getState(), { force: true }) } catch {}
      // Deny has to be reachable now, not only after reopening the chat.
      this.notify?.(incident); if (this.notify) this.notified = incident.id
      throw this.fault
    })
    void this.incidentWork.catch(() => {})
    return this.incidentWork
  }
  /** The model file's hash, as a separate read-only file: never on the way to the hold, and a slice at a time so nothing waits on it. */
  private async saveModelIdentity(file: string, path: string): Promise<void> {
    let sha256 = 'Unavailable'
    try {
      const digest = createHash('sha256')
      for (const part of modelFiles(file)) for await (const chunk of createReadStream(part, { highWaterMark: 1024 * 1024 })) { if (this.closed) return; digest.update(chunk as Buffer) }
      sha256 = digest.digest('hex')
    } catch { /* Unreadable: said in the file. */ }
    try { chmodSync(path, 0o755); try { writeFileSync(join(path, MODEL_IDENTITY_FILE), JSON.stringify({ path: file, sha256 }), { flag: 'wx', mode: 0o444 }) } finally { chmodSync(path, 0o555) } } catch { /* The evidence says this file may be absent. */ }
  }
  async decide(id: string, choice: 'continue' | 'reject'): Promise<string | undefined> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !['continue', 'reject'].includes(choice)) throw new Error('Invalid incident decision')
    // Only a failure to save evidence can be denied past: a dead monitor still stops everything.
    const denyPast = this.incomplete && choice === 'reject'
    if (this.fault && !denyPast) throw this.fault
    if (this.incidentWork) await (denyPast ? this.incidentWork.catch(() => {}) : this.incidentWork)
    const held = this.options.store.getState().networkHold
    if (!held || held.phase !== 'held' || held.incident.id !== id) throw new Error('Incident is not awaiting a decision.')
    if (choice === 'continue' && !held.incident.canContinue) throw new Error(held.incident.reason ?? 'Unknown destinations cannot be approved.')
    const path = join(incidentRoot(), id)
    const decision = JSON.stringify({ at: Date.now(), decision: choice, ...(denyPast ? { evidenceIncomplete: true } : {}) })
    const record = () => { chmodSync(path, 0o755); try { writeFileSync(join(path, 'decision.json'), decision, { flag: 'wx', mode: 0o444 }) } finally { chmodSync(path, 0o555) } }
    if (denyPast) {
      // What is known goes on disk if it can; a full disk cannot be allowed to end the chat.
      try { if (!existsSync(join(path, 'evidence.json'))) await saveEvidence(held.incident, JSON.stringify({ ...held.incident, evidenceIncomplete: true, conclusion: `Evidence could not be saved when this attempt was stopped; this is what was kept. No approval covered ${held.incident.destination}.` }, null, 2)); record() } catch { /* Deny still goes on. */ }
    } else record()
    if (choice === 'continue') this.grants.add(held.incident.destination)
    this.options.store.setState(() => ({ networkHold: { ...held, phase: choice === 'continue' ? 'continued' : 'rejected', grants: [...this.grants], incident: { ...held.incident, decision: choice, ...(denyPast ? { evidenceIncomplete: true } : {}) } } }))
    try { saveSession(this.options.store.getState(), { force: true }) } catch (error) { if (!denyPast) throw error }
    this.latched = choice === 'reject'; this.incidentWork = undefined
    if (choice === 'continue') this.controller = new AbortController()
    return choice === 'continue' ? `The user continued after a blocked network attempt and approved ${held.incident.destination} for this session. Evidence was kept read-only. Start a new continuation turn from saved progress; do not replay the cut call automatically.` : undefined
  }
  nextUserMessage(): void {
    if (this.options.store.getState().networkHold?.phase === 'rejected') { this.latched = false; this.incidentWork = undefined; this.controller = new AbortController(); if (this.incomplete) { this.incomplete = false; this.fault = undefined } }
    // A monitor timeout stopped the last turn without any observed attempt: retry with a fresh fence.
    else if (this.recoverable && this.fault && this.monitorReady && !this.closed) { this.fault = undefined; this.recoverable = false; this.latched = false; this.activity = true; this.controller = new AbortController() }
  }
  async close(): Promise<void> { this.closed = true; this.monitorReady = false; if (this.reaper) clearInterval(this.reaper); this.stopProcesses(); if (this.monitor && this.monitor.exitCode === null && this.monitor.signalCode === null) { this.monitor.kill('SIGKILL'); await new Promise<void>(resolve => { this.monitor!.once('close', () => resolve()); setTimeout(resolve, 1000).unref() }) } endWatchdog(this.monitorWatchdog); if (this.incidentWork) await this.incidentWork.catch(() => {}) }
}

/** No host and no port: the crash report has neither, so the incident's destination is unknown and Continue is unavailable. */
function killObservation(report: KillReport): Observation {
  return { layer: KILL_REPORT_LAYER, pid: report.pid, raw: JSON.stringify(report), reason: `macOS killed ${report.process ?? 'a process'} (pid ${report.pid}) for a denied network attempt, but the denial's log record never arrived, so the destination is unknown. The attempt was blocked. A hard link to a socket file also dies this way, with no network involved. Crash report: ${report.file}. Continue cannot grant an unknown endpoint.` }
}

const MODEL_IDENTITY_FILE = 'model-identity.json'

/**
 * The folder appears whole or not at all, so a resume can trust that it exists: a crash leaves at most
 * a temporary name, which the incident list skips. If the index fails, the evidence is still kept.
 */
async function saveEvidence(incident: NetworkIncident, json: string): Promise<void> {
  ensureIncidentRoot(); assertIncidentLinks()
  const temporary = join(incidentRoot(), `.evidence-${randomUUID()}`)
  const md = `# Network attempt blocked\n\nNo approval covered ${incident.destination}.\n\nModel: ${incident.model}\n\nDestination: ${incident.destination}\n\n${incident.reason ?? ''}\n\n## Exact call, observations and bounded conversation\n\n\`\`\`json\n${json}\n\`\`\`\n`
  try {
    mkdirSync(temporary, { mode: 0o700 })
    writeFileSync(join(temporary, 'evidence.json'), json, { flag: 'wx', mode: 0o444 }); writeFileSync(join(temporary, 'evidence.md'), md, { flag: 'wx', mode: 0o444 })
    // macOS refuses to rename a folder that is not writable.
    renameSync(temporary, incident.path); chmodSync(incident.path, 0o555)
  } catch (error) { try { chmodSync(temporary, 0o700); rmSync(temporary, { recursive: true, force: true }) } catch { /* Nothing was made. */ } throw error }
  await writeIndex(incident.id, { at: incident.at, model: incident.model, destination: incident.destination, files: { 'evidence.json': hash(json), 'evidence.md': hash(md) } })
}

/** A holder takes milliseconds: this long means it stopped or is stuck. */
const INDEX_LOCK_STALE_MS = 60_000
const INDEX_LOCK_WAIT_MS = 5_000
const selfIdentity = () => `${process.pid} ${processIdentity(process.pid) ?? ''}`
/** Whether a lock can be taken over: its owner is gone, it has no owner and is old, or it is simply too old. */
export function indexLockStale(lock: string, identity: (pid: number) => string | undefined = processIdentity): boolean {
  let owner: string | undefined
  try { owner = readFileSync(join(lock, 'owner'), 'utf8') } catch { /* Died before writing it, or an older version's lock. */ }
  if (owner) {
    const [pid, ...start] = owner.split(' '), recorded = start.join(' ')
    let alive = true
    try { process.kill(Number(pid), 0) } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM' }
    if (!alive) return true
    // ps can time out under load, then or now. That says nothing about the owner, so the age below decides.
    const current = identity(Number(pid))
    if (recorded && current && current !== recorded) return true
  }
  try { return Date.now() - statSync(lock).mtimeMs >= INDEX_LOCK_STALE_MS } catch { return false }
}

/** Narrow cross-process lock plus atomic replacement: simultaneous chats never lose index entries. A dead holder's lock is taken over, so it cannot stop every chat on the machine. */
async function writeIndex(id: string, entry: unknown): Promise<void> {
  const root = incidentRoot(), lock = join(root, '.index-lock'), owner = selfIdentity(), deadline = Date.now() + INDEX_LOCK_WAIT_MS
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'owner'), owner); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`Incident index lock ${lock} is held by another process`)
      // Moving it is atomic: of two waiters, one takes it over and the other waits for the new holder.
      if (attempt % 25 === 0 && indexLockStale(lock)) {
        const stale = join(root, `.index-lock-stale-${randomUUID()}`)
        try { renameSync(lock, stale); rmSync(stale, { recursive: true, force: true }) } catch { /* The other waiter did. */ }
        continue
      }
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const temp = join(root, `.index-${randomUUID()}.tmp`)
  try {
    const path = join(root, 'index.json')
    const index = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    index[id] = entry
    writeFileSync(temp, JSON.stringify(index, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
    // Not ours any more if it was taken over while this process stood still.
    try { if (readFileSync(join(lock, 'owner'), 'utf8') === owner) rmSync(lock, { recursive: true, force: true }) } catch { /* Gone. */ }
  }
}

/**
 * A redirect the caller will not follow is still an attempt: a target off the allowlist trips the
 * guard as guardedFetch's own check does. Without a guard, or for an allowed target, it returns.
 */
export async function refuseBlockedRedirect(target: URL): Promise<void> {
  const guard = currentGuard()
  if (guard) await refuseBlocked(guard, currentCall(), target)
}

async function refuseBlocked(guard: NetworkGuard, call: GuardCall | undefined, url: URL): Promise<void> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (['http:', 'https:'].includes(url.protocol) && guard.allowed(call, url.hostname, port)) return
  await guard.trip(call, { layer: 'engine-fetch', host: url.hostname, port, url: url.href, scheme: url.protocol }); await guard.check(); throw new NetworkStopped(guard.incident)
}

/** Headers a redirect to another origin may keep: nothing here can hold a credential. */
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'user-agent'])

/** In-process egress preserves Request semantics and checks each redirect before transport.
 * directFetch supplies the measured Bun 1.3 NO_PROXY compatibility fix (proxy:false alone is
 * insufficient). Known user-proxy ports are excluded before any resolution or transport. */
export async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const guard = currentGuard(), call = currentCall()
  if (!guard) return fetch(input, init)
  let request = new Request(input, init)
  const redirect = request.redirect
  for (let i = 0; i < 20; i++) {
    guard.assertReady()
    const url = new URL(request.url)
    await refuseBlocked(guard, call, url)
    const replay = request.clone()
    const signal = AbortSignal.any([request.signal, guard.signal])
    // A caller with its own deadline (an MCP call) asks Bun not to add its 300 s; a Request cannot carry that.
    const response = await directFetch(request, { redirect: 'manual', signal, ...(init && 'timeout' in init ? { timeout: init.timeout } : {}) } as RequestInit)
    const location = response.headers.get('location')
    if (redirect === 'manual' || ![301, 302, 303, 307, 308].includes(response.status) || !location) { void replay.body?.cancel(); return response }
    if (redirect === 'error') { void replay.body?.cancel(); await response.body?.cancel(); throw new TypeError('Redirect is not allowed') }
    const next = new URL(location, url)
    if (next.username || next.password) { void replay.body?.cancel(); await response.body?.cancel(); throw new TypeError('Redirect credentials are not allowed') }
    const headers = new Headers(replay.headers)
    headers.delete('host'); headers.delete('proxy-authorization')
    // Custom headers can hold a key as well (X-API-Key, a team token), and an https page must not send them to http.
    if (next.origin !== url.origin) for (const header of [...headers.keys()]) if (!CROSS_ORIGIN_HEADERS.has(header)) headers.delete(header)
    let method = replay.method, body = replay.body
    if ((response.status === 301 || response.status === 302) && method === 'POST' || response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET'; void body?.cancel(); body = null
      for (const header of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) headers.delete(header)
    }
    await response.body?.cancel()
    request = new Request(next, { method, body, headers, signal: replay.signal, credentials: replay.credentials, cache: replay.cache, redirect, ...{ duplex: 'half' } })
  }
  throw new Error('Too many network redirects')
}
