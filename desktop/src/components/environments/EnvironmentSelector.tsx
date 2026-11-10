import { Check, Cloud, Info, Monitor, PanelRightClose, TriangleAlert } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import type { ExecutionEnvironment } from '@/lib/environments'
import '@/styles/environments.css'

const ICON_STROKE = 1.75

/** Why the environment cannot change while `busy`: a reply streams, or (`takeover`) the session that takes over from a handoff is starting. */
export function environmentBusyNote(takeover: boolean): string {
  return takeover ? 'Wait for the new session to start.' : 'Stop the current response before changing environments.'
}

/** The side panel's environment view. onClose(slide): closed with the pointer. */
interface Props { open: boolean; current: ExecutionEnvironment; busy: boolean; takeover?: boolean; onClose: (slide?: boolean) => void; onChange: (environment: ExecutionEnvironment) => void }
export function EnvironmentSelector({ open, current, busy, takeover = false, onClose, onChange }: Props) {
  return <section className="gc-side-view gc-environment" hidden={!open} tabIndex={-1} aria-labelledby="environment-title">
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="environment-title" className="gc-side-title">{current === 'local' ? <Monitor size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/> : <Cloud size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/>}<span>Execution environment</span></h2>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" onClick={(event) => onClose(event.detail > 0)} aria-label="Close environment selector"><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    <div className="gc-side-body">
    <p className="gc-side-lede">Choose where G-Code runs commands and edits files.</p>
    <div className="gc-environment-options">
      {(['local', 'cloud'] as const).map((environment) => <button type="button" key={environment} disabled={busy} aria-pressed={current === environment} className={`gc-environment-option ${current === environment ? 'selected' : ''}`} onClick={(event) => { onChange(environment); onClose(event.detail > 0) }}>
        <span className="gc-environment-icon" aria-hidden="true">{environment === 'local' ? <Monitor size={20} strokeWidth={ICON_STROKE}/> : <Cloud size={20} strokeWidth={ICON_STROKE}/>}</span>
        <span className="gc-environment-copy"><strong>{environment === 'local' ? 'Local' : 'Cloud'}<em data-status={environment === 'local' ? 'ready' : 'unconfigured'}>{environment === 'local' ? 'Ready' : 'Not configured'}</em></strong><small>{environment === 'local' ? 'Run on this Mac using the selected working folder.' : 'A cloud execution service needs to be connected before tasks can run.'}</small></span>
        <span className="gc-environment-check" aria-hidden="true">{current === environment && <Check size={12} strokeWidth={3}/>}</span>
      </button>)}
    </div>
    <p className={`gc-environment-note${busy ? ' busy' : ''}`}>{busy ? <TriangleAlert size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/> : <Info size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/>}<span>{busy ? environmentBusyNote(takeover) : 'Changing environment starts a new chat. Your AI model is selected separately.'}</span></p>
    </div>
  </section>
}
