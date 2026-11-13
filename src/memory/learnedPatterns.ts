/**
 * @file learnedPatterns.ts
 * @brief What G-Code learns across sessions in one project: the verification commands (tests,
 *        builds, type checks, linters) that ran here, and how often each worked. Kept in the
 *        personal project store (~/.gcode/projects/<project>/learned/patterns.json; never in the
 *        project, never committed). A new conversation's system prompt lists the ones to trust.
 *
 * Only a plain call is learned: checks, with at most a `cd` inside the project, `source`, or a
 * well-known variable before them. Anything else first (`git reset --hard && npm test`, `nvm use 18
 * && npm test`) could have caused the result, or be needed for it, so that call says nothing about
 * the check; it is not counted at all. A call that is missed costs nothing; one that is misread
 * would be offered as trusted in every new conversation. Recognising what a check's own options do
 * is best effort, which is one reason a single run is never enough to be trusted (SHOW_FROM).
 *
 * Confidence is the share of runs that worked, smoothed (a command seen once is not certain) and
 * halved for every 90 days nobody ran it. A run whose tests failed still shows the command works;
 * only a command that could not run at all (not found, a missing script) counts against it. A run
 * counts as worked only when its exit status is the check's own (not hidden by `| tail` or `; echo`).
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { generatedDataPath, generatedFolder } from '../session/outputs.js'

export interface LearnedPattern {
  /** The checks and what they run in (see verificationOf), in a normal form: what makes two runs the same pattern. */
  key: string
  kind: 'verification'
  /** Runs that exited 0. */
  successes: number
  /** Runs that could not start the command (not found, missing script, unknown option). */
  broken: number
  /** All runs, those whose checks failed included. */
  runs: number
  /** The sessions that ran it, newest last (at most SESSIONS_KEPT). */
  sessions: string[]
  firstSeen: number
  lastSeen: number
}

interface PatternFile { version: 1; patterns: LearnedPattern[] }

const FILE = 'patterns.json'
const PATTERNS_KEPT = 50
const SESSIONS_KEPT = 20
const SHOWN = 8
const HALF_LIFE_DAYS = 90
const COMMAND_LENGTH = 160
/** Shown in a new conversation from this confidence on (two runs that worked, none that could not run: one-offs stay out); forgotten below FORGET. */
const SHOW_FROM = 0.7
const FORGET = 0.15

/** A package manager running a script or tool (`npm test`, `bun run build`, `npx tsc`). */
const PACKAGE_MANAGER = '(?:npx|bunx|pnpm(?:\\s+exec)?|yarn|npm|bun)\\s+'
const RUNNER = `${PACKAGE_MANAGER}(?:run\\s+)?`
/** A script with a word in its name that means something other than checking: `build-and-deploy`, `lint:fix`, `test:watch`. */
const NOT_A_SCRIPT = '(?!(?:\\w+[:-])*(?:deploy|publish|watch|fix|update|serve|start|clean|init)(?:[:-]|\\s|$))'
/**
 * A command segment that runs a project's checks. A script name (`test`, `build`, `lint`…) counts
 * only after a package manager: bare `test` is the shell's condition builtin (`test -f x`). `ci` needs
 * `run` as well: `npm ci` is an install.
 */
const VERIFY = new RegExp('^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\$\\([^)]*\\)|\\S*)\\s+)*(?:'
  + `${RUNNER}${NOT_A_SCRIPT}(?:test|tests|build|lint|typecheck|type-check|check|verify)(?:[:-][\\w:-]*)?`
  + `|${PACKAGE_MANAGER}run\\s+${NOT_A_SCRIPT}ci(?:[:-][\\w:-]*)?`
  + `|(?:${RUNNER})?(?:tsc|vitest|jest|mocha|eslint|biome|prettier\\s+--check)`
  + '|node\\s+--test|pytest|python3?\\s+-m\\s+(?:pytest|unittest|mypy)|ruff\\s+check|mypy|cargo\\s+(?:test|build|check|clippy)|go\\s+(?:test|build|vet)'
  + '|make(?:\\s+-[jCfl]\\s+\\S+|\\s+-(?![jCfl](?:\\s|$))\\S+)*(?:\\s+(?:test|check|build|lint|all|ci|verify)(?=\\s|$)|\\s*$)'
  + '|(?:\\.\\/)?gradlew?\\s+(?:test|build|check)|mvn\\s+(?:test|verify|package)|swift\\s+(?:test|build)|xcodebuild\\s(?:.*\\s)?(?:test|build|analyze)|dotnet\\s+(?:test|build)|deno\\s+(?:test|check|lint)'
  + ')(?:\\s|$)')
/** Options that make a check command do something else: print, set up, rewrite what it checks, skip the checks, pretend or run forever. */
const NOT_A_RUN = new RegExp('\\s(?:--version|-version|-V|--help|-h|--init|--watch(?:All)?(?!=false)|--fix|--write|--apply(?:-unsafe)?|-u|--update(?:Snapshot|-snapshots?)?|--if-present|--showConfig|-list|-showBuildSettings'
  + '|--collect-only|--co|--listTests|--dry-run|--no-run|-DskipTests|-Dmaven\\.test\\.skip(?:=true)?|-x\\s+test)(?:[\\s=]|$)'
  + '|\\b(?:tsc|eslint|jest|vitest|mocha|biome|make)\\s+-v(?:\\s|$)|\\bmake\\s+-n(?:\\s|$)')
/** Variables that say how a check runs, and hold no credential. Any other is not plain. */
const PLAIN_VARIABLE = '(?:CI|NODE_ENV|TZ|LANG|LC_\\w+|FORCE_COLOR|NO_COLOR|DEBUG|PORT|HOST|BASE_URL|HOME|TMPDIR|TERM|PATH|PYTHONPATH|PYTHONDONTWRITEBYTECODE|NODE_OPTIONS|RUST_BACKTRACE|RUSTFLAGS|GOFLAGS|CGO_ENABLED)'
/** A part that sets up where or how the checks run, and so belongs in their key. */
const SETUP = new RegExp(`^(?:(?:cd|pushd|source|\\.)\\s|(?:export\\s+)?${PLAIN_VARIABLE}=(?:"[^"]*"|'[^']*'|\\S*)$)`)
/** A check part's environment, when it is only well-known variables. */
const PLAIN_ENVIRONMENT = new RegExp(`^(?:${PLAIN_VARIABLE}=(?:"[^"]*"|'[^']*'|\\$\\([^)]*\\)|\\S*)\\s+)*$`)
/** The start of a check part that is only its environment. */
const ENVIRONMENT = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|\S*)\s+)+/
/** How a shell starts its own error line: `bash: `, `bash: line 1: `, `zsh:1: `, `/bin/sh: 1: `. */
const SHELL_SAYS = '(?:(?:ba|z|da|k)?sh|/bin/\\w*sh)(?::\\s*(?:line\\s+)?\\d+)?:\\s+'
/** A package manager's own line for a script or project it could not find. */
const MANAGER_SAYS = new RegExp('^(?:(?:npm (?:error|ERR!)| ?ERR_PNPM_\\w+|(?:Usage )?error:?)\\s+)*'
  + '(?:Missing script|Script not found|Command "[^"]*" not found|Couldn\'t find a script|could not determine executable|(?:enoent )?Could not read package\\.json|No package\\.json|(?:enoent )?ENOENT[^\\n]*package\\.json)', 'im')
const MANAGER = /^(?:npx|bunx|pnpm|yarn|npm|bun)$/
/** How much of the end of the output can say a check never ran. */
const OUTPUT_TAIL = 20
/** Bash's own first line for a command it stopped: says nothing about the command. */
const STOPPED = /^(?:Error: )?(?:Stopped before it finished|Command timed out)/
/** Never kept: something that looks like a credential. */
const SECRET = new RegExp([
  '[A-Za-z_0-9]*(?:key|token|secret|passw(?:or)?d|pass|pwd|auth|cred|dsn)[A-Za-z_0-9]*=', // DB_PASS=…, --token=…
  '--(?!passWithNoTests)[\\w-]*(?:key|token|secret|passw|pass|pwd|pat|jwt|auth|cred)[\\w-]*\\s', // --api_key …, --accessToken …
  '://[^/\\s@]+@', // user:password@host
  'bearer\\s', '\\beyJ[A-Za-z0-9_-]{10,}', '\\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}', '\\bgh[pousr]_', '\\bgithub_pat_', '\\bglpat-', '\\bxox[abprs]-', '\\bAKIA[0-9A-Z]{16}', '[A-Za-z0-9]{32,}',
].join('|'), 'i')

/** What this process learned and has not saved yet, per project. */
const pending = new Map<string, Map<string, { successes: number; broken: number; runs: number; sessions: string[]; first: number; at: number }>>()

/** Where an output redirection sends the output: a descriptor (`&1`, `&-`) or a file, its name quoted or escaped as the shell allows. */
const REDIRECT_TARGET = String.raw`(?:&(?:\d+|-)|&?(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^()]*\)|` + '`[^`]*`' + String.raw`|\\.|[^\s"'\\;&|<>()` + '`' + String.raw`])+)`
/** Quoted text, kept as it is, or an output redirection after a space: `2>&1`, `>/dev/null`, `> test.log`, `2>> errors.txt`, `&> all.log`, `>| out`. */
const OUTPUT_REDIRECTION = new RegExp(String.raw`("(?:[^"\\]|\\.)*"|'[^']*')|\s+(?:&>>?|\d*>>?\|?)\s*${REDIRECT_TARGET}`, 'g')
/** A part without its output redirections: they say where its output goes, not what it checks, so `npm test > a.log` is the pattern `npm test`. Input (`<`) is kept. */
const unredirected = (part: string) => part.replace(OUTPUT_REDIRECTION, (match, quoted?: string) => quoted ?? '').trim()

type VerificationStatus = 'exit' | 'success-only' | 'unknown'

/**
 * The verification a shell command runs, if it is a plain one: `cd`, `source`, `export` or assignments,
 * then checks joined by `&&`, then anything (`| tail`, `; echo $?`, `&& git push`).
 *
 * `key` is that setup and those checks, without a `cd` to `cwd` itself, which adds nothing.
 *
 * `status` is what the command's exit status says about them. A shell reports the status of its last
 * command only, so it is theirs when nothing follows (`exit`); after `&& …` a zero status still means
 * they passed (`success-only`); otherwise it belongs to something else (`unknown`).
 */
export function verificationOf(command: string, cwd?: string): { key: string; status: VerificationStatus } | undefined {
  const found = verification(command, cwd)
  return found && { key: found.key, status: found.status }
}

/** Where a `cd` or `pushd` part goes, as the shell reads its argument: without quotes, escapes or a trailing slash (`/` itself stays). */
function placeOf(text: string): string {
  const argument = text.replace(/^\S+\s+/, '').trim()
  const quoted = /^(["'])(.*)\1$/.exec(argument)
  return (quoted ? quoted[2]! : argument.replace(/\\(.)/g, '$1')).replace(/(.)\/+$/, '$1')
}

/** Whether a `cd` to `place` stays where the command runs: `.`, `./.`, or the path of `here` itself, however written (`/p/proj/.`). */
function staysHere(place: string, here: string | undefined): boolean {
  if (!place) return false
  if (posix.normalize(place) === '.') return true
  return here !== undefined && place.startsWith('/') && posix.normalize(place).replace(/(.)\/+$/, '$1') === here
}

function verification(command: string, cwd?: string): { key: string; status: VerificationStatus; executables: string[]; managerLast: boolean } | undefined {
  const { line, parts, operators } = shellParts(command)
  const texts = parts.map(([start, end]) => unredirected(line.slice(start, end)))
  const isCheck = (text: string | undefined) => !!text && VERIFY.test(text) && !NOT_A_RUN.test(text)
  const first = texts.findIndex(isCheck)
  if (first < 0) return
  const setup = texts.slice(0, first)
  if (!setup.every(text => SETUP.test(text)) || !operators.slice(0, first).every(operator => operator === '&&' || operator === ';')) return
  const here = cwd?.replace(/\/+$/, '')
  const places = setup.filter(text => /^(?:cd|pushd)\s/.test(text)).map(placeOf)
  // A check somewhere else says nothing about this project; where a variable or `~` leads is not known.
  const inside = (place: string) => { const path = posix.normalize(place).replace(/(.)\/+$/, '$1'); return path === here || path.startsWith(`${here}/`) }
  if (places.some(place => /^[~$-]/.test(place) || place.split('/').includes('..') || (place.startsWith('/') && here !== undefined && !inside(place)))) return
  let last = first
  while (operators[last] === '&&' && isCheck(texts[last + 1])) last++
  const checks = texts.slice(first, last + 1)
  if (!checks.every(text => PLAIN_ENVIRONMENT.test(ENVIRONMENT.exec(text)?.[0] ?? ''))) return
  const after = operators.slice(last)
  const executableOf = (text: string) => text.replace(ENVIRONMENT, '').split(/\s+/)[0]!
  return {
    key: [...setup.filter(text => !/^cd\s/.test(text) || !staysHere(placeOf(text), here)), ...new Set(checks)].join(' && '),
    status: after.some(operator => operator !== '&&') ? 'unknown' : after.length ? 'success-only' : 'exit',
    executables: checks.map(executableOf),
    managerLast: !texts.slice(last + 1).some(text => MANAGER.test(executableOf(text))),
  }
}

/** Whether what a check printed says it could not run: its own exit status, or a line the shell or package manager wrote about it. */
function couldNotRun(output: string, status: VerificationStatus, executables: string[], managerLast: boolean): boolean {
  const end = output.split('\n').slice(-OUTPUT_TAIL).map(text => text.replace(/^STDERR: /, '')).join('\n')
  if (status === 'exit' && /^Exit code: 12[67]$/m.test(end)) return true
  return executables.some(executable => {
    const name = executable.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return new RegExp(`^${SHELL_SAYS}(?:${name}: (?:command )?not found|${name}: no such file or directory|(?:command not found|no such file or directory): ${name}$)`, 'im').test(end)
      // No other package manager ran after it: the line is about this check.
      || (managerLast && MANAGER.test(executable) && MANAGER_SAYS.test(end))
  })
}

const HEREDOC = /(?<!<)<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/

/**
 * A command line split at its list and pipe operators (`&&`, `||`, `;`, `|`, `|&`, `&`, and a
 * newline, which is `;`) outside quotes, backslash escapes, backticks and `$( … )` / `( … )` groups,
 * with whitespace collapsed outside quotes; comments, line continuations and here-document bodies
 * are left out. `parts` are [start, end) ranges of `line`; `operators[i]` follows `parts[i]`.
 */
export function shellParts(command: string): { line: string; parts: Array<[number, number]>; operators: string[] } {
  let line = '', quote: string | undefined, depth = 0, start = 0, physical = 0
  const parts: Array<[number, number]> = [], operators: string[] = []
  const source = command.trim()
  const endPart = (operator: string) => {
    parts.push([start, line.trimEnd().length]); operators.push(operator)
    line = `${line.trimEnd()} ${operator} `; start = line.length
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\' && quote !== "'") {
      if (source[i + 1] === '\n') { i++; if (!quote && line && !line.endsWith(' ')) line += ' '; continue }
      line += c + (source[i + 1] ?? ''); i++; continue
    }
    if (quote) { line += c; if (c === quote) quote = undefined; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; line += c; continue }
    if (c === '\n') {
      // Its body starts on the next line, wherever on this line the `<<` is.
      const here = HEREDOC.exec(line.slice(physical))
      if (here) {
        const tag = (here[1] ?? here[2] ?? here[3]!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const end = new RegExp(`\\n[\\t ]*${tag}[\\t ]*(?=\\n|$)`).exec(source.slice(i))
        i = end ? i + end.index + end[0].length - 1 : source.length
      }
      if (depth) { if (!line.endsWith(' ') && line) line += ' ' }
      else if (line.trimEnd().length > start) endPart(';')
      physical = line.length
      continue
    }
    if (/\s/.test(c)) { if (!line.endsWith(' ') && line) line += ' '; continue }
    if (c === '#' && (!line || line.endsWith(' '))) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end - 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && depth) depth--
    const operator = depth ? undefined
      : source.startsWith('&&', i) || source.startsWith('||', i) ? source.slice(i, i + 2)
      : source.startsWith('|&', i) ? '|&'
      // In `>|` (write even with noclobber set) the `|` belongs to the redirection, not a pipe.
      : c === ';' || (c === '|' && source[i - 1] !== '>') ? c
      // `&` alone sends the part to the background; in `2>&1` and `&>` it belongs to a redirection.
      : c === '&' && source[i - 1] !== '>' && source[i + 1] !== '>' ? '&' : undefined
    if (!operator) { line += c; continue }
    endPart(operator === '|&' ? '|' : operator)
    i += operator.length - 1
  }
  // Nothing after a final `;` or newline: the last part's status is still the command's.
  if (line.trimEnd().length <= start && operators[operators.length - 1] === ';') operators.pop()
  else parts.push([start, line.trimEnd().length])
  return { line: line.trimEnd(), parts, operators }
}

/** A key is one line of the system prompt's list, in backticks, and holds no credential: when saved and when read back. */
const usableKey = (key: string) => !!key && key.length <= COMMAND_LENGTH && !/[\n`]/.test(key) && !SECRET.test(key)

/**
 * Notes one finished tool call; only Bash verification commands are learned. A run counts as worked
 * only when the exit status is the checks' own; a check that could not run (not found, a missing
 * script or package.json) counts against it whatever followed it; any other run only adds to `runs`.
 */
export function notePatternOutcome(cwd: string, sessionId: string, tool: string, input: unknown, output: string, isError: boolean, now = Date.now()): void {
  if (tool !== 'Bash' || !input || typeof input !== 'object') return
  const { command, run_in_background: background } = input as { command?: unknown; run_in_background?: unknown }
  if (typeof command !== 'string' || background === true) return
  const found = verification(command, cwd)
  if (!found || !usableKey(found.key)) return
  if (isError && STOPPED.test(output)) return
  const project = pending.get(cwd) ?? new Map()
  pending.set(cwd, project)
  const entry = project.get(found.key) ?? { successes: 0, broken: 0, runs: 0, sessions: [], first: now, at: now }
  entry.runs++; entry.at = now
  entry.sessions = [...entry.sessions.filter((id: string) => id !== sessionId), sessionId]
  if (!isError && found.status !== 'unknown') entry.successes++
  else if (couldNotRun(output, found.status, found.executables, found.managerLast)) entry.broken++
  project.set(found.key, entry)
}

export function patternConfidence(pattern: LearnedPattern, now = Date.now()): number {
  const share = (pattern.successes + 1) / (pattern.successes + pattern.broken + 2)
  const idleDays = Math.max(0, (now - pattern.lastSeen) / 86_400_000)
  return share * Math.pow(0.5, idleDays / HALF_LIFE_DAYS)
}

function patternPath(cwd: string): string { return join(generatedDataPath(cwd, 'learned'), FILE) }

/** The saved patterns that meet the rules; a damaged or foreign file reads as none. Undefined when a file that is there cannot be read now, which says nothing about what it holds. */
function loadPatterns(path: string): LearnedPattern[] | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined }
  try {
    const file = JSON.parse(text) as Partial<PatternFile>
    return Array.isArray(file.patterns) ? inNormalForm(file.patterns.filter((p): p is LearnedPattern => !!p && typeof p.key === 'string' && usableKey(p.key) && p.kind === 'verification'
      && [p.successes, p.broken, p.runs, p.firstSeen, p.lastSeen].every(n => Number.isFinite(n)) && Array.isArray(p.sessions))) : []
  } catch { return [] }
}

/**
 * Saved patterns under the key this version gives them. In earlier versions a redirection to a file stayed in the key
 * (`npm test > /tmp/a.log`), so one check could be saved under many keys: those now merge into one. A key this
 * version would not learn at all is left out, as it would be if it were recorded now.
 */
function inNormalForm(patterns: LearnedPattern[]): LearnedPattern[] {
  const merged = new Map<string, LearnedPattern>()
  for (const pattern of patterns) {
    const key = verification(pattern.key)?.key
    if (!key || !usableKey(key)) continue
    const same = merged.get(key)
    if (!same) { merged.set(key, { ...pattern, key }); continue }
    // Sessions stay newest last: the pattern seen later gives the end of the list.
    const [older, newer] = pattern.lastSeen >= same.lastSeen ? [same.sessions, pattern.sessions] : [pattern.sessions, same.sessions]
    same.sessions = [...older.filter(id => !newer.includes(id)), ...newer].slice(-SESSIONS_KEPT)
    same.successes += pattern.successes; same.broken += pattern.broken; same.runs += pattern.runs
    same.firstSeen = Math.min(same.firstSeen, pattern.firstSeen); same.lastSeen = Math.max(same.lastSeen, pattern.lastSeen)
  }
  return [...merged.values()]
}

/** The project's learned patterns as saved (an unreadable or foreign file reads as none). */
export function readLearnedPatterns(cwd: string): LearnedPattern[] {
  return loadPatterns(patternPath(cwd)) ?? []
}

/**
 * Adds what this process learned in `cwd` to the saved patterns (read again first: another
 * session may have saved since), forgets what fell below FORGET and keeps the best PATTERNS_KEPT.
 */
export function saveLearnedPatterns(cwd: string, now = Date.now()): void {
  const project = pending.get(cwd)
  if (!project?.size) return
  // A file that cannot be read for now would be replaced by this run's counts alone: they wait in memory instead.
  const saved = loadPatterns(patternPath(cwd))
  if (!saved) return
  pending.delete(cwd)
  const patterns = new Map(saved.map(pattern => [pattern.key, pattern]))
  for (const [key, run] of project) {
    const pattern = patterns.get(key) ?? { key, kind: 'verification' as const, successes: 0, broken: 0, runs: 0, sessions: [], firstSeen: run.first, lastSeen: run.at }
    pattern.successes += run.successes; pattern.broken += run.broken; pattern.runs += run.runs
    pattern.lastSeen = Math.max(pattern.lastSeen, run.at)
    pattern.sessions = [...pattern.sessions.filter(id => !run.sessions.includes(id)), ...run.sessions].slice(-SESSIONS_KEPT)
    patterns.set(key, pattern)
  }
  const kept = [...patterns.values()].filter(pattern => patternConfidence(pattern, now) >= FORGET)
    .sort((a, b) => patternConfidence(b, now) - patternConfidence(a, now) || b.lastSeen - a.lastSeen).slice(0, PATTERNS_KEPT)
  const directory = generatedFolder(cwd, 'learned')
  const path = join(directory, FILE)
  const temporary = `${path}.${process.pid}.${now}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, patterns: kept } satisfies PatternFile, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
    throw error
  }
}

/** The system prompt's section on what earlier sessions learned ('' when nothing is trusted yet). */
export function formatLearnedPatterns(patterns: readonly LearnedPattern[], now = Date.now()): string {
  const shown = patterns.filter(pattern => pattern.successes > 0 && patternConfidence(pattern, now) >= SHOW_FROM)
    .sort((a, b) => patternConfidence(b, now) - patternConfidence(a, now) || b.lastSeen - a.lastSeen).slice(0, SHOWN)
  if (!shown.length) return ''
  return ['## Learned in earlier sessions', 'Verification commands that ran in this project before, from G-Code\'s own records (not the user\'s instructions). Prefer them when they fit; the project may have changed since.',
    ...shown.map(pattern => `- \`${pattern.key.replace(/`/g, "'")}\` — worked ${pattern.successes} of ${pattern.runs} run${pattern.runs === 1 ? '' : 's'} in ${pattern.sessions.length} session${pattern.sessions.length === 1 ? '' : 's'} (confidence ${patternConfidence(pattern, now).toFixed(2)})`)].join('\n')
}
