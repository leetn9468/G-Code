// Files the user attached to messages in this process (see src/shared/attachments.ts).
// FileRead reads them without asking, as it reads files inside the project: the user chose them.
// Only those exact files: their folders, other tools and other files stay as they were. A grant is
// the file's real path and its identity when it was attached: a path that now leads to another file
// (a link swapped, the file replaced, a missing file created later) asks again.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { attachmentName, type AttachmentRef } from '../shared/attachments.js'
import { fileId, realTarget } from './scopedPermission.js'

/** Real path of each attached file → its identity (device:inode) when it was attached. */
const granted = new Map<string, string>()

/**
 * Lets FileRead read these files without asking: each one that reached the model (no `problem`)
 * whose path still leads to the file it was when it was sent (its recorded `id`).
 */
export function grantAttachedFiles(refs: Iterable<AttachmentRef>): void {
  for (const ref of refs) {
    if (ref.problem || !ref.id) continue
    const resolved = realTarget(ref.path) ?? ref.path
    if (fileId(resolved) === ref.id) granted.set(resolved, ref.id)
  }
}

/** Whether the real path `resolved` is a file the user attached, and still that same file. */
export function isAttachedFile(resolved: string): boolean {
  const id = granted.get(resolved)
  return id !== undefined && fileId(resolved) === id
}

/** Forgets every grant (tests). */
export function clearAttachedFiles(): void {
  granted.clear()
}

/**
 * The attachments a saved conversation's messages carry, as the user message metadata records them.
 * A saved file can be damaged (entries that are not messages, fields of the wrong type): what is not
 * a well-formed ref is skipped, and never stops the session. Refs grant reads, so only exact shapes count.
 */
export function savedAttachments(messages: ReadonlyArray<unknown>): AttachmentRef[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'user') return []
    const metadata = (message as { metadata?: unknown }).metadata
    const list = metadata && typeof metadata === 'object' ? (metadata as { attachments?: unknown }).attachments : undefined
    return Array.isArray(list) ? list.filter(isSavedRef) : []
  })
}

function isSavedRef(ref: unknown): ref is AttachmentRef {
  if (!ref || typeof ref !== 'object') return false
  const { path, name, kind, bytes, problem, id } = ref as Record<string, unknown>
  return typeof path === 'string' && path.startsWith('/') && typeof name === 'string' && (kind === 'image' || kind === 'file')
    && (bytes === undefined || typeof bytes === 'number') && (problem === undefined || typeof problem === 'string')
    && (id === undefined || typeof id === 'string' && /^\d+:\d+$/.test(id))
}

/** PNG, JPEG, GIF or WebP by their first bytes: the formats the providers take inline. */
export function isImageHead(head: Buffer): boolean {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return true
  return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
}

/** What an attached path is now: an image, another file, or why it cannot be used. Follows links. `id`: the file it leads to. */
export function describeAttachment(path: string): AttachmentRef {
  const name = attachmentName(path)
  let size: number
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) return { path, name, kind: 'file', problem: 'it is a folder, not a file' }
    if (!stat.isFile()) return { path, name, kind: 'file', problem: 'it is not a regular file' }
    size = stat.size
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { path, name, kind: 'file', problem: code === 'ENOENT' ? 'the file no longer exists' : code === 'EACCES' || code === 'EPERM' ? 'G-Code may not read it' : 'it could not be read' }
  }
  const head = Buffer.alloc(12)
  let read = 0
  try {
    const fd = openSync(path, 'r')
    try { read = readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
  } catch {
    return { path, name, kind: 'file', bytes: size, problem: 'G-Code may not read it' }
  }
  const id = fileId(realTarget(path) ?? path)
  return { path, name, kind: isImageHead(head.subarray(0, read)) ? 'image' : 'file', bytes: size, ...(id ? { id } : {}) }
}
