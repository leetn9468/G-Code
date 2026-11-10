import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ChevronRight, CircleAlert, CornerDownRight, FolderOpen, Plus, X } from 'lucide-react'
import { createProject, isTauri } from '@/lib/tauri'
import { Modal } from '../shell/Modal'
import { Tooltip } from '../shell/Tooltip'
import '@/styles/projects.css'

const ICON_STROKE = 1.75

interface Props { open: boolean; onClose: () => void; onCreated: (path: string) => Promise<void>; onAddExisting: () => Promise<void> }
export function NewProject({ open: visible, onClose, onCreated, onAddExisting }: Props) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const choose = async () => {
    if (!isTauri()) { setError('Create projects in the desktop app.'); return }
    try { const path = await open({ title: 'Choose where to create your project', directory: true, multiple: false }); if (typeof path === 'string') setParent(path) }
    catch (failure) { setError(String(failure)) }
  }
  const create = async () => {
    if (busy || !parent || !name.trim()) return
    setBusy(true); setError(null)
    try { const path = await createProject(parent, name.trim()); await onCreated(path); setName(''); setParent(''); onClose() }
    catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  return <Modal open={visible} onClose={() => { if (!busy) onClose() }} labelledBy="new-project-title" width={500}>
    <header className="gc-modal-header gc-project-modal-header">
      <div className="gc-modal-heading"><h2 id="new-project-title">New project</h2><p>A folder for your code and conversations.</p></div>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-btn-icon gc-modal-close" aria-label="Close new project" disabled={busy} onClick={onClose}><X size={18} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    <form className="gc-project-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label className="gc-field"><span className="gc-field-label">Project name</span><input className="gc-input-well" aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My new project" disabled={busy} autoComplete="off" spellCheck={false}/></label>
      <label className="gc-field"><span className="gc-field-label">Location</span><button type="button" className={`gc-input-well gc-project-location${parent ? '' : ' empty'}`} onClick={() => void choose()} disabled={busy}><FolderOpen size={17} strokeWidth={ICON_STROKE}/><span>{parent || 'Choose a parent folder…'}</span><ChevronRight size={16} strokeWidth={ICON_STROKE} className="gc-project-location-chevron" aria-hidden="true"/></button></label>
      {parent && name.trim() && <p className="gc-project-path"><CornerDownRight size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>{parent}/{name.trim()}</span></p>}
      {error && <p role="alert" className="gc-project-error"><CircleAlert size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>{error}</span></p>}
      <button className="gc-btn gc-btn-primary gc-project-create" disabled={busy || !parent || !name.trim()}>{busy ? <i className="gc-spinner gc-btn-spinner" aria-hidden="true"/> : <Plus size={16} strokeWidth={2}/>}{busy ? 'Creating…' : 'Create project'}</button>
    </form>
    <footer className="gc-modal-footer gc-project-modal-footer"><span>Already have a codebase?</span><button type="button" className="gc-btn gc-btn-ghost" disabled={busy} onClick={async () => { await onAddExisting(); onClose() }}><FolderOpen size={15} strokeWidth={ICON_STROKE}/>Add existing folder</button></footer>
  </Modal>
}
