/**
 * Direct transport for explicitly local endpoints.
 * Bun 1.3 ignores proxy:false, including through its node:http adapter, so add
 * only this selected hostname to this process's bypass list as a compatibility
 * fallback. Existing proxy rules for every other host are preserved.
 */
export function directFetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url)
  if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new Error('Local endpoint must use HTTP(S).'))
  ensureDirectHost(target.hostname)
  return fetch(url, { ...init, ...{ proxy: false } })
}
export function ensureDirectHost(host: string): void {
  const bypassHosts = new Set([
    ...(process.env['NO_PROXY'] ?? '').split(/[,\s]+/),
    ...(process.env['no_proxy'] ?? '').split(/[,\s]+/),
    host,
  ].filter(Boolean))
  const bypass = [...bypassHosts].join(',')
  process.env['NO_PROXY'] = bypass
  process.env['no_proxy'] = bypass
}
