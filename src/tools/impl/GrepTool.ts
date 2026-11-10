/**
 * @file GrepTool.ts
 * @brief Regex search in files/directories via ripgrep or fallback
 */


import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { SEARCH_SKIPPED_DIRS, targetsDir } from '../../utils/path.js'
import { runSubprocess, type SubprocessResult } from '../../utils/subprocess.js'
import { fileId, gcodeSecretGlobs, gcodeSecretIds, gcodeSecretMatcher, gcodeSecretsWithin, pathTarget } from '../../session/scopedPermission.js'
import { readScope, secretRefusal } from '../permissions.js'

// No executable probes during module evaluation: the guard is configured after imports.

const inputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search in (default: the project). Searching outside the project asks the user first.'),
  glob: z.string().optional().describe('Glob pattern to filter files'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('files_with_matches (default): matching files; content: matching lines; count: matching lines per file'),
  '-i': z.boolean().optional().describe('Case insensitive'),
  '-C': z.number().int().min(0).max(20).optional().describe('Lines of context before and after each match (content mode)'),
  head_limit: z.number().optional().describe('Max results to return: files, lines or per-file counts (default 250; 0 means no limit). A cut result says how many there were.'),
})

type GrepInput = z.infer<typeof inputSchema>

interface GrepOutput {
  mode: string
  numFiles: number
  filenames: string[]
  content?: string
  numMatches?: number
  /** Results found before head_limit cut them (files, lines or per-file counts, by mode). */
  total?: number
  truncated?: boolean
}

const DEFAULT_LIMIT = 250
const TIMEOUT_MS = 20_000
/** ripgrep output kept in memory (UTF-16 units); lines past it are still counted. */
const MAX_RG_OUTPUT = 8_000_000
/** Results the JS fallback collects before it stops looking. */
const MAX_BUILTIN_RESULTS = 100_000

export const GrepTool: Tool<GrepInput, GrepOutput> = {
  name: 'Grep',
  description: 'Search file contents using regex patterns',
  inputSchema,

  async call(input, context): Promise<ToolResult<GrepOutput>> {
    const searchPath = resolve(context.cwd, input.path ?? '.')
    // G-Code's own settings and key files stay closed, also to a caller that skips checkPermissions.
    const target = pathTarget(searchPath, context.cwd)
    if (target.secret) return { success: false, error: secretRefusal(target.resolved) }
    const locked = unreadableFolder(searchPath, input.path ?? '.')
    if (locked) return { success: false, error: locked }
    const mode = input.output_mode ?? 'files_with_matches'
    const limit = input.head_limit === undefined ? DEFAULT_LIMIT : input.head_limit > 0 ? Math.floor(input.head_limit) : Infinity

    // Try ripgrep first, fallback to built-in
    try {
      return await runRipgrep(input, searchPath, mode, limit, context.cwd, context.signal)
    } catch {
      return runBuiltinGrep(input, searchPath, mode, limit, context.cwd)
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    // Inside the project: allowed. Outside it (by real path, so symlinks count): ask. G-Code's key files: refused.
    return readScope('Grep', input, context.cwd) ?? { decision: 'allow', reason: 'Read-only search operation' }
  },

  prompt(): string {
    return `Grep: Search file contents using regex. Supports ripgrep for speed. Returns at most head_limit results (default ${DEFAULT_LIMIT}; 0 = no limit), and says when it cut the list. Searching outside the project asks the user first.`
  },
}

let pinnedRg: { path: string; usable: boolean } | undefined

/**
 * The ripgrep to run: GCODE_RG_PATH when it names an executable file (the desktop app sets it to
 * the copy it bundles), else rg from PATH. Glob shares it. Checked once per value, at call time.
 */
export function ripgrepPath(): string {
  const path = process.env.GCODE_RG_PATH
  if (!path) return 'rg'
  if (pinnedRg?.path !== path) {
    let usable = false
    try { usable = isAbsolute(path) && statSync(path).isFile(); if (usable) accessSync(path, constants.X_OK) } catch { usable = false }
    pinnedRg = { path, usable }
  }
  return pinnedRg.usable ? path : 'rg'
}

/**
 * Why a folder cannot be searched at all, or undefined. ripgrep cannot even start in such a folder,
 * and the built-in search skips what it cannot read: both would read as nothing being there.
 */
export function unreadableFolder(path: string, shown: string): string | undefined {
  try { if (!statSync(path).isDirectory()) return undefined; accessSync(path, constants.R_OK | constants.X_OK); return undefined }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    return `Cannot read the folder ${shown}: ${code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code ?? 'it could not be opened'}. This does not mean there is nothing in it.`
  }
}

/** The first lines of ripgrep's error output, short enough for a tool result. Glob shares it. */
export function rgError(stderr: string): string {
  const lines = stderr.trim().split('\n').map(line => line.trim()).filter(Boolean)
  const shown = lines.slice(0, 6).join('\n')
  return shown.length > 1200 ? shown.slice(0, 1200) + '…' : shown
}

/**
 * True when every error in ripgrep's `stderr` is a file or folder it could not open ("… (os error 13)"),
 * so the search ran and its result is partial. Anything else (a bad pattern or glob) is an error.
 * It reads every line, not the shortened rgError text, whose cut would hide the last one.
 */
export function onlyUnreadable(stderr: string): boolean {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(line => /\(os error \d+\)$/.test(line))
}

/**
 * How a ripgrep run ended when that was not an answer (exit 0, found; exit 1, nothing found; exit 2,
 * reported in its own words): killed by a signal, its status lost, another exit code. Glob shares it.
 */
export function rgDied(run: SubprocessResult): string | undefined {
  if (run.timedOut || run.interrupted) return undefined
  if (run.exitCode === 0 || run.exitCode === 1 || run.exitCode === 2) return undefined
  const how = run.signal ? `was killed by ${run.signal}` : run.exitCode !== null ? `exited with code ${run.exitCode}` : 'ended without reporting how'
  const said = rgError(run.stderr)
  return `ripgrep ${how}${said ? `: ${said}` : ''}`
}

/** What became of a search that did not run to its end, for a result that has found nothing or something. */
export function rgStopped(run: SubprocessResult, timeoutMs: number): string | undefined {
  if (run.timedOut) return `The search stopped after ${timeoutMs / 1000} seconds`
  if (run.interrupted) return 'The search was stopped before it finished'
  return rgDied(run)
}

/** Most characters Grep's result holds: far more than the model can use, far under V8's string limit. */
const MAX_RESULT_CHARS = 2 ** 25

/** `lines` joined with newlines, ending before the first line that would pass MAX_RESULT_CHARS. */
function joinWithinLimit(lines: string[]): { text: string; cut: boolean } {
  let size = 0
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + (i > 0 ? 1 : 0)
    if (size > MAX_RESULT_CHARS) return { text: lines.slice(0, i).join('\n'), cut: true }
  }
  return { text: lines.join('\n'), cut: false }
}

/**
 * The result the model reads, the same for ripgrep and the fallback. `lines` are every result
 * found, already relative to the project (`path`, `path:line:text` or `path:count`); `total`
 * counts results that were found but not kept in memory. With context lines, `paths` names each
 * line's file ('' for a "--" group separator), since `path-12-text` cannot be split reliably.
 */
function grepResult(input: GrepInput, mode: string, lines: string[], total: number, limit: number, notes: string[], paths?: string[]): ToolResult<GrepOutput> {
  const shown = lines.length > limit ? lines.slice(0, limit) : lines
  const truncated = total > shown.length
  const unit = mode === 'content' ? paths ? 'lines' : 'matching lines' : 'files'
  const all: string[] = []
  if (truncated) all.push(`[Showing ${shown.length} of ${total} ${unit}. Raise head_limit (0 = no limit), or narrow the pattern, path or glob.]`)
  all.push(...notes)
  const where = `${input.path ?? '.'}${input.glob ? ` (files matching ${input.glob})` : ''}`
  const joined = joinWithinLimit(shown)
  if (joined.cut) all.push('[The output was too long and was cut; narrow the search.]')
  let numMatches: number | undefined
  let numFiles = mode === 'files_with_matches' ? shown.length : 0
  let text = joined.text
  if (mode === 'count') {
    numMatches = lines.reduce((sum, line) => { const n = parseInt(line.split(':').pop() ?? '0', 10); return sum + (isNaN(n) ? 0 : n) }, 0)
    numFiles = lines.length
    if (numFiles > 1) text += `\n\n${numMatches} matching lines in ${numFiles} files`
  } else if (mode === 'content') {
    numFiles = paths ? new Set(paths.slice(0, shown.length).filter(Boolean)).size : new Set(shown.map(line => line.split(':')[0])).size
  }
  if (!lines.length && !total) text = `No matches for ${JSON.stringify(input.pattern)} in ${where}`
  const content = [text, ...all].filter(Boolean).join('\n\n')
  return {
    success: true,
    output: {
      mode, numFiles, filenames: mode === 'files_with_matches' ? shown : [], content,
      ...(numMatches !== undefined ? { numMatches } : {}),
      ...(truncated ? { total, truncated } : {}),
    },
  }
}

async function runRipgrep(
  input: GrepInput,
  searchPath: string,
  mode: string,
  limit: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<ToolResult<GrepOutput>> {
  const args = ['--hidden', '--max-columns', '500', '--no-heading']

  if (input['-i']) args.push('-i')
  if (input.glob) args.push('--glob', input.glob)
  // G-Code's own folder and version-control internals (.git …) stay out unless the path or glob names them.
  // Later globs win in ripgrep, so these exclusions hold even when the glob above matches inside them.
  for (const dir of SEARCH_SKIPPED_DIRS) if (!targetsDir(cwd, searchPath, dir, input.glob)) args.push('--glob', `!${dir}`)
  const contextLines = mode === 'content' ? input['-C'] ?? 0 : 0
  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  else args.push('-n')
  // With context, a NUL ends each path (path\0 12:text, path\0 11-text): a dash in a file name
  // cannot be told from the context separator otherwise.
  if (contextLines) args.push('-C', String(contextLines), '--null')

  // ripgrep anchors a glob with a slash (.gcode/memory/*.md, src/**/*.ts) at its own working
  // directory, and only when that is the real path; a cwd reached through a symlink (/tmp on
  // macOS) matched nothing. Searching a folder from inside it anchors globs there, as Glob does.
  let inDir = false
  try { inDir = statSync(searchPath).isDirectory() } catch { /* rg reports a missing path itself. */ }
  // G-Code's settings and key files never come back, whatever the path and glob (a file path to one was refused already).
  const root = inDir ? pathTarget(searchPath, cwd).resolved : ''
  if (inDir) for (const glob of gcodeSecretGlobs(root)) args.push('--glob', glob)
  // `-e` keeps a pattern that starts with a dash a pattern.
  args.push('-e', input.pattern, inDir ? '.' : searchPath)
  const base = inDir ? searchPath : cwd
  // Lines start with a path relative to `base` (./src/app.ts:3:…); they are shown relative to the
  // project by prefix only, so the matched text after the path is never rewritten.
  const prefix = relative(cwd, base)
  const fromBase = (line: string) => {
    if (!inDir) return line.startsWith(searchPath) ? (relative(cwd, searchPath) || searchPath) + line.slice(searchPath.length) : line
    const rest = line.replace(/^\.[\\/]/, '')
    return prefix ? prefix + sep + rest : rest
  }
  // The exclusions above already keep these out; a second look never costs a leak.
  const secrets = inDir ? gcodeSecretsWithin(root) : []
  const isSecret = (line: string) => {
    const rest = line.replace(/^\.[\\/]/, '')
    return secrets.some(secret => rest === secret || rest.startsWith(secret + ':') || rest.startsWith(secret + '/'))
  }

  // Bun.spawn under Bun, and a liveness poll: a lost 'close' cannot hang the search (see subprocess.ts).
  // Output past MAX_RG_OUTPUT is dropped, but its lines are still counted for the total.
  let outputLines = 0
  const run = await runSubprocess([ripgrepPath(), ...args], {
    cwd: base, env: process.env, timeoutMs: TIMEOUT_MS, maxOutput: MAX_RG_OUTPUT,
    // A stop reaches it, and it does not outlive this process: a blocked search would otherwise run on for good.
    signal, killOnExit: true,
    onData: (stream, chunk) => { if (stream === 'stdout') for (const byte of chunk) if (byte === 10) outputLines++ },
  })
  // No ripgrep: the JS fallback (call() catches this).
  if (run.spawnError !== undefined) throw new Error(`ripgrep not available: ${run.spawnError}`)
  const errors = rgError(run.stderr)
  // Exit 2 is an error (a bad regex, a missing path); with nothing found it is the result, not "no matches".
  // Only files ripgrep could not open in an existing folder ("… (os error 13)") leave a partial search.
  const unreadableOnly = inDir && onlyUnreadable(run.stderr)
  if (run.exitCode === 2 && !run.stdout.trim() && !unreadableOnly) return { success: false, error: `ripgrep: ${errors || 'search failed'}` }
  // A search that did not run to its end has found nothing yet; that does not mean there is nothing.
  const stopped = rgStopped(run, TIMEOUT_MS)
  if (stopped && !run.stdout.trim()) return { success: false, error: `${stopped}, with nothing found so far. This does not mean there are no matches: narrow the path or glob, or search with Bash.` }
  const lines = run.stdout.split('\n')
  // A cut output ends in the middle of a line.
  if (run.truncated.stdout || !run.stdout.endsWith('\n')) lines.pop()
  // Another name for a key file (a hard link) is only known by its inode: in a folder search, look up
  // each result's file when such a link exists (a file path to one was refused already).
  const linked = inDir ? gcodeSecretIds(true) : new Set<string>()
  const isLinkedSecret = (line: string) => {
    // The path ends at the first colon that leaves an existing file (content and count lines), or at the end (file lists).
    for (let colon = line.indexOf(':'); ; colon = line.indexOf(':', colon + 1)) {
      const id = fileId(resolve(base, colon < 0 ? line : line.slice(0, colon)))
      if (id) return linked.has(id)
      if (colon < 0) return false
    }
  }
  let found: string[], paths: string[] | undefined
  if (contextLines) {
    // Lines without a NUL are "--" separators, or a single file's lines (ripgrep prints no path then).
    const file = inDir ? '' : relative(cwd, searchPath) || searchPath
    found = []; paths = []
    for (const line of lines) {
      if (!line) continue
      const nul = line.indexOf('\0')
      if (nul < 0) { found.push(line); paths.push(line === '--' ? '' : file); continue }
      const path = line.slice(0, nul), rest = line.slice(nul + 1)
      if (isSecret(path) || (linked.size && isLinkedSecret(path))) continue
      const shown = fromBase(path)
      found.push(`${shown}${/^\d+:/.test(rest) ? ':' : '-'}${rest}`); paths.push(shown)
    }
  } else found = lines.filter(line => line && !isSecret(line) && !(linked.size && isLinkedSecret(line))).map(fromBase)
  const total = run.truncated.stdout ? Math.max(outputLines, found.length) : found.length
  const notes: string[] = []
  if (stopped) notes.push(`[${stopped}, so these results are incomplete. Narrow the path or glob.]`)
  if (run.exitCode === 2 && errors) notes.push(`[ripgrep reported errors, so results may be incomplete: ${errors}]`)
  return grepResult(input, mode, found, total, limit, notes, paths)
}

function runBuiltinGrep(
  input: GrepInput,
  searchPath: string,
  mode: string,
  limit: number,
  cwd: string,
): ToolResult<GrepOutput> {
  const flags = input['-i'] ? 'i' : ''
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, flags)
  } catch (err) {
    return { success: false, error: `Invalid regex: ${err}` }
  }

  const results: string[] = []
  const contextLines = mode === 'content' ? input['-C'] ?? 0 : 0
  /** With context: each result's file, '' for a "--" separator (see grepResult). */
  const paths: string[] | undefined = contextLines ? [] : undefined
  let more = false
  const isSecret = gcodeSecretMatcher(searchPath), linked = gcodeSecretIds(true)

  /** Matching lines with `contextLines` around them, as ripgrep prints them: "--" between groups. */
  function pushContext(lines: string[], rel: string): void {
    const matched = new Set<number>()
    for (let i = 0; i < lines.length; i++) if (regex.test(lines[i]!)) matched.add(i)
    // A final newline ends the last line; it does not start another one.
    const last = lines.at(-1) === '' ? lines.length - 2 : lines.length - 1
    let printed = -1
    for (const index of matched) {
      if (index > last) break
      const from = Math.max(index - contextLines, printed + 1), to = Math.min(index + contextLines, last)
      if (results.length && (printed < 0 || from > printed + 1)) { results.push('--'); paths!.push('') }
      for (let i = from; i <= to; i++) {
        if (results.length >= MAX_BUILTIN_RESULTS) { more = true; return }
        const mark = matched.has(i) ? ':' : '-'
        results.push(`${rel}${mark}${i + 1}${mark}${lines[i]}`); paths!.push(rel)
      }
      printed = Math.max(printed, to)
    }
  }

  function searchFile(filePath: string): void {
    if (isSecret(filePath) || (linked.size && linked.has(fileId(filePath) ?? ''))) return
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      const rel = relative(cwd, filePath) || filePath
      if (contextLines) return pushContext(lines, rel)
      let count = 0
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i]!)) continue
        count++
        if (mode === 'content') {
          if (results.length >= MAX_BUILTIN_RESULTS) { more = true; return }
          results.push(`${rel}:${i + 1}:${lines[i]}`)
        } else if (mode === 'files_with_matches') break
      }
      if (!count || mode === 'content') return
      if (results.length >= MAX_BUILTIN_RESULTS) { more = true; return }
      results.push(mode === 'count' ? `${rel}:${count}` : rel)
    } catch {
      // Skip unreadable files
    }
  }

  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) searchFile(full)
        if (more) return
      }
    } catch {
      // Skip unreadable directories
    }
  }

  try {
    const stat = statSync(searchPath)
    if (stat.isFile()) searchFile(searchPath)
    else walk(searchPath)
  } catch {
    return { success: false, error: `Path not accessible: ${input.path ?? searchPath}` }
  }

  // What ripgrep would have done differently: the result must not read as ripgrep's.
  const notes = [
    ...(more ? [`[Stopped looking after ${MAX_BUILTIN_RESULTS} results.]`] : []),
    `[ripgrep is not available, so this is G-Code's built-in search: it ${input.glob ? `did not apply the glob ${input.glob}, ` : ''}skipped dotfiles and node_modules, and did not read .gitignore.]`,
  ]
  return grepResult(input, mode, results, results.length, limit, notes, paths)
}
