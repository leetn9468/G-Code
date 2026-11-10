import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { budgetModelProblem, localBudgetEndpoint, normalizeBudget } from '../../../../src/shared/sessionBudget'
import { getModelFor, type GCodeSettings } from '@/lib/settings'
import { PROVIDERS, type ProviderName } from '@/lib/providers'
import { getProviderEnvStatus, isTauri, type ProviderEnvStatus } from '@/lib/tauri'
import { localModelLabel } from '@/lib/localModel'

/** Only boolean readiness crosses IPC; environment credentials are never exposed to this control. */
export function useBudgetEnvironment() {
  const [environment, setEnvironment] = useState<ProviderEnvStatus | null>(null)
  useEffect(() => { let active = true; if (isTauri()) void getProviderEnvStatus().then(value => { if (active) setEnvironment(value ?? null) }).catch(() => {}); return () => { active = false } }, [])
  return environment
}

/** Only user-configured choices, with the free local routes first. */
export function configuredBudgetModels(settings: GCodeSettings, environment?: ProviderEnvStatus | null): Array<{ value: string; provider: ProviderName; model: string; label: string; problem?: string }> {
  return [...PROVIDERS].sort((a, b) => Number(b === 'local' || b === 'ollama') - Number(a === 'local' || a === 'ollama')).flatMap(provider => {
    const model = getModelFor(settings, provider)
    const ready = provider === 'local' ? !!settings.provider.localModelPath : provider === 'ollama' ? !!model : !!settings.provider.apiKeys[provider] || environment?.[provider] === true
    if (!ready || !model) return []
    const free = provider === 'local' || provider === 'ollama' && localBudgetEndpoint(settings.provider.ollamaHost)
    return [{ value: `${provider}:${model}`, provider, model, label: `${provider === 'local' ? localModelLabel(settings.provider.localModelPath) : model}${free ? ' · $0' : ` · ${provider}`}`, problem: budgetModelProblem(provider, model, provider !== 'ollama' || localBudgetEndpoint(settings.provider.ollamaHost)) }]
  })
}

export function SessionBudgetField({ settings, onUpdate, environment }: { settings: GCodeSettings; onUpdate: (patch: Partial<GCodeSettings>) => void; environment?: ProviderEnvStatus | null }) {
  const budget = normalizeBudget(settings.execution.sessionBudget)
  const change = (patch: Partial<typeof budget>) => onUpdate({ execution: { ...settings.execution, sessionBudget: normalizeBudget({ ...budget, ...patch }) } })
  const problem = budget.enabled ? budgetModelProblem(settings.provider.currentProvider, getModelFor(settings, settings.provider.currentProvider), settings.provider.currentProvider !== 'ollama' || localBudgetEndpoint(settings.provider.ollamaHost)) : undefined
  const models = configuredBudgetModels(settings, environment)
  return <div className="gc-settings-section gc-budget-settings">
    <div className="gc-settings-section-head"><h3>Session budget</h3><p>Stop at the handoff reserve and choose how to continue. These defaults apply to new sessions. Saved sessions keep their limit, spending and paused state.</p></div>
    <label className="gc-settings-check"><input type="checkbox" checked={budget.enabled} onChange={event => change({ enabled: event.currentTarget.checked })} />Session budget</label>
    <label>Limit per session <input className="gc-input-well" type="number" min="0.50" max="1000000" step="0.50" value={budget.limitUsd} onChange={event => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0 && value <= 1_000_000) change({ limitUsd: value }) }} /></label>
    <label>Reserve for handoff <span className="gc-select-well"><select className="gc-input-well" value={budget.reserveUsd} onChange={event => change({ reserveUsd: Number(event.currentTarget.value) })}>
      {[...new Set([.25, .5, 1, budget.reserveUsd])].sort((a,b) => a-b).map(value => <option key={value} value={value} disabled={value > budget.limitUsd / 2}>${value.toFixed(2)}</option>)}
    </select><ChevronDown size={16} className="gc-select-chevron" aria-hidden="true" /></span></label>
    <label>Continue with <span className="gc-select-well"><select className="gc-input-well" value={budget.handoffModel ?? ''} onChange={event => change({ handoffModel: event.currentTarget.value || undefined })}>
      <option value="">Choose a configured model</option>
      {models.map(model => <option key={model.value} value={model.value} disabled={!!model.problem}>{model.label}{model.problem ? ' · Price unavailable' : ''}</option>)}
    </select><ChevronDown size={16} className="gc-select-chevron" aria-hidden="true" /></span></label>
    {problem && <p role="alert" className="gc-settings-callout">{problem}</p>}
    <p className="gc-settings-path">One reply may use part of the reserve. Each request reserves its estimated cost; missing usage keeps that reservation. Provider counts may differ from estimates.</p>
  </div>
}
