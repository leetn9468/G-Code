/**
 * @file sessionMemory.ts
 * @brief Session memory — persist key context across turns within a session
 *
 * Keeps short, one-line notes about the session: what the assistant set out to
 * do (a statement of intent in its text before tool calls, never an observation), the
 * files the session created, changed or deleted (from the engine's output
 * records, so shell edits count too), and tool errors that are still open (an
 * error is dropped once the same call succeeds). Entries are deduplicated and
 * capped per type; the engine shows new ones in each turn's context block.
 */

import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { roughTokenCount } from '../engine/context.js'
import { headUnits } from '../utils/textUnits.js'
import { relativeToProject } from '../utils/path.js'
import { generatedDataPath, generatedFolder, ignoreGeneratedFolders } from '../session/outputs.js'
import type { SessionOutput } from '../shared/sessionControls.js'
import { assertSessionOwner } from '../state/store.js'

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  turn: number
  timestamp: number
  type: 'decision' | 'file_change' | 'error' | 'context' | 'user_preference'
  content: string
  relevance: number // 0-1, decays over time
  /** What makes two entries of a type the same (a file's path, a tool call's target); the newer one replaces the older. */
  key?: string
  /** A successfully finished turn's plans linger for three turns after compaction, then go. */
  completedAtTurn?: number
}

export interface SessionMemoryState {
  sessionId: string
  entries: MemoryEntry[]
  totalTokens: number
}

// ============================================================================
// State
// ============================================================================

let memory: SessionMemoryState | null = null
let memoryCwd = ''
const MAX_MEMORY_TOKENS = 10_000
const RELEVANCE_DECAY_PER_TURN = 0.05
/** Entries kept per type; the oldest go first. */
const TYPE_LIMITS: Record<MemoryEntry['type'], number> = { decision: 12, file_change: 40, error: 8, context: 20, user_preference: 20 }
/** Statements of intent kept per turn (a long tool loop narrates every step). */
const DECISIONS_PER_TURN = 3
/** An entry's length in UTF-16 units. */
const ENTRY_LENGTH = 200
const ERROR_LENGTH = 160
const PLAN_SCAN_UNITS = 64_000
const COMPLETED_PLAN_TURNS = 3

// ============================================================================
// Lifecycle
// ============================================================================

export function initSessionMemory(sessionId: string, cwd: string): void {
  // The same session in the same folder keeps what it holds (also entries not yet saved).
  if (memory?.sessionId === sessionId && memoryCwd === cwd) return
  memoryCwd = cwd
  const currentPath = getMemoryPath(cwd, sessionId)
  const path = existsSync(currentPath) ? currentPath : join(cwd, '.gcode', 'session-memory', `${sessionId}.json`)
  if (existsSync(path)) {
    try {
      const loaded = JSON.parse(readFileSync(path, 'utf-8')) as SessionMemoryState
      memory = { sessionId, entries: [], totalTokens: 0 }
      // Entries saved by older versions may repeat or span lines: normalise them as they come in.
      for (const entry of Array.isArray(loaded.entries) ? loaded.entries : []) {
        if (entry && typeof entry.content === 'string' && entry.content.trim() && Object.hasOwn(TYPE_LIMITS, entry.type)) {
          addEntry(entry.turn ?? 0, entry.type, entry.content, entry.relevance ?? 0.7, entry.key, entry.timestamp)
          const restored = memory.entries.at(-1)
          if (restored?.type === 'decision' && restored.key === entry.key && restored.turn === entry.turn && Number.isSafeInteger(entry.completedAtTurn) && entry.completedAtTurn! >= entry.turn) restored.completedAtTurn = entry.completedAtTurn
        }
      }
      return
    } catch { /* start fresh */ }
  }

  memory = {
    sessionId,
    entries: [],
    totalTokens: 0,
  }
}

export function getSessionMemory(): SessionMemoryState | null {
  return memory
}

// ============================================================================
// Text helpers
// ============================================================================

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const words = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined

/**
 * One line of at most `limit` UTF-16 units. A longer text is cut at a word boundary (Intl word
 * segmentation, so CJK text without spaces cuts between words too) and ends with '…'; a single
 * very long token (a URL, a path) is cut where it must.
 */
export function clipLine(text: string, limit = ENTRY_LENGTH): string {
  const line = oneLine(text)
  if (line.length <= limit) return line
  const room = limit - 1
  let end = 0
  if (words) for (const { index, segment } of words.segment(line)) {
    if (index + segment.length > room) break
    end = index + segment.length
  }
  else end = Math.max(0, headUnits(line, room + 1).lastIndexOf(' '))
  const head = end >= room * 0.6 ? line.slice(0, end) : headUnits(line, room)
  return head.replace(/[\s,;:，、；：]+$/u, '') + '…'
}

/**
 * The first sentence of a text, in any language: the first line with words in it (code blocks,
 * headings and list markers left out), up to sentence-ending punctuation. '.', '!' and '?' end a
 * sentence only before a space or the line's end, so `foo.js` or 3.5 do not, and a period never
 * ends one after an abbreviation ("e.g. ", "U.S. "), or after one that can also end a sentence
 * ("etc.") when lowercase text or a number follows; '。', '！' and '？' end one anywhere.
 */
export function firstSentence(text: string): string | undefined {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '\n')
  for (const raw of prose.split('\n')) {
    // A heading is a label, not a sentence.
    if (/^\s*#{1,6}\s/.test(raw)) continue
    const line = raw.replace(/^\s*(?:>|[-*+]|\d+[.)])\s+/u, '').trim()
    if ((line.match(/\p{L}/gu)?.length ?? 0) < 3) continue
    const end = sentenceEnd(line)
    return clipLine(end >= 0 ? line.slice(0, end + 1) : line)
  }
}

/**
 * Abbreviations whose period never ends a sentence ("e.g. ", "i.e. ", "vs. ", "Dr. "…), matched on
 * the whole word before the period: one that starts after a space, an opening bracket or a quote,
 * never the extension of a file name ("main.c", "build/st"). Initials are capital letters, alone
 * ("J. ") or dotted ("U.S. "); the pronoun "I" is not one.
 */
const ABBREVIATION = /(?:^|[\s(\[{"'“‘])(?:e\.g|i\.e|vs|cf|viz|fig|figs|eq|eqs|pp|vol|dept|mr|mrs|ms|dr|prof|sr|jr|st)$/i
const INITIALS = /(?:^|[\s(\[{"'“‘])(?:(?:\p{Lu}\.)+\p{Lu}|(?!I)\p{Lu})$/u
/** Abbreviations that can also end a sentence ("etc."): they go on only before lowercase text or a number. */
const OPEN_ABBREVIATION = /(?:^|[\s(\[{"'“‘])(?:etc|al|approx|incl|esp|resp|ca|a\.m|p\.m)$/i

/** The index of the mark that ends a line's first sentence, or -1 when the whole line is one. */
function sentenceEnd(line: string): number {
  for (const match of line.matchAll(/[.!?](?=\s|$)|[。！？]/gu)) {
    const index = match.index!
    if (match[0] !== '.') return index
    if (index === line.length - 1) return index
    // "e.g. foo": an abbreviation's period goes on; "etc. and" too, but "etc. Then" ends the sentence.
    // Any other word's period ends it, also before lowercase ("Fixed it. npm test passes.").
    const before = line.slice(0, index)
    if (ABBREVIATION.test(before) || INITIALS.test(before)) continue
    if (OPEN_ABBREVIATION.test(before) && /^\s+[\p{Ll}\d]/u.test(line.slice(index + 1))) continue
    return index
  }
  return -1
}

/** A file's path as shown: relative to the project folder when inside it. */
function shownPath(path: string, cwd: string): string {
  for (const root of new Set([cwd, (() => { try { return realpathSync(cwd) } catch { return cwd } })()])) {
    const inside = relative(root, path)
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside
  }
  return path
}

/** The fields that name a file or folder, shown relative to the project. */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'plan_file', 'path'])

/** What a tool call acted on: a file (relative to the project when inside it), a URL, a query or a shell command. */
function callTarget(input: unknown, cwd: string): string {
  if (!input || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const name of ['file_path', 'notebook_path', 'plan_file', 'path', 'command', 'url', 'pattern', 'query']) {
    const value = fields[name]
    if (typeof value !== 'string' || !value) continue
    const shown = PATH_FIELDS.has(name) && cwd && isAbsolute(value) ? shownPath(value, cwd) : value
    return headUnits(oneLine(shown), 300)
  }
  return ''
}

/**
 * A command line split into its commands: at `&&`, `||`, `;`, `&` and line breaks outside quotes
 * (a redirection's `2>&1` is not one). A pipeline stays one command.
 */
function commandList(command: string): string[] {
  const parts: string[] = []
  let current = '', quote = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      current += char
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"') current += command[++index] ?? ''
    } else if (char === '"' || char === "'") { quote = char; current += char }
    else if (char === '\\') current += char + (command[++index] ?? '')
    else if ((char === '&' || char === '|') && command[index + 1] === char) { parts.push(current); current = ''; index++ }
    else if (char === ';' || char === '\n' || (char === '&' && command[index - 1] !== '>' && command[index + 1] !== '>')) { parts.push(current); current = '' }
    else current += char
  }
  parts.push(current)
  return parts.map(oneLine).filter(Boolean)
}

/** Leading variable assignments (`CI=1 npm test`) say how a command runs, not what it is. */
const withoutAssignments = (command: string) => command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
/** Shells whose `-c` argument is a command line of its own, and interpreters whose `-c` or `-e` argument is a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const INTERPRETER = /^(?:python[\d.]*|node|bun|deno|ruby|perl|php)$/

/**
 * A shell command reduced to the program and first argument of each of its commands ("npm test"),
 * after any leading `cd …&&` and variable assignments and before pipes or redirections, so that
 * `npm test 2>&1 | tail` succeeding clears an earlier `npm test` failure, while `npm install`
 * failing does not clear it, nor does `pwd` clear `pwd && npm test`. An inline script is part of
 * the key (`sh -c "npm test"` is not `sh -c "ls"`).
 */
export function commandKey(command: string): string {
  const commands = commandList(command).map(withoutAssignments)
  // Leading setup (`cd`, `source`, `export`, `set`) only says how the rest runs.
  while (commands.length > 1 && /^(?:cd|source|\.|export|set)(?:\s|$)/.test(commands[0]!)) commands.shift()
  return commands.map(commandHead).filter(Boolean).join(' ; ')
}

/** One command's program and first argument; for `sh -c`, `node -e` and the like, with the inline script (a shell's reduced in turn). */
function commandHead(command: string): string {
  const inline = /^(\S+)\s+(-[a-z]*c|-e|--eval)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+))/.exec(command)
  const program = inline ? basename(inline[1]!) : ''
  if (inline && (SHELLS.has(program) || INTERPRETER.test(program))) {
    const script = inline[3] ?? inline[4] ?? inline[5] ?? ''
    return `${inline[1]} ${inline[2]} ${SHELLS.has(program) ? commandKey(script) : headUnits(oneLine(script), 80)}`
  }
  const tokens: string[] = []
  for (const token of command.replace(/\|.*$/, '').split(' ')) {
    if (!token || /^\d*[<>]/.test(token)) break
    tokens.push(token)
    if (tokens.length === 2) break
  }
  return tokens.join(' ')
}

/** Programs that only look. */
const LOOKING = /^(?:pwd|cd|ls|cat|head|tail|wc|file|stat|find|grep|egrep|fgrep|rg|which|type|echo|printf|tree|du|df|env|printenv|uname|whoami|date|id|test|\[|true)$/
/** Tools whose `--version` only looks. */
const VERSIONED = /^(?:node|npm|npx|pnpm|yarn|bun|deno|python[\d.]*|pip[\d.]*|ruby|go|cargo|rustc|java|git|tsc)$/

/**
 * Whether every command of a command line only looks: lists, reads, searches, prints a version or
 * the git status, and writes no file. When one fails it found something absent (`cat` of a missing
 * file, `grep` with no match, an empty folder): a fact of the moment, not an error to fix.
 */
function lookingCommand(command: string): boolean {
  const commands = commandList(command)
  return commands.length > 0 && commands.every(part => part.split('|').every(piece => {
    const words = withoutAssignments(piece.trim()).split(/\s+/)
    // A redirection to a file writes it; to /dev/null or another stream it does not.
    if ([...piece.matchAll(/&?>>?\s*(\S*)/g)].some(match => !/^(?:\/dev\/null|&\d)$/.test(match[1]!) && !/^\d?>&\d$/.test(match[0]))) return false
    const program = basename(words[0] ?? '')
    if (program === 'find') return !words.some(word => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*)$/.test(word))
    if (program === 'git') return /^(?:status|log|diff|show|rev-parse|ls-files)$/.test(words[1] ?? '')
    if (VERSIONED.test(program)) return words.length === 2 && /^(?:--version|-v|-V|version)$/.test(words[1]!)
    return LOOKING.test(program)
  }))
}

// ============================================================================
// Memory Extraction
// ============================================================================

/** An English statement of intent: "I'll …", "Let me …", "Next, I'll …", "We need to …". */
const INTENT_EN = /^(?:(?:ok(?:ay)?|alright|all right|great|good|now|next|first|then|so|right|sure|perfect|done)\b[,!.]?\s+)*(?:i(?:'|’)ll|i\s+will|i(?:'|’)m\s+(?:going|about)\s+to|i\s+am\s+(?:going|about)\s+to|i(?:'|’)m\s+gonna|(?:i(?:'|’)m|i\s+am)\s+(?:now\s+)?(?:adding|fixing|rewriting|updating|changing|creating|removing|deleting|renaming|refactoring|implementing|replacing|moving|writing|switching|converting|extracting|splitting|merging)|let(?:'|’)s|let\s+me|i\s+(?:need|want|plan|have)\s+to|i(?:'|’)d\s+like\s+to|we(?:'|’)ll|we\s+will|we\s+(?:need|have)\s+to|i\s+should)\b/i
/** The same in Chinese ("我将…", "让我…", "接下来…"), and a Japanese or Korean sentence that ends as a plan ("…します。", "…하겠습니다."). */
const INTENT_CJK = /^(?:(?:好的|好|现在|然后|那么)[，,、。！!\s]*)*(?:我(?:们)?(?:将|会|先|来|要|需要|准备|打算)|让我|接下来|下面我)/u
const INTENT_END = /(?:します|しましょう|していきます|してみます|하겠습니다|할게요|해 보겠습니다)[。！.!]?$/u
/**
 * What follows a statement of intent when it is a step that only looks ("…read the tests", "…start
 * by running the suite", "让我先看看…"): done within the same turn, it is narration, not a decision.
 */
const LOOK_STEP = /^(?:(?:first|now|quickly|also|then|just|briefly|start\s+by|begin\s+by|go\s+ahead\s+and)\s+)*(?:read|reading|look|looking|check|checking|inspect|inspecting|examine|examining|explore|exploring|see|seeing|view|viewing|open|opening|run|running|re-?run|re-?running|search|searching|find|finding|list|listing|scan|scanning|review|reviewing|verify|verifying|confirm|confirming|investigate|investigating|understand|understanding|test|testing|take\s+a\s+look|have\s+a\s+look|get\s+a\s+(?:sense|feel|look|overview))\b/i
const LOOK_STEP_CJK = /^(?:先|再|来)?(?:看|查看|检查|阅读|读取|读一下|运行|跑|测试|确认|了解|搜索|浏览)/u
/** A statement whose object is a bare pronoun ("I'll leave those alone"): it needs the sentence before it. */
const PRONOUN_OBJECT = /^\S+\s+(?:it|this|that|these|those|them)\b/i

/**
 * The first statement of what the assistant is about to do anywhere in a round's bounded text,
 * or undefined. An observation ("The directory is empty.", "Both servers are running.")
 * is not a decision: it goes stale within the turn, and the turn's file changes and errors are
 * recorded on their own. A lead-in that ends in ':' ("I'll do two things:") says nothing by itself.
 */
export function intentSentence(text: string): string | undefined {
  const prose = headUnits(text, PLAN_SCAN_UNITS).replace(/```[\s\S]*?(?:```|$)/g, '\n')
  let prior = ''
  for (const raw of prose.split('\n')) {
    if (/^\s*#{1,6}\s/.test(raw)) continue
    const line = raw.replace(/^\s*(?:>|[-*+]|\d+[.)])\s+/u, '').replace(/^\*\*|\*\*$/g, '').trim()
    if ((line.match(/\p{L}/gu)?.length ?? 0) < 3) continue
    let rest = line
    while (rest) {
      const end = sentenceEnd(rest)
      const sentence = (end >= 0 ? rest.slice(0, end + 1) : rest).trim()
      rest = end >= 0 ? rest.slice(end + 1).trim() : ''
      const before = prior
      prior = sentence
      if (/[:：]$/u.test(sentence)) continue
      const lead = INTENT_EN.exec(sentence) ?? INTENT_CJK.exec(sentence)
      if (!lead && !INTENT_END.test(sentence)) continue
      const action = lead ? sentence.slice(lead[0].length).replace(/^[\s,，]+/u, '') : ''
      if (LOOK_STEP.test(action) || LOOK_STEP_CJK.test(action)) continue
      if (PRONOUN_OBJECT.test(action)) { if (before) return clipLine(`${before} ${sentence}`); continue }
      return clipLine(sentence)
    }
  }
}

/** Only the engine's successful turn boundary completes plans; interruptions/errors leave them open. */
export function completeMemoryTurn(turn: number): void {
  if (!memory) return
  for (const entry of memory.entries) if (entry.type === 'decision' && entry.turn === turn) entry.completedAtTurn = turn
}

/**
 * Extract memory-worthy content from an iteration's text: its statement of what the assistant is
 * about to do (see intentSentence). A turn keeps its latest few. Tool outcomes are recorded as each
 * call completes (noteToolOutcome, noteOutputChanges); `_toolResults` is not read.
 */
export function extractMemories(
  turn: number,
  assistantText: string,
  _toolResults?: Array<{ name: string; content: string; isError: boolean }>,
): void {
  if (!memory) return
  const sentence = intentSentence(assistantText)
  if (sentence) {
    // The latest plan wins: the turn's oldest decision makes room for a new one.
    const ofTurn = memory.entries.filter(entry => entry.type === 'decision' && entry.turn === turn)
    const key = sentence.toLowerCase()
    if (ofTurn.length >= DECISIONS_PER_TURN && !ofTurn.some(entry => entry.key === key)) {
      const oldest = ofTurn[0]
      memory.entries = memory.entries.filter(entry => entry !== oldest)
    }
    addEntry(turn, 'decision', sentence, 0.7, key)
  }
  // Compact if over budget
  if (memory.totalTokens > MAX_MEMORY_TOKENS) compactSessionMemory(turn)
}

/**
 * Notes the files a tool created, changed or deleted, from the engine's output records: one entry
 * per file ("Created: src/a.ts"), replaced when the same file changes again. A sub-agent's or
 * workflow agent's changes are noted in the memory of the session it records them into.
 */
export function noteOutputChanges(turn: number, outputs: readonly SessionOutput[], cwd: string, sessionId?: string): void {
  // `sessionId`: only into that session's memory (a child engine noting its parent's changes).
  if (!memory || (sessionId !== undefined && memory.sessionId !== sessionId)) return
  for (const output of outputs) {
    const shown = shownPath(output.path, cwd)
    // G-Code's own run files (verification and browser runs, tool output, handoffs…) are not the
    // project's changes: they stay in the session's outputs, but would crowd real changes out of the cap.
    if (isGeneratedRunFile(shown)) continue
    const label = output.deleted ? output.baseline?.absent ? 'Created and deleted' : 'Deleted' : output.baseline?.absent ? 'Created' : 'Modified'
    addEntry(turn, 'file_change', `${label}${output.shared ? " (may be another session's: its command ran at the same time)" : ''}: ${shown}`, 0.9, output.path)
  }
}

/**
 * Files the user authors in the project's .gcode folder: instructions, settings, MCP servers,
 * hooks, skills and workflow scripts. Everything else there is G-Code's own runtime data.
 */
const AUTHORED_GCODE_FILES = /^\.gcode[\\/](?:GCODE\.md|settings(?:\.local)?\.json|mcp\.json|(?:hooks|skills|workflows)[\\/].+)$/

/** A path (as shown, relative to the project) under the project's .gcode folder that G-Code wrote for itself. */
export function isGeneratedRunFile(shown: string): boolean {
  return /^\.gcode(?:[\\/]|$)/.test(shown) && !AUTHORED_GCODE_FILES.test(shown)
}

/**
 * A result that says the call never ran (approval refused, a rule denied it, the failure
 * budget refused it, invalid input): "Not run: …", or "Not run, the turn stopped: …".
 */
const NOT_RUN = /^Not run[:,]/
/** A refusal by the failure budget: a repeat of a call already noted, or its stop. Its wording holds only for the turn it was made in. */
const REPEAT = /^Not run(?:, the turn stopped:|: (?:approval was not available for this exact|the user denied this exact|this exact) )/
/** File tools that write: one of them succeeding on a file clears the errors of all of them there. */
const WRITE_TOOLS = ['FileWrite', 'FileEdit', 'NotebookEdit']

/** A refusal as a fact for later turns: up to "nothing was executed", or its first sentence; never the instructions the model was given then. */
function refusalFact(text: string): string {
  const executed = /^[\s\S]*?nothing was executed(?: or changed)?\./i.exec(text)
  if (executed) return executed[0]
  const line = text.split('\n')[0]!.trim()
  const end = sentenceEnd(line)
  return end >= 0 ? line.slice(0, end + 1) : line
}

/**
 * An error as later turns need it: its first line (what failed) and, when more follows, its last
 * line of output, usually the cause ("command not found", the failing assertion); not the text
 * between (tool notes, a listing, what the model was told to do then).
 */
function errorFact(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !/^Exit code: -?\d+$/.test(line))
  const first = lines[0] ?? ''
  const last = lines.length > 1 ? lines.at(-1)!.replace(/^STDERR:\s*/, '') : ''
  return last && last !== first ? `${clipLine(first, 80)} … ${last}` : first
}

/**
 * Notes a tool call's outcome: an error as one capped line (see errorFact), keyed by the tool and
 * what it acted on; a success clears the earlier errors of the same call (of the same tool when it
 * has no target, of any file tool that writes when it wrote the same file). A call that never ran
 * failed nothing: its refusal is kept as context, as a fact (see refusalFact), and a repeat the
 * failure budget refused leaves the first outcome in place. So is one the turn's Stop cut short
 * (`stopped`): nothing about it is left for the next turn to fix. A command that only looks and
 * fails (see lookingCommand) is not kept.
 */
export function noteToolOutcome(turn: number, tool: string, input: unknown, output: string, isError: boolean, cwd = memoryCwd, stopped = false): void {
  if (!memory) return
  // Paths are shown relative to the project, as file changes are; the key uses the same form,
  // so a later call that names the file the other way still clears the error.
  const target = callTarget(input, cwd)
  const command = tool === 'Bash' && input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : ''
  const key = `${tool}\0${tool === 'Bash' ? commandKey(command || target) : target}`
  if (!isError) {
    const before = memory.entries.length
    const cleared = new Set(WRITE_TOOLS.includes(tool) && target ? WRITE_TOOLS.map(name => `${name}\0${target}`) : [key])
    // The call's own refusal note goes too: it ran after all.
    memory.entries = memory.entries.filter(entry => entry.type === 'error' ? !cleared.has(entry.key ?? '') && entry.key !== `${tool}\0` : entry.type !== 'context' || entry.key !== key)
    if (memory.entries.length !== before) recount()
    return
  }
  const text = output.trimStart()
  const refused = stopped || NOT_RUN.test(text)
  if (REPEAT.test(text) && memory.entries.some(entry => entry.key === key && (entry.type === 'error' || entry.type === 'context'))) return
  if (!refused && command && lookingCommand(command)) return
  const subject = target ? `${tool} (${clipLine(target, 80)})` : tool
  addEntry(turn, refused ? 'context' : 'error', `${subject}: ${clipLine(relativeToProject(refused ? refusalFact(text) : errorFact(text), cwd), ERROR_LENGTH) || 'failed'}`, refused ? 0.6 : 0.8, key)
}

/**
 * Manually add a memory entry. Content is kept to one line of at most 200 units; an entry with
 * the same type and key (by default, the same content) replaces the older one.
 */
export function addEntry(
  turn: number,
  type: MemoryEntry['type'],
  content: string,
  relevance = 0.7,
  key?: string,
  timestamp = Date.now(),
): void {
  if (!memory) return
  const line = clipLine(content)
  if (!line) return
  const identity = key ?? line
  memory.entries = memory.entries.filter(entry => entry.type !== type || (entry.key ?? entry.content) !== identity)
  memory.entries.push({ turn, timestamp, type, content: line, relevance, ...(key !== undefined ? { key } : {}) })
  const ofType = memory.entries.filter(entry => entry.type === type)
  if (ofType.length > TYPE_LIMITS[type]) {
    const dropped = new Set(ofType.slice(0, ofType.length - TYPE_LIMITS[type]))
    memory.entries = memory.entries.filter(entry => !dropped.has(entry))
  }
  recount()
}

function recount(): void {
  if (memory) memory.totalTokens = memory.entries.reduce((sum, entry) => sum + roughTokenCount(entry.content), 0)
}

// ============================================================================
// Memory Relevance
// ============================================================================

/**
 * Score and sort memories by relevance.
 * Relevance decays over turns; recent and high-relevance entries score higher.
 */
export function getRelevantMemories(
  currentTurn: number,
  limit = 20,
  liveTurns: ReadonlySet<number> = new Set(),
): MemoryEntry[] {
  if (!memory) return []

  memory.entries = memory.entries.filter(entry => entry.type !== 'decision' || entry.completedAtTurn === undefined || currentTurn - entry.completedAtTurn <= COMPLETED_PLAN_TURNS)
  recount()

  // Apply time decay
  const scored = memory.entries.filter(entry => entry.type !== 'decision' || !liveTurns.has(entry.turn)).map((entry) => {
    const age = currentTurn - entry.turn
    const decayedRelevance = entry.relevance * Math.pow(1 - RELEVANCE_DECAY_PER_TURN, age)
    return { ...entry, relevance: Math.max(0.01, decayedRelevance) }
  })

  // Sort by relevance descending
  scored.sort((a, b) => b.relevance - a.relevance)

  // Open errors always show, and file changes fill at most half the lines while other entries are
  // left: a scaffold creates dozens of files, which must not push out the errors and the plan.
  const picked = new Set(scored.filter(entry => entry.type === 'error').slice(0, limit))
  let files = 0
  for (const entry of scored) {
    if (picked.size >= limit) break
    if (picked.has(entry) || (entry.type === 'file_change' && files++ >= limit / 2)) continue
    picked.add(entry)
  }
  for (const entry of scored) if (picked.size < limit) picked.add(entry)
  return scored.filter(entry => picked.has(entry))
}

const ICONS: Record<MemoryEntry['type'], string> = { decision: '[D]', file_change: '[F]', error: '[E]', user_preference: '[P]', context: '[C]' }

/**
 * The relevant memories as one line each ("- [D] …"), most relevant first. An entry's
 * whitespace (an error excerpt can span lines) is collapsed so each stays one line.
 */
export function sessionMemoryLines(currentTurn: number, liveTurns: ReadonlySet<number> = new Set(), legacyAssistantText: readonly string[] = []): string[] {
  const represented = new Set(liveTurns)
  // Older saves have no turn metadata. Exact visible plan text is sufficient evidence that
  // repeating that same note adds nothing; never infer a source turn from message positions.
  for (const entry of memory?.entries ?? []) if (entry.type === 'decision' && legacyAssistantText.some(text => text.includes(entry.content.replace(/…$/, '')))) represented.add(entry.turn)
  return getRelevantMemories(currentTurn, 20, represented).map(entry => `- ${ICONS[entry.type] ?? '[C]'} ${oneLine(entry.content)}`)
}

/**
 * Format relevant memories as a prompt section.
 */
export function formatSessionMemoryForPrompt(currentTurn: number): string {
  const lines = sessionMemoryLines(currentTurn)
  return lines.length ? ['## Session Memory\n', ...lines].join('\n') : ''
}

// ============================================================================
// Memory Compaction
// ============================================================================

/** Entries whose relevance, decayed to the current turn, falls below this are dropped. */
const PRUNE_BELOW = 0.1

/**
 * Drops the entries whose relevance has decayed below PRUNE_BELOW by `currentTurn` (about 38 turns
 * for a file change, 40 for an error), then the least relevant while the memory is over its token
 * budget. Runs at the end of every turn and whenever an entry takes the memory over budget.
 * Returns how many entries went.
 */
export function compactSessionMemory(currentTurn: number): number {
  if (!memory) return 0
  const before = memory.entries.length
  const decayed = (entry: MemoryEntry) => entry.relevance * Math.pow(1 - RELEVANCE_DECAY_PER_TURN, Math.max(0, currentTurn - entry.turn))
  memory.entries = memory.entries.filter(entry => decayed(entry) >= PRUNE_BELOW)
  recount()
  if (memory.totalTokens > MAX_MEMORY_TOKENS) {
    const ranked = [...memory.entries].sort((a, b) => decayed(a) - decayed(b))
    const dropped = new Set<MemoryEntry>()
    let tokens = memory.totalTokens
    for (const entry of ranked) {
      if (tokens <= MAX_MEMORY_TOKENS) break
      dropped.add(entry); tokens -= roughTokenCount(entry.content)
    }
    memory.entries = memory.entries.filter(entry => !dropped.has(entry))
    recount()
  }
  return before - memory.entries.length
}

// ============================================================================
// Persistence
// ============================================================================

function getMemoryPath(cwd: string, sessionId: string): string {
  return join(generatedDataPath(cwd, 'session-memory'), `${sessionId}.json`)
}

/**
 * Saves the memory now when it is this session's (see persistSessionMemory): after each tool
 * call and when a turn stops, so a stopped or killed turn keeps the files it changed and the
 * errors it hit. The memory of another session (one this process held before) is never written.
 */
export function saveSessionMemory(sessionId: string): void {
  if (memory?.sessionId === sessionId && memoryCwd) persistSessionMemory(memoryCwd)
}

/** Saves memory in the personal project store. Legacy files are only read; empty memory writes nothing. */
export function persistSessionMemory(cwd: string): void {
  // The end of a turn: the folders this turn's tools generated (tool output, handoffs…) get their ignore file too.
  ignoreGeneratedFolders(cwd)
  if (!memory) return
  // Another process owns the session, or took it over from this one: this copy is not to be
  // written over that process's memory (the session's own save reports it).
  try { assertSessionOwner(cwd, memory.sessionId) } catch { return }
  const path = getMemoryPath(cwd, memory.sessionId)
  if (!memory.entries.length && !existsSync(path)) return
  generatedFolder(cwd, 'session-memory')
  // Whole or not at all: it is saved after every tool call, and a process can be killed mid-write.
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(memory, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
    throw error
  }
}
