import type { Effort } from './sessionControls.js'

/** Model-gated wire settings. Extra/Max never imply five native levels exist. */
export function nativeEffort(provider: string, model: string, effort: Effort, maxTokens: number): Record<string, unknown> {
  const basic = effort === 'extra' || effort === 'max' ? 'high' : effort
  if (provider === 'openai' && /^(o[134](?:-|$)|gpt-5(?:[.-]|$)|gpt-6(?:[.-]|$))/.test(model) && !/chat|pro/.test(model)) {
    const extended = /^gpt-(?:5\.[23456]|6)/.test(model)
    return { reasoning_effort: extended && (effort === 'extra' || effort === 'max') ? 'xhigh' : basic }
  }
  if (provider === 'anthropic' && /^claude-(?:opus-4-[5678]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/.test(model)) {
    const supportsMax = !/^claude-opus-4-5/.test(model)
    const supportsExtra = !/^claude-(?:opus-4-[56]|sonnet-4-6)/.test(model)
    return { output_config: { effort: effort === 'max' && supportsMax ? 'max' : effort === 'extra' && supportsExtra ? 'xhigh' : basic } }
  }
  if (provider === 'gemini' && /^gemini-[34](?:[.-]|$)/.test(model)) {
    // Gemini 3 Pro only has low/high; flash and later families have medium.
    const level = effort === 'medium' && /^gemini-3(?:\.1)?-pro/.test(model) ? 'high' : basic
    return { thinkingConfig: { thinkingLevel: level } }
  }
  const budgets = { low: 1024, medium: 4096, high: 8192, extra: 12288, max: 24576 }
  if (provider === 'gemini' && /^gemini-2\.5-/.test(model)) return { thinkingConfig: { thinkingBudget: Math.min(budgets[effort], Math.max(128, maxTokens - 1024)) } }
  if (provider === 'deepseek' && /^(deepseek-v4|deepseek-flash)/.test(model)) return { thinking: { type: 'enabled' }, reasoning_effort: effort === 'low' ? 'low' : effort === 'max' ? 'max' : 'high' }
  if (provider === 'qwen' && /^qwen3(?:[.-]|$)/.test(model) && !/coder|instruct|omni/.test(model)) return { enable_thinking: true, thinking_budget: Math.min(budgets[effort], Math.max(1, maxTokens - 1024)) }
  return {}
}
