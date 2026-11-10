/**
 * @file errorParsing.ts
 * @brief Reads a provider's error: is the prompt over the model's window (and by how much), or was an image refused.
 */

/** A token count as providers print it: digits, with or without thousands commas. */
const COUNT = String.raw`(\d[\d,]*)`

/**
 * Provider wordings of "the prompt has N tokens and the limit is M", with the capture group that
 * holds each number. The provider-specific forms come first: their numbers are in a fixed order.
 */
const TOKEN_COUNT_FORMS: Array<{ pattern: RegExp; actual: 1 | 2; limit: 1 | 2 }> = [
  // OpenAI: "maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens"
  { pattern: new RegExp(String.raw`maximum context length is ${COUNT} tokens.*?(?:resulted in|requested) ${COUNT} tokens`, 'i'), actual: 2, limit: 1 },
  // Gemini: "The input token count (1234567) exceeds the maximum number of tokens allowed (1048576)"
  { pattern: new RegExp(String.raw`input token count \(${COUNT}\) exceeds the maximum number of tokens allowed \(${COUNT}\)`, 'i'), actual: 1, limit: 2 },
  // llama.cpp: "request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it"
  { pattern: new RegExp(String.raw`\(${COUNT} tokens\) exceeds the available context size \(${COUNT} tokens\)`, 'i'), actual: 1, limit: 2 },
  // Anthropic: "prompt is too long: 215000 tokens > 200000 maximum"; also "215000 tokens exceeds 200000"
  { pattern: new RegExp(String.raw`${COUNT}\s*tokens?\s*(?:>|exceeds?|over)\s*${COUNT}`, 'i'), actual: 1, limit: 2 },
  // "215000 / 200000 tokens"
  { pattern: new RegExp(String.raw`${COUNT}\s*/\s*${COUNT}\s*tokens?`, 'i'), actual: 1, limit: 2 },
  // "actual: 215000, limit: 200000"
  { pattern: new RegExp(String.raw`actual[:\s]+${COUNT}.*limit[:\s]+${COUNT}`, 'i'), actual: 1, limit: 2 },
]

/** The prompt's size and the model's limit, in tokens, from a "prompt too long" error, or null when the text gives neither. */
export function parsePromptTooLongTokenCounts(message: string): { actualTokens: number; limitTokens: number } | null {
  for (const { pattern, actual, limit } of TOKEN_COUNT_FORMS) {
    const match = pattern.exec(message)
    if (!match) continue
    const actualTokens = Number(match[actual]!.replace(/,/g, ''))
    const limitTokens = Number(match[limit]!.replace(/,/g, ''))
    if (actualTokens > 0 && limitTokens > 0) return { actualTokens, limitTokens }
  }
  return null
}

/** What the provider said, without a readable lead added around it. */
function providerText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '')
  const { providerMessage, message } = error as { providerMessage?: unknown; message?: unknown }
  return typeof providerMessage === 'string' ? providerMessage : typeof message === 'string' ? message : ''
}
const status = (error: unknown) => (error as { statusCode?: unknown } | null)?.statusCode

/**
 * The provider refused the request because the prompt is larger than the model's window: an
 * HTTP 400 or 413 that says so. Sending the same context again fails the same way.
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (status(error) !== 400 && status(error) !== 413) return false
  const text = providerText(error)
  return /prompt is too long|context.length.exceeded|maximum context length|too many (?:input )?tokens|exceeds the (?:model's )?context window|input token count .* exceeds the maximum|exceeds the available context size/i.test(text)
    || (status(error) === 413 && (error as { type?: unknown }).type === 'request_too_large' && parsePromptTooLongTokenCounts(text) !== null)
}

/** The provider could not read an image in the request (corrupt, truncated, or a format it does not take). */
export function isImageRejection(error: unknown): boolean {
  if (status(error) !== 400) return false
  return /\bimage/i.test(providerText(error)) && !isPromptTooLongError(error)
}
