/**
 * @file config.ts
 * @brief Parse MCP server configuration from .gcode/mcp.json
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MCPConfig, MCPServerConfig } from './types.js'
import { z } from 'zod'

const secret = { token: z.string().optional(), tokenEnv: z.string().min(1).optional() }
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), ...secret }).strict(),
  z.object({ type: z.literal('api_key'), ...secret, headerName: z.string().min(1).optional() }).strict(),
  z.object({
    type: z.literal('oauth2'), clientId: z.string().min(1).optional(), clientSecret: z.string().optional(), clientSecretEnv: z.string().min(1).optional(),
    tokenUrl: z.string().url().optional(), authorizationUrl: z.string().url().optional(), scope: z.string().optional(),
  }).strict(),
])
/** How long a tool call may take when a server's entry does not say. */
export const DEFAULT_CALL_TIMEOUT_SECONDS = 120
/** A longer call needs no limit of G-Code's: Stop ends a waiting call whatever its limit. */
export const MAX_CALL_TIMEOUT_SECONDS = 3600

/** What is wrong with a server's "timeoutSeconds"; undefined when it is usable or not set. */
export function timeoutProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CALL_TIMEOUT_SECONDS
    ? undefined : `"timeoutSeconds" must be a whole number of seconds from 1 to ${MAX_CALL_TIMEOUT_SECONDS}`
}

const remoteUrl = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'url must be http or https')
const serverSchema = z.object({
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(),
  url: remoteUrl.optional(), transport: z.enum(['auto', 'http', 'sse']).optional(),
  headers: z.record(z.string()).optional(), auth: authSchema.optional(), enabled: z.boolean().optional(),
  // Checked per server where it is used (timeoutProblem): every project reads this one file, and one bad number must not cost the other servers.
  timeoutSeconds: z.unknown().optional(),
}).superRefine((server, context) => {
  if (!server.command === !server.url) context.addIssue({ code: z.ZodIssueCode.custom, message: 'a server needs either "command" (local) or "url" (remote), not both' })
  else if (server.command && (server.transport || server.headers || server.auth)) context.addIssue({ code: z.ZodIssueCode.custom, message: '"transport", "headers" and "auth" apply to remote servers ("url") only' })
  else if (server.url && (server.args || server.env)) context.addIssue({ code: z.ZodIssueCode.custom, message: '"args" and "env" apply to local servers ("command") only' })
})
const configSchema = z.object({ mcpServers: z.record(serverSchema) })

/**
 * Load servers explicitly configured in user settings. Opening a project must
 * not execute commands from its untrusted .gcode/mcp.json automatically.
 */
export function loadMCPConfig(cwd: string): MCPConfig {
  const globalPath = mcpConfigPath()
  const projectPath = join(cwd, '.gcode', 'mcp.json')

  const globalConfig = loadConfigFile(globalPath)
  if (existsSync(projectPath) && projectPath !== globalPath) {
    process.stderr.write('[mcp] Project MCP configuration was not loaded. Add and enable trusted servers in MCP Settings to use them.\n')
  }
  return globalConfig
}

/** Checks a whole mcp.json object (throws the first problem). */
export function validateConfig(value: unknown): MCPConfig {
  const parsed = configSchema.safeParse(value)
  if (parsed.success) return parsed.data as MCPConfig
  const issue = parsed.error.issues[0]!
  throw new Error(`${issue.path.join('.') || 'mcp.json'}: ${issue.message}`)
}

/** The user's MCP configuration file (the only one G-Code loads). */
export function mcpConfigPath(): string { return join(homedir(), '.gcode', 'mcp.json') }

export function loadConfigFile(path: string): MCPConfig {
  if (!existsSync(path)) return { mcpServers: {} }

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)

    return validateConfig(parsed)
  } catch (error) {
    throw new Error(`Cannot load MCP configuration ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Get enabled servers from config.
 */
export function getEnabledServers(config: MCPConfig): MCPServerConfig[] {
  return Object.entries(config.mcpServers)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, server]) => ({ ...server, name }))
}
