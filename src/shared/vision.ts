import type { VisionCapabilities } from '../llm/types.js'

// Pure (no Node APIs): the desktop imports it to check attachments before it sends them.
const MiB = 1024 * 1024
/** Anthropic models before the high-resolution tier (Opus 4.7 onwards): 1568 px, about 1.15 MP. */
const STANDARD_RES_ANTHROPIC = /^(?:claude-3|claude-(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?$)/
/** Conservative inline-image policies; unknown and compatible endpoints opt out. GPT-6.1 Terra takes text and image input (model page, 2026-10-30). */
export function visionCapabilities(provider: string, model: string): VisionCapabilities | undefined {
  if (provider === 'anthropic' && /^(claude-3-|claude-(?:opus|sonnet|haiku)-[45](?:[.-]|$))/.test(model)) return { provider, maxBytes: 5 * MiB, maxDimension: 8000, maxImages: 20, maxRequestBytes: 32 * MiB, highRes: !STANDARD_RES_ANTHROPIC.test(model) }
  if (provider === 'openai' && /^(gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$|gpt-4\.1(?:-|$)|gpt-4-turbo(?:-|$)|gpt-5(?:[.-]|$)|gpt-6\.1-terra(?:-|$)|o1(?:-\d|$)|o3(?:-\d|$)|o4-mini(?:-|$))/.test(model)) return { provider, maxBytes: 20 * MiB, maxDimension: 8192, maxImages: 20, maxRequestBytes: 50 * MiB }
  if (provider === 'gemini' && /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.1)?)-/.test(model)) return { provider, maxBytes: 4 * MiB, maxDimension: 4096, maxImages: 20, maxRequestBytes: 20 * MiB }
}
