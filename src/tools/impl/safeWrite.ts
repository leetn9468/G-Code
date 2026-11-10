/**
 * @file safeWrite.ts
 * @brief Replacing a file's content so that a failed write never costs what was there.
 *
 * writeFileSync truncates first: on a full disk the old bytes are gone before the first new one lands.
 * Here the new bytes go to a temporary file next to the real target (a symbolic link is followed and
 * stays a link), which takes the old file's mode and owner and then replaces it by a rename. A file
 * that a rename would change for someone else keeps its inode instead, and is overwritten with a copy
 * of its old bytes set aside first: one with other names (a hard link), one whose owner this user
 * cannot give the new file, one in a folder this user cannot add to, one with extended attributes or
 * an access list. Sessions of one user also take a short lock per file (see withWriteLock).
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realTarget } from '../../session/scopedPermission.js'

const code = (error: unknown) => (error as NodeJS.ErrnoException).code
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** The same error, with what became of the file added to what the model reads. */
const noted = (error: unknown, note: string) => Object.assign(new Error(`${message(error)}. ${note}`), { code: code(error) })

function writeAll(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset)
}

/** A file system without fsync still takes the write. */
function flush(fd: number): void {
  try { fs.fsyncSync(fd) } catch (error) { if (!['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(code(error) ?? '')) throw error }
}

/** macOS adds this one to every file an app writes; nobody set it and a new file gets its own. */
const OWN_ATTRIBUTE = 'com.apple.provenance'

/**
 * macOS: extended attributes (Finder tags, for one) or an access list, which a rename would drop. No
 * system call for them is within reach, so `ls` says; when it cannot, the file counts as having none.
 */
function extraMetadata(target: string): boolean {
  if (process.platform !== 'darwin') return false
  try {
    // After the file's own line, one line per attribute and per access rule.
    const listing = spawnSync('/bin/ls', ['-lde@', '--', target], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    return (listing.stdout ?? '').split('\n').slice(1).some(line => { const name = line.trim().split(/\s+/)[0]; return !!name && name !== OWN_ATTRIBUTE })
  } catch { return false }
}

/** Writes through a temporary file and a rename. False when this file has to keep its inode; nothing has changed then. */
function replaceByRename(target: string, bytes: Buffer, before: fs.Stats | undefined): boolean {
  const temporary = join(dirname(target), `.gcode-write-${randomUUID()}.tmp`)
  let fd: number
  try { fd = fs.openSync(temporary, 'wx', before ? before.mode & 0o777 : 0o666) }
  catch (error) {
    // A folder this user cannot add to can hold a file they can write.
    if (before && ['EACCES', 'EPERM'].includes(code(error) ?? '')) return false
    throw Object.assign(new Error(message(error).replaceAll(temporary, target)), { code: code(error) })
  }
  const discard = () => { try { fs.rmSync(temporary, { force: true }) } catch { /* Gone or unreachable. */ } }
  try {
    try {
      writeAll(fd, bytes)
      flush(fd)
      if (before) {
        const made = fs.fstatSync(fd)
        if (made.uid !== before.uid || made.gid !== before.gid) {
          try { fs.fchownSync(fd, before.uid, before.gid) } catch { discard(); return false }
        }
        fs.fchmodSync(fd, before.mode & 0o7777)
      }
    } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, target)
    return true
  } catch (error) {
    discard()
    // Not allowed to replace the name (a sticky folder), or the name cannot be replaced (a file mounted on its own), but the file can be written.
    if (before && ['EACCES', 'EPERM', 'EBUSY', 'EXDEV'].includes(code(error) ?? '')) return false
    throw noted(error, before ? 'The file was not changed.' : 'The file was not created.')
  }
}

/** The old bytes on disk, next to the file or else in the temporary folder, for as long as the overwrite takes. */
function setAside(target: string, old: Buffer): string {
  const name = `.gcode-write-${randomUUID()}.keep`
  let failure: unknown
  for (const folder of [dirname(target), tmpdir()]) {
    const copy = join(folder, name)
    try { fs.writeFileSync(copy, old, { flag: 'wx', mode: 0o600 }); return copy }
    catch (error) { failure = error; try { fs.rmSync(copy, { force: true }) } catch { /* Nothing there. */ } }
  }
  throw noted(failure, 'No copy of the old content could be kept, so the file was not changed.')
}

/** Overwrites the file's own bytes, for a file that must keep its inode. On a failure its old bytes go back, or stay in the copy, which the error names. */
function overwriteInPlace(target: string, bytes: Buffer): void {
  const old = fs.readFileSync(target)
  const copy = setAside(target, old)
  const forget = () => { try { fs.rmSync(copy, { force: true }) } catch { /* Harmless. */ } }
  let fd: number
  try { fd = fs.openSync(target, 'r+') } catch (error) { forget(); throw error }
  try {
    writeAll(fd, bytes)
    fs.ftruncateSync(fd, bytes.length)
    flush(fd)
  } catch (error) {
    let restored = false
    try { writeAll(fd, old); fs.ftruncateSync(fd, old.length); flush(fd); restored = true } catch { /* The copy stays. */ }
    try { fs.closeSync(fd) } catch { /* Already reported. */ }
    if (!restored) throw noted(error, `The file may be damaged. What it held before is saved at ${copy}.`)
    forget()
    throw noted(error, 'The file was put back as it was.')
  }
  fs.closeSync(fd)
  forget()
}

/**
 * Replaces the content of `path` (absolute), or creates it. Returns how many other names the file has
 * (hard links), which all see the change. Throws with the file as it was, or with a message that says
 * what became of it. Anything but a regular file is refused.
 */
export function safeWriteFile(path: string, data: string | Buffer): { otherNames: number } {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const target = realTarget(path)
  // realTarget gives up on a loop of links; the stat names the error (ELOOP).
  if (!target) { fs.statSync(path); throw new Error(`Cannot resolve ${path}`) }
  let before: fs.Stats | undefined
  try { before = fs.statSync(target) } catch (error) { if (code(error) !== 'ENOENT') throw error }
  if (before?.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' })
  if (before && !before.isFile()) throw new Error(`"${path}" is not a regular file (a named pipe or a device): nothing was written to it.`)
  // A rename would replace a read-only file without a word.
  if (before) fs.accessSync(target, fs.constants.W_OK)
  const keepInode = before && (before.nlink > 1 || extraMetadata(target))
  if (keepInode || !replaceByRename(target, bytes, before)) overwriteInPlace(target, bytes)
  return { otherNames: before ? before.nlink - 1 : 0 }
}

/** What the model reads when a write reached other names of the file too; undefined when it has none. */
export function otherNamesNote(otherNames: number): string | undefined {
  if (otherNames <= 0) return undefined
  return `This file has ${otherNames} other name${otherNames === 1 ? '' : 's'} (hard link${otherNames === 1 ? '' : 's'}), possibly outside the project: ${otherNames === 1 ? 'it shows' : 'they show'} this change too.`
}

/** How long a writer waits for another session's write of the same file. */
const LOCK_WAIT_MS = 5_000
/** Writes hold a lock for milliseconds: one this old was left behind, whoever holds its pid now. */
const LOCK_STALE_MS = 30_000

function staleLock(file: string): boolean {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) return true
    const pid = Number(fs.readFileSync(file, 'utf8'))
    if (!pid) return false
    try { process.kill(pid, 0); return false } catch (error) { return code(error) === 'ESRCH' }
  } catch { return false }
}

/**
 * Runs `run` (synchronous: from the staleness check to the rename) while holding this file's lock in
 * ~/.gcode/locks, so that sessions writing one file take turns and each sees what the last one wrote.
 * Other programs do not take it. Where the folder cannot be written it runs without the lock.
 */
export async function withWriteLock<T>(path: string, run: () => T): Promise<T> {
  const folder = join(homedir(), '.gcode', 'locks')
  const file = join(folder, `${createHash('sha256').update(realTarget(path) ?? path).digest('hex')}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
      break
    } catch (error) {
      if (code(error) === 'ENOENT') {
        try { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); continue } catch { return run() }
      }
      if (code(error) !== 'EEXIST') return run()
    }
    // One that cannot be removed counts as held: this loop must end.
    if (staleLock(file)) { try { fs.rmSync(file, { force: true }); continue } catch { /* The wait below decides. */ } }
    if (Date.now() > deadline) throw new Error('Another G-Code session has been writing this file for over 5 seconds, so nothing was changed. Try again.')
    await new Promise(resolve => setTimeout(resolve, 3 + Math.random() * 12))
  }
  try { return run() } finally { try { fs.rmSync(file, { force: true }) } catch { /* A later writer treats it as stale. */ } }
}
