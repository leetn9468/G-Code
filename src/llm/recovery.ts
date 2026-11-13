/**
 * @file recovery.ts
 * @brief Keep a conversation usable after the provider refuses its content
 *
 * Some refusals are about what the conversation holds, not about the moment: an image the
 * provider cannot decode, a message larger than the model's window. Every later request sends the
 * same content and is refused the same way, so a session that keeps it can never continue. The
 * turn that was refused replaces the offending content with a short note before it is saved.
 */

import type { ContentBlock, LLMMessage, TextBlock, ToolResultBlock } from './types.js'
import { APIError } from './retry.js'
import { estimateImageTokens } from './images.js'
import { isImageRejection, isPromptTooLongError, parsePromptTooLongTokenCounts } from '../utils/errorParsing.js'

export interface Recovery {
  /** The error to report and save in place of the provider's: what happened and what was done. */
  error: Error
  /** Content blocks replaced by a note. */
  replaced: number
  /**
   * A prompt over the window that this turn's own content does not explain: the provider's count
   * divided by the local estimate, so the next context check sees the real size and compacts.
   */
  scale?: number
  /** The window the provider stated in its refusal. */
  limit?: number
}

export interface RecoveryOptions {
  /** The local estimate, in tokens, of the request that was refused. */
  requestEstimate?: number
  /** Characters the request carried besides the messages (system prompt, tool definitions). */
  overheadChars?: number
  /** A managed local model: its runtime's tokenizer measures each request, and nothing the provider said changes that count. */
  local?: boolean
  /** A sub-agent or workflow agent: it has no next message and no /compact, and what it is told goes to the model that started it. */
  agent?: boolean
}

const MAX_SCALE = 4
const shown = (value: number) => value.toLocaleString('en-US')
const sentence = (text: string) => /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

/** The same error class with a readable message, so callers that check the type still can. */
function replaceMessage(error: unknown, message: string): Error {
  if (error instanceof APIError) return new APIError(message, error.statusCode, false, undefined, { type: error.type, providerMessage: error.providerMessage, requestId: error.requestId, body: error.body, midStream: error.midStream })
  const copy = new Error(message)
  if (error instanceof Error) copy.name = error.name
  return copy
}

/** The image blocks of a message, wherever they are (in its content or in a tool result). */
function imageSlots(message: LLMMessage): Array<{ holder: Array<ContentBlock | TextBlock>; index: number; result?: ToolResultBlock }> {
  if (typeof message.content === 'string') return []
  const slots: Array<{ holder: Array<ContentBlock | TextBlock>; index: number; result?: ToolResultBlock }> = []
  const content = message.content
  content.forEach((block, index) => {
    if (block.type === 'image') slots.push({ holder: content, index })
    else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const children = block.content
      children.forEach((child, childIndex) => { if (child.type === 'image') slots.push({ holder: children, index: childIndex, result: block }) })
    }
  })
  return slots
}

/**
 * The file a FileRead image came from: its result starts with "Image: <path> (W×H)". A user message
 * with attached images holds several, each label before its image: the nearest one before it names it.
 */
function imageSource(slot: { holder: Array<ContentBlock | TextBlock>; index: number }): string | undefined {
  const label = slot.holder.slice(0, slot.index).reverse().find((block): block is TextBlock => block.type === 'text' && block.text.startsWith('Image: '))
  return label ? /^Image: (.+?) \(\d+×\d+\)$/.exec(label.text)?.[1] ?? label.text.slice(7) : undefined
}

/**
 * The provider could not process an image. Every request before this one that carried the older
 * images was accepted, and a refused request starts no new tool round, so the image it refused is
 * in the newest message that holds any. Those images are replaced by a note.
 */
function dropRejectedImages(error: unknown, wire: LLMMessage[], options: RecoveryOptions): Recovery | undefined {
  for (let i = wire.length - 1; i >= 0; i--) {
    const slots = imageSlots(wire[i]!)
    if (!slots.length) continue
    const sources = [...new Set(slots.map(imageSource).filter((path): path is string => !!path))]
    for (const slot of slots) {
      slot.holder[slot.index] = { type: 'text', text: '[Image removed: the provider could not process it. The file may be damaged or in a format the model does not take.]' }
      if (slot.result) slot.result.is_error = true
    }
    const named = sources.length === 1 ? `the image from ${sources[0]}` : sources.length > 1 ? `the images from ${sources.join(', ')}` : slots.length === 1 ? 'an image' : 'the latest images'
    const said = error instanceof APIError && error.providerMessage ? ` (${sentence(error.providerMessage).replace(/\.$/, '')})` : ''
    return { replaced: slots.length, error: replaceMessage(error, `The provider could not process ${named}${said}, so ${slots.length === 1 ? 'it was' : 'they were'} removed from the conversation. The file may be damaged or in a format the model does not take. ${options.agent ? 'Start the agent again without it.' : 'Send the message again to continue.'}`) }
  }
}

/**
 * Characters a message's content carries as sent (a saved continuation is not sent twice). An image
 * counts as the characters of its tokens (about four a token), not its base64 data: a screenshot
 * costs a few thousand tokens however many megabytes it is, so its data would make the message it
 * is in (a user's message with attached images) look like what made the request too long.
 */
function contentChars(content: LLMMessage['content'] | ToolResultBlock['content']): number {
  if (typeof content === 'string') return content.length
  const blocks = content as Array<ContentBlock | TextBlock>
  const images = blocks.flatMap(block => block.type === 'image' ? [block] : block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(child => child.type === 'image') : [])
  const shape = blocks.map(block => block.type === 'image' ? { type: 'image' } : block.type === 'tool_result' && Array.isArray(block.content) ? { ...block, content: block.content.map(child => child.type === 'image' ? { type: 'image' } : child) } : block)
  return JSON.stringify(shape).length + (images.length ? estimateImageTokens([{ role: 'user', content: images }]) * 4 : 0)
}
const chars = (message: LLMMessage) => contentChars(message.content)

/**
 * The prompt is larger than the model's window. This turn's message and tool results are the new
 * content: the largest of them are replaced by a note until the rest would fit (the provider's
 * count is spread over the request's characters). When even all of them would not make it fit,
 * the history itself is too large: nothing is dropped, and the provider's count calibrates the
 * next context check so the next message compacts first.
 */
function dropOversizedContent(error: unknown, wire: LLMMessage[], options: RecoveryOptions): Recovery | undefined {
  const text = error instanceof APIError ? error.providerMessage ?? error.message : error instanceof Error ? error.message : String(error)
  const counts = parsePromptTooLongTokenCounts(text)
  const sizes = counts ? ` (the request came to ${shown(counts.actualTokens)} tokens; the limit is ${shown(counts.limitTokens)})` : ''
  // The turn's own message: the last user message that is not tool results.
  let start = wire.length - 1
  while (start >= 0 && !(wire[start]!.role === 'user' && (typeof wire[start]!.content === 'string' || !(wire[start]!.content as ContentBlock[]).some(block => block.type === 'tool_result')))) start--
  const total = (options.overheadChars ?? 0) + wire.reduce((sum, message) => sum + chars(message), 0)
  type Candidate = { size: number; drop: () => void; kind: 'message' | 'result' }
  const candidates: Candidate[] = []
  if (start >= 0) {
    const message = wire[start]!
    candidates.push({ size: chars(message), kind: 'message', drop: () => { message.content = `[The message for this turn was removed: at ${shown(chars(message))} characters it was too long for the model${sizes}. Ask the user to shorten it, or to save it to a file and point to the file.]` } })
    for (const later of wire.slice(start + 1)) {
      if (later.role !== 'user' || typeof later.content === 'string') continue
      later.content.forEach((block, index) => {
        if (block.type !== 'tool_result') return
        // Without images, as before: the result's JSON. With them, images by their tokens.
        const size = typeof block.content === 'string' ? JSON.stringify(block.content).length : contentChars(block.content)
        candidates.push({ size, kind: 'result', drop: () => { (later.content as ContentBlock[])[index] = { ...block, is_error: true, content: `[Result removed: it made the request too long for the model${sizes}. Run the call again with narrower output if it is still needed.]` } } })
      })
    }
  }
  candidates.sort((a, b) => b.size - a.size)
  // What has to go: the share of the request's characters over 90% of the limit (room for the reply).
  const keepShare = counts ? Math.min(1, (counts.limitTokens * 0.9) / counts.actualTokens) : 0.5
  const mustDrop = total * (1 - keepShare)
  const chosen: Candidate[] = []
  let dropped = 0
  for (const candidate of candidates) {
    if (dropped >= mustDrop) break
    chosen.push(candidate); dropped += candidate.size
  }
  if (total > 0 && dropped >= mustDrop && chosen.length) {
    for (const candidate of chosen) candidate.drop()
    const message = chosen.some(candidate => candidate.kind === 'message')
    const lead = message && chosen.length === 1
      ? `The message was too long for the model${sizes}, so it was not kept in the conversation. Shorten it, or save it to a file and ask for the file to be read.`
      : `This turn made the request too long for the model${sizes}, so ${message ? 'its message and ' : ''}its largest tool results were removed from the conversation. ${options.agent ? 'Start the agent again with a smaller or narrower task.' : 'Send a message to continue.'}`
    return { replaced: chosen.length, ...(counts ? { limit: counts.limitTokens } : {}), error: replaceMessage(error, lead) }
  }
  const scale = counts && options.requestEstimate && options.requestEstimate > 0 ? counts.actualTokens / options.requestEstimate : undefined
  // Without the provider's figures the next check has nothing new to go on, so it may pass and be refused again.
  // The engine's calibration stops at this many tokens per estimated token: past it the next check may not reach its threshold.
  const beyond = scale !== undefined && scale > MAX_SCALE
  return { replaced: 0, scale, ...(counts ? { limit: counts.limitTokens } : {}), error: replaceMessage(error, options.agent
    ? `This agent's conversation is too long for the model${sizes}, and it has no next message to compact it in. Start the agent again with a smaller or narrower task.`
    : options.local
    ? `The conversation is too long for the local model${sizes}, though its tokenizer counted less, so the next message may be refused too. Start a new chat.`
    : beyond
    ? `The conversation is too long for the model${sizes}, far more than G-Code estimated, so the next message may be refused too. Send /compact to shrink it, or start a new chat.`
    : counts ? `The conversation is too long for the model${sizes}. The next message compacts it first; or start a new chat.`
    : 'The conversation is too long for the model, and the provider did not say by how much. Send /compact to shrink it, or start a new chat.') }
}

/**
 * When the provider refused the request because of what the conversation holds, replace that
 * content in `wire` (the turn's journal, saved as the next turn's context) and return a readable
 * error that says what was done. Undefined for any other failure.
 */
export function recoverRejectedRequest(error: unknown, wire: LLMMessage[], options: RecoveryOptions = {}): Recovery | undefined {
  if (isImageRejection(error)) return dropRejectedImages(error, wire, options)
  if (isPromptTooLongError(error)) return dropOversizedContent(error, wire, options)
}
