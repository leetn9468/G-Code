/**
 * @file FileWriteTool.ts
 * @brief Write/create files with staleness detection and directory auto-creation
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { getReadFileState, trackFileRead } from './FileReadTool.js'
import { isUNCPath, expandPath } from '../../utils/path.js'
import { writeChunk } from './writeChunks.js'
import { otherNamesNote, safeWriteFile, withWriteLock } from './safeWrite.js'
import { secretRefusal, writeApprovalReason, writeOutsideReason, writeTarget } from '../permissions.js'

const inputSchema = z.object({
  file_path: z.string().describe('File path to write. Relative paths resolve against the current working directory; absolute paths are also accepted.'),
  content: z.string().describe('The content to write'),
  chunk: z.object({ transfer_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), index: z.number().int().min(0).max(255), total: z.number().int().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(value => value.index < value.total).optional().describe('For long files, send ordered chunks of at most 8 KiB, starting at index 0. All chunks share transfer_id and total. Destination changes atomically only after the final complete chunk.'),
})

type FileWriteInput = z.infer<typeof inputSchema>

interface FileWriteOutput {
  type: 'create' | 'update' | 'staged'
  filePath: string
  bytesWritten: number
  receivedChunks?: number
  /** The file's other names (hard links) show the change too. */
  note?: string
}

export const FileWriteTool: Tool<FileWriteInput, FileWriteOutput> = {
  name: 'FileWrite',
  description: 'Create or overwrite files',
  inputSchema,

  async call(input, context): Promise<ToolResult<FileWriteOutput>> {
    // Writes outside the project ask first (checkPermissions); '../' is an ordinary path.
    if (isUNCPath(input.file_path)) {
      return { success: false, error: 'UNC paths blocked — potential credential leak' }
    }
    const target = writeTarget(input.file_path, context.cwd)
    if (target?.secret) return { success: false, error: secretRefusal(target.resolved, 'change') }

    const filePath = expandPath(input.file_path, context.cwd)
    // The folder where the file really lands: through a dangling symlink that is the link target's folder.
    const dir = dirname(target?.resolved ?? filePath)

    try {
      // The project folder itself is gone: recreating it would hide that from the model.
      if (target?.inside && !existsSync(context.cwd)) return { success: false, error: `The project folder ${context.cwd} no longer exists, so "${input.file_path}" was not written.` }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) return { success: false, error: `"${input.file_path}" is a directory, not a file.` }
      // Ensure parent directory exists (outside critical section)
      mkdirSync(dir, { recursive: true })

      // From the staleness check to the rename, sessions writing this file take turns.
      return await withWriteLock(filePath, (): ToolResult<FileWriteOutput> => {
        const isUpdate = existsSync(filePath)

        // Staleness check: if we previously read this file, verify it hasn't changed
        if (isUpdate) {
          const readState = getReadFileState(context).get(filePath)
          if (readState) {
            // Any other time or size: a restored backup (mv, cp -p, tar x) has an older time.
            const current = statSync(filePath)
            if (current.mtimeMs !== readState.mtime || (readState.size !== undefined && current.size !== readState.size)) {
              return {
                success: false,
                error: `File "${input.file_path}" was modified externally since last read (mtime changed). Re-read the file before writing to avoid data loss.`,
              }
            }
          } else {
            // File exists but was never read — warn
            return {
              success: false,
              error: `File "${input.file_path}" exists but has not been read with FileRead yet. Use FileRead on it first (a shell read such as cat does not count), so the overwrite cannot lose changes you have not seen.`,
            }
          }
        }

        if (input.chunk) {
          const result = writeChunk(filePath, input.content, input.chunk, context.cwd, context.sessionId)
          if (result.complete) { const written = statSync(filePath); trackFileRead(filePath, written.mtimeMs, 0, Infinity, context, written.size); context.onArtifacts?.([filePath]) }
          const note = otherNamesNote(result.otherNames ?? 0)
          return { success: true, output: { type: result.complete ? isUpdate ? 'update' : 'create' : 'staged', filePath: input.file_path, bytesWritten: result.bytes, receivedChunks: result.received, ...(note ? { note } : {}) } }
        }
        const { otherNames } = safeWriteFile(filePath, input.content)
        const written = statSync(filePath)
        trackFileRead(filePath, written.mtimeMs, 0, Infinity, context, written.size)
        context.onArtifacts?.([filePath])
        const note = otherNamesNote(otherNames)

        return {
          success: true,
          output: {
            type: isUpdate ? 'update' : 'create',
            filePath: input.file_path,
            bytesWritten: Buffer.byteLength(input.content, 'utf-8'),
            ...(note ? { note } : {}),
          },
        }
      })
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    if (isUNCPath(input.file_path)) return { decision: 'deny', reason: 'UNC paths are blocked: they can leak network credentials.' }
    const target = writeTarget(input.file_path, context.cwd)
    if (!target) return { decision: 'deny', reason: 'Invalid file path (it contains a null byte).' }
    if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
    // The approval names where the file really lands when that is outside the project (a symlink included).
    return { decision: 'ask', reason: target.inside ? writeApprovalReason(input.file_path, context.cwd) ?? 'File write requires user approval' : writeOutsideReason(target) }
  },

  prompt(): string {
    return 'FileWrite: Create or overwrite files. Overwriting an existing file needs a FileRead of it first in this session (a shell read such as cat does not count). For long content, send ordered <=8 KiB chunks with chunk:{transfer_id,index,total}; the destination changes only when all chunks arrive. Never execute incomplete tool JSON.'
  },
}
