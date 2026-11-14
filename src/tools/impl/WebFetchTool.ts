import { guardedFetch } from '../../security/guard.js'
/**
 * @file WebFetchTool.ts
 * @brief Fetch URL content with HTML→text conversion and truncation
 *
 * No external dependencies — uses built-in guardedFetch() and regex-based
 * HTML stripping. Output capped at 30KB to manage context size.
 */

import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { headUnits } from '../../utils/textUnits.js'
import { maskSecrets } from '../../security/secretValues.js'
import { connectionSignal } from '../../mcp/httpTransport.js'
import { decodeEntities } from '../../shared/htmlEntities.js'
import { approveWebHost, isWebHostApproved, webTarget } from '../../session/scopedPermission.js'
import { webFetchReason } from '../permissions.js'

const inputSchema = z.object({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z.string().optional().describe('What to extract from the page'),
})

type WebFetchInput = z.infer<typeof inputSchema>

interface WebFetchOutput {
  url: string
  status: number
  contentType: string
  content: string
  truncated: boolean
  bytesFetched: number
}

const MAX_OUTPUT_CHARS = 30_000
const FETCH_TIMEOUT_MS = 15_000
/** How long the body of a page may take once its headers have come. */
const BODY_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2MB max download
/** Redirects followed within approved hosts; a redirect to another host stops and says where it leads. */
const MAX_REDIRECTS = 5

export const WebFetchTool: Tool<WebFetchInput, WebFetchOutput> = {
  name: 'WebFetch',
  description: 'Fetch content from a URL and convert HTML to readable text',
  inputSchema,

  async call(input, context): Promise<ToolResult<WebFetchOutput>> {
    // Auto-upgrade HTTP to HTTPS; nothing but http and https is fetched (file: would read local files).
    const target = webTarget(input.url)
    if (!target) return { success: false, error: 'WebFetch only fetches http and https URLs.' }
    let url = target.url
    // This call runs because its host was approved (or an allow rule covers WebFetch): the host
    // stays approved for the rest of the session. Bypass mode approves nothing for later.
    if (!context.webFetchRuleHost && context.getPermissionContext?.().mode !== 'bypass') approveWebHost(target.host)

    // Each hop's fetch gets a signal it ends with: in Bun, cancelling a body or stopping to read it
    // leaves the connection open, and a long body goes on arriving (see connectionSignal).
    let endConnection = () => {}
    let limit = FETCH_TIMEOUT_MS
    try {
      const controller = new AbortController()
      let timer = setTimeout(() => controller.abort(), limit)

      let response: Response
      try {
        // Redirects are followed by hand: each hop must stay on an approved host.
        for (let hops = 0; ; hops++) {
          const hop = connectionSignal(controller.signal, ...(context.signal ? [context.signal] : []))
          endConnection = hop.release
          response = await guardedFetch(url, {
            signal: hop.connection,
            headers: {
              'User-Agent': 'G-Code/0.1.1 (AI Coding Agent)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
            },
            redirect: 'manual',
          })
          const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
          if (!location) break
          void response.body?.cancel().catch(() => {})
          hop.release()
          let nextUrl: string
          try { nextUrl = new URL(location, url).toString() } catch { return { success: false, error: `HTTP ${response.status}: redirect to an invalid URL` } }
          const next = webTarget(nextUrl)
          if (!next) return { success: false, error: `HTTP ${response.status}: redirected to ${nextUrl}, which is not an http or https URL. Not followed.` }
          if (next.host !== target.host && (context.webFetchRuleHost || !isWebHostApproved(next.host))) {
            const content = `Redirected (HTTP ${response.status}) to ${next.url}, on another host (${next.host}). WebFetch did not follow it. To fetch it, call WebFetch with that URL; the new host needs the user's approval.`
            return { success: true, output: { url, status: response.status, contentType: 'redirect', content, truncated: false, bytesFetched: 0 } }
          }
          if (hops >= MAX_REDIRECTS) return { success: false, error: `Too many redirects (more than ${MAX_REDIRECTS}), last to ${next.url}` }
          url = next.url
        }
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        }
      }

      const contentType = response.headers.get('content-type') ?? 'unknown'

      // Read body with size limit
      limit = BODY_TIMEOUT_MS
      timer = setTimeout(() => controller.abort(), limit)
      let rawBody: string
      try { rawBody = await readBodyWithLimit(response, MAX_BODY_BYTES) } finally { clearTimeout(timer) }
      const bytesFetched = rawBody.length

      // Convert to text
      let text: string
      if (contentType.includes('html') || contentType.includes('xhtml')) {
        text = htmlToText(rawBody)
      } else if (contentType.includes('json')) {
        try {
          const parsed = JSON.parse(rawBody)
          text = JSON.stringify(parsed, null, 2)
        } catch {
          text = rawBody
        }
      } else {
        text = rawBody
      }

      // Truncate, after masking: a key across the cut would no longer read as a key.
      const masked = maskSecrets(text)
      const truncated = masked.length > MAX_OUTPUT_CHARS
      const content = truncated ? headUnits(masked, MAX_OUTPUT_CHARS) + '\n\n[Content truncated]' : masked

      return {
        success: true,
        output: {
          url,
          status: response.status,
          contentType,
          content,
          truncated,
          bytesFetched,
        },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (context.signal?.aborted) return { success: false, error: `Stopped before the fetch finished: ${url}` }
      if (msg.includes('abort')) {
        return { success: false, error: `Fetch timed out after ${limit}ms: ${url}` }
      }
      return { success: false, error: `Fetch failed: ${msg}` }
    } finally {
      endConnection()
    }
  },

  async checkPermissions(input, _context): Promise<PermissionResult> {
    const target = webTarget(input.url)
    if (!target) return { decision: 'deny', reason: 'WebFetch only fetches http and https URLs.' }
    // Each new host asks once; an approved host stays approved for the rest of the session.
    if (isWebHostApproved(target.host)) return { decision: 'allow', reason: `Fetch from ${target.host} (approved in this session)` }
    return { decision: 'ask', reason: webFetchReason(target) }
  },

  prompt(): string {
    return 'WebFetch: Fetch content from an http or https URL. HTML is converted to readable text. Max 30KB output. The first fetch from each host asks the user; a redirect to another host is reported, not followed.'
  },
}

// ============================================================================
// HTML → Text Conversion (regex-based, no dependencies)
// ============================================================================

function htmlToText(html: string): string {
  let text = html

  // Remove script and style blocks entirely
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')

  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|blockquote|figure|figcaption)[^>]*>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/?(h[1-6])[^>]*>/gi, '\n')
  text = text.replace(/<\/?(ul|ol|dl)[^>]*>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '\n- ')
  text = text.replace(/<\/li>/gi, '')
  text = text.replace(/<dt[^>]*>/gi, '\n')
  text = text.replace(/<dd[^>]*>/gi, '\n  ')
  text = text.replace(/<hr[^>]*>/gi, '\n---\n')
  text = text.replace(/<tr[^>]*>/gi, '\n')
  text = text.replace(/<td[^>]*>/gi, '\t')
  text = text.replace(/<th[^>]*>/gi, '\t')

  // Extract link text with URL
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')

  // Extract image alt text
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, '[$1]')

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode HTML entities
  text = decodeEntities(text)

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n')
  text = text.trim()

  return text
}

// ============================================================================
// Body Reading with Size Limit
// ============================================================================

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.length
      if (totalBytes > maxBytes) {
        result += decoder.decode(value.slice(0, maxBytes - (totalBytes - value.length)), { stream: false })
        break
      }

      result += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }

  return result
}
