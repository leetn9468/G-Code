import { isAbsolute, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { isGcodeSecret, realTarget, withinPath } from '../session/scopedPermission.js'

export const providers: Readonly<Record<string, string>> = { fs: '@deepseek-ai/dsh-fs-local' }
export const unsupported = {
  // By the service names plugins inject (the pinned packages' own). userApproval is what the reserved approval plugin is reported as.
  userApproval: 'approval is handled by G-Code',
  approval: 'approval is handled by G-Code',
  jobs: 'ctx.jobs is not supported',
  'exec.agent.inject': 'exec.agent.inject is not supported; agent/session contexts are not supplied',
  agents: 'agent/session plugins are not supported',
  sessions: 'agent/session plugins are not supported',
  sessionProjections: 'agent/session plugins are not supported',
  llm: 'ctx.llm is not supported: G-Code owns the model calls',
  sandbox: 'ctx.sandbox is not supported: a plugin runs as local code with your permissions',
  ui: 'DSH UI plugins are not supported',
}

export function confinedPath(path: unknown, cwd: string, base = cwd): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('~')) throw new Error('DSH fs: invalid path')
  const root = realTarget(cwd)
  const written = isAbsolute(path) ? path : `${base}/${path}`
  // Preserve components until realTarget has followed links before any '..'.
  const target = realTarget(written)
  if (!root || !target || !(withinPath(resolve(written), root) || withinPath(resolve(written), resolve(cwd))) || !withinPath(target, root)) throw new Error('DSH fs: path is outside the project root (including symlink escape)')
  if (isGcodeSecret(target)) throw new Error('DSH fs: protected G-Code settings or credentials')
  return target
}

/** Wrap the public LocalFileSystem API before its instance is ever registered.
 * This is a capability boundary for ctx.fs, not an OS sandbox for arbitrary JS.
 * Unknown future methods cannot silently widen the pinned adapter's surface.
 */
export function confinedFileSystem(Base: any, cwd: string): any {
  const root = realTarget(cwd)
  if (!root) throw new Error('DSH fs: project root is unavailable')
  const target = (self: any, value: any) => confinedPath(Base.prototype.processPath.call(self, value), cwd)
  class ConfinedFileSystem extends Base {
    static inject = Base.inject
    static Config = Base.Config
    async resolve(path: string, options: any = {}) {
      const base = options.cwd === undefined ? root! : confinedPath(options.cwd, cwd)
      const safe = confinedPath(path, cwd, base)
      const resolved = await super.resolve(safe, { ...options, cwd: root })
      target(this, resolved)
      return Object.freeze(resolved)
    }
    lstat(path: string, options: any = {}, signal?: AbortSignal) {
      const base = options.cwd === undefined ? root! : confinedPath(options.cwd, cwd)
      confinedPath(path, cwd, base)
      // lstat must preserve the final symlink. Check both the original component
      // walk and the normalized spelling used by the pinned local backend.
      const lexical = resolve(base, path)
      confinedPath(lexical, cwd)
      return super.lstat(lexical, { ...options, cwd: root }, signal)
    }
    processPath(value: any) { return target(this, value) }
    processPathFromHostPath(path: string) { return confinedPath(path, cwd) }
    fileUrl(value: any) { target(this, value); return super.fileUrl(value) }
    contains(parent: any, child: any) { target(this, parent); target(this, child); return super.contains(parent, child) }
    // A recursive filesystem watcher can observe secrets or newly linked paths.
    watch() { throw new Error('DSH fs: watching is not supported in the project-confined provider') }
    async listDir(value: any, signal?: AbortSignal) {
      const directory = target(this, value)
      for (const name of readdirSync(directory)) confinedPath(`${directory}/${name}`, cwd)
      const entries = await super.listDir(value, signal)
      for (const entry of entries) target(this, entry.target)
      return entries
    }
  }
  for (const method of ['stat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'writeText', 'editText']) {
    Object.defineProperty(ConfinedFileSystem.prototype, method, { value: function(this: any, value: any, ...args: any[]) {
      target(this, value)
      return Base.prototype[method].call(this, value, ...args)
    } })
  }
  return ConfinedFileSystem
}
