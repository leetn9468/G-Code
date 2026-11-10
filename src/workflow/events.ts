import { headUnits } from '../utils/textUnits.js'
import { maskSecrets } from '../security/secretValues.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { relativeToProject } from '../utils/path.js'
export function truncateCodePoints(value: string, limit: number): string {
  let result = '', count = 0
  for (const ch of value) {
    if (count++ === limit) break
    result += ch
  }
  return result
}
export type WorkflowStatus = 'running' | 'complete' | 'failed' | 'skipped' | 'stopped'
export interface WorkflowNode {
  id: string
  parentId: string | null
  kind: 'run' | 'agent' | 'phase' | 'tool'
  label: string
  status: WorkflowStatus
  detail?: string
  tokens?: number
  /** A tool node whose call is waiting for the user's approval (its status stays 'running'). */
  awaitingApproval?: true
}

/**
 * Who asked for an approval when it was not the main conversation: a workflow agent, or an Agent
 * tool sub-agent. `label` is display text (escaped and bounded); approval frames carry it as `origin`.
 */
export interface ApprovalOrigin { kind: 'workflow' | 'agent'; label: string; runId?: string; agentId?: string }
declare module '../tools/tool.js' {
  interface ApprovalRequestOptions { origin?: ApprovalOrigin }
}
export type WorkflowEvent =
  | { type: 'workflow-state'; runId: string; node: WorkflowNode }
  | { type: 'workflow-done'; runId: string; status: WorkflowStatus; summary: string }
export function boundedJSON(value: unknown, limit = 8000): string {
  const whole = JSON.stringify(value ?? null)
  if (Buffer.byteLength(whole) <= limit) return whole
  // Masked before the cut: a key across it would no longer read as a key.
  const json = maskSecrets(whole)
  const encode = (length: number) => JSON.stringify({ truncated: true, originalChars: json.length, preview: headUnits(json, length) })
  let low = 0, high = Math.min(json.length, limit)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(encode(middle)) <= limit) low = middle
    else high = middle - 1
  }
  return encode(low)
}

export function boundedText(whole: string, limit = 2000): string {
  if (Buffer.byteLength(whole) <= limit) return whole
  // Masked before the cut: a key across it would no longer read as a key.
  const value = maskSecrets(whole)
  let low = 0, high = Math.min(value.length, limit)
  const suffix = '… [truncated]'
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle) + suffix) <= limit) low = middle
    else high = middle - 1
  }
  return headUnits(value, low) + suffix
}

/** One failed agent, as a script's agentFailures() returns it. */
export interface AgentFailure { label: string; reason: string }
/** How one agent ended. */
export interface AgentEnd { label: string; status: WorkflowStatus; reason?: string; text?: string }
/**
 * What the run's own record adds to the script's return value. A script may lose an agent's failure
 * (null, or a throw parallel turned into null), and all it knew dies with its worker when the run
 * fails, so this is what tells the model why, and what had already been done.
 */
export interface WorkflowReport {
  agentFailures?: { note: string; failed: number; reasons: Array<{ reason: string; count: number; labels: string[] }>; moreReasons?: number }
  agents?: { ended: Array<{ label: string; status: WorkflowStatus; reason?: string; text?: string }>; more?: number; note: string }
  filesChanged?: { paths: string[]; more?: number; note: string }
  contextLost?: { labels: string[]; note: string }
}
const reportText = (text: string, limit: number) => { const clean = escapeDisplayControls(maskSecrets(text)); return clean.length > limit ? `${headUnits(clean, limit - 1)}…` : clean }
/** All of a report, in bytes; a result under the 8000-byte envelope still has room for the script's value. */
const REPORT_BYTES = 3500

export function workflowReport(run: { status: WorkflowStatus; failures: readonly AgentFailure[]; ends: readonly AgentEnd[]; agents: number; changed: ReadonlyMap<string, boolean>; contextLost: ReadonlySet<string>; cwd: string }): WorkflowReport {
  const report: WorkflowReport = {}
  const complete = run.status === 'complete'
  if (run.failures.length) {
    const reasons = new Map<string, { reason: string; count: number; labels: string[] }>()
    for (const { label, reason } of run.failures) {
      const entry = reasons.get(reason) ?? { reason: reportText(reason, 300), count: 0, labels: [] }
      entry.count++
      if (entry.labels.length < 5) entry.labels.push(reportText(label, 60))
      reasons.set(reason, entry)
    }
    const listed = [...reasons.values()]
    report.agentFailures = {
      note: `${run.failures.length} of ${Math.max(run.agents, run.failures.length)} agents failed. A failed agent returned null to the script, or threw (parallel and pipeline turn that into null), so a value here may be missing what they were asked for.`,
      failed: run.failures.length, reasons: listed.slice(0, 4), ...(listed.length > 4 ? { moreReasons: listed.length - 4 } : {}),
    }
  }
  if (!complete && run.ends.length) {
    // The ones that finished first: the work not to redo.
    const order = [...run.ends].sort((a, b) => Number(b.status === 'complete') - Number(a.status === 'complete'))
    const ended = order.slice(0, 6).map(end => ({ label: reportText(end.label, 60), status: end.status, ...(end.reason ? { reason: reportText(end.reason, 120) } : {}), ...(end.text?.trim() ? { text: reportText(end.text, 160) } : {}) }))
    report.agents = { ended, ...(order.length > 6 ? { more: order.length - 6 } : {}), note: 'How the agents that ended before the run did so. The script\'s own results were lost with it; text is the start of each reply. Do not assume they did nothing.' }
  }
  if ((!complete || run.failures.length) && run.changed.size) {
    const paths = [...run.changed].slice(0, 12).map(([path, deleted]) => `${reportText(relativeToProject(path, run.cwd), 100)}${deleted ? ' (deleted)' : ''}`)
    report.filesChanged = { paths, ...(run.changed.size > 12 ? { more: run.changed.size - 12 } : {}), note: 'Files this run\'s agents changed before it ended; the changes stay.' }
  }
  if (run.contextLost.size) report.contextLost = { labels: [...run.contextLost].slice(0, 5).map(label => reportText(label, 60)), note: 'These agents lost part of their context without a summary, so their replies may rest on less than their whole run.' }
  // Each list is bounded above; a report of long labels in every list still leaves the value its room.
  while (Buffer.byteLength(JSON.stringify(report)) > REPORT_BYTES) {
    if (report.agents?.ended.length) { report.agents.more = (report.agents.more ?? 0) + 1; report.agents.ended.pop() }
    else if (report.filesChanged?.paths.length) { report.filesChanged.more = (report.filesChanged.more ?? 0) + 1; report.filesChanged.paths.pop() }
    else if (report.agentFailures && report.agentFailures.reasons.length > 1) { report.agentFailures.moreReasons = (report.agentFailures.moreReasons ?? 0) + 1; report.agentFailures.reasons.pop() }
    else break
  }
  return report
}

/** Preserve run identity while bounding the final JSON envelope, not an encoded inner string. */
export function workflowOutput(value: Record<string, unknown>, limit = 8000): Record<string, unknown> {
  const { result, ...metadata } = value
  const overhead = Buffer.byteLength(JSON.stringify({ ...metadata, result: null })) - 4
  if (overhead > limit - 100) return JSON.parse(boundedJSON(value, limit))
  return { ...metadata, result: JSON.parse(boundedJSON(result, limit - overhead)) }
}
