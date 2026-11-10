/**
 * @file hooks.ts
 * @brief User-defined hook system for pre/post tool execution
 *
 * Hooks are loaded from .gcode/hooks/ directory.
 * Each hook is a JSON file defining a shell command to run
 * at a specific lifecycle point.
 *
 * Hook types:
 * - preTool: runs before a tool is executed
 * - postTool: runs after a tool is executed
 * - preQuery: runs before each LLM API call
 * - postQuery: runs once after the completed turn
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { escapeDisplayControls } from '../shared/displayText.js'
import { headUnits } from '../utils/textUnits.js'

// ============================================================================
// Hook Types
// ============================================================================

export type HookType = 'preTool' | 'postTool' | 'preQuery' | 'postQuery'

export interface HookDefinition {
  name: string
  type: HookType
  command: string
  toolMatch?: string // glob or regex for tool name (preTool/postTool only)
  timeout?: number
  enabled?: boolean
}

export interface HookResult {
  hook: string
  success: boolean
  output?: string
  error?: string
  durationMs: number
}

export type HookSnapshot = ReadonlyArray<Readonly<HookDefinition>>
export type HookWarningSink = (hook: Readonly<HookDefinition>, text: string, reloadScope?: HookReloadScope) => void
export type HookReloadScope = 'turn' | 'headless' | 'run' | `run:${string}`

/** A shared snapshot warns once per reload scope. Background runs must retain
 * their own actionable warning even if the parent already warned this turn. */
export function createHookWarningReporter(onRuntime?: (event: Record<string, unknown>) => void, headless = false): HookWarningSink {
  const warned = new WeakMap<Readonly<HookDefinition>, Set<HookReloadScope>>()
  return (hook, text, scope = 'turn') => {
    const scopes = warned.get(hook) ?? new Set<HookReloadScope>()
    if (scopes.has(scope)) return
    scopes.add(scope); warned.set(hook, scopes)
    onRuntime?.({ type: 'system', text })
    if (headless || process.env.GCODE_DESKTOP !== '1') process.stderr.write(text + '\n')
  }
}
export interface HookContext {
  cwd: string
  hooks: HookSnapshot
  reloadScope?: HookReloadScope
  warn?: HookWarningSink
  signal?: AbortSignal
  toolName?: string
  toolInput?: string
  toolOutput?: string
  query?: string
  response?: string
}
export interface HookExecutionOptions {
  /** Throws for a revoked guard; false means skip a changed non-guard. */
  assertCurrent: () => boolean
  env: Readonly<Record<string, string>>
}
export type HookExecutor = (command: string, timeout: number, description: string, options: HookExecutionOptions) => Promise<{ success: boolean; output?: string; error?: string }>

// ============================================================================
// Hook Registry
// ============================================================================

const hooks: Readonly<HookDefinition>[] = []
const hookFiles = new WeakMap<Readonly<HookDefinition>, { path: string; bytes: Buffer }>()
const MAX_HOOK_BYTES = 1024 * 1024

/** Never wait for a FIFO writer, and bound reads even if a file grows after fstat. */
function readHookFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('hook must be a regular file')
    if (stat.size > MAX_HOOK_BYTES) throw new Error('hook file exceeds 1 MiB')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (!read) break
      length += read
    }
    if (length !== stat.size) throw new Error('hook file changed while reading')
    return bytes.subarray(0, length)
  } finally { closeSync(fd) }
}

function isCurrentHook(hook: Readonly<HookDefinition>): boolean {
  const source = hookFiles.get(hook)
  if (!source) return true // Programmatic hooks have no backing file.
  try { return readHookFile(source.path).equals(source.bytes) } catch { return false }
}

function validateHook(value: unknown, fallbackName: string): Readonly<HookDefinition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hook must be an object')
  const raw = value as Record<string, unknown>
  if (!['preTool', 'postTool', 'preQuery', 'postQuery'].includes(String(raw.type))) throw new Error('unknown hook type')
  if (typeof raw.command !== 'string' || !raw.command.trim() || raw.command.includes('\0')) throw new Error('hook requires a nonempty shell command without NUL bytes')
  if (raw.timeout !== undefined && (!Number.isSafeInteger(raw.timeout) || Number(raw.timeout) <= 0 || Number(raw.timeout) > 600_000)) throw new Error('hook timeout must be an integer between 1 and 600000 milliseconds')
  if (raw.toolMatch !== undefined && typeof raw.toolMatch !== 'string') throw new Error('hook toolMatch must be a string')
  return Object.freeze({
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackName,
    type: raw.type as HookType, command: raw.command,
    toolMatch: raw.toolMatch as string | undefined, timeout: raw.timeout as number | undefined,
    enabled: raw.enabled !== false,
  })
}

/** Independent, immutable definitions for one query; nested agents cannot replace them. */
export function loadHookSnapshot(cwd: string): HookSnapshot {
  const hooksDir = join(cwd, '.gcode', 'hooks')
  if (!existsSync(hooksDir)) return Object.freeze([])
  const snapshot: Readonly<HookDefinition>[] = []
  for (const file of readdirSync(hooksDir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const path = join(hooksDir, file), bytes = readHookFile(path)
      const raw: unknown = JSON.parse(bytes.toString('utf-8'))
      if (raw && typeof raw === 'object' && 'enabled' in raw && raw.enabled === false) continue
      const hook = validateHook(raw, file.replace(/\.json$/, ''))
      hookFiles.set(hook, { path, bytes })
      snapshot.push(hook)
    } catch (error) { throw new Error(`Invalid hook ${file}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return Object.freeze(snapshot)
}

/**
 * Load hooks from .gcode/hooks/ directory.
 * Each .json file defines one hook.
 */
export function loadHooks(cwd: string): number {
  hooks.splice(0, hooks.length, ...loadHookSnapshot(cwd))
  return hooks.length
}

/**
 * Register a hook programmatically.
 */
export function registerHook(hook: HookDefinition): void {
  hooks.push(validateHook(hook, hook.name))
}

/**
 * Get all registered hooks of a type.
 */
export function getHooks(type: HookType): HookSnapshot {
  return Object.freeze(hooks.filter((h) => h.type === type))
}

// ============================================================================
// Hook Execution
// ============================================================================

/** A hook that ran and did not succeed (non-zero exit, refused or denied run). */
export class HookFailedError extends Error {
  constructor(readonly hook: string, readonly hookType: HookType, readonly detail: string) { super(`Hook ${hook} failed: ${detail}`); this.name = 'HookFailedError' }
}

/**
 * Run all hooks of a given type, passing context via environment variables.
 */
export async function runHooks(
  type: HookType,
  context: HookContext,
  execute?: HookExecutor,
): Promise<HookResult[]> {
  context.signal?.throwIfAborted()
  const matching = context.hooks.filter((h) => {
    if (h.type !== type || h.enabled === false) return false
    if (h.toolMatch && context.toolName) {
      try {
        return new RegExp(h.toolMatch).test(context.toolName)
      } catch {
        return h.toolMatch === context.toolName
      }
    }
    return true
  })
  if (matching.length && !execute) throw new Error('Hook execution requires the permission-checked tool executor')

  const results: HookResult[] = []

  for (const hook of matching) {
    const displayName = escapeDisplayControls(hook.name)
    const start = Date.now()
    context.signal?.throwIfAborted()
    let skipped = false
    const runId = context.reloadScope?.startsWith('run:') ? context.reloadScope.slice(4) : undefined
    const reload = context.reloadScope === 'run' || runId ? `Restart this run to reload hooks.${runId ? ` Stop it with /workflows stop ${escapeDisplayControls(runId)} before starting a new run.` : ''}`
      : context.reloadScope === 'headless' ? 'Start a new -p/--print invocation to reload hooks. Rerunning within this invocation keeps the same definitions.'
      : 'Send a new message to reload hooks. Rerunning within this turn keeps the same definitions.'
    const assertCurrent = () => {
      if (skipped) return false
      if (isCurrentHook(hook)) return true
      if (type === 'preTool') throw new Error(`Hook ${hook.name} was modified or removed during this turn. Guarded execution blocked. ${reload}`)
      skipped = true
      const warning = `[hook warning] Skipping ${type} hook ${displayName}: file was modified or removed during this turn. ${reload}`
      if (context.warn) context.warn(hook, warning, context.reloadScope)
      else process.stderr.write(warning + '\n')
      return false
    }
    if (!assertCurrent()) continue
    const env: Record<string, string> = {
      GCODE_HOOK_TYPE: type,
    }
    if (context.toolName) env['GCODE_TOOL_NAME'] = context.toolName
    if (context.toolInput) env['GCODE_TOOL_INPUT'] = headUnits(context.toolInput, 10000)
    if (context.toolOutput) env['GCODE_TOOL_OUTPUT'] = headUnits(context.toolOutput, 10000)
    if (context.query) env['GCODE_QUERY'] = headUnits(context.query, 10000)
    if (context.response) env['GCODE_RESPONSE'] = headUnits(context.response, 10000)

    const quote = (value: string) => {
      if (value.includes('\0')) throw new Error('Hook command contains a NUL byte')
      return `'${value.replace(/'/g, `'"'"'`)}'`
    }
    for (const key of Object.keys(env)) env[key] = env[key]!.replace(/\0/g, '\ufffd')
    // Context is data, not shell syntax. Only the configured command passes
    // through command validation; the same frozen data reaches spawn's env.
    const command = `/bin/sh -c ${quote(hook.command)}`
    const result = await execute!(command, hook.timeout ?? 10_000, `Project hook ${hook.name} (${type})`, { assertCurrent, env: Object.freeze(env) })
    context.signal?.throwIfAborted()
    if (skipped) continue
    if (result.success !== true) throw new HookFailedError(hook.name, type, result.error ?? 'execution rejected or unsuccessful')

    results.push({
      hook: hook.name,
      success: true,
      output: result.output,
      durationMs: Date.now() - start,
    })
  }

  return results
}

/**
 * Convenience: run pre-tool hooks.
 */
export async function runPreToolHooks(
  cwd: string,
  toolName: string,
  toolInput: string,
  execute?: HookExecutor,
  snapshot: HookSnapshot = loadHookSnapshot(cwd),
  signal?: AbortSignal,
): Promise<HookResult[]> {
  return runHooks('preTool', { cwd, toolName, toolInput, hooks: snapshot, signal }, execute)
}

/**
 * Convenience: run post-tool hooks.
 */
export async function runPostToolHooks(
  cwd: string,
  toolName: string,
  toolOutput: string,
  execute?: HookExecutor,
  snapshot: HookSnapshot = loadHookSnapshot(cwd),
  signal?: AbortSignal,
): Promise<HookResult[]> {
  return runHooks('postTool', { cwd, toolName, toolOutput, hooks: snapshot, signal }, execute)
}
