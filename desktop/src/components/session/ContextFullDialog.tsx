// Asked mid-turn when the context window is about 85% full: hand off to a new
// session (recommended), compact and continue here, or stop. Escape, a scrim
// click and any other close mean Stop. Focus starts on the recommended choice;
// the arrow keys move between the three choices and Tab cycles as usual.

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Layers } from 'lucide-react'
import { Modal } from '../shell/Modal'
import type { ContextFullRequest } from '../chat/useChatSession'
import type { ContextFullChoice } from '../../../../src/shared/execution'
import { contextCheckPercent, contextTone } from './SessionControls'
import '@/styles/workbench-controls.css'

/** 172000 → "172K", 1500 → "1.5K", 1000000 → "1M", 1048576 → "1.05M". */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 10_000) return `${parseFloat((count / 1000).toFixed(1))}K`
  if (count < 999_500) return `${Math.round(count / 1000)}K`
  return `${parseFloat((count / 1_000_000).toFixed(2))}M`
}

/** Whole percent of the window in use, or null when the limit is unknown. */
export function contextPercent(used: number, limit: number): number | null {
  if (!(limit > 0)) return null
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
}

/** "This turn is using 172K of 200K tokens." With the check's output reserve: "…, with 12K more kept for the reply." */
export function contextFullSummary(used: number, limit: number, reserved?: number): string {
  const using = limit > 0 ? `This turn is using ${formatTokenCount(used)} of ${formatTokenCount(limit)} tokens` : `This turn is using ${formatTokenCount(used)} tokens`
  return reserved && reserved > 0 ? `${using}, with ${formatTokenCount(reserved)} more kept for the reply.` : `${using}.`
}

/**
 * The meter's percent and tone. With the output reserve the check counted, the same figure and
 * tone as the context ring; from an older CLI (no reserve), the prompt's share of the window.
 */
export function contextFullMeter(request: Pick<ContextFullRequest, 'used' | 'limit' | 'reserved'>): { pct: number | null; tone: string } {
  if (request.reserved === undefined) {
    const pct = contextPercent(request.used, request.limit)
    return { pct, tone: pct !== null && pct > 95 ? ' is-critical' : ' is-warning' }
  }
  const pct = contextCheckPercent({ used: request.used, limit: request.limit, reserved: request.reserved, checkReserved: request.reserved, safety: 0 })
  return { pct, tone: contextTone(pct) }
}

interface Props {
  request: ContextFullRequest | null
  onChoose: (choice: ContextFullChoice) => void
}

export function ContextFullDialog({ request, onChoose }: Props) {
  // The exit animation keeps showing the request that was just answered.
  const last = useRef<ContextFullRequest | null>(request)
  if (request) last.current = request
  const shown = request ?? last.current
  const answered = useRef<string | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const choices = useRef<HTMLDivElement>(null)
  const requestId = request?.requestId ?? null

  useEffect(() => {
    if (!requestId) return
    answered.current = null
    // The Modal focuses its panel when it opens; move on to the recommended choice after that.
    const frame = requestAnimationFrame(() => primary.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [requestId])

  const choose = (choice: ContextFullChoice) => {
    if (!request || answered.current === request.requestId) return
    answered.current = request.requestId
    onChoose(choice)
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(choices.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1)
    buttons[next]?.focus()
  }

  const used = shown?.used ?? 0
  const limit = shown?.limit ?? 0
  const { pct, tone } = contextFullMeter({ used, limit, reserved: shown?.reserved })

  return <Modal open={request !== null} onClose={() => choose('stop')} labelledBy="context-full-title" width={500}>
    <section className="gc-context-full">
      <header className="gc-context-full-header">
        <span className="gc-context-full-icon" aria-hidden="true"><Layers size={18} strokeWidth={1.75} /></span>
        <h2 id="context-full-title">Context window almost full</h2>
      </header>
      <p className="gc-context-full-summary">{contextFullSummary(used, limit, shown?.reserved)}</p>
      {pct !== null && <div className="gc-context-full-meter" aria-hidden="true">
        <div className={`gc-context-meter${tone}`}><i style={{ width: `${pct}%` }} /></div>
        <span className="gc-context-pct">{pct}%</span>
      </div>}
      <p className="gc-context-full-explain">Near the limit the model can no longer take in the whole conversation, so G-Code paused this turn. Choose how to continue.</p>
      <div ref={choices} className="gc-context-full-choices" role="group" aria-label="How to continue" onKeyDown={moveFocus}>
        <button ref={primary} type="button" className="gc-context-choice is-primary" aria-labelledby="context-full-handoff-title" aria-describedby="context-full-handoff" onClick={() => choose('handoff')}>
          <span id="context-full-handoff-title" className="gc-context-choice-title">Continue in a new session</span>
          <small id="context-full-handoff">G-Code writes a handoff of the progress and continues in a new session in this folder.</small>
        </button>
        <button type="button" className="gc-context-choice is-secondary" aria-labelledby="context-full-compact-title" aria-describedby="context-full-compact" onClick={() => choose('compact')}>
          <span id="context-full-compact-title" className="gc-context-choice-title">Compact and continue here</span>
          <small id="context-full-compact">Summarizes the earlier conversation to make room. Details from earlier turns can be lost.</small>
        </button>
        <div className="gc-context-full-stop-row">
          <button type="button" className="gc-context-choice is-ghost" aria-describedby="context-full-stop" onClick={() => choose('stop')}>
            <span className="gc-context-choice-title">Stop</span>
          </button>
          <small id="context-full-stop">Ends this turn. The conversation stays saved.</small>
          <kbd className="gc-kbd" aria-hidden="true">Esc</kbd>
        </div>
      </div>
    </section>
  </Modal>
}
