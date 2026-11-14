/**
 * @file auth.ts
 * @brief Credentials for remote MCP servers: bearer tokens, API keys and OAuth 2 (client
 *        credentials, or an interactive authorization-code login with PKCE, metadata discovery
 *        (RFC 9728, RFC 8414) and dynamic client registration (RFC 7591)). Tokens are cached in
 *        ~/.gcode/auth with owner-only permissions and are never printed.
 */

import { signInAdvice } from './surface.js'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { NetworkStopped, guardedFetch, refuseBlockedRedirect } from '../security/guard.js'
import { connectionSignal, readLimited, sameOriginFetch } from './httpTransport.js'
import type { MCPAuthConfig, MCPServerConfig } from './types.js'

export type { MCPAuthConfig } from './types.js'

interface TokenCache {
  accessToken: string
  /** Milliseconds since the epoch; 0 when the server gave no lifetime. */
  expiresAt: number
  refreshToken?: string
  /** For a login: the client and token endpoint the tokens came from (refreshes use the same). */
  clientId?: string
  tokenUrl?: string
}

const tokenDir = () => join(homedir(), '.gcode', 'auth')
/** One file per server name and address, so renaming or repointing a server never reuses its tokens. */
const tokenPath = (server: MCPServerConfig) => join(tokenDir(), `mcp-${createHash('sha256').update(`${server.name}\0${server.url ?? ''}`).digest('hex').slice(0, 32)}.json`)
const memory = new Map<string, TokenCache>()

/** The store as it is on disk, with owner-only modes put back if a restore or a sync tool widened them. */
function readDisk(server: MCPServerConfig): TokenCache | undefined {
  const path = tokenPath(server)
  if (!existsSync(path)) { memory.delete(path); return }
  try {
    narrow(tokenDir(), 0o700); narrow(path, 0o600)
    const value = JSON.parse(readFileSync(path, 'utf8')) as TokenCache
    if (typeof value.accessToken !== 'string' || !value.accessToken) return
    memory.set(path, value)
    return value
  } catch { return }
}

function narrow(path: string, mode: number): void {
  const stat = lstatSync(path)
  if (!stat.isSymbolicLink() && stat.mode & 0o777 & ~mode) chmodSync(path, mode)
}

/** A copy in memory serves while it is good; after that the store may hold what another process renewed. */
function readCache(server: MCPServerConfig): TokenCache | undefined {
  const cached = memory.get(tokenPath(server))
  return fresh(cached) ? cached : readDisk(server)
}

function writeCache(server: MCPServerConfig, cache: TokenCache): void {
  const dir = tokenDir(), path = tokenPath(server)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 })
  renameSync(temporary, path)
  memory.set(path, cache)
}

/** Forgets a server's cached tokens (`gcode mcp logout`). */
export function forgetTokens(server: MCPServerConfig): boolean {
  const path = tokenPath(server)
  memory.delete(path)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

export function hasCachedLogin(server: MCPServerConfig): boolean { return !!readCache(server) }

const fresh = (cache?: TokenCache) => !!cache && (cache.expiresAt === 0 || cache.expiresAt > Date.now() + 60_000)

function secret(value: string | undefined, env: string | undefined, what: string, server: string): string {
  if (env) {
    const found = process.env[env]
    if (!found) throw new Error(`MCP server "${server}": set the environment variable ${env} (${what}).`)
    return found
  }
  if (value) return value
  throw new Error(`MCP server "${server}": its auth config needs "${what === 'client secret' ? 'clientSecretEnv' : 'tokenEnv'}" or a value.`)
}

/** How long a token endpoint gets, and metadata. Both are under `gcode mcp test`'s 15 s request limit and a chat call's 30 s, so what ends the wait names the endpoint. */
const TOKEN_WAIT_MS = 12_000
const METADATA_WAIT_MS = 10_000
/** A token answer or metadata document is a few KB. */
const OAUTH_BODY_BYTES = 1024 * 1024

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`
const isLoopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)

/** An address that sign-in secrets or the user's browser may be sent to: https, or http on this computer (RFC 8252, and local servers). */
function oauthEndpoint(value: string, what: string, serverName?: string): URL {
  const owner = serverName ? `MCP server "${serverName}": ` : ''
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${owner}its OAuth ${what} is not a valid address.`) }
  if (url.protocol === 'https:' || url.protocol === 'http:' && isLoopback(url.hostname)) return url
  throw new Error(`${owner}its OAuth ${what} must use https (plain http only on this computer), and ${url.protocol === 'http:' ? url.origin : url.protocol} does not. Nothing was sent to it or opened.`)
}

/** A token endpoint refused the grant: only a new sign-in helps. Other failures say nothing about the sign-in. */
class TokenRefused extends Error {}

/** One POST of a grant. It holds secrets, so no redirect is followed at all, and the wait is bounded. */
async function postForm(url: string, form: Record<string, string>, serverName: string, signal?: AbortSignal): Promise<TokenCache & { raw: Record<string, unknown> }> {
  const target = oauthEndpoint(url, 'token endpoint', serverName)
  const wait = AbortSignal.timeout(TOKEN_WAIT_MS)
  const { connection: both, release } = connectionSignal(wait, ...(signal ? [signal] : []))
  let response: Response, text: string
  try {
    response = await guardedFetch(target, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form), redirect: 'manual', signal: both })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location) {
      void response.body?.cancel().catch(() => {})
      let next: URL | undefined
      try { next = new URL(location, target) } catch { /* Named as unknown below. */ }
      if (next) await refuseBlockedRedirect(next)
      throw new Error(`The OAuth token endpoint ${target.origin} redirected to ${next?.origin ?? 'an invalid address'}. Not followed: the sign-in secrets would go there.`)
    }
    text = await readLimited(response, OAUTH_BODY_BYTES, `The OAuth token endpoint ${target.origin} sent more than 1 MB.`, both)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (wait.aborted) throw new Error(`The OAuth token endpoint ${target.origin} did not answer within ${seconds(TOKEN_WAIT_MS)}.`)
    if (error instanceof NetworkStopped || error instanceof Error && /^The OAuth token endpoint /.test(error.message)) throw error
    throw new Error(`The OAuth token endpoint ${target.origin} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  } finally { release() }
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(text) } catch { /* Reported below without the body. */ }
  if (!response.ok || typeof data.access_token !== 'string') {
    const code = typeof data.error === 'string' ? `: ${data.error}` : ''
    const message = `OAuth token request failed (HTTP ${response.status}${code})`
    throw response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? new TokenRefused(message) : new Error(message)
  }
  const lifetime = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in)
  return { accessToken: data.access_token, expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? Date.now() + lifetime * 1000 : 0, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined, raw: data }
}

/** A wait the caller can end; the work goes on for whoever else waits for it. */
const untilAborted = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => !signal ? work : new Promise<T>((resolve, reject) => {
  const stop = () => reject(signal.reason ?? new Error('Aborted'))
  if (signal.aborted) return stop()
  signal.addEventListener('abort', stop, { once: true })
  work.then(value => { signal.removeEventListener('abort', stop); resolve(value) }, error => { signal.removeEventListener('abort', stop); reject(error) })
})

/** A holder is bounded by TOKEN_WAIT_MS, so one this old was left behind, whoever holds its pid now. */
const REFRESH_LOCK_STALE_MS = 30_000
const REFRESH_LOCK_WAIT_MS = TOKEN_WAIT_MS + 3_000

function staleRefreshLock(file: string): boolean {
  try {
    if (Date.now() - statSync(file).mtimeMs > REFRESH_LOCK_STALE_MS) return true
    const pid = Number(readFileSync(file, 'utf8'))
    if (!pid) return false
    try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  } catch { return false }
}

/**
 * One refresh at a time per sign-in, across processes: rotating refresh tokens work once, so the
 * next process must read what the last one stored. The lock file is in ~/.gcode/locks; it is held
 * only across a request bounded by TOKEN_WAIT_MS. Where that folder cannot be written it runs without it.
 */
async function withRefreshLock<T>(server: MCPServerConfig, run: () => Promise<T>): Promise<T> {
  const folder = join(homedir(), '.gcode', 'locks')
  const file = join(folder, `auth-${tokenPath(server).split(/[/\\]/).pop()!.replace(/\.json$/, '')}.lock`)
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        try { mkdirSync(folder, { recursive: true, mode: 0o700 }); continue } catch { return run() }
      }
      if (code !== 'EEXIST') return run()
    }
    if (staleRefreshLock(file)) { try { rmSync(file, { force: true }); continue } catch { /* The wait below decides. */ } }
    if (Date.now() > deadline) throw new Error(`Another G-Code process has been renewing this sign-in for over ${seconds(REFRESH_LOCK_WAIT_MS)}.`)
    await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 60))
  }
  try { return await run() } finally { try { rmSync(file, { force: true }) } catch { /* A later process treats it as stale. */ } }
}

/** Under the lock: another process may have renewed already; else this one spends the refresh token. */
async function renew(server: MCPServerConfig): Promise<TokenCache | undefined> {
  const current = readDisk(server)
  if (fresh(current)) return current
  if (!current?.refreshToken || !current.tokenUrl || !current.clientId) return
  try {
    const next = await postForm(current.tokenUrl, { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId, ...(server.url ? { resource: server.url } : {}) }, server.name)
    const stored: TokenCache = { accessToken: next.accessToken, expiresAt: next.expiresAt, refreshToken: next.refreshToken ?? current.refreshToken, clientId: current.clientId, tokenUrl: current.tokenUrl }
    writeCache(server, stored)
    return stored
  } catch (error) {
    if (!(error instanceof TokenRefused)) throw error
    // A process that does not take the lock may have got there first.
    const latest = readDisk(server)
    return fresh(latest) ? latest : undefined
  }
}

const refreshing = new Map<string, Promise<TokenCache | undefined>>()

/** A login renewed with its refresh token: undefined when the server refused it. Callers in this process share one request. */
function refreshed(server: MCPServerConfig, signal?: AbortSignal): Promise<TokenCache | undefined> {
  const key = tokenPath(server)
  let work = refreshing.get(key)
  if (!work) {
    work = withRefreshLock(server, () => renew(server)).finally(() => refreshing.delete(key))
    refreshing.set(key, work)
  }
  return untilAborted(work, signal)
}

/** The headers a remote server gets on every request: its own `headers` plus its credentials. */
export async function remoteHeaders(server: MCPServerConfig, signal?: AbortSignal): Promise<Record<string, string>> {
  const headers = { ...server.headers ?? {} }
  const auth = server.auth
  if (!auth) return headers
  if (auth.type === 'bearer') headers.Authorization = `Bearer ${secret(auth.token, auth.tokenEnv, 'bearer token', server.name)}`
  else if (auth.type === 'api_key') headers[auth.headerName ?? 'X-API-Key'] = secret(auth.token, auth.tokenEnv, 'API key', server.name)
  else headers.Authorization = `Bearer ${await oauthToken(server, auth, signal)}`
  return headers
}

async function oauthToken(server: MCPServerConfig, auth: Extract<MCPAuthConfig, { type: 'oauth2' }>, signal?: AbortSignal): Promise<string> {
  const cached = readCache(server)
  if (fresh(cached)) return cached!.accessToken
  if (auth.clientSecret || auth.clientSecretEnv) {
    // Client credentials: a machine identity, no user login.
    if (!auth.tokenUrl || !auth.clientId) throw new Error(`MCP server "${server.name}": OAuth client credentials need "clientId" and "tokenUrl".`)
    const next = await postForm(auth.tokenUrl, {
      grant_type: 'client_credentials', client_id: auth.clientId, client_secret: secret(auth.clientSecret, auth.clientSecretEnv, 'client secret', server.name),
      ...(auth.scope ? { scope: auth.scope } : {}), ...(server.url ? { resource: server.url } : {}),
    }, server.name, signal)
    const stored: TokenCache = { accessToken: next.accessToken, expiresAt: next.expiresAt, refreshToken: next.refreshToken }
    writeCache(server, stored)
    return stored.accessToken
  }
  if (cached) {
    let renewed: TokenCache | undefined
    try { renewed = await refreshed(server, signal) } catch (error) {
      if (signal?.aborted || error instanceof NetworkStopped) throw error
      // Not a refusal: the sign-in is still good, and signing in again now would fail the same way.
      throw new Error(`MCP server "${server.name}": its sign-in could not be renewed just now, and is kept. ${error instanceof Error ? error.message : String(error)} Try again when that server answers.`)
    }
    if (renewed) return renewed.accessToken
  }
  throw new Error(process.env.GCODE_DESKTOP === '1' ? `MCP server "${server.name}" needs a login. ${signInAdvice(server.name)}` : `MCP server "${server.name}" needs a login: run \`gcode mcp login ${server.name}\`.`)
}

// ============================================================================
// Interactive login (authorization code with PKCE)
// ============================================================================

interface Endpoints { authorization: string; token: string; registration?: string; scopes?: string[] }

/** A metadata document, or undefined when there is none at `url`. Only silence stops the search: the next address is usually on the same host. */
async function json(url: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const wait = AbortSignal.timeout(METADATA_WAIT_MS)
  const { connection: both, release } = connectionSignal(wait, ...(signal ? [signal] : []))
  try {
    const response = await sameOriginFetch(url, { headers: { Accept: 'application/json' }, signal: both })
    if (!response.ok) { void response.body?.cancel(); return }
    return JSON.parse(await readLimited(response, OAUTH_BODY_BYTES, 'too large', both)) as Record<string, unknown>
  } catch (error) {
    if (error instanceof NetworkStopped) throw error
    if (signal?.aborted) throw signal.reason ?? error
    if (wait.aborted) throw new Error(`The OAuth metadata address ${url} did not answer within ${seconds(METADATA_WAIT_MS)}.`)
    return
  } finally { release() }
}

/** What a server's 401 names as its metadata address (RFC 9728), for a server that serves it nowhere else. The probe carries no credentials. */
async function challengedMetadata(server: MCPServerConfig, signal?: AbortSignal): Promise<string | undefined> {
  const wait = AbortSignal.timeout(METADATA_WAIT_MS)
  const { connection: both, release } = connectionSignal(wait, ...(signal ? [signal] : []))
  try {
    const response = await guardedFetch(server.url!, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'g-code', version: '0.1.1' } } }), redirect: 'manual', signal: both })
    void response.body?.cancel().catch(() => {})
    if (response.status !== 401) return
    const named = /resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1]
    return named ? oauthEndpoint(new URL(named, server.url).href, 'metadata address', server.name).href : undefined
  } catch (error) {
    if (error instanceof NetworkStopped || error instanceof Error && error.message.includes('metadata address')) throw error
    return
  } finally { release() }
}

/**
 * The authorization server's endpoints: from the config, else discovered from the server's metadata.
 * The check on metadata: a discovered sign-in page, token endpoint and registration endpoint must all
 * be on the origin of the issuer they came from. A sign-in on one host and a token endpoint on another
 * would send that host the code and PKCE verifier of a login the user made elsewhere. An authorization
 * server spread over several hosts works when the user writes these addresses in the config: only
 * what the user wrote may leave the issuer's origin. Every address must also be https or on this computer.
 */
export async function discoverEndpoints(server: MCPServerConfig, resourceMetadata?: string, signal?: AbortSignal): Promise<Endpoints> {
  const auth = server.auth?.type === 'oauth2' ? server.auth : undefined
  const resource = new URL(server.url!)
  const written = !!(auth?.authorizationUrl && auth.tokenUrl)
  let protectedResource = await json(resourceMetadata ?? new URL('/.well-known/oauth-protected-resource' + resource.pathname.replace(/\/$/, ''), resource.origin).href, signal)
    ?? (resource.pathname !== '/' ? await json(new URL('/.well-known/oauth-protected-resource', resource.origin).href, signal) : undefined)
  if (!protectedResource && !resourceMetadata && !written) {
    const challenged = await challengedMetadata(server, signal)
    if (challenged) protectedResource = await json(challenged, signal)
  }
  const named = Array.isArray(protectedResource?.authorization_servers) && typeof protectedResource.authorization_servers[0] === 'string' ? protectedResource.authorization_servers[0] : undefined
  if (named && !written) {
    const issuer = oauthEndpoint(named, 'authorization server', server.name)
    if (resource.protocol === 'https:' && issuer.protocol !== 'https:') throw new Error(`MCP server "${server.name}": an https server named a plain http authorization server (${issuer.origin}). Nothing was sent to it.`)
  }
  const base = new URL(named ?? resource.origin)
  const path = base.pathname.replace(/\/$/, '')
  const metadata = await json(new URL(`/.well-known/oauth-authorization-server${path}`, base.origin).href, signal)
    ?? await json(new URL(`/.well-known/openid-configuration${path}`, base.origin).href, signal)
    ?? await json(`${base.origin}${path}/.well-known/openid-configuration`, signal)
  const authorization = auth?.authorizationUrl ?? (typeof metadata?.authorization_endpoint === 'string' ? metadata.authorization_endpoint : undefined)
  const token = auth?.tokenUrl ?? (typeof metadata?.token_endpoint === 'string' ? metadata.token_endpoint : undefined)
  if (!authorization || !token) throw new Error(`MCP server "${server.name}": no OAuth authorization server metadata was found; set "authorizationUrl" and "tokenUrl" in its auth config.`)
  const registration = typeof metadata?.registration_endpoint === 'string' ? metadata.registration_endpoint : undefined
  const addresses: Array<[what: string, address: string | undefined, userWrote: boolean]> = [['sign-in page', authorization, !!auth?.authorizationUrl], ['token endpoint', token, !!auth?.tokenUrl], ['registration endpoint', registration, false]]
  for (const [what, address, userWrote] of addresses) {
    if (!address) continue
    const url = oauthEndpoint(address, what, server.name)
    if (!userWrote && url.origin !== base.origin) throw new Error(`MCP server "${server.name}": the metadata of ${base.origin} names ${url.origin} as its OAuth ${what}, on another origin. Nothing was sent. If you trust it, set "authorizationUrl" and "tokenUrl" in its auth config.`)
  }
  const scopes = Array.isArray(protectedResource?.scopes_supported) ? protectedResource.scopes_supported.filter((s): s is string => typeof s === 'string') : undefined
  return { authorization, token, registration, scopes }
}

const base64url = (bytes: Buffer) => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The system browser's command for a checked http(s) address. No shell on any system: `cmd /c start` would read & in an address as a command separator. */
export function browserCommand(url: URL, platform: string = process.platform): [string, string[]] {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Refusing to open ${url.protocol} in a browser.`)
  return platform === 'darwin' ? ['open', [url.href]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]] : ['xdg-open', [url.href]]
}

function openBrowser(address: string): void {
  const [command, args] = browserCommand(new URL(address))
  try { spawn(command, args, { stdio: 'ignore', detached: true }).unref() } catch { /* The URL is printed too. */ }
}

export interface LoginOptions {
  /** Called with the authorization URL (printed by the CLI; tests follow it themselves). */
  onUrl?: (url: string) => void
  open?: (url: string) => void
  timeoutMs?: number
  resourceMetadata?: string
}

/**
 * Signs in to a remote MCP server in the browser and caches its tokens. The redirect goes to a
 * one-time listener on 127.0.0.1 (RFC 8252); `state` and PKCE bind the answer to this login.
 */
export async function loginOAuth(server: MCPServerConfig, options: LoginOptions = {}): Promise<void> {
  if (!server.url) throw new Error(`MCP server "${server.name}" is not a remote server.`)
  const auth = server.auth?.type === 'oauth2' ? server.auth : { type: 'oauth2' as const }
  const state = base64url(randomBytes(24)), verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // It may be refused before it is waited for.
  code.catch(() => {})
  // The limit covers the whole sign-in: every request below ends with it.
  const limit = new AbortController()
  const timer = setTimeout(() => { const late = new Error('Sign-in timed out.'); limit.abort(late); rejectCode(late) }, options.timeoutMs ?? 300_000)
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
    response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(ok ? '<p>G-Code is signed in. You can close this tab.</p>' : '<p>G-Code sign-in failed. You can close this tab.</p>')
    if (ok) resolveCode(url.searchParams.get('code')!)
    else rejectCode(new Error(url.searchParams.get('error') ? `Sign-in refused: ${url.searchParams.get('error')}` : 'Sign-in answer did not match this login.'))
  })
  try {
    const endpoints = await discoverEndpoints(server, options.resourceMetadata, limit.signal)
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    const port = (listener.address() as { port: number }).port
    const redirect = `http://127.0.0.1:${port}/callback`
    let clientId = auth.clientId
    if (!clientId) {
      if (!endpoints.registration) throw new Error(`MCP server "${server.name}": the authorization server has no client registration; set "clientId" in its auth config.`)
      const origin = new URL(endpoints.registration).origin
      const timeout = AbortSignal.timeout(TOKEN_WAIT_MS)
      const { connection: wait, release } = connectionSignal(limit.signal, timeout)
      let response: Response, body: string
      try {
        response = await guardedFetch(endpoints.registration, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, redirect: 'manual', signal: wait,
          body: JSON.stringify({ client_name: 'G-Code', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        })
        body = await readLimited(response, OAUTH_BODY_BYTES, `The OAuth registration endpoint ${origin} sent more than 1 MB.`, wait)
      } catch (error) {
        if (limit.signal.aborted) throw limit.signal.reason
        if (timeout.aborted) throw new Error(`The OAuth registration endpoint ${origin} did not answer within ${seconds(TOKEN_WAIT_MS)}.`)
        throw error
      } finally { release() }
      const registered = (() => { try { return JSON.parse(body) } catch { return {} } })() as { client_id?: unknown }
      if (!response.ok || typeof registered.client_id !== 'string') throw new Error(`Client registration failed (HTTP ${response.status})`)
      clientId = registered.client_id
    }
    const target = oauthEndpoint(endpoints.authorization, 'sign-in page', server.name)
    const scope = auth.scope ?? endpoints.scopes?.join(' ')
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', resource: server.url, ...(scope ? { scope } : {}) })) target.searchParams.set(key, value)
    options.onUrl?.(target.href)
    ;(options.open ?? openBrowser)(target.href)
    const tokens = await postForm(endpoints.token, { grant_type: 'authorization_code', code: await code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: server.url }, server.name, limit.signal)
    writeCache(server, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshToken: tokens.refreshToken, clientId, tokenUrl: endpoints.token })
  } finally {
    clearTimeout(timer)
    listener.close()
  }
}
