import { normalizeOllamaHost } from '../llm/ollama.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../types.js'
import type { Store } from '../state/store.js'
import { guardHost, guardEligible, CLOUD_GUARD_REASON, type NetworkGuardSettings } from '../shared/networkGuard.js'
import { NetworkGuard, setNetworkGuard, currentGuard } from './guard.js'
import { directFetch } from '../llm/directFetch.js'

/**
 * The product reads its settings; callers never receive provider keys. `problem`: the file exists but
 * could not be read, so whether Guillotine Mode is on is unknown. That is not "off": each caller refuses.
 */
export function networkSettings(): { settings: NetworkGuardSettings; modelFile?: string; ollamaHost?: string; problem?: string } {
  let data: any = {}, problem: string | undefined
  const path = join(homedir(), '.gcode/settings.json')
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SyntaxError('not an object')
  } catch (error) {
    data = {}
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problem = `${path} could not be read, so G-Code cannot tell whether Guillotine Mode is on, and nothing was started. Fix the file, or restore settings.json.bak beside it.`
  }
  const value = data.execution?.networkGuard
  return { settings: { enabled: value?.enabled === true, allowlist: Array.isArray(value?.allowlist) ? value.allowlist.map(guardHost).filter((h: unknown): h is string => typeof h === 'string') : [] }, modelFile: data.provider?.localModelPath, ollamaHost: data.provider?.ollamaHost, ...(problem ? { problem } : {}) }
}
export async function configureNetworkGuard(store: Store<AppState>, options: { networkGuard?: boolean; provider?: string; model?: string; baseUrl?: string }, notify: (incident: import('../shared/networkGuard.js').NetworkIncident) => void): Promise<NetworkGuard | undefined> {
  await currentGuard()?.close(); setNetworkGuard()
  const saved = networkSettings(), baseUrl = options.baseUrl ?? (options.provider === 'ollama' ? process.env.OLLAMA_HOST ?? saved.ollamaHost : process.env.GCODE_LOCAL_BASE_URL)
  const eligible = guardEligible(options.provider ?? '', baseUrl)
  if (options.networkGuard && !eligible) throw new Error(`--guillotine-mode refused. ${CLOUD_GUARD_REASON}`)
  if (eligible && saved.problem) throw new Error(saved.problem)
  const held = store.getState().networkHold?.phase === 'held'
  if (held && !eligible) throw new Error('This chat is held by a network incident. Resume its local model and decide before making another request.')
  if (!eligible || !(options.networkGuard || saved.settings.enabled || held)) return
  let digest: string | undefined
  if (options.provider === 'ollama') {
    try { const response = await directFetch(`${normalizeOllamaHost(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(3000) }); const data = await response.json() as { models?: Array<{ name: string; digest?: string }> }; digest = data.models?.find(m => m.name === options.model)?.digest } catch {}
  }
  const guard = new NetworkGuard({ store, provider: options.provider!, model: options.model ?? '', baseUrl, settings: { ...saved.settings, enabled: true }, modelFile: options.provider === 'local' ? saved.modelFile : undefined, modelDigest: digest, onIncident: notify })
  await guard.start(); setNetworkGuard(guard); return guard
}
