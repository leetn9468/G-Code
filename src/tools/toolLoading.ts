import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * How a session sends its tool definitions.
 *
 * - `all`: every tool's full definition in every request.
 * - `deferred`: the core tools in full; every other tool only by name, in DeferredToolCall's
 *   description. The model loads a deferred tool's definition with ToolSearch and calls it through
 *   DeferredToolCall. The fixed prompt prefix is much smaller, which matters where preparing the
 *   prompt is slow (the managed llama.cpp runtime, Ollama).
 * - `auto`: deferred for the managed local runtime and Ollama, all for cloud providers.
 *
 * `execution.toolLoading` in ~/.gcode/settings.json; GCODE_TOOL_LOADING overrides it. Read when a
 * session freezes its tool definitions (its first request); the session then keeps them.
 */
export type ToolLoading = 'auto' | 'all' | 'deferred'
export const TOOL_LOADING_DEFAULT: ToolLoading = 'auto'
export const TOOL_LOADING_ENV = 'GCODE_TOOL_LOADING'
const MODES: readonly ToolLoading[] = ['auto', 'all', 'deferred']

/**
 * Sent in full in every mode: what coding work uses in nearly every session, the two tools that reach
 * the rest, and Skill, whose description is the
 * skill catalog (a one-line summary of it would hide every skill name).
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'Bash', 'FileRead', 'FileWrite', 'FileEdit', 'Grep', 'Glob', 'ListDir', 'TodoWrite', 'Agent',
  'TaskOutput', 'TaskStop', 'ToolSearch', 'DeferredToolCall', 'Skill',
])

const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  process.stderr.write(`[tools] ${message}\n`)
}

function fromSettings(): unknown {
  // Resolved at call time: the home directory can change under tests and the desktop rewrites the file.
  try {
    const execution = (JSON.parse(readFileSync(join(homedir(), '.gcode', 'settings.json'), 'utf8')) as { execution?: unknown } | null)?.execution
    return execution && typeof execution === 'object' ? (execution as { toolLoading?: unknown }).toolLoading : undefined
  } catch { return undefined } // No settings file, or one other readers already report as invalid.
}

/** The user's tool loading mode, TOOL_LOADING_DEFAULT when none (or an invalid one) is set. */
export function toolLoadingSetting(): ToolLoading {
  const env = process.env[TOOL_LOADING_ENV]?.trim()
  if (env) {
    if (MODES.includes(env as ToolLoading)) return env as ToolLoading
    warnOnce(`Ignoring ${TOOL_LOADING_ENV}=${JSON.stringify(env.slice(0, 40))}: use auto, all or deferred.`)
  }
  const value = fromSettings()
  if (value === undefined || value === null) return TOOL_LOADING_DEFAULT
  if (MODES.includes(value as ToolLoading)) return value as ToolLoading
  warnOnce(`Ignoring execution.toolLoading ${JSON.stringify(value)?.slice(0, 40)}: use auto, all or deferred.`)
  return TOOL_LOADING_DEFAULT
}

/** Whether a session on this runtime sends only the core tools in full. */
export function defersTools(runtime: { managedLocal?: boolean; provider?: string }, setting: ToolLoading = toolLoadingSetting()): boolean {
  if (setting !== 'auto') return setting === 'deferred'
  return runtime.managedLocal === true || runtime.provider === 'ollama'
}
