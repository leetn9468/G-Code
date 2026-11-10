import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { currentGuard } from '../security/guard.js'
import { nodeRuntimeRoot, resolveExecutable, toolEnv } from '../runtime/node.js'
import { parseDshSettings, type DshSettings } from './settings.js'
import core from './runtime-lock/package.json'

declare const GCODE_COMPILED_CLI: boolean | undefined
export const dshRuntimeDirectory = () => join(homedir(), '.gcode/dsh/runtime')
export function dshAssetDirectory(): string {
  return typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI
    ? resolve(dirname(process.execPath), '../dsh') : dirname(fileURLToPath(import.meta.url))
}
export const coreVersions: Record<string, string> = core.dependencies
export interface NpmCommand { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export type Installer = (command: NpmCommand) => Promise<void>

/** Release resources use node-runtime; the generated development payload uses node. */
export function dshNodeRuntimeRoot(candidate = nodeRuntimeRoot(), executable = process.execPath, compiled = typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI): string {
  if (existsSync(join(candidate, 'bin/node'))) return candidate
  if (compiled) {
    const checkout = resolve(dirname(executable), '../../node')
    if (existsSync(join(checkout, 'bin/node'))) return checkout
  }
  return candidate
}

export function npmExecutable(): { command: string; prefix: string[]; source: string } {
  const root = dshNodeRuntimeRoot(), node = join(root, 'bin/node'), npm = join(root, 'lib/node_modules/npm/bin/npm-cli.js')
  if (existsSync(node) && existsSync(npm)) return { command: node, prefix: [npm], source: 'G-Code built-in Node/npm' }
  const fallback = resolveExecutable(process.platform === 'win32' ? 'npm.cmd' : 'npm', toolEnv().PATH!)
  if (!fallback) throw new Error('npm is unavailable. Install Node/npm before installing DSH plugins.')
  return { command: fallback, prefix: [], source: 'PATH npm' }
}

/** The one npm of a running install, for a signal to stop it with. */
let npmChild: ChildProcess | undefined

const execute: Installer = ({ command, args, cwd, env }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  npmChild = child
  // npm says why it failed here and nowhere else; only the end of it is kept.
  let said = ''
  child.stderr?.on('data', chunk => { said = (said + String(chunk)).slice(-4000) })
  child.once('error', () => reject(new Error('Could not start npm.')))
  child.once('close', code => {
    npmChild = undefined
    if (code === 0) return resolve()
    const reason = said.split(/\r?\n/).map(line => line.replace(/^npm (?:ERR!|error)\s*/, '').trim()).filter(line => line && !/debug log|complete log/i.test(line)).slice(0, 3).join(' ')
    reject(new Error(`npm failed (exit ${code})${reason ? `: ${reason.slice(0, 500)}` : ''}.`))
  })
})

/** One install at a time per runtime: a second one is told so. A lock whose process is gone is taken over. */
function takeInstallLock(lock: string): void {
  try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let holder = 0
    try { holder = Number(readFileSync(join(lock, 'pid'), 'utf8')) } catch { /* Being written, or left half way. */ }
    let alive = holder > 0
    if (holder) try { process.kill(holder, 0) } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH' }
    if (alive) throw new Error('Another DSH install is running. Wait for it to finish.')
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock, { mode: 0o700 })
  }
  writeFileSync(join(lock, 'pid'), String(process.pid))
}

/**
 * Called only by an explicit user command/button, never by startup or a model tool. npm runs in a
 * folder beside the runtime, which replaces the old one only when everything has worked: no network,
 * a failed npm or a stop leaves a working runtime as it was.
 */
export async function install(settings: DshSettings, options: { execute?: Installer; guillotine?: boolean; directory?: string } = {}) {
  if (options.guillotine || currentGuard()) throw new Error('DSH installation is refused while Guillotine Mode is enabled: npm downloads require network access.')
  const issues: string[] = []
  const checked = parseDshSettings(settings, message => issues.push(message))
  if (issues.length) throw new Error(`Invalid DSH installation settings: ${issues.join('; ')}`)
  const directory = options.directory ?? dshRuntimeDirectory()
  const npm = npmExecutable()
  const parent = dirname(directory), name = basename(directory), lock = `${directory}.install-lock`, staging = `${directory}.installing-${process.pid}`
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  takeInstallLock(lock)
  const finish = () => { rmSync(staging, { recursive: true, force: true }); rmSync(lock, { recursive: true, force: true }) }
  // npm must not outlive the command, and what it leaves goes with it. It stays up for a while on a SIGTERM (measured over 800 ms), writing into the folder being removed.
  const stop = (signal: NodeJS.Signals) => { try { npmChild?.kill('SIGKILL') } catch { /* Gone. */ } finish(); process.exit(signal === 'SIGINT' ? 130 : 143) }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, stop)
  try {
    // What a process killed outright left behind. The lock says no other install is running.
    for (const entry of readdirSync(parent)) if (entry.startsWith(`${name}.installing-`) || entry.startsWith(`${name}.replaced-`)) rmSync(join(parent, entry), { recursive: true, force: true })
    mkdirSync(staging, { mode: 0o700 })
    for (const file of ['package.json', 'package-lock.json']) cpSync(join(dshAssetDirectory(), 'runtime-lock', file), join(staging, file))
    const env = toolEnv()
    // No project npmrc, preload modules, or credentials are needed for public registry packages.
    for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key]
    Object.assign(env, { npm_config_registry: 'https://registry.npmjs.org', npm_config_userconfig: process.platform === 'win32' ? 'NUL' : '/dev/null', npm_config_globalconfig: join(staging, '.gcode-empty-npmrc'), npm_config_update_notifier: 'false' })
    const flags = ['--ignore-scripts', '--no-audit', '--no-fund']
    const run = (args: string[]) => (options.execute ?? execute)({ command: npm.command, args: [...npm.prefix, ...args], cwd: staging, env })
    try {
      await run(['ci', ...flags])
      const installed: string[] = []
      for (const plugin of checked.plugins) if (plugin.package) {
        await run(['install', '--save-exact', ...flags, `${plugin.package}@${plugin.version}`])
        installed.push(`${plugin.package}@${plugin.version}`)
      }
      // npm said yes: what it made must be what the pins say, and a working runtime goes only for one that is.
      const made = status(checked, staging).state
      if (made === 'VERSION_MISMATCH' || made === 'NOT_INSTALLED' && existsSync(join(directory, 'node_modules'))) throw new Error('npm finished, but the runtime it made does not match the pinned versions.')
      const replaced = `${directory}.replaced-${process.pid}`
      const hadOne = existsSync(directory)
      if (hadOne) renameSync(directory, replaced)
      try { renameSync(staging, directory) } catch (error) { if (hadOne) renameSync(replaced, directory); throw error }
      if (hadOne) rmSync(replaced, { recursive: true, force: true })
      return { state: 'INSTALLED', directory, npm: npm.command, npmSource: npm.source, installed }
    } catch (error) {
      const left = existsSync(join(directory, 'node_modules')) ? 'The runtime that was installed is unchanged.' : 'The runtime is not ready.'
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${left} Run Install again.`)
    }
  } finally {
    for (const signal of signals) process.removeListener(signal, stop)
    finish()
  }
}

export function status(settings: DshSettings, directory = dshRuntimeDirectory()) {
  const version = (name: string): string | undefined => { try { return JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return undefined } }
  const core = Object.entries(coreVersions).map(([name, expected]) => ({ package: name, expected, installed: version(name) ?? null }))
  return {
    state: !existsSync(join(directory, 'node_modules')) ? 'NOT_INSTALLED' : core.every(p => p.expected === p.installed) ? 'READY' : 'VERSION_MISMATCH',
    directory, core,
    plugins: settings.plugins.map(plugin => ({ spec: plugin.package ?? plugin.path, expected: plugin.version ?? null, installed: plugin.package ? version(plugin.package) ?? null : null, state: !plugin.enabled ? 'DISABLED' : plugin.package && version(plugin.package) !== plugin.version ? 'NOT_INSTALLED' : 'READY' })),
  }
}
