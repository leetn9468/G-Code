// The composer's attachments: files picked with [+], dropped on the window or pasted.
// The contract with the CLI is src/shared/attachments.ts; desktop/src-tauri/src/attachments.rs
// tells what a path is before it is attached.
import { MAX_ATTACHMENTS, attachmentSize, type AttachmentRef } from '../../../src/shared/attachments'
import { visionCapabilities } from '../../../src/shared/vision'
import type { AttachmentInfo } from './tauri'

/** An attachment in the composer: what goes with the message, and a thumbnail for an image. */
export type ComposerAttachment = AttachmentRef & { bytes: number; thumbnail?: string }

/** The composer's list with the usable files added (in order, no path twice, at most MAX_ATTACHMENTS), and why any were left out. */
export function addAttachments(current: ReadonlyArray<ComposerAttachment>, incoming: ReadonlyArray<ComposerAttachment | (AttachmentInfo & { thumbnail?: string })>): { attachments: ComposerAttachment[]; refused: string[] } {
  const attachments = [...current]
  const refused: string[] = []
  let over = 0
  for (const item of incoming) {
    if (item.problem) { refused.push(`${item.name}: ${item.problem}`); continue }
    if (attachments.some(attachment => attachment.path === item.path)) continue
    if (attachments.length >= MAX_ATTACHMENTS) { over++; continue }
    attachments.push({ path: item.path, name: item.name, kind: item.kind, bytes: item.bytes, ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}) })
  }
  if (over) refused.push(`${over} more ${over === 1 ? 'file was' : 'files were'} left out: one message takes at most ${MAX_ATTACHMENTS}`)
  return { attachments, refused }
}

/** Why these attachments cannot go to this model, or undefined when they can (the CLI checks again). */
export function attachmentSendBlock(attachments: ReadonlyArray<ComposerAttachment>, provider: string | undefined, model: string | undefined): string | undefined {
  const images = attachments.filter(attachment => attachment.kind === 'image')
  if (!images.length) return undefined
  const caps = visionCapabilities(provider ?? '', model ?? '')
  if (!caps) return 'The selected model cannot view images. Remove the image, or choose a model that can (⌘P).'
  const large = images.find(image => image.bytes > caps.maxBytes)
  if (large) return `${large.name} is ${attachmentSize(large.bytes)}; this model takes images up to ${caps.maxBytes / (1024 * 1024)} MB. Remove it or make it smaller.`
  if (images.length > caps.maxImages) return `This model takes at most ${caps.maxImages} images in one message. Remove some.`
  // As sent: base64 (4 bytes for 3), with 1 MB kept for the rest of the request (src/llm/images.ts IMAGE_REQUEST_RESERVE).
  const sent = images.reduce((sum, image) => sum + Math.ceil(image.bytes / 3) * 4, 0)
  if (sent + 1024 * 1024 > caps.maxRequestBytes) return `These images are too large together for one message to this model (${caps.maxRequestBytes / (1024 * 1024)} MB a request). Remove some or make them smaller.`
  return undefined
}

/** What the message carries and the saved conversation shows: no thumbnail. */
export function attachmentRefs(attachments: ReadonlyArray<ComposerAttachment>): AttachmentRef[] {
  return attachments.map(({ path, name, kind, bytes }) => ({ path, name, kind, bytes }))
}

/** A small square thumbnail (as a data URL) of an image preview; undefined when it cannot be drawn. */
export async function thumbnail(preview: string, mediaType: string, size = 72): Promise<string | undefined> {
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = `data:${mediaType};base64,${preview}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const context = canvas.getContext('2d')
    if (!context || !image.naturalWidth || !image.naturalHeight) return undefined
    // Cover the square: the middle of the image, scaled down once.
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    return canvas.toDataURL('image/png')
  } catch {
    return undefined
  }
}

/** Base64 of a pasted file's bytes, in chunks so a large screenshot does not overflow the call stack. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}
