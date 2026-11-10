import { workflowTasks } from './tasks.js'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { join, resolve, relative, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolUseContext, WorkflowSource } from '../tools/tool.js'
import { getSessionDirectory } from '../state/store.js'
import { parseWorkflowMeta } from './meta.js'
import { WorkflowRuntime, type WorkflowRuntimeOptions } from './runtime.js'
import { boundedText, workflowOutput, type WorkflowNode } from './events.js'
import { workflowSettings } from './settings.js'
import { escapeDisplayControls, mapDisplayControls } from '../shared/displayText.js'

const MAX_SCRIPT_BYTES = 1024 * 1024
/**
 * args as the script gets them. An untyped value was sent as a JSON string under eager input
 * streaming, which reached the script unparsed: a string holding an object or array is parsed.
 */
function parsedArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : value } catch { return value }
}
const inputSchema = z.object({
  script: z.string().optional().describe('Inline workflow source. Give exactly one of script, scriptPath or name.'),
  scriptPath: z.string().optional().describe("A workflow file in this session's runs/ or .gcode/workflows/."),
  name: z.string().optional().describe('Run a saved .gcode/workflows/<name>.js. Not a title for this run.'),
  args: z.preprocess(parsedArgs, z.union([z.record(z.unknown()), z.array(z.unknown())]).optional()).describe('Input the script reads as args: a JSON object or array, not a string.'),
  guide: z.boolean().optional().describe('Return the workflow writing guide without running a script.'),
  background: z.boolean().optional().describe('Return a runId at once and keep running (interactive terminal only). In the desktop app and -p runs the workflow runs in the foreground and the call waits.'),
})
export type WorkflowInput = z.infer<typeof inputSchema>
export interface WorkflowToolOptions extends Omit<WorkflowRuntimeOptions, 'runId' | 'tools'> {
  tools: () => ReadonlyArray<Tool>
}
const guide = `Workflow writing guide
Start with export const meta = { name: 'short title', description: 'what this run will do' }.
Use args for input data and return a compact JSON result. The script supports top-level await.
background:true returns a runId at once and keeps running; it works only in the interactive terminal. In the desktop app and headless (-p) runs the workflow runs in the foreground and the call waits for its result.
agent(prompt, {label, phase, schema, model, effort, readOnly}) returns text or a schema-validated object; cancelled or terminal API failures return null. await agentFailures() returns [{label, reason}] for the agents that have failed so far, so a script can tell why it got a null; the run's result also lists them, whatever the script returns.
Prefer pipeline(items, ...stages) when each item can move independently: a finished review should begin its verification while other reviews continue. Each stage receives (previous, originalItem, index). A thrown stage makes that item's result null and skips its remaining stages; a returned null still reaches the next stage for fallback handling.
Use parallel([()=>agent(...), ...]) only when the next step truly needs every result. It preserves input order and maps thrown items to null.
Separate claims from evidence. Ask an adversarial reviewer to find counterexamples and reproduce suspected failures before accepting a proposed fix.
For ambiguous decisions, form a small jury with independent prompts, then compare disagreements and supporting evidence rather than simply counting votes.
Iterate review and verification until a complete pass finds no new supported issues. Set an explicit maximum number of rounds and report unresolved issues if it is reached.
Check completeness: match every requested item to its outcome, count missing/null results, and keep stable identifiers through each stage. Never silently truncate input or findings. Split large work into explicit batches and report batch coverage.
Scale to the request: one focused agent for a small task, a few independent reviewers for a medium change, and bounded batches for a large audit. Default maximum 1000 agents per run; a user may explicitly set workflows.maxAgents (1–10000) in personal settings. Each parallel/pipeline call allows at most 4096 items.
Timezone and locale are outside the determinism guarantee. For portable explicit dates use getUTC methods and specify both locale and timeZone: 'UTC' in Intl formatting.
Host calls queue automatically with at most 256 dispatched at once. Progress has priority and a reserved slot; each agent's default phase is captured at its call. On return, progress is bounded by a sequence cutoff: queued log/phase calls drain before completion, and unsent agents resolve to null. After serializing the return value, one microtask batch always opens, even without cancelled agents: microtasks already queued and already registered cancellation reactions may synchronously enqueue log/phase before the closing checkpoint. Await/then continuations queued behind that checkpoint cannot extend it; later log/phase calls and every new agent call after return are discarded without serialization and return promises that never settle, regardless of other in-flight progress. A hard limit of 16384 pending calls prevents unbounded fire-and-forget work; await or batch beyond that limit.
Project hook definitions and command text are inherited from the initiating turn, or captured before any agent starts when there is no parent snapshot, and shared by all agents in that run. Deleted, disabled or edited preTool hook files block guarded execution, including after approval. Send a new message to reload hooks (headless: start a new -p/--print invocation). Rerunning within the same turn keeps the same definitions; standalone runs without a parent snapshot reload on restart. Background runs retain their initiating snapshot across new parent messages: use /workflows stop <runId>, then start a new run in a new turn to reload hooks. Changed postTool/postQuery hooks are skipped with one warning per hook per parent turn, visible as system events in desktop and stderr in terminal/headless; preQuery runs before each model request, including continuations, unless its definition changed; workflow agents do not repeat preQuery/postQuery. Newly created definitions are not loaded. Hooks use the parent's current permission mode, including approval where required; bypass runs do not ask. Stop the run to interrupt a hook already executing. This snapshot fixes definitions, not the contents of other files a hook command may read.
Use phase('title') and log('brief progress') to explain transitions. Date.now(), implicit current dates, random numbers, imports, process and filesystem APIs are unavailable in the script; ask agents to inspect files using their permitted tools. Explicit dates such as new Date(0) work.
Example:
export const meta = {name:'Review files', description:'Inspect selected files and verify findings'};
const findings = await pipeline(args.files,
  (_prev, file) => agent('Review '+file, {label:file, readOnly:true}),
  (review, file) => agent('Challenge this review of '+file+': '+review, {readOnly:true}));
return {results:findings, missing:findings.filter(x=>x===null).length};
`

export const inside = (file: string, root: string, paths = path) => {
  const path = paths.relative(root, file)
  return path === '' || (!path.startsWith('..' + paths.sep) && path !== '..' && !paths.isAbsolute(path))
}
export function workflowRunsDir(context: Pick<ToolUseContext, 'cwd' | 'sessionId'>): string {
  return join(realpathSync(homedir()), relative(homedir(), getSessionDirectory(context.cwd, context.sessionId)), 'runs')
}
function roots(context: ToolUseContext): string[] {
  return [workflowRunsDir(context), join(realpathSync(context.cwd), '.gcode', 'workflows'), join(realpathSync(homedir()), '.gcode', 'workflows')]
}
interface LoadedScript { script: string; origin: WorkflowSource }
/** The call's input is malformed: a failed call the model can correct, not a permission refusal. */
class WorkflowInputError extends Error {}
const approvalSegments = new Intl.Segmenter('en', { granularity: 'grapheme' })
const foldBrackets = (text: string) => text.replace(/\p{Ps}/gu, '[').replace(/\p{Pe}/gu, ']')
const escapeCodePoint = (ch: string) => {
  const code = ch.codePointAt(0)!
  return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
}
function approvalText(value: string, max: number): string {
  // Bound work before segmentation or normalization, without materializing the
  // complete input as an array. Metadata can occupy almost the full 1 MiB script.
  let prefix = '', count = 0
  for (const ch of value) {
    if (count++ === max * 4) break
    prefix += ch
  }
  const text = mapDisplayControls(prefix.replace(/\p{Cs}/gu, escapeCodePoint), ch =>
    // Keep the existing Cc/Cf metadata filtering, but expose tag/selector payloads
    // and other newly covered non-Cf default-ignorables instead of dropping them.
    /[\u{e0020}-\u{e007f}\u2028\u2029]/u.test(ch) || /\p{Default_Ignorable_Code_Point}/u.test(ch) && !/\p{Cf}/u.test(ch)
      ? escapeCodePoint(ch) : /\p{Cc}/u.test(ch) ? ' ' : '')
    .replace(/\[\s*Workflow\s+source\b[^\]]*(?:\]|$)/gi, '')
  // Normalize a detection copy, keeping offsets back to the original graphemes.
  // Ordinary CJK, joining text and emoji must not be normalized for display.
  let copy = ''
  const parts = Array.from(approvalSegments.segment(text), ({ segment }) => {
    const points = [...segment]
    // Canonical reordering of a huge combining cluster can be quadratic. An
    // explicit escape also prevents discarded invisible marks joining a spoof.
    const oversized = points.length > 32
    if (oversized) segment = points.slice(0, 32).map(escapeCodePoint).join('') + '…'
    const start = copy.length
    copy += foldBrackets(oversized ? segment : segment.normalize('NFKC'))
      // Fillers must become spaces before stripping default-ignorable characters.
      .replace(/[\u3164\uffa0\u2800\u115f\u1160]/gu, ' ')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    return { segment, start, end: copy.length }
  })
  const phrases = [...copy.matchAll(/workflow\s+source/gi)].map(match => match.index)
  let phraseIndex = 0
  const escaped = parts.map(({ segment, start, end }) => {
    while (phraseIndex < phrases.length && phrases[phraseIndex]! < start) phraseIndex++
    // Escape the phrase itself even without brackets or with invisible joiners.
    if (phraseIndex < phrases.length && phrases[phraseIndex]! < end) return [...segment].map(escapeCodePoint).join('')
    // The source phrase is escaped above; ordinary punctuation stays verbatim.
    return segment
  }).join('')
  // Keep the code-point display budget, but never detach a combining mark from
  // a grapheme that was already checked above (which could create a new phrase).
  let result = '', length = 0
  for (const { segment } of approvalSegments.segment(escaped.replace(/\s+/g, ' ').trim())) {
    const size = [...segment].length
    if (length + size > max) break
    result += segment
    length += size
  }
  return result
}
function loadScript(input: WorkflowInput, context: ToolUseContext): LoadedScript {
  const given = (['script', 'scriptPath', 'name'] as const).filter(key => input[key] !== undefined)
  if (given.length !== 1) throw new WorkflowInputError(`Provide exactly one of script, scriptPath or name (got ${given.join(' and ') || 'none'})${given.length > 1 && given.includes('name') ? '. name runs a saved .gcode/workflows/<name>.js; it is not a title for this run' : ''}`)
  let script = input.script
  let origin: WorkflowSource = { kind: 'inline' }
  const allowed = roots(context)
  if (input.name !== undefined) {
    if (!/^[a-z0-9-]+$/.test(input.name)) throw new Error('Workflow name must match ^[a-z0-9-]+$')
    const candidates = allowed.slice(1).map(root => join(root, input.name + '.js'))
    const file = candidates.find(path => existsSync(path))
    if (!file) throw new WorkflowInputError(`Workflow ${input.name} not found`)
    input = { ...input, scriptPath: file }
  }
  if (input.scriptPath !== undefined) {
    let file: string
    try { file = realpathSync(resolve(context.cwd, input.scriptPath)) } catch { throw new WorkflowInputError(`scriptPath not found: ${escapeDisplayControls(input.scriptPath)}`) }
    // A symlink must not expand the approved roots into some unrelated tree.
    const valid = allowed.some(root => existsSync(root) && realpathSync(root) === root && inside(file, root))
    if (!valid) throw new Error('scriptPath must be inside this session runs/ or .gcode/workflows/')
    if (!statSync(file).isFile() || statSync(file).size > MAX_SCRIPT_BYTES) throw new WorkflowInputError('Workflow script exceeds 1 MiB or is not a file')
    const index = allowed.findIndex(root => inside(file, root))
    // This is display provenance; retain the raw file separately for I/O.
    origin = { kind: (['session', 'project', 'global'] as const)[index]!, path: escapeDisplayControls(file) }
    script = readFileSync(file, 'utf8')
  }
  if (script === undefined || Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new WorkflowInputError('Workflow script exceeds 1 MiB')
  try { parseWorkflowMeta(script) } catch (error) { throw new WorkflowInputError(error instanceof Error ? error.message : String(error)) }
  return { script, origin }
}

/**
 * Foreground progress for the Workflow call's own card. Updates that only move a token count, or
 * repeat the text last shown, are dropped; a tool waiting for approval names its agent, and the
 * number of approvals still waiting stays on the line until they settle.
 */
function progressReporter(send?: (detail: string) => void): (node: WorkflowNode) => void {
  const agents = new Map<string, string>()
  const running = new Set<string>()
  const waiting = new Set<string>()
  let last: string | undefined
  return node => {
    if (!send) return
    if (node.kind === 'agent') agents.set(node.id, node.label)
    if (node.kind === 'tool') { if (node.awaitingApproval) waiting.add(node.id); else waiting.delete(node.id) }
    // A running agent or run reporting only its token count shows nothing new.
    const tokensOnly = node.status === 'running' && node.detail === undefined && node.tokens !== undefined && running.has(node.id)
    if (node.status === 'running') running.add(node.id); else running.delete(node.id)
    if (tokensOnly) return
    const subject = node.kind === 'tool' ? `agent ${agents.get(node.parentId ?? '') ?? node.parentId} › ${node.label}` : `${node.kind} ${node.label}`
    const status = node.awaitingApproval ? 'waiting for approval' : node.status
    const pending = waiting.size > (node.awaitingApproval ? 1 : 0) ? ` (${waiting.size} waiting for approval)` : ''
    const text = `${subject}: ${status}${node.detail ? ' — ' + node.detail : ''}${pending}`
    if (text === last) return
    last = text
    send(text)
  }
}

export function createWorkflowTool(options: WorkflowToolOptions): Tool<WorkflowInput, Record<string, unknown>> {
  // Permission and execution use the same bytes even if a named file changes
  // while its approval dialog is open.
  const checked = new WeakMap<WorkflowInput, LoadedScript>()
  const enabled = (context: ToolUseContext) => {
    if (!workflowSettings(context.cwd).enabled) throw new Error('Workflow is disabled; set workflows.enabled to true')
    if (context.isHeadless && !context.allowWorkflow) throw new Error('Headless Workflow requires --allow-workflow')
  }
  return {
    name: 'Workflow', description: 'Run a JavaScript workflow of agents.', inputSchema,
    prompt: () => 'Workflow: Run an approved agent script. Use guide:true for the workflow writing guide. background:true works only in the interactive terminal; elsewhere the call waits for the run.',
    async checkPermissions(input, context) {
      try {
        enabled(context)
        // call() returns this fixed text before any script is loaded or run.
        if (input.guide) return { decision: 'allow', reason: 'Static workflow writing guide' }
        const loaded = loadScript(input, context)
        checked.set(input, loaded)
        const meta = parseWorkflowMeta(loaded.script)
        return { decision: 'ask', reason: `${approvalText(meta.name, 100)}: ${approvalText(meta.description, 400)}`, workflowSource: loaded.origin }
      } catch (error) {
        // Malformed input fails the call (state 'failed'); gating and path containment stay refusals.
        if (error instanceof WorkflowInputError) throw new Error(`Invalid Workflow input: ${error.message}`)
        return { decision: 'deny', reason: error instanceof Error ? error.message : String(error) }
      }
    },
    async call(input, context) {
      try {
        enabled(context)
        if (input.guide) return { success: true, output: { guide } }
        context.signal?.throwIfAborted()
        const { script } = checked.get(input) ?? loadScript(input, context)
        checked.delete(input)
        const runId = randomUUID()
        const runs = workflowRunsDir(context)
        let ancestor = realpathSync(homedir())
        for (const part of relative(ancestor, runs).split(sep)) {
          ancestor = join(ancestor, part)
          if (existsSync(ancestor)) {
            if (lstatSync(ancestor).isSymbolicLink() || !statSync(ancestor).isDirectory()) throw new Error('Session runs directory must not traverse symlinks')
          } else mkdirSync(ancestor)
        }
        const directory = join(runs, runId)
        mkdirSync(directory)
        const scriptPath = join(directory, 'script.js')
        writeFileSync(scriptPath, script, { flag: 'wx', mode: 0o600 })
        const downgraded = input.background && (context.isHeadless ? 'headless' : process.env.GCODE_DESKTOP === '1' ? 'desktop' : undefined)
        const background = !!input.background && !downgraded
        const where = downgraded === 'desktop' ? 'the desktop app' : 'headless (-p) runs'
        if (downgraded) context.onProgress?.(`Background workflows are not available in ${where}; running in the foreground`)
        const progress = progressReporter(background ? undefined : context.onProgress)
        const runtime = new WorkflowRuntime({ ...options, runId, tools: options.tools(),
          isHeadless: context.isHeadless, onPermissionDenial: context.onPermissionDenial,
          hookSnapshot: context.hookSnapshot ?? options.hookSnapshot,
          hookWarning: context.hookWarning ?? options.hookWarning,
          hookReloadScope: background ? `run:${runId}` : context.hookReloadScope ?? (context.hookSnapshot === undefined ? options.hookReloadScope : context.isHeadless ? 'headless' : 'turn'),
          toolHookPolicy: context.toolHookPolicy ?? options.toolHookPolicy,
          maxIterations: workflowSettings(context.cwd).maxIterations,
          maxAgents: workflowSettings(context.cwd).maxAgents,
          confirm: context.confirm ?? options.confirm,
          // Files the agents change belong to this session's outputs (its Changes view). An empty
          // artifact report saves the session and publishes the updated list.
          outputs: { sessionId: options.store.getState().sessionId, store: options.store, changed: () => context.onArtifacts?.([]) },
          onEvent: event => {
            workflowTasks.emit(event)
            options.onEvent?.(event)
            if (event.type === 'workflow-state') progress(event.node)
          },
        })
        const task = workflowTasks.start(runtime, context.sessionId, scriptPath, background, script, input.args, context.signal, context.toolUseId)
        if (background) return { success: true, output: { runId, scriptPath, status: 'running' } }
        const result = await task.promise
        return { success: result.status === 'complete', error: result.error && boundedText(result.error), output: workflowOutput({ runId, scriptPath, status: result.status, result: result.value, tokens: result.tokens, ...(result.error ? { error: boundedText(result.error) } : {}), ...result.report,
          ...(downgraded ? { backgroundDowngraded: downgraded, note: `background:true is not available in ${where}, so this workflow ran in the foreground and this call waited for it to finish. Tell the user it ran in the foreground.` } : {}) }) }
      } catch (error) { return { success: false, error: boundedText(error instanceof Error ? error.message : String(error)) } }
    },
  }
}
let configured: ReturnType<typeof createWorkflowTool> | undefined
export function configureWorkflowTool(options: WorkflowToolOptions): void { configured = createWorkflowTool(options) }
export const WorkflowTool: Tool<WorkflowInput, Record<string, unknown>> = {
  name: 'Workflow', description: 'Run a JavaScript workflow of agents.', inputSchema,
  prompt: () => 'Workflow: Run an approved agent script. Use guide:true for the workflow writing guide. background:true works only in the interactive terminal; elsewhere the call waits for the run.',
  checkPermissions: (input, context) => configured?.checkPermissions(input, context) ?? Promise.resolve({ decision: 'deny', reason: 'Workflow is not configured' }),
  call: (input, context) => configured?.call(input, context) ?? Promise.resolve({ success: false, error: 'Workflow is not configured' }),
}
