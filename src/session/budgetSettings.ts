import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CLIOptions, AppState } from '../types.js'
import { saveSession, type Store } from '../state/store.js'
import { createBudget, moneyUnits, normalizeBudget, parseBudgetModel, validateBudget } from '../shared/sessionBudget.js'
import { estimatedCost, longPromptThreshold } from '../shared/pricing.js'
import { validUsage } from '../shared/usageTotals.js'
import { sessionBudgetController } from './budget.js'

/** Settings are defaults for new sessions; a saved ledger always owns a resumed limit. */
export function configureSessionBudget(store: Store<AppState>, options: Pick<CLIOptions, 'budgetUsd' | 'budgetReserveUsd' | 'handoffModel'> = {}): void {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(homedir(), '.gcode', 'settings.json'), 'utf8')).execution?.sessionBudget } catch { /* No settings: budgets default off. */ }
  const defaults = normalizeBudget(raw)
  if (options.handoffModel !== undefined && !parseBudgetModel(options.handoffModel)) throw new Error('--handoff-model must be provider:model.')
  const settings = { ...defaults, ...(options.budgetUsd !== undefined ? { enabled: true, limitUsd: options.budgetUsd } : {}),
    ...(options.budgetReserveUsd !== undefined ? { reserveUsd: options.budgetReserveUsd } : {}), ...(options.handoffModel !== undefined ? { handoffModel: options.handoffModel } : {}) }
  if (!Number.isFinite(settings.limitUsd) || settings.limitUsd <= 0 || settings.reserveUsd < 0 || !Number.isFinite(settings.reserveUsd)) throw new Error('Session budget must be positive; its reserve must be nonnegative.')
  if (options.budgetReserveUsd !== undefined && settings.reserveUsd > settings.limitUsd / 2) throw new Error('--budget-reserve-usd must be at most half the session limit.')
  const saved = store.getState().budget
  if (saved) {
    validateBudget(saved)
    if (options.budgetUsd !== undefined && moneyUnits(options.budgetUsd) !== saved.limit) {
      if (moneyUnits(options.budgetUsd) < saved.limit) throw new Error('A saved session budget cannot be lowered or reset. Use a new session explicitly.')
      sessionBudgetController(store, () => saveSession(store.getState())).add(options.budgetUsd - saved.limit / 1_000_000_000)
    }
    if (options.handoffModel) store.setState(s => ({ budget: { ...s.budget!, handoffModel: options.handoffModel } }))
    return
  }
  if (!settings.enabled) return
  const state = store.getState(), totals = state.usageTotals
  let initialSpent = 0
  if (state.messages.length || totals && (totals.requests || totals.incomplete || totals.unreportedRequests || totals.partialRequests || totals.abortedRequests)) {
    const refuse = () => { throw new Error('Previous session spending is incomplete or unpriced. Start a new session explicitly to use Session budget.') }
    if (!totals || !validUsage(totals) || totals.incomplete || totals.unreportedRequests || totals.partialRequests || totals.abortedRequests) refuse()
    const known = totals!
    // A session can have messages after a refused request while still having complete, known zero usage.
    if (known.requests === 0 && known.byModel.length === 0 && known.inputTokens === 0 && known.outputTokens === 0) initialSpent = 0
    else {
      if (known.byModel.some(row => row.provider === 'ollama' || !validUsage(row) || row.inputTokens > (longPromptThreshold(row.provider, row.model) ?? Infinity) && !row.longPrompt)) refuse()
      const cost = estimatedCost(known)
      if (cost === undefined) refuse()
      initialSpent = moneyUnits(cost!)
    }
  }
  store.setState(() => ({ budget: createBudget(settings, initialSpent) }))
}

/** A takeover uses its own endpoint configuration; the originating cloud URL is never reused. */
export function handoffProviderOptions(selection: { provider: string; model: string }, origin: { provider?: string; baseUrl?: string }) {
  let provider: { ollamaHost?: string; localBaseUrl?: string } = {}
  try { provider = JSON.parse(readFileSync(join(homedir(), '.gcode', 'settings.json'), 'utf8')).provider ?? {} } catch { /* Optional local endpoint settings. */ }
  if (selection.provider === 'ollama') return { ...selection, baseUrl: origin.provider === 'ollama' ? origin.baseUrl ?? provider.ollamaHost : provider.ollamaHost }
  if (selection.provider === 'local') return { ...selection, baseUrl: origin.provider === 'local' ? origin.baseUrl : process.env.GCODE_LOCAL_BASE_URL ?? provider.localBaseUrl }
  return selection
}
