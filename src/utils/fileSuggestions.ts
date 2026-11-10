/**
 * @file fileSuggestions.ts
 * @brief The error a file tool returns for a path that does not exist: where relative paths start, and
 * the project's files whose names come closest, so the model can retry with the right path.
 */

import { basename, extname, isAbsolute } from 'node:path'
import { guardedExecFileSync } from '../security/process.js'
import { toolEnv } from '../runtime/node.js'

const MAX_SUGGESTIONS = 5

/**
 * The project's files under `cwd`, relative to it: tracked ones and new ones git does not ignore.
 * Empty outside a git repository. git's stderr is captured, never inherited, so its "not a git
 * repository" never reaches G-Code's own stderr.
 */
function projectFiles(cwd: string): string[] {
  try {
    const out = guardedExecFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd, env: toolEnv(), encoding: 'utf-8', timeout: 5000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    })
    return [...new Set(String(out).split('\0').filter(Boolean))]
  } catch {
    return []
  }
}

/** Single-character insertions, deletions and replacements that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]!
}

/**
 * How close a file's name is to the missing one, lower first, or undefined when it is not close:
 * the same name in another folder, then the same name with another extension, then a name a few
 * typos away (at most one edit per three characters).
 */
function closeness(wanted: string, name: string): number | undefined {
  if (name === wanted) return 0
  const stem = (file: string) => file.slice(0, file.length - extname(file).length)
  if (stem(name) && stem(name) === stem(wanted)) return 1
  const allowed = Math.max(1, Math.floor(wanted.length / 3))
  if (Math.abs(name.length - wanted.length) > allowed) return undefined
  const distance = editDistance(wanted, name)
  return distance <= allowed ? 2 + distance / wanted.length : undefined
}

/** Up to five project files named like the missing path, closest first, relative to `cwd`. */
export function findSimilarFiles(missingPath: string, cwd: string): string[] {
  const wanted = basename(missingPath).toLowerCase()
  if (!wanted) return []
  const ranked: Array<{ path: string; rank: number }> = []
  for (const path of projectFiles(cwd)) {
    const rank = closeness(wanted, basename(path).toLowerCase())
    if (rank !== undefined) ranked.push({ path, rank })
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => entry.path)
}

/** The error for a path that does not exist. Its first line is always `File not found: <path>`. */
export function buildFileNotFoundMessage(filePath: string, cwd: string): string {
  const lines = [`File not found: ${filePath}`]
  if (!isAbsolute(filePath) && !filePath.startsWith('~')) lines.push(`Relative paths start from ${cwd}.`)
  const similar = findSimilarFiles(filePath, cwd)
  if (similar.length > 0) lines.push('Files with a similar name:', ...similar.map(path => `  ${path}`))
  return lines.join('\n')
}
