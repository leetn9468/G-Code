/**
 * @file TodoWriteTool.ts
 * @brief Structured task tracking, one list per session, persisted to .gcode/todos/<sessionId>.json
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { generatedFolder } from '../../session/outputs.js'

const todoItemSchema = z.object({
  content: z.string().min(1).describe('What needs to be done'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('Task status'),
  activeForm: z.string().min(1).describe('Present continuous form (e.g. "Running tests")'),
})

const inputSchema = z.object({
  todos: z.array(todoItemSchema).describe('The updated todo list'),
})

type TodoInput = z.infer<typeof inputSchema>

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

interface TodoOutput {
  count: number
  pending: number
  inProgress: number
  completed: number
}

/**
 * Each session's list. Sessions in one project (concurrent ones, or one resumed later) keep their
 * own lists: one list per project let them overwrite each other and load another session's list.
 */
const todosBySession = new Map<string, TodoItem[]>()
/** The session shown when none is named: the one the REPL loaded, else the first that wrote a list. */
let activeSession = ''

const validSessionId = (sessionId: string) => /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
const todoPath = (cwd: string, sessionId: string) => join(cwd, '.gcode', 'todos', `${sessionId}.json`)

export function getTodos(sessionId = activeSession): ReadonlyArray<TodoItem> {
  return todosBySession.get(sessionId) ?? []
}

export function formatTodos(sessionId = activeSession): string {
  const todos = getTodos(sessionId)
  if (todos.length === 0) return 'No todos.'
  return todos.map((t, i) => {
    const icon = t.status === 'completed' ? '[x]'
      : t.status === 'in_progress' ? '[>]'
      : '[ ]'
    return `  ${i + 1}. ${icon} ${t.content}`
  }).join('\n')
}

/** Saves the list in the project's .gcode/todos (ignored by git from the start), whole or not at all. */
function persistTodos(cwd: string, sessionId: string, todos: TodoItem[]): void {
  if (!validSessionId(sessionId)) return
  const path = join(generatedFolder(cwd, 'todos'), `${sessionId}.json`)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(todos, null, 2))
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
    throw error
  }
}

/** Loads a session's saved list; a session without one starts with an empty list. */
export function loadTodos(cwd: string, sessionId: string): void {
  activeSession = sessionId
  const path = todoPath(cwd, sessionId)
  if (!validSessionId(sessionId) || !existsSync(path)) { todosBySession.set(sessionId, []); return }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    const valid = Array.isArray(parsed) ? parsed.filter((item): item is TodoItem => todoItemSchema.safeParse(item).success) : []
    todosBySession.set(sessionId, valid)
  } catch {
    todosBySession.set(sessionId, [])
  }
}

export const TodoWriteTool: Tool<TodoInput, TodoOutput> = {
  name: 'TodoWrite',
  description: 'Create and manage a structured task list for tracking progress',
  inputSchema,

  async call(input, context: ToolUseContext): Promise<ToolResult<TodoOutput>> {
    const todos = input.todos.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm,
    }))
    todosBySession.set(context.sessionId, todos)
    if (!activeSession) activeSession = context.sessionId

    try {
      persistTodos(context.cwd, context.sessionId, todos)
    } catch {
      // Best-effort persistence
    }

    const pending = todos.filter((t) => t.status === 'pending').length
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    const completed = todos.filter((t) => t.status === 'completed').length

    return {
      success: true,
      output: {
        count: todos.length,
        pending,
        inProgress,
        completed,
      },
    }
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return { decision: 'allow', reason: 'Task tracking' }
  },

  prompt(): string {
    return 'TodoWrite: Manage a structured task list with pending/in_progress/completed states.'
  },
}
