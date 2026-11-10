import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isProjectPath, pathTarget } from '../../session/scopedPermission.js'
import { generatedFolder } from '../../session/outputs.js'
import { safeWriteFile } from './safeWrite.js'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const current = (path: string) => existsSync(path) ? digest(readFileSync(path)) : null

/** A transfer untouched this long is finished or abandoned: its folder is removed when a new transfer starts. */
const TRANSFER_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface WriteChunk { transfer_id: string; index: number; total: number; sha256?: string }
export function writeChunk(path: string, content: string, chunk: WriteChunk, cwd: string, sessionId: string): { complete: boolean; bytes: number; received: number; sha256?: string; otherNames?: number } {
  // By where it really lands: a link in the project to a file not created yet is inside it too.
  const target = pathTarget(path, cwd)
  if (!target.inside || target.secret) throw new Error('Chunked writes must stay inside the project')
  if (Buffer.byteLength(content) > 8192) throw new Error('Each FileWrite chunk must be at most 8 KiB; send complete JSON for each chunk')
  // generatedFolder gives .gcode/transfers its ignore file before anything is staged in it.
  const transfers = generatedFolder(cwd, 'transfers')
  const directory = join(transfers, digest(sessionId), chunk.transfer_id)
  if (!isProjectPath(directory, cwd)) throw new Error('Transfer folder escapes the project')
  mkdirSync(directory, { recursive: true })
  const manifest = join(realpathSync(directory), 'manifest.json')
  let state: { path: string; total: number; base: string | null; chunks: string[]; expected?: string; complete?: string }
  if (existsSync(manifest)) state = JSON.parse(readFileSync(manifest, 'utf8'))
  else {
    if (chunk.index !== 0) throw new Error('Start a new transfer at chunk index 0')
    sweepTransfers(transfers, directory)
    state = { path, total: chunk.total, base: current(path), chunks: [], expected: chunk.sha256 }
    writeFileSync(manifest, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
  }
  if (state.path !== path || state.total !== chunk.total || state.expected !== chunk.sha256) throw new Error('Transfer identity changed; use a new transfer_id')
  const chunkHash = digest(content)
  if (chunk.index < state.chunks.length) {
    if (state.chunks[chunk.index] !== chunkHash) throw new Error('Previously staged chunk changed; use a new transfer_id')
    if (state.complete && current(path) !== state.complete) throw new Error('Completed destination changed; re-read it and use a new transfer_id')
    return { complete: !!state.complete, bytes: state.complete ? Buffer.byteLength(readFileSync(path)) : 0, received: state.chunks.length, sha256: state.complete }
  }
  if (chunk.index !== state.chunks.length || state.complete) throw new Error('Chunks must arrive in order without gaps')
  if (current(path) !== state.base) throw new Error('Destination changed during transfer; re-read it and start a new transfer')
  writeFileSync(join(directory, `${chunk.index}.part`), content, { flag: 'wx', mode: 0o600 })
  state.chunks.push(chunkHash)
  let otherNames = 0
  if (state.chunks.length === state.total) {
    const bytes = Buffer.concat(state.chunks.map((hash, index) => { const data = readFileSync(join(directory, `${index}.part`)); if (digest(data) !== hash) throw new Error('Staged chunk integrity check failed'); return data }))
    const hash = digest(bytes)
    if (state.expected && state.expected !== hash) throw new Error('Complete file SHA-256 differs from the requested hash; destination was not changed')
    if (current(path) !== state.base) throw new Error('Destination changed before commit; staged chunks were retained')
    // Through a symbolic link to its real target, keeping mode, owner and hard links.
    otherNames = safeWriteFile(path, bytes).otherNames
    state.complete = hash
  }
  const pending = manifest + '.next'; writeFileSync(pending, JSON.stringify(state), { mode: 0o600 }); renameSync(pending, manifest)
  // Committed: the staged parts are no longer needed. The small manifest stays for replays of the
  // final chunk, which need only its hashes. Removed after the manifest says complete, so a crash
  // in between leaves extra parts, never a manifest pointing at missing ones.
  if (state.complete) for (let index = 0; index < state.total; index++) rmSync(join(directory, `${index}.part`), { force: true })
  return { complete: !!state.complete, bytes: state.complete ? Buffer.byteLength(readFileSync(path)) : 0, received: state.chunks.length, sha256: state.complete, otherNames }
}

/**
 * Removes transfer folders (`<transfers>/<session>/<transfer>`) not touched for a day: finished
 * ones and ones abandoned midway. Real folders only; a symlink is never followed. Best effort.
 */
function sweepTransfers(transfers: string, keep: string): void {
  const now = Date.now()
  const folders = (directory: string) => { try { return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)) } catch { return [] } }
  for (const session of folders(transfers)) {
    for (const transfer of folders(session)) {
      if (transfer === keep) continue
      try {
        const stat = lstatSync(transfer)
        if (stat.isDirectory() && now - stat.mtimeMs > TRANSFER_MAX_AGE_MS) rmSync(transfer, { recursive: true, force: true })
      } catch { /* Gone or unreadable: left alone. */ }
    }
    try { if (!readdirSync(session).length) rmSync(session, { recursive: true, force: true }) } catch { /* Left alone. */ }
  }
}
