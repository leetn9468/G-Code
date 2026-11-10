/**
 * How a provider ended a reply, in the terms the engine acts on. A reply counts as finished only
 * when the provider says so: any reason not listed here (a new one, a compatible server's own, a
 * pause) is not a finish. Taking it for one saved a reply stopped part way as a completed turn, and
 * a sub-agent's as a success its parent then built on.
 */
export type ReplyEnd = 'finished' | 'output-limit' | 'refused' | 'incomplete'

/** Anthropic, OpenAI-compatible (eos and eos_token: servers that name the end-of-sequence token). */
const FINISHED = new Set(['end_turn', 'stop_sequence', 'tool_use', 'stop', 'tool_calls', 'function_call', 'eos', 'eos_token'])
const OUTPUT_LIMIT = new Set(['max_tokens', 'length'])
/** The adapters report Gemini's safety blocks as 'refusal'. */
const REFUSED = new Set(['refusal', 'content_filter'])

export function replyEnd(stopReason: string): ReplyEnd {
  // The value comes off the wire: a server's number or null reads as an unknown reason, not a crash.
  const reason = String(stopReason).toLowerCase()
  return FINISHED.has(reason) ? 'finished' : OUTPUT_LIMIT.has(reason) ? 'output-limit' : REFUSED.has(reason) ? 'refused' : 'incomplete'
}

/** What the known reasons mean, for the person reading why a reply stopped. */
const MEANINGS = new Map([
  ['content_filter', "the provider's content filter stopped it"],
  ['model_context_window_exceeded', "the model's context window ran out"],
  ['insufficient_system_resource', 'the provider ran out of system resources'],
  ['pause_turn', 'the provider paused it'],
  ['malformed_function_call', 'the model wrote a tool call the provider could not read'],
  ['unexpected_tool_call', 'the model called a tool it was not offered'],
  ['too_many_tool_calls', 'the model made too many tool calls'],
])

/** A stop reason in a few words. It comes from the provider, so an unknown one is shown shortened and as plain characters. */
export function replyEndWords(stopReason: string): string {
  const reason = String(stopReason)
  const known = MEANINGS.get(reason.toLowerCase())
  if (known) return known
  return `the provider gave the reason "${reason.replace(/[^\w .:-]/g, '').slice(0, 60)}"`
}
