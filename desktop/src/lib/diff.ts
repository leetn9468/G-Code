// Line diffs for the side panel's Changes view: two texts to numbered lines,
// collapsible hunks, side-by-side rows, word highlights and +/- counts.
// Pure and capped, so a huge or very different file never freezes the UI:
// the line diff gives up after a bounded edit length or time and shows the
// differing middle as one replacement, and word highlights stop past a line
// count or a time budget.

import { diffArrays, diffWordsWithSpace } from 'diff'

export type LineKind = 'context' | 'add' | 'del'
/** A run of a changed line's text; `changed` marks the words that differ from its partner line. */
export interface WordPart { text: string; changed: boolean }
export interface DiffLine {
  kind: LineKind
  /** The line without its newline (and without a trailing CR). */
  text: string
  /** 1-based line number in A (context and removed lines). */
  oldNo?: number
  /** 1-based line number in B (context and added lines). */
  newNo?: number
  /** The file's last line has no newline after it. */
  noEol?: boolean
  /** Word highlights for a removed/added pair (absent when not computed). */
  parts?: WordPart[]
}
export interface LineDiff {
  lines: DiffLine[]
  added: number
  removed: number
  /** The line diff hit its cap: the differing middle is shown as one replacement. */
  approximate: boolean
  /** Word highlights were computed (false when skipped for size or time). */
  words: boolean
}

export const DIFF_LIMITS = {
  /** Myers edit-length cap for the line diff (lines added + removed). */
  maxEditLength: 4000,
  /** Wall-clock cap for the line diff. */
  timeoutMs: 300,
  /** No word highlights above this many changed lines. */
  wordLines: 2000,
  /** No word highlights for a pair with a longer line. */
  wordLineLength: 1000,
  /** Total time for all word highlights of one diff. */
  wordBudgetMs: 120,
}

// Marks a last line without a newline, so "x" and "x\n" compare unequal.
const NO_EOL = '\u0000'

/** Lines of a text; a trailing newline does not start an empty last line. */
export function splitLines(text: string): { lines: string[]; eol: boolean } {
  if (!text) return { lines: [], eol: true }
  const lines = text.split('\n')
  const eol = lines[lines.length - 1] === ''
  if (eol) lines.pop()
  return { lines, eol }
}

const display = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line

/** Compares A with B line by line. `words: false` skips word highlights (counts only). */
export function lineDiff(a: string, b: string, options: { words?: boolean; limits?: Partial<typeof DIFF_LIMITS> } = {}): LineDiff {
  const limits = { ...DIFF_LIMITS, ...options.limits }
  const left = splitLines(a), right = splitLines(b)
  const key = (side: { lines: string[]; eol: boolean }) => side.lines.map((line, index) => index === side.lines.length - 1 && !side.eol ? line + NO_EOL : line)
  const keyA = key(left), keyB = key(right)
  // Common prefix and suffix first: cheap, and most edits touch a small middle.
  let prefix = 0
  while (prefix < keyA.length && prefix < keyB.length && keyA[prefix] === keyB[prefix]) prefix++
  let suffix = 0
  while (suffix < keyA.length - prefix && suffix < keyB.length - prefix && keyA[keyA.length - 1 - suffix] === keyB[keyB.length - 1 - suffix]) suffix++
  const midA = keyA.slice(prefix, keyA.length - suffix)
  const midB = keyB.slice(prefix, keyB.length - suffix)

  type Op = { kind: LineKind; count: number }
  const ops: Op[] = [{ kind: 'context', count: prefix }]
  let approximate = false
  if (midA.length && midB.length) {
    const changes = diffArrays(midA, midB, { maxEditLength: limits.maxEditLength, timeout: limits.timeoutMs })
    if (changes) for (const change of changes) ops.push({ kind: change.added ? 'add' : change.removed ? 'del' : 'context', count: change.count ?? change.value.length })
    else { approximate = true; ops.push({ kind: 'del', count: midA.length }, { kind: 'add', count: midB.length }) }
  } else {
    if (midA.length) ops.push({ kind: 'del', count: midA.length })
    if (midB.length) ops.push({ kind: 'add', count: midB.length })
  }
  ops.push({ kind: 'context', count: suffix })

  const lines: DiffLine[] = []
  let oldIndex = 0, newIndex = 0, added = 0, removed = 0
  const oldLine = (index: number): DiffLine => ({ kind: 'del', text: display(left.lines[index]), oldNo: index + 1, ...(index === left.lines.length - 1 && !left.eol ? { noEol: true } : {}) })
  const newLine = (index: number): DiffLine => ({ kind: 'add', text: display(right.lines[index]), newNo: index + 1, ...(index === right.lines.length - 1 && !right.eol ? { noEol: true } : {}) })
  // Within a run of changes, removed lines come before added ones (unified-diff order).
  let pendingDel = 0, pendingAdd = 0
  const flush = () => {
    for (let i = 0; i < pendingDel; i++) lines.push(oldLine(oldIndex++))
    for (let i = 0; i < pendingAdd; i++) lines.push(newLine(newIndex++))
    removed += pendingDel; added += pendingAdd
    pendingDel = 0; pendingAdd = 0
  }
  for (const op of ops) {
    if (!op.count) continue
    if (op.kind === 'del') { pendingDel += op.count; continue }
    if (op.kind === 'add') { pendingAdd += op.count; continue }
    flush()
    for (let i = 0; i < op.count; i++) {
      lines.push({ kind: 'context', text: display(right.lines[newIndex]), oldNo: oldIndex + 1, newNo: newIndex + 1, ...(newIndex === right.lines.length - 1 && !right.eol ? { noEol: true } : {}) })
      oldIndex++; newIndex++
    }
  }
  flush()

  let words = false
  if (options.words !== false && added && removed && added + removed <= limits.wordLines) words = highlightWords(lines, limits)
  return { lines, added, removed, approximate, words }
}

/** Change runs as [start, firstAdd, end): removed lines in [start, firstAdd), added in [firstAdd, end). */
function changeRuns(lines: DiffLine[]): Array<[number, number, number]> {
  const runs: Array<[number, number, number]> = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind === 'context') { i++; continue }
    const start = i
    while (i < lines.length && lines[i].kind === 'del') i++
    const firstAdd = i
    while (i < lines.length && lines[i].kind === 'add') i++
    runs.push([start, firstAdd, i])
  }
  return runs
}

function merge(parts: WordPart[]): WordPart[] {
  const merged: WordPart[] = []
  for (const part of parts) {
    if (!part.text) continue
    const last = merged[merged.length - 1]
    if (last && last.changed === part.changed) last.text += part.text
    else merged.push({ ...part })
  }
  return merged
}

/** Pairs removed and added lines of each change run in order and marks the words that differ. */
function highlightWords(lines: DiffLine[], limits: typeof DIFF_LIMITS): boolean {
  const deadline = Date.now() + limits.wordBudgetMs
  let any = false
  for (const [start, firstAdd, end] of changeRuns(lines)) {
    const pairs = Math.min(firstAdd - start, end - firstAdd)
    for (let i = 0; i < pairs; i++) {
      if (Date.now() > deadline) return any
      const before = lines[start + i], after = lines[firstAdd + i]
      if (before.text.length > limits.wordLineLength || after.text.length > limits.wordLineLength) continue
      if (before.text === after.text) continue
      const changes = diffWordsWithSpace(before.text, after.text, { maxEditLength: 200 })
      if (!changes) continue
      let common = 0
      for (const change of changes) if (!change.added && !change.removed) common += change.value.length
      // Lines that share little are rewrites: highlighting every word is noise.
      if (common < Math.max(before.text.length, after.text.length) * 0.35) continue
      before.parts = merge(changes.filter(change => !change.added).map(change => ({ text: change.value, changed: change.removed })))
      after.parts = merge(changes.filter(change => !change.removed).map(change => ({ text: change.value, changed: change.added })))
      any = true
    }
  }
  return any
}

// ---------------------------------------------------------------------------
// Hunks: changed lines with context; unchanged regions between them collapse.
// ---------------------------------------------------------------------------

export interface HunkSegment {
  type: 'hunk'
  /** Index range in `lines`: [start, end). */
  start: number
  end: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** "@@ -oldStart,oldLines +newStart,newLines @@" */
  header: string
}
export interface GapSegment {
  type: 'gap'
  start: number
  end: number
  /** Before the first hunk, between two, or after the last. */
  position: 'start' | 'middle' | 'end'
}
export type Segment = HunkSegment | GapSegment

/** A collapsed region shorter than this is shown instead (a button would be as tall). */
const MIN_GAP = 2

/** Splits the lines into hunks (changes with `context` lines around them) and the gaps between. `revealed` ranges are always shown. */
export function segments(lines: DiffLine[], context = 3, revealed: ReadonlyArray<readonly [number, number]> = []): Segment[] {
  const count = lines.length
  const visible = new Uint8Array(count)
  let lastChange = -Infinity
  for (let i = 0; i < count; i++) {
    if (lines[i].kind !== 'context') {
      for (let j = Math.max(0, i - context, lastChange + 1); j <= Math.min(count - 1, i + context); j++) visible[j] = 1
      lastChange = i
    }
  }
  for (const [start, end] of revealed) for (let i = Math.max(0, start); i < Math.min(count, end); i++) visible[i] = 1
  const hasChange = lines.some(line => line.kind !== 'context')
  if (hasChange) {
    // Unhide gaps too short to be worth a button.
    let i = 0
    while (i < count) {
      if (visible[i]) { i++; continue }
      const start = i
      while (i < count && !visible[i]) i++
      if (i - start < MIN_GAP) visible.fill(1, start, i)
    }
  }
  const result: Segment[] = []
  let oldSeen = 0, newSeen = 0
  let i = 0
  while (i < count) {
    const start = i
    const shown = visible[i]
    while (i < count && visible[i] === shown) i++
    if (!shown) {
      result.push({ type: 'gap', start, end: i, position: start === 0 ? 'start' : i === count ? 'end' : 'middle' })
      oldSeen += i - start; newSeen += i - start
      continue
    }
    let oldLines = 0, newLines = 0
    for (let j = start; j < i; j++) { if (lines[j].oldNo !== undefined) oldLines++; if (lines[j].newNo !== undefined) newLines++ }
    const oldStart = oldLines ? oldSeen + 1 : oldSeen
    const newStart = newLines ? newSeen + 1 : newSeen
    result.push({ type: 'hunk', start, end: i, oldStart, oldLines, newStart, newLines, header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` })
    oldSeen += oldLines; newSeen += newLines
  }
  return result
}

/** The range a gap's expand control reveals: `down` from the hunk above, `up` from the hunk below, or all of it. */
export function expandGap(gap: Pick<GapSegment, 'start' | 'end'>, direction: 'up' | 'down' | 'all', step = 20): [number, number] {
  if (direction === 'down') return [gap.start, Math.min(gap.end, gap.start + step)]
  if (direction === 'up') return [Math.max(gap.start, gap.end - step), gap.end]
  return [gap.start, gap.end]
}

// ---------------------------------------------------------------------------
// Side by side: context on both sides, removed lines paired with added ones.
// ---------------------------------------------------------------------------

export interface SplitRow { left?: DiffLine; right?: DiffLine }

/** Rows for lines [start, end): a context line on both sides; within a change run, the nth removed line beside the nth added one. */
export function splitRows(lines: DiffLine[], start = 0, end = lines.length): SplitRow[] {
  const rows: SplitRow[] = []
  let i = start
  while (i < end) {
    const line = lines[i]
    if (line.kind === 'context') { rows.push({ left: line, right: line }); i++; continue }
    const dels: DiffLine[] = [], adds: DiffLine[] = []
    while (i < end && lines[i].kind === 'del') dels.push(lines[i++])
    while (i < end && lines[i].kind === 'add') adds.push(lines[i++])
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) rows.push({ left: dels[j], right: adds[j] })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Status and small helpers.
// ---------------------------------------------------------------------------

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'unchanged'
export const STATUS_LABELS: Record<ChangeStatus, string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted', unchanged: 'Unchanged' }

/** A absent: the file was added; B absent: deleted; both present: modified unless identical. */
export function changeStatus(aAbsent: boolean, bAbsent: boolean, identical: boolean): ChangeStatus {
  if (aAbsent && bAbsent) return 'unchanged'
  if (aAbsent) return 'added'
  if (bAbsent) return 'deleted'
  return identical ? 'unchanged' : 'modified'
}

/** Digits needed for the largest line number (the gutter width in ch). */
export function lineNumberDigits(lines: DiffLine[]): number {
  let max = 0
  for (const line of lines) max = Math.max(max, line.oldNo ?? 0, line.newNo ?? 0)
  return Math.max(2, String(max).length)
}
