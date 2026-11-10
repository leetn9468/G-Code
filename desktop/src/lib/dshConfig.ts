import { defaultDshSettings, exactVersion, packageName, type DshPlugin, type DshSettings } from '../../../src/shared/dsh'
export { defaultDshSettings, exactVersion, packageName, type DshPlugin, type DshSettings }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const localPluginPath = (value: unknown): value is string => typeof value === 'string' && /^(?:\/|[a-zA-Z]:[\\/]).*\.(?:mjs|js)$/.test(value)

/** Refuse malformed settings rather than silently deleting entries during a UI edit. */
export function editableDshSettings(raw: unknown): DshSettings {
  if (raw === undefined || raw === null) return defaultDshSettings()
  const invalid = () => { throw new Error('Invalid DSH configuration. Correct the dsh key in ~/.gcode/settings.json before editing it here.') }
  if (!object(raw)) return invalid()
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return invalid()
  const timeout = raw.toolTimeoutSeconds ?? 60
  if (!Number.isInteger(timeout) || Number(timeout) < 10 || Number(timeout) > 600) return invalid()
  if (raw.plugins !== undefined && !Array.isArray(raw.plugins)) return invalid()
  const plugins = ((raw.plugins ?? []) as unknown[]).map(entry => {
    if (!object(entry) || entry.enabled !== undefined && typeof entry.enabled !== 'boolean' || entry.config !== undefined && !object(entry.config)) return invalid()
    if ('path' in entry ? !localPluginPath(entry.path) || 'package' in entry || 'version' in entry : !packageName(entry.package) || !exactVersion(entry.version)) return invalid()
    return { ...entry, enabled: entry.enabled !== false, config: entry.config ?? {} } as DshPlugin
  })
  return { ...raw, enabled: raw.enabled === true, toolTimeoutSeconds: Number(timeout), plugins }
}

export interface DshProbe {
  enabled: boolean
  state: string
  error?: string
  plugins: Array<{ spec: string; state: string; missing?: string[]; error?: string; tools?: string[]; warnings?: string[] }>
  runtime?: { plugins: Array<{ spec: string; expected: string | null; state: string }> }
}
/** The CLI skips malformed/missing files, so result offsets are not UI offsets. */
export function probeForPlugin(plugins: DshPlugin[], index: number, result: DshProbe | null): DshProbe['plugins'][number] | undefined {
  if (!result) return undefined
  const plugin = plugins[index]!, spec = plugin.package ?? plugin.path
  const occurrence = plugins.slice(0, index).filter(item => (item.package ?? item.path) === spec).length
  const record = result.plugins.filter(item => item.spec === spec)[occurrence]
  const sameVersionOccurrence = plugins.slice(0, index).filter(item => (item.package ?? item.path) === spec && item.version === plugin.version).length
  const runtime = result.runtime?.plugins.filter(item => item.spec === spec && item.expected === (plugin.version ?? null))[sameVersionOccurrence]
  if (runtime?.state === 'NOT_INSTALLED') return { spec, state: 'NOT_INSTALLED' }
  return record ?? { spec, state: 'FAILED', error: 'Plugin was skipped. Check its file path and configuration.' }
}
export function pluginStatus(plugin: DshPlugin, enabled: boolean, probe?: DshProbe['plugins'][number]): string {
  if (!enabled || !plugin.enabled) return 'Disabled'
  if (!probe) return 'Not checked'
  switch (probe.state) {
    case 'ACTIVE': return 'Active'
    case 'PENDING': return `Waiting for services: ${probe.missing?.join(', ') || 'unknown'}`
    case 'FAILED': case 'IMPORT_FAILED': return `Failed: ${(probe.error || 'Plugin failed').split(/[\r\n]/)[0]}`
    case 'NOT_INSTALLED': return 'Not installed'
    case 'DISABLED': return 'Disabled'
    default: return 'Not checked'
  }
}
