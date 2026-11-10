/**
 * @file ListDirTool.ts
 * @brief Directory listing with type indicators
 */

import { readdir, stat as statPath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'

const inputSchema = z.object({
  path: z.string().optional().describe('Directory to list (defaults to cwd)'),
})

type ListDirInput = z.infer<typeof inputSchema>

interface ListDirOutput {
  path: string
  entries: string[]
  numEntries: number
}

export const ListDirTool: Tool<ListDirInput, ListDirOutput> = {
  name: 'ListDir',
  description: 'List directory contents with type indicators',
  inputSchema,

  async call(input, context): Promise<ToolResult<ListDirOutput>> {
    const dirPath = resolve(context.cwd, input.path ?? '.')

    try {
      const stat = await statPath(dirPath)
      if (!stat.isDirectory()) {
        return { success: false, error: `Not a directory: ${input.path ?? dirPath}` }
      }

      const entries = await readdir(dirPath, { withFileTypes: true })
      const formatted = entries
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })
        .map((e) => e.isDirectory() ? `${e.name}/` : e.name)

      return {
        success: true,
        output: {
          path: input.path ?? '.',
          entries: formatted,
          numEntries: formatted.length,
        },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT')) {
        return { success: false, error: `Directory not found: ${input.path ?? dirPath}` }
      }
      return { success: false, error: msg }
    }
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    return { decision: 'allow', reason: 'Read-only directory listing' }
  },

  prompt(): string {
    return 'ListDir: List directory contents. Directories marked with trailing /.'
  },
}
