// The user's message with the files attached to it (see src/shared/attachments.ts).
import { attachmentNote, type AttachmentRef } from '../shared/attachments.js'
import { describeAttachment, grantAttachedFiles } from '../session/attachments.js'
import { FileReadTool } from '../tools/impl/FileReadTool.js'
import type { ToolUseContext } from '../tools/tool.js'
import type { ImageBlock, TextBlock } from '../llm/types.js'
import { IMAGE_REQUEST_RESERVE } from '../llm/images.js'

/** The attachments as they are when the turn starts; the files the model may read are granted then. */
export function prepareAttachments(paths: ReadonlyArray<string>): AttachmentRef[] {
  const refs = paths.map(describeAttachment)
  grantAttachedFiles(refs)
  return refs
}

/**
 * The content of the user's message: their words (after the turn's context block), the note that
 * lists the attachments, then each image as FileRead shows one ("Image: <path> (W×H)", then the
 * image; recovery names a refused image by that label). An image FileRead refuses (the model takes
 * no images, the file is too large or damaged) is listed with the reason instead, in the note and
 * in `refs`. Files that are not images are listed for the model to read with FileRead. Without an
 * image the content is one string.
 *
 * `context` is a tool context whose vision counts the images the conversation already holds. The
 * message's own images must fit one request (count and size) by themselves: older images make room
 * for them (fitImages), but images past that would be dropped from this message without a word, so
 * they are named as not included instead.
 */
export async function attachmentContent(text: string, refs: AttachmentRef[], context: ToolUseContext): Promise<{ content: string | Array<TextBlock | ImageBlock>; refs: AttachmentRef[] }> {
  const images: Array<TextBlock | ImageBlock> = []
  const checked: AttachmentRef[] = []
  let shown = 0, bytes = 0
  for (const ref of refs) {
    if (ref.problem || ref.kind !== 'image') { checked.push(ref); continue }
    const caps = context.vision
    if (!caps) { checked.push({ ...ref, problem: 'the selected model cannot view images' }); continue }
    if (shown + 1 > caps.maxImages) { checked.push({ ...ref, problem: `one message to this model takes at most ${caps.maxImages} images` }); continue }
    const base64 = Math.ceil((ref.bytes ?? 0) / 3) * 4
    if (bytes + base64 + IMAGE_REQUEST_RESERVE > caps.maxRequestBytes) { checked.push({ ...ref, problem: `the images in this message come to more than ${caps.provider}'s ${caps.maxRequestBytes / (1024 * 1024)} MB request limit` }); continue }
    const result = await FileReadTool.call({ file_path: ref.path }, context)
    const image = result.success ? result.contentBlocks?.find((block): block is ImageBlock => block.type === 'image') : undefined
    if (image) {
      images.push(...result.contentBlocks!)
      shown++; bytes += image.source.data.length
      checked.push(ref)
    } else {
      checked.push({ ...ref, problem: result.success ? 'it could not be shown as an image' : String(result.error ?? 'it could not be read') })
    }
  }
  // trimEnd: a message of files only has a context block and no words after it.
  const words = [text.trimEnd(), attachmentNote(checked)].filter(Boolean).join('\n\n')
  // Without images the message stays plain text, as every other user message is.
  return { content: images.length ? [{ type: 'text', text: words }, ...images] : words, refs: checked }
}
