/**
 * @file jsonFault.ts
 * @brief Where a text stops being one JSON value
 *
 * Bun's JSON.parse says only "Unable to parse JSON string". A model redoing a long tool call needs
 * the place: the echo of its arguments is capped, and the fault is often past the cap.
 */

const NUMBER_OR_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

/** The index just after the string opening at `start`, or the negative of (the fault's index + 1). */
function scanString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x22) return i + 1
    if (code < 0x20) return -(i + 1)
    if (code !== 0x5c) continue
    const escape = text[++i]
    if (escape === 'u') {
      if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) return -(i + 1)
      i += 4
    } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return -(i + 1)
  }
  return -(text.length + 1)
}

/**
 * The index of the first character that cannot continue one JSON value, the text's length when it
 * ends too early, or -1 when it is valid. Iterative, so depth costs no stack.
 */
export function jsonFaultAt(text: string): number {
  const open: string[] = []
  // 'value', 'first' (a value or the closing bracket after "["), 'key', 'firstKey' (a key or "}" after "{"), 'colon', 'next' (a comma or the closing bracket), 'end'.
  let state = 'value', i = 0
  while (true) {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++
    if (i >= text.length) return state === 'end' ? -1 : text.length
    const char = text[i]!
    const close = (bracket: string) => { open.pop(); i++; state = open.length ? 'next' : 'end'; return bracket }
    if (state === 'end') return i
    if (state === 'colon') { if (char !== ':') return i; i++; state = 'value'; continue }
    if (state === 'next') {
      if (char === ',') { i++; state = open.at(-1) === '{' ? 'key' : 'value'; continue }
      if (char === (open.at(-1) === '{' ? '}' : ']')) { close(char); continue }
      return i
    }
    if (state === 'firstKey' && char === '}') { close(char); continue }
    if (state === 'first' && char === ']') { close(char); continue }
    if (state === 'key' || state === 'firstKey') {
      if (char !== '"') return i
      const after = scanString(text, i)
      if (after < 0) return -after - 1
      i = after; state = 'colon'; continue
    }
    if (char === '{') { open.push(char); i++; state = 'firstKey'; continue }
    if (char === '[') { open.push(char); i++; state = 'first'; continue }
    if (char === '"') {
      const after = scanString(text, i)
      if (after < 0) return -after - 1
      i = after; state = open.length ? 'next' : 'end'; continue
    }
    NUMBER_OR_LITERAL.lastIndex = i
    if (!NUMBER_OR_LITERAL.test(text)) return i
    i = NUMBER_OR_LITERAL.lastIndex; state = open.length ? 'next' : 'end'
  }
}
