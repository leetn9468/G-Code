// Right side panel: Terminal, Outputs and the execution environment open here,
// beside the conversation, one view at a time (user decision 2026-10-16:
// nothing unfolds below the conversation or as a dialog any more). The header
// icons at the conversation's upper right toggle the views; the panel's left
// edge resizes it. Every view stays mounted while hidden, so terminals keep
// their shells and Outputs keeps its selection.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { isTooltipEscape } from '../shell/Tooltip'
import '@/styles/sidepanel.css'

export type SideView = 'terminal' | 'outputs' | 'environment' | 'changes' | 'files' | 'browser' | 'tasks'

const WIDTH_DEFAULT = 420
const WIDTH_MIN = 300
const WIDTH_MAX = 960
const WIDTH_KEY = 'gcode.sidePanel.width'
// The conversation keeps at least this much (sidepanel.css --chat-min).
const CHAT_MIN = 440

const clampWidth = (value: number) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, value)))
function storedWidth() {
  try { const value = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(value) && value >= WIDTH_MIN ? clampWidth(value) : WIDTH_DEFAULT }
  catch { return WIDTH_DEFAULT }
}

interface Props {
  open: boolean
  /** Bumped when Outputs or the environment view should take the keyboard (the terminal focuses its own shell). */
  focusRequest: number
  /** Escape outside the terminal. */
  onClose: () => void
  /** The open or close slide finished. */
  onSlideEnd: () => void
  children: ReactNode
}

export function SidePanel({ open, focusRequest, onClose, onSlideEnd, children }: Props) {
  const [width, setWidth] = useState(storedWidth)
  const slotRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // What the panel actually shows: the stored width gives way to the conversation (CSS --side-room).
  const shownWidth = () => Math.round(panelRef.current?.getBoundingClientRect().width || width)
  /** The widest the panel can be right now, leaving the conversation CHAT_MIN. */
  const roomWidth = () => {
    const chat = document.querySelector<HTMLElement>('.gc-main-panel')?.getBoundingClientRect().width ?? 0
    return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(shownWidth() + chat - CHAT_MIN)))
  }
  // The separator reports what is on screen. The inner panel keeps its width
  // through the open/close slide, so this does not update every frame.
  const [shown, setShown] = useState({ now: width, max: WIDTH_MAX })
  useEffect(() => {
    const panel = panelRef.current
    const chat = document.querySelector<HTMLElement>('.gc-main-panel')
    if (!open || !panel) return
    const update = () => setShown({ now: shownWidth(), max: roomWidth() })
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    if (chat) observer.observe(chat)
    update()
    return () => observer.disconnect()
  }, [open])
  const commit = (value: number) => {
    const next = clampWidth(value)
    setWidth(next)
    try { localStorage.setItem(WIDTH_KEY, String(next)) } catch { /* width is a convenience */ }
  }

  useEffect(() => {
    if (!focusRequest) return
    const frame = requestAnimationFrame(() => slotRef.current?.querySelector<HTMLElement>('.gc-side-view:not([hidden]):not(.gc-terminal-panel)')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [focusRequest])

  // Drag the left edge; measured from the width on screen, saved as what is
  // on screen when the drag ends (so a squeezed panel has no dead zone).
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const slot = slotRef.current
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const start = shownWidth()
    let current = start
    slot?.classList.add('is-resizing')
    const move = (moveEvent: PointerEvent) => { current = clampWidth(start + startX - moveEvent.clientX); setWidth(current) }
    const end = () => {
      slot?.classList.remove('is-resizing')
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end)
      requestAnimationFrame(() => commit(Math.min(current, shownWidth())))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const resizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16
    const now = shownWidth()
    const room = roomWidth()
    const keys: Record<string, number> = { ArrowLeft: Math.min(room, now + step), ArrowRight: now - step, Home: WIDTH_MIN, End: room }
    if (!(event.key in keys)) return
    event.preventDefault()
    // Growing a panel already held at its cap keeps the saved (wider) width.
    if (event.key === 'ArrowLeft' && keys.ArrowLeft <= now) return
    commit(keys[event.key])
  }

  // Escape closes Outputs and the environment view. While the terminal shows,
  // it belongs to the shell (⌃` hides the terminal), the separator included.
  const escape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || slotRef.current?.querySelector('.gc-terminal-panel:not([hidden])')) return
    if (event.defaultPrevented && !isTooltipEscape(event.nativeEvent)) return
    event.preventDefault()
    onClose()
  }

  return (
    <div ref={slotRef} id="gc-side-panel" className={`gc-side-slot${open ? '' : ' is-closed'}`} style={{ '--side-panel-width': `${width}px` } as CSSProperties}
      onKeyDown={escape} onTransitionEnd={(event) => { if (event.target === panelRef.current && event.propertyName === 'transform') onSlideEnd() }}>
      {open && <div className="gc-side-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" aria-controls="gc-side-panel" tabIndex={0}
        aria-valuemin={WIDTH_MIN} aria-valuemax={Math.max(shown.max, shown.now)} aria-valuenow={shown.now} title="Drag to resize · Double-click to reset"
        onPointerDown={startResize} onKeyDown={resizeKey} onDoubleClick={() => commit(WIDTH_DEFAULT)} />}
      <div className="gc-side-clip"><div ref={panelRef} className="gc-side-panel">{children}</div></div>
    </div>
  )
}
