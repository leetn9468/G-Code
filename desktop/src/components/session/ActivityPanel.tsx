import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Activity, ChevronRight, CircleCheck, CircleMinus, CircleX, ShieldAlert } from 'lucide-react'
import { collapse, fade, springCollapse } from '@/lib/motion'
import type { ToolExecution, ToolApprovalRequest, ToolState } from '../chat/types'
import { PERMISSION_LABELS, type SessionPermission } from '../../../../src/shared/sessionControls'
import { terminalTool, TOOL_LABELS, type ModelRuntimeStatus, type InferenceMetrics } from '../../../../src/shared/runtimeEvents'

// Opens with the shared height spring; closes with a faster, critically damped
// one. The shared `collapse.exit` adds `stiffness` to a visualDuration spring,
// so Motion uses its default damping (ratio ~0.22) and the height bounces through zero.
const reveal: Variants = {
  ...collapse,
  exit: { height: 0, opacity: 0, transition: { height: { ...springCollapse, visualDuration: 0.2 }, opacity: { duration: 0.1 } } },
}
// Reduced motion: a short opacity fade instead of the height spring.
const revealReduced: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade },
  exit: { opacity: 0, transition: { duration: 0.1 } },
}
const STROKE = 1.75

/** Tool status: spinner while in flight, amber shield while waiting, check / x once settled. */
function ToolStatusIcon({ state }: { state: ToolState }) {
  if (!terminalTool(state)) return state === 'awaiting_approval' ? <ShieldAlert size={14} strokeWidth={STROKE}/> : <i className="gc-spinner" aria-hidden="true"/>
  if (state === 'complete') return <CircleCheck size={14} strokeWidth={STROKE}/>
  if (state === 'cancelled' || state === 'refused') return <CircleMinus size={14} strokeWidth={STROKE}/>
  return <CircleX size={14} strokeWidth={STROKE}/>
}

function RuntimeIcon({ phase }: { phase: ModelRuntimeStatus['phase'] }) {
  if (phase === 'ready') return <CircleCheck size={14} strokeWidth={STROKE}/>
  if (phase === 'failed') return <CircleX size={14} strokeWidth={STROKE}/>
  if (phase === 'cancelled' || phase === 'stopped') return <CircleMinus size={14} strokeWidth={STROKE}/>
  return <i className="gc-spinner" aria-hidden="true"/>
}

export function ActivityPanel({ tools, streaming, activity, cwd, approval, permission, errorCount, sessionRunning, environment, modelRuntime, metrics }: { tools: ToolExecution[]; streaming: boolean; activity: string; cwd?: string; approval: ToolApprovalRequest | null; permission: SessionPermission; errorCount: number; sessionRunning: boolean; environment: string; modelRuntime: ModelRuntimeStatus | null; metrics: InferenceMetrics | null }) {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  // One short word like the other states so it never truncates at the default
  // width; the expanded panel spells out which tool needs approval.
  const status = approval ? 'Needs approval' : streaming ? 'Working' : errorCount ? 'Review errors' : sessionRunning ? 'Idle' : 'Not connected'
  // Same precedence as `status`; drives the dot colour only.
  const tone = approval ? 'approval' : streaming ? 'working' : errorCount ? 'error' : sessionRunning ? 'idle' : 'offline'
  const errors = errorCount + tools.filter(t => t.state === 'failed').length
  return <section className="gc-activity-section" data-tone={tone}>
    <button type="button" className="gc-activity-toggle" aria-expanded={open} aria-controls="session-activity-panel" onClick={() => setOpen(!open)}>
      <Activity size={16} strokeWidth={STROKE}/>
      <span>Activity</span>
      <small className={streaming ? 'is-active' : ''}><i className="gc-activity-dot" aria-hidden="true"/><span>{status}</span></small>
      <ChevronRight size={14} strokeWidth={2} className="gc-activity-chevron"/>
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.div key="activity" className="gc-activity-collapse" variants={reduceMotion ? revealReduced : reveal} initial="initial" animate="animate" exit="exit">
        <div id="session-activity-panel" className="gc-activity-panel">
          <p className={`gc-activity-status${approval ? ' is-approval' : ''}`} role="status"><span className={streaming && !approval ? 'gc-shimmer-text' : undefined}>{approval ? `${approval.toolName} needs approval` : activity || status}</span></p>
          {modelRuntime && <div className="gc-model-runtime-status" data-phase={modelRuntime.phase}>
            <div className="gc-model-runtime-head"><RuntimeIcon phase={modelRuntime.phase}/><strong>Local model · {modelRuntime.phase.replaceAll('_', ' ')}</strong></div>
            <p>{modelRuntime.message}</p>
            {modelRuntime.elapsedMs != null && <small>{Math.round(modelRuntime.elapsedMs / 1000)}s elapsed{modelRuntime.deadlineMs ? ` · ${Math.round(modelRuntime.deadlineMs / 1000)}s limit` : ''}</small>}
          </div>}
          {streaming && metrics?.processing && <p className="gc-activity-note gc-activity-metrics"><span>Model input {metrics.promptTokens?.toLocaleString() ?? '—'} · Generated {metrics.generatedTokens?.toLocaleString() ?? '—'} tokens</span><br/><span>Live server counters · not completion</span></p>}
          <dl>
            <div><dt>Project</dt><dd title={cwd}>{cwd?.split('/').pop() || 'No folder'}</dd></div>
            <div><dt>Execution</dt><dd>{environment === 'local' ? 'Local' : 'Cloud · not configured'}</dd></div>
            <div><dt>Permissions</dt><dd>{PERMISSION_LABELS[permission]}</dd></div>
            <div><dt>Tool calls</dt><dd>{tools.length}</dd></div>
            <div><dt>Errors</dt><dd className={errors ? 'has-errors' : undefined}>{errors}</dd></div>
          </dl>
          <p className="gc-activity-note">Execution status only. Completed tools do not imply a passing build.</p>
          {!tools.length ? <p className="gc-activity-note gc-activity-empty">Tool calls will appear here.</p> : <ol>{[...tools].reverse().map(tool => <li key={tool.id} data-state={tool.state}><details>
            <summary><span className="gc-activity-tool-icon" aria-hidden="true"><ToolStatusIcon state={tool.state}/></span><strong>{tool.name}</strong><span>{TOOL_LABELS[tool.state]}</span></summary>
            {tool.detail && !terminalTool(tool.state) && <p>{tool.detail}</p>}
            <pre>{tool.input == null ? tool.inputPreview : JSON.stringify(tool.input, null, 2)}</pre>
            {tool.inputChars && tool.state === 'preparing' ? <small>{tool.inputChars.toLocaleString()} characters received</small> : null}
            {(tool.error || tool.output != null) && <pre>{tool.error || (typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2))}</pre>}
          </details></li>)}</ol>}
        </div>
      </motion.div>}
    </AnimatePresence>
  </section>
}
