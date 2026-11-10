// Split markdown into top-level blocks so a streaming message only re-parses its
// last block (the Streamdown / prompt-kit pattern). Completed blocks keep the
// exact same string, so a memoised renderer can skip them on every token.
//
// The splitter is deliberately conservative: it only cuts at a blank line that
// is outside a code fence AND is followed by an unindented line that does not
// continue a list. Anything ambiguous stays in one block, which is always safe
// (it only costs re-parsing).

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
// Link reference definitions and footnotes resolve across the whole document;
// splitting would orphan them, so documents that use them are not split.
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m

export function splitMarkdownBlocks(markdown: string): string[] {
  if (!markdown) return []
  if (DEFINITION.test(markdown)) return [markdown]

  const blocks: string[] = []
  let current: string[] = []
  let fence: { char: string; length: number } | null = null
  let afterBlank = false
  let inList = false
  // Whether the current block has any text yet (leading blank lines never split).
  let hasText = false

  for (const line of markdown.split('\n')) {
    if (fence) {
      current.push(line)
      const close = FENCE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length && close[2].trim() === '') fence = null
      continue
    }

    if (line.trim() === '') {
      current.push(line)
      afterBlank = hasText
      continue
    }

    const topLevel = /^\S/.test(line)
    const listItem = topLevel && LIST_ITEM.test(line)
    // Keep a loose list (items separated by blank lines) in one block so its
    // numbering, spacing and nested content stay intact.
    if (afterBlank && topLevel && !(inList && listItem)) {
      blocks.push(current.join('\n'))
      current = []
      inList = false
    }
    afterBlank = false
    if (listItem) inList = true

    const open = FENCE.exec(line)
    // A backtick fence's info string may not contain backticks (that is inline code).
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length }
    current.push(line)
    hasText = true
  }

  if (current.length) blocks.push(current.join('\n'))
  return blocks
}
