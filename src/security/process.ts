import { spawn as rawSpawn, spawnSync as rawSpawnSync, execFileSync as rawExecFileSync, type SpawnOptions, type SpawnSyncOptions, type ExecFileSyncOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { currentCall, currentGuard, processIdentity, processAncestry, GUARD_PROXY_PORTS, type GuardCall, type NetworkGuard } from './guard.js'
import { assertIncidentLinks, ensureIncidentRoot, toolProfile } from './protection.js'

export function prepareToolProcess(argv: string[], env: NodeJS.ProcessEnv, cwd: string): { argv: string[]; env: NodeJS.ProcessEnv; call?: GuardCall; guard?: NetworkGuard } {
  const guard = currentGuard()
  // Without Guillotine Mode tools run unsandboxed, as before it existed: any Seatbelt profile stops
  // setuid tools (ps, top, sudo), and the baseline's Mach allowlist breaks Go TLS (gh, terraform).
  // The evidence folder stays refused by the file tools and by Bash's command check instead.
  if (!guard) return { argv, env }
  ensureIncidentRoot(); assertIncidentLinks()
  guard.assertReady(); guard.noteActivity()
  if (process.platform !== 'darwin') throw new Error('Seatbelt is unavailable.')
  // sandbox-exec becoming the outer executable must not turn an ENOENT into
  // a successful spawn of a wrapper. Search tools use that distinction to
  // select their built-in fallback when rg is absent from this call's PATH.
  const command = argv[0] ?? ''
  const candidates = command.includes('/') ? [resolve(cwd, command)]
    : (env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir, command))
  let executable: string | undefined
  for (const file of candidates) {
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); executable = file; break } } catch { /* Next PATH entry. */ }
  }
  if (!executable) throw Object.assign(new Error(`Executable not found: ${command}`), { code: 'ENOENT' })
  argv = [executable, ...argv.slice(1)]
  if (!existsSync('/usr/bin/sandbox-exec')) throw new Error('Tool refused: the incident filesystem sandbox is unavailable.')
  const call = currentCall() ?? { id: randomUUID(), name: 'Internal tool process', input: { argv, cwd }, grants: [], tag: `GCODE_GUARD_${randomUUID().replaceAll('-', '')}`, processes: [] }
  guard.calls.set(call.tag, call); guard.watchInStore(call.tag)
  const clean = { ...env }
  for (const key of Object.keys(clean)) if (/proxy$/i.test(key)) delete clean[key]
  if (call.proxy) {
    const proxy = `http://gcode:${call.proxy.secret}@127.0.0.1:${call.proxy.port}`
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) clean[name] = proxy
    for (const name of ['ALL_PROXY', 'all_proxy']) clean[name] = `socks5h://gcode:${call.proxy.secret}@127.0.0.1:${call.proxy.socksPort}`
  }
  clean.NO_PROXY = clean.no_proxy = 'localhost,127.0.0.1,::1'
  return { argv: ['/usr/bin/sandbox-exec', '-p', toolProfile(call.tag, true, [...guard.forbiddenPorts, ...GUARD_PROXY_PORTS], call.proxy ? [call.proxy.port, call.proxy.socksPort] : []), ...argv], env: clean, call, guard }
}
export function trackToolProcess(call: GuardCall | undefined, pid: number | undefined, argv: string[], cwd: string, trusted = false): void {
  if (call && pid) { const ancestry = processAncestry(pid); call.processes.push({ pid, argv, cwd, trusted, identity: ancestry[0]?.identity ?? processIdentity(pid), group: ancestry[0] ? ancestry[0].pgid === pid : true, ancestry, ancestryStatus: ancestry.length ? 'Observed by trusted ps at launch' : 'Process exited before ancestry could be observed' }) }
}
/** Only trusted engine monitor/watchdog/lock-owner checks and the browser worker are exempt. */
export const guardedSpawn: typeof rawSpawn = ((file: string, args: string[] = [], options: SpawnOptions = {}) => {
  if (options.shell) throw new Error('Tool shell bootstrap must be explicit sandboxed argv.')
  const cwd = String(options.cwd ?? process.cwd()), launch = prepareToolProcess([file, ...args], options.env ?? process.env, cwd)
  const child = rawSpawn(launch.argv[0]!, launch.argv.slice(1), { ...options, env: launch.env, detached: process.platform !== 'win32' })
  trackToolProcess(launch.call, child.pid, [file, ...args], cwd)
  return child
}) as typeof rawSpawn
export const guardedSpawnSync: typeof rawSpawnSync = ((file: string, args: string[] = [], options: SpawnSyncOptions = {}) => {
  if (options.shell) throw new Error('Tool shell bootstrap must be explicit sandboxed argv.')
  const cwd = String(options.cwd ?? process.cwd()), launch = prepareToolProcess([file, ...args], options.env ?? process.env, cwd)
  const result = rawSpawnSync(launch.argv[0]!, launch.argv.slice(1), { ...options, env: launch.env, ...{ detached: process.platform !== 'win32' } })
  trackToolProcess(launch.call, result.pid, [file, ...args], cwd)
  if (result.signal === 'SIGKILL' || result.status === 137) launch.guard?.noteKilled(result.pid)
  return result
}) as unknown as typeof rawSpawnSync
export const guardedExecFileSync: typeof rawExecFileSync = ((file: string, args: string[] = [], options: ExecFileSyncOptions = {}) => {
  if (options.shell) throw new Error('Tool shell bootstrap must be explicit sandboxed argv.')
  const result = guardedSpawnSync(file, args, options as SpawnSyncOptions)
  if (result.error) throw result.error
  if (result.status !== 0) throw Object.assign(new Error(`Command failed: ${file} (status ${result.status ?? result.signal})`), { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })
  return result.stdout
}) as typeof rawExecFileSync
export const guardedExecSync = (command: string, options: ExecFileSyncOptions = {}): any => guardedExecFileSync('/bin/sh', ['-c', command], options as any)
