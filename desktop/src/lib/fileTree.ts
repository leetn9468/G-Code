// Pure logic for the side panel's Files view: folder listings keyed by their
// path in the tree, the visible rows (folders first, lazily loaded), keyboard
// moves for the ARIA tree, the name filter and small formatting helpers.
//
// Ids are logical paths: a child's id is its folder's id joined with its
// name, so a folder reached through a symlink keeps its own subtree (the
// native side resolves every path inside the project before using it).

import type { DirectoryEntry, DirectoryListing } from './tauri'

/** The project root's key in `Folders`. */
export const ROOT = ''

/** Folders that are never expanded on their own (only by the user). */
export const HEAVY_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '.next', '__pycache__', '.turbo'])

export interface FolderState {
  entries?: DirectoryEntry[]
  /** The listing stopped at the native limit (3000 entries). */
  truncated?: boolean
  loading?: boolean
  error?: string
  /** The folder's own path as the native side resolved it (root only). */
  path?: string
}
export type Folders = Readonly<Record<string, FolderState>>

export interface TreeOptions {
  /** Show dot-files (dimmed). */
  showHidden: boolean
  /** Case-insensitive substring of loaded names. */
  filter: string
}

export interface TreeRow {
  id: string
  entry: DirectoryEntry
  level: number
  /** The folder key this row was listed in (ROOT for top-level rows). */
  parent: string
  expanded: boolean
  posInSet: number
  setSize: number
  /** A dot-file or dot-folder. */
  dotted: boolean
  heavy: boolean
  /** The name matches the active filter. */
  match: boolean
}

export interface TreeNode extends TreeRow {
  /** null while collapsed (and for files). */
  children: TreeNode[] | null
  /** The folder's own listing state, for expanded folders. */
  folder?: FolderState
}

export const isDotted = (name: string) => name.startsWith('.')
export const isHeavy = (name: string) => HEAVY_FOLDERS.has(name)

/** `parent/name` without doubling the separator (a root of "/"). */
export function joinPath(parent: string, name: string) {
  return parent.endsWith('/') ? parent + name : `${parent}/${name}`
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** Folders first, then natural name order (file2 before file10). */
export function compareEntries(a: DirectoryEntry, b: DirectoryEntry) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** A listing as tree state: logical child paths, folders first. */
export function normalizeListing(key: string, listing: DirectoryListing): FolderState {
  const base = key || listing.path
  const entries = listing.entries.map(entry => ({ ...entry, path: joinPath(base, entry.name) })).sort(compareEntries)
  return key === ROOT ? { entries, truncated: listing.truncated, path: listing.path } : { entries, truncated: listing.truncated }
}

const matches = (entry: DirectoryEntry, query: string) => !!query && entry.name.toLowerCase().includes(query)
const shownEntries = (state: FolderState | undefined, showHidden: boolean) =>
  (state?.entries ?? []).filter(entry => showHidden || !isDotted(entry.name))

/** Ids of loaded rows that match the filter or have a loaded match below them. */
export function filterKeep(folders: Folders, options: TreeOptions): Set<string> {
  const query = options.filter.trim().toLowerCase()
  const keep = new Set<string>()
  if (!query) return keep
  const visit = (key: string): boolean => {
    let any = false
    for (const entry of shownEntries(folders[key], options.showHidden)) {
      const below = entry.dir && folders[entry.path] ? visit(entry.path) : false
      if (below || matches(entry, query)) { keep.add(entry.path); any = true }
    }
    return any
  }
  visit(ROOT)
  return keep
}

/**
 * Expands the loaded ancestors of filter matches. Heavy folders are left as
 * they are, and nothing below a collapsed heavy folder is expanded.
 */
export function expandForFilter(folders: Folders, expanded: ReadonlySet<string>, options: TreeOptions): Set<string> {
  const next = new Set(expanded)
  const query = options.filter.trim().toLowerCase()
  if (!query) return next
  const keep = filterKeep(folders, options)
  const visit = (key: string) => {
    for (const entry of shownEntries(folders[key], options.showHidden)) {
      if (!entry.dir || !keep.has(entry.path) || !folders[entry.path]) continue
      const hasMatchBelow = shownEntries(folders[entry.path], options.showHidden).some(child => keep.has(child.path))
      if (!hasMatchBelow) continue
      if (isHeavy(entry.name) && !expanded.has(entry.path)) continue
      next.add(entry.path)
      visit(entry.path)
    }
  }
  visit(ROOT)
  return next
}

/**
 * The visible tree. With a filter, a row shows when its name matches, when
 * a loaded match sits below it, or when it is inside a matching folder.
 */
export function buildTree(folders: Folders, expanded: ReadonlySet<string>, options: TreeOptions): TreeNode[] {
  const query = options.filter.trim().toLowerCase()
  const keep = query ? filterKeep(folders, options) : null
  const walk = (key: string, level: number, insideMatch: boolean): TreeNode[] => {
    const entries = shownEntries(folders[key], options.showHidden)
    const shown = keep && !insideMatch ? entries.filter(entry => keep.has(entry.path)) : entries
    return shown.map((entry, index) => {
      const open = entry.dir && expanded.has(entry.path)
      const match = matches(entry, query)
      return {
        id: entry.path, entry, level, parent: key, expanded: open, posInSet: index + 1, setSize: shown.length,
        dotted: isDotted(entry.name), heavy: entry.dir && isHeavy(entry.name), match,
        children: open ? walk(entry.path, level + 1, insideMatch || match) : null,
        folder: open ? folders[entry.path] ?? {} : undefined,
      }
    })
  }
  return walk(ROOT, 1, false)
}

/** Rows in display order (what the keyboard walks). */
export function flattenTree(nodes: readonly TreeNode[]): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      const { children, folder: _folder, ...row } = node
      rows.push(row)
      if (children) walk(children)
    }
  }
  walk(nodes)
  return rows
}

/** Expanded folders that show but have no listing yet. */
export function foldersToLoad(rows: readonly TreeRow[], folders: Folders): string[] {
  return rows.filter(row => row.entry.dir && row.expanded && !folders[row.id]).map(row => row.id)
}

/** The focused row, or its nearest visible ancestor, or the first row. */
export function resolveFocus(rows: readonly TreeRow[], focus: string | null): string | null {
  if (!rows.length) return null
  if (focus === null) return rows[0].id
  let best: TreeRow | null = null
  for (const row of rows) {
    if (row.id === focus) return focus
    if (focus.startsWith(row.id.endsWith('/') ? row.id : `${row.id}/`) && (!best || row.id.length > best.id.length)) best = row
  }
  return (best ?? rows[0]).id
}

export type TreeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
export interface TreeMove { focus?: string; expand?: string; collapse?: string }

/**
 * APG tree keys: Up/Down move; Right expands a closed folder or enters an
 * open one; Left collapses an open folder or goes to the parent row.
 */
export function treeKeyMove(rows: readonly TreeRow[], focus: string | null, key: TreeKey): TreeMove {
  if (!rows.length) return {}
  const index = focus === null ? -1 : rows.findIndex(row => row.id === focus)
  if (key === 'Home') return { focus: rows[0].id }
  if (key === 'End') return { focus: rows[rows.length - 1].id }
  if (index < 0) return { focus: rows[0].id }
  const row = rows[index]
  switch (key) {
    case 'ArrowDown': return index + 1 < rows.length ? { focus: rows[index + 1].id } : {}
    case 'ArrowUp': return index > 0 ? { focus: rows[index - 1].id } : {}
    case 'ArrowRight': {
      if (!row.entry.dir) return {}
      if (!row.expanded) return { expand: row.id }
      const next = rows[index + 1]
      return next && next.parent === row.id ? { focus: next.id } : {}
    }
    case 'ArrowLeft': {
      if (row.entry.dir && row.expanded) return { collapse: row.id }
      return row.parent !== ROOT ? { focus: row.parent } : {}
    }
  }
  return {}
}

/** Type-ahead: the next row (after the focused one, wrapping) whose name starts with `text`. */
export function typeAhead(rows: readonly TreeRow[], focus: string | null, text: string): string | null {
  const query = text.toLowerCase()
  if (!query || !rows.length) return null
  const start = Math.max(0, rows.findIndex(row => row.id === focus))
  // A repeated single letter cycles; a longer prefix keeps the current row if it still fits.
  const offset = query.length > 1 ? 0 : 1
  for (let step = 0; step < rows.length; step++) {
    const row = rows[(start + offset + step) % rows.length]
    if (row.entry.name.toLowerCase().startsWith(query)) return row.id
  }
  return null
}

/** Drops expanded folders that a fresh listing of their parent no longer has. */
export function pruneExpanded(expanded: ReadonlySet<string>, folders: Folders): Set<string> {
  const known = new Map<string, Set<string>>()
  for (const [key, state] of Object.entries(folders)) {
    if (state.entries) known.set(key === ROOT ? state.path ?? '' : key, new Set(state.entries.filter(entry => entry.dir).map(entry => entry.path)))
  }
  const next = new Set<string>()
  for (const id of expanded) {
    const cut = id.lastIndexOf('/')
    const parent = cut > 0 ? id.slice(0, cut) : '/'
    const siblings = known.get(parent)
    if (!siblings || siblings.has(id)) next.add(id)
  }
  return next
}

export const errorText = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)

/**
 * Lists the root and every open folder below it, level by level (one level's
 * folders in parallel). Failed folders keep their error. Resolves null when
 * `stale()` turns true between levels (a newer reload or another project).
 */
export async function loadOpenFolders(list: (key: string) => Promise<DirectoryListing>, expanded: () => ReadonlySet<string>, stale: () => boolean = () => false): Promise<Record<string, FolderState> | null> {
  const next: Record<string, FolderState> = {}
  let queue = [ROOT]
  while (queue.length) {
    const results = await Promise.all(queue.map(key => list(key).then(
      listing => ({ key, state: normalizeListing(key, listing) }),
      (failure): { key: string; state: FolderState } => ({ key, state: { error: errorText(failure) } }),
    )))
    if (stale()) return null
    queue = []
    const open = expanded()
    for (const { key, state } of results) {
      next[key] = state
      for (const entry of state.entries ?? []) if (entry.dir && open.has(entry.path) && !(entry.path in next)) queue.push(entry.path)
    }
  }
  return next
}

/** The loaded entry with this id. */
export function findEntry(folders: Folders, id: string): DirectoryEntry | undefined {
  for (const state of Object.values(folders)) {
    const entry = state.entries?.find(item => item.path === id)
    if (entry) return entry
  }
  return undefined
}

/** `path` relative to the project root ("." for the root itself). */
export function relativePath(root: string | undefined, path: string) {
  if (!root) return path
  if (path === root) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export type FileKind = 'code' | 'text' | 'image' | 'html' | 'file'
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'rs', 'py', 'go', 'rb', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'toml', 'yaml', 'yml', 'xml', 'sql', 'lua', 'vue', 'svelte', 'astro', 'zig', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'scala', 'r', 'graphql', 'gql', 'proto', 'tf', 'nix', 'lock', 'ini', 'conf', 'env'])
const TEXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'log', 'csv', 'tsv', 'rtf'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'heic', 'avif'])
const CODE_NAMES = new Set(['dockerfile', 'makefile', 'justfile', 'procfile', 'gemfile', 'rakefile', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierrc', '.eslintrc'])

export function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
export const isHtml = (name: string) => ['html', 'htm'].includes(extensionOf(name))

/** Picks a row's icon. */
export function fileKind(name: string): FileKind {
  const extension = extensionOf(name)
  if (extension === 'html' || extension === 'htm') return 'html'
  if (IMAGE.has(extension)) return 'image'
  if (TEXT.has(extension)) return 'text'
  if (CODE.has(extension) || CODE_NAMES.has(name.toLowerCase())) return 'code'
  return 'file'
}

/** 0 bytes, 512 bytes, 1.5 KB, 12 KB, 3.2 MB. */
export function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value).toLocaleString('en-US')} ${units[unit]}`
}

/** Text split for the line-number gutter (a final newline adds no line). */
export function previewLines(content: string) {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
