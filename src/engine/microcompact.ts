/**
 * @file microcompact.ts
 * @brief Microcompaction — trim individual tool result blocks that are too large
 *
 * Unlike message-level compaction, microcompaction operates on single
 * content blocks within messages, truncating oversized tool results
 * while preserving their structure.
 */

import type { LLMMessage, ContentBlock, ImageBlock, TextBlock, VisionCapabilities } from '../llm/types.js'
import { roughTokenCount } from './context.js'
import { IMAGE_REQUEST_RESERVE, imageProblem } from '../llm/images.js'
import { headUnits } from '../utils/textUnits.js'

const MAX_TOOL_RESULT_TOKENS = 8_000
/** The longest tool result, in characters, that microcompact leaves whole (8,000 rough tokens). */
export const MAX_TOOL_RESULT_CHARS = MAX_TOOL_RESULT_TOKENS * 4
/** The suffix of results cut before cuts said what they left out; saved sessions still hold them. */
const LEGACY_SUFFIX = '\n\n[... output truncated for context management]'
/** Room kept for the note that ends a cut result. */
const NOTE_CHARS = 400
/** The most one FileRead call returns, in characters (FileReadTool's output cap). */
const READ_OUTPUT_CHARS = MAX_TOOL_RESULT_CHARS - 1_000

/** The call a tool result answers, as far as a cut note needs it. */
export interface ToolCallRef { name: string; input: Record<string, unknown> }

/** The note cutToolResult ends a result with; groups: total lines, total characters. */
const CUT_NOTE = /\n\n\[Truncated for context management: kept the first [\d,]+ of ([\d,]+) lines(?: and the start of the next)? \([\d,]+ of ([\d,]+) characters\)\. [^\n]*\]$/
/**
 * The note a cut FileRead result ends with, in the file's own line numbers; groups: the first and
 * last line the read returned, its total characters, the file's line count.
 */
const READ_CUT_NOTE = /\n\n\[Truncated for context management: kept (?:file lines [\d,]+-[\d,]+(?: and the start of line [\d,]+)?|the start of line [\d,]+) of lines ([\d,]+)-([\d,]+) that this read returned \([\d,]+ of ([\d,]+) characters\); the file has ([\d,]+) lines\. [^\n]*\]$/

/**
 * FileRead's note on a line too long for one call; groups: the line number, its length, and the
 * file's line count (FileRead names it only when more lines follow).
 */
const READ_LONG_LINE = /\n\n\[Line ([\d,]+) is ([\d,]+) characters long; only its start is shown\.[^\n]*?(?: The file has ([\d,]+) lines;[^\n]*)?\]$/
/**
 * The note a cut that kept only the start of one FileRead line ends with; groups: the line's length
 * (when known), its number, the file's line count (when known).
 */
const LINE_CUT_NOTE = /\n\n\[Truncated for context management: kept the first [\d,]+ (?:of the ([\d,]+) )?characters of line ([\d,]+)\. Use Bash[^\n]*?(?: The file has ([\d,]+) lines?;[^\n]*)?\]$/

const countLines = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
const number = (value: string) => Number(value.replace(/,/g, ''))
const shown = (value: number) => value.toLocaleString('en-US')

/**
 * The file lines a FileRead result holds: the first and last line it returned, and how many lines
 * the file has (from its "Showing lines" note, or the whole file when it has none). Undefined for a
 * result that is not numbered lines (an empty file, a notice, one line too long to show).
 */
function readSpan(body: string): { first: number; last: number; fileLines: number } | undefined {
  const first = /^(\d+)\t/.exec(body)?.[1]
  if (!first) return
  const showing = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)[.:]/.exec(body)
  if (showing) return { first: Number(showing[1]), last: Number(showing[2]), fileLines: Number(showing[3]) }
  if (/\n\n\[Line \d+ is [\d,]+ characters long/.test(body)) return
  const numbers = [...body.matchAll(/(?:^|\n)(\d+)\t/g)]
  const last = Number(numbers.at(-1)![1])
  return Number(first) === 1 ? { first: 1, last, fileLines: last } : undefined
}

/**
 * Cuts one tool result to at most `maxChars`, at a line boundary when there is one, and ends it
 * with a note that says exactly what was kept and how to get the rest. A FileRead result's note
 * counts the file's own lines (a read from an offset starts past line 1) and names the offset of
 * the first line it left out.
 */
export function cutToolResult(text: string, maxChars: number, call?: ToolCallRef): string {
  if (text.length <= maxChars) return text
  // Cutting a result that was cut before: the note keeps counting the original output.
  const read = call?.name === 'FileRead'
  const previousLine = read ? LINE_CUT_NOTE.exec(text) : null
  const previousRead = read && !previousLine ? READ_CUT_NOTE.exec(text) : null
  const previous = previousLine || previousRead ? null : CUT_NOTE.exec(text)
  const note = previousLine ?? previousRead ?? previous
  const body = note ? text.slice(0, note.index) : text
  const totalChars = previousRead ? number(previousRead[3]!) : previous ? number(previous[2]!) : text.length
  const room = Math.max(0, maxChars - NOTE_CHARS)
  let head = headUnits(body, room)
  const newline = head.lastIndexOf('\n')
  const whole = newline >= room / 2
  if (whole) head = head.slice(0, newline)
  // A FileRead line starts with its number: continue after the last whole line kept.
  const lastNumber = read ? /(?:^|\n)(\d+)\t[^\n]*$/.exec(head)?.[1] : undefined
  // Only the start of one line fits. FileRead from that line would return the same start again,
  // so the note says how much of the line is kept and how to read the rest of it.
  if (lastNumber && !whole && !head.includes('\n')) return cutLongLine(body, head, Number(lastNumber), maxChars, previousLine, !!note, previousRead ? number(previousRead[4]!) : undefined)
  const span = !lastNumber ? undefined : previousRead
    ? { first: number(previousRead[1]!), last: number(previousRead[2]!), fileLines: number(previousRead[4]!) }
    : previous ? undefined : readSpan(body)
  let ending: string
  if (lastNumber && span) {
    const line = Number(lastNumber)
    const kept = whole ? `file lines ${shown(span.first)}-${shown(line)}`
      : line > span.first ? `file lines ${shown(span.first)}-${shown(line - 1)} and the start of line ${shown(line)}` : `the start of line ${shown(line)}`
    ending = `\n\n[Truncated for context management: kept ${kept} of lines ${shown(span.first)}-${shown(span.last)} that this read returned (${shown(head.length)} of ${shown(totalChars)} characters); the file has ${shown(span.fileLines)} lines. To read the rest, call FileRead with offset=${line + (whole ? 1 : 0)}.]`
  } else {
    const total = previous ? number(previous[1]!) : countLines(body)
    const kept = whole ? countLines(head) : Math.max(0, countLines(head) - 1)
    const how = lastNumber
      ? `To read the rest, call FileRead with offset=${Number(lastNumber) + (whole ? 1 : 0)}.`
      : `The rest was not kept; ${call?.name === 'Grep' ? 'repeat the call with a narrower pattern, path or glob, or a smaller head_limit,' : call?.name === 'ListDir' ? 'list a subfolder, or use Glob with a narrower pattern,' : 'repeat the call with narrower output (for example head, tail, grep or sed -n)'} to see it.`
    const lines = `${shown(kept)} of ${shown(total)} lines${whole ? '' : ' and the start of the next'}`
    ending = `\n\n[Truncated for context management: kept the first ${lines} (${shown(head.length)} of ${shown(totalChars)} characters). ${how}]`
  }
  return headUnits(head, maxChars - ending.length) + ending
}

/**
 * The cut of a FileRead result that keeps only the start of its first line (`head`, numbered
 * `line`). The line's length and the file's line count come from an earlier such cut, FileRead's
 * own long-line note, or the result itself. `cut`: the result was cut before (`body` is what that
 * cut kept); `cutFileLines`: the file's line count an earlier cut recorded.
 */
function cutLongLine(body: string, head: string, line: number, maxChars: number, previousLine: RegExpExecArray | null, cut: boolean, cutFileLines?: number): string {
  const prefix = `${line}\t`.length
  const longLine = cut ? null : READ_LONG_LINE.exec(body)
  const firstEnd = body.indexOf('\n')
  // The line's own characters, without its number: known when the result holds the whole line.
  const length = previousLine ? previousLine[1] ? number(previousLine[1]) : undefined
    : longLine ? number(longLine[2]!)
    : !cut || firstEnd >= 0 ? (firstEnd >= 0 ? firstEnd : body.length) - prefix : undefined
  // FileRead names the file's line count only when more lines follow the long one.
  const fileLines = previousLine ? previousLine[3] ? number(previousLine[3]) : undefined
    : longLine ? longLine[3] ? number(longLine[3]) : line
    : cut ? cutFileLines : readSpan(body)?.fileLines
  const lines = (count: number) => `${shown(count)} line${count === 1 ? '' : 's'}`
  const next = fileLines === undefined ? ` Call FileRead with offset=${line + 1} for any lines after it.`
    : line < fileLines ? ` The file has ${lines(fileLines)}; call FileRead with offset=${line + 1} for the next one.`
    : ` The file has ${lines(fileLines)}; this is the last one.`
  // A line longer than one FileRead call returns: reading it again gives the same start.
  const tooLong = !!longLine || (length !== undefined && prefix + length > READ_OUTPUT_CHARS)
  const kept = (count: number) => `kept the first ${shown(Math.max(0, count - prefix))} ${length !== undefined ? `of the ${shown(length)} ` : ''}characters of line ${shown(line)}`
  const ending = (count: number) => `\n\n[Truncated for context management: ${kept(count)}. Use Bash (for example cut -c or head -c) to read the rest of the line${tooLong ? '; FileRead returns only its start' : ''}.${next}]`
  const shownHead = headUnits(head, maxChars - ending(head.length).length)
  return shownHead + ending(shownHead.length)
}

/** Every tool call in the messages, by id. */
export function toolCalls(messages: LLMMessage[]): Map<string, ToolCallRef> {
  const calls = new Map<string, ToolCallRef>()
  for (const message of messages) if (message.role === 'assistant' && Array.isArray(message.content))
    for (const block of message.content) if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input })
  return calls
}

/**
 * Microcompact: truncate oversized tool_result blocks in-place.
 * Returns the number of blocks that were truncated.
 *
 * The engine runs it before it measures and sends every request, so a result is cut before its
 * first send, the context check counts the bytes actually sent, and the same cut gives the same
 * bytes afterwards. Cutting a result that was already sent would change the prefix of every later
 * turn and invalidate the thinking replayed with them. A cut result fits under the cap, so it is
 * never cut again. The one deliberate exception is pressure clearing (clearOldToolResults in
 * compact.ts), which runs only where a compaction would otherwise rewrite far more.
 */
export function microcompactMessages(messages: LLMMessage[]): number {
  let truncated = 0
  let calls: Map<string, ToolCallRef> | undefined

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue

    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]!
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        const tokens = roughTokenCount(block.content)
        // Cut by an earlier version: cutting again must give the same bytes, so leave it as it is.
        const legacy = block.content.endsWith(LEGACY_SUFFIX) && block.content.length <= MAX_TOOL_RESULT_CHARS + LEGACY_SUFFIX.length
        if (tokens > MAX_TOOL_RESULT_TOKENS && !legacy) {
          calls ??= toolCalls(messages)
          ;(msg.content as ContentBlock[])[i] = {
            ...block,
            content: cutToolResult(block.content, MAX_TOOL_RESULT_CHARS, calls.get(block.tool_use_id)),
          }
          truncated++
        }
      }
    }
  }

  return truncated
}

/**
 * Images dropped beyond what a request over a limit needs. Dropping an old image rewrites the
 * history after it, so the prompt cache misses once and that history is billed as a cache write.
 * Dropped one at a time, every new image past the limit misses again (f1, round 18: 11 misses in
 * 39 images, cache read ratio 0.669). This room makes it one miss per 5 images (replayed on f1's
 * calls: 4 misses, ratio 0.85, cache cost down 45%).
 */
export const IMAGE_DROP_ROOM = 4

/**
 * Keep the images of a request within what the model takes, in place, before it is measured and
 * sent: an image the provider would refuse (damaged, too large, the wrong type) becomes a short
 * note, then the oldest images do until the request is within the model's image count and request
 * size, and IMAGE_DROP_ROOM more for the images to come. The images the model has not seen yet
 * (the last message's) are dropped only when the limits need it. Returns how many were replaced.
 *
 * A request over a limit is otherwise refused before it is sent, and the conversation that holds
 * it (and every later turn, which sends it again) can never be sent. A replaced image stays
 * replaced, so later requests keep the same bytes.
 */
export function fitImages(messages: LLMMessage[], caps: VisionCapabilities | undefined, reserveBytes = IMAGE_REQUEST_RESERVE): number {
  if (!caps) return 0
  const slots: Array<{ holder: Array<ContentBlock | TextBlock | ImageBlock>; index: number; image: ImageBlock; unseen: boolean }> = []
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    const content = message.content, unseen = message === messages.at(-1)
    content.forEach((block, index) => {
      if (block.type === 'image') slots.push({ holder: content, index, image: block, unseen })
      else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const children = block.content
        children.forEach((child, childIndex) => { if (child.type === 'image') slots.push({ holder: children, index: childIndex, image: child, unseen }) })
      }
    })
  }
  if (!slots.length) return 0
  let replaced = 0
  const replace = (slot: (typeof slots)[number], text: string) => { slot.holder[slot.index] = { type: 'text', text }; replaced++ }
  const kept = slots.filter(slot => {
    const problem = imageProblem(slot.image, caps)
    if (problem) replace(slot, `[Image removed: ${problem.replace(/\.$/, '')}.]`)
    return !problem
  })
  let count = kept.length
  let bytes = count ? Buffer.byteLength(JSON.stringify(messages.map(message => ({ role: message.role, content: message.content })))) : 0
  let dropped = 0, room = IMAGE_DROP_ROOM
  for (const slot of kept) {
    const over = count > caps.maxImages || bytes + reserveBytes > caps.maxRequestBytes
    if (!over && (!dropped || slot.unseen || room-- <= 0)) break
    dropped++
    count--
    bytes -= slot.image.source.data.length
    replace(slot, `[Image removed from the conversation: one request to this model carries at most ${caps.maxImages} images and ${caps.maxRequestBytes / (1024 * 1024)} MiB, so the oldest images were dropped and the newest kept.]`)
  }
  return replaced
}
