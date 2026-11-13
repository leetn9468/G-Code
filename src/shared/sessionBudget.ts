import { LONG_PROMPT_PRICING, PRICING } from './pricing.js'
import type { TokenUsage } from '../llm/types.js'
import { validUsage } from './usageTotals.js'
import { handoffContinuation } from './execution.js'
import { attachmentRefsFrom, type AttachmentRef } from './attachments.js'

/** Nano-dollars keep tiny requests nonzero without floating-point ledger sums. */
export const MONEY_SCALE = 1_000_000_000
export const moneyUnits = (usd: number): number => {
  if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000) throw new Error('Invalid session budget amount.')
  return Math.ceil(usd * MONEY_SCALE)
}
export const moneyLabel = (units: number) => `$${units > 0 && units < 100_000 ? (units / MONEY_SCALE).toFixed(9).replace(/0+$/, '') : (units / MONEY_SCALE).toFixed(4)}`
export interface BudgetSettings { enabled: boolean; limitUsd: number; reserveUsd: number; handoffModel?: string }
export const DEFAULT_BUDGET: BudgetSettings = { enabled: false, limitUsd: 5, reserveUsd: .5 }
export function normalizeBudget(value: unknown): BudgetSettings {
  const v = value as Partial<BudgetSettings> | null
  const limitUsd = typeof v?.limitUsd === 'number' && v.limitUsd > 0 && v.limitUsd <= 1_000_000 && Number.isFinite(v.limitUsd) ? v.limitUsd : 5
  const reserveUsd = typeof v?.reserveUsd === 'number' && v.reserveUsd >= 0 && Number.isFinite(v.reserveUsd) ? Math.min(v.reserveUsd, limitUsd / 2) : Math.min(.5, limitUsd / 2)
  return { enabled: v?.enabled === true, limitUsd, reserveUsd, ...(typeof v?.handoffModel === 'string' && parseBudgetModel(v.handoffModel) ? { handoffModel: v.handoffModel.trim() } : {}) }
}
export function parseBudgetModel(value: string): { provider: string; model: string } | undefined {
  const match = /^(anthropic|openai|gemini|deepseek|qwen|ollama|local):(.+)$/.exec(value.trim())
  return match && match[2]!.trim() && !/[\x00-\x1f\x7f]/.test(value) ? { provider: match[1]!, model: match[2]!.trim() } : undefined
}
export function budgetPrice(provider: string, model: string, inputTokens = Infinity) {
  if (provider === 'local' || provider === 'ollama') return { input: 0, output: 0, read: 0, write: 0 }
  const key = `${provider}:${model}`, long = LONG_PROMPT_PRICING[key]
  return long && inputTokens > long.threshold ? long : PRICING[key]
}
export function localBudgetEndpoint(value: string | undefined): boolean {
  try { const url = new URL(value?.includes('://') ? value : `http://${value || 'localhost:11434'}`); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)) } catch { return false }
}
export function budgetModelProblem(provider: string, model: string, localEndpoint = true): string | undefined {
  if ((provider === 'ollama' || provider === 'local') && !localEndpoint) return 'No price is available for a remote local-model endpoint. Session budget only treats loopback local models as $0.'

  return budgetPrice(provider, model) ? undefined : `No price is available for ${model || 'this model'}. Choose a priced or local model to use Session budget.`
}
export interface BudgetRequest {
  id: string; stage: number; at: number; provider: string; model: string; purpose: 'task' | 'handoff'
  reserved: number; outputLimit: number; status: 'reserved' | 'unconfirmed' | 'settled' | 'rejected'
  charged?: number; usage?: TokenUsage
}
export interface BudgetHandoff {
  path: string; summary: string; request: string; author: string; writerCost: number; at: number; limit: number
  saveError?: string
  /** Files attached to the request (src/shared/attachments.ts): the continuation sends them again. */
  attachments?: AttachmentRef[]
}
export interface BudgetStage { number: number; limit: number; reserve: number; spentAtStart: number; spentAtEnd?: number; handoff?: BudgetHandoff }
export interface SessionBudget {
  version: 1; limit: number; reserve: number; stage: number; phase: 'active' | 'writing' | 'held'
  initialSpent: number; requests: BudgetRequest[]; stages: BudgetStage[]; handoffModel?: string
  pendingRequest?: string; reason?: string; writerLimit?: number; writerAllowance?: number; handoff?: BudgetHandoff
}
export function createBudget(settings: BudgetSettings, initialSpent = 0): SessionBudget {
  const limit = moneyUnits(settings.limitUsd), reserve = Math.min(moneyUnits(settings.reserveUsd), Math.floor(limit / 2))
  return { version: 1, limit, reserve, stage: 1, phase: 'active', initialSpent, requests: [], stages: [{ number: 1, limit, reserve, spentAtStart: initialSpent }], handoffModel: settings.handoffModel }
}
export const budgetSpent = (budget: SessionBudget): number => budget.initialSpent + budget.requests.reduce((sum, request) => sum + (request.charged ?? request.reserved), 0)
export const budgetHeld = (budget: SessionBudget): number => budget.requests.reduce((sum, request) => sum + (request.charged === undefined ? request.reserved : 0), 0)
export const budgetWriterSpent = (budget: SessionBudget): number => budget.requests.filter(r => r.stage === budget.stage && r.purpose === 'handoff').reduce((sum, r) => sum + (r.charged ?? r.reserved), 0)
export const budgetWriterRemaining = (budget: SessionBudget): number => Math.max(0, Math.min(budget.limit - budgetSpent(budget), (budget.writerAllowance ?? 0) - budgetWriterSpent(budget)))

/** Missing/invalid saved accounting is an error, never a free reset. */
export function validateBudget(budget: SessionBudget): void {
  const units = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 * MONEY_SCALE
  const handoff = (value: BudgetHandoff | undefined) => value === undefined || !!value && typeof value.path === 'string' && typeof value.summary === 'string' && typeof value.request === 'string' && typeof value.author === 'string' && units(value.writerCost) && units(value.limit) && units(value.at) && (value.saveError === undefined || typeof value.saveError === 'string') && (value.attachments === undefined || attachmentRefsFrom(value.attachments) !== undefined)
  if (!budget || budget.version !== 1 || !units(budget.limit) || !budget.limit || !units(budget.reserve) || budget.reserve > budget.limit / 2 || !units(budget.initialSpent)
    || !Number.isSafeInteger(budget.stage) || budget.stage < 1 || !['active', 'writing', 'held'].includes(budget.phase)
    || !Array.isArray(budget.requests) || !Array.isArray(budget.stages) || budget.requests.length > 100_000
    || budget.stages.length !== budget.stage || !budget.stages.every((s, index) => s && s.number === index + 1 && units(s.limit) && !!s.limit && units(s.reserve) && s.reserve <= s.limit / 2 && units(s.spentAtStart) && (s.spentAtEnd === undefined || units(s.spentAtEnd)) && handoff(s.handoff))
    || budget.stages.at(-1)?.limit !== budget.limit || budget.stages.at(-1)?.reserve !== budget.reserve
    || !handoff(budget.handoff) || (budget.writerLimit !== undefined && !units(budget.writerLimit)) || (budget.writerAllowance !== undefined && (!units(budget.writerAllowance) || budget.writerAllowance > budget.reserve))
    || (budget.handoffModel !== undefined && !parseBudgetModel(budget.handoffModel))
    || !budget.requests.every(r => r && typeof r.id === 'string' && typeof r.provider === 'string' && typeof r.model === 'string' && units(r.reserved)
      && Number.isSafeInteger(r.stage) && r.stage > 0 && r.stage <= budget.stage && units(r.at) && Number.isSafeInteger(r.outputLimit) && r.outputLimit > 0 && ['task', 'handoff'].includes(r.purpose)
      && (r.charged === undefined || units(r.charged)) && ['reserved', 'unconfirmed', 'settled', 'rejected'].includes(r.status)
      && (r.status !== 'rejected' || r.charged === 0)
      && (['settled', 'rejected'].includes(r.status) === (r.charged !== undefined)) && (r.usage === undefined || validUsage(r.usage)))
    || new Set(budget.requests.map(r => r.id)).size !== budget.requests.length || !Number.isSafeInteger(budgetSpent(budget))) throw new Error('Invalid saved session budget. Sending stopped; preserve the session record.')
}

/** The shared continuation still supplies the quoted handoff and original request. */
export function budgetContinuation(handoff: BudgetHandoff, sessionId: string): string {
  return handoffContinuation(handoff.summary, handoff.path, sessionId, handoff.request)
    .replace('stopped because its context window was full.', 'stopped because its session budget was reached.')
    .replace('do not redo or re-verify them. Read a file again only for a specific missing piece or an exact edit.', 'verify their claims against the actual files before relying on them.')
    + '\n\nRead the handoff first, verify it against the files and trust the files when they disagree. Follow its Next steps in order, preserve existing behaviour, and update the handoff document as part of the work.'
}
