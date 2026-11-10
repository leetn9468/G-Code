// A tool call as a one-line trace row (Zed / opencode / assistant-ui pattern):
// status icon · tool name · argument chip · state · duration · chevron.
// Consecutive rows share a rail (.gc-tool-group); runs of two or more fold
// into a StepGroup row and show these rows when expanded. Expanding a row
// reveals the input/output wells indented behind that rail.

import { terminalTool, TOOL_LABELS } from '../../../../src/shared/runtimeEvents'
import { memo, useId, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Ban, Check, ChevronRight, CircleDashed, CircleMinus, Hand, X } from 'lucide-react'
import { collapse } from '@/lib/motion'
import type { ToolExecution, ToolState } from './types'

function display(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value ?? '') }
}

/** "12ms" for quick calls, then "4.2s", "37s", "1m 3s". Rounds once, before
 *  choosing a unit, so 9.96s reads "10s" and 119.7s "2m 0s" (not "1m 60s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const tenths = Math.round(ms / 100)
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const inputOf = (tool: ToolExecution) => typeof tool.input === 'object' && tool.input ? tool.input as Record<string, unknown> : {}

/** The file a call works on (FileRead/FileEdit/FileWrite, NotebookEdit, search roots). */
export function toolPath(tool: ToolExecution): string {
  const input = inputOf(tool)
  return text(input.path ?? input.file_path ?? input.notebook_path)
}

/** The row's argument chip: the command, else the pattern, query or URL
 *  (with the path when there is one), else the path. */
export function toolArgument(tool: ToolExecution): string {
  const input = inputOf(tool)
  const path = text(input.path ?? input.file_path)
  const command = text(input.command)
  // Search and fetch tools describe themselves by pattern, query or URL.
  const target = text(input.pattern ?? input.query ?? input.url)
  return command || (target && path ? `${target} · ${path}` : target || path)
}

function StatusIcon({ state }: { state: ToolState }) {
  const props = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const
  switch (state) {
    case 'preparing':
    case 'queued': return <CircleDashed {...props} />
    case 'validating':
    // The shared ring spinner, so a running row matches the composer caption
    // and the Activity panel (same colour and speed).
    case 'running': return <i className="gc-spinner" aria-hidden="true" />
    case 'awaiting_approval': return <Hand {...props} />
    case 'complete': return <Check {...props} strokeWidth={2} />
    case 'failed': return <X {...props} strokeWidth={2} />
    case 'denied': return <Ban {...props} />
    // The tool itself refused it before it ran: nothing executed, nobody denied it.
    case 'refused': return <CircleMinus {...props} />
    case 'cancelled': return <Ban {...props} />
    default: return <CircleDashed {...props} />
  }
}

// Memoised like MessageBubble: tool updates replace only the changed record.
export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolExecution }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  // The time it ran, not the time since its arguments began to stream (that adds the rest of the reply and the queue).
  const duration = tool.completedAt ? tool.completedAt - (tool.runningAt ?? tool.startedAt) : null
  const settled = terminalTool(tool.state)
  const argument = toolArgument(tool)
  // Without a path or command, a settled failure still says why in the row.
  const note = !argument && settled ? tool.error : undefined

  return (
    <article className={`gc-tool ${tool.state}`} data-state={tool.state} data-expanded={expanded ? '' : undefined}>
      <button type="button" className="gc-tool-row" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={bodyId}>
        <span className="gc-tool-status-icon"><StatusIcon state={tool.state} /></span>
        <span className="gc-tool-name" translate="no">{tool.name}</span>
        {argument && <span className="gc-tool-arg" translate="no" title={argument}>{argument}</span>}
        {note && <span className="gc-tool-note" title={note}>{note}</span>}
        <span className="gc-tool-spacer" />
        {/* The green check already says "Complete"; keep the word for screen
            readers and spell out only the states that need attention. */}
        <span className={`gc-tool-state${settled || tool.state === 'awaiting_approval' ? '' : ' gc-shimmer-text'}${tool.state === 'complete' ? ' sr-only' : ''}`}>{TOOL_LABELS[tool.state]}</span>
        {duration != null && <span className="gc-tool-duration">{formatDuration(duration)}</span>}
        <ChevronRight className="gc-tool-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="body" id={bodyId} className="gc-tool-body" variants={collapse} initial="initial" animate="animate" exit="exit">
            <div className="gc-tool-body-inner">
              {tool.detail && !settled && <p className="gc-tool-detail">{tool.detail}</p>}
              {tool.inputPreview != null && tool.input == null && <><div className="gc-tool-label">Receiving arguments · {tool.inputChars?.toLocaleString()} characters</div><pre className="gc-tool-well">{tool.inputPreview}</pre></>}
              {tool.input != null && <><div className="gc-tool-label">Input</div><pre className="gc-tool-well">{display(tool.input)}</pre></>}
              {(tool.output != null || tool.error) && <><div className="gc-tool-label">Output</div><pre className={`gc-tool-well${tool.error ? ' is-error' : ''}`}>{tool.error ?? display(tool.output)}</pre></>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  )
})
