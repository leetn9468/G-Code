import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Modal } from '../shell/Modal'
import { readNetworkEvidence, revealNetworkIncident } from '@/lib/tauri'
import type { NetworkIncident } from '../../../../src/shared/networkGuard'

/** A decision resumes or rejects work; it never dismisses the evidence record. */
export function NetworkIncidentNotice({ incident, onReview }: { incident: NetworkIncident; onReview: () => void }) {
  const [error, setError] = useState('')
  if (!incident.decision) return <button type="button" className="gc-btn gc-btn-ghost gc-budget-reopen" onClick={onReview}>Network attempt blocked · Review incident</button>
  return <div className="gc-network-kept"><p>{incident.evidenceIncomplete ? `Evidence could not be fully saved. Whatever could be kept is at ~/.gcode/incidents/${incident.id}.` : `Evidence kept (read-only) at ~/.gcode/incidents/${incident.id}.`}</p><div className="gc-budget-add-actions"><button type="button" className="gc-btn gc-btn-ghost" onClick={onReview}>View full evidence</button><button type="button" className="gc-btn gc-btn-ghost" onClick={() => void revealNetworkIncident(incident.id).catch(e => setError(String(e)))}>Show in Finder</button></div>{error && <p role="alert">{error}</p>}</div>
}

/** Evidence is inert text. Escape only dismisses the view; it cannot decide or resume work. */
export function NetworkIncidentDialog({ incident, open, onClose, onDecision }: { incident: NetworkIncident | null; open: boolean; onClose: () => void; onDecision: (choice: 'continue' | 'reject') => void }) {
  const [evidence, setEvidence] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => { setEvidence(null); setError('') }, [incident?.id])
  return <Modal open={open && !!incident} onClose={onClose} labelledBy="network-incident-title" width={600}>
    <section className="gc-context-full gc-network-incident">
      <header className="gc-context-full-header"><span className="gc-context-full-icon" aria-hidden="true"><ShieldAlert size={18} /></span><h2 id="network-incident-title">Network attempt blocked</h2></header>
      {incident && <>
        <p className="gc-context-full-summary"><bdi>{incident.destination}</bdi></p>
        <p className="gc-context-full-explain">{incident.model} · {new Date(incident.at).toLocaleString('en-US')}</p>
        <h3>Model's stated intent</h3><pre className="gc-network-evidence">{incident.intent || 'No model reasoning or text was available.'}</pre>
        <h3>Actual call · {incident.tool}</h3><pre className="gc-network-evidence">{JSON.stringify(incident.input, null, 2)}</pre>
        {incident.reason && <p className="gc-context-full-explain">{incident.reason}</p>}
        <div className="gc-budget-add-actions"><button type="button" className="gc-btn gc-btn-ghost" onClick={() => void readNetworkEvidence(incident.id).then(setEvidence).catch(e => setError(String(e)))}>View full evidence</button><button type="button" className="gc-btn gc-btn-ghost" onClick={() => void revealNetworkIncident(incident.id).catch(e => setError(String(e)))}>Show in Finder</button></div>
        {evidence !== null && <pre className="gc-network-evidence is-full" tabIndex={0} aria-label="Read-only incident evidence">{evidence}</pre>}
        {error && <p role="alert">{error}</p>}
        <p className="gc-context-full-explain">Evidence kept (read-only) at ~/.gcode/incidents/{incident.id}.</p>
        {!incident.decision && <div className="gc-budget-add-actions" role="group" aria-label="Network incident decision"><button type="button" className="gc-btn gc-btn-ghost" onClick={() => onDecision('reject')}>Reject</button><button type="button" className="gc-btn gc-btn-ghost" disabled={!incident.canContinue} onClick={() => onDecision('continue')}>Continue</button></div>}
        {!incident.canContinue && !incident.decision && <p className="gc-context-full-explain">Continue is unavailable because the destination is unknown or is a user proxy. Reject to keep it blocked, then send a new message.</p>}
        {incident.decision && <button type="button" className="gc-btn gc-btn-ghost" onClick={onClose}>Close</button>}
      </>}
    </section>
  </Modal>
}
