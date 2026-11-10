/** Published model windows, shared by the engine and settings presets. */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Published capacities checked 2026-10-15; unknown models stay labelled fallback.
  'gpt-4o': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-5': 400_000,
  'gpt-5-2025-08-07': 400_000,
  // Published 2026-10-30: 1,050,000 window, 922,000 max input; the input limit is the budget.
  'gpt-6.1-terra': 922_000,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'deepseek-flash': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-haiku-3-20250307': 200_000,
  // Default fallback
  default: 200_000,
}

export function contextLimitSource(model: string): 'model-default' | 'fallback' { return model in MODEL_CONTEXT_LIMITS ? 'model-default' : 'fallback' }

export function getContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? MODEL_CONTEXT_LIMITS['default']!
}
