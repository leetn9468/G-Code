// The side panel's Files view: the project's file tree over a preview pane.
// The tree loads one folder at a time (folders first) and keeps its
// expansion while the view is hidden; a refresh reloads the open folders.
// Keyboard: an APG tree with a roving tabindex (arrows, Home/End, Enter to
// preview, ⌘↓ to open, Shift+F10 or the context-menu key for row actions).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, ClipboardCopy, Copy, Ellipsis, ExternalLink, Eye, EyeOff, File, FileCode2, FileImage, FileText, Folder, FolderOpen, FolderSearch, FolderTree, Globe, Link2, PanelRightClose, RotateCw, Search, X } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { copyToClipboard, listDirectory, openPath, readProjectFile, revealPath, type DirectoryEntry, type FilePreview } from '@/lib/tauri'
import {
  ROOT, buildTree, errorText, expandForFilter, fileKind, findEntry, flattenTree, foldersToLoad, formatBytes, isHtml, loadOpenFolders, normalizeListing,
  previewLines, pruneExpanded, relativePath, resolveFocus, treeKeyMove, typeAhead, type FolderState, type TreeKey, type TreeNode, type TreeRow,
} from '@/lib/fileTree'
import '@/styles/files.css'

const ICON_STROKE = 1.75
const HIDDEN_KEY = 'gcode.files.showHidden'
const SPLIT_KEY = 'gcode.files.previewRatio'
const SPLIT_DEFAULT = 0.45
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8
const TREE_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

const clampSplit = (value: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
function stored<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : parse(raw) ?? fallback } catch { return fallback }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* a convenience only */ }
}
const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path
/** The row's id when `value` is that row or inside it (so memoised rows elsewhere skip re-rendering). */
const within = (id: string, value: string | null) => value !== null && (value === id || value.startsWith(`${id}/`)) ? value : null
const formatModified = (modified?: number | null) => modified ? new Date(modified).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; id: string }
  | { status: 'ready'; id: string; file: FilePreview; modified?: number | null }
  | { status: 'error'; id: string; error: string }

interface Notice { tone: 'error' | 'info'; text: string; reveal?: string }
interface MenuState { id: string; seq: number; open: boolean; left: number; top: number; width: number; height: number; align: 'start' | 'end'; keyboard: boolean }

/** Row callbacks (stable across renders). */
export interface TreeActions {
  register: (id: string, element: HTMLLIElement | null) => void
  focusRow: (id: string) => void
  click: (id: string) => void
  doubleClick: (id: string) => void
  toggle: (id: string) => void
  menu: (id: string, event: ReactMouseEvent, from: 'pointer' | 'button') => void
  retry: (id: string) => void
}

export function FileIcon({ entry, expanded, size = 16 }: { entry: Pick<DirectoryEntry, 'name' | 'dir'>; expanded?: boolean; size?: number }) {
  const props = { size, strokeWidth: ICON_STROKE, className: 'gc-files-icon', 'aria-hidden': true as const }
  if (entry.dir) return expanded ? <FolderOpen {...props}/> : <Folder {...props}/>
  switch (fileKind(entry.name)) {
    case 'code': case 'html': return <FileCode2 {...props}/>
    case 'text': return <FileText {...props}/>
    case 'image': return <FileImage {...props}/>
    default: return <File {...props}/>
  }
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark className="gc-files-mark">{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>
}

/** Listing notes under an open folder (or the root): loading, errors, empty, truncated. */
function FolderNotes({ id, folder, shown, level, query, actions }: { id: string; folder: FolderState; shown: number; level: number; query: string; actions: TreeActions }) {
  const notes: ReactNode[] = []
  const style = { '--level': level } as CSSProperties
  if (folder.error) notes.push(<li role="none" className="gc-files-note" data-tone="error" style={style} key="error">
    <span>{folder.error}</span><button type="button" tabIndex={-1} className="gc-files-note-action" onClick={() => actions.retry(id)}>Retry</button>
  </li>)
  else if (!folder.entries) notes.push(<li role="none" className="gc-files-note" style={style} key="loading"><span className="gc-shimmer-text">Loading…</span></li>)
  else if (!shown && !query) notes.push(<li role="none" className="gc-files-note" style={style} key="empty">{folder.entries.length ? 'Only hidden items' : 'Empty folder'}</li>)
  if (folder.truncated && folder.entries) notes.push(<TruncatedNote count={folder.entries.length} level={level} key="truncated"/>)
  return <>{notes}</>
}

function TruncatedNote({ count, level }: { count: number; level: number }) {
  return <li role="none" className="gc-files-note" data-tone="warning" style={{ '--level': level } as CSSProperties}>
    Showing the first {count.toLocaleString('en-US')} items. Use Show in Finder to see the rest.
  </li>
}

interface ItemProps { node: TreeNode; activeId: string | null; selectedId: string | null; menuId: string | null; query: string; actions: TreeActions }

// Not a named function expression: inside one, the name would bind to the
// unmemoised function and every nested row would re-render with its folder.
const TreeItem = memo(function Row({ node, activeId, selectedId, menuId, query, actions }: ItemProps) {
  const { entry } = node
  const label = entry.link ? `${entry.name}, symbolic link` : entry.name
  return <li role="treeitem" className="gc-files-item" ref={element => actions.register(node.id, element)}
    aria-label={label} aria-level={node.level} aria-setsize={node.setSize} aria-posinset={node.posInSet}
    aria-expanded={entry.dir ? node.expanded : undefined} aria-selected={node.id === selectedId} aria-busy={node.folder?.loading || undefined}
    tabIndex={node.id === activeId ? 0 : -1}
    onFocus={event => { if (event.target === event.currentTarget) actions.focusRow(node.id) }}>
    <div className="gc-files-row" style={{ '--level': node.level } as CSSProperties} data-dotted={node.dotted || undefined} data-heavy={node.heavy || undefined} data-menu={menuId === node.id || undefined}
      title={entry.name}
      onMouseDown={event => { if (event.button === 0 || event.button === 2) { event.preventDefault(); actions.focusRow(node.id) } }}
      onClick={() => actions.click(node.id)}
      onDoubleClick={() => actions.doubleClick(node.id)}
      onContextMenu={event => actions.menu(node.id, event, 'pointer')}>
      <span className="gc-files-twisty" aria-hidden="true" onClick={entry.dir ? (event => { event.stopPropagation(); actions.toggle(node.id) }) : undefined} onDoubleClick={event => event.stopPropagation()}>
        {entry.dir && (node.folder?.loading && !node.folder.entries ? <span className="gc-spinner gc-files-spinner"/> : <ChevronRight size={14} strokeWidth={2}/>)}
      </span>
      <FileIcon entry={entry} expanded={node.expanded}/>
      <span className="gc-files-name"><Highlight text={entry.name} query={node.match ? query : ''}/></span>
      {entry.link && <Link2 size={13} strokeWidth={ICON_STROKE} className="gc-files-link" aria-hidden="true"/>}
      <span className="gc-files-more" aria-hidden="true" title="More actions"
        onClick={event => { event.stopPropagation(); actions.menu(node.id, event, 'button') }} onDoubleClick={event => event.stopPropagation()}>
        <Ellipsis size={15} strokeWidth={ICON_STROKE}/>
      </span>
    </div>
    {node.children && <ul role="group" className="gc-files-group" style={{ '--level': node.level } as CSSProperties}>
      {node.children.map(child => <TreeItem key={child.id} node={child} activeId={within(child.id, activeId)} selectedId={within(child.id, selectedId)} menuId={within(child.id, menuId)} query={query} actions={actions}/>)}
      {node.folder && <FolderNotes id={node.id} folder={node.folder} shown={node.children.length} level={node.level + 1} query={query} actions={actions}/>}
    </ul>}
  </li>
})

/** The ARIA tree itself (presentational; FilesPanel owns the state). */
export function FileTree({ nodes, root, activeId, selectedId, menuId = null, query = '', actions, onKeyDown }: {
  nodes: readonly TreeNode[]; root?: FolderState; activeId: string | null; selectedId: string | null; menuId?: string | null; query?: string; actions: TreeActions
  onKeyDown?: (event: ReactKeyboardEvent<HTMLUListElement>) => void
}) {
  return <ul role="tree" aria-label="Project files" className="gc-files-tree" onKeyDown={onKeyDown}>
    {nodes.map(node => <TreeItem key={node.id} node={node} activeId={within(node.id, activeId)} selectedId={within(node.id, selectedId)} menuId={within(node.id, menuId)} query={query} actions={actions}/>)}
    {root?.truncated && root.entries && <TruncatedNote count={root.entries.length} level={1}/>}
  </ul>
}

/** The preview body for one file: text with line numbers, an image, or a notice. */
export function FilePreviewBody({ name, file }: { name: string; file: FilePreview }) {
  if (file.imageDataUrl) return <div className="gc-files-preview-body" data-state="image"><img src={file.imageDataUrl} alt={name} className="gc-output-image"/></div>
  if (file.binary) return <div className="gc-files-preview-body" data-state="notice"><div className="gc-output-hint"><p>Binary file</p><small>{formatBytes(file.bytes)} · no text preview. Use Open to view it in its default app.</small></div></div>
  if (!file.content) return <div className="gc-files-preview-body" data-state="notice"><div className="gc-output-hint"><p>Empty file</p></div></div>
  const lines = previewLines(file.content)
  return <div className="gc-files-code" role="region" aria-label={`Contents of ${name}`} tabIndex={0}>
    <pre className="gc-files-gutter" aria-hidden="true">{lines.map((_, index) => index + 1).join('\n')}</pre>
    <pre className="gc-files-text"><code>{lines.join('\n')}</code></pre>
  </div>
}

export function FilesPanel({ open, onClose, cwd, refreshKey, onOpenInBrowser }: { open: boolean; onClose: (slide?: boolean) => void; cwd?: string; refreshKey?: number; onOpenInBrowser?: (path: string) => void }) {
  const [folders, setFolders] = useState<Record<string, FolderState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [showHidden, setShowHidden] = useState(() => stored(HIDDEN_KEY, raw => raw === 'false' ? false : raw === 'true' ? true : undefined, true))
  const [filter, setFilter] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [reloading, setReloading] = useState(false)
  const [split, setSplit] = useState(() => stored(SPLIT_KEY, raw => { const value = Number(raw); return Number.isFinite(value) ? clampSplit(value) : undefined }, SPLIT_DEFAULT))

  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  const itemIds = useRef(new WeakMap<Element, string>())
  const pendingFocus = useRef<string | null>(null)
  const generation = useRef(0)
  const previewRevision = useRef(0)
  const loadedFor = useRef<{ cwd: string; refreshKey?: number } | null>(null)
  const typed = useRef({ text: '', at: 0 })
  const menuSeq = useRef(0)
  // Latest values for async work and stable callbacks.
  const latest = useRef({ cwd, folders, expanded, selectedId, focusId, preview })
  latest.current = { cwd, folders, expanded, selectedId, focusId, preview }

  const options = useMemo(() => ({ showHidden, filter }), [showHidden, filter])
  const nodes = useMemo(() => buildTree(folders, expanded, options), [folders, expanded, options])
  const rows = useMemo(() => flattenTree(nodes), [nodes])
  const rowById = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows])
  const activeId = resolveFocus(rows, focusId)
  const root = folders[ROOT]
  const rootPath = root?.path

  // ---- Loading ----------------------------------------------------------
  const loadFolder = useCallback(async (key: string) => {
    const dir = latest.current.cwd
    if (!dir) return
    const gen = generation.current
    setFolders(prev => ({ ...prev, [key]: { ...prev[key], loading: true, error: undefined } }))
    try {
      const listing = await listDirectory(dir, key || undefined)
      if (gen !== generation.current) return
      setFolders(prev => ({ ...prev, [key]: normalizeListing(key, listing) }))
    } catch (failure) {
      if (gen !== generation.current) return
      setFolders(prev => ({ ...prev, [key]: { ...prev[key], loading: false, error: errorText(failure) } }))
    }
  }, [])

  /** quiet: keep the current preview on screen until the new read lands. */
  const loadPreview = useCallback(async (id: string, quiet = false, modified = findEntry(latest.current.folders, id)?.modified) => {
    const dir = latest.current.cwd
    if (!dir) return
    const revision = ++previewRevision.current
    if (!quiet) setPreview({ status: 'loading', id })
    try {
      const file = await readProjectFile(dir, id)
      if (revision === previewRevision.current) setPreview({ status: 'ready', id, file, modified })
    } catch (failure) {
      if (revision === previewRevision.current) setPreview({ status: 'error', id, error: errorText(failure) })
    }
  }, [])

  const clearPreview = useCallback(() => { previewRevision.current++; setSelectedId(null); setPreview({ status: 'idle' }) }, [])

  /** Reloads the root and every open folder below it, level by level, then swaps them in. */
  const reload = useCallback(async (dir: string, fresh: boolean) => {
    const gen = ++generation.current
    if (fresh) setFolders({})
    setReloading(true)
    const next = await loadOpenFolders(key => listDirectory(dir, key || undefined), () => latest.current.expanded, () => gen !== generation.current)
    if (!next) return
    setFolders(next)
    setExpanded(prev => { const pruned = pruneExpanded(prev, next); return pruned.size === prev.size ? prev : pruned })
    setReloading(false)
    // Keep the preview while its file is still there, re-read when it changed.
    const selected = latest.current.selectedId
    if (!selected) return
    const entry = findEntry(next, selected)
    if (entry && !entry.dir) {
      const current = latest.current.preview
      const shown = current.status === 'ready' && current.id === selected
      if (!shown || current.modified !== entry.modified) void loadPreview(selected, shown, entry.modified)
      return
    }
    const base = next[ROOT]?.path
    const parent = selected.slice(0, selected.lastIndexOf('/'))
    const parentListed = !!(parent === base ? next[ROOT] : next[parent])?.entries
    const insideRoot = !!base && relativePath(base, selected) !== selected
    // Gone, outside the new root, or now a folder: drop it; inside a closed folder: re-read to check.
    if (entry || parentListed || !insideRoot) clearPreview()
    else void loadPreview(selected, true)
  }, [clearPreview, loadPreview])

  // Lazy: the first open loads the root; cwd and refreshKey changes reload when (next) shown.
  useEffect(() => {
    if (!open) return
    if (!cwd) { loadedFor.current = null; generation.current++; setFolders({}); setReloading(false); return }
    const last = loadedFor.current
    if (last && last.cwd === cwd && last.refreshKey === refreshKey) return
    loadedFor.current = { cwd, refreshKey }
    if (last && last.cwd !== cwd) setNotice(null)
    void reload(cwd, !last || last.cwd !== cwd)
  }, [open, cwd, refreshKey, reload])

  // Open folders that show without a listing yet (a user expansion, or one kept through a reload).
  useEffect(() => {
    if (!open || !cwd) return
    for (const id of foldersToLoad(rows, folders)) void loadFolder(id)
  }, [open, cwd, rows, folders, loadFolder])

  // The filter opens the loaded ancestors of its matches (heavy folders stay as they are).
  useEffect(() => {
    if (!filter.trim()) return
    setExpanded(prev => { const next = expandForFilter(latest.current.folders, prev, { showHidden, filter }); return next.size === prev.size ? prev : next })
  }, [filter, showHidden])

  // Keyboard focus moves after the row renders; only the row scrolls into view, not its open subtree.
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const item = items.current.get(id)
    if (!item) return
    pendingFocus.current = null
    item.focus({ preventScroll: true })
    item.querySelector<HTMLElement>(':scope > .gc-files-row')?.scrollIntoView?.({ block: 'nearest' })
  })

  // Opened from the keyboard: start on the first item (Radix focuses the menu itself, after its portal mounts).
  useEffect(() => {
    if (!menu?.open || !menu.keyboard) return
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>('.gc-files-menu[data-state="open"] [role="menuitem"]')?.focus({ preventScroll: true }))
    return () => window.clearTimeout(timer)
  }, [menu])

  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = window.setTimeout(() => setNotice(current => current === notice ? null : current), 1800)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ---- Actions ----------------------------------------------------------
  /** Keyboard-driven focus moves (the row's ring shows). */
  const moveFocus = (id: string) => { setFocusId(id); pendingFocus.current = id; setModality('keyboard') }
  // Rows are focused from script on mouse down too; the ring is for keyboard use only.
  const setModality = (value: 'keyboard' | 'pointer') => { if (sectionRef.current && sectionRef.current.dataset.modality !== value) sectionRef.current.dataset.modality = value }

  const toggle = (id: string, force?: boolean) => {
    const isOpen = latest.current.expanded.has(id)
    const next = force ?? !isOpen
    if (next === isOpen) return
    setExpanded(prev => { const set = new Set(prev); if (next) set.add(id); else set.delete(id); return set })
    if (next) return
    // Collapsing: a failed listing is retried on the next expand, and focus inside comes up to the folder.
    if (latest.current.folders[id]?.error) setFolders(prev => { const { [id]: _failed, ...rest } = prev; return rest })
    const item = items.current.get(id)
    const active = document.activeElement
    if (within(id, latest.current.focusId) && latest.current.focusId !== id) { setFocusId(id); if (item && active && item !== active && item.contains(active)) pendingFocus.current = id }
  }

  const select = (id: string) => {
    const row = rowById.get(id)
    if (!row || row.entry.dir) return
    setSelectedId(id)
    void loadPreview(id)
  }

  const runOpen = (id: string) => {
    const dir = latest.current.cwd
    if (!dir) return
    setNotice(null)
    openPath(dir, id).catch(failure => setNotice({ tone: 'error', text: `Couldn’t open ${baseName(id)}: ${errorText(failure)}`, reveal: id }))
  }
  const runReveal = (id: string) => {
    const dir = latest.current.cwd
    if (!dir) return
    setNotice(null)
    revealPath(dir, id).catch(failure => setNotice({ tone: 'error', text: `Couldn’t show ${baseName(id)} in Finder: ${errorText(failure)}` }))
  }
  const runCopy = (id: string, relative = false) => {
    const text = relative ? relativePath(rootPath, id) : id
    copyToClipboard(text).then(() => setNotice({ tone: 'info', text: relative ? 'Copied relative path' : 'Copied path' }), failure => setNotice({ tone: 'error', text: `Couldn’t copy the path: ${errorText(failure)}` }))
  }

  const openMenu = (id: string, rect: { left: number; top: number; width: number; height: number }, align: MenuState['align'], keyboard = false) => {
    const base = sectionRef.current?.getBoundingClientRect()
    if (!base) return
    setFocusId(id)
    setMenu({ id, seq: ++menuSeq.current, open: true, left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height, align, keyboard })
  }

  /** Back to the row when the menu closes, unless focus already moved elsewhere (a click on another control). */
  const restoreRowFocus = (id: string) => {
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.gc-files-menu')) return
    items.current.get(id)?.focus({ preventScroll: true })
  }

  const activate = (row: TreeRow) => { if (row.entry.dir) toggle(row.id); else select(row.id) }

  // Row callbacks go through a ref so the memoised rows never see new functions.
  const handlers = useRef<TreeActions>(null as unknown as TreeActions)
  handlers.current = {
    register: (id, element) => { if (element) { items.current.set(id, element); itemIds.current.set(element, id) } else items.current.delete(id) },
    focusRow: id => {
      setFocusId(id)
      const item = items.current.get(id)
      if (item && document.activeElement !== item) item.focus({ preventScroll: true })
    },
    // A click on a folder row opens or closes it (as in Finder's list view and VS Code); a file is previewed.
    click: id => { const row = rowById.get(id); if (!row) return; if (row.entry.dir) toggle(id); else select(id) },
    // The two clicks of a double-click already toggled a folder; only files open.
    doubleClick: id => { const row = rowById.get(id); if (row && !row.entry.dir) runOpen(id) },
    toggle: id => toggle(id),
    menu: (id, event, from) => {
      event.preventDefault()
      if (from === 'button') openMenu(id, event.currentTarget.getBoundingClientRect(), 'end')
      else openMenu(id, { left: event.clientX, top: event.clientY, width: 1, height: 1 }, 'start')
    },
    retry: id => { setFolders(prev => { const { [id]: _failed, ...rest } = prev; return rest }) },
  }
  const actions = useMemo<TreeActions>(() => ({
    register: (id, element) => handlers.current.register(id, element),
    focusRow: id => handlers.current.focusRow(id),
    click: id => handlers.current.click(id),
    doubleClick: id => handlers.current.doubleClick(id),
    toggle: id => handlers.current.toggle(id),
    menu: (id, event, from) => handlers.current.menu(id, event, from),
    retry: id => handlers.current.retry(id),
  }), [])

  const onTreeKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    // The focused row is the event's target (state may not have caught up with a fast key repeat).
    const targetId = itemIds.current.get(event.target as Element)
    if (!targetId) return
    const row = rowById.get(targetId)
    const current = row ? row.id : activeId
    const { key, metaKey, ctrlKey, altKey, shiftKey } = event
    if (metaKey && !ctrlKey && !altKey && key === 'ArrowDown') {
      event.preventDefault()
      if (!row) return
      if (!row.entry.dir) { runOpen(row.id); return }
      const move = treeKeyMove(rows, row.id, 'ArrowRight')
      if (move.expand) toggle(move.expand, true)
      if (move.focus) moveFocus(move.focus)
      return
    }
    if (metaKey && !ctrlKey && !altKey && key === 'ArrowUp') {
      event.preventDefault()
      if (row && row.parent !== ROOT) moveFocus(row.parent)
      return
    }
    if (metaKey && altKey && !ctrlKey && key.toLowerCase() === 'c' && row) { event.preventDefault(); runCopy(row.id); return }
    if (TREE_KEYS.has(key) && !metaKey && !ctrlKey && !altKey) {
      event.preventDefault()
      const move = treeKeyMove(rows, current, key as TreeKey)
      if (move.expand) toggle(move.expand, true)
      if (move.collapse) toggle(move.collapse, false)
      if (move.focus) moveFocus(move.focus)
      return
    }
    if ((key === 'Enter' || key === ' ') && !metaKey && !ctrlKey && !altKey) {
      event.preventDefault()
      if (row) activate(row)
      return
    }
    if (key === 'ContextMenu' || (shiftKey && key === 'F10')) {
      event.preventDefault()
      const element = row && items.current.get(row.id)?.querySelector<HTMLElement>(':scope > .gc-files-row .gc-files-name')
      if (row && element) { const rect = element.getBoundingClientRect(); openMenu(row.id, { left: rect.left, top: rect.top, width: Math.min(rect.width, 160), height: rect.height }, 'start', true) }
      return
    }
    if (key.length === 1 && key !== ' ' && !metaKey && !ctrlKey && !altKey) {
      const now = Date.now()
      typed.current = { text: now - typed.current.at > 600 ? key : typed.current.text + key, at: now }
      const target = typeAhead(rows, current, typed.current.text)
      if (target) { event.preventDefault(); moveFocus(target) }
    }
  }

  const onFilterKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && filter) { event.preventDefault(); setFilter(''); return }
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const target = (filter.trim() ? rows.find(row => row.match)?.id : undefined) ?? activeId
      if (!target) return
      event.preventDefault()
      moveFocus(target)
    }
  }

  const refresh = () => {
    if (!cwd) return
    loadedFor.current = { cwd, refreshKey }
    void reload(cwd, false)
  }
  const toggleHidden = () => setShowHidden(value => { store(HIDDEN_KEY, String(!value)); return !value })

  // ---- Preview split ----------------------------------------------------
  const startSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const body = bodyRef.current
    if (!body) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-resizing')
    let current = split
    const move = (moveEvent: PointerEvent) => {
      const rect = body.getBoundingClientRect()
      if (rect.height > 0) { current = clampSplit((rect.bottom - moveEvent.clientY) / rect.height); setSplit(current) }
    }
    const end = () => {
      handle.classList.remove('is-resizing')
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end)
      store(SPLIT_KEY, current.toFixed(3))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const commitSplit = (value: number) => { const next = clampSplit(value); setSplit(next); store(SPLIT_KEY, next.toFixed(3)) }
  const splitKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.05
    const keys: Record<string, number> = { ArrowUp: split + step, ArrowDown: split - step, Home: SPLIT_MAX, End: SPLIT_MIN }
    if (!(event.key in keys)) return
    event.preventDefault()
    commitSplit(keys[event.key])
  }

  // ---- Render -----------------------------------------------------------
  const menuRow = menu ? rowById.get(menu.id) : undefined
  const menuEntry = menuRow?.entry ?? (menu ? findEntry(folders, menu.id) : undefined)
  const selectedEntry = selectedId ? findEntry(folders, selectedId) : undefined
  const selectedName = selectedId ? baseName(selectedId) : ''
  const query = filter.trim()
  const projectName = rootPath ? baseName(rootPath) : cwd ? baseName(cwd) : ''

  let tree: ReactNode
  if (!cwd) tree = <Empty title="No project folder" text="Choose a project folder for this chat to browse its files here."/>
  else if (!root || (!root.entries && !root.error)) tree = <div className="gc-files-state"><span className="gc-shimmer-text">Loading files…</span></div>
  else if (!root.entries) tree = <div className="gc-files-state"><p role="alert" className="gc-files-error">{root.error}</p><button type="button" className="gc-btn gc-btn-ghost gc-files-retry" onClick={refresh}>Try again</button></div>
  else if (!nodes.length) tree = query
    ? <Empty title="No matches" text={`No loaded file or folder name contains “${query}”. The filter searches folders that have been opened.`}/>
    : <Empty title={root.entries.length ? 'Only hidden items' : 'This folder is empty'} text={root.entries.length ? 'Show hidden files to see them.' : 'Files created in the project folder appear here.'}/>
  else tree = <FileTree nodes={nodes} root={root} activeId={activeId} selectedId={selectedId} menuId={menu?.open ? menu.id : null} query={query} actions={actions} onKeyDown={onTreeKey}/>

  const meta = [
    selectedId && rootPath ? relativePath(rootPath, selectedId).split('/').slice(0, -1).join('/') : '',
    preview.status === 'ready' ? formatBytes(preview.file.bytes) : formatBytes(selectedEntry?.size),
    formatModified(selectedEntry?.modified) && `Modified ${formatModified(selectedEntry?.modified)}`,
  ].filter(Boolean).join(' · ')

  return <section ref={sectionRef} className="gc-side-view gc-files" hidden={!open} tabIndex={-1} aria-labelledby="files-title"
    onPointerDownCapture={() => setModality('pointer')} onKeyDownCapture={event => { if (!event.metaKey || event.key.startsWith('Arrow')) setModality('keyboard') }}>
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="files-title" className="gc-side-title"><FolderTree size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Files</span>{projectName && <span className="gc-files-project" title={rootPath ?? cwd}>{projectName}</span>}</h2>
      <Tooltip content={showHidden ? 'Hide hidden files' : 'Show hidden files'}><button type="button" className="gc-side-icon" aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'} onClick={toggleHidden}>{showHidden ? <Eye size={16} strokeWidth={ICON_STROKE}/> : <EyeOff size={16} strokeWidth={ICON_STROKE}/>}</button></Tooltip>
      <Tooltip content="Refresh"><button type="button" className="gc-side-icon gc-files-refresh" aria-label="Refresh files" aria-busy={reloading || undefined} aria-disabled={!cwd || undefined} onClick={refresh}><RotateCw size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" aria-label="Close files" onClick={(event) => onClose(event.detail > 0)}><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    {cwd && <div className="gc-files-toolbar">
      <label className="gc-files-filter">
        <Search size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>
        <input ref={filterRef} type="text" value={filter} placeholder="Filter loaded files" aria-label="Filter files" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
          onChange={event => setFilter(event.target.value)} onKeyDown={onFilterKey}/>
        {filter && <button type="button" className="gc-files-clear" aria-label="Clear filter" onClick={() => { setFilter(''); filterRef.current?.focus() }}><X size={13} strokeWidth={2}/></button>}
      </label>
    </div>}
    <div ref={bodyRef} className="gc-files-body" style={{ '--files-preview': split } as CSSProperties}>
      <div className="gc-files-tree-pane">
        <div className="gc-files-scroll">{tree}</div>
        <div className="gc-files-notices" aria-live="polite">
          {notice && <div className="gc-files-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : undefined}>
            <span>{notice.text}</span>
            {notice.reveal && <button type="button" className="gc-files-notice-action" onClick={() => { const id = notice.reveal!; runReveal(id) }}>Show in Finder</button>}
            {notice.tone === 'error' && <button type="button" className="gc-files-notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={13} strokeWidth={2}/></button>}
          </div>}
        </div>
      </div>
      {selectedId && <>
        <div ref={splitRef} className="gc-files-split" role="separator" aria-orientation="horizontal" aria-label="Resize preview" aria-controls="gc-files-preview" tabIndex={0}
          aria-valuemin={SPLIT_MIN * 100} aria-valuemax={SPLIT_MAX * 100} aria-valuenow={Math.round(split * 100)} title="Drag to resize · Double-click to reset"
          onPointerDown={startSplit} onKeyDown={splitKey} onDoubleClick={() => commitSplit(SPLIT_DEFAULT)}/>
        <div id="gc-files-preview" className="gc-files-preview" aria-label={`Preview of ${selectedName}`} role="region">
          <div className="gc-files-preview-head">
            <FileIcon entry={{ name: selectedName, dir: false }}/>
            <div className="gc-files-preview-title"><strong title={selectedId}>{selectedName}</strong>{meta && <small>{meta}</small>}</div>
            {isHtml(selectedName) && onOpenInBrowser && <Tooltip content="Open in Browser"><button type="button" className="gc-side-icon" aria-label="Open in Browser" onClick={() => onOpenInBrowser(selectedId)}><Globe size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>}
            <Tooltip content="Open" shortcut="⌘↓"><button type="button" className="gc-side-icon" aria-label={`Open ${selectedName}`} onClick={() => runOpen(selectedId)}><ExternalLink size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
            <Tooltip content="Show in Finder"><button type="button" className="gc-side-icon" aria-label="Show in Finder" onClick={() => runReveal(selectedId)}><FolderSearch size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
            <Tooltip content="Close preview"><button type="button" className="gc-side-icon" aria-label="Close preview" onClick={clearPreview}><X size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
          </div>
          {preview.status === 'error' ? <div className="gc-files-preview-body" data-state="notice"><p role="alert" className="gc-files-error">{preview.error}</p></div>
            : preview.status === 'ready' ? <FilePreviewBody name={selectedName} file={preview.file}/>
            : <div className="gc-files-preview-body" data-state="notice"><span className="gc-shimmer-text">Loading preview…</span></div>}
          {preview.status === 'ready' && preview.file.truncated && !preview.file.binary && <p className="gc-files-preview-foot">Showing the first 256 KB of {formatBytes(preview.file.bytes)}. Open the file to see all of it.</p>}
        </div>
      </>}
    </div>

    {/* One shared menu for every row, anchored where it was asked for; it stays mounted while closing so it can fade out. */}
    <DropdownMenu.Root key={menu?.seq ?? 0} open={!!menu?.open && !!menuEntry} onOpenChange={value => { if (!value) { restoreRowFocus(menu?.id ?? ''); setMenu(current => current && { ...current, open: false }) } }} modal={false}>
      <DropdownMenu.Trigger asChild>
        <span className="gc-files-menu-anchor" aria-hidden="true" tabIndex={-1} style={menu ? { left: menu.left, top: menu.top, width: menu.width, height: menu.height } : undefined}/>
      </DropdownMenu.Trigger>
      {menu && menuEntry && <DropdownMenu.Portal>
        <DropdownMenu.Content className="gc-menu gc-files-menu" side="bottom" align={menu.align} sideOffset={4} collisionPadding={12} loop
          onCloseAutoFocus={event => { event.preventDefault(); restoreRowFocus(menu.id) }}>
          <DropdownMenu.Label className="gc-menu-label gc-files-menu-label">{menuEntry.name}</DropdownMenu.Label>
          {!menuEntry.dir && <DropdownMenu.Item className="gc-menu-item" onSelect={() => select(menu.id)}><Eye size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Preview</span><kbd className="gc-files-menu-kbd">↩</kbd></DropdownMenu.Item>}
          <DropdownMenu.Item className="gc-menu-item" onSelect={() => runOpen(menu.id)}><ExternalLink size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Open</span>{!menuEntry.dir && <kbd className="gc-files-menu-kbd">⌘↓</kbd>}</DropdownMenu.Item>
          {!menuEntry.dir && isHtml(menuEntry.name) && onOpenInBrowser && <DropdownMenu.Item className="gc-menu-item" onSelect={() => onOpenInBrowser(menu.id)}><Globe size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Open in Browser</span></DropdownMenu.Item>}
          <DropdownMenu.Item className="gc-menu-item" onSelect={() => runReveal(menu.id)}><FolderSearch size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Show in Finder</span></DropdownMenu.Item>
          <DropdownMenu.Separator className="gc-menu-separator"/>
          <DropdownMenu.Item className="gc-menu-item" onSelect={() => runCopy(menu.id)}><Copy size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Copy path</span><kbd className="gc-files-menu-kbd">⌥⌘C</kbd></DropdownMenu.Item>
          {rootPath && <DropdownMenu.Item className="gc-menu-item" onSelect={() => runCopy(menu.id, true)}><ClipboardCopy size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Copy relative path</span></DropdownMenu.Item>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>}
    </DropdownMenu.Root>
  </section>
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="gc-outputs-empty gc-files-empty"><span className="gc-modal-icon gc-outputs-empty-icon" aria-hidden="true"><FolderTree size={18} strokeWidth={ICON_STROKE}/></span><strong>{title}</strong><small>{text}</small></div>
}
