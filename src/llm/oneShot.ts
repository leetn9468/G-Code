import type { LLMClient } from './types.js'

/**
 * The client for one-off requests nothing repeats: a compaction summary, a handoff document. Each
 * sends its own system prompt and transcript with no tools, so no later request reads its prefix
 * back from the cache; it is sent with `cache: false` and its input is billed at the plain rate,
 * not the cache-write rate. Everything else (usage tracking, limits, retries) is the wrapped
 * client's.
 */
export function oneShot(client: LLMClient): LLMClient {
  return {
    get contextWindow() { return client.contextWindow },
    get managedLocal() { return client.managedLocal },
    get budgetLocal() { return client.budgetLocal },
    refreshContextWindow: client.refreshContextWindow?.bind(client),
    maxOutputTokens: client.maxOutputTokens,
    visionCapabilities: client.visionCapabilities?.bind(client),
    modelIdentity: client.modelIdentity?.bind(client),
    countTokens: client.countTokens?.bind(client),
    chat: request => client.chat({ ...request, cache: request.cache ?? false }),
    chatStream: request => client.chatStream({ ...request, cache: request.cache ?? false }),
  }
}
