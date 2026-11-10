/**
 * @file leftovers.ts
 * @brief What a session's start does for the project's personal store, in the background.
 *
 * Removes what earlier processes of G-Code left behind: a temporary file a kill cut off, the lock of
 * a process that is gone, the record of a chat in which nothing was ever said. Only by the exact name
 * G-Code gives each of them, only when older than a day, and never what belongs to a session some
 * process has open. Conversations, snapshots and saved outputs are not touched.
 *
 * Also takes group and other access off the store's folders and files where an older version left it
 * (an owner's own bits stay as they are), and adds up the snapshots for the size notice.
 */

import { chmod, lstat, readFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getProjectDirectory, removeDeadLock, sessionInUse } from '../state/store.js'
import { KEPT_VERSIONS } from '../shared/sessionControls.js'

/** Temporary files live for milliseconds and a lock is refreshed every 30 s: a day is far past either. */
const LEFTOVER_AGE_MS = 24 * 60 * 60_000
/** A chat in which nothing was said is a small file: larger ones are not even read. */
const EMPTY_RECORD_BYTES = 64 * 1024
/** From this much on, a start says how much the snapshots take. */
export const SNAPSHOT_NOTICE_BYTES = 1024 * 1024 * 1024

const ID = '[A-Za-z0-9_-]{1,128}'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_TEMP = new RegExp(`^(${ID})\\.json\\.${UUID}\\.tmp$`)
const MEMORY_TEMP = new RegExp(`^(${ID})\\.json\\.\\d+\\.\\d+\\.tmp$`)
const PATTERNS_TEMP = /^patterns\.json\.\d+\.\d+\.tmp$/
const JOURNAL_TEMP = new RegExp(`^writes\\.jsonl\\.${UUID}\\.tmp$`)
const SNAPSHOT_TEMP = new RegExp(`^[0-9a-f]{64}\\.(?:snap|png|jpg)\\.${UUID}\\.tmp$`)
const TASKS_TEMP = new RegExp(`^background-tasks\\.jsonl\\.${UUID}\\.tmp$`)
const TEAM_TEMP = new RegExp(`^(?:\\.gcode-write-${UUID}\\.tmp|.+\\.json\\.\\d+\\.\\d+\\.tmp)$`)
const LOCK = new RegExp(`^(${ID})\\.lock$`)
const GUARD = new RegExp(`^${ID}\\.lock\\.takeover$`)
const RECORD = new RegExp(`^(${ID})\\.json$`)
const SESSION_FOLDER = new RegExp(`^${ID}$`)
/** A session's snapshot folder is named by a hash of its id. */
const SNAPSHOT_FOLDER = /^[0-9a-f]{64}$/
const OWN_FOLDERS = new Set(['outputs', 'session-memory', 'tool-output', 'learned'])

const entries = async (folder: string) => { try { return await readdir(folder) } catch { return [] as string[] } }
const entry = async (path: string) => { try { return await lstat(path) } catch { return undefined } }

/** Takes group and other access off a real folder or file of the store; a link or another owner's entry stays. */
async function makePrivate(path: string, info: { mode: number; isSymbolicLink(): boolean }): Promise<void> {
  if (info.isSymbolicLink() || !(info.mode & 0o077)) return
  try { await chmod(path, info.mode & 0o700) } catch { /* Not this user's. */ }
}

/** A session record in which nothing happened: nothing was said, charged, changed or set aside. */
function emptyRecord(text: string): boolean {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    const none = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0)
    const usage = data.usageTotals as { requests?: unknown; byModel?: unknown } | undefined
    return Array.isArray(data.messages) && data.messages.length === 0
      && ['contextMessages', 'outputs', 'toolHistory', 'compactArchives'].every(field => none(data[field]))
      && none(data.budget) && none(data.networkHold)
      && (!usage || (usage.requests === 0 && none(usage.byModel)))
  } catch { return false }
}

/** Removes a regular file that has been there longer than LEFTOVER_AGE_MS. */
async function removeOld(path: string, now: number): Promise<void> {
  const info = await entry(path)
  if (!info?.isFile() || now - info.mtimeMs <= LEFTOVER_AGE_MS) return
  try { await unlink(path) } catch { /* Gone already, or not this user's. */ }
}

/** A process with this pid may still be about to rename its temporary file. */
function running(name: string): boolean {
  const pid = Number(/\.(\d+)\.\d+\.tmp$/.exec(name)?.[1])
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** See the file comment. Best effort: nothing here can fail a start. Returns what the snapshots take. */
export async function tidySessionStore(cwd: string, now = Date.now()): Promise<{ snapshotBytes: number; snapshotFolder: string }> {
  const store = getProjectDirectory(cwd)
  const snapshotFolder = join(store, 'outputs')
  let snapshotBytes = 0
  try {
    for (const folder of [join(homedir(), '.gcode'), dirname(store), store]) {
      const info = await entry(folder)
      if (info?.isDirectory()) await makePrivate(folder, info)
    }
    for (const name of await entries(store)) {
      const path = join(store, name)
      const info = await entry(path)
      if (!info || info.isSymbolicLink()) continue
      await makePrivate(path, info)
      if (info.isDirectory()) {
        if (OWN_FOLDERS.has(name) || SESSION_FOLDER.test(name)) snapshotBytes += await tidyFolder(store, path, name, now)
        continue
      }
      if (!info.isFile()) continue
      const temporary = SESSION_TEMP.exec(name)?.[1]
      const lock = LOCK.exec(name)?.[1]
      const record = RECORD.exec(name)?.[1]
      if (temporary) { if (!sessionInUse(store, temporary)) await removeOld(path, now) }
      else if (GUARD.test(name)) await removeOld(path, now)
      else if (lock) { if (now - info.mtimeMs > LEFTOVER_AGE_MS) removeDeadLock(store, lock) }
      else if (record && info.size <= EMPTY_RECORD_BYTES && now - info.mtimeMs > LEFTOVER_AGE_MS && !sessionInUse(store, record)) {
        try { if (emptyRecord(await readFile(path, 'utf8'))) { await unlink(path); removeDeadLock(store, record) } } catch { /* Left as it is. */ }
      }
    }
    await tidyProjectFolders(store, cwd, now)
  } catch { /* A later start tries again. */ }
  return { snapshotBytes, snapshotFolder }
}

/** One folder of the store. Returns the bytes of its snapshots (in `outputs`). */
async function tidyFolder(store: string, folder: string, name: string, now: number): Promise<number> {
  let bytes = 0
  for (const file of await entries(folder)) {
    const path = join(folder, file)
    const info = await entry(path)
    if (!info || info.isSymbolicLink()) continue
    await makePrivate(path, info)
    if (info.isDirectory()) {
      if (name === 'outputs' && SNAPSHOT_FOLDER.test(file)) for (const snapshot of await entries(path)) {
        const inner = join(path, snapshot)
        const held = await entry(inner)
        if (!held?.isFile()) continue
        await makePrivate(inner, held)
        if (SNAPSHOT_TEMP.test(snapshot)) await removeOld(inner, now)
        else bytes += held.size
      }
      continue
    }
    if (!info.isFile()) continue
    if (name === 'session-memory') {
      const owner = MEMORY_TEMP.exec(file)?.[1]
      if (owner && !sessionInUse(store, owner) && !running(file)) await removeOld(path, now)
    } else if (name === 'learned') {
      if (PATTERNS_TEMP.test(file) && !running(file)) await removeOld(path, now)
    } else if (name === 'outputs') {
      if (JOURNAL_TEMP.test(file)) await removeOld(path, now)
    } else if (name !== 'tool-output' && TASKS_TEMP.test(file) && !sessionInUse(store, name)) await removeOld(path, now)
  }
  return bytes
}

/** Temporary files in the project's own .gcode folders (one is meant to be committed). A link there is not followed. */
async function tidyProjectFolders(store: string, cwd: string, now: number): Promise<void> {
  const gcode = join(cwd, '.gcode')
  if (!(await entry(gcode))?.isDirectory()) return
  const todos = join(gcode, 'todos')
  if ((await entry(todos))?.isDirectory()) for (const file of await entries(todos)) {
    const owner = SESSION_TEMP.exec(file)?.[1]
    if (owner && !sessionInUse(store, owner)) await removeOld(join(todos, file), now)
  }
  const team = join(gcode, 'team-memory')
  if ((await entry(team))?.isDirectory()) for (const file of await entries(team)) {
    if (TEAM_TEMP.test(file) && !running(file)) await removeOld(join(team, file), now)
  }
}

const gibibytes = (bytes: number) => `${(bytes / SNAPSHOT_NOTICE_BYTES).toFixed(1)} GB`

/** What a start says when the project's snapshots have grown large; undefined below SNAPSHOT_NOTICE_BYTES. */
export function snapshotNotice({ snapshotBytes, snapshotFolder }: { snapshotBytes: number; snapshotFolder: string }): string | undefined {
  if (snapshotBytes < SNAPSHOT_NOTICE_BYTES) return undefined
  return `The Changes view's snapshots for this project take ${gibibytes(snapshotBytes)} in ${snapshotFolder}. G-Code keeps each file's copy from before the chat and its last ${KEPT_VERSIONS} versions, and deleting a chat removes that chat's. To free more, delete chats you no longer need, or close G-Code and delete that folder: earlier versions in this project's chats then read as unavailable, and everything else keeps working.`
}

/** tidySessionStore at a session's start, with its notice for `tell`. It runs on its own: whatever goes wrong here, a rejection must not end the process. */
export function tidyInBackground(cwd: string, tell: (notice: string) => void): Promise<void> {
  return tidySessionStore(cwd).then(found => { const notice = snapshotNotice(found); if (notice) tell(notice) }).catch(() => { /* A later start tries again. */ })
}
