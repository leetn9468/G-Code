import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { getProjectDirectory } from '../state/store.js'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const exists = (path: string) => { try { lstatSync(path); return true } catch { return false } }

/** Resolve the nearest existing ancestor so symlinked parents cannot widen edit authority. */
export function isProjectPath(path: unknown, cwd?: string): boolean {
  if (typeof path !== 'string' || !path.trim() || !cwd || path.startsWith('~')) return false
  try {
    const root = realpathSync(cwd)
    const target = resolve(root, path)
    let ancestor = target
    while (!exists(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
    const resolved = resolve(realpathSync(ancestor), relative(ancestor, target))
    if (isGcodeSecret(resolved)) return false
    const rel = relative(root, resolved)
    return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
  } catch { return false }
}

/** Files G-Code itself generated for this project remain readable after moving
 * them outside the working tree. This does not grant access to other projects,
 * arbitrary personal files, directories, or a replaced store root. */
export function isPersonalOutput(path: string, cwd: string): boolean {
  try {
    const directory = join(realpathSync(homedir()), '.gcode', 'projects', basename(getProjectDirectory(cwd)))
    if (realpathSync(directory) !== directory) return false
    const target = realTarget(path)
    if (!target) return false
    const info = lstatSync(target)
    if (!info.isFile() || info.nlink !== 1) return false
    const name = relative(directory, target).split(sep).join('/')
    return /^outputs\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:snap|png|jpg)$/.test(name)
      || /^tool-output\/bash-[^/]{1,8}-\d+-[a-f0-9]{6}(?:-stderr)?\.txt$/.test(name)
  } catch { return false }
}

/** Deliberately small grammar: no shell substitutions, separators, redirects or optional executables. */
export function autoInspectionCommand(command: unknown): boolean {
  return typeof command === 'string' && /^(?:pwd|ls(?: -[alh]+)?|git (?:status(?: --short)?|diff(?: --stat)?|log -[1-9][0-9]? --oneline))$/.test(command.trim())
}

// ============================================================================
// Where a path really leads
// ============================================================================

/**
 * Where an absolute path really leads: the real path of its nearest existing ancestor, plus the
 * rest as written. Symlinks anywhere in the existing part are followed, a dangling one too (to the
 * file a write through it would create); undefined when even the root cannot be resolved.
 */
export function realTarget(path: string, hops = 0): string | undefined {
  try {
    if (!isAbsolute(path)) path = resolve(path)
    const split = (value: string) => value.split(process.platform === 'win32' ? /[\\/]/ : /\//)
    const root = parse(path).root
    let current = realpathSync(root)
    const pending = split(path.slice(root.length))
    // Resolve one component at a time: a link before '..' must be followed before going up.
    while (pending.length) {
      const part = pending.shift()!
      if (!part || part === '.') continue
      if (part === '..') { current = dirname(current); continue }
      const candidate = join(current, part)
      let stat
      try { stat = lstatSync(candidate) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        current = candidate
        continue
      }
      if (!stat.isSymbolicLink()) { current = candidate; continue }
      if (++hops > 40) return undefined
      const target = readlinkSync(candidate), targetRoot = parse(target).root
      if (targetRoot) current = realpathSync(targetRoot)
      pending.unshift(...split(target.slice(targetRoot.length)))
    }
    return current
  } catch { return undefined }
}

/** True when `path` is `root` or inside it (both real paths). */
export function withinPath(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export interface PathTarget {
  /** The real path the tool would reach. */
  resolved: string
  /** The project's real path. */
  root: string
  /** Inside the project, the project folder itself included. */
  inside: boolean
  /** Written inside the project, but a symbolic link leads out of it. */
  viaLink: boolean
  /** One of G-Code's own settings or key files (see isGcodeSecret). */
  secret: boolean
}

/** Where an absolute path (already resolved the way its tool resolves it) leads, relative to the project `cwd`. */
export function pathTarget(path: string, cwd: string): PathTarget {
  const root = realTarget(resolve(cwd)) ?? resolve(cwd)
  const resolved = realTarget(path) ?? path
  const inside = withinPath(resolved, root)
  // Written inside the project folder (through its own path or its real one), yet leading out of it.
  const viaLink = !inside && (withinPath(path, resolve(cwd)) || withinPath(path, root))
  return { resolved, root, inside, viaLink, secret: isGcodeSecret(resolved) }
}

// ============================================================================
// G-Code's own settings and key files
// ============================================================================

/** Entries of ~/.gcode that hold API keys or tokens: provider keys, MCP servers (with their auth), the MCP token cache. */
export const SECRET_ENTRIES = ['settings.json', 'settings.json.bak', 'permissions.json', 'mcp.json', 'auth', 'incidents'] as const
/** The desktop writes settings.json through a temporary file next to it. */
const SECRET_TEMP = /^\.gcode-(?:settings|permissions)-.*\.tmp$/

/** G-Code's own folder in the home directory (its real path when it exists). */
function gcodeHome(): string {
  const home = join(homedir(), '.gcode')
  return realTarget(home) ?? home
}

/** The real paths of G-Code's settings and key files, whether or not they exist yet. */
export function gcodeSecretPaths(): string[] {
  const home = gcodeHome()
  return SECRET_ENTRIES.map(name => realTarget(join(home, name)) ?? join(home, name))
}

/** macOS and Windows volumes ignore letter case by default, so ~/.gcode/MCP.json is mcp.json there, even before it exists. */
const foldCase = (path: string) => process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path

/** A file's identity (device and inode), the same for all its names; undefined for anything but an existing file. */
export function fileId(path: string): string | undefined {
  try { const file = statSync(path); return file.isFile() ? `${file.dev}:${file.ino}` : undefined } catch { return undefined }
}

/** The identities of G-Code's existing key files (the ones in ~/.gcode/auth included); `linkedOnly` keeps those with another name somewhere (a hard link). */
export function gcodeSecretIds(linkedOnly = false): Set<string> {
  const ids = new Set<string>()
  const add = (path: string) => { try { const file = statSync(path); if (file.isFile() && (!linkedOnly || file.nlink > 1)) ids.add(`${file.dev}:${file.ino}`) } catch { /* Not there. */ } }
  for (const secret of gcodeSecretPaths()) {
    add(secret)
    try { for (const name of readdirSync(secret, { recursive: true })) add(join(secret, String(name))) } catch { /* Not a folder. */ }
  }
  return ids
}

/**
 * True for G-Code's own settings and key files (~/.gcode/settings.json, ~/.gcode/mcp.json,
 * anything in ~/.gcode/auth) and for any other name of the same file (a hard link, a different
 * letter case). `resolved` is a real path (see realTarget).
 */
export function isGcodeSecret(resolved: string): boolean {
  const home = gcodeHome()
  if (foldCase(dirname(resolved)) === foldCase(home) && SECRET_TEMP.test(basename(resolved))) return true
  if (gcodeSecretPaths().some(secret => withinPath(foldCase(resolved), foldCase(secret)))) return true
  const id = fileId(resolved)
  return id !== undefined && gcodeSecretIds().has(id)
}

/** G-Code's settings and key files inside the real folder `root`, as paths relative to it with forward slashes. */
export function gcodeSecretsWithin(root: string): string[] {
  return gcodeSecretPaths().filter(secret => withinPath(secret, root) && secret !== root)
    .map(secret => relative(root, secret).split(sep).join('/'))
}

const globEscape = (text: string) => text.replace(/[\\*?[\]{}]/g, '\\$&')

/**
 * ripgrep exclusions for G-Code's settings and key files under the real folder `root`, anchored at
 * it (`!/…`): ripgrep run in that folder never reads them, whatever path and glob it was given.
 */
export function gcodeSecretGlobs(root: string): string[] {
  const globs = gcodeSecretsWithin(root).map(rel => `!/${globEscape(rel)}`)
  const home = gcodeHome()
  if (withinPath(home, root)) {
    const rel = relative(root, home).split(sep).join('/')
    globs.push(`!/${rel ? globEscape(rel) + '/' : ''}.gcode-settings-*.tmp`)
  }
  return globs
}

/**
 * A test for paths found while walking the folder `searchPath` (as written, not resolved): true for
 * G-Code's settings and key files, so a search never reads or lists them.
 */
export function gcodeSecretMatcher(searchPath: string): (path: string) => boolean {
  const root = realTarget(searchPath) ?? searchPath
  const secrets = gcodeSecretsWithin(root).map(rel => rel.split('/').join(sep))
  const home = gcodeHome()
  const homeRel = withinPath(home, root) ? relative(root, home) : undefined
  return (path: string) => {
    const rel = relative(searchPath, path)
    if (secrets.some(secret => rel === secret || rel.startsWith(secret + sep))) return true
    return homeRel !== undefined && relative(homeRel || '.', dirname(rel)) === '' && SECRET_TEMP.test(basename(rel))
  }
}

// ============================================================================
// Web hosts approved in this session
// ============================================================================

/** Hosts the user approved for WebFetch while this G-Code session (process) runs. */
const approvedWebHosts = new Set<string>()

export function approveWebHost(host: string): void { approvedWebHosts.add(host) }
export function isWebHostApproved(host: string): boolean { return approvedWebHosts.has(host) }
/** Tests only: start from a session with no approved hosts. */
export function forgetWebHosts(): void { approvedWebHosts.clear() }

export interface WebTarget {
  /** The URL fetched: http:// is upgraded to https://. */
  url: string
  /** Host name, with the port when it is not the default one. */
  host: string
  /** On this computer or a private network (loopback, link-local, private ranges, .local). */
  local: boolean
}

/** What WebFetch would contact for `url`; undefined for anything but an http or https URL. */
export function webTarget(url: unknown): WebTarget | undefined {
  if (typeof url !== 'string') return undefined
  const upgraded = url.startsWith('http://') ? 'https://' + url.slice(7) : url
  let parsed: URL
  try { parsed = new URL(upgraded) } catch { return undefined }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return undefined
  const host = parsed.host.toLowerCase()
  return { url: parsed.toString(), host, local: isLocalHost(parsed.hostname.toLowerCase()) }
}

function isLocalHost(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  if (name.includes(':')) {
    // An IPv4 address mapped into IPv6 (the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1).
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(name)
    if (mapped) {
      const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)]
      return isLocalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return name === '::1' || name === '::' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name)
  }
  return false
}

/** In-process incidental reads are subject to the same inode boundary as named file tools. */
export function assertToolFile(path: string): void {
  const target = realTarget(path) ?? resolve(path)
  if (isGcodeSecret(target)) throw new Error('Protected G-Code settings, credentials or incident evidence are unavailable to tools.')
}
