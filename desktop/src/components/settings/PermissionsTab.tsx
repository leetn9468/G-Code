import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Trash2 } from 'lucide-react'
import { changePermission, readPermissions, type PermissionSnapshot } from '@/lib/tauri'
import { describePermissionRule, permissionRuleError } from '../../../../src/shared/permissionRules'

export function PermissionScope({ project, value, onChange, disabled = false }: { project?: string | null; value: 'all' | 'project'; onChange: (value: 'all' | 'project') => void; disabled?: boolean }) {
  return <label>Scope<span className="gc-select-well"><select className="gc-input-well" aria-label="Permission scope" value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value as 'all' | 'project')}>
    <option value="all">All projects</option>
    {project && <option value="project">This project: {project.split('/').filter(Boolean).pop() || project}</option>}
  </select><ChevronDown size={16} strokeWidth={1.75} className="gc-select-chevron" aria-hidden="true" /></span></label>
}

/** Personal rules save on explicit Add/Remove; typing never reads or writes settings.json. */
export function PermissionsTab({ cwd }: { cwd?: string }) {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null)
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setSnapshot(null); setError(''); setBusy(false); setScope('all')
    void readPermissions(cwd).then(value => { if (generation.current === current) setSnapshot(value) }, problem => { if (generation.current === current) setError(String(problem)) })
    return () => { generation.current++ }
  }, [cwd])
  const mutate = async (rule: string, deny: boolean, remove: boolean) => {
    if (busy || !snapshot) return false
    const current = generation.current
    setBusy(true); setError('')
    try {
      const next = await changePermission(rule, deny, remove, scope === 'project' ? snapshot.projectRoot ?? undefined : undefined)
      if (current === generation.current) { setSnapshot(value => value ? { ...value, rules: next.rules } : next); return true }
    } catch (problem) { if (current === generation.current) setError(String(problem)) }
    finally { if (current === generation.current) setBusy(false) }
    return false
  }
  const lists = snapshot && (scope === 'project' && snapshot.projectRoot ? snapshot.rules.projects[snapshot.projectRoot] ?? { allow: [], deny: [] } : snapshot.rules)
  return <div className="gc-settings-section gc-permissions">
    <div className="gc-settings-section-head"><h3>Permissions</h3><p>Rules apply to future calls. Deny rules and safety checks always win. Add and Remove save immediately.</p></div>
    <PermissionScope project={snapshot?.projectRoot} value={scope} onChange={setScope} disabled={busy || !snapshot} />
    {error && <p role="alert" className="gc-permission-error">{error}</p>}
    {!snapshot && !error && <p role="status">Loading rules…</p>}
    {lists && <>
      <PermissionList key={`allow:${scope}`} title="Allow" rules={lists.allow} project={scope === 'project'} busy={busy} onChange={(rule, remove) => mutate(rule, false, remove)} />
      <PermissionList key={`deny:${scope}`} title="Deny" rules={lists.deny} project={scope === 'project'} busy={busy} onChange={(rule, remove) => mutate(rule, true, remove)} />
    </>}
  </div>
}

export function PermissionList({ title, rules, project, busy, onChange }: { title: 'Allow' | 'Deny'; rules: string[]; project: boolean; busy: boolean; onChange: (rule: string, remove: boolean) => Promise<boolean> }) {
  const [rule, setRule] = useState('')
  const error = rule ? permissionRuleError(rule, project) : undefined
  return <section className="gc-permission-list" aria-label={`${title} rules`}>
    <h4>{title}</h4>
    {rules.length ? <ul>{rules.map(value => <li key={value}>
      <div><code>{value}</code><p>{describePermissionRule(value, title === 'Deny')}</p></div>
      <button type="button" className="gc-btn-icon" disabled={busy} aria-label={`Remove ${title.toLowerCase()} rule ${value}`} onClick={() => void onChange(value, true)}><Trash2 size={15} aria-hidden="true" /></button>
    </li>)}</ul> : <p>No {title.toLowerCase()} rules.</p>}
    <form className="gc-permission-add" onSubmit={event => { event.preventDefault(); if (!rule || error || busy) return; void onChange(rule, false).then(saved => { if (saved) setRule('') }) }}>
      <input className="gc-input-well" aria-label={`New ${title.toLowerCase()} rule`} aria-invalid={!!error} aria-describedby={error ? `permission-${title}-error` : undefined} value={rule} spellCheck={false} placeholder={title === 'Allow' ? 'Bash(npm test)' : 'Edit(~/.ssh/**)'} onChange={event => setRule(event.currentTarget.value)} />
      <button type="submit" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={!rule || !!error || busy}>Add</button>
      {error && <p id={`permission-${title}-error`} role="status" className="gc-permission-error">{error}</p>}
    </form>
  </section>
}
