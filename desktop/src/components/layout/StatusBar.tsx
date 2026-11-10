import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import NumberFlow from '@number-flow/react'
import { Folder } from 'lucide-react'
import { workspaceLabel } from '@/lib/workspace'
import { formatGenerationSpeed, type GenerationSpeed } from '@/lib/generationSpeed'
import { fade } from '@/lib/motion'
import { Tooltip } from '../shell/Tooltip'
import '../../styles/statusbar.css'

interface Props {
  sessionShortId: string
  cwd: string
  projectLabel?: string
  sessionRunning: boolean
  streaming: boolean
  onOpenProject: () => void
  turnCount: number
  toolCallCount: number
  errorCount: number
  /** The local model's generation speed, right of the session state; null for cloud models. */
  generationSpeed?: GenerationSpeed | null
  /** Keep-awake menu button, at the far right of the strip. */
  keepAwakeControl?: ReactNode
}

// Rolling digits for counts the user watches change: 500ms instead of the
// library's 900ms default so the strip stays quick.
const countTiming = { duration: 500, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }

// Metrics fade in when the first turn starts and out on a new chat. Opacity
// only: the strip is peripheral and should never move under the reader.
const metricMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: fade,
} as const

function Count({ value }: { value: number }) {
  // The animated digits are decorative; assistive tech reads the plain number.
  return <b className="gc-status-count">
    <NumberFlow value={value} transformTiming={countTiming} spinTiming={countTiming} aria-hidden="true" />
    <span className="sr-only">{value}</span>
  </b>
}

export function StatusBar({ sessionShortId, cwd, projectLabel, sessionRunning, streaming, onOpenProject, turnCount, toolCallCount, errorCount, generationSpeed, keepAwakeControl }: Props) {
  const state = streaming ? 'Working' : sessionRunning ? 'Connected' : 'Idle'
  const hasMetrics = turnCount > 0 || toolCallCount > 0 || errorCount > 0
  return (
    <footer className="gc-statusbar">
      <Tooltip
        side="top"
        align="start"
        shortcut="⌘O"
        content={<span className="gc-status-tip"><span>Open project folder</span>{cwd && <span className="gc-status-path">{cwd}</span>}</span>}
      >
        <button type="button" className="gc-status-project" onClick={onOpenProject} aria-label="Open project folder (⌘O)"><Folder size={13} strokeWidth={1.75} aria-hidden="true" /><span>{projectLabel || workspaceLabel(cwd)}</span></button>
      </Tooltip>
      <span className={`gc-runtime-status${streaming ? ' is-busy' : ''}`} title={`Session ${sessionShortId} · ${sessionRunning ? 'CLI connected' : 'CLI not connected'}`}><i className={streaming ? 'busy' : sessionRunning ? 'connected' : ''} />{state}</span>
      <AnimatePresence initial={false}>
        {generationSpeed && <motion.span key="speed" className={`gc-status-item gc-status-speed${generationSpeed.live ? ' is-live' : ''}`}
          title={generationSpeed.live ? 'Local model generation speed, measured while it writes' : 'Local model generation speed of its last reply'} {...metricMotion}>
          {formatGenerationSpeed(generationSpeed.tokensPerSecond)}
        </motion.span>}
      </AnimatePresence>
      <span className="gc-statusbar-spacer" />
      <AnimatePresence initial={false}>
        {turnCount > 0 && <motion.span key="turns" className="gc-status-item gc-status-metric" {...metricMotion}><Count value={turnCount} /> {turnCount === 1 ? 'turn' : 'turns'}</motion.span>}
        {toolCallCount > 0 && <motion.span key="tools" className="gc-status-item gc-status-metric" {...metricMotion}><Count value={toolCallCount} /> {toolCallCount === 1 ? 'tool call' : 'tool calls'}</motion.span>}
        {errorCount > 0 && <motion.span key="errors" className="gc-status-item gc-status-metric gc-status-error" role="status" {...metricMotion}><Count value={errorCount} /> {errorCount === 1 ? 'error' : 'errors'}</motion.span>}
        {hasMetrics && <motion.span key="divider" className="gc-status-divider" aria-hidden="true" {...metricMotion} />}
      </AnimatePresence>
      {keepAwakeControl}
    </footer>
  )
}
