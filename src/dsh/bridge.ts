/** Owned stdio DSH adapter. The first stdin line is private bootstrap JSON. */
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { confinedFileSystem, providers, unsupported } from './providers.js'
import { ownPluginProcess } from './lifecycle.js'
import { pluginSpec, type DshPlugin } from './settings.js'

export interface BridgeInput { runtime: string; cwd: string; plugins: DshPlugin[]; toolTimeoutSeconds: number; providers?: string[] }
type State = 'ACTIVE' | 'PENDING' | 'FAILED' | 'IMPORT_FAILED' | 'DISABLED'
export interface PluginStatus { spec: string; state: State; missing?: string[]; error?: string; tools: string[]; warnings: string[] }
export interface BridgeStatus { plugins: PluginStatus[]; unsupported: Record<string, string>; bootMs: number }
const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split(/[\r\n]/)[0]!.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500)
export function safeToolName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,54}$/.test(name)) return name
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 41) || 'tool'}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}
const asPlugin = (module: any) => typeof module.apply === 'function' ? module : module.default ?? module
function dependencyNames(plugin: any, normalize?: (inject: any) => object): string[] {
  const inject = plugin?.inject
  if (inject === undefined || inject === null) return []
  if (typeof inject !== 'object') throw new Error('Plugin inject must be an array or a service configuration object')
  const names = Array.isArray(inject) ? inject : Object.keys(normalize ? normalize(inject) : inject)
  if (names.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Plugin inject must contain non-empty service names')
  // Cordis object values are intercept configuration, not optional-dependency flags.
  return [...new Set(names)]
}
function copyJson(value: any, ancestors = new Set<any>()): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('must be lossless JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('must be plain JSON')
  ancestors.add(value)
  try { return Array.isArray(value) ? Array.from(value, item => copyJson(item, ancestors)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, ancestors)])) }
  finally { ancestors.delete(value) }
}
function beforeDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()))
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

async function startBridge() {
  const ownership = ownPluginProcess()
  const log = (text: string) => process.stderr.write(`[dsh] ${firstLine(text)}\n`)
  const wire = (message: unknown) => ownership.send(JSON.stringify(message) + '\n')
  const input = createInterface({ input: process.stdin })
  const controllers = new Map<unknown, AbortController>()
  let root: any, closing = false
  const stop = async () => {
    if (closing) return
    closing = true
    for (const controller of controllers.values()) controller.abort()
    const pids = ownership.descendants()
    const force = setTimeout(() => { ownership.kill(pids); process.exit(0) }, 300)
    try { await root?.fiber?.dispose() } catch { /* Teardown must still reap children. */ }
    for (const pid of ownership.descendants()) pids.add(pid)
    ownership.kill(pids); clearTimeout(force); process.exit(0)
  }
  input.on('close', () => void stop())
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void stop())
  let booted: Promise<Awaited<ReturnType<typeof boot>>> | undefined
  input.on('line', line => {
    if (!line.trim() || closing) return
    let request: any
    try { request = JSON.parse(line) } catch { log('Invalid JSON input'); return }
    if (!booted) {
      booted = boot(request).catch(error => { log(`Bridge failed: ${firstLine(error)}`); void stop(); throw error })
      void booted.catch(() => {})
      return
    }
    if (request.method === 'notifications/cancelled') { controllers.get(request.params?.requestId)?.abort(); void stop(); return }
    const controller = new AbortController()
    if (request.id !== undefined) controllers.set(request.id, controller)
    void (async () => {
      const host = await booted!
      let result: unknown
      switch (request.method) {
        case 'initialize': result = { protocolVersion: request.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'gcode-dsh', version: '1' }, instructions: host.summary }; break
        case 'notifications/initialized': return
        case 'ping': result = {}; break
        case 'dsh/status': result = host.status; break
        case 'tools/list': result = { tools: host.catalog }; break
        case 'tools/call': result = await host.call(request.params?.name, request.params?.arguments, controller); break
        default: if (request.id !== undefined) wire({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return
      }
      if (request.id !== undefined && !closing) wire({ jsonrpc: '2.0', id: request.id, result })
    })().catch(error => { if (request.id !== undefined && !closing) wire({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: firstLine(error) } }) }).finally(() => controllers.delete(request.id))
  })

  async function boot(config: BridgeInput) {
    if (!isAbsolute(config.runtime) || !isAbsolute(config.cwd) || !Array.isArray(config.plugins) || !Number.isInteger(config.toolTimeoutSeconds) || config.toolTimeoutSeconds < 10 || config.toolTimeoutSeconds > 600) throw new Error('Invalid bridge bootstrap')
    const started = performance.now(), deadline = Date.now() + 3000
    const require = createRequire(join(config.runtime, 'package.json'))
    const load = async (spec: string) => import(pathToFileURL(isAbsolute(spec) ? spec : require.resolve(spec)).href)
    process.env.DSH_BRIDGE_RUNTIME = config.runtime
    const { Context, Inject } = await load('@deepseek-ai/cordis')
    root = new Context()
    const errors = new Map<any, string>()
    // Cordis 4.0.6-alpha.2: ERROR=0, WARN=1, INFO=2, DEBUG=3.
    root.logger.exporter({ levels: { default: 1 }, export: (entry: any) => {
      if (entry.level <= 1) { const message = entry.args.map(firstLine).join(' '); log(`${entry.type}: ${message}`); if (entry.type === 'error') errors.set(entry.fiber?.deref(), message) }
    } })
    const wait = (fiber: any, dependencies: string[]) => new Promise<void>(done => {
      let dispose: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => { dispose?.(); clearTimeout(timer); done() }
      const check = () => { if (fiber.state === 2 || fiber.state === 3 || fiber.state === 0 && dependencies.some(name => root.get(name) === undefined)) finish() }
      dispose = root.on('internal/status', check)
      timer = setTimeout(finish, Math.max(0, deadline - Date.now()))
      check()
    })
    let toolsPlugin: any
    for (const spec of ['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native']) {
      const plugin = asPlugin(await load(spec)), fiber = root.plugin(plugin)
      if (spec === '@deepseek-ai/dsh-tools') toolsPlugin = plugin
      await wait(fiber, dependencyNames(plugin, Inject?.resolve))
      if (fiber.state !== 2) throw new Error(`Core plugin failed: ${spec}`)
    }
    const tools = root.get('tools')
    const statuses: PluginStatus[] = []
    const records: Array<{ entry: DshPlugin; plugin: any; dependencies: string[]; status: PluginStatus; fiber?: any }> = []
    // Resolve imports together, then apply plugins in configured order. A stuck
    // top-level await gets at most one second and cannot consume all readiness time.
    const importDeadline = Math.min(deadline, Date.now() + 1000)
    const imported = await Promise.all(config.plugins.map(async entry => {
      const spec = pluginSpec(entry), status: PluginStatus = { spec, state: entry.enabled ? 'PENDING' : 'DISABLED', tools: [], warnings: [] }
      statuses.push(status)
      if (!entry.enabled) return undefined
      if (['@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tool-executor-native'].includes(spec)) {
        status.missing = [spec.includes('approval') ? 'userApproval' : 'reservedProvider']; status.error = spec.includes('approval') ? unsupported.userApproval : 'Core services are owned by G-Code'; return undefined
      }
      try {
        if (entry.package && JSON.parse(readFileSync(join(config.runtime, 'node_modules', entry.package, 'package.json'), 'utf8')).version !== entry.version) throw new Error('Plugin version mismatch; run gcode dsh install explicitly')
        // What the client shows if the bridge never answers: a plugin stuck at import leaves "importing" without "imported".
        log(`Importing plugin ${spec}`)
        const plugin = asPlugin(await beforeDeadline(load(spec), importDeadline, 'Plugin import did not finish within 1 second'))
        log(`Imported plugin ${spec}`)
        return { entry, plugin, dependencies: dependencyNames(plugin, Inject?.resolve), status }
      }
      catch (error) { status.state = 'IMPORT_FAILED'; status.error = firstLine(error) }
    }))
    for (const record of imported) if (record) records.push(record)
    const needs = new Set(records.flatMap(record => record.dependencies))
    for (const [service, spec] of Object.entries(providers)) if (needs.has(service) && (config.providers === undefined || config.providers.includes(service))) {
      try { const Base = asPlugin(await load(spec)); const plugin = confinedFileSystem(Base, config.cwd); const fiber = root.plugin(plugin, { cwd: config.cwd }); await wait(fiber, dependencyNames(plugin, Inject?.resolve)); if (fiber.state !== 2) log(`Provider ${service} failed`) }
      catch (error) { log(`Provider ${service} failed: ${firstLine(error)}`) }
    }
    const owners = new Map<any, PluginStatus>(), definitions = new Map<string, { owner: PluginStatus; exposed: string; dispose: () => unknown; register: () => void }>()
    const conflicts: Array<{ owner: PluginStatus; name: string; register: () => void }> = []
    let loading: PluginStatus | undefined
    const register = toolsPlugin.prototype.register
    toolsPlugin.prototype.register = function(this: any, definition: any, ...args: any[]) {
      let owner: PluginStatus | undefined, fiber = this.ctx?.fiber
      const seen = new Set<any>()
      while (fiber && !owner && !seen.has(fiber)) { seen.add(fiber); owner = owners.get(fiber); fiber = fiber.parent?.fiber }
      owner ??= loading
      if (!owner) throw new Error('Tool registration has no user plugin owner')
      if (owner.state === 'FAILED' || owner.state === 'DISABLED') throw new Error('Plugin is no longer active')
      const name = definition?.name
      if (typeof name !== 'string' || !name) { owner.warnings.push('Invalid tool name; skipped'); return () => {} }
      const exposed = safeToolName(name)
      let copied: any
      try {
        const parameters = copyJson(definition.parameters)
        if (!parameters || Array.isArray(parameters) || parameters.type !== 'object') throw new Error('must have an object root')
        copied = { ...definition, parameters, description: typeof definition.description === 'string' ? definition.description : '' }
      } catch (error) { owner.warnings.push(`Invalid input schema for ${name}: ${firstLine(error)}; skipped`); return () => {} }
      let dispose: (() => unknown) | undefined, disposed = false
      const commit = () => {
        if (disposed || owner!.state === 'FAILED') return
        if (definitions.has(name) || [...definitions.values()].some(record => record.exposed === exposed)) { owner!.warnings.push(`Tool name conflict: ${name}; kept first plugin`); return }
        dispose = register.call(this, copied, ...args)
        definitions.set(name, { owner: owner!, exposed, dispose: () => dispose?.(), register: commit })
        if (name !== exposed) owner!.warnings.push(`Renamed tool ${name} to ${exposed}`)
      }
      const occupied = [...definitions.entries()].find(([key, record]) => key === name || record.exposed === exposed)
      if (occupied && statuses.indexOf(owner) < statuses.indexOf(occupied[1].owner)) {
        // Async apply bodies can register out of order. The configured first
        // plugin still owns a duplicate name once it becomes ready.
        occupied[1].dispose(); definitions.delete(occupied[0])
        conflicts.push({ owner: occupied[1].owner, name: occupied[0], register: occupied[1].register })
        commit()
      } else if (occupied) conflicts.push({ owner, name, register: commit })
      else commit()
      return () => { disposed = true; return dispose?.() }
    }
    for (const record of records) {
      const missing = record.dependencies.filter(name => root.get(name) === undefined)
      if (missing.length) { record.status.missing = missing; record.status.error = missing.map(name => (unsupported as any)[name]).filter(Boolean).join('; ') || undefined; continue }
      try {
        loading = record.status
        const fiber = root.plugin(record.plugin, record.entry.config)
        // Cordis returns a thenable wrapper whose prototype is the actual fiber;
        // services expose ctx.fiber, so attribute registrations to that identity.
        record.fiber = fiber.ctx?.fiber ?? fiber
        owners.set(fiber, record.status); owners.set(record.fiber, record.status)
      } catch (error) { record.status.state = 'FAILED'; record.status.error = firstLine(error) }
      finally { loading = undefined }
    }
    // Apply in order, but observe readiness together so a slow failed plugin does
    // not spend the healthy plugins' entire shared three-second deadline.
    await Promise.all(records.map(async record => {
      const fiber = record.fiber
      if (!fiber) return
      await wait(fiber, record.dependencies)
      record.status.state = fiber.state === 2 ? 'ACTIVE' : fiber.state === 0 ? 'PENDING' : 'FAILED'
      if (record.status.state === 'PENDING') record.status.missing = record.dependencies.filter(name => root.get(name) === undefined)
      if (record.status.state === 'FAILED') record.status.error = errors.get(fiber) ?? 'Plugin did not become ready within 3 seconds'
      if (fiber.state === 3) try { await fiber.await() } catch (error) { record.status.error = firstLine(error) }
    }))
    for (const record of records) if (record.status.state !== 'ACTIVE') {
      for (const [name, definition] of definitions) if (definition.owner === record.status) {
        try { definition.dispose() } catch { /* A failed disposer cannot retain tool ownership. */ }
        definitions.delete(name)
      }
      if (record.fiber) void record.fiber.dispose().catch(() => {})
    }
    for (const conflict of conflicts.sort((a, b) => statuses.indexOf(a.owner) - statuses.indexOf(b.owner))) if (conflict.owner.state === 'ACTIVE') {
      try { conflict.register() } catch (error) { conflict.owner.warnings.push(`Tool ${conflict.name} could not register: ${firstLine(error)}`) }
    }
    const catalog: any[] = [], names = new Map<string, string>()
    const schemas = tools.schemas().sort((a: any, b: any) => {
      const order = statuses.indexOf(definitions.get(a.name)?.owner!) - statuses.indexOf(definitions.get(b.name)?.owner!)
      return order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    })
    for (const schema of schemas) {
      const owned = definitions.get(schema.name)
      if (!owned || owned.owner.state !== 'ACTIVE') continue
      names.set(owned.exposed, schema.name); owned.owner.tools.push(owned.exposed)
      // Pinned DSH has no explicit readonly metadata; never infer it from the name.
      catalog.push({ name: owned.exposed, description: schema.description ?? '', inputSchema: schema.parameters ?? { type: 'object' }, _meta: { 'gcode/dsh-plugin': owned.owner.spec } })
    }
    const status: BridgeStatus = { plugins: statuses, unsupported, bootMs: performance.now() - started }
    const summary = `DSH plugins: ${statuses.map(s => `${s.spec} ${s.state}${s.missing?.length ? ` (missing ${s.missing.join(', ')})` : ''}`).join('; ') || 'none'}`
    log(summary)
    return { status, summary, catalog, async call(name: string, args: unknown, controller: AbortController) {
      const original = names.get(name)
      if (!original) throw new Error('Unknown or inactive DSH tool')
      const timer = setTimeout(() => { controller.abort(); void stop() }, config.toolTimeoutSeconds * 1000)
      try {
        const result = await tools.execute({ calls: [{ type: 'tool-call', id: `dsh-${Date.now()}`, name: original, arguments: JSON.stringify(args ?? {}) }], signal: controller.signal })
        const response = result.results[0]?.result
        const content = (response?.content ?? []).map((block: any) => {
          if (block.type === 'text' && typeof block.text === 'string') return block
          if (block.type === 'image' && block.data) return { type: 'image', data: block.data, mimeType: block.mediaType ?? block.mimeType ?? 'image/png' }
          return { type: 'text', text: JSON.stringify(block) }
        })
        if (result.additionalContexts?.length) content.push({ type: 'text', text: JSON.stringify({ unsupportedAdditionalContexts: result.additionalContexts }) })
        return { content, isError: !!response?.isError }
      } finally { clearTimeout(timer) }
    } }
  }
}

// Source Bun and bundled Node entrypoints share the exact same transport.
void startBridge().catch(error => { process.stderr.write(`[dsh] ${firstLine(error)}\n`); process.exitCode = 1 })
