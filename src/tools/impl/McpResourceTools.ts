/**
 * @file McpResourceTools.ts
 * @brief The resources of the connected MCP servers, for the model: one tool lists them, one reads
 *        one by URI. Registered by initMCP when a server offers resources.
 */

import { z } from 'zod'
import type { Tool, ToolResult } from '../tool.js'
import type { ImageBlock } from '../../llm/types.js'
import { getMCPClients } from '../../mcp/manager.js'
import { currentGuard } from '../../security/guard.js'
import { headUnits } from '../../utils/textUnits.js'

/** What a read returns inline at most; the rest is cut with a note. */
const TEXT_LIMIT = 100_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const clientFor = (server: string) => getMCPClients().find(client => client.server.name === server)

export const ListMcpResourcesTool: Tool<{ server?: string }, string> = {
  name: 'ListMcpResources',
  description: 'List the resources (documents, records, files) the connected MCP servers offer, with their URIs. Read one with ReadMcpResource.',
  inputSchema: z.object({ server: z.string().min(1).optional().describe('Only this MCP server') }).strict(),
  concurrencySafe: true,
  async call({ server }): Promise<ToolResult<string>> {
    const clients = getMCPClients().filter(client => !server || client.server.name === server)
    if (server && !clients.length) return { success: false, error: `No connected MCP server is named "${server}".` }
    const lines: string[] = []
    for (const client of clients) for (const resource of client.resources) {
      lines.push(`${client.server.name}: ${resource.uri}${resource.name && resource.name !== resource.uri ? ` (${resource.name})` : ''}${resource.mimeType ? ` [${resource.mimeType}]` : ''}${resource.description ? ` — ${resource.description}` : ''}`)
    }
    return { success: true, output: lines.length ? lines.join('\n') : 'The connected MCP servers offer no resources.' }
  },
  async checkPermissions() { return { decision: 'allow' } },
  prompt() { return 'ListMcpResources: list the resources the connected MCP servers offer.' },
}

export const ReadMcpResourceTool: Tool<{ server: string; uri: string }, string> = {
  name: 'ReadMcpResource',
  description: 'Read one resource of a connected MCP server by its URI (from ListMcpResources). Text comes back inline; images are shown to you.',
  inputSchema: z.object({ server: z.string().min(1).describe('The MCP server name'), uri: z.string().min(1).describe('The resource URI') }).strict(),
  concurrencySafe: true,
  async call({ server, uri }, context): Promise<ToolResult<string>> {
    const client = clientFor(server)
    if (!client) return { success: false, error: `No connected MCP server is named "${server}".` }
    // Guillotine Mode: like an MCP tool call, the read gets its own connection inside this call.
    const owned = currentGuard() ? client.fresh() : undefined
    try {
      if (owned) await owned.connect(context.signal)
      const contents = await (owned ?? client).readResource(uri, context.signal)
      const texts: string[] = [], images: ImageBlock[] = []
      for (const item of contents) {
        if (typeof item.text === 'string') texts.push(contents.length > 1 ? `--- ${item.uri}\n${item.text}` : item.text)
        else if (typeof item.blob === 'string' && item.mimeType && IMAGE_TYPES.has(item.mimeType) && item.blob.length <= 7_000_000) {
          images.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType as ImageBlock['source']['media_type'], data: item.blob } })
          texts.push(`[${item.uri}: ${item.mimeType} image, shown]`)
        } else if (typeof item.blob === 'string') texts.push(`[${item.uri}: ${item.mimeType ?? 'binary'} content, ${Math.floor(item.blob.length * 3 / 4)} bytes, not shown]`)
      }
      let text = texts.join('\n\n') || 'The resource is empty.'
      if (text.length > TEXT_LIMIT) text = `${headUnits(text, TEXT_LIMIT)}\n[Resource cut at ${TEXT_LIMIT} characters of ${text.length}.]`
      return { success: true, output: text, ...(images.length ? { contentBlocks: [{ type: 'text', text }, ...images] } : {}) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally { await owned?.disconnect() }
  },
  async checkPermissions() { return { decision: 'allow' } },
  prompt() { return 'ReadMcpResource: read a resource of a connected MCP server by URI.' },
}
