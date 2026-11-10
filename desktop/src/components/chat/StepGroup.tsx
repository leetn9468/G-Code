// A run of two or more consecutive tool calls, folded into one row:
// "12 steps · edited 4 files · ran 5 commands · 1 failed" and a chevron.
// While the run is live its current step shows under the row as a live line
// (spinner, tool name, argument); a step waiting for approval holds that line.
// Expanding reveals the usual ToolCard rows on their shared rail.
//
// The expanded state belongs to ChatArea (keyed like the group, by the message
// before it), so it survives re-renders, history backfill and the group being
// remounted. Restored history renders still: both collapsibles use
// AnimatePresence initial={false}, and rows mounted by expanding never replay
// their entrance.

import { Fragment, memo, useId, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, Hand, Layers } from 'lucide-react'
import { terminalTool, TOOL_LABELS } from '../../../../src/shared/runtimeEvents'
import { collapse } from '@/lib/motion'
import { ToolCard, formatDuration, toolArgument, toolPath } from './ToolCard'
import type { ToolExecution } from './types'

export interface Step {
  key: string
  tool: ToolExecution
  /** Appended live (not restored history): may play its entrance. */
  entering: boolean
}

// Engine names first; the short aliases cover providers that report them.
const EDIT_TOOLS = new Set(['FileEdit', 'FileWrite', 'NotebookEdit', 'Edit', 'Write', 'MultiEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
// A command "ran" once it started: queued, denied, refused or still awaiting approval did not.
const RAN = new Set(['running', 'complete', 'failed', 'cancelled'])

export interface StepSummary { steps: number; editedFiles: number; commands: number; failed: number; denied: number; notRun: number }

export function summarizeSteps(tools: readonly ToolExecution[]): StepSummary {
  const edited = new Set<string>()
  let commands = 0, failed = 0, denied = 0, notRun = 0
  for (const tool of tools) {
    if (EDIT_TOOLS.has(tool.name) && tool.state === 'complete') edited.add(toolPath(tool) || `#${tool.id}`)
    if (COMMAND_TOOLS.has(tool.name) && RAN.has(tool.state)) commands++
    if (tool.state === 'failed') failed++
    else if (tool.state === 'denied') denied++
    else if (tool.state === 'refused') notRun++
  }
  return { steps: tools.length, editedFiles: edited.size, commands, failed, denied, notRun }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

type Tone = 'count' | 'failed' | 'denied' | 'refused'

/** The summary line's tokens ("12 steps", "edited 4 files", "1 failed"…): zero counts are left out. */
export function summaryTokens(summary: StepSummary): Array<{ text: string; tone?: Tone }> {
  const tokens: Array<{ text: string; tone?: Tone }> = [{ text: plural(summary.steps, 'step'), tone: 'count' }]
  if (summary.editedFiles) tokens.push({ text: `edited ${plural(summary.editedFiles, 'file')}` })
  if (summary.commands) tokens.push({ text: `ran ${plural(summary.commands, 'command')}` })
  if (summary.failed) tokens.push({ text: `${summary.failed} failed`, tone: 'failed' })
  if (summary.denied) tokens.push({ text: `${summary.denied} denied`, tone: 'denied' })
  if (summary.notRun) tokens.push({ text: `${summary.notRun} not run`, tone: 'refused' })
  return tokens
}

/** The live line's step: one awaiting approval, else the newest unsettled one, else the newest. */
export function currentStep<S extends { tool: ToolExecution }>(steps: readonly S[]): S | undefined {
  let pending: S | undefined
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    if (step.tool.state === 'awaiting_approval') return step
    if (!pending && !terminalTool(step.tool.state)) pending = step
  }
  return pending ?? steps[steps.length - 1]
}

/** Live while any step is unsettled, or while the turn streams and nothing follows the group yet. */
export function stepsLive(tools: readonly ToolExecution[], streaming: boolean, last: boolean): boolean {
  return (streaming && last) || tools.some((tool) => !terminalTool(tool.state))
}

/** First start to last finish, once every step has settled. */
function span(tools: readonly ToolExecution[]): number | null {
  let start = Infinity, end = -Infinity
  for (const tool of tools) {
    if (!terminalTool(tool.state) || !tool.completedAt) return null
    start = Math.min(start, tool.startedAt)
    end = Math.max(end, tool.completedAt)
  }
  return end >= start ? end - start : null
}

function LiveLine({ step }: { step: Step }) {
  const { tool } = step
  const waiting = tool.state === 'awaiting_approval'
  const settled = terminalTool(tool.state)
  const argument = toolArgument(tool)
  // Each new step fades up in place (CSS: content arriving mid-stream).
  return (
    <div className={`gc-step-live-line${step.entering ? ' gc-enter' : ''}`} data-state={tool.state}>
      <span className="gc-step-live-icon">{waiting ? <Hand size={14} strokeWidth={1.75} aria-hidden="true" /> : <i className="gc-spinner" aria-hidden="true" />}</span>
      <span className="gc-step-live-name" translate="no">{tool.name}</span>
      {argument && <span className="gc-tool-arg" translate="no" title={argument}>{argument}</span>}
      {!settled && <span className={`gc-tool-state${waiting ? '' : ' gc-shimmer-text'}`}>{TOOL_LABELS[tool.state]}</span>}
    </div>
  )
}

interface Props {
  groupKey: string
  steps: Step[]
  live: boolean
  expanded: boolean
  onToggle: (groupKey: string) => void
}

// ChatArea rebuilds the step list every render (each streamed token); only a
// changed record, entrance flag or state re-renders the group.
function sameGroup(previous: Props, next: Props) {
  if (previous.groupKey !== next.groupKey || previous.live !== next.live || previous.expanded !== next.expanded || previous.onToggle !== next.onToggle) return false
  if (previous.steps.length !== next.steps.length) return false
  return previous.steps.every((step, index) => {
    const other = next.steps[index]
    return step.key === other.key && step.tool === other.tool && step.entering === other.entering
  })
}

export const StepGroup = memo(function StepGroup({ groupKey, steps, live, expanded, onToggle }: Props) {
  const bodyId = useId()
  const tools = steps.map((step) => step.tool)
  const tokens = summaryTokens(summarizeSteps(tools))
  const current = live ? currentStep(steps) : undefined
  const waiting = steps.some((step) => step.tool.state === 'awaiting_approval')
  const duration = live ? null : span(tools)
  // Rows that mount because the group was expanded are not new: only steps
  // that arrive while it is open play their entrance.
  const [openedWith, setOpenedWith] = useState<ReadonlySet<string> | null>(null)
  if (expanded && !openedWith) setOpenedWith(new Set(steps.map((step) => step.key)))
  else if (!expanded && openedWith) setOpenedWith(null)
  const label = [...tokens.map((token) => token.text), ...(waiting ? ['awaiting approval'] : live ? ['in progress'] : []), ...(duration != null ? [formatDuration(duration)] : [])].join(', ')

  return (
    <div className="gc-flow-item gc-step-group" data-kind="tools" data-live={live ? '' : undefined} data-waiting={waiting ? '' : undefined} data-expanded={expanded ? '' : undefined}>
      <button type="button" className="gc-tool-row gc-step-row" onClick={() => onToggle(groupKey)} aria-expanded={expanded} aria-controls={bodyId} aria-label={label}>
        <span className="gc-tool-status-icon">{waiting ? <Hand size={16} strokeWidth={1.75} aria-hidden="true" /> : <Layers size={15} strokeWidth={1.75} aria-hidden="true" />}</span>
        <span className="gc-step-summary">
          {tokens.map((token, index) => (
            <Fragment key={token.text}>
              {index > 0 && <span className="gc-step-dot" aria-hidden="true"> · </span>}
              <span data-tone={token.tone}>{token.text}</span>
            </Fragment>
          ))}
        </span>
        <span className="gc-tool-spacer" />
        {duration != null && <span className="gc-tool-duration">{formatDuration(duration)}</span>}
        <ChevronRight className="gc-tool-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {current && !expanded && (
          <motion.div key="live" className="gc-step-live" variants={collapse} initial="initial" animate="animate" exit="exit">
            <LiveLine key={current.key} step={current} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="body" id={bodyId} className="gc-step-body" variants={collapse} initial="initial" animate="animate" exit="exit">
            <div className="gc-tool-group">
              {steps.map((step) => (
                <div key={step.key} className={`gc-tool-slot${step.entering && openedWith && !openedWith.has(step.key) ? ' gc-enter' : ''}`}>
                  <ToolCard tool={step.tool} />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}, sameGroup)
