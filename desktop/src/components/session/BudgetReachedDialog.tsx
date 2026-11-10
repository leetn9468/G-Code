import { useState } from 'react'
import { Layers } from 'lucide-react'
import { Modal } from '../shell/Modal'
import { budgetHeld, budgetSpent, moneyLabel, type SessionBudget } from '../../../../src/shared/sessionBudget'

export function BudgetReachedDialog({ budget, open, model, onContinue, onAdd, onClose }: {
  budget: SessionBudget | null; open: boolean; model?: string; onContinue: () => void; onAdd: (usd: number) => void; onClose: () => void
}) {
  const [other, setOther] = useState(false), [amount, setAmount] = useState('')
  const value = Number(amount), valid = amount.trim() !== '' && Number.isFinite(value) && value > 0 && value <= 1_000_000
  return <Modal open={open && !!budget} onClose={onClose} labelledBy="budget-reached-title" width={500}>
    <section className="gc-context-full">
      <header className="gc-context-full-header"><span className="gc-context-full-icon" aria-hidden="true"><Layers size={18} /></span><h2 id="budget-reached-title">Budget reached</h2></header>
      {budget && <>
        <p className="gc-context-full-summary">{moneyLabel(budgetSpent(budget))} / {moneyLabel(budget.limit)} used</p>
        {!!budgetHeld(budget) && <p className="gc-context-full-explain">Includes {moneyLabel(budgetHeld(budget))} reserved or unconfirmed usage.</p>}
        <p className="gc-context-full-explain">{budget.handoff?.path ? `Handoff: ${budget.handoff.path}` : budget.handoff?.saveError ?? 'The handoff is being prepared.'}</p>
        {budget.handoff && <p className="gc-context-full-explain">Written by {budget.handoff.author} · Writer cost {moneyLabel(budget.handoff.writerCost)}</p>}
        <div className="gc-context-full-choices" role="group" aria-label="How to continue">
          {model && budget.handoff ? <button type="button" className="gc-context-choice is-primary" onClick={onContinue}><span className="gc-context-choice-title">Continue with {model}</span><small>Starts a new session, reads the handoff and verifies it against the files.</small></button>
            : <p className="gc-context-full-explain">Choose a configured model in Settings → Session budget → Continue with.</p>}
          <div className="gc-budget-add-actions">{[5,10,20].map(usd => <button key={usd} type="button" className="gc-btn gc-btn-ghost" onClick={() => onAdd(usd)}>Add ${usd}</button>)}<button type="button" className="gc-btn gc-btn-ghost" onClick={() => setOther(value => !value)}>Other…</button></div>
          {other && <form className="gc-budget-add-actions" onSubmit={event => { event.preventDefault(); if (valid) onAdd(value) }}><label>Add budget (USD)<input className="gc-input-well" inputMode="decimal" type="number" min="0.01" max="1000000" step="0.01" value={amount} onChange={event => setAmount(event.currentTarget.value)} /></label><button type="submit" className="gc-btn gc-btn-ghost" disabled={!valid}>Add budget</button></form>}
          <button type="button" className="gc-context-choice is-ghost" onClick={onClose}><span className="gc-context-choice-title">Not now</span><small>This session stays paused.</small></button>
        </div>
      </>}
    </section>
  </Modal>
}
