import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type TargetAndTransition, type Transition, type Variants } from 'motion/react'
import { ChevronRight, CircleAlert, Clock3, Folder, FolderOpen, MessageSquare, MessageSquareDashed, Plus, RefreshCw, Search, Settings2, Trash2, Wrench } from 'lucide-react'
import { Tooltip } from '@/components/shell/Tooltip'
import { collapse, fade, flatProjection, springCollapse, springIndicator } from '@/lib/motion'
import type { SavedSession } from '@/lib/tauri'
import { SESSION_STATUS_LABEL, type SessionStatus } from '@/lib/sessionStatus'
import { groupSessions, sessionKey, type Project } from '@/lib/projects'
import { continuationRequest, isHandoffContinuation } from '../../../../src/shared/execution'
import '@/styles/sidebar.css'

interface Props {
  activityPanel?: ReactNode
  cwd?: string
  projects: Project[]
  sessions: SavedSession[]
  loading: boolean
  error: string | null
  deleting: string | null
  onRefresh: () => void
  onDelete: (session: SavedSession) => Promise<void>
  currentSessionId: string
  /** The chat whose work is running while another one is on screen: it cannot be deleted either. */
  runningSessionId?: string
  /** Status light for a chat row; undefined shows none. */
  statusOf: (sessionId: string, active: boolean) => SessionStatus | undefined
  onNew: () => void
  onNewRecent: () => void
  onResume: (session: SavedSession) => void
  onSelectProject: (path: string) => void
  onNewProject: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onOpenMcp: () => void
}
// The first message of a session that took over from a handoff (handoffContinuation
// in src/shared/execution.ts) quotes the user's request. continuationRequest() is
// undefined both for other messages and for a continuation that did not record the
// request, and only the latter is titled CONTINUED_SESSION.
/** Shown for a session that took over from a handoff whose request was not recorded. */
export const CONTINUED_SESSION = 'Continued session'

/**
 * A chat row's title: the first user message; for a session that took over
 * from a handoff, the user's request it continues (quoted in the continuation),
 * or CONTINUED_SESSION when the request was not recorded.
 */
export function chatTitle(session: { messages: ReadonlyArray<{ role: string; content: unknown; metadata?: { attachments?: ReadonlyArray<{ name: string }> } }> }): string {
  const message = session.messages.find((entry) => entry.role === 'user')
  const first = message?.content
  if (first === undefined) return 'Untitled session'
  const text = String(first)
  // A message of attached files only is named by its files.
  if (!text.trim() && message?.metadata?.attachments?.length) return message.metadata.attachments.map(file => file.name).join(', ')
  if (!isHandoffContinuation(text)) return text
  return continuationRequest(text)?.trim() || CONTINUED_SESSION
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
function relative(timestamp: number) { const delta = Date.now() - timestamp; if (delta < 60_000) return 'Just now'; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`; if (delta < 86_400_000) return `${plural(Math.floor(delta / 3_600_000), 'hour')} ago`; if (delta < 172_800_000) return 'Yesterday'; return new Date(timestamp).toLocaleDateString() }

// Icons beside 14px text use a 1.75 stroke so they carry the same optical weight.
const STROKE = 1.75

// Group bodies open with the shared height spring. They clip only while
// moving, so the active-row pill can glide between groups without being cut off.
// The exit is a critically damped spring, faster than the enter. The shared
// `collapse.exit` adds `stiffness` to a visualDuration spring, which makes Motion
// fall back to its default damping (ratio ~0.22): height would swing through
// zero for ~1.3s and jolt the rows below.
const reveal: Variants = {
  initial: { ...(collapse.initial as TargetAndTransition), overflow: 'hidden' },
  animate: { ...(collapse.animate as TargetAndTransition), transitionEnd: { overflow: 'visible' } },
  exit: { height: 0, opacity: 0, overflow: 'hidden', transition: { height: { ...springCollapse, visualDuration: 0.2 }, opacity: { duration: 0.1 } } },
}
// Reduced motion: keep a short opacity fade, drop the height movement.
const revealReduced: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: { duration: 0.1 } },
}
// Selection changes that did not come from a click in the list (⌘K, ⌘N, restore) jump instantly.
const instant: Transition = { duration: 0 }
// How long a clicked row keeps the pill while its saved chat is still loading.
const PENDING_MS = 2000

export function SessionList({ activityPanel, cwd, projects, sessions, loading, error, deleting, onRefresh, onDelete, currentSessionId, runningSessionId, statusOf, onNew, onNewRecent, onResume, onSelectProject, onNewProject, onOpenSearch, onOpenSettings, onOpenMcp }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const reduceMotion = useReducedMotion()
  const groupVariants = reduceMotion ? revealReduced : reveal
  const groups = groupSessions(projects, sessions)

  // The selection pill glides only after a pointer click on a row; keyboard and
  // programmatic selection changes (palette, shortcuts, restore) are instant.
  // Resuming is asynchronous and first clears the selection, so a layoutId pill
  // that followed the real selection would unmount and reappear without
  // gliding. A pointer click therefore moves the pill to the clicked row at
  // once (old and new pill swap in one commit) and holds it there until the
  // resume lands, another chat becomes active, or PENDING_MS passes.
  const activeSession = sessions.find((session) => session.sessionId === currentSessionId && session.cwd === cwd)
  const activeKey = activeSession ? sessionKey(activeSession) : null
  const [pending, setPending] = useState<{ key: string; from: string | null } | null>(null)
  const pillKey = pending?.key ?? activeKey
  useEffect(() => {
    if (!pending) return
    if (activeKey === pending.key || (activeKey && activeKey !== pending.from)) { setPending(null); return }
    const timer = window.setTimeout(() => setPending(null), PENDING_MS)
    return () => window.clearTimeout(timer)
  }, [pending, activeKey])

  const chatRow = (session: SavedSession) => {
    const key = sessionKey(session)
    const preview = chatTitle(session)
    const active = session.sessionId === currentSessionId && session.cwd === cwd
    // Highlight follows the pill so a clicked row reads as selected while it loads.
    const selected = key === pillKey
    const status = statusOf(session.sessionId, active)
    return <div key={key} className={`gc-sidebar-chat ${selected ? 'active' : ''}`}>
      {selected && <motion.span layoutId="active-chat" layoutDependency={pillKey} transition={pending ? springIndicator : instant} transformTemplate={flatProjection} className="gc-sidebar-chat-pill" aria-hidden="true"/>}
      <button type="button" className="gc-sidebar-chat-open" onClick={(event) => { if (event.detail > 0 && key !== activeKey) setPending({ key, from: activeKey }); onResume(session) }} aria-current={active ? 'page' : undefined} title={preview}>
        <span className="gc-sidebar-chat-mark">{status && <i className="gc-session-light" data-status={status} role="img" aria-label={SESSION_STATUS_LABEL[status]} title={SESSION_STATUS_LABEL[status]}/>}</span>
        <span className="gc-sidebar-chat-text">
          <strong className="gc-sidebar-chat-title">{preview}</strong>{' '}
          <small className="gc-sidebar-chat-meta">{relative(session.savedAt)} · {plural(session.messageCount ?? session.messages.length, 'message')}</small>
        </span>
      </button>
      <button type="button" className="gc-sidebar-chat-delete" disabled={active || session.sessionId === runningSessionId || Boolean(deleting)} title={session.sessionId === runningSessionId ? 'This chat is still running.' : active ? 'Start a new chat before deleting this one.' : 'Delete saved session'} aria-label={`Delete session ${session.sessionId}`} onClick={() => { if (!deleting && window.confirm('Delete this saved session? Its Changes history, session notes and task records go with it.')) void onDelete(session) }}><Trash2 size={14} strokeWidth={STROKE}/></button>
    </div>
  }

  const rows = (records: SavedSession[], group: string) => <>
    {records.slice(0, 5).map(chatRow)}
    <AnimatePresence initial={false}>
      {expanded[group] && records.length > 5 && <motion.div key="more" className="gc-sidebar-more" variants={groupVariants} initial="initial" animate="animate" exit="exit">{records.slice(5).map(chatRow)}</motion.div>}
    </AnimatePresence>
    {records.length > 5 && <button type="button" className="gc-sidebar-show-more" onClick={() => setExpanded((before) => ({ ...before, [group]: !before[group] }))}>{expanded[group] ? 'Show less' : `Show all ${records.length} chats`}</button>}
  </>

  return <aside className="gc-sessions gc-sidebar" aria-label="Sessions">
    {/* Empty parts of the row drag the window; both buttons still click. */}
    <div className="gc-sidebar-brand" data-tauri-drag-region="deep">
      <button type="button" className="gc-sidebar-search" onClick={onOpenSearch} aria-label="Search commands or chats (⌘K)"><Search size={15} strokeWidth={STROKE}/><span>Search</span><kbd className="gc-kbd">⌘K</kbd></button>
      <Tooltip content="New chat" side="bottom"><button type="button" className="gc-sidebar-new" onClick={onNew} aria-label="New chat"><Plus size={16} strokeWidth={2}/><kbd className="gc-kbd" aria-hidden="true">⌘N</kbd></button></Tooltip>
    </div>
    <div className="gc-sidebar-section">
      <h2>Projects</h2>
      <Tooltip content="Refresh chats" side="right"><button type="button" className="gc-sidebar-icon gc-sidebar-refresh" aria-label="Refresh sessions" onClick={onRefresh} disabled={loading}><RefreshCw size={14} strokeWidth={STROKE} className={loading ? 'is-loading' : undefined}/></button></Tooltip>
    </div>
    <button type="button" className="gc-sidebar-add-project" onClick={onNewProject}><Plus size={16} strokeWidth={STROKE}/><span>New project</span></button>
    {error && <p role="alert" className="gc-sidebar-error"><CircleAlert size={15} strokeWidth={STROKE}/><span>{error}</span></p>}
    <div className="gc-sidebar-items" aria-busy={loading}>
      <LayoutGroup id="gc-sidebar">
        {groups.projects.map((project) => {
          const open = !collapsed[project.path]
          return <section className="gc-project-group" key={project.path} aria-label={`Project ${project.name}`}>
            <div className={`gc-project-group-header ${cwd === project.path ? 'active' : ''}`}>
              <button type="button" className="gc-project-collapse" aria-label={`${collapsed[project.path] ? 'Expand' : 'Collapse'} ${project.name}`} aria-expanded={!collapsed[project.path]} onClick={() => setCollapsed((before) => ({ ...before, [project.path]: !before[project.path] }))}><ChevronRight size={14} strokeWidth={2}/></button>
              <button type="button" className="gc-project-select" onClick={() => onSelectProject(project.path)} title={project.path}>{open ? <FolderOpen size={16} strokeWidth={STROKE}/> : <Folder size={16} strokeWidth={STROKE}/>}<strong>{project.name}</strong></button>
              <Tooltip content={`New chat in ${project.name}`} side="right"><button type="button" className="gc-sidebar-icon gc-sidebar-row-action" aria-label={`New chat in ${project.name}`} onClick={() => onSelectProject(project.path)}><Plus size={15} strokeWidth={STROKE}/></button></Tooltip>
            </div>
            <AnimatePresence initial={false}>
              {open && <motion.div key="chats" className="gc-project-group-body" variants={groupVariants} initial="initial" animate="animate" exit="exit">
                {project.sessions.length ? rows(project.sessions, project.path) : <p className="gc-sidebar-group-empty"><MessageSquareDashed size={14} strokeWidth={STROKE}/>No chats yet</p>}
              </motion.div>}
            </AnimatePresence>
          </section>
        })}
        <section className="gc-recents-group" aria-label="Recents outside projects">
          <div className="gc-project-group-header gc-recents-header"><Clock3 size={16} strokeWidth={STROKE}/><h2>Recents</h2><Tooltip content="New chat outside projects" side="right"><button type="button" className="gc-sidebar-icon gc-sidebar-row-action" aria-label="New chat outside projects" onClick={onNewRecent}><Plus size={15} strokeWidth={STROKE}/></button></Tooltip></div>
          {groups.recents.length ? rows(groups.recents, 'recents') : <div className="gc-sidebar-empty"><MessageSquare size={16} strokeWidth={STROKE}/><span>{loading ? 'Loading chats…' : 'Chats outside projects appear here.'}</span></div>}
        </section>
      </LayoutGroup>
    </div>
    <div className="gc-sidebar-dock">
      {activityPanel}
      <nav className="gc-sidebar-footer" aria-label="Workspace settings">
        <button type="button" onClick={onOpenMcp}><Wrench size={16} strokeWidth={STROKE}/><span>Tools & MCP</span></button>
        <button type="button" onClick={onOpenSettings}><Settings2 size={16} strokeWidth={STROKE}/><span>Settings</span><kbd className="gc-kbd" aria-hidden="true">⌘,</kbd></button>
      </nav>
    </div>
  </aside>
}
