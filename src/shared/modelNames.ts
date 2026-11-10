// Short, readable model names for compact UI (the composer's model pill),
// after G-Code Lite's shortModelName. The full id stays wherever exactness
// matters (tooltips, accessible descriptions, settings). Ids that match no
// known family are returned unchanged, so a custom or local id is never
// rewritten into something the user did not type.

// claude-opus-5-5, claude-sonnet-4-20250514, claude-opus-4-1-20250805
const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i
// Older order, version before family: claude-3-5-haiku-20241022, claude-3-opus-20240229
const CLAUDE_LEGACY = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i
// gpt-5.5, gpt-4o, gpt-4o-mini, gpt-4.1-nano-2025-04-14
const GPT = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z0-9.]+)*)$/i
// Plain ids only: tags (qwen3:8b), paths, file names and spaced text stay as given.
const PLAIN_ID = /^[a-z0-9][a-z0-9.-]*$/i
// Release dates and revision numbers at the end of an id.
const TRAILING_DATE = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2})$/

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
/** Words with a digit are sizes or versions (8B, V4, R1, A22B); others are capitalized. */
const titleWord = (word: string) => (/\d/.test(word) ? word.toUpperCase() : capitalize(word))
const version = (major: string, minor?: string) => (minor ? `${major}.${minor}` : major)

/** Brand-prefixed families whose remaining words are title-cased. */
const WORD_FAMILIES: Array<{ prefix: RegExp; brand: (match: RegExpExecArray) => string }> = [
  { prefix: /^gemini-/i, brand: () => 'Gemini' },
  { prefix: /^deepseek-/i, brand: () => 'DeepSeek' },
  // qwen-max, qwen3-coder-plus, qwen2.5-72b-instruct: the version stays on the brand.
  { prefix: /^qwen(\d+(?:\.\d+)?)?-/i, brand: (match) => `Qwen${match[1] ?? ''}` },
]

export function shortModelName(id: string): string {
  if (!id || !PLAIN_ID.test(id)) return id

  const claude = CLAUDE.exec(id)
  if (claude) return `${capitalize(claude[1])} ${version(claude[2], claude[3])}`
  const legacy = CLAUDE_LEGACY.exec(id)
  if (legacy) return `${capitalize(legacy[3])} ${version(legacy[1], legacy[2])}`

  const undated = id.replace(TRAILING_DATE, '')
  const gpt = GPT.exec(undated)
  if (gpt) {
    const rest = gpt[2].split('-').filter(Boolean).map((word) => word.toLowerCase())
    return [`GPT-${gpt[1].toLowerCase()}`, ...rest].join(' ')
  }

  for (const family of WORD_FAMILIES) {
    const match = family.prefix.exec(undated)
    if (!match) continue
    const words = undated.slice(match[0].length).split('-')
      // Revision numbers (gemini-2.0-flash-001) read as noise; versions (2.5) keep their dot.
      .filter((word, index) => word && !(index > 0 && /^\d+$/.test(word)))
    if (!words.length) return id
    return [family.brand(match), ...words.map(titleWord)].join(' ')
  }
  return id
}
