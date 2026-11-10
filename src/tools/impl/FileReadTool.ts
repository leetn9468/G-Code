/**
 * @file FileReadTool.ts
 * @brief Read file contents with line range, encoding detection, binary check, dedup
 */

import { open, readFile, stat as statFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult, FileReadRecord, ReadFileState } from '../tool.js'
import { expandPath, isUNCPath } from '../../utils/path.js'
import { readScope, secretRefusal } from '../permissions.js'
import { pathTarget } from '../../session/scopedPermission.js'
import { buildFileNotFoundMessage } from '../../utils/fileSuggestions.js'
import { checkImage, imageShownSize, IMAGE_REQUEST_RESERVE } from '../../llm/images.js'
import type { VisionCapabilities } from '../../llm/types.js'
import { headUnits } from '../../utils/textUnits.js'
import { MAX_TOOL_RESULT_CHARS } from '../../engine/microcompact.js'
import { maskSecretsInCutText } from '../../security/secretValues.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().int().nonnegative().optional().describe('Line number to start from (1-based). A read that stops early ends with the offset to continue from.'),
  limit: z.number().int().positive().optional().describe('Number of lines to read (default 2000; one call returns at most about 31,000 characters)'),
})

type FileReadInput = z.infer<typeof inputSchema>

interface FileReadOutput {
  filePath: string
  content: string
  numLines: number
  startLine: number
  totalLines: number
}

const DEFAULT_LIMIT = 2000
/**
 * Characters of numbered lines one read returns. With the closing note the result stays under
 * microcompact's cap, so the engine never cuts a fresh read in the middle of a line.
 */
const MAX_OUTPUT_CHARS = MAX_TOOL_RESULT_CHARS - 1_000
/** Extensions FileRead refuses as binary (FileEdit refuses them too). */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.wasm', '.pyc', '.class',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
])

/** Above this size a text file is scanned in chunks, so memory stays flat however large it is. */
const STREAM_READ_BYTES = 32 * 1024 * 1024
/** Bytes kept of one line while scanning: enough for any UTF-8 text to fill one read's output. */
const STREAM_LINE_BYTES = (MAX_OUTPUT_CHARS + 1) * 4
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const HEAD_BYTES = 8192

/**
 * Why a file tool does not open this: opening a named pipe waits for a writer that may never come,
 * and a terminal or a device such as /dev/stdin never ends or takes someone's input. Undefined for a
 * regular file, a folder (each tool has its own words) and /dev/null, which is simply empty.
 */
export function notAFile(stat: { isFile(): boolean; isDirectory(): boolean; isFIFO(): boolean; isSocket(): boolean }, shown: string, path?: string): string | undefined {
  if (stat.isFile() || stat.isDirectory() || path === '/dev/null') return undefined
  const kind = stat.isFIFO() ? 'a named pipe' : stat.isSocket() ? 'a socket' : 'a device'
  return `"${shown}" is ${kind}, not a regular file: reading it could wait forever, so it was not opened. If you mean to read it, use Bash with a timeout.`
}

/** The first 8 KiB of a file; undefined when it cannot be opened, or is not a regular file. */
export async function readHead(path: string): Promise<Buffer | undefined> {
  try {
    if (!(await statFile(path)).isFile()) return undefined
    const handle = await open(path, 'r')
    try { const head = Buffer.alloc(HEAD_BYTES); return head.subarray(0, (await handle.read(head, 0, head.length, 0)).bytesRead) } finally { await handle.close() }
  } catch { return undefined }
}

const hasUtf16Bom = (head: Buffer) => (head[0] === 0xFF && head[1] === 0xFE) || (head[0] === 0xFE && head[1] === 0xFF)

/** A binary format named by its first bytes (magic numbers), whatever the file's extension. */
export function sniffFormat(head: Buffer): string | undefined {
  const at = (start: number, text: string) => head.toString('latin1', start, start + text.length) === text
  if (at(0, '\x89PNG\r\n')) return 'PNG image'
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'JPEG image'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'GIF image'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'WebP image'
  if (at(4, 'ftyp')) {
    const brand = head.toString('latin1', 8, 12)
    return /^(?:hei[cxms]|hev[cxms]|mif1|msf1)$/.test(brand) ? 'HEIC image' : /^avi[fs]$/.test(brand) ? 'AVIF image' : 'MP4/QuickTime media'
  }
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return 'TIFF image'
  if (at(0, 'SQLite format 3\0')) return 'SQLite database'
  if (at(0, '%PDF-')) return 'PDF document'
  if (at(0, 'PK\x03\x04')) return 'ZIP archive'
  if (head[0] === 0x1F && head[1] === 0x8B) return 'gzip archive'
  if (at(0, '\x7FELF') || [0xFEEDFACF, 0xCFFAEDFE, 0xFEEDFACE, 0xCEFAEDFE, 0xCAFEBABE].includes(head.length >= 4 ? head.readUInt32BE(0) : 0)) return 'executable'
}

/** Why FileRead will not show a binary file as text, and what to use instead. */
function binaryRefusal(format: string | undefined): string {
  const next = format === 'HEIC image' || format === 'AVIF image' || format === 'TIFF image'
    ? ' Convert it to PNG or JPEG first (on macOS: sips -s format png <file> --out <file>.png), then read that.'
    : format === 'SQLite database' ? ' Query it with Bash (sqlite3).' : ' Use Bash with a binary-safe tool (file, xxd, strings) to inspect it.'
  return `Binary file (${format ?? 'it contains NUL bytes'}): FileRead shows text only.${next}`
}

/**
 * Lines from `offset` (0-based) of a large UTF-8 file, scanned in 1 MiB chunks: every line is
 * counted, but only up to `limit` lines and about one read's worth of characters are kept, each
 * cut at STREAM_LINE_BYTES. `firstBytes` is the full length of the first kept line.
 */
async function scanLines(filePath: string, offset: number, limit: number): Promise<{ lines: string[]; totalLines: number; firstBytes: number }> {
  const lines: string[] = []
  let line = 0, parts: Buffer[] = [], kept = 0, bytes = 0, chars = 0, firstBytes = 0, lastByte = 10
  const keeping = () => line >= offset && lines.length < limit && chars <= MAX_OUTPUT_CHARS
  const endLine = () => {
    if (keeping()) {
      const text = Buffer.concat(parts).toString('utf-8')
      if (!lines.length) firstBytes = bytes
      lines.push(text); chars += text.length + 1
    }
    line++; parts = []; kept = 0; bytes = 0
  }
  const handle = await open(filePath, 'r'), chunk = Buffer.alloc(1024 * 1024)
  try {
    for (let n: number; (n = (await handle.read(chunk, 0, chunk.length, null)).bytesRead) > 0;) {
      const view = chunk.subarray(0, n)
      for (let start = 0; start < n;) {
        const newline = view.indexOf(10, start), end = newline < 0 ? n : newline
        const room = Math.min(end - start, STREAM_LINE_BYTES - kept)
        if (room > 0 && keeping()) { parts.push(Buffer.from(view.subarray(start, start + room))); kept += room }
        bytes += end - start
        if (newline < 0) break
        endLine(); start = newline + 1
      }
      lastByte = view[n - 1]!
    }
    // A final newline ends the last line; it does not start another one (wc -l counts the same).
    if (lastByte !== 10) endLine()
  } finally { await handle.close() }
  return { lines, totalLines: line, firstBytes }
}

// Read-file state for dedup + staleness detection. Each QueryEngine passes its
// own map in ToolUseContext; the shared fallback only serves callers that run
// tools without an engine (direct calls, scripts).
const fallbackReadFileState: ReadFileState = new Map()

export function createReadFileState(): ReadFileState {
  return new Map()
}

function readFileStateFor(context?: Pick<ToolUseContext, 'readFileState'>): ReadFileState {
  return context?.readFileState ?? fallbackReadFileState
}

export function getReadFileState(context?: Pick<ToolUseContext, 'readFileState'>): ReadonlyMap<string, FileReadRecord> {
  return readFileStateFor(context)
}

export function trackFileRead(filePath: string, mtime: number, offset: number, limit: number, context?: Pick<ToolUseContext, 'readFileState'>, size?: number): void {
  readFileStateFor(context).set(filePath, { mtime, offset, limit, ...(size !== undefined ? { size } : {}) })
}

// Paths whose last FileRead result is still in the conversation the model is sent. Only these
// may be answered with the "unchanged" stub; the mtime records stay for FileEdit/FileWrite.
const deliveredReads = new WeakMap<ReadFileState, Set<string>>()
function delivered(state: ReadFileState): Set<string> {
  let paths = deliveredReads.get(state)
  if (!paths) deliveredReads.set(state, paths = new Set())
  return paths
}

/**
 * The engine calls this when earlier tool results leave the context or are cut (microcompact,
 * compaction, context collapse, /compact, handoff): the next FileRead of any file returns its
 * content again instead of "[File unchanged since last read]". Freshness checks are unaffected.
 */
export function invalidateFileReadDedup(state: ReadFileState): void {
  deliveredReads.get(state)?.clear()
}

/**
 * What one more image of this size does to the conversation's image budget. Only an image too
 * large for any request is refused; past the model's image count or request size the engine drops
 * the oldest images before the next request (fitImages), so the note says so.
 */
function imageBudget(vision: VisionCapabilities, base64Bytes: number): { refusal?: string; note?: string } {
  const MiB = 1024 * 1024
  if (base64Bytes + IMAGE_REQUEST_RESERVE > vision.maxRequestBytes) return { refusal: `Not read: this image (${(base64Bytes / MiB).toFixed(1)} MiB as sent) is over the model's ${vision.maxRequestBytes / MiB} MiB request limit by itself. Resize or compress it first.` }
  const held = vision.inContext?.()
  if (held && (held.images + 1 > vision.maxImages || held.bytes + base64Bytes + IMAGE_REQUEST_RESERVE > vision.maxRequestBytes)) {
    return { note: `The conversation already holds ${held.images} images, more than one request to this model carries with this one, so the oldest images are dropped from it to make room.` }
  }
  return {}
}

export const FileReadTool: Tool<FileReadInput, FileReadOutput> = {
  name: 'FileRead',
  description: 'Read file contents with optional line range',
  inputSchema,

  async call(input, context): Promise<ToolResult<FileReadOutput>> {
    // Security checks. Reads outside the project ask first (checkPermissions); '../' is an ordinary path.
    if (isUNCPath(input.file_path)) {
      return { success: false, error: 'UNC paths (\\\\) blocked — potential credential leak' }
    }

    const filePath = expandPath(input.file_path, context.cwd)
    // G-Code's own settings and key files stay closed, also to a caller that skips checkPermissions.
    const target = pathTarget(filePath, context.cwd)
    if (target.secret) return { success: false, error: secretRefusal(target.resolved) }

    try {
      // Asynchronous IO throughout, so reads that run in parallel overlap.
      const stat = await statFile(filePath)
      if (stat.isDirectory()) {
        return { success: false, error: `"${input.file_path}" is a directory, not a file` }
      }
      const refused = notAFile(stat, input.file_path, target.resolved)
      if (refused) return { success: false, error: refused }

      // Binary file check: by extension, then by content (the extension may be missing or wrong).
      const ext = extname(filePath).toLowerCase()
      const opened = await readHead(filePath), head = opened ?? Buffer.alloc(0), format = sniffFormat(head)
      const imageFormat = /^(?:PNG|JPEG|GIF|WebP) image$/.test(format ?? '') ? format : undefined
      if (context.vision && (IMAGE_EXTENSIONS.has(ext) || imageFormat)) {
        if (stat.size > context.vision.maxBytes) return { success: false, error: `Image is ${(stat.size / (1024 * 1024)).toFixed(1)} MiB, over the ${context.vision.maxBytes / (1024 * 1024)} MiB inline limit. Resize or compress the image.` }
        // The image's data is checked here, once: a damaged file is refused before it enters the conversation.
        const bytes = await readFile(filePath), info = checkImage(bytes, context.vision, { deep: true })
        const budget = imageBudget(context.vision, Math.ceil(bytes.length / 3) * 4)
        if (budget.refusal) return { success: false, error: budget.refusal }
        // The model sees a large image shrunk; without that size it mixes up the two coordinate spaces.
        // The label keeps its exact form: recovery reads the file's path from it.
        const shown = imageShownSize(info.width, info.height, context.vision)
        const notes = [
          shown.width < info.width ? `Shown to you at about ${shown.width}×${shown.height}: positions you see are in that smaller size; multiply them by ${(info.width / shown.width).toFixed(2)} for the file's pixels.` : '',
          budget.note ?? '',
        ].filter(Boolean).join(' ')
        return { success: true, contentBlocks: [
          { type: 'text', text: `Image: ${input.file_path} (${info.width}×${info.height})` },
          ...(notes ? [{ type: 'text' as const, text: notes }] : []),
          { type: 'image', source: { type: 'base64', media_type: info.mediaType, data: bytes.toString('base64') } },
        ] }
      }
      // Not binary to the model, only unseen: say why, so it does not hunt for a decoder. Named as
      // a binary file is named: the format its bytes name (a PNG saved as .txt), else the extension.
      if (IMAGE_EXTENSIONS.has(ext) || imageFormat) {
        return { success: false, error: `Image file (${imageFormat ?? ext}): the current model cannot receive images, so FileRead cannot show it. Use Bash (file, sips -g pixelWidth -g pixelHeight) for its size and metadata.` }
      }
      // By extension too, and worded as the content check words it: the format when its bytes name one.
      if (BINARY_EXTENSIONS.has(ext)) return { success: false, error: binaryRefusal(format ?? ext) }
      if (format || (!hasUtf16Bom(head) && head.includes(0))) return { success: false, error: binaryRefusal(format) }

      // Dedup: skip if same file at same mtime with same range
      const offset = Math.max(0, (input.offset ?? 1) - 1)
      const limit = input.limit ?? DEFAULT_LIMIT
      const state = readFileStateFor(context)
      const prev = state.get(filePath)
      if (prev && delivered(state).has(filePath) && prev.mtime === stat.mtimeMs && (prev.size === undefined || prev.size === stat.size) && prev.offset === offset && prev.limit === limit) {
        return {
          success: true,
          output: {
            filePath: input.file_path,
            content: '[File unchanged since last read]',
            numLines: 0,
            startLine: offset + 1,
            totalLines: 0,
          },
        }
      }

      // The lines from the offset on, and how long the first one is. A large file is scanned in chunks.
      let lines: string[], totalLines: number, firstLength: string
      if (stat.size > STREAM_READ_BYTES) {
        const mib = (stat.size / 1024 / 1024).toFixed(0)
        if (hasUtf16Bom(head)) return { success: false, error: `This UTF-16 file is too large for FileRead (${mib} MiB). Use Bash, for example: iconv -f UTF-16 -t UTF-8 <file> | sed -n '1,200p'` }
        const scan = await scanLines(filePath, offset, limit)
        lines = scan.lines; totalLines = scan.totalLines; firstLength = `${scan.firstBytes.toLocaleString('en-US')} bytes`
      } else {
        // Encoding detection: check for UTF-16 BOM. A file shorter than the head was read whole already.
        const rawBuffer = opened && opened.length < HEAD_BYTES ? opened : await readFile(filePath)
        let raw: string
        if (rawBuffer[0] === 0xFF && rawBuffer[1] === 0xFE) {
          raw = rawBuffer.toString('utf16le')
        } else if (rawBuffer[0] === 0xFE && rawBuffer[1] === 0xFF) {
          raw = rawBuffer.swap16().toString('utf16le')
        } else {
          raw = rawBuffer.toString('utf-8')
        }
        // A final newline ends the last line; it does not start another one (wc -l counts the same).
        const allLines = raw.split('\n')
        if (allLines.at(-1) === '') allLines.pop()
        totalLines = allLines.length
        lines = allLines.slice(offset, offset + limit)
        firstLength = `${(lines[0]?.length ?? 0).toLocaleString('en-US')} characters`
      }
      const notice = (content: string): ToolResult<FileReadOutput> => ({ success: true, output: { filePath: input.file_path, content, numLines: 0, startLine: offset + 1, totalLines } })
      if (totalLines === 0) {
        trackFileRead(filePath, stat.mtimeMs, offset, limit, context, stat.size)
        return notice('[The file is empty: 0 lines.]')
      }
      if (offset >= totalLines) {
        return notice(`[Offset ${offset + 1} is past the end of the file: it has ${totalLines} line${totalLines === 1 ? '' : 's'}. Use an offset from 1 to ${totalLines}.]`)
      }

      // Whole numbered lines up to the line limit and the output cap.
      const end = Math.min(totalLines, offset + limit)
      const numberedLines: string[] = []
      let chars = 0
      let longLine = false
      for (let index = offset; index < end && index - offset < lines.length; index++) {
        const line = `${index + 1}\t${lines[index - offset]}`
        const cost = line.length + (numberedLines.length ? 1 : 0)
        if (chars + cost > MAX_OUTPUT_CHARS) {
          // One line longer than the cap: show its start rather than nothing.
          // Masked before the cut: a key across it would no longer read as a key.
          if (!numberedLines.length) { numberedLines.push(headUnits(maskSecretsInCutText(line, 'end'), MAX_OUTPUT_CHARS)); longLine = true }
          break
        }
        numberedLines.push(line)
        chars += cost
      }
      const last = offset + numberedLines.length // 1-based number of the last line shown
      let numbered = numberedLines.join('\n')
      // Only the content reaches the model, so a partial read says what it left out and how to continue.
      if (longLine) {
        numbered += `\n\n[Line ${offset + 1} is ${firstLength} long; only its start is shown. Use Bash (for example cut -c or head -c) to read the rest of it.${last < totalLines ? ` The file has ${totalLines} lines; call FileRead with offset=${last + 1} for the next one.` : ''}]`
      } else if (offset > 0 || last < totalLines) {
        const capped = last < end ? ` One call returns at most about ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters.` : ''
        numbered += last < totalLines
          ? `\n\n[Showing lines ${offset + 1}-${last} of ${totalLines}. ${totalLines - last} more line${totalLines - last === 1 ? '' : 's'}: call FileRead with offset=${last + 1} to continue.${capped}]`
          : `\n\n[Showing lines ${offset + 1}-${last} of ${totalLines}: the end of the file.]`
      }

      // Track read state
      trackFileRead(filePath, stat.mtimeMs, offset, limit, context, stat.size)
      delivered(state).add(filePath)

      return {
        success: true,
        output: {
          filePath: input.file_path,
          content: numbered,
          numLines: numberedLines.length,
          startLine: offset + 1,
          totalLines,
        },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT')) {
        return { success: false, error: buildFileNotFoundMessage(input.file_path, context.cwd) }
      }
      return { success: false, error: msg }
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    if (isUNCPath(input.file_path)) return { decision: 'deny', reason: 'UNC paths (\\\\) are blocked: they can leak network credentials.' }
    // Inside the project: allowed. Outside it (by real path, so symlinks count): ask. G-Code's key files: refused.
    return readScope('FileRead', input, context.cwd) ?? { decision: 'allow', reason: 'Read-only operation' }
  },

  prompt(): string {
    return 'FileRead: Read numbered text lines with optional offset/limit, or PNG/JPEG/GIF/WebP images when the selected model supports vision (at most 20 images stay in the conversation: past that the oldest are dropped, so crop or combine images rather than reading many; a large image is shown to you shrunk, and the result gives that size). SVG is text. Oversized images must be resized first. One call returns up to 2000 lines and at most about 31,000 characters; a read that stops before the end of the file ends with "[Showing lines X-Y of N …]" and the offset to continue from. Reading a file outside the project asks the user first.'
  },
}
