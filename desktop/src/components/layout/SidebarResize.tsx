import { useRef, type PointerEvent } from 'react'
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX, sidebarWidth } from '@/lib/sidebar'

export function SidebarResize({ width, onChange, onCommit }: { width: number; onChange: (width: number) => void; onCommit: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number; current: number } | null>(null)
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (!drag.current) return
    const next = cancel ? drag.current.width : drag.current.current
    drag.current = null
    event.currentTarget.parentElement?.classList.remove('is-resizing')
    onChange(next); onCommit(next)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="session-sidebar"
    aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width} className="gc-sidebar-resize"
    title="Drag to resize · Double-click to reset"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width, current: width }; event.currentTarget.parentElement?.classList.add('is-resizing'); event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => { if (drag.current) { const next = sidebarWidth(drag.current.width + event.clientX - drag.current.x); drag.current.current = next; onChange(next) } }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => finish(event)}
    onDoubleClick={() => { onChange(SIDEBAR_DEFAULT); onCommit(SIDEBAR_DEFAULT) }}
    onKeyDown={event => { const next = event.key === 'Home' ? SIDEBAR_MIN : event.key === 'End' ? SIDEBAR_MAX : event.key === 'ArrowLeft' ? width - 10 : event.key === 'ArrowRight' ? width + 10 : null; if (next !== null) { event.preventDefault(); onChange(sidebarWidth(next)); onCommit(sidebarWidth(next)) } }}/>
}
