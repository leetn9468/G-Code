import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRule, PermissionRuleSource, ToolPermissionContext } from '../types.js'
import { emptyPermissionFile, parsePermissionRule, PERMISSIONS_MAX_BYTES, PERMISSIONS_MAX_RULES, type PermissionFile } from '../shared/permissionRules.js'
import { realTarget } from './scopedPermission.js'

type Warning = (message: string) => void
const warned = new Set<string>()
const caches = new Map<string, { stamp: string; data: PermissionFile }>()
const defaultWarning: Warning = message => process.stderr.write(`[permissions] ${message}\n`)
/** Why the last read refused the file (never its parse-error text, which can quote the file); undefined after a good read. */
let lastRefusal: string | undefined
const warnOnce = (message: string, warning: Warning) => { if (!warned.has(message)) { warned.add(message); warning(message) } }

export function permissionRule(rule: string, source: PermissionRuleSource, projectRoot?: string): PermissionRule {
  const parsed = parsePermissionRule(rule, !!projectRoot)
  if (!parsed) throw new Error(`Invalid permission rule ${JSON.stringify(rule.slice(0, 4096))}`)
  return { tool: parsed.tool, rule, source, ...(projectRoot ? { projectRoot } : {}) }
}

/** Read only the personal file; never follow a link or a special file, or expose parse-error text. */
export function readPermissionFile(warning: Warning = defaultWarning): PermissionFile {
  const folder = join(homedir(), '.gcode'), path = join(folder, 'permissions.json')
  const previous = caches.get(path)
  let stamp = 'missing'
  try {
    const parent = lstatSync(folder)
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('unsafe parent')
    const info = lstatSync(path, { bigint: true })
    stamp = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`
    if (previous?.stamp === stamp) { lastRefusal = undefined; return previous.data }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(PERMISSIONS_MAX_BYTES)) throw new Error('unsafe file')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let raw: string
    try {
      const file = fstatSync(fd, { bigint: true })
      if (!file.isFile() || file.nlink !== 1n || file.size > BigInt(PERMISSIONS_MAX_BYTES) || file.dev !== info.dev || file.ino !== info.ino) throw new Error('changed file')
      const bytes = Buffer.alloc(PERMISSIONS_MAX_BYTES + 1)
      let size = 0, next = 0
      do { next = readSync(fd, bytes, size, bytes.length - size, null); size += next } while (next && size < bytes.length)
      if (size > PERMISSIONS_MAX_BYTES) throw new Error('huge file')
      raw = bytes.subarray(0, size).toString('utf8')
    } finally { closeSync(fd) }
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid file')
    const object = value as Record<string, unknown>
    if (object.version !== 1 || !Array.isArray(object.allow) || !Array.isArray(object.deny) || !object.projects || typeof object.projects !== 'object' || Array.isArray(object.projects)) throw new Error('invalid file')
    const data = emptyPermissionFile()
    let count = 0
    const list = (input: unknown, project = false) => {
      if (!Array.isArray(input)) throw new Error('invalid list')
      count += input.length
      if (count > PERMISSIONS_MAX_RULES) throw new Error('too many rules')
      return input.filter((rule): rule is string => {
        if (parsePermissionRule(rule, project)) return true
        warnOnce(typeof rule === 'string' ? `Ignored malformed rule ${JSON.stringify(rule.slice(0, 4096))}.` : 'Ignored a non-string permission rule.', warning)
        return false
      })
    }
    data.allow = list(object.allow); data.deny = list(object.deny)
    const projects = Object.entries(object.projects)
    if (projects.length > PERMISSIONS_MAX_RULES) throw new Error('too many projects')
    for (const [root, entry] of projects) {
      if (!root.startsWith('/') || realTarget(root) !== root || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid project')
      const rules = entry as Record<string, unknown>
      data.projects[root] = { allow: list(rules.allow, true), deny: list(rules.deny, true) }
    }
    caches.set(path, { stamp, data })
    lastRefusal = undefined
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const data = emptyPermissionFile(); caches.set(path, { stamp: 'missing', data }); lastRefusal = undefined; return data
    }
    // A partially written or hostile file cannot erase the deny rules this process loaded. A new
    // process has none to keep: requireReadablePermissionFile stops it before it runs anything.
    lastRefusal = error instanceof SyntaxError ? 'it is not valid JSON' : (error as NodeJS.ErrnoException).code ? 'it could not be read' : 'it is a link, too large, or not in the expected form'
    warnOnce(previous ? 'Could not safely load ~/.gcode/permissions.json. This process keeps the rules it loaded last.' : 'Could not safely load ~/.gcode/permissions.json. No rules from it are applied.', warning)
    return previous?.data ?? emptyPermissionFile()
  }
}

/**
 * At the start of a process, before anything runs. Rules from a file that exists but cannot be
 * loaded would silently not apply (in Bypass, a denied command would run), and a new process has no
 * last valid rules to keep, so it stops here, naming the file. A ~/.gcode that is a symbolic link is
 * refused for personal data and warned about; it stops the process only when rules wait behind it.
 */
export function requireReadablePermissionFile(): void {
  const path = join(homedir(), '.gcode', 'permissions.json')
  const warnings: string[] = []
  readPermissionFile(message => warnings.push(message))
  if (lastRefusal) {
    let exists = true
    try { statSync(path) } catch (error) { exists = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    if (exists) throw new Error(`${path} could not be loaded: ${lastRefusal}. Its deny rules cannot be applied, so nothing was started. Fix or remove the file.`)
  }
  warnings.forEach(defaultWarning)
}

/** Reload at the permission boundary, including after an approval waited or a project changed. */
export function withUserPermissionRules(context: ToolPermissionContext, cwd?: string): ToolPermissionContext {
  if (!context.loadUserRules) return context
  const data = readPermissionFile()
  const root = cwd ? realTarget(cwd) : undefined
  const project = root ? data.projects[root] : undefined
  const combine = (key: 'allow' | 'deny', current: PermissionRule[]) => [
    ...current.filter(rule => rule.source !== 'settings' && rule.source !== 'project'),
    ...data[key].map(rule => permissionRule(rule, 'settings')),
    ...(project?.[key].map(rule => permissionRule(rule, 'project', root)) ?? []),
  ]
  return { ...context, alwaysAllowRules: combine('allow', context.alwaysAllowRules), alwaysDenyRules: combine('deny', context.alwaysDenyRules) }
}
