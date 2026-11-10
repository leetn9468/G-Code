/**
 * @file FileEditTool.ts
 * @brief Surgical string replacement with size guard, quote and line-end normalization, batched edits
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { BINARY_EXTENSIONS, getReadFileState, notAFile, readHead, sniffFormat, trackFileRead } from './FileReadTool.js'
import { isUNCPath, expandPath } from '../../utils/path.js'
import { buildFileNotFoundMessage } from '../../utils/fileSuggestions.js'
import { otherNamesNote, safeWriteFile, withWriteLock } from './safeWrite.js'
import { secretRefusal, writeApprovalReason, writeOutsideReason, writeTarget } from '../permissions.js'

/** Most replacements one call makes with `edits`. */
const MAX_EDITS = 50

const editSchema = z.object({
  old_string: z.string().min(1).describe('The non-empty exact string to find and replace'),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
})

// One form or the other. Optional fields plus a refine keep the emitted JSON schema a plain
// object (no anyOf), which llama.cpp's grammar builder handles.
const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to edit'),
  old_string: z.string().min(1).optional().describe('The non-empty exact string to find and replace'),
  new_string: z.string().optional().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
  edits: z.array(editSchema).min(1).max(MAX_EDITS).optional().describe(`Instead of old_string/new_string: 1-${MAX_EDITS} replacements applied in order; all are made or none`),
}).refine(input => input.edits ? input.old_string === undefined && input.new_string === undefined && input.replace_all === undefined : input.old_string !== undefined && input.new_string !== undefined,
  { message: 'Give old_string and new_string, or edits, not both.' })

type FileEditInput = z.infer<typeof inputSchema>

interface FileEditOutput {
  filePath: string
  replacements: number
  /** The file's other names (hard links) show the change too. */
  note?: string
  /** With `edits`: how many were applied (all of them). */
  edits?: number
}

type Edit = z.infer<typeof editSchema>

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 100 // 100 MB

function normalizeQuotes(s: string): string {
  return s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
}

type TextEncoding = 'utf-8' | 'utf16le' | 'utf16be'

const binary = (why: string) => `Binary file (${why}): FileEdit edits text files only. Use Bash with a binary-safe tool for byte-level changes.`
const isUtf16 = (head: Buffer) => (head[0] === 0xFF && head[1] === 0xFE) || (head[0] === 0xFE && head[1] === 0xFF)

/**
 * Why FileEdit refuses a file, from its extension and first 8 KiB alone; undefined when only the
 * full decode can tell. checkPermissions uses it too, so the user is never asked to approve an edit
 * that cannot run.
 */
function sniffRefusal(head: Buffer, ext: string): string | undefined {
  // Named as FileRead names it: the format its first bytes name, else the extension.
  if (BINARY_EXTENSIONS.has(ext)) return binary(sniffFormat(head) ?? ext)
  // FF FE 00 00 also starts like a UTF-16LE mark; read as UTF-16, an edit would break the 4-byte units.
  if ((head[0] === 0xFF && head[1] === 0xFE && head[2] === 0 && head[3] === 0) || (head[0] === 0 && head[1] === 0 && head[2] === 0xFE && head[3] === 0xFF)) {
    return 'File is UTF-32 (it starts with a UTF-32 byte order mark); FileEdit edits UTF-8 and UTF-16 only and would corrupt it. Edit it with Bash.'
  }
  // A PNG saved as .txt is named by its first bytes too.
  if (!isUtf16(head) && head.subarray(0, 8192).includes(0)) return binary(sniffFormat(head) ?? 'it contains NUL bytes')
}

/**
 * The file's text, decoded without loss, and the encoding to write it back in; or why FileEdit
 * must not touch it. A lossy decode would rewrite every byte it could not read (as U+FFFD), not
 * just the edited part, so binary files and text that is not valid UTF-8 or UTF-16 are refused.
 */
function decodeText(raw: Buffer, ext: string): { text: string; encoding: TextEncoding } | { error: string } {
  const refusal = sniffRefusal(raw, ext)
  if (refusal) return { error: refusal }
  const utf16 = (encoding: 'utf16le' | 'utf16be') => {
    if (raw.length % 2) return { error: 'File starts with a UTF-16 byte order mark but has an odd number of bytes; FileEdit would corrupt it. Edit it with Bash.' }
    // Big-endian is decoded from a byte-swapped copy (swap16 works in place).
    const bytes = encoding === 'utf16be' ? Buffer.from(raw).swap16() : raw
    return { text: bytes.toString('utf16le'), encoding }
  }
  if (raw[0] === 0xFF && raw[1] === 0xFE) return utf16('utf16le')
  if (raw[0] === 0xFE && raw[1] === 0xFF) return utf16('utf16be')
  try {
    // ignoreBOM keeps a UTF-8 byte order mark in the text, so it is written back too.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw), encoding: 'utf-8' }
  } catch {
    return { error: 'File is not valid UTF-8 (it may be Latin-1 or Windows-1252); FileEdit would corrupt the bytes it cannot read. Convert it to UTF-8 first, or edit it with Bash.' }
  }
}

function encodeText(text: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf-8') return Buffer.from(text, 'utf-8')
  const bytes = Buffer.from(text, 'utf16le')
  return encoding === 'utf16be' ? bytes.swap16() : bytes
}

/** True when `at` begins a line of `text`; the first line begins after a byte order mark, which FileRead does not show. */
const startsLine = (text: string, at: number) => at === 0 || text[at - 1] === '\n' || (at === 1 && text[0] === '\uFEFF')

/**
 * Calls `each` with each offset where `needle` occurs in `haystack`, left to right and without
 * overlaps, until it returns false. With `lineStart`, only occurrences that begin a line count.
 */
function scan(haystack: string, needle: string, lineStart: boolean, each: (at: number) => boolean | void): void {
  // An empty needle matches at every offset without moving on: the search would never end, and it is
  // synchronous, so nothing (not even Stop) could interrupt it. It matches nothing here.
  if (!needle) return
  for (let at = haystack.indexOf(needle); at !== -1;) {
    if (lineStart && !startsLine(haystack, at)) { at = haystack.indexOf(needle, at + 1); continue }
    if (each(at) === false) return
    at = haystack.indexOf(needle, at + needle.length)
  }
}

function countOccurrences(haystack: string, needle: string, lineStart: boolean): number {
  let count = 0
  scan(haystack, needle, lineStart, () => { count++ })
  return count
}

/** `text` with the first occurrence of `search` (every one with `all`) replaced, as `scan` finds them. */
function replaceOccurrences(text: string, search: string, lineStart: boolean, all: boolean, replacement: string): string {
  const parts: string[] = []
  let last = 0
  scan(text, search, lineStart, at => { parts.push(text.slice(last, at), replacement); last = at + search.length; return all })
  return parts.join('') + text.slice(last)
}

/**
 * Where `old` occurs in `text`: as given, else with curly quotes read as straight ones. With
 * `lineStart`, only where it begins a line.
 */
function find(text: string, old: string, lineStart = false): { search: string; count: number } {
  const count = countOccurrences(text, old, lineStart)
  if (count) return { search: old, count }
  let at = -1
  scan(normalizeQuotes(text), normalizeQuotes(old), lineStart, first => { at = first; return false })
  if (at < 0) return { search: old, count: 0 }
  // The quotes map one character to one, so the match is at the same place in the real text.
  const search = text.slice(at, at + old.length)
  return { search, count: countOccurrences(text, search, lineStart) }
}

const LINE_PREFIX = /^(\d+)\t/

/** True when every non-empty line starts with FileRead's line prefix (the number and a tab). */
function hasLinePrefixes(text: string): boolean {
  let any = false
  for (const line of text.split('\n')) {
    if (!line) continue
    if (!LINE_PREFIX.test(line)) return false
    any = true
  }
  return any
}

/**
 * True when `text` reads as lines copied from FileRead: every non-empty line has a prefix, and the
 * numbers count up one per line, as FileRead prints them. A blank line may have lost its "N<tab>".
 * Numbers that skip or repeat are more likely data (a TSV's id column) than copied output.
 */
function copiedFromFileRead(text: string): boolean {
  if (!hasLinePrefixes(text)) return false
  let first: number | undefined
  return text.split('\n').every((line, k) => {
    const number = LINE_PREFIX.exec(line)?.[1]
    if (number === undefined) return true
    first ??= Number(number) - k
    return Number(number) === first + k
  })
}

const stripLinePrefixes = (text: string) => text.replace(/^\d+\t/gm, '')

/** What a "not found" error quotes of the file: lines, characters in all, characters per line. */
const HINT_LINES = 8
const HINT_CHARS = 1_500
const HINT_LINE_CHARS = 200
/** Above this many lines the error skips the search for the closest text (it stays fast). */
const HINT_MAX_FILE_LINES = 200_000
const NOT_FOUND = 'String to replace not found in file.'

const squash = (line: string) => line.replace(/\s+/g, '')

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) { const gram = text.slice(i, i + 2); grams.set(gram, (grams.get(gram) ?? 0) + 1) }
  return grams
}

/** Dice similarity of two strings' character pairs, from 0 (none shared) to 1. */
function similarity(grams: Map<string, number>, size: number, text: string): number {
  const other = bigrams(text)
  let shared = 0
  for (const [gram, count] of other) shared += Math.min(count, grams.get(gram) ?? 0)
  return (2 * shared) / (size + Math.max(0, text.length - 1))
}

/**
 * The "not found" error, with where the closest text is, so the edit can be fixed without
 * reading the file again: lines that hold `old` but for whitespace, else the lines around the
 * best-matching one. Only reports: a whitespace-blind replace could silently break Python or YAML.
 */
function notFound(text: string, old: string, afterEdits: boolean): string {
  const lines = text.split('\n')
  const want = old.split('\n').map(squash)
  while (want.length && !want[0]) want.shift()
  while (want.length && !want.at(-1)) want.pop()
  if (!want.length || lines.length > HINT_MAX_FILE_LINES) return NOT_FOUND
  const squashed = lines.map(squash)
  const note = afterEdits ? ' (numbered as after the earlier edits in this call)' : ''
  const quote = (header: string, from: number, to: number) => {
    let message = header
    for (let i = from; i < to; i++) {
      const line = lines[i]!.replace(/\r$/, ''), shown = `\n${i + 1}\t${line.length > HINT_LINE_CHARS ? line.slice(0, HINT_LINE_CHARS) + '…' : line}`
      if (message.length + shown.length > HINT_CHARS) return message + '\n…'
      message += shown
    }
    return message
  }

  // Whole lines in the middle, the end of the first line and the start of the last: old_string
  // may begin and end inside a line.
  const fits = (i: number) => want.every((w, k) => {
    const line = squashed[i + k]
    if (line === undefined) return false
    if (want.length === 1) return line.includes(w)
    return k === 0 ? line.endsWith(w) : k === want.length - 1 ? line.startsWith(w) : line === w
  })
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (!fits(i)) continue
    const where = want.length === 1 ? `Line ${i + 1}` : `Lines ${i + 1}-${i + want.length}`
    return quote(`${NOT_FOUND} ${where}${note} ${want.length === 1 ? 'holds' : 'hold'} this text with different whitespace (indentation, spaces or tabs). Copy it exactly as shown:`, i, i + want.length)
  }

  // Otherwise the place most lines of old_string agree on, by the line each one would start it.
  const wanted = new Map<string, number[]>()
  want.forEach((w, k) => { if (w.length >= 4) wanted.set(w, [...wanted.get(w) ?? [], k]) })
  const votes = new Map<number, number>()
  squashed.forEach((line, i) => { for (const k of wanted.get(line) ?? []) votes.set(i - k, (votes.get(i - k) ?? 0) + 1) })
  let anchor: number | undefined, best = 0
  for (const [start, count] of votes) if (count > best || (count === best && start < anchor!)) { anchor = start; best = count }
  if (anchor === undefined) {
    // No line matches whole: the line most like the longest line of old_string.
    const k = want.reduce((longest, w, index) => w.length > want[longest]!.length ? index : longest, 0), target = want[k]!
    const grams = bigrams(target)
    let score = 0.5
    if (target.length >= 4) squashed.forEach((line, i) => {
      if (line.length < target.length / 2 || line.length > target.length * 2) return
      const s = similarity(grams, target.length - 1, line)
      if (s > score) { score = s; anchor = i - k }
    })
  }
  if (anchor === undefined) return `${NOT_FOUND} No line of it is in the file.`
  const at = Math.min(Math.max(anchor, 0), lines.length - 1), from = Math.max(at - 1, 0)
  const to = Math.min(lines.length, from + HINT_LINES, Math.max(from + 3, at + want.length + 1))
  return quote(`${NOT_FOUND} The closest text is at line ${at + 1}${note}:`, from, to)
}

/**
 * Applies `edits` in order to `text`, or says why one cannot be made (then none is). `eol` puts
 * old_string and new_string in the line ends `text` uses.
 */
function applyEdits(text: string, edits: Edit[], eol: (s: string) => string): { text: string; replacements: number } | { error: string } {
  let replacements = 0
  for (const [index, edit] of edits.entries()) {
    const fail = (error: string) => ({ error: edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ${error} No edits were made.` : error })
    if (!edit.old_string) return fail('old_string must not be empty.')
    let old = eol(edit.old_string), replacement = eol(edit.new_string)
    if (!old) return fail('old_string is empty once its line ends are removed (the file uses one kind of line end).')
    let found = find(text, old)
    // Lines copied from FileRead output with their "12<tab>" prefixes on. A copied prefix stood
    // before the start of a line, so the stripped text must begin a line too: elsewhere it is some
    // other text that merely contains it (another row of a TSV, a longer word).
    let lineStart = false, hint = old
    if (!found.count && copiedFromFileRead(old)) {
      const stripped = stripLinePrefixes(old)
      if (!stripped) return fail('old_string is empty once the FileRead line numbers are removed.')
      const strippedFound = find(text, stripped, true)
      if (strippedFound.count) {
        // new_string is stripped only when every line has a prefix; when only some do, which ones
        // are copied numbers and which are real text cannot be told apart, so nothing is guessed.
        const lines = replacement.split('\n').filter(Boolean), numbered = lines.filter(line => LINE_PREFIX.test(line)).length
        if (numbered && numbered < lines.length) {
          return fail("old_string matched once its FileRead line numbers were removed, but new_string has them on only some lines. Remove the 'N<tab>' prefixes from new_string (or put them on every line).")
        }
        // Every line numbered is copied output only when it starts at old_string's line, as a kept
        // prefix does; another number is the text's own (a TSV's id column), written as given.
        const firstNumber = (s: string) => Number(LINE_PREFIX.exec(s.split('\n').find(Boolean)!)![1])
        if (numbered && firstNumber(replacement) === firstNumber(old)) replacement = stripLinePrefixes(replacement)
        old = stripped; found = strippedFound; lineStart = true
      } else if (!find(text, stripped).count) hint = stripped
    }
    // The closest text is looked for without the line numbers, unless the stripped text is in the
    // file but not at a line start: the hint would then point at that other text.
    if (!found.count) return fail(notFound(text, hint, index > 0))
    if (found.count > 1 && !edit.replace_all) {
      return fail(`Found ${found.count} matches for old_string. Provide more context to make it unique, or set replace_all to true.`)
    }
    // Compared after line ends and line numbers are removed: an edit that would change nothing is not reported as made.
    if (edit.old_string === edit.new_string || old === replacement) return fail('old_string and new_string are identical.')
    text = replaceOccurrences(text, found.search, lineStart, !!edit.replace_all, replacement)
    replacements += edit.replace_all ? found.count : 1
  }
  return { text, replacements }
}

export const FileEditTool: Tool<FileEditInput, FileEditOutput> = {
  name: 'FileEdit',
  description: 'Replace exact strings in text files',
  inputSchema,

  async call(input, context): Promise<ToolResult<FileEditOutput>> {
    // Checked here too: direct callers skip the schema.
    if (input.edits && (input.old_string !== undefined || input.new_string !== undefined)) return { success: false, error: 'Give old_string and new_string, or edits, not both.' }
    if (!input.edits && !input.old_string) return { success: false, error: 'old_string must not be empty.' }
    if (input.edits && (!input.edits.length || input.edits.length > MAX_EDITS)) return { success: false, error: `edits must hold 1 to ${MAX_EDITS} edits.` }
    const edits: Edit[] = input.edits ?? [{ old_string: input.old_string!, new_string: input.new_string ?? '', replace_all: input.replace_all }]
    const filePath = expandPath(input.file_path, context.cwd)

    // Edits outside the project ask first (checkPermissions); '../' is an ordinary path.
    if (isUNCPath(input.file_path)) {
      return { success: false, error: 'UNC paths blocked — potential credential leak' }
    }
    const target = writeTarget(input.file_path, context.cwd)
    if (target?.secret) return { success: false, error: secretRefusal(target.resolved, 'change') }

    if (!existsSync(filePath)) {
      return { success: false, error: buildFileNotFoundMessage(input.file_path, context.cwd) }
    }

    try {
      // From the staleness check to the rename, sessions writing this file take turns.
      return await withWriteLock(filePath, (): ToolResult<FileEditOutput> => {
        const stat = statSync(filePath)
        const refused = notAFile(stat, input.file_path)
        if (refused) return { success: false, error: refused }

        // Size guard
        if (stat.size > MAX_EDIT_FILE_SIZE) {
          return {
            success: false,
            error: `File is too large to edit (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum editable size is 100MB.`,
          }
        }

        // Staleness check
        const readState = getReadFileState(context).get(filePath)
        if (readState && (stat.mtimeMs !== readState.mtime || (readState.size !== undefined && stat.size !== readState.size))) {
          return {
            success: false,
            error: `File "${input.file_path}" was modified externally since last read. Re-read before editing.`,
          }
        }

        const decoded = decodeText(readFileSync(filePath), extname(filePath).toLowerCase())
        if ('error' in decoded) return { success: false, error: decoded.error }
        const content = decoded.text

        // A CRLF file is matched in LF form, as old_string is usually written, and written back
        // CRLF. In a file with one kind of line end, a CR before a line end in old_string or
        // new_string is dropped. Mixed line ends are matched as given.
        const crlf = content.includes('\r\n') && !/(?<!\r)\n/.test(content)
        const eol = crlf || !content.includes('\r') ? (s: string) => s.replace(/\r(?=\n|$)/g, '') : (s: string) => s
        const result = applyEdits(crlf ? content.replaceAll('\r\n', '\n') : content, edits, eol)
        if ('error' in result) return { success: false, error: result.error }
        const updated = crlf ? result.text.replaceAll('\n', '\r\n') : result.text

        // Written back in the file's own encoding (and byte order mark): only the edited text changes.
        const { otherNames } = safeWriteFile(filePath, encodeText(updated, decoded.encoding))

        // Update read state with new mtime
        const written = statSync(filePath)
        trackFileRead(filePath, written.mtimeMs, 0, Infinity, context, written.size)
        const note = otherNamesNote(otherNames)

        return {
          success: true,
          output: {
            filePath: input.file_path,
            replacements: result.replacements,
            ...(input.edits ? { edits: edits.length } : {}),
            ...(note ? { note } : {}),
          },
        }
      })
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    if (isUNCPath(input.file_path)) return { decision: 'deny', reason: 'UNC paths are blocked: they can leak network credentials.' }
    const target = writeTarget(input.file_path, context.cwd)
    if (!target) return { decision: 'deny', reason: 'Invalid file path (it contains a null byte).' }
    if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
    // A file call() always refuses is refused before anyone is asked.
    const filePath = expandPath(input.file_path, context.cwd)
    try { const refused = notAFile(statSync(filePath), input.file_path); if (refused) return { decision: 'deny', reason: refused } } catch { /* Missing: call() says so. */ }
    const head = await readHead(filePath)
    const refusal = head && sniffRefusal(head, extname(filePath).toLowerCase())
    if (refusal) return { decision: 'deny', reason: refusal }
    // The approval names where the edit really lands when that is outside the project (a symlink included).
    return { decision: 'ask', reason: target.inside ? writeApprovalReason(input.file_path, context.cwd) ?? 'File edit requires user approval' : writeOutsideReason(target) }
  },

  prompt(): string {
    return 'FileEdit: Replace exact strings in text files (UTF-8 or UTF-16; binary files are refused). For several changes to one file, pass edits instead of old_string/new_string: they apply in order, and all are made or none. 100MB size limit.'
  },
}
