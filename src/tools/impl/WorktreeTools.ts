import { guardedExecFileSync as execFileSync } from '../../security/process.js'
/**
 * @file WorktreeTools.ts
 * @brief Git worktree isolation — EnterWorktree / ExitWorktree
 */


import { toolEnv } from '../../runtime/node.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'

let activeWorktree: { path: string; branch: string; originalCwd: string; sessionId: string } | null = null

// EnterWorktree
export const EnterWorktreeTool: Tool<{ name?: string }, { path: string; branch: string }> = {
  name: 'EnterWorktree',
  description: 'Create an isolated git worktree for safe experimentation',
  inputSchema: z.object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional().describe('Name for the worktree (letters, numbers, hyphens, underscores)'),
  }),

  async call(input, context): Promise<ToolResult<{ path: string; branch: string }>> {
    if (!context.setCwd) return { success: false, error: 'Working directory switching is unavailable in this runtime.' }
    if (activeWorktree) {
      return { success: false, error: 'Already in a worktree. Exit first with ExitWorktree.' }
    }

    const name = input.name ?? `gcode-${randomUUID().slice(0, 8)}`
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      return { success: false, error: 'Invalid worktree name.' }
    }
    const worktreeDir = join(context.cwd, '.gcode', 'worktrees')
    const worktreePath = join(worktreeDir, name)
    const branch = `gcode/${name}`

    try {
      mkdirSync(worktreeDir, { recursive: true })
      execFileSync('git', ['worktree', 'add', '-b', branch, '--', worktreePath], {
        cwd: context.cwd, env: toolEnv(),
        encoding: 'utf-8',
        timeout: 30_000,
        windowsHide: true,
      })

      activeWorktree = { path: worktreePath, branch, originalCwd: context.cwd, sessionId: context.sessionId }
      context.setCwd(worktreePath)

      return {
        success: true,
        output: { path: worktreePath, branch },
      }
    } catch (err) {
      return { success: false, error: `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  async checkPermissions() { return { decision: 'ask' as const, reason: 'Creates a git worktree' } },
  prompt() { return 'EnterWorktree: Create an isolated git worktree for safe changes.' },
}

// ExitWorktree
export const ExitWorktreeTool: Tool<{ action: string; discard_changes?: boolean }, { action: string }> = {
  name: 'ExitWorktree',
  description: 'Exit and optionally remove the current git worktree',
  inputSchema: z.object({
    action: z.enum(['keep', 'remove']).describe('"keep" preserves the worktree, "remove" deletes it'),
    discard_changes: z.boolean().optional().describe('Force remove even with uncommitted changes'),
  }),

  async call(input, context): Promise<ToolResult<{ action: string }>> {
    if (!activeWorktree) {
      return { success: false, error: 'Not in a worktree.' }
    }
    if (activeWorktree.sessionId !== context.sessionId || !context.setCwd) {
      return { success: false, error: 'The worktree belongs to another session or cwd switching is unavailable.' }
    }

    const { path, branch, originalCwd } = activeWorktree

    if (input.action === 'remove') {
      try {
        const flags = input.discard_changes ? ['--force'] : []
        execFileSync('git', ['worktree', 'remove', ...flags, '--', path], {
          cwd: originalCwd, env: toolEnv(),
          encoding: 'utf-8',
          timeout: 30_000,
          windowsHide: true,
        })
        // Delete branch
        try {
          execFileSync('git', ['branch', '-d', '--', branch], { cwd: originalCwd, env: toolEnv(), encoding: 'utf-8', timeout: 10_000, windowsHide: true })
        } catch { /* branch may not exist or may have unmerged changes */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!input.discard_changes && msg.includes('contains modified')) {
          return { success: false, error: `Worktree has uncommitted changes. Set discard_changes: true to force remove.` }
        }
        return { success: false, error: `Failed to remove worktree: ${msg}` }
      }
    }

    context.setCwd(originalCwd)
    activeWorktree = null
    return { success: true, output: { action: input.action } }
  },

  async checkPermissions() { return { decision: 'ask' as const, reason: 'Manages git worktree' } },
  prompt() { return 'ExitWorktree: Exit the current worktree. "keep" preserves it, "remove" deletes it.' },
}
