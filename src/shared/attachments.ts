// Files the user attaches to a message in the desktop composer ([+], drop or paste).
// Pure (no Node APIs): the desktop and the CLI share the contract.
//
// The desktop sends absolute paths only. The CLI shows images to a vision model inline in the
// user's message; any other file is listed by path for the model to read with FileRead, which
// reads an attached file without asking (the user chose it). Nothing is copied into the project.

/** At most this many files go with one message (the providers' per-request image limit). */
export const MAX_ATTACHMENTS = 20
/** Longest path accepted in a frame: macOS PATH_MAX. */
const MAX_PATH_CHARS = 1024

export type AttachmentKind = 'image' | 'file'

/** An attachment as the saved conversation and the desktop show it. */
export interface AttachmentRef {
  path: string
  name: string
  kind: AttachmentKind
  /** Size in bytes when it was sent; absent when the file could not be read then. */
  bytes?: number
  /** Why it did not reach the model (missing, unreadable, an image the model cannot take). */
  problem?: string
  /** The file's identity (device:inode) when it was sent. A later read without asking needs this same file at this same path. */
  id?: string
}

/** The file's name: the last part of its path. */
export function attachmentName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * The attachment paths of a desktop message frame. Absent means none. Anything else that is not a
 * list of distinct absolute paths (at most MAX_ATTACHMENTS) is refused whole: a frame is never
 * sent with part of what the user attached.
 */
export function parseAttachmentPaths(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid desktop input frame: attachments must be a list of paths')
  if (value.length > MAX_ATTACHMENTS) throw new Error(`Too many attachments: ${value.length}; one message takes at most ${MAX_ATTACHMENTS}.`)
  const seen = new Set<string>()
  for (const path of value) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_CHARS || path.includes('\0') || /[\r\n]/.test(path)) throw new Error('Invalid desktop input frame: an attachment is not an absolute file path')
    if (seen.has(path)) throw new Error(`Invalid desktop input frame: ${path} is attached twice`)
    seen.add(path)
  }
  return value as string[]
}

/** The size as people read it: 820 B, 12.4 KB, 3.1 MB. */
export function attachmentSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`
}

/**
 * What the model is told about the attachments, after the user's words. Images follow this text
 * in the same message; other files are read with FileRead.
 */
export function attachmentNote(refs: ReadonlyArray<AttachmentRef>): string {
  if (!refs.length) return ''
  const line = (ref: AttachmentRef) => {
    if (ref.problem) return `- ${ref.path}: not included (${ref.problem.replace(/\.$/, '')})`
    const size = ref.bytes !== undefined ? `, ${attachmentSize(ref.bytes)}` : ''
    return ref.kind === 'image' ? `- ${ref.path} (image${size}, shown below)` : `- ${ref.path} (file${size}: read it with FileRead)`
  }
  const files = refs.some(ref => ref.kind === 'file' && !ref.problem)
  return [
    `[The user attached ${refs.length === 1 ? 'a file' : `${refs.length} files`} to this message.${files ? ' Read each attached file with FileRead before you answer; reading an attached file needs no approval, wherever it is.' : ''}]`,
    ...refs.map(line),
  ].join('\n')
}

/** The attachments that reached the model, as a handoff carries them to the session that takes over (no identity: that session checks the files again). */
export function usableAttachments(refs: ReadonlyArray<AttachmentRef>): AttachmentRef[] {
  return refs.filter(ref => !ref.problem).map(({ path, name, kind, bytes }) => ({ path, name, kind, ...(bytes !== undefined ? { bytes } : {}) }))
}

/** Attachment refs from a frame or a saved record: undefined unless every entry has a path, a name and a kind. */
export function attachmentRefsFrom(value: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return undefined
  const valid = value.every(ref => !!ref && typeof ref === 'object' && typeof ref.path === 'string' && ref.path.startsWith('/') && typeof ref.name === 'string' && (ref.kind === 'image' || ref.kind === 'file') && (ref.bytes === undefined || Number.isSafeInteger(ref.bytes) && ref.bytes >= 0))
  return valid ? value.map(({ path, name, kind, bytes }) => ({ path, name, kind, ...(bytes !== undefined ? { bytes } : {}) })) : undefined
}

/**
 * The request as text, for what carries it on without the message itself (a handoff's
 * continuation, the request a session budget holds): the user's words and the attached paths.
 */
export function requestWithAttachments(input: string, refs: ReadonlyArray<AttachmentRef>): string {
  if (!refs.length) return input
  const list = `[Attached: ${refs.map(ref => ref.path).join(', ')}]`
  return input ? `${input}\n\n${list}` : list
}
