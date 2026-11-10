/** How a remote server is signed in to (src/mcp/types.ts MCPAuthConfig). A token is inline or read from an environment variable. */
export type McpAuth =
  | { type: 'bearer'; token?: string; tokenEnv?: string }
  | { type: 'api_key'; token?: string; tokenEnv?: string; headerName?: string }
  | { type: 'oauth2'; clientId?: string; clientSecret?: string; clientSecretEnv?: string; tokenUrl?: string; authorizationUrl?: string; scope?: string }

/** A local server runs `command`; a remote one is reached at `url`. */
export interface McpServer {
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'auto' | 'http' | 'sse'
  headers?: Record<string, string>
  auth?: McpAuth
  enabled?: boolean
  /** How long its calls may take (src/mcp/config.ts). A bad value costs only this: the default applies. */
  timeoutSeconds?: unknown
  [key: string]: unknown
}
export interface McpConfig { mcpServers: Record<string, McpServer>; [key: string]: unknown }

export function parseMcpArguments(input: string): string[] {
  if (!input.trim()) return []
  let value: unknown
  try { value = JSON.parse(input) } catch { throw new Error('Arguments must be a JSON array, for example ["--path", "/my project"].') }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Every argument must be a string in a JSON array.')
  return value
}

/** The one rule for a server's name (valid_name in mcp_cli.rs, NAME in src/mcp/commands.ts): what the form accepts, Test, Sign in and a chat all accept. */
export function validServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name) && !name.startsWith('-') && name !== 'dsh' && name !== '__proto__'
}

/** What a registry entry still needs before it can run (planServer in src/mcp/registry.ts): `<placeholder>` arguments, empty values. */
export function valuesToFill(server: McpServer): string[] {
  const empty = (section: 'env' | 'headers') => Object.entries(server[section] ?? {}).filter(([, value]) => value === '').map(([key]) => `${section}.${key}`)
  return [...empty('env'), ...empty('headers'), ...(Array.isArray(server.args) ? server.args.filter(arg => /^<.+>$/.test(arg)).map(arg => `args ${arg}`) : [])]
}

const httpUrl = (value: unknown) => {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
const strings = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string'))

/** The CLI's check of "timeoutSeconds" (timeoutProblem in src/mcp/config.ts). It never stops the file from loading. */
export function timeoutProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 3600 ? undefined : '"timeoutSeconds" must be a whole number of seconds from 1 to 3600, so its calls use the default of 120 seconds.'
}

/** Checks what the CLI checks (src/mcp/config.ts), so the desktop never saves a file every session then refuses. */
export function parseMcpConfig(value: unknown): McpConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP configuration must be an object.')
  const servers = (value as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('MCP configuration must contain an mcpServers object.')
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`MCP server ${name} must be an object.`)
    const server = entry as Record<string, unknown>
    const local = typeof server.command === 'string' && server.command !== '', remote = server.url !== undefined
    if (local === remote) throw new Error(`MCP server ${name} needs either a command (local) or a url (remote), not both.`)
    if (remote) {
      if (!httpUrl(server.url)) throw new Error(`MCP server ${name} has a url that is not http or https.`)
      if (server.args !== undefined || server.env !== undefined) throw new Error(`MCP server ${name}: arguments and environment apply to local servers only.`)
      if (server.transport !== undefined && !['auto', 'http', 'sse'].includes(String(server.transport))) throw new Error(`MCP server ${name} has an unknown transport.`)
      if (!strings(server.headers)) throw new Error(`MCP server ${name} has invalid headers.`)
      const auth = server.auth as Record<string, unknown> | undefined
      if (auth !== undefined && (!auth || typeof auth !== 'object' || !['bearer', 'api_key', 'oauth2'].includes(String(auth.type)))) throw new Error(`MCP server ${name} has an unknown sign-in type.`)
    } else {
      if (server.transport !== undefined || server.headers !== undefined || server.auth !== undefined) throw new Error(`MCP server ${name}: transport, headers and sign-in apply to remote servers only.`)
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg: unknown) => typeof arg !== 'string'))) throw new Error(`MCP server ${name} has invalid arguments.`)
      if (!strings(server.env)) throw new Error(`MCP server ${name} has an invalid environment.`)
    }
  }
  return value as McpConfig
}

/**
 * The sign-in a remote server form describes. A token field holding `$NAME` reads the token from
 * that environment variable instead of saving it in mcp.json.
 */
export function remoteAuth(kind: 'none' | 'bearer' | 'api_key' | 'oauth2', token: string, headerName = '', clientId = '', scope = ''): McpAuth | undefined {
  const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(token.trim())
  const secret = variable ? { tokenEnv: variable[1]! } : token.trim() ? { token: token.trim() } : {}
  if (kind === 'bearer') return { type: 'bearer', ...secret }
  if (kind === 'api_key') return { type: 'api_key', ...secret, ...(headerName.trim() ? { headerName: headerName.trim() } : {}) }
  if (kind === 'oauth2') return { type: 'oauth2', ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(scope.trim() ? { scope: scope.trim() } : {}) }
  return undefined
}

/** A short name for a registry entry ("io.github.owner/my-server" → "my-server"), as a server name allows. */
export function serverNameFor(registryName: string): string {
  return (registryName.split('/').pop() ?? registryName).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server'
}
