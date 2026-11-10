import { currentGuard, inGuardCall, NetworkGuard, setNetworkGuard } from '../security/guard.js'
import { networkSettings } from '../security/settings.js'
import { createAppStore } from '../state/store.js'
import { loadMCPConfig } from '../mcp/config.js'
import { createDshClient } from './host.js'
import { install, status } from './runtime.js'
import { dshSettings, pluginSpec } from './settings.js'
import { unsupported } from './providers.js'

export async function dshStatus(cwd: string, guillotine = false, verbose = false) {
  const settings = dshSettings(cwd)
  const plugins = settings.plugins.map(plugin => ({ spec: pluginSpec(plugin), state: 'DISABLED', tools: [] as string[], warnings: [] as string[] }))
  if (!settings.enabled) return { enabled: false, state: 'DISABLED', plugins, unsupported }
  const runtime = status(settings)
  const failed = (error: string) => plugins.map((plugin, index) => settings.plugins[index]!.enabled
    ? { ...plugin, state: runtime.plugins[index]?.state === 'NOT_INSTALLED' ? 'NOT_INSTALLED' : 'FAILED', error }
    : plugin)
  if (Object.hasOwn(loadMCPConfig(cwd).mcpServers, 'dsh')) {
    const error = 'User mcp.json reserves "dsh"; built-in bridge skipped.'
    return { enabled: true, state: 'CONFLICT', error, runtime, plugins: failed(error), unsupported }
  }
  if (runtime.state !== 'READY') return { enabled: true, state: runtime.state, runtime, plugins: plugins.map((p, i) => ({ ...p, state: settings.plugins[i]!.enabled ? 'NOT_INSTALLED' : 'DISABLED' })), unsupported }
  const client = createDshClient(settings, cwd, verbose)
  let guard: NetworkGuard | undefined, discovery: Awaited<ReturnType<NetworkGuard['call']>> | undefined
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('DSH status timed out')), 5000)
  const stop = () => { abort.abort(); void client.disconnect() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  try {
    const saved = networkSettings().settings
    if (guillotine || saved.enabled) {
      guard = new NetworkGuard({ store: createAppStore(undefined, cwd), provider: 'local', model: 'dsh-status', settings: { ...saved, enabled: true } })
      await guard.start(); setNetworkGuard(guard)
      const config = client.getConnection().config
      discovery = await guard.call('MCP discovery', 'dsh', { command: config.command, args: config.args })
    }
    await inGuardCall(guard, discovery, () => client.connect(abort.signal))
    await guard?.fence()
    const bridge = await client.dshStatus(abort.signal)
    return { enabled: true, state: 'READY', runtime, ...bridge, plugins: bridge.plugins.map((plugin, index) =>
      runtime.plugins[index]?.state === 'NOT_INSTALLED' ? { ...plugin, state: 'NOT_INSTALLED', error: undefined } : plugin) }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/[\r\n]/)[0]! : 'DSH bridge failed'
    return { enabled: true, state: 'ERROR', runtime, error: reason, plugins: failed(reason), unsupported }
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
    await client.disconnect()
    try { try { await guard?.finishCall(discovery) } finally { await guard?.close() } }
    finally { if (guard && currentGuard() === guard) setNetworkGuard() }
  }
}

export async function runDshCommand(action: 'status' | 'install', options: { json?: boolean; guillotineMode?: boolean; networkGuard?: boolean; verbose?: boolean }) {
  const saved = networkSettings()
  if (saved.problem) throw new Error(saved.problem)
  const cwd = process.cwd(), guillotine = !!(options.guillotineMode || options.networkGuard || saved.settings.enabled)
  if (action === 'install') {
    const result = await install(dshSettings(cwd), { guillotine })
    process.stdout.write(`Installed DSH runtime at ${result.directory}\nUsing ${result.npmSource}: ${result.npm}\n${result.installed.length} plugin package(s) installed.\n`)
    return
  }
  const result = await dshStatus(cwd, guillotine, options.verbose)
  if (options.json) process.stdout.write(JSON.stringify(result) + '\n')
  else {
    process.stdout.write(`DeepSeek Harness plugins: ${result.state}\n`)
    for (const plugin of result.plugins) process.stdout.write(`${plugin.spec}: ${plugin.state}${'missing' in plugin && Array.isArray(plugin.missing) ? ` (missing ${plugin.missing.join(', ')})` : ''}${'error' in plugin && plugin.error ? ` — ${plugin.error}` : ''}\n`)
    if ('error' in result) process.stdout.write(`${result.error}\n`)
  }
  if (['ERROR', 'CONFLICT', 'VERSION_MISMATCH'].includes(result.state)) process.exitCode = 1
}
