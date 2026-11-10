import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, ChevronRight, Globe, ListChecks, PanelRightClose, Square, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { detectDevServers, seenDevServers, terminalText } from '@/lib/devServers'
import { TOOL_LABELS, terminalTool, type ToolPhase } from '../../../../src/shared/runtimeEvents'
import type { BackgroundShellInfo, ShellStatus } from '../../../../src/shared/tasks'
import type { ToolExecution } from '../chat/types'
import type { WorkflowNodeView, WorkflowRunView } from '../chat/useChatSession'
import '@/styles/tasks.css'

const ICON_STROKE = 1.75
// Layout effects are client-only; render tests and previews use the plain effect.
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** The light's colour: the status tokens, as in the sidebar (running breathes). */
type Light = 'running' | 'attention' | 'completed' | 'failed' | 'stopped'
const SHELL_LABELS: Record<ShellStatus, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' }
function toolLight(state: ToolPhase): Light {
  if (state === 'complete') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'denied' || state === 'refused' || state === 'cancelled') return 'stopped'
  return state === 'awaiting_approval' ? 'attention' : 'running'
}

/** 42s · 3m 05s · 1h 02m */
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
function clock(time: number) {
  const date = new Date(time)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function bytes(count: number) {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${(count / 1024 / 1024).toFixed(1)} MB`
}
const firstLine = (text: string) => text.trim().split('\n')[0]?.trim() ?? ''
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string' && value.trimStart().startsWith('{')) { try { return record(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : ''

const NODE_STATUS: Record<string, string> = { running: 'Running', complete: 'Completed', failed: 'Failed', skipped: 'Skipped', stopped: 'Stopped' }
function nodeLight(node: WorkflowNodeView): Light {
  if (node.awaitingApproval) return 'attention'
  return node.status === 'complete' ? 'completed' : node.status === 'failed' ? 'failed' : node.status === 'running' ? 'running' : 'stopped'
}
/** The run's phases and agents (its tools are summed per agent): what the workflow is doing, node by node. */
export function workflowNodeRows(run: WorkflowRunView | undefined, ended = false): Array<{ node: WorkflowNodeView; depth: number; tools: number }> {
  if (!run) return []
  // Stop ends the CLI, so no last frame comes for what was running: once the call is over, so are they.
  const nodes = ended ? run.nodes.map(node => node.status === 'running' ? { ...node, status: 'stopped', awaitingApproval: false } : node) : run.nodes
  const calls = (id: string) => nodes.filter(node => node.kind === 'tool' && node.parentId === id)
  // An agent one of whose calls waits for the user needs them too.
  const shown = nodes.filter(node => node.kind === 'phase' || node.kind === 'agent')
    .map(node => node.kind === 'agent' && node.status === 'running' && calls(node.id).some(call => call.awaitingApproval && call.status === 'running') ? { ...node, awaitingApproval: true } : node)
  const tools = (id: string) => calls(id).length
  // Agents name the run as their parent; those that start after a phase began are listed under it.
  let phase = false
  return shown.map(node => { if (node.kind === 'phase') phase = true; return { node, depth: node.kind === 'agent' && phase ? 1 : 0, tools: tools(node.id) } })
}

function agentLabel(tool: ToolExecution) {
  const input = record(tool.input)
  return firstLine(text(input.description) || text(input.prompt)) || firstLine(tool.inputPreview ?? '') || 'Sub-agent'
}
function workflowLabel(tool: ToolExecution) {
  const input = record(tool.input)
  const script = text(input.script)
  const meta = script.match(/\bmeta\s*=\s*\{[^}]*?\bname\s*:\s*(['"`])((?:(?!\1)[^\n])+)\1/)
  return text(input.scriptPath) || text(input.name) || meta?.[2] || text(record(tool.output).scriptPath) || (script ? 'Inline workflow script' : 'Workflow')
}

/** Running work first (newest first), then finished work (latest to finish first). */
function ordered<T>(items: readonly T[], running: (item: T) => boolean, started: (item: T) => number, ended: (item: T) => number) {
  return [...items].sort((a, b) => Number(running(b)) - Number(running(a)) || (running(a) ? started(b) - started(a) : ended(b) - ended(a)))
}

/** Re-renders every second while `active`, for elapsed times. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/** The side panel's Tasks view: background commands, sub-agents and workflows (mounted while hidden). */
export function TasksPanel({ open, onClose, tasks, tools, workflowRuns = {}, onStop, onOpenUrl }: { open: boolean; onClose: (slide?: boolean) => void; tasks: BackgroundShellInfo[]; tools: ToolExecution[]; workflowRuns?: Readonly<Record<string, WorkflowRunView>>; onStop: (id: string) => void; onOpenUrl?: (url: string) => void }) {
  const shells = useMemo(() => ordered(tasks, task => task.status === 'running', task => task.startedAt, task => task.endedAt ?? task.startedAt), [tasks])
  const agents = useMemo(() => ordered(tools.filter(tool => tool.name === 'Agent'), tool => !terminalTool(tool.state), tool => tool.startedAt, tool => tool.completedAt ?? tool.updatedAt ?? tool.startedAt), [tools])
  const workflows = useMemo(() => ordered(tools.filter(tool => tool.name === 'Workflow'), tool => !terminalTool(tool.state), tool => tool.startedAt, tool => tool.completedAt ?? tool.updatedAt ?? tool.startedAt), [tools])
  // One address per running command: the newest it printed.
  const servers = useMemo(() => {
    const byTask = new Map<string, string>()
    for (const server of detectDevServers(tasks, seenDevServers)) if (!byTask.has(server.taskId)) byTask.set(server.taskId, server.url)
    return byTask
  }, [tasks])
  const runningShells = shells.filter(task => task.status === 'running').length
  const runningAgents = agents.filter(tool => !terminalTool(tool.state)).length
  const runningWorkflows = workflows.filter(tool => !terminalTool(tool.state)).length
  const running = runningShells + runningAgents + runningWorkflows
  const now = useNow(open && running > 0)
  const empty = !shells.length && !agents.length && !workflows.length

  return <section className="gc-side-view gc-tasks" hidden={!open} tabIndex={-1} aria-labelledby="tasks-title">
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="tasks-title" className="gc-side-title"><ListChecks size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Tasks</span>{running > 0 && <span className="gc-outputs-count">{running} running</span>}</h2>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" aria-label="Close tasks" onClick={(event) => onClose(event.detail > 0)}><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    {empty ? <div className="gc-outputs-empty"><span className="gc-modal-icon gc-outputs-empty-icon" aria-hidden="true"><ListChecks size={18} strokeWidth={ICON_STROKE}/></span><strong>No background work yet.</strong><small>Background commands (Bash run_in_background), sub-agents and workflows appear here while they run, and stay listed after they finish.</small></div>
      : <div className="gc-tasks-body">
        <TaskSection id="tasks-shells" title="Background commands" Icon={SquareTerminal} count={shells.length} running={runningShells} none="No background commands. Bash commands started with run_in_background appear here.">
          {shells.map(task => <ShellRow key={task.id} task={task} now={now} url={servers.get(task.id)} onStop={onStop} onOpenUrl={onOpenUrl}/>)}
        </TaskSection>
        <TaskSection id="tasks-agents" title="Sub-agents" Icon={Bot} count={agents.length} running={runningAgents} none="No sub-agents in this session.">
          {agents.map(tool => <ToolRow key={tool.id} tool={tool} now={now} label={agentLabel(tool)}/>)}
        </TaskSection>
        <TaskSection id="tasks-workflows" title="Workflows" Icon={Workflow} count={workflows.length} running={runningWorkflows} none="No workflows in this session.">
          {workflows.map(tool => <ToolRow key={tool.id} tool={tool} now={now} label={workflowLabel(tool)} workflow run={workflowRuns[tool.id] ?? Object.values(workflowRuns).find(run => run.runId === text(record(tool.output).runId))}/>)}
        </TaskSection>
      </div>}
  </section>
}

function TaskSection({ id, title, Icon, count, running, none, children }: { id: string; title: string; Icon: LucideIcon; count: number; running: number; none: string; children: ReactNode }) {
  return <section className="gc-tasks-section" aria-labelledby={id}>
    <h3 id={id}><Icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>{title}</span><span className="gc-outputs-count" aria-label={`${count} total${running ? `, ${running} running` : ''}`}>{count}</span></h3>
    {count ? <ul>{children}</ul> : <p className="gc-tasks-none">{none}</p>}
  </section>
}

function ShellRow({ task, now, url, onStop, onOpenUrl }: { task: BackgroundShellInfo; now: number; url?: string; onStop: (id: string) => void; onOpenUrl?: (url: string) => void }) {
  // A failed command opens on its output.
  const [expanded, setExpanded] = useState(task.status === 'failed')
  const [stopping, setStopping] = useState(false)
  const runningNow = task.status === 'running'
  useEffect(() => { if (!runningNow) setStopping(false) }, [runningNow])
  const title = task.description?.trim() || task.command
  const outputId = `gc-task-output-${task.id}`
  const meta = [
    SHELL_LABELS[task.status] ?? task.status,
    runningNow ? duration(now - task.startedAt) : task.endedAt ? `ended ${clock(task.endedAt)} (${duration(task.endedAt - task.startedAt)})` : '',
    // The number is the command's process group (its bash wrapper), as the agent's own text calls it.
    runningNow ? (task.pid ? `group ${task.pid}` : '') : task.exitCode !== null && task.exitCode !== undefined ? `exit ${task.exitCode}` : '',
  ].filter(Boolean)
  return <li className="gc-task" data-status={task.status}>
    <span className="gc-task-light" data-status={task.status} aria-hidden="true"/>
    <div className="gc-task-text">
      <strong title={title}>{title}</strong>
      {task.description?.trim() && <code title={task.command}>{task.command}</code>}
      <small>{meta.join(' · ')}</small>
    </div>
    <div className="gc-task-actions">
      <button type="button" className="gc-task-toggle" aria-expanded={expanded} aria-controls={outputId} onClick={() => setExpanded(value => !value)}>
        <ChevronRight size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>Output{task.outputBytes > 0 && <span>{bytes(task.outputBytes)}</span>}
      </button>
      {runningNow && url && onOpenUrl && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" title={url} onClick={() => onOpenUrl(url)}><Globe size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>Open in Browser</button>}
      {runningNow && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={stopping} aria-label={`Stop ${title}`} onClick={() => { setStopping(true); onStop(task.id) }}><Square size={12} strokeWidth={2} aria-hidden="true"/>{stopping ? 'Stopping…' : 'Stop'}</button>}
    </div>
    {expanded && <OutputTail id={outputId} tail={task.tail} total={task.outputBytes}/>}
  </li>
}

/** The output tail in a well that follows new output unless scrolled up. */
function OutputTail({ id, tail, total }: { id: string; tail: string; total: number }) {
  const well = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  const output = useMemo(() => terminalText(tail).replace(/\s+$/, ''), [tail])
  useClientLayoutEffect(() => {
    const element = well.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [output])
  const shown = new TextEncoder().encode(tail).length
  return <div className="gc-task-well" id={id}>
    {total > shown && <small>Last {bytes(shown)} of {bytes(total)}</small>}
    <pre ref={well} tabIndex={0} aria-label="Command output" onScroll={(event) => {
      const element = event.currentTarget
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
    }}>{output || 'No output yet.'}</pre>
  </div>
}

function ToolRow({ tool, now, label, workflow, run }: { tool: ToolExecution; now: number; label: string; workflow?: boolean; run?: WorkflowRunView }) {
  const live = !terminalTool(tool.state)
  const end = tool.completedAt ?? tool.updatedAt ?? now
  const output = record(tool.output)
  // A background workflow's call returns at once; the run goes on without this card.
  const detached = workflow && tool.state === 'complete' && record(tool.input).background === true && output.status === 'running'
  const state = detached ? 'Started in background' : TOOL_LABELS[tool.state] ?? tool.state
  const error = tool.error ? firstLine(tool.error) : ''
  return <li className="gc-task" data-status={toolLight(tool.state)}>
    <span className="gc-task-light" data-status={toolLight(tool.state)} aria-hidden="true"/>
    <div className="gc-task-text">
      <strong title={label}>{label}</strong>
      <small>{[state, duration((live ? now : end) - (tool.runningAt ?? tool.startedAt)), !live ? `ended ${clock(end)}` : ''].filter(Boolean).join(' · ')}</small>
      {error && <span className="gc-task-error" title={tool.error}>{error}</span>}
    </div>
    {workflow && <WorkflowNodes run={run} ended={!live && !detached}/>}
  </li>
}

/** A workflow's phases and agents under its row, each with its own light and state. */
function WorkflowNodes({ run, ended }: { run?: WorkflowRunView; ended?: boolean }) {
  const rows = workflowNodeRows(run, ended)
  if (!rows.length) return null
  return <ol className="gc-task-nodes" aria-label="Workflow steps">
    {rows.map(({ node, depth, tools }) => <li key={node.id} data-kind={node.kind} data-depth={depth}>
      <span className="gc-task-light" data-status={nodeLight(node)} aria-hidden="true"/>
      <div>
        <strong title={node.label}>{node.label}</strong>
        <small>{[node.awaitingApproval ? 'Needs your approval' : NODE_STATUS[node.status] ?? node.status, tools ? `${tools} tool call${tools === 1 ? '' : 's'}` : '', node.tokens ? `${node.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(' · ')}</small>
        {node.detail && node.status !== 'complete' && <span className={node.status === 'failed' ? 'gc-task-error' : 'gc-task-node-detail'} title={node.detail}>{firstLine(node.detail)}</span>}
      </div>
    </li>)}
  </ol>
}
