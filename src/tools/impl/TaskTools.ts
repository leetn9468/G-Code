/**
 * @file TaskTools.ts
 * @brief Task record management (6 tools)
 *
 * TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TaskOutput
 * Stores task records within a session. Does not launch or control processes.
 */

import { randomUUID } from 'node:crypto'
import { leftGroupNote } from '../../utils/subprocess.js'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { backgroundShells, endedTask, headUnits, shellState, shownTail, stoppedWithProcess, taskSession, type TaskRecord } from '../backgroundShells.js'

/** How long TaskStop waits for a shell to end: SIGKILL follows the SIGTERM after two seconds. */
const STOP_WAIT_MS = 3000

/**
 * What became of a background shell of this session that an earlier G-Code process ran: it
 * ended with that process, if it had not ended before.
 */
function endedShell(record: TaskRecord): string {
  const command = record.command.replace(/\s+/g, ' ').trim()
  return `Background task ${record.id} (${command.length > 200 ? `${headUnits(command, 199)}…` : command}) is not running. An earlier G-Code process of this session ran it, and background tasks end with their process (the session was closed, stopped or restarted since). ${stoppedWithProcess(record) ? 'It was still running then, so it was stopped.' : `It had already ended before that${record.state === 'ended' ? '' : `: ${record.state}`}.`} Start it again if you still need it.`
}

/** Why there is no background shell `id`: background shells do not outlive their G-Code process. */
function missingShell(id: string): string {
  if (backgroundShells.forgot(id)) return `Background task ${id} finished a while ago, and its output is no longer kept (only the most recent finished tasks are).`
  return `G-Code is not running a background task ${id}. Background tasks end with the G-Code process that started them: when the session is closed, stopped or restarted. A task started before that is gone; start it again if you still need it.`
}

// ============================================================================
// Task State
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

export interface Task {
  id: string
  name: string
  description: string
  status: TaskStatus
  output: string
  createdAt: number
  updatedAt: number
}

const tasks = new Map<string, Task>()

export function getAllTasks(): Task[] { return Array.from(tasks.values()) }

// ============================================================================
// TaskCreateTool
// ============================================================================

export const TaskCreateTool: Tool<{ name: string; description: string }, Task> = {
  name: 'TaskCreate',
  description: 'Create a new task record (does not launch work)',
  inputSchema: z.object({
    name: z.string().describe('Task name'),
    description: z.string().describe('What the task does'),
  }),

  async call(input, _context): Promise<ToolResult<Task>> {
    const task: Task = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      description: input.description,
      status: 'pending',
      output: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    tasks.set(task.id, task)
    return { success: true, output: task }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskCreate: Create a new task record (does not launch work).' },
}

// ============================================================================
// TaskGetTool
// ============================================================================

export const TaskGetTool: Tool<{ task_id: string }, Task> = {
  name: 'TaskGet',
  description: 'Get details of a specific task',
  inputSchema: z.object({ task_id: z.string().describe('Task ID') }),

  async call(input): Promise<ToolResult<Task>> {
    const task = tasks.get(input.task_id)
    if (!task) return { success: false, error: `Task ${input.task_id} not found` }
    return { success: true, output: task }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskGet: Get details of a task record.' },
}

// ============================================================================
// TaskListTool
// ============================================================================

type ShellRow = { id: string; command: string; description?: string; state: string }
export const TaskListTool: Tool<Record<string, never>, { tasks: Task[]; backgroundShells: ShellRow[] }> = {
  name: 'TaskList',
  description: 'List all task records and the background shells of this session',
  inputSchema: z.object({}),

  // Shells too: TaskOutput and TaskStop take their ids, so a list without them reads as "nothing running".
  async call(): Promise<ToolResult<{ tasks: Task[]; backgroundShells: ShellRow[] }>> {
    const shells = backgroundShells.list().map(shell => ({ id: shell.id, command: headUnits(shell.command, 200), ...(shell.description ? { description: shell.description } : {}), state: shellState(shell, backgroundShells.details(shell.id)) }))
    return { success: true, output: { tasks: getAllTasks(), backgroundShells: shells } }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskList: List all task records, and the background shells started with Bash run_in_background (their ids work with TaskOutput and TaskStop).' },
}

// ============================================================================
// TaskUpdateTool
// ============================================================================

export const TaskUpdateTool: Tool<{ task_id: string; status?: TaskStatus; output?: string }, Task> = {
  name: 'TaskUpdate',
  description: 'Update a task record status or notes',
  inputSchema: z.object({
    task_id: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'stopped']).optional(),
    output: z.string().optional(),
  }),

  async call(input): Promise<ToolResult<Task>> {
    const task = tasks.get(input.task_id)
    if (!task) return { success: false, error: `Task ${input.task_id} not found` }

    if (input.status) task.status = input.status
    if (input.output !== undefined) task.output = input.output
    task.updatedAt = Date.now()

    return { success: true, output: task }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskUpdate: Update a task record.' },
}

// ============================================================================
// TaskStopTool
// ============================================================================

export const TaskStopTool: Tool<{ task_id: string }, Task | string> = {
  name: 'TaskStop',
  description: 'Stop a background shell task, or mark a task record stopped',
  inputSchema: z.object({ task_id: z.string() }),

  async call(input, context): Promise<ToolResult<Task | string>> {
    const shell = backgroundShells.get(input.task_id)
    if (shell) {
      // The model stopped it, or is told here that it has ended: no notice of its end is due.
      backgroundShells.markSeen(shell.id)
      if (!backgroundShells.stop(shell.id)) return { success: true, output: `Background task ${shell.id} already ${shellState(shell, backgroundShells.details(shell.id))}.` }
      // Wait until it has ended, so the next call (a start, TaskOutput) sees it gone.
      const ended = await backgroundShells.waitForEnd(shell.id, STOP_WAIT_MS, context?.signal)
      const now = backgroundShells.get(shell.id) ?? shell
      // The turn was stopped while it waited: only SIGTERM has gone out so far.
      if (!ended && now.status === 'running' && context?.signal?.aborted) {
        // The error alone: the tool runner joins a failed call's error and output, so both said it twice.
        return { success: false, error: `The turn was stopped before background task ${shell.id} (${shell.command}) ended. It was sent SIGTERM, and gets SIGKILL 2 s later if it is still running.` }
      }
      if (now.status === 'running') return { success: true, output: `Background task ${shell.id} (${shell.command}) is still stopping: it got SIGTERM, then SIGKILL, and has not ended yet.` }
      return { success: true, output: `Stopped background task ${shell.id} (${shell.command})${now.exitCode !== null ? `; exit code ${now.exitCode}` : ''}.${leftGroupNote(backgroundShells.details(shell.id)?.leftGroup)}` }
    }
    const ended = input.task_id.startsWith('bg-') && context ? endedTask(taskSession(context), input.task_id) : undefined
    if (ended) return { success: true, output: endedShell(ended) }
    const task = tasks.get(input.task_id)
    if (!task) return { success: false, error: input.task_id.startsWith('bg-') ? missingShell(input.task_id) : `Task ${input.task_id} not found` }

    task.status = 'stopped'
    task.updatedAt = Date.now()
    return { success: true, output: task }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskStop: Stop a background shell started with Bash run_in_background (terminates its process group and waits, up to 3 seconds, until it has ended), or mark a task record stopped.' },
}

// ============================================================================
// TaskOutputTool
// ============================================================================

/** The longest TaskOutput waits for a shell to end: the longest a Bash command may run. */
const MAX_WAIT_MS = 600_000

export const TaskOutputTool: Tool<{ task_id: string; wait_ms?: number }, string> = {
  name: 'TaskOutput',
  description: 'Get the output of a background shell task or a task record',
  inputSchema: z.object({
    task_id: z.string(),
    wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe('Wait up to this many ms (max 600000) for a running background shell to end before reading; it returns as soon as the shell ends. Default 0: no wait.'),
  }),

  async call(input, context): Promise<ToolResult<string>> {
    let shell = backgroundShells.get(input.task_id)
    if (shell) {
      const wait = input.wait_ms ?? 0
      let waited = ''
      if (wait > 0 && shell.status === 'running') {
        const ended = await backgroundShells.waitForEnd(shell.id, wait, context?.signal)
        shell = backgroundShells.get(shell.id) ?? shell
        waited = ended ? ' (it ended during the wait)' : context?.signal?.aborted ? ' (the wait was cut short: the turn was stopped)' : ` (still running after a ${+(wait / 1000).toFixed(1)} s wait)`
      }
      const output = backgroundShells.output(shell.id) ?? ''
      const state = shellState(shell, backgroundShells.details(shell.id))
      if (shell.status !== 'running') backgroundShells.markSeen(shell.id)
      // Only the end of a long output is kept (32 KB once the shell has finished).
      const { text: shown, omitted } = shownTail(output, 30_000, backgroundShells.trimmed(shell.id), shell.status === 'running')
      const empty = shell.status === 'running' ? '(no output yet)' : '(no output)'
      return { success: true, output: `Background task ${shell.id}: ${state}${waited}\n${omitted ? '… (earlier output omitted)\n' : ''}${shown || (omitted ? '' : empty)}` }
    }
    const ended = input.task_id.startsWith('bg-') && context ? endedTask(taskSession(context), input.task_id) : undefined
    // Still "running" and not stopped with its process: that process died without a word (SIGKILL, a crash).
    const abrupt = ended && ended.status === 'running' && !ended.endedWithProcess
    if (ended) return { success: true, output: `${endedShell(ended)}\nIts last output:\n${ended.tail || (abrupt ? '(none recorded: the G-Code process that ran it ended abruptly)' : '(no output)')}` }
    const task = tasks.get(input.task_id)
    if (!task) return { success: false, error: input.task_id.startsWith('bg-') ? missingShell(input.task_id) : `Task ${input.task_id} not found` }
    return { success: true, output: task.output || (task.status === 'pending' || task.status === 'running' ? '(no output yet)' : '(no output)') }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() { return 'TaskOutput: Read the output and status of a background shell (Bash run_in_background), or the stored output of a task record. With wait_ms it first waits, up to that many ms, for a running shell to end, and returns as soon as it does: use it to follow a long build instead of polling. Background shells end with the G-Code session (closing, stopping or restarting it).' },
}
