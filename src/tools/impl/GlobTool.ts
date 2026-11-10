/**
 * @file GlobTool.ts
 * @brief File pattern matching via ripgrep --files or built-in walk
 */


import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { SEARCH_SKIPPED_DIRS, targetsDir } from '../../utils/path.js'
import { runSubprocess } from '../../utils/subprocess.js'
import { assertToolFile, gcodeSecretGlobs, gcodeSecretMatcher, pathTarget } from '../../session/scopedPermission.js'
import { readScope, secretRefusal } from '../permissions.js'
import { onlyUnreadable, rgError, rgStopped, ripgrepPath, unreadableFolder } from './GrepTool.js'

// No executable probes during module evaluation: the guard is configured after imports.

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files (e.g. "**/*.ts")'),
  path: z.string().optional().describe('Directory to search in (defaults to cwd). Searching outside the project asks the user first.'),
})

type GlobInput = z.infer<typeof inputSchema>

interface GlobOutput {
  numFiles: number
  filenames: string[]
  truncated: boolean
  /** When truncated: how many files matched. */
  totalFiles?: number
  /** When truncated: the list with a note that says so (what the model reads). */
  content?: string
}

const MAX_RESULTS = 200
const TIMEOUT_MS = 20_000
/** Matches the JS fallback collects (and sorts by modification time) before it stops looking. */
const MAX_BUILTIN_MATCHES = 50_000

/**
 * The newest MAX_RESULTS of `files` (already newest first); a cut list says so. `notes` say why the
 * list may be incomplete (folders that could not be read, a search that timed out).
 */
function globResult(files: string[], more = false, notes: string[] = []): ToolResult<GlobOutput> {
  const truncated = files.length > MAX_RESULTS
  const limited = files.slice(0, MAX_RESULTS)
  if (!truncated && !notes.length) return { success: true, output: { numFiles: limited.length, filenames: limited, truncated } }
  const all = truncated ? [`[Showing the ${MAX_RESULTS} most recently modified of ${files.length}${more ? '+' : ''} matching files. Narrow the pattern or path to see the rest.]`, ...notes] : notes
  const content = [limited.length ? limited.join('\n') : 'No files found', ...all].join('\n\n')
  return { success: true, output: { numFiles: limited.length, filenames: limited, truncated, ...(truncated ? { totalFiles: files.length } : {}), content } }
}

/** The note for folders a search could not read. */
const unreadableNote = (errors: string) => `[Some folders could not be read, so this list may be incomplete:\n${errors}]`

// Load .gitignore patterns for filtering
function loadIgnorePatterns(cwd: string): string[] {
  const patterns: string[] = ['node_modules', '.git', '__pycache__', '.DS_Store', 'dist', 'build']
  const gitignorePath = join(cwd, '.gitignore')
  if (existsSync(gitignorePath)) {
    try {
      assertToolFile(gitignorePath)
      const lines = readFileSync(gitignorePath, 'utf-8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#')) {
          patterns.push(trimmed.replace(/\/$/, ''))
        }
      }
    } catch { /* skip */ }
  }
  return patterns
}

function isIgnored(path: string, patterns: string[]): boolean {
  const name = path.split('/').pop() ?? path
  return patterns.some((p) => {
    if (name === p) return true
    if (p.includes('*')) {
      try { return new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(name) }
      catch { return false }
    }
    return false
  })
}

export const GlobTool: Tool<GlobInput, GlobOutput> = {
  name: 'Glob',
  description: 'Find files matching glob patterns',
  inputSchema,

  async call(input, context): Promise<ToolResult<GlobOutput>> {
    const searchDir = resolve(context.cwd, input.path ?? '.')
    // G-Code's own settings and key files stay closed, also to a caller that skips checkPermissions.
    const target = pathTarget(searchDir, context.cwd)
    if (target.secret) return { success: false, error: secretRefusal(target.resolved) }
    // A folder that is not there or cannot be read is not a folder with no matching files.
    const shownPath = input.path ?? searchDir
    const locked = unreadableFolder(searchDir, shownPath)
    if (locked) return { success: false, error: locked }
    if (!existsSync(searchDir)) return { success: false, error: `Path does not exist: ${shownPath}` }

    try {
      return await runRipgrepGlob(input.pattern, searchDir, context.cwd, context.signal)
    } catch {
      return runBuiltinGlob(input.pattern, searchDir, context.cwd)
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    // Inside the project: allowed. Outside it (by real path, so symlinks count): ask. G-Code's key files: refused.
    return readScope('Glob', input, context.cwd) ?? { decision: 'allow', reason: 'Read-only file search' }
  },

  prompt(): string {
    return `Glob: Find files matching glob patterns. Returns up to ${MAX_RESULTS} paths, most recently modified first, and says when it cut the list. Searching outside the project asks the user first.`
  },
}

async function runRipgrepGlob(
  pattern: string,
  searchDir: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ToolResult<GlobOutput>> {
  // Newest first, so the cap drops the oldest files, never the ones just changed.
  const args = ['--files', '--glob', pattern, '--hidden', '--sortr=modified']
  // G-Code's own folder (snapshots, memory) and version-control internals (.git …) stay out unless
  // the path or pattern names them. Later globs win in ripgrep, so these hold over the pattern.
  for (const dir of SEARCH_SKIPPED_DIRS) if (!targetsDir(cwd, searchDir, dir, pattern)) args.push('--glob', `!${dir}`)
  // ripgrep anchors a glob with a slash (src/*.ts) at its own working directory, and only when
  // that is the real path; running it in the search folder anchors patterns there, as documented.
  let inDir = false
  try { inDir = statSync(searchDir).isDirectory() } catch { /* rg reports a missing path itself. */ }
  // G-Code's settings and key files are never listed, whatever the path and pattern.
  if (inDir) for (const glob of gcodeSecretGlobs(pathTarget(searchDir, cwd).resolved)) args.push('--glob', glob)
  if (!inDir) args.push(searchDir)
  const base = inDir ? searchDir : cwd

  // Bun.spawn under Bun, and a liveness poll: a lost 'close' cannot hang the search (see subprocess.ts).
  // A stop reaches it, and it does not outlive this process.
  const run = await runSubprocess([ripgrepPath(), ...args], { cwd: base, env: process.env, timeoutMs: TIMEOUT_MS, signal, killOnExit: true })
  // No ripgrep: the JS fallback (call() catches this).
  if (run.spawnError !== undefined) throw new Error(`ripgrep not available: ${run.spawnError}`)
  const errors = rgError(run.stderr)
  // In an existing folder, exit 2 with nothing listed is an error (an invalid pattern), not "no files",
  // unless the only errors are folders ripgrep could not open ("… (os error 13)"): then the list is partial.
  const unreadableOnly = inDir && onlyUnreadable(run.stderr)
  if (inDir && run.exitCode === 2 && !run.stdout.trim() && !unreadableOnly) return { success: false, error: `ripgrep: ${errors || 'search failed'}` }
  // A search that did not run to its end has listed nothing yet; that does not mean there is nothing.
  const stopped = rgStopped(run, TIMEOUT_MS)
  if (stopped && !run.stdout.trim()) return { success: false, error: `${stopped}, with nothing listed so far. This does not mean no files match: narrow the pattern or path, or list them with Bash.` }
  const notes: string[] = []
  if (stopped) notes.push(`[${stopped}, so this list is incomplete. Narrow the pattern or path.]`)
  if (inDir && run.exitCode === 2 && errors) notes.push(unreadableOnly ? unreadableNote(errors) : `[ripgrep reported errors, so this list may be incomplete:\n${errors}]`)
  const isSecret = gcodeSecretMatcher(base)
  const files = run.stdout.trim().split('\n').filter(Boolean)
  const relativized = files.flatMap((f) => {
    const full = isAbsolute(f) ? f : join(base, f)
    if (inDir && isSecret(full)) return []
    try { return [relative(cwd, full) || full] } catch { return [full] }
  })
  return globResult(relativized, false, notes)
}

function runBuiltinGlob(
  pattern: string,
  searchDir: string,
  cwd: string,
): ToolResult<GlobOutput> {
  // ripgrep calls this an error too; escaped below, it would read as "No results".
  if (/\[(?![^\]]*\])/.test(pattern)) return { success: false, error: `Invalid glob pattern "${pattern}": a [ is not closed.` }

  // Convert glob to regex (simplified)
  // `**/` also matches no folder at all, so **/*.ts finds a.ts at the top as ripgrep does.
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '{{GLOBSTAR_DIR}}')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR_DIR\}\}/g, '(?:.*/)?')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  let regex: RegExp
  try {
    regex = new RegExp(`^${regexStr}$`)
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }

  const results: Array<{ path: string; mtime: number }> = []
  let more = false
  const ignorePatterns = loadIgnorePatterns(cwd)
  for (const dir of SEARCH_SKIPPED_DIRS) if (!targetsDir(cwd, searchDir, dir, pattern) && !ignorePatterns.includes(dir)) ignorePatterns.push(dir)
  const isSecret = gcodeSecretMatcher(searchDir)
  /** Folders that exist but could not be read, as ripgrep reports them. */
  const unreadable: string[] = []

  function walk(dir: string, prefix: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (isIgnored(entry.name, ignorePatterns)) continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = join(dir, entry.name)

        if (isSecret(full)) continue
        if (entry.isDirectory()) {
          walk(full, rel)
          if (more) return
        } else if (entry.isFile()) {
          if (regex.test(rel) || regex.test(entry.name)) {
            if (results.length >= MAX_BUILTIN_MATCHES) { more = true; return }
            let mtime = 0
            try { mtime = statSync(full).mtimeMs } catch { /* gone: sorts last */ }
            results.push({ path: relative(cwd, full) || full, mtime })
          }
        }
      }
    } catch (error) {
      // Skip unreadable directories, but say so; a missing path is simply no files, as with ripgrep.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable.push(`${relative(cwd, dir) || dir}: ${code ?? String(error)}`)
    }
  }

  try {
    walk(searchDir, '')
  } catch {
    return { success: false, error: `Cannot access: ${searchDir}` }
  }

  const shown = unreadable.slice(0, 6).join('\n') + (unreadable.length > 6 ? `\n… and ${unreadable.length - 6} more` : '')
  // Newest first, as with ripgrep.
  return globResult(results.sort((a, b) => b.mtime - a.mtime).map(result => result.path), more, unreadable.length ? [unreadableNote(shown)] : [])
}
