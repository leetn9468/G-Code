import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { ArrowRight, Check, ChevronDown, ChevronUp, Copy, FileCode2, FileDiff, FileMinus2, FilePen, FilePlus2, FolderOpen, PanelRightClose, SquareArrowOutUpRight, TriangleAlert, UnfoldVertical } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { flatProjection, springIndicator } from '@/lib/motion'
import { BASELINE_VERSION, copyToClipboard, gitHeadFile, openPath, readSessionOutput, revealPath, type FilePreview } from '@/lib/tauri'
import { STATUS_LABELS, changeStatus, expandGap, lineDiff, lineNumberDigits, segments, splitRows, type ChangeStatus, type DiffLine, type GapSegment, type LineDiff, type Segment, type SplitRow } from '@/lib/diff'
import { droppedVersionsNote, missingCopiesNote, outputErrorMessage, savedVersions, useDeletedOutputFolder, versionNumber, type OutputErrorSubject } from '../session/Outputs'
import type { SessionOutput } from '../../../../src/shared/sessionControls'
import '@/styles/changes.css'

const ICON_STROKE = 1.75
const MODE_KEY = 'gcode.changes.mode'
/** Rows rendered before "Show more" (keeps a huge diff from blocking a frame). */
const ROW_BUDGET = 1500
const EXPAND_STEP = 20
/** File copies kept in memory (each at most 256 KB of text, or a ≤5 MB image). */
const CACHE_LIMIT = 80

/** What a side of the comparison is: the copy from before the session, the last commit, the current file or a saved version (`v:<id>`). */
export type Spec = 'baseline' | 'head' | 'current' | `v:${string}`
export type DiffMode = 'unified' | 'split'
/** One side's contents; `absent` when the file did not exist there. `sha` is known for saved snapshots. */
export interface Side { absent: boolean; content: string; bytes: number; truncated: boolean; binary: boolean; imageDataUrl?: string; sha?: string }
export interface ChangeStat { added: number; removed: number; status: ChangeStatus; binary: boolean }

const ABSENT: Side = { absent: true, content: '', bytes: 0, truncated: false, binary: false }
const toSide = (file: FilePreview, sha?: string): Side => file.absent ? ABSENT : ({ absent: false, content: file.content ?? '', bytes: file.bytes ?? 0, truncated: !!file.truncated, binary: !!file.binary, imageDataUrl: file.imageDataUrl, sha })
/** The current file is gone (deleted), as opposed to unreadable. */
export const isMissingFile = (failure: unknown) => /No such file|os error 2|not found/i.test(String(failure))
const isBinary = (a: Side, b: Side) => a.binary || b.binary || !!a.imageDataUrl || !!b.imageDataUrl

/** +/- counts and status for one comparison. */
export function compareSides(a: Side, b: Side, diff?: LineDiff): ChangeStat {
  if (isBinary(a, b)) {
    const identical = !a.absent && !b.absent && ((!!a.sha && a.sha === b.sha) || (!!a.imageDataUrl && a.imageDataUrl === b.imageDataUrl))
    return { added: 0, removed: 0, binary: true, status: changeStatus(a.absent, b.absent, identical) }
  }
  const { added, removed } = diff ?? lineDiff(a.content, b.content, { words: false })
  return { added, removed, binary: false, status: changeStatus(a.absent, b.absent, !added && !removed) }
}

export function specLabel(spec: Spec | '', output: SessionOutput): string {
  if (spec === 'baseline') return 'Before this session'
  if (spec === 'head') return 'Last commit'
  if (spec === 'current') return 'Current file'
  const index = output.versions?.findIndex(version => `v:${version.id}` === spec) ?? -1
  return index >= 0 ? `v${versionNumber(output, index)}` : 'No earlier copy'
}

/** Whether this side can be compared: a version that was dropped or never saved cannot. */
const canRead = (spec: Spec | '', output: SessionOutput) => !spec.startsWith('v:') || savedVersions(output).some(version => `v:${version.id}` === spec)
/** A version in a picker. One whose bytes were not saved is listed, and cannot be picked. */
const versionOption = (output: SessionOutput, entry: NonNullable<SessionOutput['versions']>[number], index: number) => <option key={entry.id} value={`v:${entry.id}`} disabled={!!entry.notKept}>v{versionNumber(output, index)} · {versionTime(entry.createdAt)}{entry.notKept ? ' · not kept: held a key' : ''}</option>

const versionTime = (createdAt: number) => new Date(createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fileName = (path: string) => path.split('/').pop() || path
const directory = (path: string, cwd?: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path).split('/').slice(0, -1).join('/') || '.'
const bytes = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'byte' : 'bytes'}`
const STATUS_ICONS = { added: FilePlus2, deleted: FileMinus2, modified: FilePen, unchanged: FileCode2 } as const

/** A row's status: from its A → B comparison; a file the session deleted reads Deleted while B is its (missing) current file, also before any comparison is known. */
export function rowStatus(item: SessionOutput, stat: ChangeStat | undefined, b: Spec): ChangeStatus | undefined {
  return item.deleted && b === 'current' ? 'deleted' : stat?.status
}

function storedMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}

/** The side panel's Changes view: the session's changed files, each compared A → B (mounted while hidden, so the selection survives). onClose(slide): closed with the pointer. */
export function ChangesPanel({ open, onClose, outputs, cwd, sessionId }: { open: boolean; onClose: (slide?: boolean) => void; outputs: SessionOutput[]; cwd?: string; sessionId: string }) {
  const sorted = useMemo(() => [...outputs].sort((a, b) => b.updatedAt - a.updatedAt), [outputs])
  const [selected, setSelected] = useState('')
  const [aSpec, setASpec] = useState<Spec | ''>('')
  const [aReady, setAReady] = useState(false)
  const [bSpec, setBSpec] = useState<Spec>('current')
  const [sides, setSides] = useState<{ key: string; path: string; a: Side; b: Side; aSpec: Spec; bSpec: Spec } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [copied, setCopied] = useState(false)
  const [mode, setModeState] = useState<DiffMode>(storedMode)
  const [modePointer, setModePointer] = useState(false)
  const [headOk, setHeadOk] = useState<Record<string, boolean>>({})
  const [reveal, setReveal] = useState<{ key: string; ranges: Array<[number, number]> }>({ key: '', ranges: [] })
  const [budget, setBudget] = useState<{ key: string; rows: number }>({ key: '', rows: ROW_BUDGET })
  // Presentation only: the active-row pill glides when picked with the
  // pointer and moves instantly when picked from the keyboard.
  const [indicatorInstant, setIndicatorInstant] = useState(true)
  // Bumped when the panel opens again: the current file and the last commit may have changed meanwhile.
  const [generation, setGeneration] = useState(0)
  const [, setTick] = useState(0)
  const navRef = useRef<HTMLElement>(null)
  const version = useRef(0)
  const generationRef = useRef(0)
  const cacheRef = useRef(new Map<string, Promise<Side>>())
  const statsRef = useRef(new Map<string, ChangeStat>())
  /** List counts that failed to load this generation (not retried until the panel opens again). */
  const failedRef = useRef(new Set<string>())
  /** The latest counts per (path, A, B) regardless of generation, so rows never flash empty while they refresh. */
  const shownStatsRef = useRef(new Map<string, ChangeStat>())
  /** The counts a row showed last, kept while a newly picked A/B pair is computed. */
  const latestRef = useRef(new Map<string, ChangeStat>())
  const defaultsRef = useRef(new Map<string, Spec | ''>())
  const gitMissing = useRef(false)
  const wasOpen = useRef(open)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  const output = outputs.find(item => item.path === selected)
  // A deleted file can't be opened; Show in Finder shows the folder it was in, while that folder exists.
  const deletedFolder = useDeletedOutputFolder(cwd, output, open)

  useEffect(() => {
    version.current++
    cacheRef.current.clear(); statsRef.current.clear(); failedRef.current.clear(); shownStatsRef.current.clear(); latestRef.current.clear(); defaultsRef.current.clear(); gitMissing.current = false
    setSelected(''); setASpec(''); setAReady(false); setBSpec('current'); setSides(null); setError(''); setActionError(''); setLoading(false); setHeadOk({})
  }, [sessionId, cwd])
  useEffect(() => {
    if (open && !wasOpen.current) { generationRef.current++; setGeneration(generationRef.current) }
    wasOpen.current = open
  }, [open])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const sideKey = (item: SessionOutput, spec: Spec) => spec === 'current' ? `current#${generationRef.current}#${item.updatedAt}` : spec === 'head' ? `head#${generationRef.current}` : spec
  const statKey = (item: SessionOutput, a: Spec, b: Spec) => `${item.path}\0${sideKey(item, a)}\0${sideKey(item, b)}`
  const record = (item: SessionOutput, a: Spec, b: Spec, stat: ChangeStat) => {
    statsRef.current.set(statKey(item, a, b), stat)
    shownStatsRef.current.set(`${item.path}\0${a}\0${b}`, stat)
    setTick(tick => tick + 1)
  }

  /** One side's contents, cached per (path, side); snapshots never change, the current file and the last commit refresh per generation. */
  const read = (item: SessionOutput, spec: Spec): Promise<Side> => {
    if (!cwd) return Promise.reject(new Error('Open a project folder to compare files.'))
    const key = `${item.path}\0${sideKey(item, spec)}`
    const cache = cacheRef.current
    const hit = cache.get(key)
    if (hit) return hit
    const load = (async (): Promise<Side> => {
      if (spec === 'baseline') return item.baseline?.absent ? ABSENT : toSide(await readSessionOutput(cwd, sessionId, item.path, BASELINE_VERSION), item.baseline?.sha256)
      if (spec === 'head') return toSide(await gitHeadFile(cwd, item.path))
      if (spec === 'current') {
        try { return toSide(await readSessionOutput(cwd, sessionId, item.path)) }
        catch (failure) { if (isMissingFile(failure)) return ABSENT; throw failure }
      }
      const id = spec.slice(2)
      return toSide(await readSessionOutput(cwd, sessionId, item.path, id), item.versions?.find(entry => entry.id === id)?.sha256)
    })()
    cache.set(key, load)
    load.catch(() => { if (cache.get(key) === load) cache.delete(key) })
    if (cache.size > CACHE_LIMIT) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest) }
    return load
  }

  /** Whether the last commit can be read for this file (not a git repository: never asked again). */
  const probeHead = async (item: SessionOutput) => {
    if (gitMissing.current || !cwd) return false
    try {
      await read(item, 'head')
      setHeadOk(previous => previous[item.path] ? previous : { ...previous, [item.path]: true })
      return true
    } catch (failure) {
      if (/git repository/i.test(String(failure))) gitMissing.current = true
      return false
    }
  }

  /** A's default: the copy from before the session, else the last commit, else v1 ('' when there is nothing to compare with). */
  const resolveDefault = async (item: SessionOutput): Promise<Spec | ''> => {
    const known = defaultsRef.current.get(item.path)
    const saved = savedVersions(item)
    if (known !== undefined && canRead(known, item) && (known || !saved.length)) return known
    let spec: Spec | '' = ''
    if (item.baseline && !item.baseline.notKept) spec = 'baseline'
    else if (await probeHead(item)) spec = 'head'
    else if (saved.length) spec = `v:${saved[0].id}`
    defaultsRef.current.set(item.path, spec)
    return spec
  }

  // Counts for the list, computed lazily one file at a time while the panel is open.
  useEffect(() => {
    if (!open || !cwd || !sorted.length) return
    let cancelled = false
    void (async () => {
      for (const item of sorted) {
        if (cancelled) return
        const a = await resolveDefault(item)
        if (cancelled) return
        const key = a && statKey(item, a, 'current')
        if (!a || !key || statsRef.current.has(key) || failedRef.current.has(key)) continue
        try {
          const [left, right] = await Promise.all([read(item, a), read(item, 'current')])
          if (cancelled) return
          record(item, a, 'current', compareSides(left, right))
        } catch { failedRef.current.add(key) /* the row shows no counts; selecting it shows the error */ }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })()
    return () => { cancelled = true }
  }, [open, cwd, sessionId, sorted, generation])

  const select = async (item: SessionOutput) => {
    if (item.path === selected && !error) return
    const revision = ++version.current
    setSelected(item.path); setASpec(''); setAReady(false); setBSpec('current'); setSides(null); setError(''); setActionError('')
    const spec = await resolveDefault(item)
    if (version.current !== revision) return
    setASpec(spec); setAReady(true)
    // "Last commit" is offered whenever it can be read, even when A defaults to the baseline.
    if (spec !== 'head') void probeHead(item)
  }

  // A version picked earlier may have been dropped since: each side goes back to what it starts on.
  useEffect(() => {
    if (!output) return
    if (!canRead(bSpec, output)) setBSpec('current')
    if (canRead(aSpec, output)) return
    const revision = version.current
    void resolveDefault(output).then(spec => { if (version.current === revision) setASpec(spec) })
  }, [output?.versions, aSpec, bSpec])

  // Load both sides of the selected comparison.
  useEffect(() => {
    if (!output || !aReady) return
    if (!aSpec) { setSides(null); setLoading(false); return }
    const revision = ++version.current
    const a = aSpec, b = bSpec
    if (!canRead(a, output) || !canRead(b, output)) return
    setLoading(true); setError('')
    // A failure names the side that could not be read, never with a raw OS error.
    const side = (spec: Spec) => read(output, spec).catch(failure => { throw outputErrorMessage(failure, spec === 'current' ? 'current' : spec === 'head' ? 'head' : 'saved') })
    Promise.all([side(a), side(b)]).then(([left, right]) => {
      if (version.current !== revision) return
      setSides({ key: statKey(output, a, b), path: output.path, a: left, b: right, aSpec: a, bSpec: b })
    }, failure => {
      if (version.current !== revision) return
      setSides(null); setError(String(failure))
    }).finally(() => { if (version.current === revision) setLoading(false) })
  }, [selected, aSpec, bSpec, aReady, generation, output?.updatedAt, cwd, sessionId])

  const diff = useMemo(() => sides && !isBinary(sides.a, sides.b) ? lineDiff(sides.a.content, sides.b.content) : null, [sides])
  useEffect(() => {
    if (!sides) return
    const item = outputs.find(entry => entry.path === sides.path)
    if (item) record(item, sides.aSpec, sides.bSpec, compareSides(sides.a, sides.b, diff ?? undefined))
  }, [sides, diff])

  const setMode = (next: DiffMode, pointer: boolean) => {
    setModePointer(pointer); setModeState(next)
    try { localStorage.setItem(MODE_KEY, next) } catch { /* the mode is a convenience */ }
  }
  const act = async (run: () => Promise<void>, subject?: OutputErrorSubject) => {
    setActionError('')
    try { await run() } catch (failure) { setActionError(subject ? outputErrorMessage(failure, subject) : String(failure)) }
  }
  const copyPath = () => act(async () => {
    if (!output) return
    await copyToClipboard(output.path)
    setCopied(true); clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1500)
  })

  // Arrow keys move through the list (from the list or the view itself); Escape belongs to SidePanel.
  const listKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.metaKey || event.altKey || event.ctrlKey) return
    const nav = navRef.current
    const target = event.target as Node
    if (!nav || !(nav.contains(target) || target === event.currentTarget)) return
    event.preventDefault()
    const index = sorted.findIndex(item => item.path === selected)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sorted.length - 1 : event.key === 'ArrowDown' ? Math.min(sorted.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1)
    const item = sorted[next]
    if (!item) return
    setIndicatorInstant(true)
    nav.querySelectorAll<HTMLButtonElement>('button[data-path]')[next]?.focus()
    void select(item)
  }

  const statFor = (item: SessionOutput) => {
    const chosen = item.path === selected && aSpec
    const a = chosen || defaultsRef.current.get(item.path)
    const b = chosen ? bSpec : 'current'
    const stat = a ? shownStatsRef.current.get(`${item.path}\0${a}\0${b}`) : undefined
    if (stat) latestRef.current.set(item.path, stat)
    return stat ?? latestRef.current.get(item.path)
  }
  const stats = sorted.map(statFor)
  const totals = stats.reduce((sum, stat) => stat && !stat.binary ? { added: sum.added + stat.added, removed: sum.removed + stat.removed, known: sum.known + 1 } : stat ? { ...sum, known: sum.known + 1 } : sum, { added: 0, removed: 0, known: 0 })

  const revealed = sides && reveal.key === sides.key ? reveal.ranges : NO_RANGES
  const rows = sides && budget.key === sides.key ? budget.rows : ROW_BUDGET
  const truncated = !!sides && (sides.a.truncated || sides.b.truncated)
  const actionsDisabled = !output || !cwd
  // A deleted file can no longer be opened; Show in Finder shows its folder while that exists.
  const fileActionsDisabled = actionsDisabled || !!output?.deleted
  const revealDisabled = actionsDisabled || (!!output?.deleted && !deletedFolder)

  let body: ReactNode
  let state = 'diff'
  if (error) { state = 'error'; body = <p role="alert">{error}</p> }
  else if (!output) { state = 'empty'; body = <div className="gc-output-hint"><p>Select a file to see its changes.</p><small>Pick A and B to compare any two copies: before this session, the last commit, a saved version or the current file. Arrow keys move through the list.</small></div> }
  else if (aReady && !aSpec) { state = 'empty'; body = output.deleted
    ? <div className="gc-output-hint"><p>This file was deleted.</p><small>No copy from before the session was saved, so its earlier contents can't be shown.</small></div>
    : output.baseline?.notKept || output.versions?.some(entry => entry.notKept)
      ? <div className="gc-output-hint"><p>Nothing can be compared.</p><small>This file holds a known API key or token, so G-Code keeps no copies of it. This does not mean it is unchanged.</small></div>
      : <div className="gc-output-hint"><p>Nothing to compare yet.</p><small>This file has no copy from before the session and no saved versions.</small></div> }
  else if (!sides) { state = 'loading'; body = <p className="gc-changes-loading gc-shimmer-text">Loading changes…</p> }
  else if (sides.a.imageDataUrl || sides.b.imageDataUrl) { state = 'image'; body = <ImageCompare a={sides.a} b={sides.b} aLabel={specLabel(sides.aSpec, output)} bLabel={specLabel(sides.bSpec, output)}/> }
  else if (isBinary(sides.a, sides.b)) { state = 'empty'; body = <div className="gc-output-hint"><p>{binaryMessage(sides.a, sides.b)}</p><small>{specLabel(sides.aSpec, output)} → {specLabel(sides.bSpec, output)}</small></div> }
  else if (sides.a.absent && sides.b.absent) { state = 'empty'; body = output.deleted && sides.aSpec === 'baseline' && sides.bSpec === 'current'
    ? <div className="gc-output-hint"><p>Created and deleted during this session.</p><small>It did not exist before the session and is gone now.{output.versions?.length ? ' Pick a saved version as B to see what it held.' : ''}</small></div>
    : <div className="gc-output-hint"><p>The file is absent in both.</p><small>It does not exist in {specLabel(sides.aSpec, output)} or in {specLabel(sides.bSpec, output)}.</small></div> }
  else if (diff && !diff.added && !diff.removed) { state = 'empty'; body = <div className="gc-output-hint"><p>No differences.</p><small>{specLabel(sides.aSpec, output)} and {specLabel(sides.bSpec, output)} are identical{truncated ? ' in the first 256 KB' : ''}.</small></div> }
  else if (diff) body = <DiffView diff={diff} mode={mode} revealed={revealed}
    onReveal={range => setReveal(previous => ({ key: sides.key, ranges: [...(previous.key === sides.key ? previous.ranges : []), range] }))}
    rowBudget={rows} onMore={() => setBudget({ key: sides.key, rows: rows + ROW_BUDGET })}/>

  const notes: ReactNode[] = []
  if (output?.deleted && aSpec) notes.push(<p key="deleted" className="gc-changes-note">This file was deleted during this session.</p>)
  if (output && !output.baseline && aReady) notes.push(<p key="baseline" className="gc-changes-note">{aSpec ? `No copy from before the first change; comparing with ${aSpec === 'head' ? 'the last commit' : specLabel(aSpec, output)}` : 'No copy from before the first change.'}</p>)
  const missing = output ? missingCopiesNote(output) : ''
  if (missing) notes.push(<p key="not-kept" className="gc-changes-note" data-tone="warning"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>{missing}{output?.baseline?.notKept && aSpec ? ` Comparing with ${aSpec === 'head' ? 'the last commit' : specLabel(aSpec, output)}.` : ''}</p>)
  const dropped = output ? droppedVersionsNote(output) : ''
  if (dropped) notes.push(<p key="dropped" className="gc-changes-note">{dropped}</p>)
  if (output?.shared) notes.push(<p key="shared" className="gc-changes-note">Another session's command ran in this project when this change was made, so it may be theirs.</p>)
  if (output?.snapshotError) notes.push(<p key="snapshot" className="gc-changes-note" data-tone="warning"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>{output.snapshotError}</p>)
  if (truncated && diff) notes.push(<p key="truncated" className="gc-changes-note" data-tone="warning"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>Preview limited to 256 KB; changes past that point are not shown.</p>)
  if (diff?.approximate) notes.push(<p key="approximate" className="gc-changes-note">Too many changes to align line by line; the changed region is shown as one replacement.</p>)
  if (actionError) notes.push(<p key="action" className="gc-changes-note" data-tone="error" role="alert">{actionError}</p>)

  return <section className="gc-side-view gc-changes" hidden={!open} tabIndex={-1} aria-labelledby="changes-title" onKeyDown={listKey}>
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="changes-title" className="gc-side-title"><FileDiff size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Changes</span>
        {!!outputs.length && <span className="gc-outputs-count">{outputs.length} {outputs.length === 1 ? 'file' : 'files'}</span>}
        {totals.known > 0 && <span className="gc-changes-totals" aria-label={`${totals.added} lines added, ${totals.removed} removed`}><span className="gc-changes-add">+{totals.added.toLocaleString()}</span><span className="gc-changes-del">−{totals.removed.toLocaleString()}</span></span>}
      </h2>
      {!!outputs.length && <>
        <Tooltip content="Open"><button type="button" className="gc-side-icon" aria-label="Open file" aria-disabled={fileActionsDisabled} onClick={() => { if (!fileActionsDisabled) void act(() => openPath(cwd!, output!.path), 'open') }}><SquareArrowOutUpRight size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
        <Tooltip content={output?.deleted && deletedFolder ? 'Show folder in Finder' : 'Show in Finder'}><button type="button" className="gc-side-icon" aria-label="Show in Finder" aria-disabled={revealDisabled} onClick={() => { if (!revealDisabled) void (output!.deleted ? act(() => revealPath(cwd!, deletedFolder), 'folder') : act(() => revealPath(cwd!, output!.path), 'reveal')) }}><FolderOpen size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
        <Tooltip content={copied ? 'Copied' : 'Copy path'}><button type="button" className="gc-side-icon" aria-label="Copy path" aria-disabled={!output} onClick={() => { if (output) void copyPath() }}>{copied ? <Check size={15} strokeWidth={ICON_STROKE}/> : <Copy size={15} strokeWidth={ICON_STROKE}/>}</button></Tooltip>
      </>}
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" aria-label="Close changes" onClick={(event) => onClose(event.detail > 0)}><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    {!outputs.length ? <div className="gc-outputs-empty"><span className="gc-modal-icon gc-outputs-empty-icon" aria-hidden="true"><FileDiff size={18} strokeWidth={ICON_STROKE}/></span><strong>No changes yet.</strong><small>Files created or changed during this session appear here. Compare each one with its copy from before the session, the last commit or any saved version.</small></div> : <div className="gc-outputs-content gc-changes-content">
      <nav ref={navRef} aria-label="Changed files" onPointerDown={() => setIndicatorInstant(false)}>{sorted.map((item, index) => {
        const stat = stats[index]
        const status = rowStatus(item, stat, item.path === selected && aSpec ? bSpec : 'current')
        const Icon = STATUS_ICONS[status ?? 'unchanged']
        const active = selected === item.path
        return <button type="button" className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} tabIndex={active || (!selected && index === 0) ? 0 : -1} data-path={item.path} onClick={() => void select(item)} key={item.path} title={item.path}>
          {active && <motion.span className="gc-output-indicator" aria-hidden="true" layoutId="gc-changes-indicator" layoutDependency={selected} transformTemplate={flatProjection} initial={false} style={{ borderRadius: 10 }} transition={indicatorInstant ? { duration: 0 } : springIndicator}/>}
          <Icon size={16} strokeWidth={ICON_STROKE} data-status={status}/>
          <span><strong>{fileName(item.path)}</strong><small>{status && <span className="gc-changes-status" data-status={status}>{STATUS_LABELS[status]}</span>}<span className="gc-output-directory">{directory(item.path, cwd)}</span></small></span>
          <span className="gc-changes-row-stat">{stat ? stat.binary ? <span className="gc-changes-binary">Binary</span> : <><span className="gc-changes-add">+{stat.added.toLocaleString()}</span><span className="gc-changes-del">−{stat.removed.toLocaleString()}</span></> : null}</span>
        </button>
      })}</nav>
      <div className="gc-output-detail gc-changes-detail" aria-busy={loading || undefined}>
        {output && <div className="gc-output-version gc-changes-toolbar">
          <div className="gc-changes-pickers">
          <label><span className="gc-changes-side">A</span><span className="gc-output-select"><select aria-label="Compare from (A)" value={aSpec} disabled={!aSpec} onChange={event => setASpec(event.target.value as Spec)}>
            {!aSpec && <option value="">{aReady ? 'No earlier copy' : 'Loading…'}</option>}
            {output.baseline && <option value="baseline" disabled={!!output.baseline.notKept}>Before this session{output.baseline.notKept ? ' · not kept: held a key' : ''}</option>}
            {headOk[output.path] && <option value="head">Last commit</option>}
            {output.versions?.map((entry, index) => versionOption(output, entry, index))}
          </select><ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/></span></label>
          <ArrowRight className="gc-changes-arrow" size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>
          <label><span className="gc-changes-side">B</span><span className="gc-output-select"><select aria-label="Compare to (B)" value={bSpec} onChange={event => setBSpec(event.target.value as Spec)}>
            <option value="current">{output.deleted ? 'Current file (deleted)' : 'Current file'}</option>
            {output.versions?.map((entry, index) => versionOption(output, entry, index))}
          </select><ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/></span></label>
          </div>
          <div className="gc-segmented gc-changes-mode" role="group" aria-label="Diff layout">
            {(['unified', 'split'] as const).map(item => <button key={item} type="button" className="gc-segmented-item" aria-pressed={mode === item} onClick={event => setMode(item, event.detail > 0)}>
              {mode === item && <motion.span layoutId="gc-changes-mode-thumb" transformTemplate={flatProjection} className="gc-segmented-thumb" transition={modePointer ? springIndicator : { duration: 0 }} aria-hidden="true"/>}
              <span className="gc-segmented-label">{item === 'unified' ? 'Unified' : 'Split'}</span>
            </button>)}
          </div>
        </div>}
        {!!notes.length && <div className="gc-changes-notes">{notes}</div>}
        <div className="gc-changes-body" data-state={state} role={state === 'diff' ? 'region' : undefined} aria-label={state === 'diff' && output ? `Changes in ${fileName(output.path)}` : undefined} tabIndex={state === 'diff' ? 0 : undefined}>{body}</div>
      </div>
    </div>}
  </section>
}

const NO_RANGES: Array<[number, number]> = []

export function binaryMessage(a: Side, b: Side): string {
  if (a.absent) return `Binary file added (${bytes(b.bytes)})`
  if (b.absent) return `Binary file deleted (${bytes(a.bytes)})`
  if (a.sha && a.sha === b.sha) return `Binary file unchanged (${bytes(b.bytes)})`
  return `Binary file changed (${a.bytes.toLocaleString()} → ${bytes(b.bytes)})`
}

function ImageCompare({ a, b, aLabel, bLabel }: { a: Side; b: Side; aLabel: string; bLabel: string }) {
  const pane = (side: Side, label: string, tag: 'A' | 'B') => <figure className="gc-changes-image">
    <figcaption><span className="gc-changes-side">{tag}</span><span>{label}</span><small>{side.absent ? 'Not present' : bytes(side.bytes)}</small></figcaption>
    <div className="gc-changes-image-well">{side.imageDataUrl ? <img src={side.imageDataUrl} alt={`${tag}: ${label}`} className="gc-output-image"/> : <span>{side.absent ? 'Not present' : 'No preview'}</span>}</div>
  </figure>
  return <div className="gc-changes-images">{pane(a, aLabel, 'A')}{pane(b, bLabel, 'B')}</div>
}

// ---------------------------------------------------------------------------
// The diff itself: unified or side by side, with collapsible unchanged runs.
// ---------------------------------------------------------------------------

const SIGNS = { add: '+', del: '−', context: '' } as const

function Code({ line }: { line?: DiffLine }) {
  if (!line) return null
  return <>
    {line.parts ? line.parts.map((part, index) => part.changed ? <mark key={index} className="gc-diff-word">{part.text}</mark> : <span key={index}>{part.text}</span>) : line.text}
    {line.noEol && line.kind !== 'context' && <span className="gc-diff-noeol">No newline at end of file</span>}
  </>
}

function UnifiedRow({ line }: { line: DiffLine }) {
  return <div className="gc-diff-row" data-kind={line.kind}>
    <span className="gc-diff-ln" aria-hidden="true">{line.kind === 'add' ? '' : line.oldNo}</span>
    <span className="gc-diff-ln" aria-hidden="true">{line.kind === 'del' ? '' : line.newNo}</span>
    <span className="gc-diff-sign">{SIGNS[line.kind]}</span>
    <span className="gc-diff-code"><Code line={line}/></span>
  </div>
}

function SplitHalf({ line, side }: { line?: DiffLine; side: 'left' | 'right' }) {
  const number = line && (side === 'left' ? line.oldNo : line.newNo)
  return <div className="gc-diff-half" data-kind={line?.kind ?? 'none'}>
    <span className="gc-diff-ln" aria-hidden="true">{number}</span>
    <span className="gc-diff-sign">{line ? SIGNS[line.kind] : ''}</span>
    <span className="gc-diff-code"><Code line={line}/></span>
  </div>
}

function SplitRowView({ row }: { row: SplitRow }) {
  return <div className="gc-diff-row is-split"><SplitHalf line={row.left} side="left"/><SplitHalf line={row.right} side="right"/></div>
}

function GapRow({ gap, next, onReveal }: { gap: GapSegment; next?: Segment; onReveal?: (range: [number, number]) => void }) {
  const count = gap.end - gap.start
  const stepwise = count > EXPAND_STEP
  return <div className="gc-diff-gap" data-position={gap.position}>
    {stepwise && gap.position !== 'end' && <Tooltip content={`Show ${EXPAND_STEP} more lines above`}><button type="button" className="gc-diff-gap-step" aria-label={`Expand up ${EXPAND_STEP} lines`} onClick={() => onReveal?.(expandGap(gap, 'up', EXPAND_STEP))}><ChevronUp size={14} strokeWidth={ICON_STROKE}/></button></Tooltip>}
    {stepwise && gap.position !== 'start' && <Tooltip content={`Show ${EXPAND_STEP} more lines below`}><button type="button" className="gc-diff-gap-step" aria-label={`Expand down ${EXPAND_STEP} lines`} onClick={() => onReveal?.(expandGap(gap, 'down', EXPAND_STEP))}><ChevronDown size={14} strokeWidth={ICON_STROKE}/></button></Tooltip>}
    <button type="button" className="gc-diff-gap-all" onClick={() => onReveal?.(expandGap(gap, 'all'))}><UnfoldVertical size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>{stepwise ? 'Show all ' : 'Show '}{count.toLocaleString()} unchanged {count === 1 ? 'line' : 'lines'}</button>
    {next?.type === 'hunk' && <span className="gc-diff-gap-header" aria-hidden="true">{next.header}</span>}
  </div>
}

/** Renders a line diff as hunks with 3 lines of context; collapsed regions expand in place. At most `rowBudget` rows render before a "Show more" button. */
export function DiffView({ diff, mode, revealed = NO_RANGES, onReveal, rowBudget = ROW_BUDGET, onMore }: { diff: LineDiff; mode: DiffMode; revealed?: ReadonlyArray<readonly [number, number]>; onReveal?: (range: [number, number]) => void; rowBudget?: number; onMore?: () => void }) {
  const parts = useMemo(() => segments(diff.lines, 3, revealed), [diff, revealed])
  const digits = lineNumberDigits(diff.lines)
  const rendered: ReactNode[] = []
  let used = 0, hidden = 0
  parts.forEach((segment, index) => {
    if (segment.type === 'gap') {
      if (used < rowBudget) { rendered.push(<GapRow key={`gap:${segment.start}`} gap={segment} next={parts[index + 1]} onReveal={onReveal}/>); used++ }
      return
    }
    if (mode === 'unified') {
      const end = Math.min(segment.end, segment.start + Math.max(0, rowBudget - used))
      for (let line = segment.start; line < end; line++) rendered.push(<UnifiedRow key={`l:${line}`} line={diff.lines[line]}/>)
      used += end - segment.start; hidden += segment.end - end
      return
    }
    const rows = splitRows(diff.lines, segment.start, segment.end)
    const shown = rows.slice(0, Math.max(0, rowBudget - used))
    shown.forEach((row, offset) => rendered.push(<SplitRowView key={`s:${segment.start}:${offset}`} row={row}/>))
    used += shown.length; hidden += rows.length - shown.length
  })
  return <div className="gc-diff" data-mode={mode} style={{ '--gc-ln-ch': digits } as CSSProperties}>
    {rendered}
    {hidden > 0 && <div className="gc-diff-more"><button type="button" className="gc-code-expand" onClick={onMore}>Show {hidden.toLocaleString()} more {hidden === 1 ? 'line' : 'lines'}</button></div>}
  </div>
}
