import { useState } from 'react'
import { changePermission } from '@/lib/tauri'
import { PermissionScope } from '../settings/PermissionsTab'
import { describePermissionRule, permissionRuleError } from '../../../../src/shared/permissionRules'

/** Approve only after the personal rule is durably saved; a failed write leaves the call pending. */
export function AlwaysAllow({ suggestion, project, onSaved, onCancel }: { suggestion: string; project?: string; onSaved: () => void; onCancel: () => void }) {
  const [rule, setRule] = useState(suggestion)
  const [scope, setScope] = useState<'all' | 'project'>(project ? 'project' : 'all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const invalid = permissionRuleError(rule, scope === 'project')
  return <form className="gc-always-allow" data-permission-editor onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel() }
  }} onSubmit={event => {
    event.preventDefault()
    if (invalid || busy) return
    setBusy(true); setError('')
    void changePermission(rule, false, false, scope === 'project' ? project : undefined).then(() => onSaved(), problem => { setError(String(problem)); setBusy(false) })
  }}>
    <h3>Always allow this rule?</h3>
    <label>Rule<input autoFocus className="gc-input-well" aria-label="Always allow rule" aria-invalid={!!invalid} value={rule} spellCheck={false} disabled={busy} onChange={event => setRule(event.currentTarget.value)} /></label>
    <p>{invalid ?? describePermissionRule(rule)}</p>
    <PermissionScope project={project} value={scope} onChange={setScope} disabled={busy} />
    {error && <p role="alert" className="gc-permission-error">{error}</p>}
    <div className="gc-approval-actions">
      <button type="button" className="gc-btn gc-btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="gc-btn gc-btn-primary" disabled={!!invalid || busy}>{busy ? 'Saving…' : 'Save and allow'}</button>
    </div>
  </form>
}
