// Tool approval tray: docked directly above the composer while a request is
// pending (not a blocking modal). Enter allows and Escape denies from the tray
// or with nothing else focused, which is everything the old focus-trapped modal
// could reach; there is no automatic timeout. The composer stays editable while
// a turn runs, so the tray never takes focus from a text field: an Enter typed
// there sends what the user wrote and must never approve a tool unread. An empty
// composer has nothing to send, so there the tray's keys still answer (after
// the same arming delay), and a live region says the request appeared.

import { useEffect, useRef, useState } from 'react'
import { AlwaysAllow } from './AlwaysAllow'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { easeOut, motionSafe } from '@/lib/motion'
import type { DesktopToolApprovalRequest } from '@/lib/tauri'
import { escapeDisplayControls } from '../../../../src/shared/displayText'

interface Props {
  request: DesktopToolApprovalRequest | null
  /** Every request waiting, oldest first (the CLI's approval-queue); the others are listed under this one. */
  queue?: readonly DesktopToolApprovalRequest[]
  cwd?: string
  onRespond: (allowed: boolean, allowAll: boolean, timedOut?: boolean, networkScope?: 'call' | 'session') => void
}

// Escape controls after JSON serialization, including controls in object keys.
// Keep the actual request input unchanged; this string is only rendered text.
const approvalInputText = (input: unknown) => escapeDisplayControls(JSON.stringify(input, null, 2) ?? '', true)

/**
 * Fields the user types into (the composer, a search box). A request that
 * appears while one has focus leaves it there: a keystroke already under way
 * belongs to what the user was writing, not to the prompt that just appeared.
 */
const TEXT_ENTRY = 'textarea, input, select, [contenteditable]:not([contenteditable="false"])'
/**
 * How long, in ms, Enter does not answer a request that just appeared. Escape
 * (deny) is always safe; an Enter pressed for something else just as the tray
 * rises must not grant a permission the user has not read.
 */
export const APPROVAL_ENTER_ARM_MS = 400

/**
 * The composer's textarea with nothing typed in it. Focus stays there for the
 * whole turn after a send, so this is where a keyboard user usually is when a
 * request appears; with no text, Enter and Escape have nothing else to do.
 */
function emptyComposer(target: Element | null): boolean {
  if (!target?.matches('textarea') || !target.closest('.gc-composer')) return false
  return !String((target as HTMLTextAreaElement).value ?? '').trim()
}

const approvalTitle = (request: DesktopToolApprovalRequest) => request.network ? 'Network approval required' : 'Tool approval required'

/**
 * Who asks, for a request that is not the main conversation's: "workflow agent" or "agent", its
 * label (from a CLI without `origin`, the agent id) and the first 8 characters of the run id.
 * null for the main conversation.
 */
export function approvalOrigin(request: DesktopToolApprovalRequest): { who: string; label?: string; run?: string } | null {
  const origin = request.origin
  const runId = origin?.runId ?? request.runId
  if (!origin && !runId) return null
  const label = origin?.label ?? origin?.agentId ?? request.agentId
  return {
    who: origin?.kind === 'agent' ? 'agent' : 'workflow agent',
    label: label ? escapeDisplayControls(label) : undefined,
    run: runId ? escapeDisplayControls(runId.slice(0, 8)) : undefined,
  }
}

/** Rises out of the composer; settles back into it on exit. */
const trayIn = motionSafe({
  initial: { opacity: 0, transform: 'translateY(8px)' },
  animate: { opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.22, ease: easeOut } },
  exit: { opacity: 0, transform: 'translateY(6px)', transition: { duration: 0.15, ease: easeOut } },
})

/** One line for a request waiting behind the one shown: its tool, what it does and who asks. */
export function queuedLine(request: DesktopToolApprovalRequest): string {
  const origin = approvalOrigin(request)
  const what = escapeDisplayControls(request.filePath || request.description.split('\n')[0] || '').trim()
  return [request.toolName, what, origin && `asked by ${origin.who}${origin.label ? ` ${origin.label}` : ''}`].filter(Boolean).join(' · ')
}

export function ToolApproval({ request, queue = [], onRespond, cwd }: Props) {
  const [networkScope, setNetworkScope] = useState<'call' | 'session'>('call')
  useEffect(() => setNetworkScope('call'), [request?.requestId])
  const [editing, setEditing] = useState(false)
  useEffect(() => setEditing(false), [request?.requestId])
  const respond = useRef(onRespond)
  respond.current = onRespond
  // The exiting tray keeps its last content on screen for ~150ms; its buttons
  // must not answer a request that is no longer pending.
  const pending = useRef(request)
  pending.current = request
  const card = useRef<HTMLDivElement>(null)
  /** The request the live region announces: one that appeared while focus stayed elsewhere. */
  const [announced, setAnnounced] = useState<string | null>(null)
  const shownAt = useRef(0)
  useEffect(() => { shownAt.current = performance.now() }, [request?.requestId])

  useEffect(() => {
    if (!request) return
    const key = (event: KeyboardEvent) => {
      if (pending.current?.requestId !== request.requestId) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      // A held key repeating, or one pressed as the tray appeared, is not a decision.
      if (event.key === 'Enter' && (event.repeat || performance.now() - shownAt.current < APPROVAL_ENTER_ARM_MS)) return
      const target = event.target instanceof Element ? event.target : null
      // The old approval modal always opened on top of everything. The tray sits
      // in the composer, so another dialog (Settings, ⌘K, the context window) can
      // cover it; while focus is inside one, Enter/Escape belong to that dialog
      // and must not silently answer a prompt the user cannot see.
      if (target?.closest('[aria-modal="true"], [data-permission-editor]')) return
      if (editing) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setEditing(false) }
        return
      }
      // The tray is not modal either, so focus can rest on other live controls
      // (the composer, Stop, Outputs, sidebar rows). Their keys stay theirs: Enter
      // there must never approve. The prompt answers from the tray itself, or from
      // the page body.
      const inTray = Boolean(target && card.current?.contains(target))
      const onPage = !target || target === document.body || target === document.documentElement
      // An empty composer answers too, but only a plain key: Shift+Enter is a new
      // line, and an IME's Enter confirms what is being composed.
      const fromComposer = !inTray && !onPage && emptyComposer(target)
      if (fromComposer && (event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)) return
      if (!inTray && !onPage && !fromComposer) return
      // Enter on a focused tray button activates that button: Deny must deny.
      if (event.key === 'Enter' && inTray && target?.closest('button')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); respond.current(false, false) }
      if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); respond.current(true, false, undefined, request.network ? networkScope : undefined) }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true) }
  }, [request, editing, networkScope])

  // Land keyboard and screen-reader users on the tray once per request (not on
  // every render), unless they are working inside a modal dialog, the side
  // panel (an Enter meant for the shell must never approve) or a text field
  // such as the composer, which stays editable while the turn runs (keys typed
  // after a focus move would be lost, and Enter would approve). From the
  // composer, Shift+Tab reaches the tray's buttons. Focus goes back where it
  // was when the request resolves. When focus stays put, the live region below
  // announces the request instead, since the alertdialog is never focused.
  useEffect(() => {
    if (!request) return
    const element = card.current
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!element || active?.closest('[aria-modal="true"], .gc-side-slot') || active?.matches(TEXT_ENTRY)) { setAnnounced(request.requestId); return }
    setAnnounced(null)
    const previous = active && active !== document.body && !element.contains(active) ? active : null
    element.focus({ preventScroll: true })
    return () => {
      if (!element.contains(document.activeElement)) return
      if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true })
      else element.blur()
    }
  }, [request])

  const answer = (allowed: boolean) => { if (request && pending.current?.requestId === request.requestId) onRespond(allowed, false, undefined, request.network ? networkScope : undefined) }
  const origin = request ? approvalOrigin(request) : null
  const waiting = request ? queue.filter(item => item.requestId !== request.requestId) : []

  return (
    <>
    {/* Always mounted, so screen readers see its text change. */}
    <span className="sr-only" aria-live="assertive" aria-atomic="true">{request && announced === request.requestId ? `${approvalTitle(request)}: ${request.toolName}` : ''}</span>
    <AnimatePresence initial={false}>
      {request && <motion.div
        key="tool-approval"
        ref={card}
        className="gc-approval-tray"
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="tool-approval-title"
        aria-describedby="tool-approval-origin tool-approval-description tool-approval-source tool-approval-path tool-approval-reason"
        tabIndex={-1}
        variants={trayIn}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <div className="gc-approval-header">
          <span className="gc-approval-icon" aria-hidden="true"><ShieldAlert size={18} strokeWidth={1.75} /></span>
          <div className="gc-approval-heading">
            <h2 id="tool-approval-title">{approvalTitle(request)}</h2>
            <span>{request.network ? 'Guillotine Mode' : request.source ?? 'Permission'} gate</span>
          </div>
          <span className="gc-approval-tool">{request.toolName}</span>
        </div>
        {/* The one scroller in the tray. Focusable so long input can be read
            from the keyboard (WebKit does not make scrollers tabbable). */}
        <div className="gc-approval-body" tabIndex={0} role="group" aria-label="Request details">
          {/* A workflow agent or sub-agent asks: say which, so it is not mistaken for the main conversation. */}
          {origin && <div id="tool-approval-origin" className="gc-approval-path gc-approval-origin">Asked by {origin.who}{origin.label && <> <bdi>{origin.label}</bdi></>}{origin.run && <> · run {origin.run}</>}</div>}
          <p id="tool-approval-description" style={{ whiteSpace: 'pre-line' }}>{request.description || 'G-Code wants to run this tool.'}</p>
          {request.workflowSource && <div id="tool-approval-source" className="gc-approval-path">Source: {request.workflowSource.kind}{request.workflowSource.path && <> · <bdi>{request.workflowSource.path}</bdi></>}</div>}
          {request.filePath && <div id="tool-approval-path" className="gc-approval-path">{request.filePath}</div>}
          {/* The gate often sends the same text as description and reason; show it once. */}
          {request.reason && request.reason !== request.description && <div id="tool-approval-reason" className="gc-approval-reason"><AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" /><span>{request.reason}</span></div>}
          {request.network && <><p className="gc-approval-path">Expected destinations: {request.network.hosts.join(', ') || 'Unknown. Unapproved traffic will stop the session.'}</p><label className="gc-network-scope">Approve destinations for <select value={networkScope} onChange={event => setNetworkScope(event.currentTarget.value as 'call' | 'session')}><option value="call">This call only</option><option value="session">This session</option></select></label></>}
          {request.input != null && <pre className="gc-approval-input">{approvalInputText(request.input)}</pre>}
          {waiting.length > 0 && <div className="gc-approval-queue" role="group" aria-label={`${waiting.length} more waiting`}>
            <span>Next, {waiting.length} more waiting</span>
            <ol>{waiting.map(item => <li key={item.requestId}><bdi>{queuedLine(item)}</bdi></li>)}</ol>
          </div>}
        </div>
        {editing && request.suggestedRule && <AlwaysAllow key={request.requestId} suggestion={request.suggestedRule} project={request.projectRoot || cwd}
          onCancel={() => setEditing(false)} onSaved={() => { if (pending.current?.requestId === request.requestId) answer(true) }} />}
        {!editing && <div className="gc-approval-footer">
          <span className="gc-approval-timeout">Waiting for your decision{waiting.length ? `; ${waiting.length} more after this one` : ''}. No automatic timeout.</span>
          <div className="gc-approval-actions">
            {!request.network && request.suggestedRule && <button type="button" className="gc-btn gc-btn-ghost" onClick={() => setEditing(true)}>Always allow…</button>}
            <button type="button" className="gc-btn gc-btn-ghost" onClick={() => answer(false)} aria-keyshortcuts="Escape">Deny <kbd className="gc-kbd">Esc</kbd></button>
            <button type="button" className="gc-btn gc-btn-primary" onClick={() => answer(true)} aria-keyshortcuts="Enter">Allow <kbd className="gc-kbd inverse">↵</kbd></button>
          </div>
        </div>}
      </motion.div>}
    </AnimatePresence>
    </>
  )
}
