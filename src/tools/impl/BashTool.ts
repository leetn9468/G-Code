/**
 * @file BashTool.ts
 * @brief Execute shell commands with safety checks, timeout, and output capture
 */

import { closeSync, existsSync, openSync, unlinkSync, write } from 'node:fs'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { sessionInUse } from '../../state/store.js'
import { randomUUID } from 'node:crypto'
import { constants as osConstants, homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { containsVulnerableUNCPath } from '../../utils/path.js'
import { realTarget, SECRET_ENTRIES } from '../../session/scopedPermission.js'
import { knownSecrets, maskSecrets, maskSecretsInCutText, maskStream } from '../../security/secretValues.js'
import { leftGroupNote, runSubprocess } from '../../utils/subprocess.js'
import { MAX_TOOL_RESULT_CHARS } from '../../engine/microcompact.js'
import { generatedDataPath, generatedFolder } from '../../session/outputs.js'
import { backgroundShells, serverAddress, shellState, shownTail, tailOutput, taskSession, type BackgroundShellInfo } from '../backgroundShells.js'
import { headOutput } from '../../utils/textUnits.js'

const inputSchema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z.number().positive().max(600_000).optional().describe('Timeout in milliseconds: default 120000 (2 minutes), max 600000 (10 minutes)'),
  description: z.string().optional().describe('Description of what this command does'),
  run_in_background: z.boolean().optional().describe('Start the command and return at once with a task id instead of waiting for it to exit. Use for dev servers, watchers and long builds; read its output with TaskOutput and stop it with TaskStop. It is stopped when the G-Code session ends.'),
})

type BashInput = z.infer<typeof inputSchema>

interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number | null
  interrupted: boolean
  /** Ended by its timeout (not by a stop). */
  timedOut?: boolean
  /** The file with the whole stdout (or its first MAX_SAVED_BYTES), when it was too long to show. */
  persistedOutputPath?: string
  /** The same for stderr. */
  persistedStderrPath?: string
  /** The background task that took over what the command left running (see adopt in backgroundShells.ts). */
  backgroundTaskId?: string
}

/** In UTF-16 units: the most of stdout and stderr together shown inline (see inlineShares). */
const MAX_OUTPUT_INLINE = 30_000
/**
 * Per stream, in UTF-16 units: what is kept in memory of its start, and of its end (see
 * keepTail in runSubprocess). Only that much can be shown inline; all of it goes to a file as it
 * arrives (see SavedOutput).
 */
const MAX_OUTPUT_MEMORY = MAX_OUTPUT_INLINE
/** Of a stream cut inline, the part of its share that shows its start; the rest shows its end (a build's summary, the last error). */
const HEAD_SHARE = 0.6
/** The most a saved output file holds: a command that prints without end (`yes`) must not fill the disk. */
const MAX_SAVED_BYTES = 64 * 1024 * 1024
/** Saved outputs older than this are deleted (see sweepToolOutput). */
const SAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** The most all saved outputs of a project may take together; the oldest go first. */
const SAVED_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

// ============================================================================
// Destructive Command Detection
// ============================================================================
//
// The command is split into simple commands (on ; && || | & newlines, subshells, $(…) and
// backticks, and the scripts of `bash -c`, `eval`, `trap`, `watch`, `su -c` and of a shell fed
// `echo …`, `printf …`, a here-document or a here-string), and each rule looks at a command word
// and its own arguments, so `grep -rn shutdown src`, `echo reboot` and `git rm -r --cached` are
// not flagged. Two levels:
// - catastrophic: refused before any approval prompt, in every permission mode (bypass too);
// - dangerous: needs the user's explicit approval (it runs in bypass mode or once approved).
// Ordinary cleanup inside the project (rm -f of files, rm -rf dist, node_modules, .next, coverage,
// tmp…) is neither.
//
// The parser is not a shell, so a fail-closed layer runs over the raw text as well: `rm -r` of /,
// the home folder or a system folder anywhere in it (quotes, escapes and braces removed first,
// so quoted text and here-documents count), and nesting deeper than the parser follows, are
// catastrophic too.

export type CommandRiskLevel = 'catastrophic' | 'dangerous'

export interface CommandRisk {
  level: CommandRiskLevel
  /** The simple command that matched, as the shell sees it. */
  command: string
  /** What it would do, in plain words: "deletes your home folder". */
  effect: string
}

/** Stands for the output of a `$(…)` or backtick substitution inside a word. */
const SUBST = '\u0001'
const MAX_NESTING = 6
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'select', 'function', '{', '}', '!', 'time', '[[', 'coproc'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const DISK_DEVICE = /^\/dev\/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z]|xvd[a-z]|vd[a-z]|mmcblk\d)/
/** Reads from these never end or wait for a terminal. */
const STREAM_DEVICES = ['/dev/zero', '/dev/stdin', '/dev/tty', '/proc/self/fd/']
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/

interface ShellCommand {
  words: string[]
  redirects: { op: string; target: string }[]
  /** Runs in a `$(…)` or backtick subshell, so its `cd` does not move the commands after it. */
  isolated?: boolean
  /** The command whose output it reads: in `a | b`, b's is a. */
  from?: ShellCommand
  /** The body of its own here-document, which it reads as input. */
  input?: string
}

/** Set when the source nests deeper than the parser follows (MAX_NESTING): part of it was not looked at. */
interface ParseState { overflow: boolean }

/** Index of the `)` that closes the `(` at `open`, skipping quoted text; `source.length` when unclosed. */
function closingParen(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const end = source.indexOf("'", i + 1); i = end < 0 ? source.length : end; continue }
    if (c === '"') {
      i++
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return source.length
}

function closingBacktick(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue }
    if (source[i] === '`') return i
  }
  return source.length
}

/** Just enough of the shell grammar to find each simple command's words and redirections. */
export function parseShellCommands(source: string, depth = 0, state: ParseState = { overflow: false }): ShellCommand[] {
  const commands: ShellCommand[] = []
  let words: string[] = []
  let redirects: ShellCommand['redirects'] = []
  let word = ''
  let inWord = false
  let pendingOp: string | null = null
  // The last command of this level, and whether the next one reads its output (after `|` or `|&`).
  let last: ShellCommand | undefined
  let piped = false
  const heredocs: { delimiter: string; stripTabs: boolean; owner: string[] }[] = []
  const nested = (inner: string, isolated = true) => {
    if (depth >= MAX_NESTING) { state.overflow = true; return }
    commands.push(...parseShellCommands(inner, depth + 1, state).map(command => isolated ? { ...command, isolated } : command))
  }
  const endWord = () => {
    if (!inWord) return
    if (pendingOp) {
      if (pendingOp === '<<' || pendingOp === '<<-') heredocs.push({ delimiter: word, stripTabs: pendingOp === '<<-', owner: words })
      redirects.push({ op: pendingOp, target: word })
      pendingOp = null
    } else words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    pendingOp = null
    if (words.length || redirects.length) {
      const command: ShellCommand = { words, redirects }
      if (piped && last) command.from = last
      commands.push(command)
      last = command
      piped = false
    }
    words = []
    redirects = []
  }
  /** Here-document bodies are data, unless they are fed to a shell. */
  const skipHeredocs = (from: number): number => {
    let i = from
    for (const doc of heredocs.splice(0)) {
      const body: string[] = []
      while (i < source.length) {
        const end = source.indexOf('\n', i)
        const line = source.slice(i, end < 0 ? source.length : end)
        i = end < 0 ? source.length : end + 1
        if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
        body.push(line)
      }
      for (let index = commands.length - 1; index >= 0; index--) {
        if (commands[index]!.words === doc.owner) { commands[index]!.input = body.join('\n') + '\n'; break }
      }
      if (doc.owner.some(owner => SHELLS.has(commandName([owner])))) nested(body.join('\n'), false)
    }
    return i
  }
  /** `$(…)`, `$((…))` or a backtick substitution starting at `i`; returns the index after it. */
  const substitution = (i: number): number => {
    if (source[i] === '`') {
      const end = closingBacktick(source, i)
      nested(source.slice(i + 1, end))
      word += SUBST
      return end + 1
    }
    const end = closingParen(source, i + 1)
    if (source[i + 2] !== '(') nested(source.slice(i + 2, end))
    word += SUBST
    return end + 1
  }

  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (c === '\\') {
      if (source[i + 1] === '\n') { i += 2; continue }
      if (i + 1 < source.length) { word += source[i + 1]; inWord = true }
      i += 2
      continue
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1)
      const stop = end < 0 ? source.length : end
      word += source.slice(i + 1, stop)
      inWord = true
      i = stop + 1
      continue
    }
    if (c === '"') {
      inWord = true
      i++
      while (i < source.length && source[i] !== '"') {
        const d = source[i]!
        if (d === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!
          if ('$`"\\\n'.includes(next)) { if (next !== '\n') word += next; i += 2 } else { word += d; i++ }
          continue
        }
        if ((d === '$' && source[i + 1] === '(') || d === '`') { i = substitution(i); continue }
        word += d
        i++
      }
      i++
      continue
    }
    if ((c === '$' && source[i + 1] === '(') || c === '`') { inWord = true; i = substitution(i); continue }
    if (c === '$' && source[i + 1] === '{') {
      const end = source.indexOf('}', i)
      const stop = end < 0 ? source.length : end
      word += source.slice(i, stop + 1)
      inWord = true
      i = stop + 1
      continue
    }
    if (c === '#' && !inWord) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    if (c === '\n') { endCommand(); i = skipHeredocs(i + 1); continue }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue }
    if (c === '>' || c === '<' || (c === '&' && source[i + 1] === '>')) {
      // A bare number right before the operator is its file descriptor (2>file), not a word.
      if (inWord && !pendingOp && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      let op = c
      i++
      while (i < source.length && op.length < 3 && '<>&|-'.includes(source[i]!)) op += source[i++]
      pendingOp = op
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand()
      i++
      const doubled = (c === ';' || c === '&' || c === '|') && (source[i] === c || (c === '|' && source[i] === '&'))
      if (doubled) i++
      // `|` and `|&` feed the next command; `( … ) | sh` feeds it the subshell's last command.
      if (c === '|') piped = !doubled || source[i - 1] === '&'
      else if (c !== '(' && c !== ')') piped = false
      continue
    }
    word += c
    inWord = true
    i++
  }
  endCommand()
  return commands
}

function commandName(words: readonly string[]): string {
  const first = words.find(word => !RESERVED.has(word) && !ASSIGNMENT.test(word)) ?? ''
  return first.split(/[\\/]/).pop() ?? first
}

/** Drops leading options (and the values of the ones in `withValue`), then a `--`. */
function skipOptions(words: string[], withValue: ReadonlySet<string> = new Set()): string[] {
  let i = 0
  while (i < words.length && words[i]!.startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') { i++; break }
    i += withValue.has(words[i]!) ? 2 : 1
  }
  return words.slice(i)
}

const SUDO_VALUE = new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D', '-R', '-T'])
const XARGS_VALUE = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-J', '-R', '-S'])
const TIMEOUT_VALUE = new Set(['-s', '-k', '--signal', '--kill-after'])

/** The command a wrapper (sudo, env, xargs, nohup…) runs, and whether its arguments come from input. */
function unwrap(words: string[]): { words: string[]; fromInput: boolean } {
  let rest = words
  let fromInput = false
  for (let guard = 0; guard < 8; guard++) {
    while (rest.length && (RESERVED.has(rest[0]!) || ASSIGNMENT.test(rest[0]!))) rest = rest[0] === 'time' && rest[1] === '-p' ? rest.slice(2) : rest.slice(1)
    const name = commandName(rest.slice(0, 1))
    if (name === 'sudo' || name === 'doas') rest = skipOptions(rest.slice(1), SUDO_VALUE)
    else if (name === 'command') {
      if (rest[1] === '-v' || rest[1] === '-V') return { words: [], fromInput }
      rest = skipOptions(rest.slice(1))
    } else if (['builtin', 'nohup', 'noglob', 'setsid', 'time'].includes(name)) rest = skipOptions(rest.slice(1))
    else if (name === 'exec') rest = skipOptions(rest.slice(1), new Set(['-a']))
    else if (name === 'caffeinate') rest = skipOptions(rest.slice(1), new Set(['-t', '-w']))
    // busybox is a multi-call binary: `busybox sh -c …`, `busybox rm -rf ~` are the real commands.
    else if (name === 'busybox') rest = rest.slice(1)
    else if (name === 'stdbuf') rest = skipOptions(rest.slice(1), new Set(['-i', '-o', '-e']))
    else if (name === 'nice') rest = skipOptions(rest.slice(1), new Set(['-n']))
    else if (name === 'timeout' || name === 'gtimeout') rest = skipOptions(rest.slice(1), TIMEOUT_VALUE).slice(1)
    else if (name === 'env') rest = skipOptions(rest.slice(1), new Set(['-u', '-C', '-P']))
    else if (name === 'xargs') { fromInput = true; rest = skipOptions(rest.slice(1), XARGS_VALUE) }
    else break
  }
  return { words: rest, fromInput }
}

interface Scope {
  /** The project folder. */
  cwd: string
  home: string
  /** Where relative paths resolve: the project folder until a `cd`; null once that is unknown. */
  here: string | null
  /** Real paths looked up for this command (see realForm), shared across its targets. */
  lookups?: RealLookups
}

/** Each lookup touches the disk, so a command with thousands of brace alternatives gets a limited number, then fails closed. */
interface RealLookups { left: number; over: boolean; cwd?: string; home?: string }
const MAX_REAL_LOOKUPS = 64

function depthOf(path: string): number { return path.split('/').filter(Boolean).length }
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
/**
 * Top-level folders that belong to the system (lower case, for case-insensitive disks): deleting
 * one is catastrophic, and a project opened at one bounds nothing. Other top-level folders, such
 * as the /app or /workspace of a container, are ordinary project folders.
 */
const SYSTEM_FOLDERS = new Set(['applications', 'bin', 'boot', 'cores', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'library', 'media', 'mnt', 'network', 'nix', 'opt', 'private', 'proc', 'root', 'run', 'sbin', 'snap', 'sys', 'system', 'tmp', 'users', 'usr', 'var', 'volumes'])
function systemFolder(path: string): boolean { return depthOf(path) === 1 && SYSTEM_FOLDERS.has(path.slice(1).toLowerCase()) }
/** A project folder that is `/`, a system folder, the home folder or above it bounds nothing. */
function projectScope(scope: Scope): boolean {
  return depthOf(scope.cwd) > 0 && !systemFolder(scope.cwd) && scope.cwd !== scope.home && !within(scope.cwd, scope.home)
}
/** The last path segment matches everything there: `*`, `.*`, `*.*`, `.[!.]*`… */
function matchesEverything(segment: string): boolean {
  return segment.includes('*') && segment.replace(/\[[^\]]*\]/g, '').replace(/[.*?]/g, '') === ''
}

/**
 * A budget shared across all the brace expansion (and raw-text scanning) of one command, so a
 * pathological command cannot make the guard do exponential or quadratic work. `work` is spent on
 * each alternative produced and each step taken; once it runs out, expansion stops and `truncated`
 * is set, and the caller fails closed (treats the command as needing approval).
 */
interface ExpandBudget { work: number; truncated: boolean }
function newBudget(work = 4096): ExpandBudget { return { work, truncated: false } }

/**
 * The words a shell's brace expansion makes of `word`: `{~,x}` is `~` and `x`, `a{b,c}d` is `abd`
 * and `acd` (comma lists only; `${…}` is a parameter, not a brace list). Bounded by `budget`: it
 * stops and sets `budget.truncated` once the shared work budget is spent, so `{a,b}{c,d}…` with
 * dozens of groups costs no more than a short command (the first alternatives, then a stop).
 */
function braceAlternatives(word: string, budget: ExpandBudget = newBudget()): string[] {
  const expand = (w: string): string[] => {
    // Out of budget: keep the word as it is (never drop it), so later targets are still checked.
    if (budget.work <= 0) { budget.truncated = true; return [w] }
    budget.work--
    for (let open = 0; open < w.length; open++) {
      if (w[open] !== '{' || w[open - 1] === '$') continue
      const commas: number[] = []
      let depth = 0, close = -1
      for (let i = open; i < w.length && close < 0; i++) {
        if (w[i] === '{') depth++
        else if (w[i] === '}' && --depth === 0) close = i
        else if (w[i] === ',' && depth === 1) commas.push(i)
      }
      if (close < 0) return [w]
      if (!commas.length) continue
      const alternatives: string[] = []
      let from = open + 1
      for (const end of [...commas, close]) {
        if (budget.work <= 0) { budget.truncated = true; alternatives.push(w); break }
        for (const expanded of expand(w.slice(0, open) + w.slice(from, end) + w.slice(close + 1))) alternatives.push(expanded)
        from = end + 1
      }
      return alternatives
    }
    return [w]
  }
  return expand(word)
}

type TargetLevel = CommandRiskLevel | 'ok'

/**
 * The same folder under another name on macOS: the system volume's firmlink to the data volume
 * (/System/Volumes/Data/Users/me is /Users/me), and /etc, /tmp and /var, which are links into /private.
 */
function withoutAliases(path: string): string {
  return (path.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/').replace(/^\/private(?=\/(?:etc|tmp|var)(?:\/|$))/i, '')
}

/** `raw` with the home folder and $PWD filled in; undefined when only the running shell can know what it is. */
function expandedTarget(raw: string, scope: Scope): string | undefined {
  let path = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, scope.home).replace(/^\$\{?PWD\}?(?=\/|$)/, scope.cwd)
  if (path === '~' || path.startsWith('~/')) path = scope.home + path.slice(1)
  else if (path.startsWith('~')) return undefined
  if (path.includes(SUBST) || /\$(?:[A-Za-z_{(]|\d)/.test(path)) return undefined
  if (!isAbsolute(path) && scope.here === null) return undefined
  return path
}

/**
 * Where a target really leads, and the scope to judge it in, both by their real paths with macOS's
 * aliases taken out. Written as the kernel reads it: a link before `..` is followed first. A link
 * that is itself the target is followed only when `follow` says so, or when a trailing slash or a
 * wildcard goes into it: `rm -rf link` removes the link, `rm -rf link/` and `rm -rf link/*` what
 * it leads to.
 */
function realForm(raw: string, scope: Scope, follow: boolean): { path: string; scope: Scope } | undefined {
  const path = expandedTarget(raw, scope)
  if (path === undefined) return undefined
  const lookups = scope.lookups ??= { left: MAX_REAL_LOOKUPS, over: false }
  if (lookups.left-- <= 0) { lookups.over = true; return undefined }
  const input = isAbsolute(path) ? path : `${scope.here ?? scope.cwd}/${path}`
  const last = input.slice(input.lastIndexOf('/') + 1)
  // The last word stays as written when the path does not go into it (a link), and for a wildcard.
  const into = follow || last === '' || last === '.' || last === '..'
  const folder = into ? realTarget(input) : realTarget(input.slice(0, input.lastIndexOf('/')) || '/')
  if (folder === undefined) return undefined
  const real = (value: string) => withoutAliases(realTarget(value) ?? value)
  lookups.cwd ??= real(scope.cwd)
  lookups.home ??= real(scope.home)
  return {
    path: withoutAliases(into ? folder : `${folder === '/' ? '' : folder}/${last}`),
    scope: { cwd: lookups.cwd, home: lookups.home, here: null },
  }
}

const LEVEL_ORDER: Record<TargetLevel, number> = { ok: 0, dangerous: 1, catastrophic: 2 }

/**
 * How bad deleting (or recursively changing) `raw` would be: by the path as written and by where it
 * really leads, whichever is worse. A symbolic link in the project can lead to the home folder.
 * `follow`: the command goes through a link that is itself the target (chmod -R, find -L).
 */
function classifyTarget(raw: string, recursive: boolean, scope: Scope, follow = false): { level: TargetLevel; effect: string } {
  const written = classifyPath(raw, recursive, scope)
  if (written.level === 'catastrophic' || !raw) return written
  const real = realForm(raw, scope, follow)
  if (!real) return written
  const reached = classifyPath(real.path, recursive, real.scope)
  if (LEVEL_ORDER[reached.level] <= LEVEL_ORDER[written.level]) return written
  return { level: reached.level, effect: `${reached.effect} (${raw} leads there through a symbolic link)` }
}

/**
 * How bad deleting `raw` is by its path alone. `recursive` is false for plain `rm`/`rm -f`, which
 * removes files only.
 */
function classifyPath(raw: string, recursive: boolean, given: Scope): { level: TargetLevel; effect: string } {
  const ok = { level: 'ok' as const, effect: '' }
  if (!raw) return ok
  const scope = { ...given, cwd: withoutAliases(given.cwd), home: withoutAliases(given.home) }
  let path = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, scope.home).replace(/^\$\{?PWD\}?(?=\/|$)/, scope.cwd)
  if (path === '~' || path.startsWith('~/')) path = scope.home + path.slice(1)
  else if (path.startsWith('~')) return recursive ? { level: 'dangerous', effect: `deletes ${raw}, another user's home folder` } : ok
  if (path.includes(SUBST) || /\$(?:[A-Za-z_{(]|\d)/.test(path)) {
    return recursive ? { level: 'dangerous', effect: 'deletes a folder whose path comes from a variable or command output' } : ok
  }
  if (!isAbsolute(path) && scope.here === null) {
    return recursive ? { level: 'dangerous', effect: `deletes ${raw} in a folder that is only known when the command runs` } : ok
  }
  const absolute = withoutAliases(resolve(scope.here ?? scope.cwd, path))
  const everything = matchesEverything(basename(absolute))
  const base = everything ? dirname(absolute) : absolute
  const where = (target: string) => target === scope.home ? 'your home folder' : target === '/' ? '/' : target
  if (!recursive) {
    if (!everything) return ok
    if (base === scope.cwd && projectScope(scope)) return { level: 'dangerous', effect: 'deletes every file in the project folder' }
    if (projectScope(scope) && within(scope.cwd, base)) return ok
    return { level: 'dangerous', effect: `deletes every file in ${where(base)}` }
  }
  if (base === '/') return { level: 'catastrophic', effect: everything ? 'deletes everything on the disk' : 'deletes the whole disk' }
  // A top-level folder, unless it is the project itself (a container's /app); the project rules below cover that.
  if (depthOf(base) === 1 && !(base === scope.cwd && projectScope(scope))) return { level: 'catastrophic', effect: `deletes the ${systemFolder(base) ? 'system' : 'top-level'} folder ${base}${everything ? ' and everything in it' : ''}` }
  if (base === scope.home) return { level: 'catastrophic', effect: everything ? 'deletes everything in your home folder' : 'deletes your home folder' }
  if (within(base, scope.home)) return { level: 'catastrophic', effect: `deletes ${base}, which contains your home folder` }
  if (projectScope(scope)) {
    if (within(scope.cwd, absolute)) {
      if (everything && base === scope.cwd) return { level: 'dangerous', effect: 'deletes everything in the project folder' }
      const first = relative(scope.cwd, absolute).split(/[\\/]/)[0]
      if (first === '.git') return { level: 'dangerous', effect: "deletes the project's git history" }
      return ok
    }
    if (base === scope.cwd) return { level: 'dangerous', effect: 'deletes the whole project folder' }
    if (within(base, scope.cwd)) return { level: 'dangerous', effect: `deletes ${base}, which contains the project folder` }
  }
  return { level: 'dangerous', effect: `deletes ${base}, outside the project folder` }
}

/** A disk device by its name, or by where a symbolic link with another name leads. */
function diskDevice(path: string, scope: Scope): boolean {
  if (DISK_DEVICE.test(path)) return true
  const real = expandedTarget(path, scope)
  return real !== undefined && DISK_DEVICE.test(realTarget(isAbsolute(real) ? real : `${scope.here ?? scope.cwd}/${real}`) ?? '')
}

const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-newer', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-empty', '-user', '-group', '-perm', '-links', '-inum', '-samefile', '-lname', '-ilname'])

function worst(findings: Array<{ level: TargetLevel; effect: string }>): { level: TargetLevel; effect: string } | undefined {
  return findings.find(finding => finding.level === 'catastrophic') ?? findings.find(finding => finding.level === 'dangerous')
}

/** Shared command unwrapping for network classification; does not execute shell text. */
export function unwrappedShellWords(words: string[]): string[] { return unwrap(words).words }

/** The risk of one simple command (already unwrapped), or undefined. */
function assessSimple(words: string[], fromInput: boolean, scope: Scope, budget: ExpandBudget): { level: TargetLevel; effect: string } | undefined {
  const name = commandName(words.slice(0, 1))
  const lower = name.toLowerCase()
  const args = words.slice(1)
  switch (name) {
    case 'rm': {
      let recursive = false
      const targets: string[] = []
      let options = true
      for (const arg of args) {
        if (options && arg === '--') { options = false; continue }
        if (options && arg.startsWith('--')) {
          if (arg === '--recursive') recursive = true
          if (arg === '--no-preserve-root') return { level: 'catastrophic', effect: 'turns off the protection for /' }
          continue
        }
        if (options && arg.startsWith('-') && arg.length > 1) { if (/[rR]/.test(arg)) recursive = true; continue }
        targets.push(arg)
      }
      if (fromInput && recursive) return { level: 'dangerous', effect: 'deletes folders named by its input' }
      return worst(targets.flatMap(target => braceAlternatives(target, budget)).map(target => classifyTarget(target, recursive, scope)))
    }
    case 'find': {
      const options = skipOptions(args, new Set(['-f']))
      // -L and -H go through a root that is a link; otherwise find -delete removes only the link.
      const followsRoot = args.slice(0, args.length - options.length).some(arg => /^-[A-Za-z]*[LH]/.test(arg))
      const roots: string[] = []
      for (const arg of options) { if (arg.startsWith('-') || arg === '(' || arg === '!' || arg === ')') break; roots.push(arg) }
      const expression = options.slice(roots.length)
      const deletes = expression.includes('-delete') || expression.some((arg, index) =>
        ['-exec', '-execdir', '-ok', '-okdir'].includes(arg) && commandName(expression.slice(index + 1, index + 2)) === 'rm')
      if (!deletes) return undefined
      // A name/path test whose glob matches everything (`-name '*'`) bounds nothing, so it does not
      // count as a filter: `find ~ -name '*' -delete` still empties the home folder.
      const NAME_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename'])
      const filtered = expression.some((arg, index) => FIND_TESTS.has(arg) && !(NAME_TESTS.has(arg) && matchesEverything(expression[index + 1] ?? '')))
      return worst((roots.length ? roots : ['.']).flatMap(root => braceAlternatives(root, budget)).map(root => {
        const target = classifyTarget(root, true, scope, followsRoot)
        if (!filtered || target.level === 'ok') return target
        // A filter (find . -name '*.pyc' -delete) bounds what goes: fine in the project, approval elsewhere.
        if (target.level === 'catastrophic') return { level: 'dangerous' as const, effect: `deletes matching files anywhere under ${root}` }
        const plain = !/^~|\$/.test(root) && !root.includes(SUBST) && (isAbsolute(root) || scope.here !== null)
        const absolute = plain ? resolve(scope.here ?? scope.cwd, root) : ''
        // By its real path too: a root that a link leads out of the project is not in the project.
        const real = realForm(root, scope, followsRoot)
        const really = !real || real.path === real.scope.cwd || within(real.scope.cwd, real.path)
        if (plain && really && projectScope(scope) && (absolute === scope.cwd || within(scope.cwd, absolute))) return { level: 'ok' as const, effect: '' }
        return target
      }))
    }
    case 'git': {
      const rest = skipOptions(args, new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']))
      const sub = rest[0]
      const subArgs = rest.slice(1)
      if (sub === 'reset' && subArgs.includes('--hard')) return { level: 'dangerous', effect: 'discards uncommitted changes' }
      if (sub === 'clean' && subArgs.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force') && !subArgs.some(arg => /^-[a-zA-Z]*n/.test(arg) || arg === '--dry-run')) {
        return { level: 'dangerous', effect: 'deletes untracked files' }
      }
      if (sub === 'push' && subArgs.some(arg => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) || arg.startsWith('--force') || arg === '--mirror' || (arg.startsWith('+') && arg.length > 1))) {
        return { level: 'dangerous', effect: 'overwrites history on the remote' }
      }
      // `git checkout [<rev>] -- <paths>` overwrites those paths; `.`, `-f` and `--force` the whole tree.
      if (sub === 'checkout' && (subArgs.some(arg => arg === '.' || arg === './' || arg === ':/' || arg === '-f' || arg === '--force') || pathsAfterDashes(subArgs))) {
        return { level: 'dangerous', effect: 'discards uncommitted changes' }
      }
      // `git restore <paths>` overwrites the working tree unless it only unstages (--staged without --worktree).
      if (sub === 'restore') {
        const has = (long: string, short: string) => subArgs.some(arg => arg === long || (/^-[a-zA-Z]+$/.test(arg) && arg.includes(short)))
        if (has('--worktree', 'W') || !has('--staged', 'S')) return { level: 'dangerous', effect: 'discards uncommitted changes' }
      }
      if (sub === 'switch' && subArgs.some(arg => arg === '-f' || arg === '--force' || arg === '--discard-changes')) return { level: 'dangerous', effect: 'discards uncommitted changes' }
      if (sub === 'stash' && (subArgs[0] === 'drop' || subArgs[0] === 'clear')) return { level: 'dangerous', effect: 'deletes stashed changes' }
      if (sub === 'branch' && (subArgs.includes('-D') || (subArgs.some(arg => arg === '-d' || arg === '--delete') && subArgs.some(arg => arg === '-f' || arg === '--force')))) {
        return { level: 'dangerous', effect: 'deletes a branch even if it is not merged' }
      }
      return undefined
    }
    case 'chmod': case 'chown': case 'chgrp': {
      const recursive = args.some(arg => arg === '--recursive' || /^-[a-zA-Z]*R/.test(arg))
      const operands = args.filter(arg => !arg.startsWith('-'))
      const targets = operands.slice(1).flatMap(target => braceAlternatives(target, budget))
      if (recursive) {
        // Link or not: which of them a chmod or chown follows on the command line depends on the system.
        const hit = targets.map(target => classifyTarget(target, true, scope, true)).find(target => target.level === 'catastrophic')
        if (hit) return { level: 'catastrophic', effect: `changes ${name === 'chmod' ? 'permissions' : 'ownership'} of everything in ${targets.join(' ')}` }
      }
      if (name === 'chmod' && /^(?:0?777|(?:a|ugo)?[+=]rwx)$/.test(operands[0] ?? '')) return { level: 'dangerous', effect: 'makes files writable by everyone' }
      if (name !== 'chmod' && recursive) return { level: 'dangerous', effect: 'changes the owner of a whole folder tree' }
      return undefined
    }
    case 'kill': {
      let signal: string | undefined
      const targets: string[] = []
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg === '--') { targets.push(...args.slice(index + 1)); break }
        if (signal === undefined && targets.length === 0 && (arg === '-s' || arg === '-n')) { signal = args[++index] ?? ''; continue }
        // `kill -1 PID` sends signal 1; a lone `-1` (or one after the signal) means every process.
        if (signal === undefined && targets.length === 0 && arg.startsWith('-') && (arg !== '-1' || index < args.length - 1)) { signal = arg.slice(1); continue }
        targets.push(arg)
      }
      if (targets.includes('-1')) return { level: 'catastrophic', effect: 'kills every process you own' }
      if (signal && /^(?:9|KILL|SIGKILL)$/i.test(signal)) return { level: 'dangerous', effect: 'force-kills a process without letting it clean up' }
      return undefined
    }
    case 'killall': return { level: 'dangerous', effect: 'kills every process with that name' }
    case 'shutdown': case 'reboot': case 'halt': case 'poweroff':
      return { level: 'catastrophic', effect: 'shuts down or restarts the computer' }
    case 'init': return ['0', '6'].includes(args[0] ?? '') ? { level: 'catastrophic', effect: 'shuts down or restarts the computer' } : undefined
    case 'systemctl': case 'launchctl':
      return args.some(arg => ['poweroff', 'reboot', 'halt', 'kexec'].includes(arg)) ? { level: 'catastrophic', effect: 'shuts down or restarts the computer' } : undefined
    case 'wipefs': case 'mke2fs': return { level: 'catastrophic', effect: 'erases a disk' }
    case 'diskutil':
      return args.some(arg => /^(?:erase\w*|zeroDisk|randomDisk|secureErase|partitionDisk|reformat)$/i.test(arg) || arg === 'deleteContainer' || arg === 'deleteVolume')
        ? { level: 'catastrophic', effect: 'erases a disk' } : undefined
    case 'dd': {
      const output = args.find(arg => arg.startsWith('of='))?.slice(3)
      return output && diskDevice(output, scope) ? { level: 'catastrophic', effect: `writes straight over the disk device ${output}` } : undefined
    }
  }
  if (/^(?:mkfs|newfs)(?:[._].*)?$/.test(name)) return { level: 'catastrophic', effect: 'formats a disk' }
  if (lower === 'format' && args.some(arg => /^[a-z]:$/i.test(arg))) return { level: 'catastrophic', effect: 'formats a drive' }
  if ((lower === 'del' || lower === 'erase') && args.some(arg => /^\/s$/i.test(arg))) return { level: 'dangerous', effect: 'deletes files in every subfolder' }
  if ((lower === 'rd' || lower === 'rmdir') && args.some(arg => /^\/s$/i.test(arg))) return { level: 'dangerous', effect: 'deletes a whole folder tree' }
  return undefined
}

const WATCH_VALUE = new Set(['-n', '--interval', '-q', '--equexit'])
const ECHO_FLAG = /^-[neE]+$/

/**
 * What a command reads as input when the command line shows it: a here-string, or the output of
 * `echo …`, `printf …` or `cat` with a here-document or here-string piped into it. Undefined when
 * it is not on the command line (a file, a download) or the command has a here-document of its own
 * (the parser already looked at that).
 */
function inputOf(simple: ShellCommand): string | undefined {
  const here = simple.redirects.find(redirect => redirect.op === '<<<')
  if (here) return here.target
  if (!simple.from || simple.redirects.some(redirect => redirect.op.startsWith('<'))) return undefined
  const { words } = unwrap(simple.from.words)
  const name = commandName(words.slice(0, 1))
  // Escapes are read as echo -e and printf would: the script may be on several lines.
  const unescape = (text: string) => text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  if (name === 'echo') { let args = words.slice(1); while (args.length && ECHO_FLAG.test(args[0]!)) args = args.slice(1); return unescape(args.join(' ')) }
  if (name === 'printf') {
    const parts = words.slice(1)
    if (!parts.length) return ''
    const format = unescape(parts[0]!)
    const rest = parts.slice(1)
    if (!rest.length) return format
    // printf reuses its format for each cycle of arguments its conversions consume, so
    // `printf '%s\n' 'cd ~' 'rm -rf *'` prints two lines, not one — the parser must see both.
    const conversions = (format.match(/%[^%]/g) ?? []).length
    if (conversions === 0) return format
    let out = ''
    for (let i = 0; i < rest.length; i += conversions) { let k = 0; out += format.replace(/%[^%]/g, () => unescape(rest[i + k++] ?? '')) }
    return out
  }
  if (name === 'cat' && words.length === 1) return simple.from.input ?? simple.from.redirects.find(redirect => redirect.op === '<<<')?.target
  return undefined
}

/**
 * The shell code a command runs from its arguments or input: the script of `bash -c` (options and
 * `--` before it included), `eval`, `trap script SIGNAL`, `watch` and `su -c`, or for a shell that
 * reads its script from its input, that input when the command line shows it (see inputOf).
 * `{}` when it runs code that is not on the command line (a script file, input from elsewhere);
 * null when the command does not run shell code.
 */
function shellCode(name: string, args: string[], simple: ShellCommand, wrappedFromInput = false): { script?: string } | null {
  if (name === 'eval') return { script: args.join(' ') }
  if (name === 'trap') {
    const rest = args[0] === '--' ? args.slice(1) : args
    // `trap SIGNAL`, `trap - SIGNAL` and `trap 2 …` reset; `trap -l` and `trap -p` list.
    if (rest.length < 2 || rest[0] === '-' || /^-[lp]+$/.test(rest[0]!) || /^\d+$/.test(rest[0]!)) return {}
    return { script: rest[0] }
  }
  if (name === 'watch') return { script: skipOptions(args, WATCH_VALUE).join(' ') }
  if (name === 'su') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--command') return { script: args[i + 1] ?? '' }
      if (args[i]!.startsWith('--command=')) return { script: args[i]!.slice('--command='.length) }
    }
    return {}
  }
  if (!SHELLS.has(name)) return null
  let inline = false
  let fromInput = false
  let operand: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--' || arg === '-') { operand = args[i + 1]; break }
    if (arg === '--command') return { script: args[i + 1] ?? '' }
    if (arg.startsWith('--command=')) return { script: arg.slice('--command='.length) }
    if (arg.startsWith('--')) { if (arg === '--rcfile' || arg === '--init-file') i++; continue }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      const letters = arg.slice(1)
      if (arg[0] === '-' && letters.includes('c')) inline = true
      if (arg[0] === '-' && letters.includes('s')) fromInput = true
      // -o and -O take the option name that follows (`bash -euo pipefail -c …`).
      if (/[oO]/.test(letters)) i++
      continue
    }
    operand = arg
    break
  }
  // `… | xargs sh -c` runs `sh -c <line>` with the piped line as the script, so a `sh -c` with no
  // inline operand that a wrapper feeds from input reads that input as its script.
  if (inline) return { script: operand ?? (wrappedFromInput ? inputOf(simple) : '') }
  if (operand !== undefined && !fromInput) return {}
  return { script: inputOf(simple) }
}

/** One simple command a command line runs, as a deny or ask rule looks at it (see commandsRun). */
export interface RunCommand {
  /** Wrappers, keywords and assignments off; the command word is its base name, in lower case. */
  words: string[]
  redirects: { op: string; target: string }[]
  /** Its command word comes from a variable, a substitution, a wildcard or input: only the shell knows what runs. */
  unresolved: boolean
}

const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

/**
 * Every simple command `command` would run, for deny and ask rules, where matching too little is the
 * unsafe side: through wrappers (`env`, `nohup`, `xargs`…), keywords, assignments and paths, into the
 * scripts of `bash -c`, `eval` and a shell fed from the command line, and into `find -exec` and
 * aliases. Allow rules do not use this: they stay literal. A script file or a program's own code
 * (`bash x.sh`, `python -c`) is not looked into; a shell reading input that is not on the command
 * line counts as unresolved.
 */
export function commandsRun(command: string): RunCommand[] {
  const found: RunCommand[] = []
  const state: ParseState = { overflow: false }
  const budget = newBudget()
  const visit = (source: string, depth: number) => {
    for (const simple of parseShellCommands(source, depth, state)) {
      const unwrapped = unwrap(simple.words)
      if (!unwrapped.words.length) continue
      // `{rm,f}` is `rm f` to the shell.
      const first = unwrapped.words[0]!
      const words = first.includes('{') && first.includes(',') ? [...braceAlternatives(first, budget), ...unwrapped.words.slice(1)] : unwrapped.words
      const name = commandName(words.slice(0, 1))
      const args = words.slice(1)
      // A lone wildcard is a case pattern (`*) …`), which the parser hands over as a word; `[` is the test command.
      const wildcard = words[0] !== '[' && /[*?[]/.test(words[0]!) && (words.length > 1 || words[0]!.includes('/'))
      // The words of `for x in …`, `select` and `case … in` are not a command.
      const header = ['for', 'select', 'case'].includes(simple.words[0] ?? '')
      let unresolved = !header && (wildcard || /[$\u0001]|\{\}/.test(words[0]!))
      const code = shellCode(name, args, simple, unwrapped.fromInput)
      if (code) {
        if (code.script !== undefined) { if (depth < MAX_NESTING) visit(code.script, depth + 1); else state.overflow = true }
        else if (simple.from) unresolved = true
      }
      if (name === 'find') {
        for (let index = 0; index < args.length; index++) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index]!)) continue
          const end = args.slice(index + 1).findIndex(arg => arg === ';' || arg === '+')
          visit(args.slice(index + 1, end < 0 ? undefined : index + 1 + end).map(arg => /[\s'"]/.test(arg) ? JSON.stringify(arg) : arg).join(' '), depth + 1)
        }
      }
      if (name === 'alias') for (const arg of args) { const equals = arg.indexOf('='); if (equals > 0) visit(arg.slice(equals + 1), depth + 1) }
      found.push({ words: [name.toLowerCase(), ...(name.toLowerCase() === 'git' ? skipOptions(args, GIT_VALUE) : args)], redirects: simple.redirects, unresolved })
    }
  }
  visit(command, 0)
  if (state.overflow) found.push({ words: [], redirects: [], unresolved: true })
  return found
}

/** Two absolute paths are the same folder, matched case-insensitively (macOS and Windows disks are). */
function samePath(a: string, b: string): boolean { return a === b || a.toLowerCase() === b.toLowerCase() }
/** `child` is the same as, or inside, `parent`, case-insensitively. */
function withinOrEqual(parent: string, child: string): boolean { return samePath(parent, child) || within(parent, child) || within(parent.toLowerCase(), child.toLowerCase()) }

/** Raw text that a shell may run as `rm -r` of the disk, the home folder or a system folder; see catastrophicText. */
function catastrophicPath(target: string, home: string, project: string): string | undefined {
  // A stray shell punctuation char glued to the path (perl's `q{…}`, a here-string, a trailing `;`).
  const bare = target.replace(/^[{(<]+/, '').replace(/[})>;,]+$/, '')
  let path = bare
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1)
  else if (/^\$HOME(?=\/|$)/.test(path)) path = home + path.slice('$HOME'.length)
  else if (!path.startsWith('/')) return bare.includes('$') ? undefined : catastrophicThroughLink(bare, home, project)
  path = withoutAliases(posix.normalize(path))
  if (path.length > 1) path = path.replace(/\/+$/, '')
  const everything = matchesEverything(posix.basename(path))
  if (everything) path = posix.dirname(path)
  if (path === '/') return everything ? 'deletes everything on the disk' : 'deletes the whole disk'
  if (samePath(path, home)) return everything ? 'deletes everything in your home folder' : 'deletes your home folder'
  if (withinOrEqual(path, home) && !samePath(path, home)) return `deletes ${path}, which contains your home folder`
  if (systemFolder(path)) return `deletes the system folder ${path}`
  return path.includes('$') ? undefined : catastrophicThroughLink(path + (target.endsWith('/') || everything ? '/' : ''), home, project)
}

/** The same for a path that only a symbolic link makes catastrophic (`rm -rf link-home/`, also when read as text in a quoted script). */
function catastrophicThroughLink(path: string, home: string, project: string): string | undefined {
  const scope: Scope = { cwd: project, home, here: project }
  const wild = matchesEverything(posix.basename(path))
  const real = realForm(wild ? posix.dirname(path) + '/' : path, scope, false)
  if (!real) return undefined
  const lexical = withoutAliases(posix.normalize(isAbsolute(path) ? path : `${real.scope.cwd}/${path}`)).replace(/\/+$/, '')
  const reached = real.path.length > 1 ? real.path.replace(/\/+$/, '') : real.path
  if (samePath(reached, wild ? posix.dirname(lexical) : lexical)) return undefined
  const realHome = real.scope.home
  const leads = ` (${path} leads there through a symbolic link)`
  if (reached === '/') return `deletes the whole disk${leads}`
  if (samePath(reached, realHome)) return `deletes your home folder${leads}`
  if (withinOrEqual(reached, realHome)) return `deletes ${reached}, which contains your home folder${leads}`
  if (systemFolder(reached)) return `deletes the system folder ${reached}${leads}`
  return undefined
}

/** `rm` as a word at the end of a token: `rm`, `/bin/rm`, `x=rm`, `!rm`, `q{rm`; never `charm`/`confirm`. */
const RM_WORD = /(?:^|[^A-Za-z0-9_])rm$/
/** Normalises the raw text for the fail-closed scan: joins line continuations, turns `$IFS`/`${IFS}` and `${HOME…}` forms into plain tokens, drops quotes, backticks and backslashes. */
function normaliseRaw(command: string): string {
  return command
    .replace(/\\\r?\n/g, '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ')
    .replace(/\$\{HOME(?:[-:%#/][^}]*)?\}/g, '$HOME')
    .replace(/['"`\\]/g, '')
}

/**
 * The fail-closed layer over the raw text: `rm` with -r/-R/--recursive of /, the home folder (~,
 * $HOME, ${HOME}), a folder above it or a system folder, or `--no-preserve-root`, anywhere in the
 * command once quotes, backslashes, `$IFS` and brace lists are taken out. It catches what the
 * parser does not follow or reads as data (`echo "rm -rf ~" | sh`, `ssh host 'rm -rf ~'`, a
 * here-document, `x='rm -rf ~'; eval "$x"`, `{rm,-rf,~}`, `rm${IFS}-rf${IFS}~`). Quoted text in a
 * note (`echo "rm -rf /"`) is an accepted false positive: the refusal says to use FileWrite.
 */
function catastrophicText(command: string, home: string, project: string, budget: ExpandBudget): CommandRisk | undefined {
  const text = normaliseRaw(command)
  for (const segment of text.split(/[;&|\n]/)) {
    // Flatten brace lists so `{rm,-rf,~}` and `rm -rf {~,x}` become plain words to scan.
    const tokens = segment.split(/[\s()]+/).filter(Boolean).flatMap(word => braceAlternatives(word, budget))
    for (let index = 0; index < tokens.length; index++) {
      // Each token looked at is a unit of work; a command with thousands of them stops here (and
      // fails closed) rather than re-scanning the tail from every `rm`.
      if (budget.work <= 0) { budget.truncated = true; return undefined }
      budget.work--
      if (!RM_WORD.test(tokens[index]!)) continue
      const flags: string[] = []
      let recursive = false
      let options = true
      // Everything after `rm` in the segment may be its target; a recursive flag anywhere before a
      // catastrophic target (even with junk between) is enough.
      for (let j = index + 1; j < tokens.length; j++) {
        if (budget.work <= 0) { budget.truncated = true; break }
        budget.work--
        const token = tokens[j]!
        if (options && token === '--') { options = false; continue }
        if (options && token === '--no-preserve-root') return { level: 'catastrophic', command: 'rm --no-preserve-root', effect: 'turns off the protection for /' }
        if (options && (token === '--recursive' || /^-[a-zA-Z]+$/.test(token))) { flags.push(token); if (token === '--recursive' || /[rR]/.test(token)) recursive = true; continue }
        if (!recursive) continue
        const effect = catastrophicPath(token, home, project)
        if (effect) return { level: 'catastrophic', command: ['rm', ...flags, token].join(' '), effect: `${effect}, and it is in the command text, where a shell can run it (quoted text and here-documents count; use FileWrite to write such text to a file)` }
      }
    }
  }
  return undefined
}

function displayCommand(command: ShellCommand): string {
  const quote = (word: string) => /[\s'"]/.test(word) || word === '' ? JSON.stringify(word) : word
  const parts = [...command.words.map(quote), ...command.redirects.map(redirect => `${redirect.op} ${quote(redirect.target)}`)]
  const text = parts.join(' ').split(SUBST).join('$(…)')
  return text.length > 120 ? text.slice(0, 117) + '...' : text
}

/**
 * The most serious risk in `command` when run in `cwd`, or null. Catastrophic findings win over
 * dangerous ones; within a level the first one is reported.
 */
export function assessCommandRisk(command: string, cwd: string, home: string = homedir()): CommandRisk | null {
  const project = resolve(cwd)
  const userHome = resolve(home)
  const found: CommandRisk[] = []
  const state: ParseState = { overflow: false }
  // One work budget for all the brace expansion and raw-text scanning this command triggers, so a
  // pathological command (dozens of brace groups, thousands of tokens) stays bounded; see newBudget.
  const budget = newBudget()
  if (FORK_BOMB.test(command)) found.push({ level: 'catastrophic', command: ':(){ :|:& };:', effect: 'is a fork bomb that freezes the computer' })
  const lookups: RealLookups = { left: MAX_REAL_LOOKUPS, over: false }
  const visit = (source: string, depth: number, start: string | null) => {
    const scope: Scope = { cwd: project, home: userHome, here: start, lookups }
    for (const simple of parseShellCommands(source, depth, state)) {
      const { words, fromInput } = unwrap(simple.words)
      const shown = displayCommand(simple)
      for (const redirect of simple.redirects) {
        if (redirect.op.includes('>') && diskDevice(redirect.target, scope)) found.push({ level: 'catastrophic', command: shown, effect: `writes straight over the disk device ${redirect.target}` })
      }
      for (const word of [...simple.words.slice(1), ...simple.redirects.map(redirect => redirect.target)]) {
        const path = word.replace(/^[a-z]+=/, '')
        const device = STREAM_DEVICES.find(prefix => path === prefix || path.startsWith(prefix))
        if (device) { found.push({ level: 'dangerous', command: shown, effect: `uses ${device.replace(/\/$/, '')}, which can hang the command or flood its output` }); break }
      }
      if (!words.length) continue
      const name = commandName(words.slice(0, 1))
      if ((name === 'cd' || name === 'pushd' || name === 'popd') && !simple.isolated) {
        // Later relative paths resolve from here (approximately: a subshell's cd is not undone).
        const target = name === 'popd' ? '-' : skipOptions(words.slice(1))[0] ?? '~'
        const expanded = target === '~' || target.startsWith('~/') ? userHome + target.slice(1) : target.replace(/^\$\{?HOME\}?(?=\/|$)/, userHome)
        scope.here = expanded === '-' || expanded.includes(SUBST) || expanded.includes('$') || expanded.startsWith('~') || (!isAbsolute(expanded) && scope.here === null)
          ? null : resolve(scope.here ?? project, expanded)
        continue
      }
      const code = shellCode(name, words.slice(1), simple, fromInput)
      if (code) {
        if (code.script !== undefined) {
          if (depth < MAX_NESTING) visit(code.script, depth + 1, scope.here)
          else state.overflow = true
        }
        continue
      }
      const risk = assessSimple(words, fromInput, scope, budget)
      if (risk && risk.level !== 'ok') found.push({ level: risk.level, command: shown, effect: risk.effect })
    }
  }
  visit(command, 0, project)
  // What the parser found first (it names the sub-command), then the fail-closed layer: the raw
  // text, and source nested deeper than the parser followed.
  // The raw scan has a budget of its own, so a command that used up the parser's still gets scanned.
  const rawBudget = newBudget()
  const parsed = found.find(risk => risk.level === 'catastrophic') ?? catastrophicText(command, userHome, project, rawBudget)
  if (rawBudget.truncated || lookups.over) budget.truncated = true
  if (parsed) return parsed
  if (state.overflow) {
    const shown = command.replace(/\s+/g, ' ').replace(/`/g, "'").trim()
    return { level: 'catastrophic', command: shown.length > 80 ? shown.slice(0, 77) + '...' : shown, effect: `nests shells or command substitutions more than ${MAX_NESTING} levels deep, too deep for G-Code to check what it runs` }
  }
  // The brace expansion or the raw-text scan hit its work budget: too much to check, so fail closed
  // (needs approval) unless a real finding already outranks it.
  if (budget.truncated) return found.find(risk => risk.level === 'dangerous') ?? { level: 'dangerous', command: (command.length > 80 ? command.slice(0, 77) + '...' : command).replace(/\s+/g, ' ').trim(), effect: 'expands too many brace alternatives or is too long for G-Code to check in full' }
  return found[0] ?? null
}

/** Whether git arguments name paths after `--` (which checkout then overwrites). */
function pathsAfterDashes(args: string[]): boolean {
  const dashes = args.indexOf('--')
  return dashes >= 0 && dashes < args.length - 1
}

/** The deny text for a catastrophic command; also the error when call() is reached directly. */
function refusal(risk: CommandRisk): string {
  return `Refused: \`${risk.command}\` ${risk.effect}. G-Code never runs this, in any permission mode, even with approval.`
}

/** The approval reason for a dangerous command. */
function warning(risk: CommandRisk): string {
  return `Risky command: \`${risk.command}\` ${risk.effect}. It runs only with your approval (or in bypass mode).`
}

const UNC_REFUSAL = 'Refused: the command contains a UNC path (\\\\server\\share or file://server), which could leak your network credentials.'

/**
 * Guillotine Mode evidence (~/.gcode/incidents) is out of reach of tools. Without the guard no
 * sandbox runs, so a command naming the folder is refused here; an obfuscated name can still get
 * through, which the evidence's hash index makes detectable.
 */
const INCIDENT_MENTION = /\.gcode[\\/]+incidents\b/i
const INCIDENT_REFUSAL = 'Refused: incident evidence in ~/.gcode/incidents is read-only and unavailable to tools. Review it in Settings > Guillotine Mode.'

/**
 * G-Code's settings and key files are out of reach of tools in every permission mode, as FileRead,
 * Grep and Glob already refuse them. A command with a path to the folder itself (`ls -la ~/.gcode`,
 * `cd ~/.gcode`, `grep -r x ~/.gcode`), a key file in it, or a wildcard that reaches them is refused
 * too. Its other folders (projects, skills) stay open, so does any project's own .gcode, and so does
 * text that only mentions the path. An obfuscated path can still get through, which is why the keys
 * are also masked in everything a tool returns (security/secretValues.ts).
 */
const SECRET_REFUSAL = "Refused: ~/.gcode holds G-Code's own settings and API keys, which tools may not read in any permission mode. Its other folders, such as ~/.gcode/projects and ~/.gcode/skills, are open. Settings are changed in G-Code's Settings."

/**
 * A command's words as the shell would see them, quotes removed. A `~` or `$` a quote keeps the
 * shell from expanding becomes NUL, so it cannot read as the home folder.
 */
function shellWords(command: string): string[] {
  const words: string[] = []
  let word = '', started = false, quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") { if (c === "'") quote = ''; else word += c === '~' || c === '$' ? '\0' : c }
    else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\') word += command[++i] ?? ''
      else word += c === '~' ? '\0' : c
    } else if (c === "'" || c === '"') { quote = c; started = true }
    else if (c === '\\') { word += command[++i] ?? ''; started = true }
    else if (/[\s;|&()<>]/.test(c)) { if (started) words.push(word); word = ''; started = false }
    else { word += c; started = true }
  }
  if (started) words.push(word)
  return words
}

/** Whether a path inside a home folder (`.gcode/settings.json`) reaches G-Code's key files. */
function reachesSecrets(inHome: string): boolean {
  const [folder, ...rest] = inHome.replace(/^(?:\.\/)+/, '').split('/')
  const isFolder = folder === '.gcode' || (folder!.startsWith('.') && /[*?[]/.test(folder!) && new RegExp(`^${folder!.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test('.gcode'))
  if (!isFolder) return false
  const first = rest[0] ?? ''
  return !first || rest.includes('..') || /[*?[{]/.test(first) || /^\.gcode-(?:settings|permissions)-/.test(first) || SECRET_ENTRIES.some(entry => first === entry)
}

function namesGcodeSecrets(command: string, cwd: string, home: string = homedir()): boolean {
  const lowerHome = home.toLowerCase()
  const homes = ['~', '$home', '${home}', lowerHome]
  const isHome = (word: string) => homes.includes(word.replace(/\/+$/, ''))
  let atHome = cwd === home
  const words = shellWords(command).map(word => word.toLowerCase())
  return words.some((word, index) => {
    if (words[index - 1] === 'cd') atHome = isHome(word)
    // `--file=~/.gcode/settings.json`: the shell sees a word; the path is what follows `=`.
    return [word, word.slice(word.indexOf('=') + 1)].some(path => {
      const start = homes.find(prefix => path.startsWith(`${prefix}/`))
      if (start) return reachesSecrets(path.slice(start.length + 1))
      // Another home folder (a link's target, another user's); any other absolute path is somebody's project.
      const other = /^\/(?:users\/[^/]+|home\/[^/]+|root)\/(.*)$/.exec(path)
      if (other) return reachesSecrets(other[1]!)
      return atHome && reachesSecrets(path)
    })
  })
}

/**
 * Why `command` is never run (UNC path, catastrophic command), or null. An in-place edit
 * (`sed -i`, `perl -pi`) is an ordinary command: the files a command changes get their baselines
 * like FileEdit's, so it runs under the usual approval.
 */
export function blockedCommand(command: string, cwd: string): string | null {
  if (containsVulnerableUNCPath(command)) return UNC_REFUSAL
  if (INCIDENT_MENTION.test(command)) return INCIDENT_REFUSAL
  if (namesGcodeSecrets(command, cwd)) return SECRET_REFUSAL
  const risk = assessCommandRisk(command, cwd)
  if (risk?.level === 'catastrophic') return refusal(risk)
  return null
}

/**
 * The environment a command runs with. It has no terminal and no input, so nothing may wait for
 * an editor or a prompt that no one can answer: git's editor is `true` (`git commit` without -m
 * stops at once with "empty commit message"; --amend, merge and rebase --continue keep their
 * message, and `rebase -i` runs its list as it is) and git asks for no credentials on a terminal.
 * This overrides the user's own GIT_EDITOR, which cannot work without a terminal; hook variables
 * still win.
 */
function commandEnv(hookEnv?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', ...hookEnv }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** A saved output file's name: `bash-<session>-<time>-<random>[-stderr].txt`. */
const SAVED_NAME = /^(?:bash|request)-([^/]{1,8})-(\d+)-[0-9a-f]{6}(?:-stderr)?\.txt$/
/** Over the size limit, a saved output younger than this goes after older ones: its session may just have been told about it. */
const SAVED_SESSION_RECENT_MS = 60 * 60_000

/** Folders swept by this process, and when: a sweep runs at most once a minute per folder. */
const swept = new Map<string, number>()

/**
 * Deletes saved outputs in `folder` (.gcode/tool-output) that are older than SAVED_MAX_AGE_MS,
 * then the oldest ones while all of them take more than SAVED_TOTAL_BYTES; files of sessions no
 * process has open go first, then those of other running sessions, then the current session's
 * (`session`, its 8-character prefix), and `keep` (the file being written) is never deleted. Only regular files named like a saved output are touched; links are
 * not followed. Best effort and in the background.
 */
export async function sweepToolOutput(folder: string, session: string, keep?: string, now = Date.now()): Promise<void> {
  let names: string[]
  try { names = await readdir(folder) } catch { return }
  const files: Array<{ path: string; size: number; time: number; owner: string; current: boolean }> = []
  for (const name of names) {
    if (!SAVED_NAME.test(name)) continue
    const path = join(folder, name)
    if (path === keep) continue
    try {
      const stat = await lstat(path)
      if (stat.isFile()) files.push({ path, size: stat.size, time: stat.mtimeMs, owner: SAVED_NAME.exec(name)![1]!, current: name.startsWith(`bash-${session}-`) || name.startsWith(`request-${session}-`) })
    } catch { /* Gone already. */ }
  }
  const remove = async (path: string) => { try { await unlink(path); return true } catch { return false } }
  let total = 0
  const kept: typeof files = []
  for (const file of files) {
    if (!file.current && now - file.time > SAVED_MAX_AGE_MS && await remove(file.path)) continue
    kept.push(file)
    total += file.size
  }
  // Over the limit, what no running session was told about goes first: another session may still read
  // what it saved. Then that session's older files, the largest first (the fewest files it was told
  // about are gone), and this session's last.
  let live = new Set<string>()
  try { const store = dirname(folder); live = new Set((await readdir(store)).filter(name => name.endsWith('.lock') && sessionInUse(store, name.slice(0, -5))).map(name => name.slice(0, 8))) } catch { /* Nothing known to run. */ }
  const rank = (file: typeof files[number]) => file.current ? 4 : (live.has(file.owner) ? 2 : 0) + (now - file.time > SAVED_SESSION_RECENT_MS ? 0 : 1)
  kept.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 || rank(a) === 3 ? b.size - a.size : 0) || a.time - b.time)
  for (const file of kept) {
    if (total <= SAVED_TOTAL_BYTES) break
    if (await remove(file.path)) total -= file.size
  }
}

/** Writes all of `data` to `fd` without blocking. */
function writeAll(fd: number, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const next = (offset: number) => write(fd, data, offset, data.byteLength - offset, null, (error, written) => {
      if (error) return reject(error)
      if (offset + written < data.byteLength) next(offset + written)
      else resolve()
    })
    next(0)
  })
}

/**
 * One stream of a command, saved to `.gcode/tool-output` as it arrives once it is longer than
 * what is shown inline, so the file has all of it (up to MAX_SAVED_BYTES), not only what is kept
 * in memory. The folder comes from generatedFolder: its ignore file is in place before the first
 * byte is written, and a link that leads out of the project is refused.
 *
 * write() runs for every chunk the command prints, so it does little: past MAX_SAVED_BYTES only
 * a byte count, and the file is written in the background, chunks that arrive meanwhile in one go.
 */
class SavedOutput {
  /** Bytes of the stream. */
  bytes = 0
  /** Bytes in the file. */
  saved = 0
  path?: string
  error?: string
  /** Bytes taken for the file (at most MAX_SAVED_BYTES); lines and characters are counted in those. */
  private taken = 0
  /** Newlines in the bytes taken. */
  newlines = 0
  /** UTF-16 units the bytes taken decode to. */
  units = 0
  private endsInNewline = true
  private fd?: number
  /** Taken, not written yet; until the file exists, all of the stream. */
  private queue: Uint8Array[] = []
  private queued = 0
  private writing?: Promise<void>
  /** Bytes taken but not written, as Latin-1: they may be the start of a key (see maskStream). */
  private held = ''
  /** Keys known when the file was opened, as Latin-1, longest first. */
  private secrets: string[] = []
  private ending = false

  constructor(private readonly cwd: string, private readonly sessionId: string, private readonly stream: 'stdout' | 'stderr') {}

  write(chunk: Uint8Array): void {
    if (!chunk.byteLength) return
    this.bytes += chunk.byteLength
    const room = MAX_SAVED_BYTES - this.taken
    if (room <= 0) return
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
    this.taken += part.byteLength
    let newlines = 0
    let units = 0
    for (let index = 0; index < part.byteLength; index++) {
      const byte = part[index]!
      if (byte === 10) newlines++
      // A character's first byte; one of four bytes is a surrogate pair.
      if ((byte & 0xc0) !== 0x80) units += byte >= 0xf0 ? 2 : 1
    }
    this.newlines += newlines
    this.units += units
    this.endsInNewline = part[part.byteLength - 1] === 10
    if (this.error !== undefined) return
    // The pipe's chunk may be reused once this returns.
    this.queue.push(Buffer.from(part))
    this.queued += part.byteLength
    // A UTF-16 unit takes at least one byte: until then the output fits inline.
    if (this.fd === undefined && this.bytes <= MAX_OUTPUT_INLINE) return
    this.flush()
  }

  /** All of the stream was counted (it is at most MAX_SAVED_BYTES). */
  get counted(): boolean { return this.taken === this.bytes }

  /** Lines of the stream, when all of it was counted; else of its first MAX_SAVED_BYTES. */
  get lines(): number { return this.newlines + (this.taken > 0 && !this.endsInNewline ? 1 : 0) }

  /**
   * Once the command has ended. `keep`: the stream is cut inline, so the file is needed, even
   * when it was short enough that none was made yet. Otherwise the file is deleted.
   */
  async finish(keep: boolean): Promise<void> {
    if (keep) { this.ending = true; this.flush() }
    while (this.writing) await this.writing
    if (this.fd !== undefined) { try { closeSync(this.fd) } catch { /* Already closed. */ } this.fd = undefined }
    this.queue = []
    this.queued = 0
    if (!keep && this.path) { try { unlinkSync(this.path) } catch { /* Gone already. */ } this.path = undefined }
  }

  /** The end of the truncation note: where the whole stream is, or why it is not all there. */
  note(name: 'output' | 'stderr'): string {
    const counted = this.counted
    const total = counted ? `${name} truncated: ${plural(this.bytes, 'byte')}, ${plural(this.lines, 'line')} in all` : `${name} truncated: ${plural(this.bytes, 'byte')} in all`
    if (this.path && this.saved === this.bytes) return `${total}; full ${name} saved to ${this.path}`
    const first = `the first ${plural(this.saved, 'byte')}${!counted && this.saved === this.taken ? ` (${plural(this.lines, 'line')})` : ''}`
    if (this.path && this.saved > 0) return `${total}; only ${first} were saved${this.error ? ` (${this.error})` : ''}, to ${this.path}`
    return `${total}; it could not be saved${this.error ? `: ${this.error}` : ''}`
  }

  /** Starts writing what is queued, unless a write is under way (it starts the next one when it ends). */
  private flush(): void {
    if (this.writing || this.error !== undefined || (!this.queued && !(this.ending && this.held))) return
    if (this.fd === undefined && !this.open()) return
    const fd = this.fd!
    const data = this.queue.length === 1 ? this.queue[0]! : Buffer.concat(this.queue, this.queued)
    this.queue = []
    this.queued = 0
    // The file holds no key either: it gets archived with ~/.gcode/projects. What may be the start of one waits for the next chunk.
    const text = this.held + data.toString('latin1')
    const { out, held } = maskStream(text, this.secrets, this.ending, !this.counted)
    this.held = held
    const done = text.length - held.length, written = Buffer.from(out, 'latin1')
    this.writing = writeAll(fd, written).then(
      // Bytes of the stream: the line and character counts in the note are of the stream too.
      () => { this.saved += done },
      error => { this.error = errorText(error); this.queue = []; this.queued = 0 },
    ).finally(() => { this.writing = undefined; this.flush() })
  }

  private open(): boolean {
    if (this.path !== undefined) return false
    try {
      const folder = generatedFolder(this.cwd, 'tool-output')
      const path = join(folder, `bash-${this.sessionId.slice(0, 8)}-${Date.now()}-${randomUUID().slice(0, 6)}${this.stream === 'stderr' ? '-stderr' : ''}.txt`)
      // 'wx': never follows or replaces something already there.
      this.fd = openSync(path, 'wx', 0o600)
      this.path = path
      this.secrets = knownSecrets().map(secret => Buffer.from(secret).toString('latin1')).sort((a, b) => b.length - a.length)
      const last = swept.get(folder)
      if (last === undefined || Date.now() - last > 60_000) { swept.set(folder, Date.now()); void sweepToolOutput(folder, this.sessionId.slice(0, 8), path) }
      return true
    } catch (error) { this.error = errorText(error); this.queue = []; this.queued = 0; return false }
  }
}

/**
 * How many UTF-16 units of each stream are shown inline: `total` for both together, so the
 * result (with the notes on where each stream is saved) stays whole under the context cap. A
 * stream shorter than half keeps all of itself and leaves the rest to the other; two long ones
 * get half each.
 */
export function inlineShares(stdout: number, stderr: number, total = MAX_OUTPUT_INLINE): { stdout: number; stderr: number } {
  if (stdout + stderr <= total) return { stdout, stderr }
  const half = Math.floor(total / 2)
  if (stdout <= half) return { stdout, stderr: total - stdout }
  if (stderr <= half) return { stdout: total - stderr, stderr }
  return { stdout: half, stderr: total - half }
}

/**
 * The output shown inline for a command run in `cwd`: MAX_OUTPUT_INLINE, less what a long project
 * path adds to the notes past the room the context cap (MAX_TOOL_RESULT_CHARS) leaves for them,
 * the error line, the exit code and the note on what was left running.
 */
function inlineTotal(cwd: string): number {
  const note = 200 + generatedDataPath(cwd, 'tool-output').length + 80
  return Math.max(4_000, Math.min(MAX_OUTPUT_INLINE, MAX_TOOL_RESULT_CHARS - 2 * note - 1_000))
}

const newlinesIn = (text: string) => { let count = 0; for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count++; return count }

/**
 * A stream as the model sees it: whole, or, within `share` units, its start and its end with a
 * note between them on what was left out (characters and lines) and where all of it is saved.
 * `text`: its start as kept in memory (cut when `truncated`); `tail`: its end (see keepTail).
 */
function shownOutput(text: string, tail: string, truncated: boolean, share: number, file: SavedOutput, name: 'output' | 'stderr'): { text: string; path?: string } {
  if (!truncated && text.length <= share) return { text }
  const head = headOutput(text, Math.floor(share * HEAD_SHARE))
  const end = tailOutput(tail, share - head.length)
  const saved = !!file.path && file.saved > 0
  // Counted while it ran when it was cut in memory; the line numbers are those of the saved file.
  const units = truncated ? file.counted ? file.units : undefined : text.length
  const omitted = units !== undefined ? plural(Math.max(0, units - head.length - end.length), 'character') : plural(Math.max(0, file.bytes - Buffer.byteLength(head) - Buffer.byteLength(end)), 'byte')
  const first = newlinesIn(head) + 1
  const endsLine = end.length < tail.length ? tail.charCodeAt(tail.length - end.length - 1) === 10 : !truncated
  const last = file.counted ? Math.max(first, file.newlines - newlinesIn(end) + (endsLine ? 0 : 1)) : undefined
  const lines = last === undefined ? `from line ${first}` : last === first ? `line ${first}` : `lines ${first}-${last}`
  const omittedNote = `... (omitted here: ${lines}, ${omitted}${saved ? `; FileRead with offset ${first} reads them` : ''})`
  return { text: `${head}${head.endsWith('\n') ? '' : '\n'}... (${file.note(name)})\n${omittedNote}\n${end}`, ...(saved ? { path: file.path } : {}) }
}

/** How long a background start waits at most for a line that says it is up, or for an early exit. */
const START_LOOK_MS = 2000

/** In a one-shot (-p) run, background tasks end with the run: the model must not promise otherwise. */
const HEADLESS_TASKS = 'This is a one-shot (-p) run: G-Code stops every background task when the run ends, right after your final answer. Use it before you finish, and do not tell the user it keeps running.'

/** The end of a background start's output (`output`: all of it that is kept), and a note when that is not all of it, as TaskOutput gives. */
function startTail(now: BackgroundShellInfo, output: string): string {
  const { text, omitted } = shownTail(output, 3000, backgroundShells.trimmed(now.id), now.status === 'running')
  return `${omitted ? '… (earlier output omitted; TaskOutput shows more)\n' : ''}${text}`
}

/** What a background start reports: running (with its address and output so far), or ended (with its exit code and output). */
function backgroundStartResult(now: BackgroundShellInfo, output = now.tail, headless = false): ToolResult<BashOutput> {
  const task = `{"task_id":"${now.id}"}`
  const details = backgroundShells.details(now.id)
  if (now.status === 'running') {
    // Told to stop as it started (the turn was stopped): it does not run on, and there is nothing to stop.
    const head = details?.stopping
      ? `Background task ${now.id} is ${shellState(now, details)}: it was told to stop as it started and does not keep running. Its output stays available with TaskOutput ${task} while this G-Code session runs.`
      : `Background task ${now.id} is ${shellState(now, details)}. Read its output with TaskOutput ${task} and stop it with TaskStop ${task}. ${headless ? HEADLESS_TASKS : 'It runs until it exits or is stopped, and it ends when this G-Code session is closed, stopped or restarted.'}`
    const address = serverAddress(output)
    const body = now.tail ? `Output so far:\n${startTail(now, output)}` : 'No output yet.'
    return { success: true, output: { stdout: `${head}\n${address ? `Address: ${address}\n` : ''}${body}`, stderr: '', exitCode: null, interrupted: false } }
  }
  // It never ran: nothing to read or stop.
  if (details?.startError !== undefined) {
    return { success: false, output: { stdout: `Background task ${now.id} could not be started: ${details.startError}.`, stderr: '', exitCode: null, interrupted: false }, error: `Failed to start background command: ${details.startError}` }
  }
  // It has already ended: there is nothing left to stop.
  const ended = now.status === 'stopped' ? 'was stopped' : now.exitCode !== null ? `exited with code ${now.exitCode}` : 'ended, but its exit status was not reported,'
  const head = `Background task ${now.id} ${ended} and is no longer running. Its output stays available with TaskOutput ${task} while this G-Code session runs.`
  const body = now.tail ? `Output:\n${startTail(now, output)}` : 'No output.'
  const failed = now.status === 'failed'
  return {
    success: !failed,
    output: { stdout: `${head}\n${body}`, stderr: '', exitCode: now.exitCode, interrupted: false },
    error: failed ? now.exitCode !== null ? `Background command exited with code ${now.exitCode}` : 'Background command ended, but its exit status was not reported' : undefined,
  }
}

/** What the model is told about processes a foreground command left running, now tracked as `task`. */
function leftRunningNote(task: BackgroundShellInfo, headless: boolean, output: boolean): string {
  const id = `{"task_id":"${task.id}"}`
  return `[Still running: processes this command started in the background (process group ${task.pid}). G-Code now tracks them as background task ${task.id}; ${output ? `read what they print with TaskOutput ${id} and ` : ''}stop them with TaskStop ${id}. ${headless ? 'This one-shot (-p) run stops them when it ends.' : 'They are stopped when this G-Code session ends.'} Start servers and watchers with run_in_background instead of &.]`
}

/** ` (exit 137)`: what a shell reports for a command that died of this signal. */
function signalExit(signal: string): string {
  const number = osConstants.signals[signal as NodeJS.Signals]
  return number ? ` (exit ${128 + number})` : ''
}

/** The timeout error, with what to do instead. */
function timeoutError(timeout: number): string {
  const follow = 'run_in_background and follow it with TaskOutput (its wait_ms waits for the end)'
  const instead = timeout < MAX_TIMEOUT ? `Rerun it with a longer timeout (up to 600000 ms), or with ${follow}.` : `Rerun it with ${follow}.`
  return `Command timed out after ${+(timeout / 1000).toFixed(1)} s and was stopped. ${instead}`
}

// ============================================================================
// Tool Implementation
// ============================================================================

export const BashTool: Tool<BashInput, BashOutput> = {
  name: 'Bash',
  description: 'Execute shell commands and return stdout/stderr',
  inputSchema,

  async call(input, context): Promise<ToolResult<BashOutput>> {
    context.signal?.throwIfAborted()
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    // The same checks run in checkPermissions(), before any approval prompt; these catch a direct
    // call. Dangerous (not catastrophic) commands are not re-checked here: by now the user has
    // approved them or the session is in bypass mode.
    const refused = blockedCommand(input.command, context.cwd)
    if (refused) return { success: false, error: refused }

    if (input.run_in_background) {
      let started
      try { started = backgroundShells.start(input.command, context.cwd, commandEnv(context.hookEnv), input.description, taskSession(context)) }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
      // A moment for servers to print their URL, or for an early failure: until a line that says
      // it is up (and the lines right after it) or the exit, at most START_LOOK_MS.
      await backgroundShells.waitForStart(started.id, { maxMs: START_LOOK_MS, signal: context.signal })
      const now = backgroundShells.get(started.id) ?? started
      // The reply says it ended (or is being stopped): no notice of its end is due later.
      if (now.status !== 'running' || backgroundShells.details(now.id)?.stopping) backgroundShells.markSeen(now.id)
      return backgroundStartResult(now, backgroundShells.output(started.id) ?? now.tail, context.isHeadless)
    }

    const windows = process.platform === 'win32'
    const saved = { stdout: new SavedOutput(context.cwd, context.sessionId, 'stdout'), stderr: new SavedOutput(context.cwd, context.sessionId, 'stderr') }
    // runSubprocess never rejects.
    const run = await runSubprocess(windows ? ['cmd.exe', '/c', input.command] : ['bash', '-c', input.command], {
      cwd: context.cwd,
      env: commandEnv(context.hookEnv),
      timeoutMs: timeout,
      signal: context.signal,
      // Its own process group: a stop reaches everything the command started.
      group: !windows,
      maxOutput: MAX_OUTPUT_MEMORY,
      keepTail: MAX_OUTPUT_MEMORY,
      onData: (stream, chunk) => saved[stream].write(chunk),
      killOnExit: true,
      reportLeftGroup: true,
    })
    // What the command left running in its group (`server > log 2>&1 &`, or a `server &` that
    // still prints to the pipes, which it then reads) becomes a background task at once: listed,
    // stoppable, and stopped with the session instead of left behind.
    const leftover = run.groupLeft && run.pid !== undefined ? backgroundShells.adopt(run.pid, input.command, context.cwd, input.description, taskSession(context), run.pipes) : undefined
    if (!leftover) run.pipes?.release()
    // Long output: its start and its end inline, all of it in a file. One share for both streams, so the
    // result keeps both notes (and the exit code) under the context cap.
    const shares = inlineShares(run.stdout.length, run.stderr.length, inlineTotal(context.cwd))
    await Promise.all([saved.stdout.finish(run.truncated.stdout || run.stdout.length > shares.stdout), saved.stderr.finish(run.truncated.stderr || run.stderr.length > shares.stderr)])
    // A missing working folder makes posix_spawn report ENOENT for bash itself.
    if (run.spawnError !== undefined) return { success: false, error: existsSync(context.cwd) ? `Failed to spawn process: ${run.spawnError}` : `Could not run the command: its working folder ${context.cwd} does not exist (it was deleted or moved).` }
    const code = run.exitCode
    const interrupted = run.interrupted

    // Before any cut: a key split by one would no longer be found in the result.
    const start = (text: string, cut: boolean) => cut ? maskSecretsInCutText(text, 'end') : maskSecrets(text)
    const end = (text: string, cut: boolean) => cut ? maskSecretsInCutText(text, 'start') : maskSecrets(text)
    const out = shownOutput(start(run.stdout, run.truncated.stdout), end(run.tail?.stdout ?? run.stdout, run.truncated.stdout), run.truncated.stdout, shares.stdout, saved.stdout, 'output')
    const err = shownOutput(start(run.stderr, run.truncated.stderr), end(run.tail?.stderr ?? run.stderr, run.truncated.stderr), run.truncated.stderr, shares.stderr, saved.stderr, 'stderr')
    let stdout = out.text
    if (leftover) stdout += `${stdout && !stdout.endsWith('\n') ? '\n' : ''}${leftRunningNote(leftover, context.isHeadless, !!run.pipes)}`

    return {
      success: code === 0 && !interrupted,
      output: {
        stdout, stderr: err.text, exitCode: code, interrupted, ...(run.timedOut ? { timedOut: true } : {}),
        ...(out.path ? { persistedOutputPath: out.path } : {}), ...(err.path ? { persistedStderrPath: err.path } : {}), ...(leftover ? { backgroundTaskId: leftover.id } : {}),
      },
      error: run.timedOut ? `${timeoutError(timeout)}${leftGroupNote(run.leftGroup)}`
        : interrupted ? `Stopped before it finished: the turn was cancelled (it did not time out)${leftGroupNote(run.leftGroup)}`
          : run.statusLost ? 'The command ended, but its exit status was not reported; its output may be incomplete'
            // Died of a signal: a crash or a kill, which the same words as an ordinary failure would hide.
            : run.signal ? `Command killed by ${run.signal}${signalExit(run.signal)}`
              : code !== 0 ? 'Command failed' : undefined,
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    const command = typeof input === 'object' && input !== null && typeof input.command === 'string' ? input.command : ''
    // Refuse before anyone is asked: an approval would be wasted on a command that never runs.
    const refused = blockedCommand(command, context.cwd)
    if (refused) return { decision: 'deny', reason: refused }
    const risk = assessCommandRisk(command, context.cwd)
    if (risk) return { decision: 'ask', reason: warning(risk) }
    return { decision: 'ask', reason: 'Shell commands require user approval' }
  },

  prompt(): string {
    return 'Bash: Execute shell commands. Returns stdout, stderr, and exit code; a long output shows its start and its end, and the note between them says which lines were left out and where all of it is saved. A command is stopped after 2 minutes unless you pass timeout (up to 600000 ms, 10 minutes); for an install, download or build that may take longer, pass a larger timeout or set run_in_background. Package installs may take longer than 2 minutes; use a larger timeout or run_in_background. Pass non-interactive flags to scaffolders, for example `npm create vite@latest app -- --template react`. When Guillotine Mode is on (local models only), commands run in a macOS sandbox: setuid tools such as ps and sudo cannot run there (use TaskOutput/TaskStop for your own background commands), and network access needs the user\'s approval. Commands have no terminal and no input: git opens no editor (pass messages with -m or -F) and nothing can prompt. Catastrophic commands (deleting / or the home folder, formatting disks, shutting down) are always refused, and so is such text anywhere in a command, even quoted or in a here-document (write such text to files with FileWrite); so is reading G-Code\'s own settings and key files in ~/.gcode; other destructive ones (rm -rf outside the project, git reset --hard, git push --force) need the user\'s approval. Cleanup inside the project, such as rm -rf dist or node_modules, is fine. Set run_in_background for commands that keep running (dev servers, watchers), not `&`: it returns a task id once the command prints a URL or says it is ready or listening, once it exits, or after 2 seconds, and says which (an early failure comes back as an error with its exit code and output); use TaskOutput to read the output and TaskStop to stop it while it runs. Processes a command leaves running with `&` become a background task too, and the command returns once it has exited. A process that starts its own session (setsid, a daemon) leaves the group of its command: a stop does not reach it, it is not tracked, and it can outlive the session; a stop that finds one says so. Background tasks end with the G-Code session: when it is closed, stopped or restarted, and in a one-shot (-p) run when the run ends.'
  },
}
