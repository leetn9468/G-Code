/**
 * @file registry.ts
 * @brief Finding MCP servers: the official MCP Registry (registry.modelcontextprotocol.io), with a
 *        small built-in list of the maintained reference servers when the registry cannot be reached,
 *        and turning an entry into a ~/.gcode/mcp.json server.
 */

import { signInAdvice } from './surface.js'
import { guardedFetch } from '../security/guard.js'
import { connectionSignal, readLimited } from './httpTransport.js'

export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io'
/** A page of at most 50 entries is far below this. */
const REGISTRY_BODY_BYTES = 8 * 1024 * 1024

export interface RegistryVariable { name: string; description?: string; required: boolean; secret: boolean; default?: string }
export interface RegistryPackage { registryType: string; identifier: string; version?: string; runtimeHint?: string; runtimeArguments: string[]; packageArguments: string[]; environmentVariables: RegistryVariable[] }
export interface RegistryRemote { type: 'streamable-http' | 'sse'; url: string; headers: RegistryVariable[] }
export interface RegistryEntry { name: string; description: string; version?: string; repository?: string; packages: RegistryPackage[]; remotes: RegistryRemote[] }

/** Maintained reference servers (github.com/modelcontextprotocol/servers), used when the registry is unreachable. */
const BUILT_IN: RegistryEntry[] = [
  ['filesystem', 'npm', '@modelcontextprotocol/server-filesystem', 'Read and write files in the directories you pass as arguments', ['<allowed directory>']],
  ['memory', 'npm', '@modelcontextprotocol/server-memory', 'A knowledge-graph memory that persists across sessions', []],
  ['sequential-thinking', 'npm', '@modelcontextprotocol/server-sequential-thinking', 'Step-by-step problem solving through thought sequences', []],
  ['everything', 'npm', '@modelcontextprotocol/server-everything', 'Reference server exercising every MCP feature (for testing)', []],
  ['fetch', 'pypi', 'mcp-server-fetch', 'Fetch web pages and convert them to Markdown', []],
  ['git', 'pypi', 'mcp-server-git', 'Read, search and change Git repositories', []],
  ['time', 'pypi', 'mcp-server-time', 'Current time and time-zone conversions', []],
].map(([short, type, identifier, description, args]) => ({
  name: `io.github.modelcontextprotocol/${short}`, description: description as string, repository: 'https://github.com/modelcontextprotocol/servers',
  packages: [{ registryType: type as string, identifier: identifier as string, runtimeHint: type === 'npm' ? 'npx' : 'uvx', runtimeArguments: type === 'npm' ? ['-y'] : [], packageArguments: args as string[], environmentVariables: [] }],
  remotes: [],
}))

const variables = (raw: unknown): RegistryVariable[] => Array.isArray(raw) ? raw.filter(v => v && typeof v.name === 'string').map(v => ({
  name: v.name, description: typeof v.description === 'string' ? v.description : undefined, required: v.isRequired === true, secret: v.isSecret === true,
  default: typeof v.default === 'string' ? v.default : undefined,
})) : []
const argumentValues = (raw: unknown): string[] => Array.isArray(raw) ? raw.flatMap(a => {
  if (!a || typeof a !== 'object') return []
  const value = typeof a.value === 'string' ? a.value : typeof a.default === 'string' ? a.default : typeof a.valueHint === 'string' ? `<${a.valueHint}>` : undefined
  if (a.type === 'named' && typeof a.name === 'string') return value === undefined ? [a.name] : [a.name, value]
  return value === undefined ? [] : [value]
}) : []

/** One registry item ({ server, _meta } in the 2025-09 schema, or the bare server). */
export function parseRegistryItem(item: unknown): RegistryEntry | undefined {
  const server = (item && typeof item === 'object' && 'server' in item ? (item as { server: unknown }).server : item) as Record<string, any> | undefined
  if (!server || typeof server.name !== 'string') return
  const packages: RegistryPackage[] = Array.isArray(server.packages) ? server.packages.filter((p: any) => p && typeof p.identifier === 'string' && typeof p.registryType === 'string').map((p: any) => ({
    registryType: p.registryType, identifier: p.identifier, version: typeof p.version === 'string' ? p.version : undefined, runtimeHint: typeof p.runtimeHint === 'string' ? p.runtimeHint : undefined,
    runtimeArguments: argumentValues(p.runtimeArguments), packageArguments: argumentValues(p.packageArguments), environmentVariables: variables(p.environmentVariables),
  })) : []
  const remotes: RegistryRemote[] = Array.isArray(server.remotes) ? server.remotes.filter((r: any) => r && typeof r.url === 'string' && ['streamable-http', 'sse'].includes(r.type)).map((r: any) => ({ type: r.type, url: r.url, headers: variables(r.headers) })) : []
  return { name: server.name, description: typeof server.description === 'string' ? server.description : '', version: typeof server.version === 'string' ? server.version : undefined, repository: typeof server.repository?.url === 'string' ? server.repository.url : undefined, packages, remotes }
}

export interface RegistrySearch { entries: RegistryEntry[]; source: 'official' | 'built-in'; error?: string }

/** Searches the official registry (latest versions); on failure, the built-in list. */
export async function searchRegistry(query: string, options: { limit?: number; baseUrl?: string; timeoutMs?: number } = {}): Promise<RegistrySearch> {
  const url = new URL('/v0/servers', options.baseUrl ?? OFFICIAL_REGISTRY_URL)
  if (query) url.searchParams.set('search', query)
  url.searchParams.set('limit', String(options.limit ?? 20))
  url.searchParams.set('version', 'latest')
  const { connection: signal, release } = connectionSignal(AbortSignal.timeout(options.timeoutMs ?? 15_000))
  try {
    const response = await guardedFetch(url, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = JSON.parse(await readLimited(response, REGISTRY_BODY_BYTES, 'the registry sent more than 8 MB', signal)) as { servers?: unknown }
    if (body.servers !== undefined && !Array.isArray(body.servers)) throw new Error('the registry sent an invalid reply')
    const entries = ((body.servers ?? []) as unknown[]).map(parseRegistryItem).filter((entry): entry is RegistryEntry => !!entry)
    return { entries, source: 'official' }
  } catch (error) {
    const q = query.toLowerCase()
    return { entries: BUILT_IN.filter(e => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)), source: 'built-in', error: error instanceof Error ? error.message : String(error) }
  } finally { release() }
}

/** The exact entry by its registry name (or a built-in short name). */
export async function findRegistryEntry(name: string, options: { baseUrl?: string } = {}): Promise<RegistryEntry | undefined> {
  const found = await searchRegistry(name, { ...options, limit: 50 })
  const short = (entry: RegistryEntry) => entry.name.split('/').pop()
  return found.entries.find(entry => entry.name === name) ?? found.entries.find(entry => short(entry) === name)
}

export interface AddPlan {
  /** The mcp.json server object. */
  config: Record<string, unknown>
  /** Variables the user still has to fill in before enabling it (a registry entry is always added disabled). */
  missing: string[]
  notes: string[]
}

/** The registry schema's runtime hints. An entry cannot name any other program to run on the user's machine. */
const RUNTIME_HINTS = new Set(['npx', 'uvx', 'docker', 'dnx'])

const RUNNERS: Record<string, (p: RegistryPackage) => string[]> = {
  npm: p => [p.runtimeHint ?? 'npx', ...(p.runtimeArguments.length ? p.runtimeArguments : ['-y']), p.version ? `${p.identifier}@${p.version}` : p.identifier],
  pypi: p => [p.runtimeHint ?? 'uvx', ...p.runtimeArguments, p.version ? `${p.identifier}==${p.version}` : p.identifier],
  oci: p => [p.runtimeHint ?? 'docker', 'run', '-i', '--rm', ...p.runtimeArguments, p.version ? `${p.identifier}:${p.version}` : p.identifier],
}

/** How to configure an entry: a local package when one can run here, else its remote endpoint. */
export function planServer(entry: RegistryEntry, name: string, prefer: 'local' | 'remote' = 'local'): AddPlan {
  const local = entry.packages.find(p => RUNNERS[p.registryType])
  const remote = entry.remotes[0]
  const notes: string[] = []
  if (remote && (prefer === 'remote' || !local)) {
    const required = remote.headers.filter(h => h.required)
    const bearer = required.find(h => h.name.toLowerCase() === 'authorization')
    const config: Record<string, unknown> = { url: remote.url, transport: remote.type === 'sse' ? 'sse' : 'http' }
    const missing = required.filter(h => h !== bearer).map(h => `headers.${h.name}`)
    if (bearer) {
      const variable = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MCP_TOKEN`
      config.auth = { type: 'bearer', tokenEnv: variable }
      missing.push(`the environment variable ${variable} (its bearer token)`)
    } else notes.push(process.env.GCODE_DESKTOP === '1' ? `If the server asks for a sign-in: ${signInAdvice(name)}` : `If the server asks for a sign-in, run \`gcode mcp login ${name}\`.`)
    const headers = required.filter(h => h !== bearer)
    if (headers.length) config.headers = Object.fromEntries(headers.map(h => [h.name, '']))
    return { config, missing, notes }
  }
  if (!local) return { config: {}, missing: [], notes: ['This entry has no package G-Code can run (npm, PyPI or OCI) and no remote endpoint.'] }
  if (local.runtimeHint !== undefined && !RUNTIME_HINTS.has(local.runtimeHint)) return { config: {}, missing: [], notes: [`This entry asks to run its package with ${JSON.stringify(local.runtimeHint)}, and G-Code only starts registry packages with ${[...RUNTIME_HINTS].join(', ')}. If you trust it, add it yourself with --command.`] }
  const [command, ...args] = RUNNERS[local.registryType]!(local)
  const placeholders = local.packageArguments.filter(a => /^<.+>$/.test(a))
  const env = Object.fromEntries(local.environmentVariables.filter(v => v.required || v.default !== undefined).map(v => [v.name, v.default ?? '']))
  const missing = [...local.environmentVariables.filter(v => v.required && v.default === undefined).map(v => `env.${v.name}`), ...placeholders.map(p => `args ${p}`)]
  if (local.registryType === 'pypi') notes.push('Needs uv (`uvx`) on your PATH.')
  if (local.registryType === 'oci') notes.push('Needs Docker.')
  return { config: { command, args: [...args, ...local.packageArguments], ...(Object.keys(env).length ? { env } : {}) }, missing, notes }
}
