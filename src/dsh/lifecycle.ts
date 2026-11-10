import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Console } from 'node:console'

/** Install before importing plugin code. stdout is exclusively the MCP wire. */
export function ownPluginProcess() {
  const send = process.stdout.write.bind(process.stdout)
  const errorWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((...args: any[]) => (errorWrite as any)(...args)) as typeof process.stdout.write
  const logger = new Console({ stdout: process.stderr, stderr: process.stderr })
  for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert', 'time', 'timeEnd', 'timeLog', 'group', 'groupEnd'] as const) console[key] = (logger[key] as any).bind(logger)
  const children = new Set<childProcess.ChildProcess>()
  const track = (child: childProcess.ChildProcess) => { children.add(child); child.once('exit', () => children.delete(child)) }
  // Bun may retain a named `spawn` binding after syncBuiltinESMExports. Hook the
  // ChildProcess launch seam too, so those bindings cannot detach from the owner.
  const prototype = childProcess.ChildProcess.prototype as any
  const launch = prototype.spawn
  prototype.spawn = function(options: any) {
    options.detached = false
    if (options.stdio?.[1]?.type === 'fd' && options.stdio[1].fd === 1) options.stdio[1] = { ...options.stdio[1], fd: 2 }
    const result = launch.call(this, options)
    track(this)
    return result
  }
  const originalExec = childProcess.execFileSync.bind(childProcess)
  // Descendants stay in the bridge's group; an `inherit` stdout cannot corrupt JSON-RPC.
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    const original = childProcess[name] as Function
    ;(childProcess as any)[name] = (...args: any[]) => {
      let index = args.findIndex((arg, i) => i > 0 && arg && typeof arg === 'object' && !Array.isArray(arg))
      if (index < 0) { index = typeof args.at(-1) === 'function' ? args.length - 1 : args.length; args.splice(index, 0, {}) }
      const options = { ...args[index], detached: false }
      if (options.stdio === 'inherit') options.stdio = ['inherit', 2, 2]
      else if (Array.isArray(options.stdio)) options.stdio = options.stdio.map((fd: any, i: number) => i === 1 && (fd === 'inherit' || fd === 1 || fd === process.stdout) ? 2 : fd)
      args[index] = options
      const result = original(...args)
      if (result && typeof result.kill === 'function') track(result)
      return result
    }
  }
  syncBuiltinESMExports()
  const descendants = () => {
    const found = new Set<number>([process.pid])
    try {
      const rows = originalExec('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number))
      let changed = true
      while (changed) { changed = false; for (const [pid, parent] of rows) if (found.has(parent!) && !found.has(pid!)) { found.add(pid!); changed = true } }
    } catch { /* The MCP owner also kills the complete owned group. */ }
    found.delete(process.pid)
    for (const child of children) if (child.pid) found.add(child.pid)
    return found
  }
  return { send, descendants, kill(pids: Set<number>) {
    for (const pid of [...pids].reverse()) try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
  } }
}
