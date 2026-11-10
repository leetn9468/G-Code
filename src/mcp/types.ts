/**
 * @file types.ts
 * @brief MCP (Model Context Protocol) type definitions
 */

/**
 * How G-Code authenticates to a remote server. Secrets are read from the environment variable
 * `tokenEnv` (or `clientSecretEnv`), or from `token` when the user chose to keep it in mcp.json.
 */
export type MCPAuthConfig =
  | { type: 'bearer'; token?: string; tokenEnv?: string }
  | { type: 'api_key'; token?: string; tokenEnv?: string; headerName?: string }
  /** OAuth: client credentials when a secret is given, otherwise an interactive login (`gcode mcp login`). */
  | { type: 'oauth2'; clientId?: string; clientSecret?: string; clientSecretEnv?: string; tokenUrl?: string; authorizationUrl?: string; scope?: string }

export interface MCPServerConfig {
  name: string
  /** A local server, started as a child process (stdio). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** A remote server: Streamable HTTP, or the older HTTP+SSE transport ("auto" tries both). */
  url?: string
  transport?: 'auto' | 'http' | 'sse'
  headers?: Record<string, string>
  auth?: MCPAuthConfig
  enabled?: boolean
  /** How long a tool call, resource read or prompt may take, in seconds (see callLimit in client.ts). Connecting and listing keep their own limit. */
  timeoutSeconds?: number
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>
}

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
  /** Hints from the server; readOnlyHint lets calls run alongside other read-only calls. */
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown }
  _meta?: Record<string, unknown>
}

export interface MCPResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPServerConnection {
  config: MCPServerConfig
  tools: MCPToolDefinition[]
  resources: MCPResourceDefinition[]
  status: 'connected' | 'disconnected' | 'error'
  error?: string
}

export interface MCPRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface MCPResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export interface MCPNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface MCPPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface MCPSamplingRequest {
  messages: Array<{ role: string; content: { type: string; text: string } }>
  modelPreferences?: { hints?: Array<{ name?: string }> }
  maxTokens: number
}
