/** Exact destinations, never instructions or model-supplied claims of consent. */
export interface NetworkGuardSettings { enabled: boolean; allowlist: string[] }
export interface NetworkIncident {
  id: string; path: string; at: number; sessionId: string; destination: string; model: string
  layer: string; tool: string; input: unknown; intent: string; canContinue: boolean; reason?: string
  decision?: 'continue' | 'reject'
  /** Denied after its evidence could not be fully saved. */
  evidenceIncomplete?: boolean
}
export interface NetworkHold { incident: NetworkIncident; phase: 'held' | 'rejected' | 'continued'; grants: string[]; evidenceSaved?: boolean }
export const CLOUD_GUARD_REASON = "Cloud models need the network to work, so the guard can't run with them."
export function loopbackHost(value: string): boolean {
  const h = value.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h) && h.split('.').every(n => Number(n) <= 255)
}
export function guardEligible(provider: string, baseUrl?: string): boolean {
  if (provider !== 'local' && provider !== 'ollama') return false
  try { const u = new URL(baseUrl || 'http://localhost:11434'); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && loopbackHost(u.hostname) } catch { return false }
}
/** ASCII/punycode is deliberately shown to avoid a Unicode lookalike silently widening a grant. */
export function guardHost(value: string): string | undefined {
  if (!value || /[\s/@?#\\]/.test(value) || value.includes('*')) return undefined
  try { const u = new URL(`http://${value}`); const explicit = /(?::(\d+))$/.exec(value)?.[1]; return u.hostname && u.pathname === '/' && !u.username && !u.password ? `${u.hostname.toLowerCase()}${explicit ? ':' + Number(explicit) : u.port ? ':' + u.port : ''}` : undefined } catch { return undefined }
}
export function destinationAllowed(host: string, port: number, grants: Iterable<string>): boolean {
  const rawName = host.toLowerCase().replace(/^\[|\]$/g, '')
  let name = rawName
  try { name = new URL(`http://${rawName.includes(':') ? `[${rawName}]` : rawName}`).hostname.replace(/^\[|\]$/g, '') } catch { return false }
  for (const raw of grants) {
    const rule = raw.toLowerCase()
    const authority = name.includes(':') ? `[${name}]:${port}` : `${name}:${port}`
    if (rule === name || rule === `[${name}]` || rule === authority) return true
    if (rule.startsWith('*.') && !rule.includes(':') && name.endsWith(rule.slice(1)) && name !== rule.slice(2)) return true
  }
  return false
}

export function destinationAuthority(host: string, port: number): string | undefined {
  const h = host.replace(/^\[|\]$/g, '')
  return guardHost(`${h.includes(':') ? `[${h}]` : h}:${port}`)
}
/** Active proxy settings can be authorities without a scheme (curl accepts that form). */
export function userProxyPort(value: string): number | undefined {
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`)
    const defaults: Record<string, number> = { 'http:': 80, 'https:': 443, 'socks:': 1080, 'socks4:': 1080, 'socks4a:': 1080, 'socks5:': 1080, 'socks5h:': 1080, 'ftp:': 21 }
    if (!u.hostname || !defaults[u.protocol] || u.pathname !== '/' && u.pathname !== '' || u.search || u.hash) return
    const port = u.port ? Number(u.port) : defaults[u.protocol]
    return port && port > 0 && port <= 65535 ? port : undefined
  } catch { return }
}
