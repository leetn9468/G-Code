/**
 * @file projectMemory.ts
 * @brief Load and watch project memory files (GCODE.md / .gcode/GCODE.md)
 *
 * Project memory provides persistent context across sessions.
 * Files are loaded into the system prompt at session start and
 * refreshed when changes are detected.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { roughTokenCount } from '../engine/context.js'

// ============================================================================
// Memory File Discovery
// ============================================================================

const MEMORY_FILE_NAMES = [
  'GCODE.md',
  '.gcode/GCODE.md',
]

export interface MemoryFile {
  path: string
  content: string
  tokens: number
  mtime: number
}

/**
 * Discover and load all project memory files from a directory.
 */
export function loadProjectMemory(cwd: string): MemoryFile[] {
  const files: MemoryFile[] = []

  for (const name of MEMORY_FILE_NAMES) {
    const fullPath = join(cwd, name)
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath)
        if (!stat.isFile()) continue

        const content = readFileSync(fullPath, 'utf-8')
        if (!content.trim()) continue

        files.push({
          path: fullPath,
          content,
          tokens: roughTokenCount(content),
          mtime: stat.mtimeMs,
        })
      } catch {
        // Skip unreadable files
      }
    }
  }

  return files
}

/**
 * Format memory files for system prompt injection.
 */
export function formatMemoryForPrompt(files: MemoryFile[]): string {
  if (files.length === 0) return ''

  const parts = ['## Project Memory\n']

  for (const file of files) {
    const relPath = file.path.split(/[/\\]/).slice(-2).join('/')
    parts.push(`### ${relPath}\n`)
    parts.push(file.content)
    parts.push('')
  }

  return parts.join('\n')
}
