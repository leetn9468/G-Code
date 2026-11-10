/**
 * @file store.ts
 * @brief Immutable state store with subscription support
 *
 * Provides a generic Store<T> pattern. State updates produce new objects;
 * direct mutation is prevented by convention (DeepReadonly at call sites).
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, hostname } from 'node:os'
import type { ContentBlock } from '../llm/types.js'
import { terminalTool } from '../shared/runtimeEvents.js'
import { tokenCalibration } from '../shared/tokenCalibration.js'
import { headUnits } from '../utils/textUnits.js'
import {
  type AppState,
  type SessionContext,
  type Message,
  type ToolPermissionContext,
  createDefaultPermissionContext,
  createEmptySessionContext,
} from '../types.js'

// ============================================================================
// Generic Store
// ============================================================================

export type StateUpdater<T> = (prev: T) => Partial<T>
export type Unsubscribe = () => void

export interface Store<T> {
  getState(): Readonly<T>
  setState(updater: StateUpdater<T>): void
  subscribe(listener: (state: Readonly<T>) => void): Unsubscribe
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = { ...initial }
  const listeners = new Set<(state: Readonly<T>) => void>()

  return {
    getState(): Readonly<T> {
      return state
    },

    setState(updater: StateUpdater<T>): void {
      const patch = updater(state)
      state = { ...state, ...patch }
      for (const listener of listeners) {
        listener(state)
      }
    },

    subscribe(listener: (state: Readonly<T>) => void): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// ============================================================================
// AppState Factory
// ============================================================================

export function createDefaultAppState(
  sessionId?: string,
  cwd?: string,
): AppState {
  const id = sessionId ?? randomUUID()

  return {
    sessionId: id,
    cwd: cwd ?? process.cwd(),
    messages: [],
    permissionContext: createDefaultPermissionContext(),
    sessionContext: createEmptySessionContext(),
  }
}

export function createAppStore(
  sessionId?: string,
  cwd?: string,
): Store<AppState> {
  return createStore(createDefaultAppState(sessionId, cwd))
}

// ============================================================================
// Session Persistence
// ============================================================================

function getGcodeDir(): string {
  return join(homedir(), '.gcode')
}

function getSessionDir(cwd: string): string {
  // Encoding only the first 24 bytes of cwd merged unrelated sibling projects.
  const hash = createHash('sha256').update(resolve(cwd), 'utf8').digest('hex')
  return join(getGcodeDir(), 'projects', hash)
}

/** Shared generated data for the same project key as session history. */
export function getProjectDirectory(cwd: string): string {
  return getSessionDir(cwd)
}

/** Files owned by a single session, separate from its JSON history. */
export function getSessionDirectory(cwd: string, sessionId: string): string {
  if (!validSessionId(sessionId)) throw new Error('Invalid session ID')
  return join(getSessionDir(cwd), sessionId)
}

function getLegacySessionDir(cwd: string): string {
  return join(getGcodeDir(), 'projects', Buffer.from(cwd).toString('base64url').slice(0, 32))
}

function validSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
}

function readBoundSession(path: string, cwd: string, sessionId?: string): SessionData | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SessionData
    if (!data || typeof data.cwd !== 'string' || resolve(data.cwd) !== resolve(cwd)
      || typeof data.sessionId !== 'string' || !validSessionId(data.sessionId)
      || (sessionId && data.sessionId !== sessionId)
      || !Array.isArray(data.messages) || !data.permissionContext || !data.sessionContext
      || !Number.isFinite(data.savedAt)) return null
    return data
  } catch { return null }
}

function getSessionPath(cwd: string, sessionId: string): string {
  return join(getSessionDir(cwd), `${sessionId}.json`)
}

export interface SessionData {
  sessionId: string
  cwd: string
  messages: Message[]
  sessionContext: SessionContext
  permissionContext: ToolPermissionContext
  savedAt: number
  contextMessages?: AppState['contextMessages']
  contextStatus?: AppState['contextStatus']
  contextCalibration?: AppState['contextCalibration']
  networkHold?: AppState['networkHold']
  budget?: AppState['budget']
  usageTotals?: AppState['usageTotals']
  outputs?: AppState['outputs']
  toolHistory?: AppState['toolHistory']
  compactArchives?: AppState['compactArchives']
  effort?: AppState['effort']
  promptSnapshot?: AppState['promptSnapshot']
}

/**
 * What a running turn adds to a save: its user message and an assistant entry marked interrupted
 * (for `messages`), and the turn's wire so far with every call answered and a note that the turn
 * is incomplete (for `contextMessages`). Every save while the turn runs includes it, whoever makes
 * the save, so a process killed mid-turn (SIGKILL, a crash, an out-of-memory kill) loses at most
 * the request in flight. The turn's own end, finished or interrupted, replaces it.
 */
export interface PendingTurn { messages: Message[]; contextMessages: Message[] }
const pendingTurns = new Map<string, () => PendingTurn | undefined>()

/** Registers the running turn of a session (see PendingTurn); the returned function removes it. */
export function trackPendingTurn(sessionId: string, pending: () => PendingTurn | undefined): () => void {
  pendingTurns.set(sessionId, pending)
  return () => { if (pendingTurns.get(sessionId) === pending) pendingTurns.delete(sessionId) }
}

/**
 * The text a stored message keeps next to its wire blocks: the reply text and a word for each
 * tool call, result and image. Every reader uses the wire; a full JSON copy of the blocks here
 * stored each tool input, result and image twice.
 */
export function wirePreview(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return headUnits(content.map(block => block.type === 'text' ? block.text
    : block.type === 'tool_use' ? `[tool call ${block.name}]`
    : block.type === 'tool_result' ? `[tool result${block.is_error ? ', error' : ''}]`
    : block.type === 'image' ? '[image]' : '').filter(Boolean).join('\n'), 2000)
}

/** A message saved by an older version keeps a JSON copy of its wire blocks as content: drop it. */
function withoutWireCopy(message: Message): Message {
  return message?.wire && Array.isArray(message.wire.content) && typeof message.content === 'string' && message.content.startsWith('[')
    ? { ...message, content: wirePreview(message.wire.content) } : message
}

/** The fields a session file was last written from, by path: a save with nothing new writes nothing. */
const lastWritten = new Map<string, readonly unknown[]>()
const savedFields = (state: Readonly<AppState>): readonly unknown[] => [state.messages, state.sessionContext, state.permissionContext,
  state.networkHold, state.budget, state.usageTotals, state.contextMessages, state.contextStatus, state.outputs, state.toolHistory, state.compactArchives, state.effort, state.promptSnapshot, state.contextCalibration]

/** `force`: write even when nothing changed since this process last wrote the file (the final save at exit). */
export function saveSession(state: Readonly<AppState>, options: { force?: boolean } = {}): void {
  if (!validSessionId(state.sessionId)) throw new Error('Invalid session ID')
  const path = getSessionPath(state.cwd, state.sessionId)
  // Another process owns the session, or took it over from this one: writing would replace its turns with this copy.
  assertSessionOwner(state.cwd, state.sessionId)
  const pending = pendingTurns.get(state.sessionId)?.()
  const fields = savedFields(state)
  // The store replaces what changes (never edits it in place): the same objects are the same data.
  // A running turn always writes, its progress is not in the store.
  const previous = lastWritten.get(path)
  if (!pending && !options.force && previous?.every((value, index) => value === fields[index]) && existsSync(path)) return
  const dir = getSessionDir(state.cwd)

  const data: SessionData = {
    sessionId: state.sessionId,
    cwd: state.cwd,
    messages: pending ? [...state.messages, ...pending.messages] : state.messages as Message[],
    sessionContext: state.sessionContext,
    permissionContext: state.permissionContext as ToolPermissionContext,
    savedAt: Date.now(),
    networkHold: state.networkHold,
    budget: state.budget,
    usageTotals: state.usageTotals,
    contextMessages: pending ? pending.contextMessages : state.contextMessages, contextStatus: state.contextStatus, contextCalibration: tokenCalibration(state.contextCalibration), outputs: state.outputs, toolHistory: state.toolHistory, compactArchives: state.compactArchives, effort: state.effort,
    promptSnapshot: state.promptSnapshot,
  }

  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Compact JSON: the file is rewritten whole on each save, and indentation only adds bytes.
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
    throw new SessionSaveError(dir, error)
  }
  sessionWrites++
  if (pending) lastWritten.delete(path)
  else lastWritten.set(path, fields)
}

/** A session file that cannot be written, and what to do about it. The turn stops: one that cannot be recorded must not run tools. */
export class SessionSaveError extends Error {
  readonly code?: string
  constructor(folder: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code
    const reason = code === 'ENOSPC' || code === 'EDQUOT' ? `the disk is full: ${folder}. Free some space`
      : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? `this folder cannot be written: ${folder}. Check its permissions`
      : `${cause instanceof Error ? cause.message : String(cause)}. Check the folder ${folder}`
    super(`G-Code could not save this session because ${reason}, then send the message again. What was saved before stays as it was.`)
    this.name = 'SessionSaveError'
    this.code = code
  }
}

let sessionWrites = 0
/** How many session files this process has written: what its saves cost. */
export function sessionWriteCount(): number { return sessionWrites }

// ============================================================================
// Session Ownership
// ============================================================================

/**
 * The process that has a session open. One process at a time may own a session: each keeps the
 * whole session in memory and saves all of it, so a second one would silently replace the first
 * one's turns, usage, output versions and session memory.
 */
export interface SessionLockOwner { pid: number; hostname: string; startedAt: number; token?: string }

export class SessionLockedError extends Error {
  /** `lost`: this process owned the session until another one took it over (see assertSessionOwner). */
  constructor(readonly sessionId: string, readonly owner: SessionLockOwner | null, readonly lost = false) {
    super(lost
      ? `Session ${sessionId} was taken over by another G-Code process while this one was paused, so this process no longer saves it. Resume the session to continue from its last save.`
      : `Session ${sessionId} is open in another G-Code process${owner ? ` (pid ${owner.pid})` : ''}. Close it there first, or start a new chat.`)
    this.name = 'SessionLockedError'
  }
}

/** An owner refreshes its lock this often; a lock not refreshed for LOCK_STALE_MS is stale unless its pid is still the process that took it. */
const LOCK_REFRESH_MS = 30_000
const LOCK_STALE_MS = 5 * 60_000
/** A lock file just created may still be empty while its owner writes it. */
const LOCK_WRITE_GRACE_MS = 10_000
/** `lost`: another process took the lock over (see assertSessionOwner). */
const heldLocks = new Map<string, { token: string; timer: ReturnType<typeof setInterval>; lost?: boolean; onLost?: (error: SessionLockedError) => void }>()
let exitHook = false

function getLockPath(cwd: string, sessionId: string): string {
  return join(getSessionDir(cwd), `${sessionId}.lock`)
}

/** A lock file's owner; `{ pid: 0 }` when the text cannot be read as one. */
function parseLock(raw: string): SessionLockOwner {
  try {
    const owner = JSON.parse(raw) as SessionLockOwner
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && typeof owner.hostname === 'string') return owner
  } catch { /* Not a lock this version wrote, or one still being written. */ }
  return { pid: 0, hostname: '', startedAt: 0 }
}

/** The lock's owner; null when there is no lock; `{ pid: 0 }` when the file cannot be read as one. */
function readLock(path: string): SessionLockOwner | null {
  try { return parseLock(readFileSync(path, 'utf8')) } catch { return null }
}

/** Whether a lock this process took with `token` is gone or replaced; false when the file cannot be read for another reason. */
function lockLost(path: string, token: string): boolean {
  try { return parseLock(readFileSync(path, 'utf8')).token !== token } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}

/** The lock file as it is now: its owner, and `state` (inode, mtime and bytes), which changes whenever the file is replaced or refreshed. */
function lockSnapshot(path: string): { owner: SessionLockOwner; state: string } | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const stat = statSync(path)
    return { owner: parseLock(raw), state: `${stat.ino}:${stat.mtimeMs}:${raw}` }
  } catch { return null }
}

/**
 * Whether the process with `pid` started after `time`, so it is not the one that took a lock then
 * (its pid was reused). Also true when that cannot be told (no `ps`): a lock not refreshed for
 * LOCK_STALE_MS is then stale, as before.
 */
function startedAfter(pid: number, time: number): boolean {
  const elapsed = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(spawnSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).stdout ?? '')
  if (!elapsed) return true
  const [days, hours, minutes, seconds] = elapsed.slice(1).map(part => Number(part ?? 0))
  // `ps` counts whole seconds.
  return Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000 > time + 1500
}

/**
 * Whether the lock's owner may still be running: its pid exists on this host, and it refreshed the
 * lock recently or is still the process that took it. A stopped owner (Ctrl-Z, a debugger) refreshes
 * nothing, yet it still has the session in memory and saves it once it goes on.
 */
function liveLock(owner: SessionLockOwner, path: string): boolean {
  let age: number
  try { age = Date.now() - statSync(path).mtimeMs } catch { return false }
  if (owner.pid === 0) return age < LOCK_WRITE_GRACE_MS
  // The pid is checked on this machine even when the host name differs (a laptop's changes with its network).
  if (owner.pid === process.pid) return false
  try { process.kill(owner.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false }
  return age <= LOCK_STALE_MS || !startedAfter(owner.pid, owner.startedAt)
}

/**
 * Throws SessionLockedError when this process may not write the session: another live process
 * owns it, or this process owned it and lost it. A held lock is lost when its file is gone or holds
 * another token: another process took it over (this one was stopped and its owner could not be
 * told apart from a reused pid), and may have saved turns since and released it. This process's
 * copy is stale either way, and stays refused.
 */
export function assertSessionOwner(cwd: string, sessionId: string): void {
  const path = getLockPath(cwd, sessionId)
  const held = heldLocks.get(path)
  if (held && !held.lost && !lockLost(path, held.token)) return
  const owner = readLock(path)
  if (held) {
    throw loseLock(path, sessionId)
  }
  if (owner && liveLock(owner, path)) throw new SessionLockedError(sessionId, owner.pid ? owner : null)
}

/** Loss is sticky and reported once, including when a refresh finds it before any save. */
function loseLock(path: string, sessionId: string): SessionLockedError {
  const held = heldLocks.get(path)
  const owner = readLock(path)
  const error = new SessionLockedError(sessionId, owner?.pid ? owner : null, true)
  if (held && !held.lost) {
    held.lost = true
    clearInterval(held.timer)
    try { held.onLost?.(error) } catch { /* A listener cannot re-enable writes or crash a timer. */ }
  }
  return error
}

function releaseLock(path: string): void {
  const held = heldLocks.get(path)
  if (!held) return
  clearInterval(held.timer)
  heldLocks.delete(path)
  // Only this process's own lock: never one another process took over.
  try { if (readLock(path)?.token === held.token) unlinkSync(path) } catch { /* Already gone. */ }
}

/** Waits `ms` without returning to the event loop (a lock is taken synchronously). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Removes a stale lock unless it changed since it was judged stale (`judged`, its lockSnapshot
 * state then). Only the holder of `<lock>.takeover`, created exclusively, removes anything: two
 * contenders that judged the same lock stale must not remove the lock one of them wrote since.
 */
function removeStaleLock(path: string, judged: string): void {
  const guard = `${path}.takeover`
  try { writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return
    // Another contender is taking over right now; a guard left by one that died goes after the grace period.
    try { if (Date.now() - statSync(guard).mtimeMs > LOCK_WRITE_GRACE_MS) unlinkSync(guard) } catch { /* Gone already. */ }
    pause(25)
    return
  }
  try { if (lockSnapshot(path)?.state === judged) unlinkSync(path) } catch { /* Another process removed it first. */ }
  finally { try { unlinkSync(guard) } catch { /* Removed as stale by another contender. */ } }
}

/**
 * Makes this process the session's owner (see SessionLockOwner): `<sessionId>.lock` next to its
 * history, holding the pid. Throws SessionLockedError while another live process owns it; a lock
 * whose process is gone is taken over. Best effort otherwise: when the folder cannot be written,
 * no lock is taken (the session's own save then reports the problem). Returns the release.
 */
export function acquireSessionLock(cwd: string, sessionId: string, options: { onLost?: (error: SessionLockedError) => void } = {}): () => void {
  if (!validSessionId(sessionId)) throw new Error('Invalid session ID')
  const path = getLockPath(cwd, sessionId)
  if (heldLocks.has(path)) return () => {}
  const token = randomUUID()
  const owner: SessionLockOwner = { pid: process.pid, hostname: hostname(), startedAt: Date.now(), token }
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) } catch { return () => {} }
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return () => {}
      const current = lockSnapshot(path)
      if (current && liveLock(current.owner, path)) throw new SessionLockedError(sessionId, current.owner.pid ? current.owner : null)
      if (attempt >= 4) throw new SessionLockedError(sessionId, current?.owner.pid ? current.owner : null)
      if (current) removeStaleLock(path, current.state)
    }
  }
  // A last check that the lock there is this one.
  const written = readLock(path)
  if (written?.token !== token) throw new SessionLockedError(sessionId, written?.pid ? written : null)
  const timer = setInterval(() => {
    const held = heldLocks.get(path)
    // Taken over while paused: tell the UI now, without waiting for another save.
    if (!held || held.lost || lockLost(path, held.token)) { if (held) loseLock(path, sessionId); clearInterval(timer); return }
    try { const now = new Date(); utimesSync(path, now, now) } catch { /* Removed. */ }
  }, LOCK_REFRESH_MS)
  timer.unref?.()
  heldLocks.set(path, { token, timer, onLost: options.onLost })
  if (!exitHook) {
    exitHook = true
    process.on('exit', () => { for (const held of [...heldLocks.keys()]) releaseLock(held) })
  }
  return () => releaseLock(path)
}

/** Whether a process (this one included) has the session of this id open in the project store `directory`. */
export function sessionInUse(directory: string, sessionId: string): boolean {
  const path = join(directory, `${sessionId}.lock`)
  if (heldLocks.has(path)) return true
  const owner = readLock(path)
  return !!owner && liveLock(owner, path)
}

/** Removes the lock of a session whose process is gone, on the takeover guard's terms (see removeStaleLock). */
export function removeDeadLock(directory: string, sessionId: string): void {
  const path = join(directory, `${sessionId}.lock`)
  const current = lockSnapshot(path)
  if (current && !heldLocks.has(path) && !liveLock(current.owner, path)) removeStaleLock(path, current.state)
}

export function loadSession(cwd: string, sessionId: string): SessionData | null {
  if (!validSessionId(sessionId)) return null
  return readBoundSession(getSessionPath(cwd, sessionId), cwd, sessionId)
    ?? readBoundSession(join(getLegacySessionDir(cwd), `${sessionId}.json`), cwd, sessionId)
}

/**
 * List all sessions for a given cwd, sorted by most recent first. `onUnreadable` hears how many
 * session files of this project could not be read (a disk fault, a hand edit): they are left out,
 * and left as they are.
 */
export function listSessions(cwd: string, onUnreadable?: (count: number) => void): SessionData[] {
  const sessions = new Map<string, SessionData>()
  let unreadable = 0
  for (const dir of [getLegacySessionDir(cwd), getSessionDir(cwd)]) {
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const data = readBoundSession(join(dir, file), cwd)
        if (data) sessions.set(data.sessionId, data)
        // A legacy folder can hold another project's sessions; those read well.
        else if (!readsAsOtherProject(join(dir, file), cwd)) unreadable++
      }
    } catch { /* Missing or inaccessible directory. */ }
  }
  if (unreadable) onUnreadable?.(unreadable)
  return [...sessions.values()].sort((a, b) => b.savedAt - a.savedAt)
}

/** Whether a session file is well formed and bound to another project. */
function readsAsOtherProject(path: string, cwd: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SessionData | null
    return !!data && typeof data.cwd === 'string' && resolve(data.cwd) !== resolve(cwd)
  } catch { return false }
}

/**
 * Get the most recent session for a cwd.
 */
export function getLatestSession(cwd: string, onUnreadable?: (count: number) => void): SessionData | null {
  const sessions = listSessions(cwd, onUnreadable)
  return sessions[0] ?? null
}

/** What a process can say when session `sessionId` cannot be loaded for `cwd`: why, where that can be told. */
export function sessionNotLoadedMessage(cwd: string, sessionId: string): string {
  const fallback = `Requested session ${sessionId} was not found or is invalid for this project. Start a new chat explicitly.`
  if (!validSessionId(sessionId)) return fallback
  const shown = (path: string) => JSON.stringify(path).slice(1, -1)
  for (const dir of [getSessionDir(cwd), getLegacySessionDir(cwd)]) {
    const path = join(dir, `${sessionId}.json`)
    if (existsSync(path) && !readsAsOtherProject(path, cwd)) return `Session ${sessionId} could not be read: its file is damaged or not readable (${shown(path)}). The file was left as it is. Start a new chat explicitly.`
  }
  // A session is bound to the folder it was started in: what hangs off it (Changes, memory, snapshots) is kept by that path.
  const projects = join(getGcodeDir(), 'projects')
  let folders: string[] = []
  try { folders = readdirSync(projects) } catch { return fallback }
  for (const folder of folders) {
    const path = join(projects, folder, `${sessionId}.json`)
    if (!existsSync(path)) continue
    try {
      const saved = (JSON.parse(readFileSync(path, 'utf8')) as SessionData | null)?.cwd
      if (typeof saved === 'string' && saved) return `Session ${sessionId} belongs to the folder ${shown(saved)}, not this one. A chat stays with its folder: run G-Code there to continue it. If that folder was moved, move it back first.`
    } catch { /* Damaged: said below. */ }
    return `Session ${sessionId} belongs to another folder and its file could not be read (${shown(path)}). The file was left as it is. Start a new chat explicitly.`
  }
  return fallback
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const optionalRecords = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.every(isRecord))

/**
 * The first field of a session file that a session cannot be opened with: a valid save never writes
 * one (a hand edit or a disk fault did). Only what opening or the first turn depends on: older files
 * lack fields, and a file that works is not refused for a field nothing reads as this one.
 */
function damagedField(session: SessionData): string | undefined {
  for (const field of ['contextMessages', 'toolHistory', 'compactArchives'] as const) if (!optionalRecords(session[field])) return field
  const rules = session.permissionContext as unknown as Record<string, unknown>
  if (!isRecord(rules) || ['alwaysAllowRules', 'alwaysDenyRules', 'alwaysAskRules'].some(name => !Array.isArray(rules[name]))) return 'permissionContext'
}

/** Whether saved totals can be added to; other totals read like those of a session from before usage was recorded. */
const usableUsage = (usage: unknown): usage is AppState['usageTotals'] => isRecord(usage) && Array.isArray(usage.byModel) && usage.byModel.every(isRecord)

/**
 * Restore an AppState store from a saved session.
 */
export function restoreSession(session: SessionData): Store<AppState> {
  const damaged = damagedField(session)
  if (damaged) throw new Error(`Session ${session.sessionId} could not be opened: its file is damaged (the field "${damaged}"). The file was left as it is. Start a new chat explicitly.`)
  // A call still running when its process ended never settles by itself.
  const toolHistory = session.toolHistory?.map(tool => terminalTool(tool.state) ? tool
    : { ...tool, state: 'cancelled' as const, error: 'Previous process ended before this call settled', completedAt: session.savedAt })
  const state: AppState = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    messages: session.messages,
    networkHold: session.networkHold,
    budget: session.budget,
    usageTotals: usableUsage(session.usageTotals) ? session.usageTotals : undefined,
    contextMessages: session.contextMessages?.map(withoutWireCopy), contextStatus: session.contextStatus, contextCalibration: tokenCalibration(session.contextCalibration), outputs: session.outputs, toolHistory,
    compactArchives: session.compactArchives?.map(archive => ({ ...archive, messages: Array.isArray(archive.messages) ? archive.messages.map(withoutWireCopy) : archive.messages })), effort: session.effort,
    // Only a well-formed snapshot; anything else is rebuilt from the memory files.
    promptSnapshot: typeof session.promptSnapshot?.cwd === 'string' && typeof session.promptSnapshot.memory === 'string' && typeof session.promptSnapshot.permissionMode === 'string'
      ? { cwd: session.promptSnapshot.cwd, memory: session.promptSnapshot.memory, permissionMode: session.promptSnapshot.permissionMode,
          ...(typeof session.promptSnapshot.nodeEnvironment === 'string' && session.promptSnapshot.nodeEnvironment.length <= 4096 ? { nodeEnvironment: session.promptSnapshot.nodeEnvironment } : {}),
          ...(typeof session.promptSnapshot.learned === 'string' && session.promptSnapshot.learned.length <= 16_384 ? { learned: session.promptSnapshot.learned } : {}),
          ...(typeof session.promptSnapshot.system === 'string' && session.promptSnapshot.system.length <= 2_000_000 && typeof session.promptSnapshot.local === 'boolean'
            && Array.isArray(session.promptSnapshot.tools) && session.promptSnapshot.tools.length <= 1024
            && session.promptSnapshot.tools.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string' && tool.input_schema && typeof tool.input_schema === 'object' && !Array.isArray(tool.input_schema))
            && new Set(session.promptSnapshot.tools.map(tool => tool.name)).size === session.promptSnapshot.tools.length
            ? { system: session.promptSnapshot.system, tools: session.promptSnapshot.tools, local: session.promptSnapshot.local } : {}) } : undefined,
    permissionContext: session.permissionContext,
    sessionContext: session.sessionContext,
  }
  return createStore(state)
}
