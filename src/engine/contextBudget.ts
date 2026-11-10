import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContextStatus } from '../shared/sessionControls.js'

/**
 * A user-set ceiling on the context the engine fills, so a 1M-token model does
 * not have to run up a 1M-token bill before compaction or a handoff.
 *
 * - `execution.contextBudget` in ~/.gcode/settings.json: an integer from 100,000 to 2,000,000.
 * - `GCODE_CONTEXT_LIMIT` (an integer of at least 8,000) overrides it, so tests can reach the threshold cheaply.
 *
 * Both are read again on every call; the engine reads them once per turn.
 */
export const CONTEXT_BUDGET_RANGE = { min: 100_000, max: 2_000_000 } as const
export const CONTEXT_LIMIT_ENV = 'GCODE_CONTEXT_LIMIT'
export const CONTEXT_LIMIT_ENV_MIN = 8_000

export type ContextLimitSource = ContextStatus['limitSource'] | 'budget'
export interface ContextWindow { limit: number; source: ContextLimitSource }

const warned = new Set<string>()
function warnOnce(message: string, key = message): void {
  if (warned.has(key)) return
  warned.add(key)
  process.stderr.write(`[context] ${message}\n`)
}

function fromEnvironment(): number | undefined {
  const raw = process.env[CONTEXT_LIMIT_ENV]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (/^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= CONTEXT_LIMIT_ENV_MIN) return value
  warnOnce(`Ignoring ${CONTEXT_LIMIT_ENV}=${JSON.stringify(raw.slice(0, 40))}: it must be an integer of at least ${CONTEXT_LIMIT_ENV_MIN}.`)
  return undefined
}

function fromSettings(): number | undefined {
  // Resolved at call time: the home directory can change under tests and the desktop rewrites the file.
  const file = join(homedir(), '.gcode', 'settings.json')
  let value: unknown
  try {
    const execution = (JSON.parse(readFileSync(file, 'utf8')) as { execution?: unknown } | null)?.execution
    value = execution && typeof execution === 'object' ? (execution as { contextBudget?: unknown }).contextBudget : undefined
  } catch { return undefined } // No settings file, or one other readers already report as invalid.
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 50_000 && value < CONTEXT_BUDGET_RANGE.min) {
    warnOnce('Saved context budget raised to 100,000 tokens to leave room for the system prompt and reply reserve.', `${file}:context-budget-migration`)
    return CONTEXT_BUDGET_RANGE.min
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= CONTEXT_BUDGET_RANGE.min && value <= CONTEXT_BUDGET_RANGE.max) return value
  warnOnce(`Ignoring execution.contextBudget ${JSON.stringify(value)?.slice(0, 40)} in ${file}: it must be an integer from ${CONTEXT_BUDGET_RANGE.min} to ${CONTEXT_BUDGET_RANGE.max}.`)
  return undefined
}

/** The user's context budget in tokens, or undefined when none is set. */
export function contextBudget(managedLocal = false): number | undefined {
  return fromEnvironment() ?? (managedLocal ? undefined : fromSettings())
}

/** The limit the engine works to: the model's or runtime's window, lowered to the budget when that is smaller. */
export function effectiveContextWindow(limit: number, source: ContextStatus['limitSource'], budget = contextBudget()): ContextWindow {
  return budget !== undefined && budget < limit ? { limit: budget, source: 'budget' } : { limit, source }
}
