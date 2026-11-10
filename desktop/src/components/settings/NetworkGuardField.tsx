import { useEffect, useState } from 'react'
import type { GCodeSettings } from '@/lib/settings'
import { listNetworkIncidents, deleteNetworkIncident, revealNetworkIncident, type IncidentSummary } from '@/lib/tauri'
import { CLOUD_GUARD_REASON, guardEligible, guardHost } from '../../../../src/shared/networkGuard'

export function NetworkGuardField({ settings, onUpdate }: { settings: GCodeSettings; onUpdate: (patch: Partial<GCodeSettings>) => void }) {
  const value = settings.execution.networkGuard ?? { enabled: false, allowlist: [] }
  const eligible = guardEligible(settings.provider.currentProvider, settings.provider.currentProvider === 'ollama' ? settings.provider.ollamaHost : undefined)
  const [host, setHost] = useState(''), [error, setError] = useState(''), [rows, setRows] = useState<IncidentSummary[]>([]), [deleting, setDeleting] = useState<string | null>(null), [unreadable, setUnreadable] = useState(0)
  useEffect(() => { let live = true; void listNetworkIncidents().then(v => { if (live) { setRows(v.rows); setUnreadable(v.unreadable) } }).catch(e => { if (live) setError(String(e)) }); return () => { live = false } }, [])
  const change = (patch: Partial<typeof value>) => onUpdate({ execution: { ...settings.execution, networkGuard: { ...value, ...patch } } })
  const add = () => { const normalized = guardHost(host.trim()); if (!normalized) { setError('Enter a host or host:port, without a URL or wildcard.'); return } change({ allowlist: [...new Set([...value.allowlist, normalized])] }); setHost(''); setError('') }
  return <div className="gc-settings-section gc-budget-settings">
    <div className="gc-settings-section-head"><h3>Guillotine Mode</h3><p>Stops local-model work when a tool contacts an unapproved destination and keeps read-only evidence. Changes apply when the session starts.</p><p>It covers connections off this Mac made during the session. It does not stop a tool from reaching anything listening on this Mac itself, such as a local proxy, tunnel or VPN client that isn’t set in your environment or system settings, and that can carry traffic out with no hold. It does not cover files that run later, such as login items or shell startup files.</p></div>
    <label className="gc-settings-check"><input type="checkbox" checked={value.enabled} disabled={!eligible} onChange={e => change({ enabled: e.currentTarget.checked })} />Block unapproved network access by local models</label>
    {!eligible && <p className="gc-settings-path">{CLOUD_GUARD_REASON}</p>}
    <div className="gc-settings-field">
      <label htmlFor="gc-network-host">Approved hosts</label>
      <div className="gc-settings-inline"><input id="gc-network-host" className="gc-input-well" value={host} placeholder="registry.npmjs.org" onChange={e => setHost(e.currentTarget.value)} /><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" onClick={add}>Add host</button></div>
    </div>
    {value.allowlist.length > 0 && <div className="gc-network-list">{value.allowlist.map(h => <div className="gc-network-row" key={h}><bdi>{h}</bdi><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" aria-label={`Remove ${h}`} onClick={() => change({ allowlist: value.allowlist.filter(v => v !== h) })}>Remove</button></div>)}</div>}
    <p className="gc-settings-path">Network commands still ask for your approval first. If a tool reaches an address G-Code can’t identify, you can only reject it.</p>
    <h4 className="gc-settings-subhead">Incidents</h4>{!rows.length && !unreadable && <p className="gc-settings-path">No incidents saved.</p>}
    {unreadable > 0 && <p className="gc-settings-path">{unreadable} incident {unreadable === 1 ? 'folder' : 'folders'} in ~/.gcode/incidents could not be read and {unreadable === 1 ? 'is' : 'are'} not listed. The files were left as they are.</p>}
    {rows.map(row => <div className="gc-network-incident-row" key={row.id}><p>{new Date(row.at).toLocaleString('en-US')} · {typeof row.model === 'string' ? row.model : `${row.model.provider}:${row.model.name}`}</p><p><bdi>{row.destination}</bdi> · {row.decision ?? 'Awaiting decision'}</p><div className="gc-budget-add-actions"><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void revealNetworkIncident(row.id).catch(e => setError(String(e)))}>Show in Finder</button><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => setDeleting(row.id)}>Delete</button></div>
      {deleting === row.id && <div role="group" aria-label="Confirm incident deletion"><p>Move this incident to Trash? Evidence will remain recoverable there.</p><div className="gc-budget-add-actions"><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => setDeleting(null)}>Cancel</button><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void deleteNetworkIncident(row.id).then(() => { setRows(current => current.filter(r => r.id !== row.id)); setDeleting(null) }).catch(e => setError(String(e)))}>Move to Trash</button></div></div>}
    </div>)}
    {error && <p role="alert" className="gc-settings-callout">{error}</p>}
  </div>
}
