import { assertToolFile } from '../../session/scopedPermission.js'
import { writeTarget, secretRefusal } from '../permissions.js'
import { guardedExecSync as execSync } from '../../security/process.js'
/**
 * @file UtilityTools.ts
 * @brief Small utility tools: Sleep, Config, ToolSearch, PowerShell
 */


import { toolEnv } from '../../runtime/node.js'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { safeWriteFile } from './safeWrite.js'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { createDefaultPermissionContext } from '../../types.js'
import { workflowSettings } from '../../workflow/settings.js'
import { DEFERRED_CALL, toolJsonSchema } from './DeferredToolCallTool.js'

// ============================================================================
// SleepTool
// ============================================================================

export const SleepTool: Tool<{ seconds: number }, string> = {
  name: 'Sleep',
  description: 'Pause execution for a specified duration',
  inputSchema: z.object({
    seconds: z.number().min(0).max(300).describe('Seconds to wait (max 300)'),
  }),

  async call(input, context): Promise<ToolResult<string>> {
    // Stopping the turn ends the wait at once instead of holding the stop for up to 300 s.
    const signal = context.signal
    const started = Date.now()
    const stopped = signal?.aborted || await new Promise<boolean>((resolve) => {
      const finish = (aborted: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(aborted) }
      const onAbort = () => finish(true)
      const timer = setTimeout(() => finish(false), input.seconds * 1000)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    if (stopped) return { success: false, error: `Sleep stopped after ${Math.round((Date.now() - started) / 1000)}s: the turn was stopped` }
    return { success: true, output: `Slept for ${input.seconds}s` }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'Sleep: Pause execution for a specified number of seconds (max 300).' },
}

// ============================================================================
// ConfigTool
// ============================================================================

/**
 * Settings G-Code reads only from the user's own ~/.gcode/settings.json (the desktop's Settings and
 * the CLI). A project's .gcode/settings.json cannot change them, and Workflow authority must stay
 * personal, so the Config tool refuses them instead of writing a value that has no effect.
 */
const PERSONAL_SETTINGS = new Set(['workflows', 'execution', 'provider', 'workspace', 'effort', 'ui', 'appearance'])
const UNSAFE_KEY_PARTS = new Set(['__proto__', 'constructor', 'prototype'])

type SettingsObject = Record<string, unknown>
const isSettingsObject = (value: unknown): value is SettingsObject => !!value && typeof value === 'object' && !Array.isArray(value)

/** A dotted key ("a.b.c") as its path of object keys. */
function settingKey(key: string): string[] {
  const parts = key.split('.')
  if (parts.some(part => !part.trim() || UNSAFE_KEY_PARTS.has(part))) throw new Error(`Invalid setting key "${key}": use names separated by dots, such as a.b`)
  return parts
}
function readSetting(config: SettingsObject, parts: string[]): { found: boolean; value?: unknown } {
  let value: unknown = config
  for (const part of parts) {
    if (!isSettingsObject(value) || !Object.hasOwn(value, part)) return { found: false }
    value = value[part]
  }
  return { found: true, value }
}
/** JSON text becomes its value (true, 3, {"a":1}); any other text stays a string. */
function settingValue(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
/** Saved API keys never reach the model, even when the project folder is the home folder. */
function withoutSecrets(value: unknown, parts: string[] = []): unknown {
  if (parts[0] === 'provider' && parts[1] === 'apiKeys') return isSettingsObject(value) ? Object.fromEntries(Object.keys(value).map(name => [name, '[hidden]'])) : '[hidden]'
  if (!isSettingsObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutSecrets(child, [...parts, key])]))
}

export const ConfigTool: Tool<{ action: string; key?: string; value?: string }, unknown> = {
  name: 'Config',
  description: 'Read or write this project\'s .gcode/settings.json',
  inputSchema: z.object({
    action: z.enum(['get', 'set', 'list']).describe('Action to perform'),
    key: z.string().optional().describe('Setting key for get/set; dots name nested keys, such as a.b'),
    value: z.string().optional().describe('Value for set. JSON is parsed (true, 3, {"a":1}); other text is stored as a string'),
  }),

  async call(input, context): Promise<ToolResult<unknown>> {
    const configPath = join(context.cwd, '.gcode', 'settings.json')
    try { assertToolFile(configPath) } catch (error) { return { success: false, error: String(error) } }
    if (input.action === 'set') { const target = writeTarget(configPath, context.cwd); if (target?.secret) return { success: false, error: secretRefusal(target.resolved, 'change') } }
    const shown = '.gcode/settings.json'
    let parts: string[] | undefined
    try { parts = input.key === undefined ? undefined : settingKey(input.key) } catch (error) { return { success: false, error: (error as Error).message } }
    const load = (): SettingsObject => {
      if (!existsSync(configPath)) return {}
      const config: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (!isSettingsObject(config)) throw new Error(`${shown} does not hold a JSON object`)
      return config
    }

    if (input.action === 'list' || input.action === 'get') {
      let config: SettingsObject
      try { config = load() } catch { return { success: true, output: {} } }
      if (input.action === 'get' && parts) {
        const setting = readSetting(config, parts)
        if (!setting.found) return { success: true, output: `${input.key} is not set in ${shown}` }
        return { success: true, output: withoutSecrets(setting.value, parts) }
      }
      return { success: true, output: withoutSecrets(config) }
    }

    if (input.action === 'set' && parts) {
      if (input.value === undefined) return { success: false, error: 'set needs a value' }
      if (PERSONAL_SETTINGS.has(parts[0]!)) {
        return { success: false, error: `"${input.key}" is a personal setting. G-Code reads it only from ~/.gcode/settings.json, and this tool edits the project's ${shown}, which G-Code does not read. Nothing was changed; ask the user to change it in Settings.` }
      }
      let config: SettingsObject
      // A file that is not valid JSON is never replaced: its other settings would be lost.
      try { config = load() } catch (error) { return { success: false, error: `${shown} could not be read (${error instanceof Error ? error.message : String(error)}); fix it first. Nothing was changed.` } }
      let node = config
      for (const [index, part] of parts.slice(0, -1).entries()) {
        const next = node[part]
        if (next === undefined) node = node[part] = {}
        else if (isSettingsObject(next)) node = next
        else return { success: false, error: `"${parts.slice(0, index + 1).join('.')}" is not an object, so "${input.key}" cannot be set. Nothing was changed.` }
      }
      const value = settingValue(input.value)
      node[parts.at(-1)!] = value
      mkdirSync(join(context.cwd, '.gcode'), { recursive: true })
      safeWriteFile(configPath, JSON.stringify(config, null, 2))
      return { success: true, output: { file: shown, key: input.key, value } }
    }

    return { success: false, error: 'Invalid action or missing key' }
  },

  async checkPermissions() { return { decision: 'ask' as const, reason: 'Modifies settings' } },
  prompt() { return 'Config: Read or write this project\'s .gcode/settings.json; dots name nested keys (a.b). G-Code does not read this file: personal settings (workflows, provider, execution) live in ~/.gcode/settings.json and cannot be changed here.' },
}

// ============================================================================
// ToolSearchTool
// ============================================================================

/** Workflow is left out of the catalog until the user turns it on; a search names it and says how. */
const WORKFLOW_OFF = { name: 'Workflow', description: 'Unavailable: Workflow is off. Only the user can turn it on, with workflows.enabled: true in ~/.gcode/settings.json; project settings cannot. Ask the user.', available: false as const }

/** One match. A tool the session does not send in full (deferred) comes with its whole definition. */
interface ToolSearchMatch { name: string; description: string; available?: false; input_schema?: Record<string, unknown> }

export const ToolSearchTool: Tool<{ query: string }, ToolSearchMatch[]> = {
  name: 'ToolSearch',
  description: 'Search available tools by name or description',
  inputSchema: z.object({
    query: z.string().describe('Keywords, or "select:Name,Other" for exact tool names'),
  }),

  async call(input, context): Promise<ToolResult<ToolSearchMatch[]>> {
    // The caller's own tools: a sub-agent or read-only agent must not be offered tools it lacks.
    const tools = context.tools ?? (await import('../registry.js')).getTools(createDefaultPermissionContext(), context.cwd)
    const query = input.query.trim()
    const q = query.toLowerCase()
    const selected = /^select:/i.test(query) ? [...new Set(query.slice(7).split(',').map(name => name.trim()).filter(Boolean))] : undefined
    const byName = (name: string) => tools.find(t => t.name === name) ?? tools.find(t => t.name.toLowerCase() === name.toLowerCase())
    const found = selected ? [...new Set(selected.map(byName).filter((t): t is NonNullable<typeof t> => !!t))]
      : tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    const deferred = context.deferredTools
    const matches: ToolSearchMatch[] = found.map((t) => deferred?.has(t.name)
      ? { name: t.name, description: t.prompt(), input_schema: toolJsonSchema(t) }
      : { name: t.name, description: t.description })
    const workflow = q.includes('workflow') || 'run a javascript workflow of agents.'.includes(q)
    if (workflow && !tools.some(t => t.name === 'Workflow') && !workflowSettings(context.cwd).enabled) matches.push(WORKFLOW_OFF)
    const missing = selected?.filter(name => !byName(name) && !(name.toLowerCase() === 'workflow' && matches.includes(WORKFLOW_OFF))) ?? []
    if (!selected && !matches.some(match => match.input_schema)) return { success: true, output: matches }
    // The model reads definitions as compact text: indented JSON would double a schema's tokens.
    const text = [
      ...matches.map(match => match.input_schema
        ? `${match.name} (call it with ${DEFERRED_CALL})\n${match.description}\nInput schema: ${JSON.stringify(match.input_schema)}`
        : `${match.name}: ${match.description}`),
      ...(missing.length ? [`No tool named ${missing.join(', ')}.`] : []),
    ].join('\n\n') || 'No matching tools.'
    return { success: true, output: matches, contentBlocks: [{ type: 'text', text }] }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'ToolSearch: Search available tools by name or keyword.' },
}

// ============================================================================
// PowerShellTool (Windows-specific)
// ============================================================================

export const PowerShellTool: Tool<{ command: string; timeout?: number }, { stdout: string; stderr: string; exitCode: number | null }> = {
  name: 'PowerShell',
  description: 'Execute PowerShell commands (Windows)',
  inputSchema: z.object({
    command: z.string().describe('PowerShell command to execute'),
    timeout: z.number().optional().describe('Timeout in ms'),
  }),

  async call(input, context): Promise<ToolResult<{ stdout: string; stderr: string; exitCode: number | null }>> {
    if (process.platform !== 'win32') {
      return { success: false, error: 'PowerShell is only available on Windows' }
    }
    try {
      const result = execSync(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${input.command.replace(/"/g, '\\"')}"`,
        { cwd: context.cwd, env: toolEnv(), encoding: 'utf-8', timeout: input.timeout ?? 120_000, windowsHide: true },
      )
      return { success: true, output: { stdout: result, stderr: '', exitCode: 0 } }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number }
      return {
        success: false,
        output: { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 },
        error: e.stderr || 'Command failed',
      }
    }
  },

  async checkPermissions() { return { decision: 'ask' as const, reason: 'Shell execution' } },
  prompt() { return 'PowerShell: Execute PowerShell commands (Windows only).' },
}
