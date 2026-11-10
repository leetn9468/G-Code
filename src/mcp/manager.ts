import { disableAdvice, signInAdvice } from './surface.js'
import { currentGuard, inGuardCall } from '../security/guard.js'
import { classifyNetwork, setMcpServerHosts } from '../security/classify.js'
/**
 * @file manager.ts
 * @brief MCP server manager — connects to all configured servers,
 *        discovers tools, and wraps them as G-Code tools.
 */

import { z } from 'zod'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import Ajv2019 from 'ajv/dist/2019.js'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tools/tool.js'
import { registerTool, unregisterTool, findTool } from '../tools/registry.js'
import type { MCPServerConfig, MCPToolDefinition } from './types.js'
import { MCPClient, bundledBrowserMCP, type MCPPromptMessage } from './client.js'
import { DEFAULT_CALL_TIMEOUT_SECONDS, loadMCPConfig, getEnabledServers, mcpConfigPath, timeoutProblem } from './config.js'
import { MCPAuthRequired } from './httpTransport.js'
import { dshSettings } from '../dsh/settings.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { maskSecrets } from '../security/secretValues.js'
import { IMAGE_REQUEST_RESERVE, checkImage } from '../llm/images.js'
import type { ImageBlock, VisionCapabilities } from '../llm/types.js'

// ============================================================================
// Manager State
// ============================================================================

const clients: MCPClient[] = []
const registeredNames = new Set<string>()
/** Each server's network destinations, for the Guillotine gate of its tools and resource reads. */
const serverHosts = new Map<string, string[]>()
setMcpServerHosts(server => serverHosts.get(server) ?? [])
/** A remote server's destination as the guard names it (host:port). */
const authority = (url: URL) => `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
let startupAbort: AbortController | undefined
export const MCP_STARTUP_TIMEOUT_MS = 60_000
/** What the model is told once per conversation about what is missing from this chat (the person sees the [mcp] lines). */
let modelNotices: string[] = []
export const mcpModelNotices = (): readonly string[] => modelNotices

/** One line for the person, on stderr (the desktop shows [mcp] lines in the chat). Text from a server or a tool's name stays inert. */
const tell = (text: string): void => { process.stderr.write(`[mcp] ${escapeDisplayControls(maskSecrets(text))}\n`) }
const short = (text: string, length = 400) => text.length > length ? `${text.slice(0, length)}…` : text

/** A server this chat goes without. Its tools were never registered, so nothing else changes. */
function serverUnavailable(name: string, error: unknown): void {
  const why = error instanceof MCPAuthRequired ? `${error.message} ${signInAdvice(name)}` : error instanceof Error ? error.message : String(error)
  tell(`Server ${JSON.stringify(name)} is not available in this chat, so its tools are missing: ${short(why)} Fix it and start a new chat, or ${disableAdvice(name)}.`)
  // The reason can be text the server sent: the person reads it, the model does not.
  modelNotices.push(`The MCP server ${JSON.stringify(name)} did not start for this chat, so its tools (mcp__${name}__*) are not available, even if earlier messages used them. The user has been told why. If the request needs them, say so.`)
}

/** A tool left out of an otherwise working server. */
function toolLeftOut(serverName: string, toolName: string, why: string): void {
  tell(`Server ${JSON.stringify(serverName)}: left out tool "${short(toolName, 120)}": ${short(why)} Its other tools work.`)
  const notice = `The MCP server ${JSON.stringify(serverName)} offers tools that were left out of this chat because they cannot be used here; the user has been told which.`
  if (!modelNotices.includes(notice)) modelNotices.push(notice)
}

/**
 * What the provider refuses in a tool's schema, in the words it refuses it with (the real API's HTTP 400
 * on tools.N.custom.input_schema). Such a tool would fail every request of every chat. Only Anthropic's
 * rules are known from its own answers; other providers are left to say so themselves.
 */
function schemaRefusal(schema: Record<string, unknown>, provider?: string): string | undefined {
  if (provider !== 'anthropic') return
  const union = ['oneOf', 'allOf', 'anyOf'].find(key => key in schema)
  if (union) return `its input schema has ${union} at the top level, which the provider refuses ("input_schema does not support oneOf, allOf, or anyOf at the top level").`
  const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : []
  const bad = properties.find(key => !/^[a-zA-Z0-9_.-]{1,64}$/.test(key))
  if (bad !== undefined) return `its input schema has the property ${short(JSON.stringify(bad), 80)}, and the provider refuses property names outside [a-zA-Z0-9_.-]{1,64}.`
}

/** A description past this is cut at registration: every request carries it, and every save of the chat. */
const DESCRIPTION_CHARS = 16_000

/**
 * Initialize MCP: load config, connect to all servers, register tools.
 */
export async function initMCP(cwd: string, verbose = false, options: { startupTimeoutMs?: number; provider?: string } = {}): Promise<number> {
  if (startupAbort || clients.length) throw new Error('MCP is already initialized or initializing')
  modelNotices = []
  let config: ReturnType<typeof loadMCPConfig>
  try { config = loadMCPConfig(cwd) } catch (error) {
    // Every project reads this one file: a broken one must not stop every chat.
    tell(`${short(error instanceof Error ? error.message : String(error))} No MCP servers are loaded in this chat. Fix ${mcpConfigPath()} and start a new chat.`)
    modelNotices.push('The MCP configuration could not be read, so no MCP servers are available in this chat, even if earlier messages used their tools. The user has been told why. If the request needs them, say so.')
    config = { mcpServers: {} }
  }
  const servers = getEnabledServers(config)
  const dsh = dshSettings(cwd)
  let builtInDsh: MCPClient | undefined
  if (dsh.enabled) {
    if (Object.hasOwn(config.mcpServers, 'dsh')) process.stderr.write('[dsh] Server name conflict: user mcp.json reserves "dsh"; built-in bridge skipped.\n')
    else try {
      const { createDshClient } = await import('../dsh/host.js')
      builtInDsh = createDshClient(dsh, cwd, verbose)
      servers.push(builtInDsh.getConnection().config)
    } catch (error) { process.stderr.write(`[dsh] Bridge unavailable: ${escapeDisplayControls(error instanceof Error ? error.message : String(error))}\n`) }
  }

  if (servers.length === 0) return 0

  let toolCount = 0
  const controller = new AbortController()
  startupAbort = controller
  const timeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS
  // Past the deadline the servers not reached yet are left out; a cancel (the chat is ending) stops everything.
  const deadline = new Error(`MCP initialization timed out after ${timeoutMs}ms across all configured servers`)
  const timer = setTimeout(() => controller.abort(deadline), timeoutMs)
  const pastDeadline = () => controller.signal.reason === deadline
  let serverName = ''
  try {
    for (const serverConfig of servers) {
      serverName = serverConfig.name
      if (pastDeadline()) { if (serverConfig !== builtInDsh?.getConnection().config) serverUnavailable(serverName, deadline); continue }
      controller.signal.throwIfAborted()
      if (currentGuard() && bundledBrowserMCP(serverConfig)) { process.stderr.write('[mcp] Stateful browser MCP is paused by Guillotine Mode. Use BrowserVerify for guarded browser checks.\n'); continue }
      // Guillotine Mode: a remote server is reached only when its host is on the user's allowlist;
      // discovery runs before any approval card could be shown.
      const remote = serverConfig.url ? new URL(serverConfig.url) : undefined
      if (remote && currentGuard() && !currentGuard()!.allowed(undefined, remote.hostname, Number(remote.port || (remote.protocol === 'https:' ? 443 : 80)))) {
        process.stderr.write(`[mcp] Remote server ${JSON.stringify(serverName)} is paused by Guillotine Mode. Add ${remote.host} to the Guillotine allowlist to use it.\n`)
        continue
      }
      const client = builtInDsh && serverConfig === builtInDsh.getConnection().config ? builtInDsh : new MCPClient(serverConfig, { cwd })
      const badTimeout = timeoutProblem(serverConfig.timeoutSeconds)
      if (badTimeout) tell(`Server ${JSON.stringify(serverName)}: ${badTimeout}, so its calls use the default of ${DEFAULT_CALL_TIMEOUT_SECONDS} seconds. Fix it in ${mcpConfigPath()}.`)
      const ownedDsh = client.builtInDsh
      const serverToolNames: string[] = []
      // Track connecting servers too, so shutdown can cancel initialization.
      clients.push(client)
      if (!ownedDsh) process.stderr.write(`[mcp] Connecting ${JSON.stringify(serverName)}…\n`)
      const guard = currentGuard()
      let discovery: Awaited<ReturnType<NonNullable<typeof guard>['call']>> | undefined
      const bridgeDeadline = ownedDsh ? new AbortController() : undefined
      const bridgeTimer = bridgeDeadline ? setTimeout(() => bridgeDeadline.abort(new Error('DSH bridge startup timed out')), 5000) : undefined
      try {
      discovery = guard ? await guard.call('MCP discovery', serverConfig.name, remote ? { url: serverConfig.url } : { command: serverConfig.command, args: serverConfig.args }, remote ? [authority(remote)] : []) : undefined
      await inGuardCall(guard, discovery, () => client.connect(bridgeDeadline ? AbortSignal.any([controller.signal, bridgeDeadline.signal]) : controller.signal))
      await guard?.fence()
      controller.signal.throwIfAborted()
      for (const skipped of client.skippedTools) toolLeftOut(serverConfig.name, skipped.name, `${skipped.reason}.`)
      const hosts = remote ? [authority(remote)] : classifyNetwork('Bash', { command: [serverConfig.command, ...(serverConfig.args ?? [])].join(' ') }, cwd).hosts
      serverHosts.set(serverConfig.name, hosts)
      for (const mcpTool of client.tools) {
        try {
        const refused = schemaRefusal(mcpTool.inputSchema, options.provider)
        if (refused) throw new Error(refused)
        const tool = wrapMCPTool(client, mcpTool, serverConfig.name, hosts)
        if (findTool(tool.name)) throw new Error(`MCP tool name is already registered: ${tool.name}`)
        registerTool(tool)
        registeredNames.add(tool.name)
        serverToolNames.push(tool.name)
        toolCount++
        } catch (error) {
          if (!ownedDsh) { toolLeftOut(serverConfig.name, mcpTool.name, error instanceof Error ? error.message : String(error)); continue }
          process.stderr.write(`[dsh] Skipped incompatible tool: ${escapeDisplayControls(error instanceof Error ? error.message : String(error))}\n`)
        }
      }
      if (ownedDsh) {
        process.stderr.write(`[dsh] ${escapeDisplayControls(client.instructions ?? `Connected (${client.tools.length} tools)`)}\n`)
        if (verbose) process.stderr.write(`[dsh] ${JSON.stringify(await client.dshStatus(controller.signal))}\n`)
      }
      if (guard) { await client.disconnect(); await guard.finishCall(discovery) }
      if (verbose) process.stderr.write(`[mcp] ${serverConfig.name}: connected (${client.tools.length} tools, ${client.resources.length} resources)\n`)
      } catch (error) {
        for (const name of serverToolNames) { unregisterTool(name); registeredNames.delete(name); toolCount-- }
        serverHosts.delete(serverConfig.name)
        await client.retire()
        const at = clients.indexOf(client)
        if (at >= 0) clients.splice(at, 1)
        // A network stop under Guillotine Mode ends the chat, as ever: it is not a server's failure.
        await guard?.check()
        await guard?.finishCall(discovery)
        if (controller.signal.aborted && !pastDeadline()) throw error
        if (ownedDsh) process.stderr.write(`[dsh] Bridge unavailable: ${escapeDisplayControls(error instanceof Error ? error.message : String(error))}\n`)
        else serverUnavailable(serverConfig.name, pastDeadline() ? deadline : error)
      } finally { clearTimeout(bridgeTimer) }
    }
    // Resources are read through two read-only tools, registered once any server has some.
    if (clients.some(client => client.resources.length)) {
      const { ListMcpResourcesTool, ReadMcpResourceTool } = await import('../tools/impl/McpResourceTools.js')
      for (const tool of [ListMcpResourcesTool, ReadMcpResourceTool]) if (!findTool(tool.name)) { registerTool(tool); registeredNames.add(tool.name); toolCount++ }
    }
    return toolCount
  } catch (err) {
    const failure = controller.signal.aborted ? controller.signal.reason : err
    const msg = failure instanceof Error ? failure.message : String(failure)
    await shutdownMCP()
    await currentGuard()?.check()
    throw new Error(`MCP server "${serverName}" failed to initialize: ${msg}`)
  } finally {
    clearTimeout(timer)
    if (startupAbort === controller) startupAbort = undefined
  }
}

/**
 * One prompt of a connected server, for a `/mcp__<server>__<prompt>` the user typed. Under Guillotine
 * Mode it is fetched over its own connection inside a guard call, as discovery is: the user ran it.
 */
export async function getMcpPrompt(server: string, name: string, args: Record<string, string>, signal?: AbortSignal): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
  const client = clients.find(candidate => candidate.server.name === server)
  if (!client) throw new Error(`No connected MCP server is named "${server}".`)
  const guard = currentGuard()
  if (!guard) return client.getPrompt(name, args, signal)
  const owned = client.fresh()
  const call = await guard.call('MCP prompt', server, { prompt: name, arguments: args }, serverHosts.get(server) ?? [])
  try {
    return await inGuardCall(guard, call, async () => { await owned.connect(signal); return owned.getPrompt(name, args, signal) })
  } finally { await owned.disconnect(); await guard.finishCall(call) }
}

/**
 * Disconnect all MCP servers and unregister their tools.
 */
export async function shutdownMCP(): Promise<void> {
  startupAbort?.abort(new Error('MCP initialization cancelled'))
  for (const name of registeredNames) unregisterTool(name)
  registeredNames.clear()
  serverHosts.clear()
  const disconnecting = clients.splice(0)
  await Promise.all(disconnecting.map((client) => client.retire()))
}

/**
 * Get all connected MCP clients.
 */
export function getMCPClients(): ReadonlyArray<MCPClient> {
  return clients
}

// ============================================================================
// MCP Tool Wrapper
// ============================================================================

type MCPCallResult = { content?: Array<{ type?: string; text?: string; data?: unknown; mimeType?: unknown; resource?: { uri?: string; text?: string; mimeType?: string; blob?: string }; uri?: string; name?: string }>; structuredContent?: unknown; isError?: boolean }

/** An image for the model, with the type its bytes show, or why it cannot be one. */
function imageForModel(data: string, vision: VisionCapabilities | undefined): ImageBlock | string {
  if (!vision) return 'the current model cannot receive images'
  try {
    const bytes = Buffer.from(data, 'base64'), info = checkImage(bytes, vision, { deep: true })
    const sent = bytes.toString('base64')
    if (sent.length + IMAGE_REQUEST_RESERVE > vision.maxRequestBytes) return "it is over the model's request limit by itself"
    return { type: 'image', source: { type: 'base64', media_type: info.mediaType, data: sent } }
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}

/** What a call's content comes to for the model: text, images it can take, and a true line for whatever it cannot see. */
function resultContent(result: MCPCallResult, vision: VisionCapabilities | undefined): { text: string; images: ImageBlock[] } {
  const lines: string[] = [], images: ImageBlock[] = []
  for (const item of result.content ?? []) {
    if (item?.type === 'text') { lines.push(item.text ?? ''); continue }
    const kind = typeof item?.mimeType === 'string' ? item.mimeType : item?.resource?.mimeType ?? item?.type ?? 'unknown content'
    const size = typeof item?.data === 'string' ? `, ${Math.floor(item.data.length * 3 / 4).toLocaleString('en-US')} bytes` : ''
    if (item?.type === 'image' && typeof item.data === 'string') {
      const image = imageForModel(item.data, vision)
      if (typeof image === 'string') lines.push(`[${kind}${size}, not shown: ${image}]`)
      else { images.push(image); lines.push(`[${kind}${size}, shown]`) }
    } else if (item?.type === 'resource' && typeof item.resource?.text === 'string') lines.push(`[resource ${item.resource.uri ?? ''}]\n${item.resource.text}`)
    else if (item?.type === 'resource_link') lines.push(`[resource link: ${item.uri ?? item.name ?? ''}]`)
    else lines.push(`[${kind}${size}, not shown]`)
  }
  return { text: lines.join('\n'), images }
}

function wrapMCPTool(
  client: MCPClient,
  mcpTool: MCPToolDefinition,
  serverName: string,
  networkHosts: string[] = [],
): Tool<Record<string, unknown>, unknown> {
  const toolName = `mcp__${serverName}__${mcpTool.name}`
  const dshPlugin = client.builtInDsh && typeof mcpTool._meta?.['gcode/dsh-plugin'] === 'string' ? mcpTool._meta['gcode/dsh-plugin'] : undefined
  const dshCatalog = client.builtInDsh ? JSON.stringify(client.tools) : undefined
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(toolName)) throw new Error(`MCP tool name is not compatible with model providers: ${toolName}`)
  const schema = mcpTool.inputSchema
  const validatorOptions = { allErrors: true, strict: false, validateFormats: false }
  const validator = String(schema.$schema ?? '').includes('2020-12') ? new Ajv2020(validatorOptions)
    : String(schema.$schema ?? '').includes('2019-09') ? new Ajv2019(validatorOptions) : new Ajv(validatorOptions)
  const validate = validator.compile(schema)
  if ((validate as { $async?: boolean }).$async) throw new Error(`Asynchronous input schemas are not supported: ${toolName}`)

  // The model's description is what the wrapper sends; a huge one costs every request and every save.
  const description = typeof mcpTool.description === 'string' && mcpTool.description.length > DESCRIPTION_CHARS
    ? `${mcpTool.description.slice(0, DESCRIPTION_CHARS)}… [description cut at ${DESCRIPTION_CHARS.toLocaleString('en-US')} characters of ${mcpTool.description.length.toLocaleString('en-US')}]` : mcpTool.description
  if (description !== mcpTool.description) tell(`Server ${JSON.stringify(serverName)}: tool ${JSON.stringify(mcpTool.name)} has a description of ${mcpTool.description.length.toLocaleString('en-US')} characters; only the first ${DESCRIPTION_CHARS.toLocaleString('en-US')} are sent.`)

  return {
    name: toolName,
    networkHosts,
    description,
    inputJsonSchema: schema,
    ...(mcpTool.annotations?.readOnlyHint === true ? { concurrencySafe: true } : {}),
    inputSchema: z.record(z.unknown()).superRefine((input, context) => {
      if (!validate(input)) context.addIssue({ code: z.ZodIssueCode.custom, message: validator.errorsText(validate.errors) })
    }),

    async call(input: Record<string, unknown>, context: ToolUseContext): Promise<ToolResult<unknown>> {
      const owned = currentGuard() ? client.fresh() : undefined
      try {
        if (owned) {
          await owned.connect(context.signal)
          if (dshCatalog !== undefined) {
            if (JSON.stringify(owned.tools) !== dshCatalog) throw new Error('DSH tools changed; start a new session to refresh the frozen tools.')
          } else if (JSON.stringify(owned.tools.find(t => t.name === mcpTool.name)?.inputSchema) !== JSON.stringify(mcpTool.inputSchema)) throw new Error('MCP tool schema changed; start a new session to refresh the frozen tools.')
        }
        const result = await (owned ?? client).callTool(mcpTool.name, input, context.signal) as MCPCallResult
        // Only an invalid shape: a result may have structured content and no list.
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.content !== undefined && !Array.isArray(result.content)) return { success: false, error: 'The MCP server sent an invalid result for this call.' }
        const restarted = client.takeRestartNotice() ? `[MCP server ${JSON.stringify(serverName)} was started again since its last call: anything it held in memory is gone.]\n` : ''
        const { text, images } = resultContent(result, context.vision)
        const output = restarted + (text || JSON.stringify(result.structuredContent ?? result.content ?? result))
        const artifacts = (result.structuredContent as { artifacts?: unknown } | undefined)?.artifacts
        if (Array.isArray(artifacts)) context.onArtifacts?.(artifacts.filter((path): path is string => typeof path === 'string'))
        // The built-in DSH executor already labels tool errors. The engine adds
        // that label once; preserve ordinary MCP servers' text verbatim.
        if (result.isError) return { success: false, error: client.builtInDsh ? output.replace(/^Error: /, '') : output }
        return { success: true, output, ...(images.length ? { contentBlocks: [{ type: 'text' as const, text: output }, ...images] } : {}) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      } finally { await owned?.disconnect() }
    },

    async checkPermissions(_input: Record<string, unknown>, _context: ToolUseContext): Promise<PermissionResult> {
      return { decision: 'ask', reason: dshPlugin ? `DSH plugin tool (${dshPlugin})` : `MCP tool from ${serverName}` }
    },

    prompt(): string {
      return `${toolName}: ${description} (via MCP server "${serverName}")${dshPlugin ? ` DSH plugin: ${dshPlugin}` : ''}`
    },
  }
}
