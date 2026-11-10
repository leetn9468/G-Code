/**
 * @file types.ts
 * @brief LLM client types — provider-agnostic message and tool format
 */

// ============================================================================
// Messages
// ============================================================================

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | (TextBlock | ImageBlock)[]
  is_error?: boolean
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
}
export interface VisionCapabilities {
  provider: string
  maxBytes: number
  maxDimension: number
  maxImages: number
  maxRequestBytes: number
  /** Anthropic: the model takes high-resolution images (2576 px, about 3.75 MP; Opus 4.7 and later). */
  highRes?: boolean
  /**
   * Set by the engine for its tools: the images the next request already carries and the size of
   * its messages, so a read that would take the request over a limit is refused.
   */
  inContext?: () => { images: number; bytes: number }
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  continuation?: ProviderContinuation
}

export interface ProviderContinuation { provider: string; model: string; payload: unknown }
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
export interface TokenCount { tokens: number; source: 'runtime-tokenizer' | 'provider-count'; estimated: boolean }

// ============================================================================
// Tool Definitions (for the API)
// ============================================================================

export interface LLMToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ============================================================================
// Streaming Events
// ============================================================================

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; partial: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'continuation'; continuation: ProviderContinuation }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; error: string }

// ============================================================================
// Client Interface
// ============================================================================

export interface LLMRequestOptions {
  /** Internal: the session budget owns per-attempt admission and disables hidden retries. */
  noRetry?: boolean
  budgetInputTokens?: number
  /** Recheck a reserved request after provider queues, immediately before transport. */
  beforeSend?: () => void
  model: string
  system?: string
  messages: LLMMessage[]
  tools?: LLMToolDefinition[]
  effort?: import('../shared/sessionControls.js').Effort
  maxTokens?: number
  temperature?: number
  stream?: boolean
  signal?: AbortSignal
  /**
   * false: a one-off request nothing repeats (a compaction summary, a handoff). The provider is
   * not asked to cache it, so its input is not billed at the cache-write rate.
   */
  cache?: boolean
  /** Stable conversation identity, never a user name or credential. */
  cacheKey?: string
}

export interface LLMResponse {
  content: ContentBlock[]
  stopReason: string
  usage: TokenUsage
  usageReported?: boolean
  continuation?: ProviderContinuation
  /**
   * For a reply the output limit stopped: the ids of the tool calls whose arguments were cut off
   * (they did not parse, or the provider stopped while writing them). An empty list says every call
   * is complete. Undefined when the adapter cannot tell; the engine then distrusts a final call.
   */
  incompleteToolUse?: string[]
}

export interface LLMClient {
  modelIdentity?(model: string): { provider: string; model: string }
  visionCapabilities?(model: string): VisionCapabilities | undefined
  /** The output limit set by this client's runtime; NO_OUTPUT_LIMIT for local inference. */
  readonly maxOutputTokens?: number
  /** Explicit server context window, when controlled by this application. */
  readonly contextWindow?: number
  /** Explicitly owned llama.cpp client; never inferred from a model name or window size. */
  readonly managedLocal?: boolean
  /** False for a remote endpoint labelled local/Ollama; it cannot be inferred free. */
  readonly budgetLocal?: boolean
  refreshContextWindow?(signal?: AbortSignal): Promise<number | undefined>
  countTokens?(options: LLMRequestOptions): Promise<TokenCount | undefined>
  chat(options: LLMRequestOptions): Promise<LLMResponse>
  chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent>
}
