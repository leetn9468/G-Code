import { guardedFetch } from '../../security/guard.js'
/**
 * @file WebSearchTool.ts
 * @brief Web search via DuckDuckGo HTML (no API key required)
 */

import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { decodeEntities } from '../../shared/htmlEntities.js'

const inputSchema = z.object({
  query: z.string().min(2).describe('The search query'),
  num_results: z.number().optional().describe('Max results (default 5)'),
})

type SearchInput = z.infer<typeof inputSchema>

interface SearchResult {
  title: string
  url: string
  snippet: string
}

interface SearchOutput {
  query: string
  results: SearchResult[]
}

export const WebSearchTool: Tool<SearchInput, SearchOutput> = {
  name: 'WebSearch',
  description: 'Search the web for current information',
  inputSchema,

  async call(input, _context): Promise<ToolResult<SearchOutput>> {
    const limit = input.num_results ?? 5
    try {
      const encoded = encodeURIComponent(input.query)
      const response = await guardedFetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          'User-Agent': 'G-Code/0.1.0 (AI Coding Agent)',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        return { success: false, error: `Search failed: HTTP ${response.status}` }
      }

      const html = await response.text()
      const results = parseSearchResults(html, limit)

      return { success: true, output: { query: input.query, results } }
    } catch (err) {
      return { success: false, error: `Search failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return { decision: 'allow', reason: 'Read-only web search' }
  },

  prompt(): string {
    return 'WebSearch: Search the web for current information. Returns titles, URLs, and snippets.'
  },
}

export function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  // Match DuckDuckGo result blocks
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = resultPattern.exec(html)) !== null && results.length < limit) {
    const url = decodeURIComponent(match[1]?.replace(/.*uddg=/, '').replace(/&.*/, '') ?? '')
    const title = stripTags(match[2] ?? '').trim()
    const snippet = stripTags(match[3] ?? '').trim()
    if (url && title) {
      results.push({ title, url, snippet })
    }
  }

  // Fallback: try simpler pattern
  if (results.length === 0) {
    const linkPattern = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([^<]+)<\/a>/gi
    while ((match = linkPattern.exec(html)) !== null && results.length < limit) {
      const url = match[1] ?? ''
      const title = decodeEntities(match[2] ?? '').trim()
      if (url && title && !url.includes('duckduckgo.com') && title.length > 5) {
        results.push({ title, url, snippet: '' })
      }
    }
  }

  return results
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
}
