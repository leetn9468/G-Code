/**
 * @file TeamMemoryWriteTool.ts
 * @brief Adds a note to the project's team memory (.gcode/team-memory/<topic>.json), signed with
 *        its author and date. It changes a project file, so it asks like a file write (and is
 *        allowed where project edits are: acceptEdits, auto); plan mode refuses it.
 */

import { z } from 'zod'
import type { Tool, ToolResult } from '../tool.js'
import { appendTeamMemoryLocked, TEAM_NOTE_MAX, teamMemoryAuthor, teamMemoryFile } from '../../memory/teamMemory.js'
import { secretRefusal, writeTarget } from '../permissions.js'

export const TEAM_MEMORY_TOOL = 'TeamMemoryWrite'

const inputSchema = z.object({
  topic: z.string().trim().min(1).max(64).describe('The topic, such as "Conventions", "Build" or "Pitfalls"; an existing topic gets the note added'),
  content: z.string().trim().min(1).max(TEAM_NOTE_MAX).describe('The note: one fact, decision or convention, written for teammates'),
}).strict()

export const TeamMemoryWriteTool: Tool<z.infer<typeof inputSchema>, string> = {
  name: TEAM_MEMORY_TOOL,
  description: "Add a note to the project's team memory (.gcode/team-memory), signed with its author and date.",
  inputSchema,

  async call({ topic, content }, context): Promise<ToolResult<string>> {
    try {
      const author = teamMemoryAuthor(context.cwd)
      const file = await appendTeamMemoryLocked(context.cwd, topic, author, content)
      return { success: true, output: `Added to the team memory topic "${topic}" (${file}) as ${author}. New conversations in this project show it with the project memory; later turns of this one see it in their context block.` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async checkPermissions({ topic }, context) {
    const target = writeTarget(teamMemoryFile(context.cwd, topic), context.cwd)
    if (!target) return { decision: 'deny', reason: 'Invalid team-memory topic.' }
    if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
    if (!target.inside) return { decision: 'deny', reason: '.gcode/team-memory leads outside the project (through a symbolic link); G-Code does not write there.' }
    return { decision: 'ask', reason: 'Team memory write requires user approval' }
  },

  prompt(): string {
    return "TeamMemoryWrite: add a lasting note to the project's team memory (.gcode/team-memory/<topic>.json), which everyone working in this project shares and commits. Only for what teammates and later sessions should know: conventions, decisions and their reasons, pitfalls and how to avoid them. Not for task progress, personal preferences or secrets. One fact per note, written to stand alone."
  },
}
