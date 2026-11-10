import { RedirectRefused, sameOriginFetch } from '../mcp/httpTransport.js'
import { APIError } from './retry.js'

/**
 * A request to a model provider: it carries the key and the whole conversation, so a redirect is
 * followed only on the same origin. fetch would send a 307's body to any address, with every header
 * but Authorization and cookies (Anthropic's key is x-api-key), https to plain http included. Nothing
 * retries a refusal: the next attempt would get the same answer.
 */
export async function providerFetch(url: string | URL, init: RequestInit, send: (url: string, init: RequestInit) => Promise<Response> = (target, options) => fetch(target, options)): Promise<Response> {
  try {
    return await sameOriginFetch(url, init, { send, carries: "this request's API key and conversation", moved: 'If the provider has moved, change its base URL in Settings.' })
  } catch (error) {
    if (error instanceof RedirectRefused) throw new APIError(error.message, error.status, false)
    throw error
  }
}
