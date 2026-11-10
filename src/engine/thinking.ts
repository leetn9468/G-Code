/**
 * @file thinking.ts
 * @brief Extended thinking configuration and budget management
 */

export interface ThinkingConfig {
  enabled: boolean
  budgetTokens: number
}

const DEFAULT_BUDGET = 10_000

let config: ThinkingConfig = {
  enabled: false,
  budgetTokens: DEFAULT_BUDGET,
}

export function setThinkingConfig(c: Partial<ThinkingConfig>): void {
  if (c.enabled !== undefined) config.enabled = c.enabled
  if (c.budgetTokens !== undefined) config.budgetTokens = c.budgetTokens
}

export function getThinkingConfig(): Readonly<ThinkingConfig> {
  return config
}

/**
 * Build thinking parameter for Anthropic API.
 * Returns the thinking block to include in the request body, or undefined.
 */
export function buildThinkingParam(): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!config.enabled) return undefined
  return { type: 'enabled', budget_tokens: config.budgetTokens }
}
