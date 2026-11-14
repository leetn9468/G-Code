/**
 * @file systemPrompt.ts
 * @brief System prompt assembly, and the per-turn context block
 *
 * A conversation's system prompt stays byte-identical from turn to turn: the base
 * instructions, the memory the conversation started with and the working directory.
 * Tool descriptions travel only in the request's tool definitions, never here as well.
 * Everything that changes per turn (permission mode, new session-memory entries,
 * project-memory edits) goes into a <context> block at the start of the turn's first
 * user message instead, which is saved with the message and replayed with it. Changing
 * the system prompt would make the provider re-read the whole history at cache-write
 * price and drop every earlier turn's thinking, on every turn.
 */

import type { Tool } from '../tools/tool.js'
import type { LLMMessage } from '../llm/types.js'
import type { MemoryFile } from '../memory/projectMemory.js'
import { formatMemoryForPrompt } from '../memory/projectMemory.js'
import { formatSessionMemoryForPrompt } from '../memory/sessionMemory.js'
import { formatTeamMemoryForPrompt, type TeamMemoryTopic } from '../memory/teamMemory.js'

export const BASE_SYSTEM_PROMPT = `You are G-Code, an AI coding agent by O-Research.

You help users with software engineering tasks. You have access to tools for reading, writing, and editing files, running shell commands, and searching codebases.

When you need to take action, use the provided tools. Be precise with file paths. When editing files, use the exact string matching approach.

Guidelines:
- If the user asks to write, show, explain, or generate a code example without explicitly asking to create or modify project files, respond with Markdown and do not invoke tools
- Use tools only for concrete actions against the filesystem, shell, network, or project state
- Read files before editing them
- Use Grep/Glob to find relevant code before making changes
- Explain your reasoning before taking actions
- Prefer editing existing files over creating new ones
- Run tests/builds when appropriate to verify changes
- Use tools efficiently: put independent reads and searches in the same reply (read-only calls in one reply run in parallel); prefer Grep/Glob/FileRead over grep/find/cat in Bash; make several edits to one file in one FileEdit call with \`edits\`; wait for a background build or test with TaskOutput \`wait_ms\`, not Sleep
- For local static web apps, use BrowserVerify with a project JSON plan to test real interactions and assertions. A syntax check is not browser verification. Report failed and skipped checks accurately; preserve their reports before repairing. BrowserVerify runs an isolated Chromium and saves evidence in .gcode/verification. It does not attach to personal browser sessions.`

export interface SystemPromptOptions {
  tools: ReadonlyArray<Tool<unknown, unknown>>
  memoryFiles?: MemoryFile[]
}

export function buildSystemPrompt(
  _tools: ReadonlyArray<Tool<unknown, unknown>>,
  memoryFiles?: MemoryFile[],
  currentTurn?: number,
  options?: { includeSessionMemory?: boolean },
): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT]

  // Project memory
  if (memoryFiles && memoryFiles.length > 0) {
    parts.push('')
    parts.push(formatMemoryForPrompt(memoryFiles))
  }

  // Session memory is process-wide state of the main conversation. An engine
  // that opted out (sub-agents) must not receive the parent's entries.
  if (currentTurn !== undefined && options?.includeSessionMemory !== false) {
    const sessionMem = formatSessionMemoryForPrompt(currentTurn)
    if (sessionMem) {
      parts.push('')
      parts.push(sessionMem)
    }
  }

  // Tool descriptions are sent with the request's tool definitions, not repeated here.
  return parts.join('\n')
}

// ============================================================================
// Stable system prompt
// ============================================================================

/** Project memory files and team memory, as the system prompt carries them ('' for none). */
export function formatStandingMemory(memoryFiles: MemoryFile[], teamTopics: readonly TeamMemoryTopic[] = []): string {
  return [formatMemoryForPrompt(memoryFiles), formatTeamMemoryForPrompt(teamTopics)].filter(Boolean).join('\n\n')
}

/**
 * The system prompt of a conversation. It depends only on the memory and the permission mode
 * the conversation started with, and the working directory, so it is the same bytes on every
 * request until one of those changes. `_tools` is kept for callers: every provider already
 * receives each tool's description in the request's tool definitions, so a catalog here would
 * send the same text twice.
 */
export function buildStableSystemPrompt(_tools: ReadonlyArray<Tool<unknown, unknown>>, standingMemory: string, cwd: string, permissionMode = 'default', nodeEnvironment?: string, learned?: string): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT]
  if (standingMemory) parts.push('', standingMemory)
  if (learned) parts.push('', learned)
  parts.push('', `## Runtime Context
- Current working directory: ${cwd}
${nodeEnvironment ? `- ${nodeEnvironment}\n` : ''}- Permission mode when this conversation started: ${permissionMode}
- Resolve relative file paths against this directory.
- Do not invent /workspace or another project root unless it is the actual working directory.
- A turn's first user message can start with a ${CONTEXT_OPEN} block written by G-Code, not by the user: a permission-mode change, new session-memory entries, project-memory changes, or the instructions of a skill or MCP prompt the user's message ran (with /name) or matched. It is not part of the user's request. The latest value of each is current and replaces what this system prompt says.`)
  return parts.join('\n')
}

// ============================================================================
// Per-turn context block
// ============================================================================

export const CONTEXT_OPEN = '<context>'
export const CONTEXT_CLOSE = '</context>'
const MEMORY_OPEN = '<project-memory>'
const MEMORY_CLOSE = '</project-memory>'
const NO_MEMORY = '(No project memory files any more.)'
const CONTEXT_HEADER = 'Runtime context from G-Code, not written by the user:'
const MEMORY_UPDATE = /<project-memory>\n([\s\S]*?)\n<\/project-memory>/g

/** Text placed inside the block cannot close it or its memory section early. */
const inert = (text: string) => text.replace(/<\/(context|project-memory)>/gi, '<\\/$1>')

/** The context blocks of the earlier turns in `history`, oldest first. */
export function contextBlocks(history: ReadonlyArray<LLMMessage>): string[] {
  const blocks: string[] = []
  for (const message of history) {
    if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(`${CONTEXT_OPEN}\n`)) continue
    const end = message.content.indexOf(`\n${CONTEXT_CLOSE}`)
    if (end > 0) blocks.push(message.content.slice(CONTEXT_OPEN.length + 1, end))
  }
  return blocks
}

export interface TurnContextInput {
  budget?: string
  /** The mode the system prompt states and the mode now; shown when the model was last told otherwise. */
  permissionMode: { system: string; current: string }
  /** Relevant session-memory lines ("- [D] …"); the ones an earlier block in `history` already shows are left out. */
  sessionMemory?: string[]
  /** The memory the system prompt carries and the memory on disk now; a difference is shown once. */
  standingMemory?: { system: string; current: string }
  /** The conversation the block is added to, which holds the earlier blocks. */
  history?: ReadonlyArray<LLMMessage>
  /**
   * Skills and MCP prompts this message runs. One with `once` set is left out when the conversation
   * already holds that marker (a skill its trigger loaded before, or the model loaded with Skill).
   */
  invocations?: ReadonlyArray<TurnInvocation>
}

export interface TurnInvocation { text: string; once?: string }

/** Whether any earlier message (a context block, a tool result) holds `marker`. */
function holds(history: ReadonlyArray<LLMMessage>, marker: string): boolean {
  const escaped = JSON.stringify(marker).slice(1, -1)
  return history.some(message => typeof message.content === 'string' ? message.content.includes(marker) : JSON.stringify(message.content).includes(escaped))
}

/**
 * The <context> block for one turn, or '' when there is nothing new to say. What an earlier block
 * in the conversation already shows is not repeated: the permission mode appears when it differs
 * from the last one shown (the system prompt's before any), session-memory entries and memory
 * edits once.
 */
export function buildTurnContext(input: TurnContextInput): string {
  const earlier = contextBlocks(input.history ?? [])
  const lines: string[] = []
  if (input.budget) lines.push(input.budget)
  let shownMode = input.permissionMode.system
  // Only the line right after the header: memory text inside a block may contain anything.
  for (const block of earlier) { const shown = new RegExp(`^${CONTEXT_HEADER}\\n- Permission mode: (\\S+)(?:\\n|$)`).exec(block); if (shown) shownMode = shown[1]! }
  if (input.permissionMode.current !== shownMode) lines.push(`- Permission mode: ${input.permissionMode.current}`)
  const shown = `\n${earlier.join('\n')}\n`
  const fresh = (input.sessionMemory ?? []).map(inert).filter(line => !shown.includes(`\n${line}\n`))
  if (fresh.length) lines.push('Session memory, new since the earlier context:', ...fresh)
  if (input.standingMemory) {
    const show = (memory: string) => memory ? inert(memory) : NO_MEMORY
    let latest: string | undefined
    for (const block of earlier) for (const match of block.matchAll(MEMORY_UPDATE)) latest = match[1]
    const current = show(input.standingMemory.current)
    if (current !== (latest ?? show(input.standingMemory.system))) {
      lines.push('Project memory changed during this session. This version replaces the project memory in the system prompt and any earlier version:', MEMORY_OPEN, current, MEMORY_CLOSE)
    }
  }
  for (const invocation of input.invocations ?? []) {
    if (invocation.once && holds(input.history ?? [], invocation.once)) continue
    lines.push(inert(invocation.text))
  }
  return lines.length ? [CONTEXT_OPEN, CONTEXT_HEADER, ...lines, CONTEXT_CLOSE].join('\n') : ''
}

/** The turn's first user message as sent and saved: the context block (if any), then the user's own words. */
export function withTurnContext(context: string, input: string): string {
  return context ? `${context}\n\n${input}` : input
}
