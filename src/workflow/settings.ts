import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { escapeDisplayControls } from '../shared/displayText.js'

export interface WorkflowSettings { enabled: boolean; concurrency: Record<string, number>; maxIterations: number; maxAgents?: number }
const warned = new Set<string>()

/**
 * A `workflows` entry in this project's .gcode/settings.json (or settings.local.json) has no
 * effect, because workflow settings are personal. The notice says so and where the setting goes;
 * it never changes the result. Undefined when the project has no such entry.
 */
export function ignoredProjectWorkflowSetting(cwd: string): string | undefined {
  const files = ['settings.json', 'settings.local.json'].map(name => join(cwd, '.gcode', name))
    .filter(file => { try { const value = JSON.parse(readFileSync(file, 'utf8')); return !!value && typeof value === 'object' && 'workflows' in value } catch { return false } })
  if (!files.length) return
  // In the home folder the project file is the personal one, which is read.
  const real = (file: string) => { try { return realpathSync(file) } catch { return file } }
  const personal = real(join(homedir(), '.gcode', 'settings.json'))
  const ignored = files.filter(file => real(file) !== personal)
  if (!ignored.length) return
  const shown = ignored.map(file => escapeDisplayControls(file)).join(' and ')
  return workflowSettings(cwd).enabled
    ? `"workflows" in ${shown} is ignored: workflow settings are read only from ~/.gcode/settings.json.`
    : `Workflow is off. "workflows" in ${shown} is ignored: only ~/.gcode/settings.json can turn it on (workflows.enabled: true).`
}

/** Writes the ignored-project-setting notice to stderr, once per project. */
export function warnIgnoredProjectWorkflowSetting(cwd: string): void {
  const notice = ignoredProjectWorkflowSetting(cwd)
  if (!notice || warned.has(`project:${notice}`)) return
  warned.add(`project:${notice}`)
  process.stderr.write(`[workflow] ${notice}\n`)
}
/** Execution authority and resource limits are user settings, never repository settings. */
export function workflowSettings(_cwd: string): WorkflowSettings {
  const warn = (reason: string) => {
    const key = `${file}:${reason}`
    if (!warned.has(key)) { warned.add(key); process.stderr.write(`[workflow] Invalid user settings: ${reason}. Using defaults for invalid entries.\n`) }
  }
  const defaults: WorkflowSettings = { enabled: false, concurrency: {}, maxIterations: 100 }
  const file = join(homedir(), '.gcode', 'settings.json')
  try {
    if (!existsSync(file)) return defaults
    const config = JSON.parse(readFileSync(file, 'utf8')).workflows
    if (config === undefined) return defaults
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('workflows must be an object')
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('workflows.enabled must be boolean')
    const result = { ...defaults, concurrency: {} as Record<string, number>, enabled: config.enabled === true }
    if (config.maxAgents !== undefined) {
      if (!Number.isSafeInteger(config.maxAgents) || config.maxAgents < 1 || config.maxAgents > 10000) warn('workflows.maxAgents must be between 1 and 10000')
      else (result as WorkflowSettings).maxAgents = config.maxAgents
    }
    if (config.maxIterations !== undefined) {
      if (!Number.isSafeInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 100) warn('workflows.maxIterations must be between 1 and 100')
      else result.maxIterations = config.maxIterations
    }
    if (config.concurrency !== undefined) {
      if (!config.concurrency || typeof config.concurrency !== 'object' || Array.isArray(config.concurrency)) warn('workflows.concurrency must be a provider map')
      else for (const [provider, value] of Object.entries(config.concurrency)) {
        if (!['local','ollama','anthropic','openai','gemini','deepseek','qwen'].includes(provider) || !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 256) warn(`workflows.concurrency.${provider} must be a known provider with an integer limit from 1 to 256`)
        else result.concurrency[provider] = Number(value)
      }
    }
    return result
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    return defaults
  }
}
