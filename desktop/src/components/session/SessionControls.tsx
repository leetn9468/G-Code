import { budgetHeld, budgetSpent, moneyLabel, type SessionBudget } from '../../../../src/shared/sessionBudget'
import { Fragment, useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { AlertTriangle, Check, ChevronDown, Layers, Shield, SlidersHorizontal, X } from 'lucide-react'
import { Modal } from '../shell/Modal'
import { PRICING, estimatedCost } from '../../../../src/shared/pricing'
import { emptyUsage, type UsageTotals } from '../../../../src/shared/usageTotals'
import { cachePercent, cacheReadRatio, cacheSavings, sessionCacheRatio } from '../../../../src/shared/cache'
import { EFFORTS, PERMISSIONS, PERMISSION_LABELS, PERMISSION_DETAILS, effortDescription, type Effort, type SessionPermission, type ContextStatus } from '../../../../src/shared/sessionControls'

interface Props { budget?: SessionBudget | null; onBudget?: () => void; effort: Effort; permission: SessionPermission; provider: string; model?: string; disabled: boolean; context: ContextStatus | null; hasMessages: boolean; onEffort: (value: Effort) => void; onPermission: (value: SessionPermission) => void; onCompact: (focus: string) => void }

const effortLabel = (level: Effort) => level[0].toUpperCase() + level.slice(1)

/** Local models count as $0, like estimatedCost. */
const freeProvider = (provider: string) => provider === 'local' || provider === 'ollama'

/**
 * The session's cost as far as it is known: the list-price estimate over every model row with
 * a price (local models at $0), and what it leaves out. `cost` is undefined only when no row
 * is priced. `partial`: requests without usable usage, turns from before usage was recorded or
 * unpriced models are not in it, and requests cut off before their final usage count only the
 * output that arrived, so the real cost is at least `cost`.
 */
export function sessionCostEstimate(usage: UsageTotals): { cost?: number; unpriced: string[]; partial: boolean } {
  const priced = usage.byModel.filter(row => freeProvider(row.provider) || PRICING[`${row.provider}:${row.model}`])
  const unpriced = [...new Set(usage.byModel.filter(row => !priced.includes(row)).map(row => row.model))]
  // The known rows alone: the gaps are reported beside the figure instead of hiding it.
  const cost = priced.length ? estimatedCost({ ...emptyUsage(), byModel: priced }) : undefined
  // partialRequests is optional: sessions saved before it existed have none.
  return { cost, unpriced, partial: unpriced.length > 0 || usage.unreportedRequests > 0 || (usage.partialRequests ?? 0) > 0 || (usage.abortedRequests ?? 0) > 0 || usage.incomplete }
}

/** What the session estimate leaves out, in short sentences; '' when nothing. */
export function sessionCostGaps(usage: UsageTotals, estimate = sessionCostEstimate(usage)): string {
  const notes: string[] = []
  if (!usage.byModel.length) notes.push('No request has reported usage yet, so there is no cost estimate.')
  // "No price" only ever names models without a PRICING entry.
  else if (estimate.unpriced.length && estimate.cost === undefined) notes.push(estimate.unpriced.length === 1 ? 'No price for this model, so only reported tokens are shown.' : 'No price for these models, so only reported tokens are shown.')
  else if (estimate.unpriced.length) notes.push(`No price for ${estimate.unpriced.join(', ')}, so ${estimate.unpriced.length === 1 ? 'its' : 'their'} tokens are not in the estimate.`)
  if (usage.unreportedRequests) notes.push(`${usage.unreportedRequests} ${usage.unreportedRequests === 1 ? 'request' : 'requests'} reported no usable usage${estimate.cost === undefined ? '' : ' and ' + (usage.unreportedRequests === 1 ? 'is' : 'are') + ' not in the estimate'}.`)
  const aborted = usage.abortedRequests ?? 0
  if (aborted > 0) notes.push(`${aborted} ${aborted === 1 ? 'request was' : 'requests were'} stopped before usage arrived; ${aborted === 1 ? 'its cost is' : 'their costs are'} unknown.`)
  const partial = usage.partialRequests ?? 0
  if (partial > 0) notes.push(partial === 1
    ? '1 request ended before the provider reported its final usage; its output is estimated.'
    : `${partial} requests ended before the provider reported their final usage; their output is estimated.`)
  if (usage.incomplete) notes.push('Some earlier turns in this session have no recorded usage.')
  return notes.join(' ')
}

export function SessionUsageSummary({ usage }: { usage?: UsageTotals }) {
  if (!usage) return <p className="gc-context-footnote">This session: no usage recorded yet. Usage from before this version can’t be filled in.</p>
  const estimate = sessionCostEstimate(usage)
  const { cost } = estimate
  const gaps = sessionCostGaps(usage, estimate)
  return <div className="gc-context-group">
    <p className="gc-context-caption">This session · {usage.requests.toLocaleString()} {usage.requests === 1 ? 'request' : 'requests'} with reported usage</p>
    <p className="gc-context-caption">Session cache hit rate: {cachePercent(sessionCacheRatio(usage))}</p>
    <dl>{[['Input (incl. cache)', usage.inputTokens], ['Output (incl. reasoning)', usage.outputTokens], ['Total (input + output)', usage.inputTokens + usage.outputTokens], ['Cache read (part of input)', usage.cacheReadTokens ?? 0], ['Cache write (part of input)', usage.cacheWriteTokens ?? 0]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{Number(value).toLocaleString()}</dd></div>)}</dl>
    {cost !== undefined && <p className="gc-context-caption">{estimate.partial ? 'At least ' : ''}${cost.toFixed(2)} USD · estimate at list prices</p>}
    <p className="gc-context-footnote">{[cost === undefined ? '' : 'Prices come from an offline table; your provider’s bill is authoritative. Local models count as $0.', gaps].filter(Boolean).join(' ')}</p>
  </div>
}

function cacheDisclosure(usage: UsageTotals | undefined): string {
  if (!usage?.requests) return 'No request has reported cache use yet.'
  const missing = [...new Set(usage.byModel.filter(row => row.cacheUnreportedRequests || row.cacheReportedRequests !== row.requests).map(row => row.provider))]
  return missing.length ? `Cache reporting unavailable for ${missing.join(', ')}. Some requests did not report cache use, so the session rate is unavailable.`
    : 'The session has incomplete usage; its cache rate is unavailable.'
}

export function CacheSummary({ context }: { context?: ContextStatus | null; provider: string }) {
  const totals = context?.usageTotals
  const ratio = sessionCacheRatio(totals)
  const saving = cacheSavings(totals)
  const reason = ratio === undefined ? cacheDisclosure(totals) : ''
  return <div className="gc-context-group">
    <dl>
      <div><dt>Last request</dt><dd>{cachePercent(cacheReadRatio(context?.lastUsage))}</dd></div>
      <div><dt>This session</dt><dd>{cachePercent(ratio)}</dd></div>
      <div><dt>Tokens read from cache</dt><dd>{(totals?.cacheReadTokens ?? 0).toLocaleString()}</dd></div>
      <div><dt>Tokens written to cache</dt><dd>{(totals?.cacheWriteTokens ?? 0).toLocaleString()}</dd></div>
      <div><dt>Estimated saving</dt><dd>{saving === undefined ? '—' : `${saving < 0 ? '−' : ''}$${Math.abs(saving).toFixed(4)}`}</dd></div>
    </dl>
    <p className="gc-context-footnote">{reason || 'Cache reads divided by input tokens, including cached input.'} Savings compare reported usage with uncached input at offline list prices, including cache-write premiums. Local models cost $0.</p>
    {!!totals?.cacheInvalidations && <p className="gc-context-footnote">{totals.cacheInvalidations} history {totals.cacheInvalidations === 1 ? 'rewrite' : 'rewrites'} may have caused a cache miss.</p>}
  </div>
}

/** Per-level effort copy. A trailing sentence every level shares is shown once
 *  as a menu footnote instead of five times; the wording is unchanged. */
function effortCopy(provider: string, model?: string) {
  const sentences = EFFORTS.map((level) => effortDescription(provider, level, model).replace(/\.\s+/g, '.\n').split('\n'))
  const shortest = Math.min(...sentences.map((parts) => parts.length))
  const tail = (parts: string[], index: number) => parts[parts.length - 1 - index]
  let shared = 0
  while (shared < shortest - 1 && sentences.every((parts) => tail(parts, shared) === tail(sentences[0], shared))) shared++
  return {
    items: sentences.map((parts) => parts.slice(0, parts.length - shared).join(' ')),
    note: shared ? sentences[0].slice(sentences[0].length - shared).join(' ') : '',
  }
}

/** Where the context limit comes from. 'budget': the context budget from Settings lowered the model's window (compared as a string until ContextStatus lists it). */
export function contextLimitLabel(limitSource: string | undefined): string {
  switch (limitSource) {
    case 'runtime': return 'runtime-configured window'
    case 'fallback': return 'fallback budget; model limit unverified'
    case 'budget': return 'context budget from Settings'
    case 'provider-limit': return 'limit the provider stated'
    default: return 'model default budget'
  }
}

// 16px context ring: track + progress arc from 12 o'clock.
const RING_RADIUS = 6
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** The engine's context check asks how to make room at this share of the window (COMPACTION_THRESHOLD in src/engine/context.ts). */
export const CONTEXT_ASK_PCT = 85
/** The ring turns amber this far ahead of the question. */
export const CONTEXT_WARN_PCT = 75

/** The output reserve the engine's local context check counts for a managed local model (LOCAL_CHECK_OUTPUT_TOKENS in QueryEngine). */
export const LOCAL_CHECK_RESERVE = 2048

/**
 * The fields the context check percentage reads. `checkReserved`: what the check adds to the
 * prompt, its output reserve plus safety margin (CLIs from before it was sent leave it out).
 * `reserved` is the request's max_tokens, which for a managed local model is far more than the
 * check counts.
 */
export type ContextCheckFields = Pick<ContextStatus, 'used' | 'limit' | 'reserved' | 'safety'> & { checkReserved?: number }

/** Only a managed local model has a safety reserve (QueryEngine.publishContext). */
const isLocalCheck = (context: Partial<ContextCheckFields>) => (Number(context.safety) || 0) > 0
const safetyOf = (context: Partial<ContextCheckFields>) => Math.max(0, Number(context.safety) || 0)

/**
 * What the context check adds to the prompt: checkReserved when the CLI sends it; from an older
 * CLI, the request's reserve for a cloud model or the local check's fixed reserve for a local
 * one, plus the safety reserve.
 */
export function contextCheckReserve(context: Partial<ContextCheckFields>): number {
  const check = context.checkReserved
  if (typeof check === 'number' && Number.isFinite(check) && check >= 0) return check
  return (isLocalCheck(context) ? LOCAL_CHECK_RESERVE : Math.max(0, Number(context.reserved) || 0)) + safetyOf(context)
}

/** The output reserve part of what the check adds (the rest is the safety reserve). */
export const contextCheckOutputReserve = (context: Partial<ContextCheckFields>) => Math.max(0, contextCheckReserve(context) - safetyOf(context))

/**
 * Whole percent of the window as the engine's context check counts it: the prompt plus the
 * output reserve and safety margin the check adds (calculateContextBudget). Rounded down, so the
 * ring shows 85% exactly when the check would ask or trim. null while nothing is measured.
 */
export function contextCheckPercent(context: ContextCheckFields | null | undefined): number | null {
  if (!context || !(context.limit > 0)) return null
  const counted = Math.max(0, Number(context.used) || 0) + contextCheckReserve(context)
  return Math.min(100, Math.floor(counted * 100 / context.limit))
}

/** How the context dialog explains the percentage, in the check's own numbers. */
export function contextCheckExplanation(context: ContextCheckFields): string {
  const reserve = contextCheckOutputReserve(context).toLocaleString('en-US')
  return isLocalCheck(context)
    ? `The percentage adds the ${reserve}-token output reserve and the ${safetyOf(context).toLocaleString('en-US')}-token safety reserve, as the local model’s context check does. At ${CONTEXT_ASK_PCT}%, G-Code drops the oldest turns to make room.`
    : `The percentage adds the ${reserve}-token output reserve, as the context check does. At ${CONTEXT_ASK_PCT}%, G-Code asks how to make room.`
}

/**
 * A part of the context (instructions, tool definitions, conversation) calibrated like the total.
 * The engine sends each part as its raw estimate with the scale it learned from provider usage;
 * shown raw, the parts added up to about two thirds of the measured total.
 */
export function calibratedPart(context: Pick<ContextStatus, 'scale'>, part: number): number {
  const scale = context.scale
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? Math.round(part * scale) : part
}

/**
 * The caption over the request usage. While a response arrives its usage is what the provider
 * reported as it started (an output count of a few tokens), not a completed request's.
 */
export function usageCaption(context: Pick<ContextStatus, 'source' | 'inFlight'>): string {
  if (context.inFlight) return 'Current request usage · in progress, output so far'
  return `Last completed request usage${context.source === 'provider-usage' ? '' : ' · separate from the current prompt count'}`
}

/** Amber from CONTEXT_WARN_PCT; red from CONTEXT_ASK_PCT, where the engine asks (or would ask on the next request). */
export const contextTone = (pct: number | null) => pct === null ? '' : pct >= CONTEXT_ASK_PCT ? ' is-critical' : pct >= CONTEXT_WARN_PCT ? ' is-warning' : ''

export function SessionControls({ budget, onBudget, effort, permission, provider, model, disabled, context, hasMessages, onEffort, onPermission, onCompact }: Props) {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState('')
  const [effortOpen, setEffortOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [cacheOpen, setCacheOpen] = useState(false)
  const cacheRate = cachePercent(sessionCacheRatio(context?.usageTotals))
  const cacheTitle = cacheRate === '—' ? cacheDisclosure(context?.usageTotals) : `Session cache hit rate: ${cacheRate}`
  const pct = contextCheckPercent(context)
  const tone = contextTone(pct)
  const copy = useMemo(() => effortCopy(provider, model), [provider, model])
  // Pill names keep their fixed prefix and add the visible value, as the old
  // <select>s announced it ("Model effort: Medium", "Permissions: Bypass").
  // Streaming disables both menus; one that was open stays closed afterwards.
  useEffect(() => { if (disabled) { setEffortOpen(false); setPermissionOpen(false) } }, [disabled])

  return <>
    {budget?.phase === 'held' && <button type="button" className="gc-btn gc-btn-ghost gc-budget-reopen" onClick={onBudget}>Budget reached · Choose how to continue</button>}
    <div className="gc-session-controls" role="group" aria-label="Session controls">
      <DropdownMenu.Root open={effortOpen && !disabled} onOpenChange={setEffortOpen}>
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <button type="button" className="gc-control-pill" aria-label={`Model effort: ${effortLabel(effort)}`}>
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" /><span className="gc-control-pill-label">{effortLabel(effort)}</span><ChevronDown className="gc-pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="gc-menu gc-session-menu" side="top" align="start" sideOffset={8} collisionPadding={12} loop>
            <DropdownMenu.Label className="gc-menu-label">Effort</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={effort} onValueChange={(value) => { if (!disabled && value !== effort) onEffort(value as Effort) }}>
              {EFFORTS.map((level, index) => <DropdownMenu.RadioItem key={level} value={level} className="gc-menu-item">
                <DropdownMenu.ItemIndicator className="gc-menu-item-indicator"><Check size={14} strokeWidth={2} /></DropdownMenu.ItemIndicator>
                <span className="gc-menu-item-copy"><span>{effortLabel(level)}</span><small>{copy.items[index]}</small></span>
              </DropdownMenu.RadioItem>)}
            </DropdownMenu.RadioGroup>
            {copy.note && <>
              <DropdownMenu.Separator className="gc-menu-separator" />
              <DropdownMenu.Label className="gc-menu-footnote">{copy.note}</DropdownMenu.Label>
            </>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root open={permissionOpen && !disabled} onOpenChange={setPermissionOpen}>
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <button type="button" className={`gc-control-pill${permission === 'bypass' ? ' gc-permission-bypass' : ''}`} aria-label={`Permissions: ${PERMISSION_LABELS[permission]}`}>
            <Shield size={14} strokeWidth={1.75} aria-hidden="true" /><span className="gc-control-pill-label">{PERMISSION_LABELS[permission]}</span><ChevronDown className="gc-pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="gc-menu gc-session-menu is-wide" side="top" align="start" sideOffset={8} collisionPadding={12} loop>
            <DropdownMenu.Label className="gc-menu-label">Permissions</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={permission} onValueChange={(value) => { if (!disabled && value !== permission) onPermission(value as SessionPermission) }}>
              {PERMISSIONS.map((mode) => <Fragment key={mode}>
                {mode === 'bypass' && <DropdownMenu.Separator className="gc-menu-separator" />}
                <DropdownMenu.RadioItem value={mode} className={`gc-menu-item${mode === 'bypass' ? ' is-bypass' : ''}`}>
                  <DropdownMenu.ItemIndicator className="gc-menu-item-indicator"><Check size={14} strokeWidth={2} /></DropdownMenu.ItemIndicator>
                  <span className="gc-menu-item-copy"><span>{PERMISSION_LABELS[mode]}</span><small>{PERMISSION_DETAILS[mode]}</small></span>
                </DropdownMenu.RadioItem>
              </Fragment>)}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button type="button" className={`gc-control-pill gc-context-trigger${tone}`} onClick={() => setOpen(true)} aria-label={`Context window and compact: ${pct === null ? 'not measured' : `${context?.estimated ? 'about ' : ''}${pct}%`}`}>
        <svg className="gc-context-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle className="gc-context-ring-track" cx="8" cy="8" r={RING_RADIUS} />
          <circle className="gc-context-ring-value" cx="8" cy="8" r={RING_RADIUS} strokeDasharray={RING_CIRCUMFERENCE} style={{ strokeDashoffset: RING_CIRCUMFERENCE * (1 - (pct ?? 0) / 100), opacity: pct ? 1 : 0 }} />
        </svg>
        <span className="gc-control-pill-label">Context {pct === null ? '—' : `${context?.estimated ? '~' : ''}${pct}%`}</span>
      </button>
      <button type="button" className="gc-control-pill gc-cache-trigger" title={cacheTitle} onClick={() => setCacheOpen(true)} aria-label={`Prompt cache: ${cacheRate}`}>
        <span className="gc-control-pill-label">Cache {cacheRate}</span>
      </button>
    </div>
    {permission === 'bypass' && <p className="gc-controls-note"><AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />Bypass: permission prompts are skipped. Deny rules still apply.</p>}
    <Modal open={open} onClose={() => setOpen(false)} labelledBy="context-title" width={520} maxHeight="calc(100vh - 40px)">
      <section className="gc-context-dialog">
        <header>
          <span className="gc-context-icon" aria-hidden="true"><Layers size={18} strokeWidth={1.75} /></span>
          <h2 id="context-title">Context window</h2>
          <button type="button" className="gc-panel-close gc-btn-icon" aria-label="Close context window" onClick={() => setOpen(false)}><X size={18} strokeWidth={1.75} /></button>
        </header>
        {context ? <>
          <div className="gc-context-summary">
            <strong className="gc-context-total">{context.estimated ? '~' : ''}{context.used.toLocaleString()} <small>/ {context.limit.toLocaleString()} tokens</small></strong>
            <div className="gc-context-meter-row">
              <div className={`gc-context-meter${tone}`} aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
              <span className="gc-context-pct">{context.estimated ? '~' : ''}{pct}%</span>
            </div>
            <p className="gc-context-source">{context.source === 'provider-usage' ? context.inFlight ? 'Current model response · input + output so far' : 'Latest model response · reported input + output' : context.source === 'runtime-tokenizer' ? 'Current prompt · local model tokenizer' : context.source === 'calibrated-estimate' ? 'Next request estimate · calibrated with reported usage' : 'Estimated context'} · {contextLimitLabel(context.limitSource)}</p>
            <p className="gc-context-source">{contextCheckExplanation(context)}</p>
          </div>
          {context.lastUsage && <div className="gc-context-group">
            <p className="gc-context-caption">{usageCaption(context)}</p>
            <p className="gc-context-caption">Last request cache hit rate: {cachePercent(cacheReadRatio(context.lastUsage))}</p>
            <dl>{[['Input (includes cache)', context.lastUsage.inputTokens], ['Output (includes reasoning)', context.lastUsage.outputTokens], ['Cache read (part of input)', context.lastUsage.cacheReadTokens], ['Cache write (part of input)', context.lastUsage.cacheWriteTokens], ['Reasoning (part of output)', context.lastUsage.reasoningTokens]].filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{Number(value).toLocaleString()}</dd></div>)}</dl>
          </div>}
          <div className="gc-context-group">
            <dl>{[['Instructions, estimated', calibratedPart(context, context.system)], ['Tool definitions, estimated', calibratedPart(context, context.tools)], ['Conversation, estimated', calibratedPart(context, context.conversation)], ['Next output reserve', contextCheckOutputReserve(context)], ['Safety reserve', context.safety]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>~{Number(value).toLocaleString()}</dd></div>)}</dl>
          </div>
          <p className="gc-context-footnote">{context.compactions} compaction{context.compactions === 1 ? '' : 's'} in this session. Context uses one request, not cumulative session usage. Cache and reasoning are counted once. Estimated parts do not replace the measured total.</p>
        </> : <p className="gc-context-empty">Context statistics appear after the session connects. No usage has been measured yet.</p>}
        {budget && <div className="gc-context-group"><p className="gc-context-caption">Session budget: {moneyLabel(budgetSpent(budget))} / {moneyLabel(budget.limit)} · Stage {budget.stage}</p><p className="gc-context-footnote">Reserve for handoff: {moneyLabel(budget.reserve)}. {budgetHeld(budget) ? `${moneyLabel(budgetHeld(budget))} is reserved or unconfirmed.` : ''} One reply may use part of the reserve.</p></div>}
        <SessionUsageSummary usage={context?.usageTotals} />
        <div className="gc-compact-form">
          <h3>Compact conversation</h3>
          <p>Summarize earlier context with the selected model. Your full conversation and previous context remain saved. This uses model tokens.</p>
          <label htmlFor="compact-focus">Keep in focus <span>(optional)</span></label>
          <textarea id="compact-focus" value={focus} maxLength={2000} onChange={e => setFocus(e.target.value)} placeholder="For example: current goal, changed files and unresolved failures"/>
          <div className="gc-compact-actions">
            {disabled && <small>Wait for the response to finish first.</small>}
            <button type="button" className="gc-btn gc-btn-primary" disabled={disabled || !hasMessages} onClick={() => { onCompact(focus); setOpen(false) }}>Compact now</button>
          </div>
        </div>
      </section>
    </Modal>
    <Modal open={cacheOpen} onClose={() => setCacheOpen(false)} labelledBy="cache-title" width={460} maxHeight="calc(100vh - 40px)">
      <section className="gc-context-dialog">
        <header><h2 id="cache-title">Prompt cache</h2><button type="button" className="gc-panel-close gc-btn-icon" aria-label="Close prompt cache" onClick={() => setCacheOpen(false)}><X size={18} strokeWidth={1.75} /></button></header>
        <CacheSummary context={context} provider={provider} />
      </section>
    </Modal>
  </>
}
