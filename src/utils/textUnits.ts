/**
 * @file textUnits.ts
 * @brief Trims that never cut a character in half.
 *
 * JavaScript strings are UTF-16: an emoji or a rare CJK character is a surrogate pair, two
 * units. A plain `slice` at a fixed length can keep one half of a pair, a lone surrogate that
 * JSON encodes as `\ud83d` and that providers reject or turn into U+FFFD. Use these for every
 * trim of text that goes to the model, the desktop, a hook's environment or a saved session.
 */

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff

/** The last `length` UTF-16 units, without half a surrogate pair at the start. */
export function tailUnits(text: string, length: number): string {
  if (length <= 0) return ''
  if (text.length <= length) return text
  const start = text.length - length
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start)
}

/** The first `length` UTF-16 units, without half a surrogate pair at the end. */
export function headUnits(text: string, length: number): string {
  if (length <= 0) return ''
  if (text.length <= length) return text
  return text.slice(0, isHighSurrogate(text.charCodeAt(length - 1)) ? length - 1 : length)
}

/** The last `bytes` bytes of the UTF-8 encoding, starting on a character boundary. */
export function tailBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  const buffer = Buffer.from(text)
  let start = buffer.length - bytes
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString()
}

// Terminal output (background shells, TaskOutput) is full of colour codes. A tail cut at a fixed
// length can start between ESC and the rest of its sequence, so `[0m` or `32m` shows as text, or
// halfway through a line. These tails start after a cut sequence and, when a line break is near
// the start, on the next whole line.

/** One escape sequence: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), or a two-byte one. */
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/y
/** How far back from a cut an escape sequence that spans it can start (OSC hyperlinks can be long). */
const ESCAPE_LOOKBACK = 512

/** Where a tail of `text` cut at `cut` should start: past an escape sequence the cut splits, then on the next line if one starts soon. */
function outputStart(text: string, cut: number, slack: number): number {
  let start = cut
  for (let index = cut - 1; index >= Math.max(0, cut - ESCAPE_LOOKBACK); index--) {
    if (text.charCodeAt(index) !== 0x1b) continue
    ESCAPE_SEQUENCE.lastIndex = index
    const match = ESCAPE_SEQUENCE.exec(text)
    // Only the nearest ESC before the cut can start a sequence that spans it.
    if (match && index + match[0].length > cut) start = index + match[0].length
    break
  }
  if (start > 0 && text[start - 1] !== '\n') {
    const newline = text.indexOf('\n', start)
    if (newline >= 0 && newline - start < slack) start = newline + 1
  }
  return start
}

const slackFor = (length: number) => Math.min(1024, Math.floor(length / 4))

/** Like tailUnits, for terminal output: never starts inside an escape sequence, and starts on a whole line when one begins within the first quarter (at most 1 KB). */
export function tailOutput(text: string, length: number): string {
  const tail = tailUnits(text, length)
  if (tail.length === text.length) return tail
  return text.slice(outputStart(text, text.length - tail.length, slackFor(length)))
}

/**
 * Like headUnits, for terminal output: never ends inside an escape sequence, and ends on a whole
 * line when one ends within the last quarter (at most 1 KB).
 */
export function headOutput(text: string, length: number): string {
  const head = headUnits(text, length)
  if (head.length === text.length) return head
  let end = head.length
  // Only the nearest ESC before the cut can start a sequence that spans it.
  const escape = head.lastIndexOf('\x1b', end - 1)
  if (escape >= 0 && escape >= end - ESCAPE_LOOKBACK) {
    ESCAPE_SEQUENCE.lastIndex = escape
    const match = ESCAPE_SEQUENCE.exec(text)
    if (!match || escape + match[0].length > end) end = escape
  }
  const newline = text.lastIndexOf('\n', end - 1)
  if (newline >= 0 && end - (newline + 1) < slackFor(length)) end = newline + 1
  return text.slice(0, end)
}

/** Like tailBytes, for terminal output: the same start rules as tailOutput. */
export function tailOutputBytes(text: string, bytes: number): string {
  const tail = tailBytes(text, bytes)
  if (tail.length === text.length) return tail
  return text.slice(outputStart(text, text.length - tail.length, slackFor(tail.length)))
}
