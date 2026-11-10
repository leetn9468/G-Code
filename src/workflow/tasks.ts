import { boundedJSON, boundedText, type WorkflowEvent } from './events.js'
import type { WorkflowRuntime, WorkflowResult } from './runtime.js'

export interface WorkflowTask {
  runId: string
  sessionId: string
  scriptPath: string
  background: boolean
  runtime?: WorkflowRuntime
  promise: Promise<WorkflowResult>
  result?: WorkflowResult
  resultMessage?: string
  completedAt?: number
  /** The Workflow tool call that runs it: the desktop shows its nodes under that call. */
  toolUseId?: string
}
export interface WorkflowControl { type: 'workflow-control'; runId: string; agentId?: string; action: 'skip' | 'stop' }

/** Process-local tasks. Script persistence is separate; restart/resume is not implied. */
export class WorkflowTasks {
  private closing = false
  private closedSessions = new Set<string>()
  private tasks = new Map<string, WorkflowTask>()
  private events = new Set<(event: WorkflowEvent, task?: WorkflowTask) => void>()
  private completed = new Set<(task: WorkflowTask) => void>()
  constructor(private retention = { maxCompleted: 100, ttlMs: 30 * 60_000, now: Date.now }) {}
  private prune(): void {
    const completed = [...this.tasks.values()].filter(task => task.result).sort((a, b) => a.completedAt! - b.completedAt!)
    let remaining = completed.length
    for (const task of completed) {
      if (remaining > this.retention.maxCompleted || this.retention.now() - task.completedAt! >= this.retention.ttlMs) {
        this.tasks.delete(task.runId)
        remaining--
      } else break
    }
  }
  start(runtime: WorkflowRuntime, sessionId: string, scriptPath: string, background: boolean, script: string, args?: unknown, signal?: AbortSignal, toolUseId?: string): WorkflowTask {
    this.prune()
    if (this.closing || this.closedSessions.has(sessionId)) throw new Error('Workflow session is shutting down')
    if (this.tasks.has(runtime.runId)) throw new Error(`Workflow ${runtime.runId} already exists`)
    const task: WorkflowTask = { runId: runtime.runId, runtime, sessionId, scriptPath, background, promise: undefined!, ...(toolUseId ? { toolUseId } : {}) }
    this.tasks.set(task.runId, task)
    task.promise = runtime.run(script, args, { signal }).then(result => {
      const notification = formatResult(task.runId, task.scriptPath, result)
      task.resultMessage = notification.message
      task.result = { ...result, value: notification.value, error: result.error && boundedText(result.error) }
      task.completedAt = this.retention.now()
      task.runtime = undefined
      task.promise = Promise.resolve(task.result)
      try { for (const listener of this.completed) listener(task) }
      finally { this.prune() }
      return result
    })
    return task
  }
  list(sessionId?: string): WorkflowTask[] { this.prune(); return [...this.tasks.values()].filter(task => !sessionId || task.sessionId === sessionId) }
  control(control: WorkflowControl, sessionId?: string): boolean {
    const task = this.tasks.get(control.runId)
    if (!task || task.result || sessionId && task.sessionId !== sessionId) return false
    if (control.action === 'skip') {
      if (!control.agentId) throw new Error('skip requires agentId')
      return task.runtime!.skip(control.agentId)
    } else task.runtime!.stop()
    return true
  }
  stopBackground(sessionId: string): void { for (const task of this.list(sessionId)) if (task.background && !task.result) task.runtime!.stop() }
  stopAll(sessionId?: string): void { for (const task of this.list(sessionId)) if (!task.result) task.runtime!.stop() }
  async shutdown(sessionId?: string): Promise<void> {
    if (sessionId) this.closedSessions.add(sessionId)
    else this.closing = true
    this.stopAll(sessionId)
    await Promise.allSettled(this.list(sessionId).map(task => task.promise))
  }
  emit(event: WorkflowEvent): void { for (const listener of this.events) listener(event, this.tasks.get(event.runId)) }
  onEvent(listener: (event: WorkflowEvent, task?: WorkflowTask) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onDone(listener: (task: WorkflowTask) => void): () => void { this.completed.add(listener); return () => this.completed.delete(listener) }
}
export const workflowTasks = new WorkflowTasks()

function formatResult(runId: string, scriptPath: string, result?: WorkflowResult): { message: string; value: unknown } {
  const original = result?.value
  const encode = (value: unknown, limit = 2000) => {
    const content = JSON.stringify({ status: result?.status, ...result?.report, result: value, error: result?.error && boundedText(result.error, Math.min(2000, limit)), scriptPath: boundedText(scriptPath, Math.min(1000, limit)) })
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return `<workflow-result runId="${runId}">${content}</workflow-result>`
  }
  const complete = encode(original)
  if (Buffer.byteLength(complete) <= 8000) return { message: complete, value: original }
  let limit = 6000
  for (;;) {
    // Always truncate the original value, never a previous truncation envelope.
    const value = JSON.parse(boundedJSON(original, limit))
    const message = encode(value, limit)
    if (Buffer.byteLength(message) <= 8000 || limit <= 100) return { message, value }
    limit = Math.max(100, Math.floor(limit * 0.75))
  }
}

export function workflowResultMessage(task: WorkflowTask): string {
  return task.resultMessage ?? formatResult(task.runId, task.scriptPath, task.result).message
}
