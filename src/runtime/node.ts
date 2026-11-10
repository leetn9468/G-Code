import { guardedExecFileSync as execFileSync } from '../security/process.js'
/** Resolve the shared runtime relative to the source checkout or relocated app. */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const GCODE_COMPILED_CLI: boolean | undefined
declare const GCODE_BROWSER_WORKER: boolean | undefined

export function nodeRuntimeRoot(): string {
  if (typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI) return resolve(dirname(process.execPath), '../../node-runtime')
  const here = dirname(fileURLToPath(import.meta.url))
  if (typeof GCODE_BROWSER_WORKER !== 'undefined' && GCODE_BROWSER_WORKER) {
    const bundled = resolve(here, '../node-runtime')
    return existsSync(bundled) ? bundled : resolve(here, '../node')
  }
  const source = resolve(here, '../../desktop/runtime/node')
  return existsSync(source) ? source : resolve(here, '../desktop/runtime/node')
}

const NPM_DEFAULTS = { npm_config_yes: 'true', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_progress: 'false' }
/** GUI discovery happens in Rust. Headless commands retain their explicit PATH. */
export function toolEnv(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited }
  // It says this process's parent is the app (an end of input then means the app is gone); a tool's child is not in that position.
  delete env.GCODE_DESKTOP
  const bundled = join(nodeRuntimeRoot(), 'bin')
  const identity = (path: string) => { try { return realpathSync(path) } catch { return path } }
  const seen = new Set<string>()
  const paths = (env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(path => { const key = identity(path); if (seen.has(key)) return false; seen.add(key); return true })
  if (existsSync(join(bundled, 'node'))) env.PATH = [...paths.filter(path => identity(path) !== identity(bundled)), bundled].join(delimiter)
  else env.PATH = paths.join(delimiter)
  const set = new Set(Object.entries(env).filter(([, value]) => value !== undefined).map(([key]) => key.toLowerCase()))
  for (const [key, value] of Object.entries(NPM_DEFAULTS)) if (!set.has(key)) env[key] = value
  return env
}

export interface NodeEnvironment { version: string | null; npm: string | null; npx: string | null; path: string | null; builtIn: boolean }
export function resolveExecutable(command: string, path: string, cwd = process.cwd()): string | undefined {
  for (const directory of path.split(delimiter)) {
    const file = resolve(cwd, directory, command)
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file } } catch { /* Try the next PATH entry. */ }
  }
}
/** Only the caller caches this result, so new sessions can see a changed installation. */
export function nodeEnvironment(inherited: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): NodeEnvironment {
  const env = toolEnv(inherited)
  // Version probes never need user-provided preload modules. Shims still use cwd.
  delete env.NODE_OPTIONS; delete env.NODE_PATH
  const node = resolveExecutable('node', env.PATH!, cwd)
  let builtIn = false
  try { builtIn = !!node && realpathSync(node) === realpathSync(join(nodeRuntimeRoot(), 'bin/node')) } catch { /* Missing runtime. */ }
  // The first run of the built-in Node can wait on macOS, and killing it restarts that wait.
  const timeout = builtIn ? 30_000 : 2500
  const version = (file?: string): string | null => {
    if (!file) return null
    try {
      const text = execFileSync(file, ['--version'], { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(text) ? text : null
    } catch { return null }
  }
  return { version: version(node), npm: version(resolveExecutable('npm', env.PATH!, cwd)), npx: version(resolveExecutable('npx', env.PATH!, cwd)), path: node ? dirname(node) : null, builtIn }
}
export function nodeEnvironmentPrompt(info: NodeEnvironment): string {
  const location = info.builtIn ? 'G-Code built-in' : `system, ${info.path ?? 'unavailable'}`
  return `Node ${info.version ?? 'unavailable'}, npm ${info.npm ?? 'unavailable'}, npx ${info.npx ?? 'unavailable'} (${location})`
}
