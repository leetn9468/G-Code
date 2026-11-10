/**
 * @file NotebookEditTool.ts
 * @brief Jupyter notebook (.ipynb) cell CRUD that keeps the file valid nbformat 4
 *
 * Every write follows the nbformat 4 schema: code cells carry `outputs` and `execution_count`,
 * markdown and raw cells never do, a notebook at nbformat 4.5 or later gives every cell a unique
 * `id`, and a source array has no trailing empty line.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Tool, ToolResult, PermissionResult } from '../tool.js'
import { expandPath, isUNCPath } from '../../utils/path.js'
import { notAFile } from './FileReadTool.js'
import { otherNamesNote, safeWriteFile, withWriteLock } from './safeWrite.js'
import { secretRefusal, writeApprovalReason, writeOutsideReason, writeTarget } from '../permissions.js'

const CELL_TYPES = ['code', 'markdown', 'raw'] as const
type CellType = typeof CELL_TYPES[number]

const inputSchema = z.object({
  notebook_path: z.string().describe('Absolute path to the .ipynb file'),
  cell_number: z.number().int().nonnegative().optional().describe(
    '0-indexed cell position. Required for replace and delete unless cell_id is given. For insert, the new cell is placed at this index: it goes before the cell that is there now, and cell_number equal to the cell count appends.',
  ),
  cell_id: z.string().optional().describe(
    'The id of the target cell (nbformat 4.5+), as an alternative to cell_number. For insert, the new cell goes right after this cell.',
  ),
  new_source: z.string().describe('New cell source content (ignored for delete)'),
  cell_type: z.enum(CELL_TYPES).optional().describe(
    'Cell type. For insert it defaults to code. For replace the cell keeps its current type unless this is given.',
  ),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe(
    'replace (default) rewrites one cell, insert adds a cell (at the end when neither cell_number nor cell_id is given), delete removes one cell.',
  ),
})

type NotebookInput = z.infer<typeof inputSchema>

interface NotebookOutput {
  filePath: string
  action: string
  /** Index of the cell that was replaced or inserted, or that was removed. */
  cellIndex: number
  cellId?: string
  cellType?: string
  cellCount: number
  /** The file's other names (hard links) show the change too. */
  note?: string
}

interface NotebookCell {
  id?: string
  cell_type: string
  source: string[] | string
  metadata: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
  attachments?: Record<string, unknown>
  [key: string]: unknown
}

interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

/** nbformat 4.5 made `id` required on every cell; earlier minors do not allow it. */
function usesCellIds(notebook: Notebook): boolean {
  return notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
}

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/

function newCellId(taken: Set<string>): string {
  for (;;) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!taken.has(id)) { taken.add(id); return id }
  }
}

/** Jupyter's own split: every line keeps its newline, and there is no trailing empty element. */
export function sourceLines(source: string): string[] {
  const lines = source.split('\n').map((line, index, all) => index < all.length - 1 ? line + '\n' : line)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Gives the cell the fields its type requires and drops the ones it must not have. */
function shapeCell(cell: NotebookCell, type: CellType, resetCode: boolean): void {
  cell.cell_type = type
  if (!cell.metadata || typeof cell.metadata !== 'object') cell.metadata = {}
  if (type === 'code') {
    // New code means old results no longer describe it.
    if (resetCode || !Array.isArray(cell.outputs)) cell.outputs = []
    if (resetCode || cell.execution_count === undefined) cell.execution_count = null
    delete cell.attachments
  } else {
    delete cell.outputs
    delete cell.execution_count
  }
}

/** A JSON string, or a number literal (anything else in JSON holds no digits). */
const JSON_TOKEN = /"[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/**
 * Number literals JSON.parse would change (integers past 2^53, 1.0, 1e400) become placeholder
 * strings while the notebook is edited, and `restore` writes them back as they were: cells the
 * edit never touched keep their values.
 */
function keepNumbers(text: string): { text: string; restore: (json: string) => string } {
  const tag = `gcode-number-${randomUUID()}-`, literals: string[] = []
  const kept = text.replace(JSON_TOKEN, token => token[0] === '"' || JSON.stringify(Number(token)) === token ? token : `"${tag}${literals.push(token) - 1}"`)
  return { text: kept, restore: json => literals.length ? json.replace(new RegExp(`"${tag}(\\d+)"`, 'g'), (_, index: string) => literals[Number(index)]!) : json }
}

function emptyNotebook(): Notebook {
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export const NotebookEditTool: Tool<NotebookInput, NotebookOutput> = {
  name: 'NotebookEdit',
  description: 'Edit Jupyter notebook cells (replace, insert, or delete)',
  inputSchema,

  async call(input, context): Promise<ToolResult<NotebookOutput>> {
    if (isUNCPath(input.notebook_path)) return { success: false, error: 'UNC paths blocked — potential credential leak' }
    const target = writeTarget(input.notebook_path, context.cwd)
    if (target?.secret) return { success: false, error: secretRefusal(target.resolved, 'change') }
    const mode = input.edit_mode ?? 'replace'

    try {
      const filePath = expandPath(input.notebook_path, context.cwd)
      // From reading the notebook to the rename, sessions writing this file take turns.
      return await withWriteLock(filePath, (): ToolResult<NotebookOutput> => {
        let notebook: Notebook
        let restore = (json: string) => json

        if (existsSync(filePath)) {
          const refused = notAFile(statSync(filePath), input.notebook_path)
          if (refused) return { success: false, error: refused }
          const source = keepNumbers(readFileSync(filePath, 'utf-8'))
          restore = source.restore
          notebook = JSON.parse(source.text) as Notebook
          if (!notebook || typeof notebook !== 'object' || !Array.isArray(notebook.cells)) {
            return { success: false, error: `Not a Jupyter notebook (no cells array): ${input.notebook_path}` }
          }
          if (typeof notebook.nbformat !== 'number') notebook.nbformat = 4
          if (typeof notebook.nbformat_minor !== 'number') notebook.nbformat_minor = 5
          if (!notebook.metadata || typeof notebook.metadata !== 'object') notebook.metadata = {}
        } else if (mode === 'insert') {
          notebook = emptyNotebook()
        } else {
          return { success: false, error: `Notebook not found: ${input.notebook_path}` }
        }

        const withIds = usesCellIds(notebook)
        const taken = new Set<string>()
        if (withIds) {
          // A 4.5 notebook needs an id on every cell; fill any that are missing or duplicated.
          for (const cell of notebook.cells) {
            if (typeof cell.id === 'string' && VALID_ID.test(cell.id) && !taken.has(cell.id)) taken.add(cell.id)
            else cell.id = undefined
          }
          for (const cell of notebook.cells) if (cell.id === undefined) cell.id = newCellId(taken)
        }

        // The target cell: cell_id wins over cell_number.
        let target: number | undefined
        if (input.cell_id !== undefined) {
          target = notebook.cells.findIndex(cell => cell.id === input.cell_id)
          if (target < 0) {
            return { success: false, error: `No cell with id "${input.cell_id}"${withIds ? '' : ' (this notebook is older than nbformat 4.5 and has no cell ids; use cell_number)'}` }
          }
        } else if (input.cell_number !== undefined) {
          target = input.cell_number
        }

        const count = notebook.cells.length
        let cellIndex: number
        let cell: NotebookCell | undefined

        switch (mode) {
          case 'replace': {
            if (target === undefined) return { success: false, error: 'cell_number (or cell_id) is required for replace' }
            if (target >= count) return { success: false, error: `Cell ${target} does not exist (notebook has ${count} cells, numbered from 0)` }
            cellIndex = target
            cell = notebook.cells[target]!
            const current = (CELL_TYPES as readonly string[]).includes(cell.cell_type) ? cell.cell_type as CellType : 'code'
            cell.source = sourceLines(input.new_source)
            shapeCell(cell, input.cell_type ?? current, true)
            break
          }

          case 'insert': {
            // After the cell with cell_id; at index cell_number; otherwise at the end.
            cellIndex = input.cell_id !== undefined ? target! + 1 : Math.min(target ?? count, count)
            cell = { cell_type: input.cell_type ?? 'code', metadata: {}, source: sourceLines(input.new_source) }
            if (withIds) cell = { id: newCellId(taken), ...cell }
            shapeCell(cell, input.cell_type ?? 'code', true)
            notebook.cells.splice(cellIndex, 0, cell)
            break
          }

          case 'delete': {
            if (target === undefined) return { success: false, error: 'cell_number (or cell_id) is required for delete' }
            if (target >= count) return { success: false, error: `Cell ${target} does not exist (notebook has ${count} cells, numbered from 0)` }
            cellIndex = target
            cell = notebook.cells.splice(target, 1)[0]
            break
          }
        }

        const { otherNames } = safeWriteFile(filePath, restore(JSON.stringify(notebook, null, 1)) + '\n')
        const note = otherNamesNote(otherNames)

        return {
          success: true,
          output: {
            filePath: input.notebook_path,
            action: mode,
            cellIndex,
            ...(cell?.id ? { cellId: cell.id } : {}),
            ...(cell ? { cellType: cell.cell_type } : {}),
            cellCount: notebook.cells.length,
            ...(note ? { note } : {}),
          },
        }
      })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    if (isUNCPath(input.notebook_path)) return { decision: 'deny', reason: 'UNC paths are blocked: they can leak network credentials.' }
    const target = writeTarget(input.notebook_path, context.cwd)
    if (!target) return { decision: 'deny', reason: 'Invalid file path (it contains a null byte).' }
    if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
    try { const refused = notAFile(statSync(expandPath(input.notebook_path, context.cwd)), input.notebook_path); if (refused) return { decision: 'deny', reason: refused } } catch { /* Missing: call() says so. */ }
    // The approval names where the notebook really lands when that is outside the project (a symlink included), as FileWrite does.
    return { decision: 'ask', reason: target.inside ? writeApprovalReason(input.notebook_path, context.cwd) ?? 'Notebook edit requires approval' : writeOutsideReason(target) }
  },

  prompt(): string {
    return 'NotebookEdit: Edit Jupyter notebook cells. edit_mode replace (default) and delete need cell_number (0-indexed) or cell_id. ' +
      'insert puts the new cell at index cell_number (before the cell there now), right after cell_id, or at the end when neither is given. ' +
      'Replacing a cell keeps its type unless cell_type is given, and clears a code cell\'s outputs and execution count. The result reports cellIndex.'
  },
}
