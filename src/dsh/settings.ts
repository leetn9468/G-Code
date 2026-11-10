import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

import { defaultDshSettings, exactVersion, packageName, type DshPlugin, type DshSettings } from '../shared/dsh.js'
export { defaultDshSettings, exactVersion, packageName, pluginSpec, type DshPlugin, type DshSettings } from '../shared/dsh.js'
const warned = new Set<string>()
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Diagnostics describe the invalid field, never dump configuration or parser input. */
export function parseDshSettings(raw: unknown, warn: (message: string) => void = () => {}): DshSettings {
  const result = defaultDshSettings()
  if (raw === undefined) return result
  if (!object(raw)) { warn('dsh must be an object'); return result }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') warn('dsh.enabled must be boolean')
  else result.enabled = raw.enabled === true
  if (raw.toolTimeoutSeconds !== undefined) {
    if (Number.isInteger(raw.toolTimeoutSeconds) && Number(raw.toolTimeoutSeconds) >= 10 && Number(raw.toolTimeoutSeconds) <= 600) result.toolTimeoutSeconds = Number(raw.toolTimeoutSeconds)
    else warn('dsh.toolTimeoutSeconds must be an integer from 10 to 600')
  }
  if (raw.plugins === undefined) return result
  if (!Array.isArray(raw.plugins)) { warn('dsh.plugins must be an array'); return result }
  for (const [i, entry] of raw.plugins.entries()) {
    const reject = (reason: string) => warn(`dsh.plugins[${i}]: ${reason}; skipped`)
    if (!object(entry)) { reject('must be an object'); continue }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') { reject('enabled must be boolean'); continue }
    if (entry.config !== undefined && !object(entry.config)) { reject('config must be an object'); continue }
    const common = { enabled: entry.enabled !== false, config: entry.config as Record<string, unknown> ?? {} }
    if ('path' in entry) {
      if ('package' in entry || 'version' in entry) { reject('choose package/version or path'); continue }
      if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !['.js', '.mjs'].includes(extname(entry.path))) { reject('path must be an absolute .js or .mjs file'); continue }
      try { if (!statSync(entry.path).isFile()) throw new Error() } catch { reject('path must exist and be a file'); continue }
      result.plugins.push({ path: entry.path, ...common })
    } else if (!packageName(entry.package) || !exactVersion(entry.version)) reject('package must be an npm name and version an exact semver')
    else result.plugins.push({ package: entry.package, version: entry.version, ...common })
  }
  return result
}

/** User settings alone grant authority. Merely opening a repository cannot enable plugins. */
export function dshSettings(cwd: string, output: (message: string) => void = message => process.stderr.write(`[dsh] ${message}\n`)): DshSettings {
  const personal = join(homedir(), '.gcode', 'settings.json')
  const warn = (message: string) => { const key = `${personal}:${cwd}:${message}`; if (!warned.has(key)) { warned.add(key); output(message) } }
  const real = (file: string) => { try { return realpathSync(file) } catch { return file } }
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = join(cwd, '.gcode', name)
    if (real(file) === real(personal)) continue
    try { const value = JSON.parse(readFileSync(file, 'utf8')); if (object(value) && 'dsh' in value) warn('Project dsh settings are ignored; only ~/.gcode/settings.json can enable plugins.') } catch { /* Untrusted project settings never grant authority. */ }
  }
  try { return parseDshSettings(JSON.parse(readFileSync(personal, 'utf8'))?.dsh, warn) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('Cannot read user settings as JSON; DSH is disabled.'); return defaultDshSettings() }
}
