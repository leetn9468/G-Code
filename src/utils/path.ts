/**
 * @file path.ts
 * @brief Tool path arguments: `~` and relative paths, network-share (UNC) checks, and the folders searches skip.
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// ============================================================================
// Path arguments
// ============================================================================

/**
 * Text with the project folder's absolute prefix removed, so the paths in an error read as file
 * changes do; the folder itself (what `pwd` prints) reads as '.'.
 */
export function relativeToProject(text: string, cwd: string): string {
  if (!cwd) return text
  let result = text
  for (const root of new Set([cwd, (() => { try { return realpathSync(cwd) } catch { return cwd } })()])) {
    const prefix = root.endsWith(sep) ? root : root + sep
    if (prefix.length <= 1) continue
    result = result.split(prefix).join('')
    result = result.replace(new RegExp(`${prefix.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"\`)\\]},;:])`, 'g'), '.')
  }
  return result
}

/**
 * The absolute, normalized path a tool's path argument names: `~` is the home folder and a
 * relative path is taken from `cwd` (the process's when not given). A NUL byte throws: the
 * operating system would end the path there and open a different file.
 */
export function expandPath(input: string, cwd = process.cwd()): string {
  if (input.includes('\0')) throw new Error('Path contains null byte')
  const path = input === '~' ? homedir() : /^~[\\/]/.test(input) ? join(homedir(), input.slice(2)) : input
  return resolve(cwd, path)
}

// ============================================================================
// Network shares (UNC)
// ============================================================================

/**
 * A path argument that names a network share (`\\server\share` or `//server/share`). Opening one
 * makes Windows sign in to that server with the user's credentials, so file tools refuse it.
 */
export const isUNCPath = (path: string): boolean => path.startsWith('\\\\') || path.startsWith('//')

/** Where a path can start in a command: the start, after whitespace, a quote, `=`, `(` or a shell operator. */
const UNC_BOUNDARY = String.raw`(?:^|[\s'"=(;|&<>` + '`' + String.raw`])`
/**
 * A host name or IP of two or more characters (and `?` for the `\\?\UNC\` long-path form). One
 * letter is left out on purpose: `"\\n\t"` and `"\\b\d"` are escape sequences, not hosts.
 */
const UNC_HOST = String.raw`(?:[A-Za-z0-9][A-Za-z0-9._-]+|\?)`
/** A share name; `$` is allowed for admin shares such as `c$`. */
const UNC_SHARE = String.raw`[A-Za-z0-9$_.-]`
/**
 * Credentials before the host, as SMB URLs and `mount_smbfs //user@server/share` take them:
 * `user@`, `user:password@`, `DOMAIN;user@`.
 */
const UNC_USER = String.raw`(?:[A-Za-z0-9._%~;:-]+@)?`
/** WebDAV suffixes after the host: `\\server@SSL\share`, `\\server@8080\share`, `\\server@SSL@443\share`. */
const UNC_PORT = String.raw`(?:@(?:SSL|\d{1,5}))*`
const UNC_PATTERNS = [
  // \\server\share as written, and \\\\server\\share, its shell-escaped form.
  new RegExp(String.raw`${UNC_BOUNDARY}\\\\${UNC_USER}${UNC_HOST}${UNC_PORT}\\${UNC_SHARE}`, 'i'),
  new RegExp(String.raw`${UNC_BOUNDARY}\\\\\\\\${UNC_USER}${UNC_HOST}${UNC_PORT}\\\\${UNC_SHARE}`, 'i'),
  // //server/share/…, //user@server/share
  new RegExp(String.raw`${UNC_BOUNDARY}//${UNC_USER}${UNC_HOST}${UNC_PORT}/`, 'i'),
  // file://server/… and file://user@server/… (file:///path and file://localhost/path are local and stay allowed).
  /\bfile:\/\/(?:[A-Za-z0-9._%~;:-]+@)?(?!localhost[:/])[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?\//i,
]

/**
 * Detect vulnerable UNC paths in command strings: a path that starts with `\\server\share` (or
 * its escaped form) or `//server/share/` at a word boundary, with optional credentials
 * (`//user@server/share`) and WebDAV suffixes (`\\server@SSL\share`), or a `file://server/` URL. Escaped
 * backslashes inside a word, as in `printf 'a\\nb'`, `grep -E "\\.test\\.js$"`,
 * `sed 's/\\/\//g'` or `node -e "console.log('x\\ty')"`, are not paths and are not matched.
 */
export function containsVulnerableUNCPath(command: string): boolean {
  return UNC_PATTERNS.some(pattern => pattern.test(command))
}

// ============================================================================
// G-Code's own folder
// ============================================================================

/** G-Code's own folder (snapshots, memory, tool output): Grep and Glob search it only when asked to by path or glob. */
export const GCODE_DIR = '.gcode'

/** Version-control folders (git, Subversion, Mercurial, Bazaar, Jujutsu, Sapling): internals, not project files. */
export const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const

/** Folders Grep and Glob leave out unless the search path or the glob names them. */
export const SEARCH_SKIPPED_DIRS = [GCODE_DIR, ...VCS_DIRS] as const

/** True when the search path (relative to the project when inside it) or the glob names a folder called `name`. */
export function targetsDir(cwd: string, searchPath: string, name: string, glob?: string): boolean {
  const rel = relative(cwd, searchPath)
  const shown = rel.startsWith('..') || isAbsolute(rel) ? searchPath : rel
  return shown.split(/[\\/]/).includes(name) || (glob ?? '').split(/[\\/]/).includes(name)
}
