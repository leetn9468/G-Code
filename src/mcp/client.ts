import { currentGuard } from '../security/guard.js'
import { assertRuntimeLinks } from '../security/resources.js'
import { ensureIncidentRoot, assertIncidentLinks } from '../security/protection.js'
import { browserNodePath, browserRuntimeRoot } from '../browser/paths.js'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as trustedSpawn } from 'node:child_process'
import { guardedSpawn as spawn } from '../security/process.js'
/** Owned MCP stdio transport with capability negotiation and bounded shutdown. */
import { type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { toolEnv } from '../runtime/node.js'
import { endWatchdog, watchGroup } from '../utils/watchdog.js'
import { maskSecrets } from '../security/secretValues.js'
import type { MCPServerConfig, MCPServerConnection, MCPToolDefinition, MCPResourceDefinition, MCPPromptDefinition, MCPResourceContent } from './types.js'
import type { BridgeInput, BridgeStatus } from '../dsh/bridge.js'
import { MCPSessionExpired, MAX_MESSAGE_BYTES, connectRemote, timedOut, timedOutError, type RemoteTransport, type RequestLimit } from './httpTransport.js'
import { DEFAULT_CALL_TIMEOUT_SECONDS, timeoutProblem } from './config.js'
import { remoteHeaders } from './auth.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}
interface MCPClientOptions { cwd?: string; requestTimeoutMs?: number; dsh?: { bootstrap: BridgeInput; stderr?: (text: string) => void } }
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const INITIALIZE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'g-code', version: '0.1.0' } }
/** One message of a prompt (prompts/get): text, or another content block shown as JSON. */
export interface MCPPromptMessage { role: string; content: { type: string; text?: string; [key: string]: unknown } }
/** Connecting and listing, and any other request without a limit of its own. */
const CONNECT_TIMEOUT_SECONDS = 30
/** How long a server gets to answer a ping after a call timed out: one that cannot is stopped. */
const LIVENESS_WAIT_MS = 5000
/** Provider credentials G-Code reads from the environment; kept from every local server unless its own entry names one. */
const MODEL_KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY']

/** Only the exact bundled adapter with no injected environment is a browser exception. */
export function bundledBrowserMCP(config: MCPServerConfig): boolean {
  if (!config.command || config.env && Object.keys(config.env).length || config.args?.length !== 1) return false
  try { return realpathSync(config.command) === realpathSync(browserNodePath()) && realpathSync(config.args[0]!) === realpathSync(join(browserRuntimeRoot(), 'mcp.mjs')) } catch { return false }
}
export class MCPClient {
  private process: ChildProcess | null = null
  /** A remote server's transport (Streamable HTTP or HTTP+SSE); null for a local one. */
  private remote: RemoteTransport | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private disconnecting: Promise<void> | null = null
  private exitCleanup?: () => void
  private watchdog?: ChildProcess
  private reconnecting?: Promise<void>
  /** The tools as first connected: a restarted server must offer the same, since the model's list is fixed for the chat. */
  private frozenCatalog?: string
  private retired = false
  private restartNotice = false
  /** The end of a DSH bridge's stderr, for the message when it does not start. */
  private bridgeOutput = ''
  instructions?: string
  tools: MCPToolDefinition[] = []
  /** Tools the server listed that cannot be offered, and why. */
  skippedTools: Array<{ name: string; reason: string }> = []
  resources: MCPResourceDefinition[] = []
  prompts: MCPPromptDefinition[] = []
  status: MCPServerConnection['status'] = 'disconnected'
  error?: string

  constructor(private config: MCPServerConfig, private options: MCPClientOptions = {}) {}

  get builtInDsh(): boolean { return !!this.options.dsh }
  /** The server's configuration (`url` set for a remote server). */
  get server(): MCPServerConfig { return this.config }

  fresh(): MCPClient { return new MCPClient(this.config, this.options) }

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.process || this.remote || this.disconnecting) throw new Error('MCP client is already connected or shutting down')
    if (this.config.url) return this.connectRemote(signal)
    if (!this.config.command) throw new Error('MCP server has neither a command nor a url')
    const browser = bundledBrowserMCP(this.config)
    if (browser && currentGuard()) throw new Error('Guillotine Mode requires call-scoped tools. Use BrowserVerify instead of the stateful browser MCP adapter.')
    if (browser) { ensureIncidentRoot(); assertIncidentLinks(); assertRuntimeLinks() }
    const inherited = { ...process.env }
    // A server starts at chat start, before any approval, and has no use for G-Code's own model keys (src/llm/*.ts); one it needs is written in its own entry.
    for (const key of MODEL_KEY_ENV) delete inherited[key]
    const env = toolEnv({ ...inherited, ...this.config.env })
    if (this.options.dsh) for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', ...MODEL_KEY_ENV]) delete env[key]
    if (browser) for (const key of Object.keys(env)) if (key.startsWith('DYLD_') || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key]
    const child = (browser ? trustedSpawn : spawn)(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'], env,
      cwd: this.options.cwd, detached: process.platform !== 'win32', windowsHide: true,
    })
    this.process = child
    this.error = undefined
    // The exit hook below does not run when this process is SIGKILLed or crashes: a server that ignores the closed stdin, or a stuck plugin, would stay.
    const watchdog = process.platform !== 'win32' && child.pid ? watchGroup(child.pid) : undefined
    this.watchdog = watchdog
    const onParentExit = () => { this.killOwnedProcess(child, 'SIGKILL'); endWatchdog(watchdog) }
    this.exitCleanup = onParentExit
    process.once('exit', onParentExit)
    child.once('exit', () => {
      if (this.process === child) {
        this.process = null
        this.status = 'disconnected'
        this.rejectAll('MCP server exited')
      }
      this.killOwnedProcess(child, 'SIGKILL')
      endWatchdog(watchdog)
      process.removeListener('exit', onParentExit)
      if (this.exitCleanup === onParentExit) this.exitCleanup = undefined
    })
    child.once('error', (err) => {
      if (this.process !== child) return
      this.status = 'error'
      this.error = err.message
      this.rejectAll(err.message)
    })
    child.stdin?.on('error', (err) => {
      if (this.process === child) {
        this.rejectAll(`MCP stdin failed: ${err.message}`)
        void this.disconnect()
      }
    })
    // A noisy server must not deadlock after filling its stderr pipe.
    if (this.options.dsh) {
      this.bridgeOutput = ''
      child.stderr?.on('data', chunk => { this.bridgeOutput = (this.bridgeOutput + String(chunk)).slice(-2000); this.options.dsh?.stderr?.(String(chunk)) })
    } else child.stderr?.resume()
    if (child.stdout) this.readMessages(child.stdout, child)
    try {
      // Private bootstrap is not argv or an environment variable, and cannot be supplied by mcp.json.
      if (this.options.dsh) child.stdin!.write(JSON.stringify(this.options.dsh.bootstrap) + '\n')
      await this.handshake(await this.send('initialize', INITIALIZE, signal), signal)
      this.freezeCatalog()
      this.status = 'connected'
    } catch (err) {
      await this.disconnect()
      if (this.frozenCatalog !== undefined) this.tools = JSON.parse(this.frozenCatalog)
      this.status = 'error'
      this.error = err instanceof Error ? err.message : String(err)
      throw this.options.dsh && !this.error.startsWith('DSH tools changed') ? new Error(this.bridgeFailure(this.error)) : err
    }
  }

  /** A remote server: connect, initialize and list, then the same checks as a local server. */
  private async connectRemote(signal?: AbortSignal): Promise<void> {
    const server = this.config
    try {
      const { transport, result } = await connectRemote({
        url: server.url!, transport: server.transport ?? 'auto', timeoutMs: this.options.requestTimeoutMs ?? CONNECT_TIMEOUT_SECONDS * 1000,
        headers: headerSignal => remoteHeaders(server, headerSignal),
      }, INITIALIZE, signal)
      this.remote = transport
      this.error = undefined
      await this.handshake(result, signal)
      this.freezeCatalog()
      this.status = 'connected'
    } catch (err) {
      await this.disconnect()
      if (this.frozenCatalog !== undefined) this.tools = JSON.parse(this.frozenCatalog)
      this.status = 'error'
      this.error = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  private freezeCatalog(): void {
    const catalog = JSON.stringify(this.tools)
    if (this.frozenCatalog !== undefined && catalog !== this.frozenCatalog) throw new Error(this.options.dsh ? 'DSH tools changed; start a new session to refresh the frozen tools.' : `MCP server "${this.config.name}" changed its tools; start a new chat to use them.`)
    this.frozenCatalog ??= catalog
  }

  /** A bridge that did not start: what it said last (the plugin it was importing, a missing package) and what can help. */
  private bridgeFailure(reason: string): string {
    const said = this.bridgeOutput.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ')
    return `${reason.replace(/\.$/, '')}.${said ? ` Last bridge output: ${maskSecrets(said)}.` : ''} A plugin that stops the bridge takes the others with it: disable it to find which, and run \`gcode dsh install\` if the runtime is damaged.`
  }

  /** Checks the server's initialize result and lists its tools, resources and prompts. */
  private async handshake(result: unknown, signal?: AbortSignal): Promise<void> {
    const initialized = result as { protocolVersion?: string; capabilities?: Record<string, unknown>; instructions?: string } | undefined
    if (this.options.dsh) this.instructions = initialized?.instructions
    if (!initialized || !SUPPORTED_VERSIONS.has(initialized.protocolVersion ?? '') || !initialized.capabilities || typeof initialized.capabilities !== 'object') {
      throw new Error('MCP server returned an unsupported protocol version or invalid capabilities')
    }
    this.notify('notifications/initialized', {})
    this.tools = initialized.capabilities.tools ? await this.listAll<MCPToolDefinition>('tools/list', 'tools', signal) : []
    this.resources = initialized.capabilities.resources ? await this.listAll<MCPResourceDefinition>('resources/list', 'resources', signal) : []
    this.prompts = initialized.capabilities.prompts ? await this.listAll<MCPPromptDefinition>('prompts/list', 'prompts', signal) : []
    // One bad definition costs that tool, not the server and its other tools.
    const names = new Set<string>()
    this.skippedTools = []
    this.tools = this.tools.filter(tool => {
      const name = tool && typeof tool.name === 'string' && tool.name ? tool.name : undefined
      const problem = !name ? 'it has no name' : names.has(name) ? 'its name is used twice' : tool.inputSchema?.type !== 'object' ? 'its input schema is missing or not an object' : undefined
      if (problem) { this.skippedTools.push({ name: name ?? '(unnamed)', reason: problem }); return false }
      names.add(name!)
      tool.description ??= ''
      return true
    })
  }

  private async listAll<T>(method: string, key: string, signal?: AbortSignal): Promise<T[]> {
    const collected: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const result = await this.send(method, cursor ? { cursor } : {}, signal) as Record<string, unknown>
      if (!result || !Array.isArray(result[key])) throw new Error(`Invalid MCP ${method} response`)
      collected.push(...result[key] as T[])
      const next = result.nextCursor
      if (next !== undefined && (typeof next !== 'string' || !next || seen.has(next) || seen.size >= 100)) {
        throw new Error(`Invalid MCP pagination for ${method}`)
      }
      cursor = next as string | undefined
      if (cursor) seen.add(cursor)
    } while (cursor)
    return collected
  }

  /** Disconnects for good: this client will not start its server again (the chat is ending). */
  retire(): Promise<void> {
    this.retired = true
    return this.disconnect()
  }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting
    this.disconnecting = this.closeProcess().finally(() => { this.disconnecting = null })
    return this.disconnecting
  }

  private async closeProcess(): Promise<void> {
    const remote = this.remote
    this.remote = null
    if (remote) { this.status = 'disconnected'; this.rejectAll('MCP server disconnected'); await remote.close(); return }
    const child = this.process
    this.process = null
    this.status = 'disconnected'
    this.rejectAll('MCP server disconnected')
    if (!child) return
    const onParentExit = this.exitCleanup
    child.stdin?.end()
    if (this.options.dsh) child.kill('SIGTERM') // Give the root Context its bounded dispose phase first.
    else this.killOwnedProcess(child, 'SIGTERM')
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.removeListener('exit', finish)
          child.removeListener('error', finish)
          resolve()
        }
        const timer = setTimeout(() => { this.killOwnedProcess(child, 'SIGKILL'); finish() }, 500)
        child.once('exit', finish)
        child.once('error', finish)
      })
    }
    this.killOwnedProcess(child, 'SIGKILL')
    if (onParentExit) process.removeListener('exit', onParentExit)
    if (this.exitCleanup === onParentExit) this.exitCleanup = undefined
  }

  private killOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* owned process group has already exited */ }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.running(signal)
    return this.send('tools/call', { name, arguments: args }, signal, this.callLimit(DEFAULT_CALL_TIMEOUT_SECONDS))
  }

  dshStatus(signal?: AbortSignal): Promise<BridgeStatus> {
    if (!this.options.dsh) return Promise.reject(new Error('Not a built-in DSH bridge'))
    return this.send('dsh/status', {}, signal) as Promise<BridgeStatus>
  }

  /**
   * A request made while the chat uses the server: the entry's "timeoutSeconds" (a bad value counts as
   * not set: initMCP says so), else `fallback`. An explicit requestTimeoutMs (the DSH bridge's own
   * setting, `gcode mcp test`) applies to everything and is not changed in mcp.json, so no hint.
   */
  private callLimit(fallback: number): RequestLimit | undefined {
    if (this.options.requestTimeoutMs !== undefined) return undefined
    const seconds = this.config.timeoutSeconds !== undefined && !timeoutProblem(this.config.timeoutSeconds) ? this.config.timeoutSeconds : fallback
    return { timeoutMs: seconds * 1000, hint: `The limit for this server is ${seconds} seconds. To change it, set "timeoutSeconds" in the entry for ${JSON.stringify(this.config.name)} in ~/.gcode/mcp.json.` }
  }

  /**
   * A server that stopped mid-chat (a crash, a call the user stopped, a dropped stream) is started again
   * for the next call, as long as it offers the same tools. A call that may have run is never sent twice.
   */
  private async running(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.remote?.closed && !this.reconnecting) await this.disconnect()
    if (this.status === 'connected' || this.retired || this.frozenCatalog === undefined) return
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        await this.disconnecting
        try { await this.connect(signal) } catch (error) {
          if (this.options.dsh) throw error
          throw new Error(`MCP server "${this.config.name}" is not running and could not be started again: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.restartNotice = true
      })().finally(() => { this.reconnecting = undefined })
    }
    await this.reconnecting
  }

  /** True once after the server was started again, for what the next result tells the model. */
  takeRestartNotice(): boolean {
    const notice = this.restartNotice && !this.options.dsh
    this.restartNotice = false
    return notice
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<MCPResourceContent[]> {
    await this.running(signal)
    const result = await this.send('resources/read', { uri }, signal, this.callLimit(CONNECT_TIMEOUT_SECONDS)) as { contents?: MCPResourceContent[] }
    if (!Array.isArray(result?.contents)) throw new Error('The MCP server sent an invalid result for resources/read.')
    return result.contents
  }

  async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
    await this.running(signal)
    const result = await this.send('prompts/get', { name, arguments: args ?? {} }, signal, this.callLimit(CONNECT_TIMEOUT_SECONDS)) as { description?: string; messages?: MCPPromptMessage[] }
    if (!Array.isArray(result?.messages)) throw new Error('The MCP server sent an invalid result for prompts/get.')
    return { description: typeof result.description === 'string' ? result.description : undefined, messages: result.messages }
  }

  private send(method: string, params: Record<string, unknown>, signal?: AbortSignal, limit?: RequestLimit): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error(`MCP request aborted: ${method}`))
    if (this.remote) return this.sendRemote(this.remote, method, params, signal, limit)
    const child = this.process
    if (!child?.stdin || child.stdin.destroyed) return Promise.reject(new Error('MCP server not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const stop = (reason: Error) => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.cleanup()
        this.notify('notifications/cancelled', { requestId: id, reason: reason.message })
        // A call the user stopped does not go on in the background; nor does any request of the DSH bridge, which ends on a cancel itself.
        void this.disconnect().finally(() => reject(reason))
      }
      const onAbort = () => stop(new Error(`MCP request aborted: ${method}`))
      const onTimeout = () => {
        // One slow call is no reason to end a healthy server and every other tool of it. It is asked to
        // cancel; a server that no longer answers a ping is stopped. During connect, the catch there stops it.
        if (this.options.dsh || this.status !== 'connected') return stop(timedOut(method, limit?.hint))
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.cleanup()
        this.notify('notifications/cancelled', { requestId: id, reason: `MCP request timed out: ${method}` })
        reject(timedOut(method, limit?.hint))
        this.stopIfSilent(child)
      }
      const timer = setTimeout(onTimeout, limit?.timeoutMs ?? this.options.requestTimeoutMs ?? CONNECT_TIMEOUT_SECONDS * 1000)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) stop(new Error(`MCP write failed: ${error.message}`))
      })
      if (signal?.aborted) onAbort()
    })
  }

  /** The spec's answer to a 404 on a session: a new session. The server has no such session, so the request did not run, and goes once more. */
  private async sendRemote(remote: RemoteTransport, method: string, params: Record<string, unknown>, signal?: AbortSignal, limit?: RequestLimit): Promise<unknown> {
    try { return await remote.request(method, params, signal, limit) } catch (error) {
      if (limit && timedOutError(error)) this.dropIfSilent(remote)
      // The handshake of a new attempt, on the transport it just made: that attempt has failed, and starting another here would wait for itself.
      if (!(error instanceof MCPSessionExpired) || this.remote === remote && this.status !== 'connected') throw error
    }
    if (this.remote === remote) await this.disconnect()
    await this.running(signal)
    if (!this.remote) throw new Error('MCP session expired, and no new one could be started.')
    return this.remote.request(method, params, signal, limit)
  }

  /**
   * The HTTP+SSE stream carries every reply and may stay silent for hours, so a connection that died
   * without closing shows only as a call with no answer. As on stdio: a server that cannot answer a
   * ping either is dropped, and the next call connects again. An error reply is still an answer.
   */
  private dropIfSilent(remote: RemoteTransport): void {
    if (remote.kind !== 'sse' || this.status !== 'connected') return
    void remote.request('ping', {}, undefined, { timeoutMs: LIVENESS_WAIT_MS }).catch(error => {
      if (!String(error).includes('MCP error:') && this.remote === remote) void this.disconnect()
    })
  }

  private stopIfSilent(child: ChildProcess): void {
    const id = this.nextId++
    const timer = setTimeout(() => {
      this.pending.delete(id)
      if (this.process === child) void this.disconnect()
    }, LIVENESS_WAIT_MS)
    const alive = () => {}
    this.pending.set(id, { resolve: alive, reject: alive, cleanup: () => clearTimeout(timer) })
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n', () => {})
  }

  /** stdout as one JSON message per line, up to the size the remote transports allow: past it the server is stopped before it can use up this process's memory. */
  private readMessages(stdout: Readable, child: ChildProcess): void {
    let parts: Buffer[] = [], size = 0
    const overrun = () => {
      parts = []; size = 0
      if (this.process !== child) return
      this.error = 'MCP server sent a message larger than 32 MB, so G-Code stopped it.'
      this.rejectAll(this.error)
      void this.disconnect()
    }
    stdout.on('data', (chunk: Buffer) => {
      let start = 0
      while (this.process === child) {
        const newline = chunk.indexOf(10, start)
        const piece = chunk.subarray(start, newline < 0 ? chunk.length : newline)
        if (size + piece.length > MAX_MESSAGE_BYTES) return overrun()
        if (newline < 0) { if (piece.length) { parts.push(piece); size += piece.length } return }
        const line = parts.length ? Buffer.concat([...parts, piece], size + piece.length) : piece
        parts = []; size = 0
        start = newline + 1
        this.handleLine(line.toString('utf8'))
      }
    })
    // A last line with no newline, as a line reader gives it.
    stdout.once('end', () => { if (this.process === child && parts.length) this.handleLine(Buffer.concat(parts, size).toString('utf8')) })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.remote) { void this.remote.notify(method, params); return }
    this.process?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', () => {})
  }

  private handleLine(line: string): void {
    let response: Record<string, any>
    try { response = JSON.parse(line) } catch { return }
    if (!response || typeof response !== 'object' || !('id' in response)) return
    if (typeof response.method === 'string') {
      const reply = response.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client capability not supported' } }
      this.process?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: response.id, ...reply }) + '\n', () => {})
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.cleanup()
    if (response.error) pending.reject(new Error(`MCP error: ${typeof response.error.message === 'string' && response.error.message ? response.error.message : 'unknown error'}`))
    else pending.resolve(response.result)
  }

  private rejectAll(reason: string): void {
    for (const request of this.pending.values()) { request.cleanup(); request.reject(new Error(reason)) }
    this.pending.clear()
  }

  getConnection(): MCPServerConnection {
    return { config: this.config, tools: this.tools, resources: this.resources, status: this.status, error: this.error }
  }
}
