/**
 * @file commands.ts
 * @brief `gcode mcp …`: list, find, add, remove, enable, disable, test and sign in to the MCP servers
 *        in ~/.gcode/mcp.json. Nothing here starts a model session. Secrets (tokens, header values)
 *        are never printed.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { enableFirstAdvice, fillInAdvice, signInAdvice } from './surface.js'
import { networkSettings } from '../security/settings.js'
import { maskSecrets } from '../security/secretValues.js'
import { safeWriteFile, withWriteLock } from '../tools/impl/safeWrite.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { MCPClient } from './client.js'
import { loadConfigFile, mcpConfigPath, timeoutProblem, validateConfig } from './config.js'
import { forgetTokens, hasCachedLogin, loginOAuth } from './auth.js'
import { MCPAuthRequired } from './httpTransport.js'
import { findRegistryEntry, planServer, searchRegistry, type RegistryEntry } from './registry.js'
import type { MCPServerConfig } from './types.js'

export interface McpCommandOptions {
  json?: boolean; name?: string; remote?: boolean; url?: string; transport?: 'auto' | 'http' | 'sse'; command?: string
  arg?: string[]; env?: string[]; header?: string[]; bearerEnv?: string; apiKeyEnv?: string; apiKeyHeader?: string; oauth?: boolean
  clientId?: string; scope?: string; disabled?: boolean; guillotineMode?: boolean; networkGuard?: boolean
}

/** Server names become part of tool names (mcp__<server>__<tool>); "dsh" is the built-in bridge's. */
const NAME = /^[A-Za-z0-9_-]{1,32}$/
const print = (text: string): void => { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`) }

function readRaw(): Record<string, unknown> & { mcpServers: Record<string, Record<string, unknown>> } {
  const path = mcpConfigPath()
  if (!existsSync(path)) return { mcpServers: {} }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not a JSON object`)
  raw.mcpServers ??= {}
  return raw
}

/** Validates, then replaces mcp.json atomically with owner-only permissions (it may hold tokens), through a symlink if it is one. */
function writeRaw(config: Record<string, unknown>): void {
  validateConfig(config)
  const path = mcpConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  // safeWriteFile keeps a file's mode, and gives a new one what the umask leaves: owner-only either way.
  if (existsSync(path)) chmodSync(path, 0o600)
  const umask = process.umask(0o077)
  try { safeWriteFile(path, JSON.stringify(config, null, 2) + '\n') } finally { process.umask(umask) }
}

/** One change of mcp.json: processes take turns from the read to the rename, so none overwrites another's. */
const changeConfig = <T>(change: (config: ReturnType<typeof readRaw>) => T): Promise<T> => {
  mkdirSync(dirname(mcpConfigPath()), { recursive: true })
  return withWriteLock(mcpConfigPath(), () => change(readRaw()))
}

function server(name: string): MCPServerConfig {
  const found = loadConfigFile(mcpConfigPath()).mcpServers[name]
  if (!found) throw new Error(`No MCP server named "${name}" in ${mcpConfigPath()}.`)
  return { ...found, name }
}

/** What a server is, without its secrets. */
function describe(name: string, config: MCPServerConfig): Record<string, any> {
  return {
    name, enabled: config.enabled !== false, kind: config.url ? 'remote' : 'local',
    ...(config.timeoutSeconds === undefined ? {} : timeoutProblem(config.timeoutSeconds) ? { timeoutProblem: timeoutProblem(config.timeoutSeconds) } : { timeoutSeconds: config.timeoutSeconds }),
    ...(config.url ? { url: maskSecrets(config.url), transport: config.transport ?? 'auto', headers: Object.keys(config.headers ?? {}) } : { command: config.command, args: (config.args ?? []).map(maskSecrets), env: Object.keys(config.env ?? {}) }),
    ...(config.auth ? { auth: config.auth.type === 'oauth2' ? { type: 'oauth2', signedIn: hasCachedLogin({ ...config, name }), clientCredentials: !!(config.auth.clientSecret || config.auth.clientSecretEnv) } : { type: config.auth.type, tokenEnv: config.auth.tokenEnv, inline: !!config.auth.token } } : {}),
  }
}

function pairs(values: string[] | undefined, what: string): Record<string, string> | undefined {
  if (!values?.length) return
  return Object.fromEntries(values.map(value => {
    const at = value.indexOf('=')
    if (at < 1) throw new Error(`${what} must be NAME=VALUE: ${value}`)
    return [value.slice(0, at), value.slice(at + 1)]
  }))
}

/** Credentials to plain http on another computer: anyone on the way can read them. */
function clearTextCredentials(url: string, auth: boolean, headers: boolean): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'http:' && (auth || headers) && !(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))
  } catch { return false }
}

function registryLine(entry: RegistryEntry): string {
  const how = [...entry.packages.map(p => p.registryType), ...entry.remotes.map(r => `remote ${r.type}`)].join(', ') || 'no runnable package'
  return `${entry.name}${entry.version ? `@${entry.version}` : ''} — ${entry.description || '(no description)'} [${how}]`
}

function refuseUnderGuillotine(options: McpCommandOptions, action: string): void {
  const saved = networkSettings()
  if (saved.problem) throw new Error(saved.problem)
  if (options.guillotineMode || options.networkGuard || saved.settings.enabled) throw new Error(`Guillotine Mode is on: \`gcode mcp ${action}\` reaches the network and is refused. Turn Guillotine Mode off first.`)
}

export async function runMcpCommand(action: string, args: string[], options: McpCommandOptions): Promise<void> {
  try { await run(action, args, options) } catch (error) {
    process.stderr.write(`gcode mcp ${action}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

async function run(action: string, args: string[], options: McpCommandOptions): Promise<void> {
  if (action === 'list') {
    const servers = Object.entries(loadConfigFile(mcpConfigPath()).mcpServers).map(([name, config]) => describe(name, { ...config, name }))
    if (options.json) return print(JSON.stringify({ path: mcpConfigPath(), servers }))
    if (!servers.length) return print(`No MCP servers in ${mcpConfigPath()}. Find one with \`gcode mcp search <words>\`.`)
    for (const s of servers) print(`${s.name}: ${s.enabled ? 'enabled' : 'disabled'}, ${s.kind === 'remote' ? `${s.url} (${s.transport})` : [s.command, ...(s.args ?? [])].join(' ')}${s.auth ? `, auth ${s.auth.type}` : ''}${s.timeoutSeconds ? `, calls up to ${s.timeoutSeconds} s` : ''}${s.timeoutProblem ? ` (${s.timeoutProblem}; calls use the default)` : ''}`)
    return
  }
  if (action === 'search') {
    refuseUnderGuillotine(options, 'search')
    const found = await searchRegistry(args.join(' '))
    if (options.json) return print(JSON.stringify(found))
    if (found.source === 'built-in') print(`The official MCP Registry could not be reached (${found.error}); showing G-Code's built-in reference servers.`)
    if (!found.entries.length) return print('No servers found.')
    for (const entry of found.entries) print(registryLine(entry))
    return print('Add one with `gcode mcp add <name> <registry name>`.')
  }
  if (action === 'add') {
    const [name, registryName] = args
    if (!name || !NAME.test(name) || name.startsWith('-') || name === 'dsh' || name === '__proto__') throw new Error('The server name must be 1-32 letters, digits, "_" or "-", not start with "-", and not be "dsh" or "__proto__".')
    if (readRaw().mcpServers[name]) throw new Error(`An MCP server named "${name}" already exists; remove it first.`)
    let entry: Record<string, unknown>, missing: string[] = [], notes: string[] = []
    const fromRegistry = !options.url && !options.command
    if (options.url || options.command) {
      if (options.url && options.command) throw new Error('Give either --url (remote) or --command (local).')
      const auth = options.bearerEnv ? { type: 'bearer', tokenEnv: options.bearerEnv }
        : options.apiKeyEnv ? { type: 'api_key', tokenEnv: options.apiKeyEnv, ...(options.apiKeyHeader ? { headerName: options.apiKeyHeader } : {}) }
        : options.oauth ? { type: 'oauth2', ...(options.clientId ? { clientId: options.clientId } : {}), ...(options.scope ? { scope: options.scope } : {}) } : undefined
      entry = options.url
        ? { url: options.url, ...(options.transport ? { transport: options.transport } : {}), ...(pairs(options.header, '--header') ? { headers: pairs(options.header, '--header') } : {}), ...(auth ? { auth } : {}) }
        : { command: options.command, ...(options.arg?.length ? { args: options.arg } : {}), ...(pairs(options.env, '--env') ? { env: pairs(options.env, '--env') } : {}) }
      if (options.oauth) notes.push(`Sign in with \`gcode mcp login ${name}\`.`)
      if (options.url && clearTextCredentials(options.url, !!auth, !!options.header?.length)) notes.push(`Warning: ${new URL(options.url).origin} is plain http to another computer, so the credentials and headers of "${name}" travel unencrypted. Use https if the server has it.`)
    } else {
      if (!registryName) throw new Error('Give a registry name (see `gcode mcp search`), or --url / --command for your own server.')
      refuseUnderGuillotine(options, 'add')
      const found = await findRegistryEntry(registryName)
      if (!found) throw new Error(`No registry entry named "${registryName}". Search with \`gcode mcp search ${registryName}\`.`)
      const plan = planServer(found, name, options.remote ? 'remote' : 'local')
      if (!Object.keys(plan.config).length) throw new Error(plan.notes.join(' '))
      entry = plan.config; missing = plan.missing; notes = [...plan.notes, 'Registry entries are published by third parties: the server runs with your permissions. Check its source before enabling it.']
      const runs = typeof entry.command === 'string' ? [entry.command, ...(entry.args as string[] ?? [])].join(' ') : `the remote server ${String(entry.url)}`
      notes.push(`It will run: ${escapeDisplayControls(maskSecrets(runs))}`)
      if (!missing.length) notes.push(process.env.GCODE_DESKTOP === '1' ? 'It is disabled: nothing runs until you press Enable on it in Tools & MCP.' : `It is disabled: nothing runs until you enable it with \`gcode mcp enable ${name}\`, or Enable in the desktop's MCP servers list.`)
    }
    // A registry entry is someone else's command: it runs only once the user has seen it and said so.
    const enabled = !options.disabled && missing.length === 0 && !fromRegistry
    await changeConfig(config => {
      if (config.mcpServers[name]) throw new Error(`An MCP server named "${name}" already exists; remove it first.`)
      config.mcpServers[name] = { ...entry, enabled }
      writeRaw(config)
    })
    print(`Added MCP server "${name}" (${enabled ? 'enabled' : 'disabled'}) to ${mcpConfigPath()}.`)
    if (missing.length) print(`Fill in before enabling: ${missing.join('; ')}. ${fillInAdvice(name)}`)
    for (const note of notes) print(note)
    return print('New chats load the change.')
  }
  if (['remove', 'enable', 'disable'].includes(action)) {
    const [name] = args
    await changeConfig(config => {
      if (!name || !config.mcpServers[name]) throw new Error(`No MCP server named "${name ?? ''}" in ${mcpConfigPath()}.`)
      if (action === 'remove') { const removed = { ...config.mcpServers[name], name } as MCPServerConfig; delete config.mcpServers[name]; writeRaw(config); forgetTokens(removed) }
      else { config.mcpServers[name] = { ...config.mcpServers[name], enabled: action === 'enable' }; writeRaw(config) }
    })
    return print(`${action === 'remove' ? 'Removed' : action === 'enable' ? 'Enabled' : 'Disabled'} MCP server "${name}". New chats load the change.`)
  }
  if (action === 'test') {
    const target = server(args[0] ?? '')
    if (target.enabled === false) {
      const message = `"${target.name}" is disabled, so it was not started. ${enableFirstAdvice(target.name)}`
      if (!options.json) throw new Error(message)
      print(JSON.stringify({ status: 'disabled', error: message, tools: [] }))
      process.exitCode = 1
      return
    }
    if (target.url) refuseUnderGuillotine(options, 'test')
    const client = new MCPClient(target, { cwd: process.cwd(), requestTimeoutMs: 15_000 })
    try {
      await client.connect(AbortSignal.timeout(30_000))
      const skipped = client.skippedTools.map(tool => `${tool.name}: ${tool.reason}`)
      const result = { status: 'connected', tools: client.tools.map(t => t.name), resources: client.resources.length, prompts: client.prompts.map(p => p.name), ...(skipped.length ? { skipped } : {}) }
      if (options.json) print(JSON.stringify(result))
      else print(`"${target.name}" connected: ${result.tools.length} tool(s)${result.tools.length ? ` (${result.tools.join(', ')})` : ''}, ${result.resources} resource(s), ${result.prompts.length} prompt(s).${skipped.length ? ` Left out: ${escapeDisplayControls(skipped.join('; '))}.` : ''}`)
    } catch (error) {
      const message = error instanceof MCPAuthRequired ? `${error.message} ${signInAdvice(target.name)}` : error instanceof Error ? error.message : String(error)
      if (options.json) print(JSON.stringify({ status: 'error', error: message, tools: [] }))
      else throw new Error(message)
      process.exitCode = 1
    } finally { await client.disconnect() }
    return
  }
  if (action === 'login') {
    const target = server(args[0] ?? '')
    if (!target.url) throw new Error(`"${target.name}" is a local server; only remote servers sign in.`)
    refuseUnderGuillotine(options, 'login')
    await loginOAuth(target, { onUrl: url => print(`Opening your browser to sign in to "${target.name}". If it does not open, visit:\n${url}`) })
    return print(`Signed in to "${target.name}". New chats use the sign-in.`)
  }
  if (action === 'logout') {
    const target = server(args[0] ?? '')
    return print(forgetTokens(target) ? `Signed out of "${target.name}".` : `"${target.name}" had no saved sign-in.`)
  }
  throw new Error(`Unknown action "${action}".`)
}
