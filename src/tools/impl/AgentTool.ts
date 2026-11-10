/**
 * @file AgentTool.ts
 * @brief Spawn a sub-agent G-Code process for complex subtasks
 *
 * Creates a child QueryEngine with its own context and tool set.
 * The parent receives a single text result when the child completes: its final reply, then a
 * short record of what it changed, what failed and what it left running.
 */

import { randomUUID } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import type { LLMClient } from '../../llm/types.js'
import type { Store } from '../../state/store.js'
import { createAppStore } from '../../state/store.js'
import type { AppState } from '../../types.js'
import { QueryEngine } from '../../engine/queryEngine.js'
import { AGENT_CONCURRENCY } from '../../engine/toolRunner.js'
import { escapeDisplayControls } from '../../shared/displayText.js'
import { terminalTool, TOOL_LABELS, type ToolPhase } from '../../shared/runtimeEvents.js'
import { headUnits, tailUnits } from '../../utils/textUnits.js'
import { relativeToProject } from '../../utils/path.js'
import { backgroundShells } from '../backgroundShells.js'
import { lspReadOnlyRefusal } from './LSPTool.js'
import { MAX_TOOL_RESULT_CHARS } from '../../engine/microcompact.js'
import { generatedFolder } from '../../session/outputs.js'
import { maskSecrets } from '../../security/secretValues.js'

const inputSchema = z.object({
  description: z.string().describe('Short description of the subtask (3-5 words)'),
  prompt: z.string().describe('Detailed instructions for the sub-agent'),
  subagent_type: z.enum(['general', 'explore']).optional()
    .describe('explore: finds, reads and answers questions about code; read-only, runs no commands. general (default): may also edit files and run commands.'),
})

type AgentInput = z.infer<typeof inputSchema>

/** One call the sub-agent made, as in-process callers read it (the model reads `content`). */
interface AgentCall { name: string; input: string; state: ToolPhase }

interface AgentOutput {
  /** What the parent model reads: the final reply, then the facts block (see resultText). */
  content: string
  response: string
  toolCallCount: number
  iterations: number
  calls?: AgentCall[]
  /** Calls after the listed ones. */
  moreCalls?: number
}

/** Calls kept in `calls`; a longer run keeps its first ones and says how many more. */
const LISTED_CALLS = 50
/** Lines in each list of the facts block; a longer list ends with how many more. */
const LISTED_FACTS = 10

/**
 * What an explore sub-agent may use: it reads and searches, and runs and writes nothing, so its
 * call skips the approval prompt. Each of its calls still passes the deny rules, the scoped asks
 * (a read outside the project, a new web host) and the network guard.
 */
const EXPLORE_TOOLS = new Set(['FileRead', 'Grep', 'Glob', 'ListDir', 'LSP', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill', 'ListMcpResources', 'ReadMcpResource'])
/** An MCP tool its server marks read-only (readOnlyHint) is an explore tool too; its calls still ask unless a rule allows them. */
const exploreTool = (tool: Tool<unknown, unknown>) => EXPLORE_TOOLS.has(tool.name) || (tool.name.startsWith('mcp__') && tool.concurrencySafe === true)

/**
 * A call's main argument in one short line: the command, the file, the pattern. A path is shown
 * relative to the project and, when still long, keeps its end: under a deep project root the head
 * is the same for every file, and the file name is what tells the calls apart.
 */
function brief(input: unknown, cwd?: string): string {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const main = [value.command, value.file_path, value.notebook_path, value.pattern, value.url, value.path, value.query, ...Object.values(value)].find(item => typeof item === 'string' && item.trim())
  if (typeof main !== 'string') return ''
  const isPath = main === value.file_path || main === value.notebook_path || main === value.path
  const shown = isPath && cwd && isAbsolute(main) ? projectPath(main, cwd) : main
  const line = shown.replace(/\s+/g, ' ').trim()
  if (line.length <= 120) return escapeDisplayControls(line)
  return escapeDisplayControls(isPath ? `${headUnits(line, 40)}…${tailUnits(line, 79)}` : `${headUnits(line, 119)}…`)
}

/** A path inside the project, relative to it; any other path as it is. */
function projectPath(path: string, cwd: string): string {
  const inner = relative(cwd, path)
  return inner && inner !== '..' && !inner.startsWith(`..${sep}`) && !isAbsolute(inner) ? inner : path
}

/** One call as the sub-agent's tool-state events tell it. */
interface CallRecord { name: string; input?: unknown; state: ToolPhase; output?: string; error?: string }

/** A call that did not complete, in one short line: its error (and a command's exit code) or why it did not run. */
function failure(call: CallRecord, cwd: string): string {
  const text = call.error ?? ''
  const exit = /^Exit code: (-?\d+)$/m.exec(text)?.[1]
  const lines = text.replace(/^Error: /, '').split('\n').map(line => line.trim()).filter(Boolean)
  // A first line that ends in ':' introduces the reason ('Not run: invalid input for "X":' then '- issue'): keep its first item.
  const opening = lines[0]?.endsWith(':') && lines[1] ? `${lines[0]} ${lines[1].replace(/^- /, '')}` : lines[0] ?? ''
  // A command's first line is the fixed "Command failed": why it failed is its first stderr line. What it
  // printed is no reason: a failing `node --test` ends with an assertion's closing "}" (e2, round 20).
  const said = call.name === 'Bash' && opening === 'Command failed' ? lines.slice(1).find(line => line.startsWith('STDERR: '))?.slice(8).trim() : undefined
  const first = said ? `${opening}: ${said}` : opening
  // A denial or cancellation says so first, unless its reason already does ("Not run: …").
  const label = call.state === 'failed' ? '' : TOOL_LABELS[call.state]
  const reason = !first ? label : label && !first.toLowerCase().startsWith(label.toLowerCase()) ? `${label}: ${first}` : first
  // Paths relative to the project, as the call's own are: under a deep project root they fill the line.
  const plain = relativeToProject(reason, cwd)
  // A long error keeps its end too: a path-heavy one says why last ("… No such file or directory (os error 2)").
  const line = escapeDisplayControls(plain.length > 160 ? `${headUnits(plain, 100)}…${tailUnits(plain, 59)}` : plain)
  const input = brief(call.input, cwd)
  return `- ${call.name}${input ? ` (${input})` : ''}: ${line}${exit !== undefined ? `, exit ${exit}` : ''}`
}

/** At most LISTED_FACTS lines, then how many more. */
function capped(lines: string[]): string[] {
  return lines.length > LISTED_FACTS ? [...lines.slice(0, LISTED_FACTS), `- ${lines.length - LISTED_FACTS} more`] : lines
}

/** Room in a result for what comes with the reply: the failure line and the note on a cut reply. */
const RESULT_MARGIN = 3000
/** The longest failure reason a result repeats. */
const MAX_FAILURE_CHARS = 2000

/**
 * A reply that fits next to the facts; a longer one keeps its start, and the whole of it is saved
 * where FileRead can reach it (the name is a saved output's, so the same sweep removes it in time).
 * Microcompaction would otherwise cut the end of the result: the facts, and a note that says to
 * repeat the call, which for an agent repeats its work.
 */
export function fittedReply(whole: string, room: number, cwd: string, sessionId: string): string {
  if (whole.length <= room) return whole
  // Masked before the cut: a key across it would no longer read as a key.
  const reply = maskSecrets(whole)
  if (reply.length <= room) return reply
  let saved: string | undefined
  try {
    saved = join(generatedFolder(cwd, 'tool-output'), `bash-${sessionId.slice(0, 8)}-${Date.now()}-${randomUUID().slice(0, 6)}.txt`)
    writeFileSync(saved, reply, { flag: 'wx', mode: 0o600 })
  } catch { saved = undefined }
  const where = saved ? `The whole reply is saved at ${saved}: read the part you need with FileRead offset and limit.` : 'The rest could not be saved.'
  return `${headUnits(reply, room)}\n\n[This sub-agent's reply was cut to fit: the first ${room.toLocaleString('en-US')} of ${reply.length.toLocaleString('en-US')} characters are shown. ${where} Running the agent again would repeat its work and its changes.]`
}

/**
 * The parent model's result: the sub-agent's final reply, then the facts it cannot leave out or get
 * wrong, in plain text (a JSON result escapes every newline of the reply). The full call list stays
 * out: the parent asked for the outcome, and the failed calls and changed files are the parts of
 * the run it may need to act on.
 */
function resultText(reply: string, records: ReadonlyMap<string, CallRecord>, changed: ReadonlyMap<string, boolean>, iterations: number, cwd: string, sessionId: string, lost: ReadonlySet<string> = new Set()): string {
  const calls = [...records.values()].filter(call => call.state !== 'preparing')
  const facts: string[] = []
  // Outputs are recorded by their real path (/private/var/… for /var/… on macOS).
  let root = cwd
  try { root = realpathSync(cwd) } catch { /* A removed folder: its paths are shown in full. */ }
  if (changed.size) facts.push(`Files changed: ${[...changed].slice(0, LISTED_FACTS * 2).map(([path, deleted]) => `${brief({ file_path: projectPath(path, root) })}${deleted ? ' (deleted)' : ''}`).join(', ')}${changed.size > LISTED_FACTS * 2 ? `, ${changed.size - LISTED_FACTS * 2} more` : ''}`)
  const failed = calls.filter(call => terminalTool(call.state) && call.state !== 'complete')
  if (failed.length) facts.push('Failed calls:', ...capped(failed.map(call => failure(call, cwd))))
  // Background tasks it started (their ids are in its Bash results) that still run: the parent can
  // read or stop them, and they end with the session.
  const ids = new Set(calls.filter(call => call.name === 'Bash').flatMap(call => (call.output ?? call.error ?? '').match(/\bbg-[0-9a-f]{8}\b/g) ?? []))
  const running = [...ids].map(id => backgroundShells.get(id)).filter(task => task?.status === 'running')
  if (running.length) facts.push(`Still running: ${running.slice(0, LISTED_FACTS).map(task => `${task!.id} (${brief({ command: task!.command }, cwd)})`).join(', ')}${running.length > LISTED_FACTS ? `, ${running.length - LISTED_FACTS} more` : ''}. Read with TaskOutput, stop with TaskStop.`)
  // No person reads a sub-agent's notices, so what left its context is said here: the reply may rest on less than the whole run.
  if (lost.has('request')) facts.push('Context: its task was too long to stay whole, so from its first compaction it kept only the start and end of the task.')
  if (lost.has('note')) facts.push('Context: earlier messages left its context without a summary (only their starts and a list of the calls stayed), so this reply may rest on less than the whole run.')
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const tally = [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ')
  facts.push(`${calls.length ? `${calls.length} tool call${calls.length === 1 ? '' : 's'} (${tally})` : 'No tool calls'} in ${iterations} repl${iterations === 1 ? 'y' : 'ies'}.`)
  const block = `\n\n[Sub-agent run]\n${facts.join('\n')}`
  return `${fittedReply(reply.trim() || '(No final reply.)', MAX_TOOL_RESULT_CHARS - RESULT_MARGIN - block.length, cwd, sessionId)}${block}`
}

// Real engineering work (a refactor that splits files, then builds and checks them) takes far more
// than 25 model replies; this cap, the per-turn call budget and failures with no new work between them bound a sub-agent that loops.
const AGENT_MAX_ITERATIONS = 100

// Tools that mutate process-wide or parent-session state (worktree singleton,
// todo list, task registry, settings, permission mode) or would nest
// further agents. A sub-agent works inside the parent's turn and returns text.
const PARENT_ONLY_TOOLS = new Set([
  'Agent', 'Workflow', 'EnterWorktree', 'ExitWorktree', 'TodoWrite', 'Config', 'EnterPlanMode', 'ExitPlanMode',
])
// Bash tells every caller to follow a background command with these: a sub-agent that starts one
// must be able to read and stop it. The other Task tools are the parent's task list.
const SUB_AGENT_TASK_TOOLS = new Set(['TaskOutput', 'TaskStop'])

export function isSubAgentTool(name: string): boolean {
  return !PARENT_ONLY_TOOLS.has(name) && (SUB_AGENT_TASK_TOOLS.has(name) || !/^Task[A-Z]/.test(name))
}

// Must be set before AgentTool can be used
let agentLLMClient: LLMClient | null = null
let agentStore: Store<AppState> | null = null
let agentModel: string | undefined

export function configureAgentTool(
  client: LLMClient,
  store: Store<AppState>,
  model?: string,
): void {
  agentLLMClient = client
  agentStore = store
  agentModel = model
}

export const AgentTool: Tool<AgentInput, AgentOutput> = {
  name: 'Agent',
  description: 'Launch a sub-agent to handle complex, multi-step subtasks autonomously',
  inputSchema,

  async call(input, context): Promise<ToolResult<AgentOutput>> {
    if (!agentLLMClient || !agentStore) {
      return { success: false, error: 'AgentTool not configured (no LLM client)' }
    }

    const { getTools } = await import('../registry.js')
    const tools = getTools(agentStore.getState().permissionContext, context.cwd)

    const explore = input.subagent_type === 'explore'
    // An explore sub-agent writes and runs nothing: LSP's format action (it rewrites the file) and
    // diagnostics that start a program are refused there, in every mode, never asked.
    const childTools = tools.filter((t) => isSubAgentTool(t.name) && (!explore || exploreTool(t))).map(t => explore && t.name === 'LSP' ? {
      ...t, checkPermissions: (lspInput: unknown, lspContext: ToolUseContext) => {
        const refusal = lspReadOnlyRefusal(lspInput, 'An explore sub-agent')
        return refusal ? Promise.resolve<PermissionResult>({ decision: 'deny', reason: refusal }) : t.checkPermissions(lspInput, lspContext)
      },
    } : t)
    const childStore = createAppStore(undefined, context.cwd)
    childStore.setState(() => ({
      permissionContext: { ...agentStore!.getState().permissionContext },
      effort: agentStore!.getState().effort,
    }))

    // The parent's card for this call shows what the sub-agent is doing: its tool calls and its waits
    // for the model. The child's own context-status frames are its context, not the session's.
    let shown = ''
    // Its calls, from its tool-state events: the store's tool history keeps only the last 100.
    const records = new Map<string, CallRecord>()
    // What left its context without being summarized (see resultText).
    const lost = new Set<string>()
    // The files it changed: it records them into the parent session's outputs through this store.
    const changed = new Map<string, boolean>()
    const parentStore = agentStore
    const ledgerStore: Store<AppState> = {
      getState: () => parentStore.getState(),
      subscribe: listener => parentStore.subscribe(listener),
      setState: updater => parentStore.setState(state => {
        const next = updater(state)
        for (const output of next.outputs ?? []) if (!state.outputs?.includes(output)) changed.set(output.path, !!output.deleted)
        return next
      }),
    }
    const progress = (detail: string) => {
      if (!detail || detail === shown) return
      shown = detail
      context.onProgress?.(detail)
    }
    const childEngine = new QueryEngine({
      client: agentLLMClient,
      tools: childTools,
      store: childStore,
      usageStore: agentStore,
      model: agentModel,
      // Streamed like the main conversation (its text is not shown), so it gets the same output
      // budget for its effort: a non-streaming request is capped far lower, and adaptive thinking
      // could spend all of that before the sub-agent wrote its report.
      streaming: true,
      verbose: false,
      sessionMemory: false,
      includeSessionMemory: false,
      persist: false,
      maxIterations: AGENT_MAX_ITERATIONS,
      // The parent's own outputs, as a child engine records by default; the parent saves and reports them.
      outputs: { sessionId: parentStore.getState().sessionId, store: ledgerStore, changed: () => context.onArtifacts?.([]) },
      // The approval says which sub-agent asks, as a workflow agent's does.
      onGateConfirm: context.confirm && ((name, reason, toolInput, request) => context.confirm!(name, reason, toolInput,
        { ...request, origin: { kind: 'agent', label: escapeDisplayControls(headUnits(input.description, 200)) } })),
      hookSnapshot: context.hookSnapshot,
      hookWarning: context.hookWarning,
      hookReloadScope: context.hookReloadScope ?? (context.hookSnapshot === undefined ? 'run' : context.isHeadless ? 'headless' : 'turn'),
      isHeadless: context.isHeadless,
      onPermissionDenial: context.onPermissionDenial,
      toolHookPolicy: context.toolHookPolicy ?? context.getPermissionContext,
      onRuntime: event => {
        if (typeof event.contextLost === 'string') lost.add(event.contextLost)
        // Its notices too (a retry with a larger output budget, a compaction): otherwise the card
        // reads "Waiting for the model…" through all of it.
        if ((event.type === 'status' || event.type === 'system') && typeof event.text === 'string') progress(escapeDisplayControls(headUnits(event.text, 300)))
        if (event.type !== 'tool-state' || typeof event.name !== 'string') return
        const state = event.state as ToolPhase
        if (typeof event.id === 'string') {
          const call = records.get(event.id) ?? { name: event.name, state }
          call.state = state
          if (event.input !== undefined) call.input = event.input
          // A command's result names the background task it started; other results are not needed.
          if (event.name === 'Bash' && typeof event.output === 'string') call.output = event.output
          if (typeof event.error === 'string') call.error = event.error
          records.set(event.id, call)
        }
        const subject = typeof event.detail === 'string' && state === 'running' ? escapeDisplayControls(headUnits(event.detail, 120)) : brief(event.input, context.cwd)
        if (state === 'running') progress(`${escapeDisplayControls(event.name)}${subject ? `: ${subject}` : ''}`)
        else if (terminalTool(state)) progress(`${escapeDisplayControls(event.name)} ${TOOL_LABELS[state].toLowerCase()}${subject ? `: ${subject}` : ''}`)
      },
    })
    const record = () => {
      const all = [...records.values()].filter(call => call.state !== 'preparing').map(call => ({ name: call.name, input: brief(call.input, context.cwd), state: call.state }))
      return { calls: all.slice(0, LISTED_CALLS), ...(all.length > LISTED_CALLS ? { moreCalls: all.length - LISTED_CALLS } : {}) }
    }

    const abortChild = () => childEngine.abort()
    context.signal?.addEventListener('abort', abortChild, { once: true })

    try {
      context.signal?.throwIfAborted()
      process.stderr.write(`[agent] Starting: ${escapeDisplayControls(input.description)}\n`)

      const result = await childEngine.submitQuery(input.prompt)

      process.stderr.write(
        `[agent] Done: ${escapeDisplayControls(input.description)} (${result.iterations} iterations, ${result.toolCallCount} tool calls)\n`,
      )

      return {
        success: true,
        output: {
          content: resultText(result.response, records, changed, result.iterations, context.cwd, context.sessionId, lost),
          response: result.response,
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
          ...record(),
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A failed or stopped sub-agent may already have changed files: say what it changed and what
      // failed, and what it had written so far (its notes on the work), with the rounds it took.
      const ran = record()
      const turn = childEngine.failedTurn
      const error = context.signal?.aborted ? 'Sub-agent stopped: the turn was stopped before it finished.' : `Sub-agent failed: ${headUnits(msg, MAX_FAILURE_CHARS)}`
      const iterations = turn?.iterations ?? 0
      return { success: false, error, ...(ran.calls.length || turn?.text ? { output: { content: resultText(turn?.text ?? '', records, changed, iterations, context.cwd, context.sessionId, lost), response: turn?.text ?? '', toolCallCount: ran.calls.length + (ran.moreCalls ?? 0), iterations, ...ran } } : {}) }
    } finally {
      context.signal?.removeEventListener('abort', abortChild)
    }
  },

  async checkPermissions(input, _context): Promise<PermissionResult> {
    // User decision 2026-11-01: a sub-agent that only reads runs without asking; its calls are checked one by one.
    if (input?.subagent_type === 'explore') return { decision: 'allow' }
    return { decision: 'ask', reason: 'Sub-agent spawning requires user approval' }
  },

  prompt(): string {
    // At most 200 bytes: it is repeated in every request's tool catalog.
    return `Agent: Hand a sub-agent complex multi-step subtasks (general) or code search and reading (explore: read-only, no approval). Agent calls in one reply run in parallel (up to ${AGENT_CONCURRENCY} at once).`
  },
}
