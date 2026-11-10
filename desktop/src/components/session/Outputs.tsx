import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown, FileCode2, FileMinus2, FolderOutput, PanelRightClose, TriangleAlert } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { flatProjection, springIndicator } from '@/lib/motion'
import { BASELINE_VERSION, closeBrowserTrace, listDirectory, openBrowserTrace, openPath, readSessionOutput, revealPath } from '@/lib/tauri'
import { KEPT_VERSIONS, type SessionOutput } from '../../../../src/shared/sessionControls'

const ICON_STROKE = 1.75

/** A file or folder that is not there (ENOENT, or ENOTDIR for a path through a file; /usr/bin/open says "does not exist"). */
const MISSING = /No such file|does not exist|os error (?:2|20)\b/i
const DENIED = /Permission denied|Operation not permitted|os error (?:1|13)\b/i
/** /usr/bin/open finds no app for the file (kLSApplicationNotFoundErr). */
const NO_APP = /No application knows how to open|kLSApplicationNotFoundErr|-10814\b/i
/** What failed, for the message: the working file, a saved copy, the last commit, Open / Show in Finder, or showing a deleted file's folder. */
export type OutputErrorSubject = 'current' | 'saved' | 'head' | 'open' | 'reveal' | 'folder'
/** Open, Show in Finder and showing the folder run /usr/bin/open, whose errors are never shown as they are. */
const ACTIONS: ReadonlySet<OutputErrorSubject> = new Set(['open', 'reveal', 'folder'])
/** What G-Code itself says before it runs /usr/bin/open (workbench.rs, storage.rs): shown as they are. */
const OWN_ACTION_MESSAGES = /^(?:This file would run as a program\.|Only files and folders can be opened\.|That path is outside the project folder|Select an existing project folder|Project path must be a directory)/

const errorText = (failure: unknown) => String(failure instanceof Error ? failure.message : failure ?? '').replace(/^Error:\s*/, '').trim()

/** A failure as the Outputs and Changes views show it: never a raw OS or /usr/bin/open error. Messages G-Code wrote itself pass through. */
export function outputErrorMessage(failure: unknown, subject: OutputErrorSubject): string {
  const text = errorText(failure)
  const os = /os error \d+/i.test(text)
  if (subject === 'head' && os) return 'The last commit can’t be read.'
  if (MISSING.test(text)) return subject === 'saved' ? 'This saved copy is missing from the project’s .gcode folder.' : subject === 'folder' ? 'The folder it was in no longer exists.' : 'The file is no longer at this path.'
  if (DENIED.test(text)) return subject === 'current' || subject === 'saved' ? 'G-Code doesn’t have permission to read this file.' : 'G-Code doesn’t have permission to open this file.'
  if (subject === 'open' && NO_APP.test(text)) return 'No app on this Mac is set to open this kind of file. Use Show in Finder to choose one.'
  if (os || !text || (ACTIONS.has(subject) && !OWN_ACTION_MESSAGES.test(text))) return { current: 'The file can’t be read.', saved: 'The saved copy can’t be read.', head: 'The last commit can’t be read.', open: 'The file can’t be opened.', reveal: 'Finder can’t show this file.', folder: 'Finder can’t show the folder it was in.' }[subject]
  return text
}

/** The raw error behind a friendly message, for a title tooltip ('' when the message is the error itself). */
export function outputErrorDetail(failure: unknown, subject: OutputErrorSubject): string {
  const text = errorText(failure)
  return text && text !== outputErrorMessage(failure, subject) ? text : ''
}

/** A failure the Outputs view shows: the friendly message, and the raw error for its tooltip. */
interface ShownError { message: string; detail: string }
const NO_ERROR: ShownError = { message: '', detail: '' }
const shownError = (failure: unknown, subject: OutputErrorSubject): ShownError => ({ message: outputErrorMessage(failure, subject), detail: outputErrorDetail(failure, subject) })

/** Whether the copy from before the session holds bytes (a snapshot, not "absent"). */
const hasBaselineCopy = (output: SessionOutput) => !!output.baseline && !output.baseline.absent && !output.baseline.notKept
/** The versions whose bytes were saved: one that held a known key is listed, but has none. */
export const savedVersions = (output: SessionOutput) => (output.versions ?? []).filter(version => !version.notKept)
/** A version's number: dropped versions keep their numbers, so v21 stays v21. */
export const versionNumber = (output: SessionOutput, index: number) => index + 1 + (output.droppedVersions?.count ?? 0)
const NOT_KEPT_LABEL = 'not kept: held a key'
/** What the record says about copies that cannot be read ('' when every copy can). */
export function missingCopiesNote(output: SessionOutput): string {
  const held = (output.versions ?? []).flatMap((version, index) => version.notKept ? [`v${versionNumber(output, index)}`] : [])
  return [
    output.baseline?.notKept ? 'The copy from before this session was not kept: the file held a known API key or token.' : '',
    held.length ? `${held.join(', ')} ${held.length === 1 ? 'was' : 'were'} not kept: the file held a known API key or token, so G-Code saved no copy.` : '',
  ].filter(Boolean).join(' ')
}
/** Which versions were dropped and why ('' when none were). */
export function droppedVersionsNote(output: SessionOutput): string {
  const dropped = output.droppedVersions
  if (!dropped) return ''
  const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${dropped.count === 1 ? 'v1 is' : `v1 to v${dropped.count} are`} no longer kept (saved ${dropped.oldestAt === dropped.newestAt ? when(dropped.oldestAt) : `${when(dropped.oldestAt)} to ${when(dropped.newestAt)}`}): G-Code keeps the copy from before the session and the last ${KEPT_VERSIONS} versions of each file.`
}
/** The copy a deleted output previews: its last saved version, else the copy from before the session ('' when neither was saved). */
export function deletedPreviewVersion(output: SessionOutput): string {
  return savedVersions(output).at(-1)?.id ?? (hasBaselineCopy(output) ? BASELINE_VERSION : '')
}
/** The version an output opens on: a deleted file's last saved copy; otherwise the latest version, or the working file when the last snapshot failed. */
export const defaultOutputVersion = (output: SessionOutput) => output.deleted ? deletedPreviewVersion(output) : output.snapshotError || output.versions?.at(-1)?.notKept ? '' : output.versions?.at(-1)?.id ?? ''
/** Whether the version picker still offers this saved copy ('' is the working file, always offered). */
const offersVersion = (output: SessionOutput, id: string) => !id || (id === BASELINE_VERSION ? !!output.deleted && hasBaselineCopy(output) : savedVersions(output).some(version => version.id === id))
/** What the selected output's preview depends on besides its path: deleted or restored, and the saved copies. */
const outputShape = (output: SessionOutput | undefined) => output ? `${output.deleted ? 'deleted' : 'present'}\0${hasBaselineCopy(output) ? 'baseline' : ''}\0${(output.versions ?? []).map(version => version.id).join(',')}` : ''

/** The folder a file is (or was) in; the project root for a bare name. */
export function outputFolder(path: string, cwd: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : cwd
}

/** For a deleted output: the folder it was in, while that folder still exists ('' otherwise, or while checking). */
export function useDeletedOutputFolder(cwd: string | undefined, output: SessionOutput | undefined, open = true): string {
  const [found, setFound] = useState<{ key: string; folder: string }>({ key: '', folder: '' })
  const folder = cwd && output?.deleted ? outputFolder(output.path, cwd) : ''
  const key = folder && `${cwd}\0${folder}`
  useEffect(() => {
    if (!cwd || !folder || !open) return
    let cancelled = false
    listDirectory(cwd, folder === cwd ? undefined : folder).then(
      () => { if (!cancelled) setFound({ key, folder }) },
      () => { if (!cancelled) setFound({ key, folder: '' }) },
    )
    return () => { cancelled = true }
  }, [cwd, folder, open])
  return key && found.key === key ? found.folder : ''
}

/** The side panel's Outputs view (mounted while hidden, so the selection survives). onClose(slide): closed with the pointer. */
export function Outputs({ open, onClose, outputs, cwd, sessionId }: { open: boolean; onClose: (slide?: boolean) => void; outputs: SessionOutput[]; cwd?: string; sessionId: string }) {
  const [selected, setSelected] = useState('')
  const [versionId, setVersionId] = useState('')
  const [image, setImage] = useState('')
  const [preview, setPreview] = useState('')
  const [error, setError] = useState<ShownError>(NO_ERROR)
  const [loading, setLoading] = useState(false)
  const [traceBusy, setTraceBusy] = useState(false)
  // Open / Show in Finder failures (e.g. a file that would run as a program):
  // shown above the preview, which stays as it was.
  const [actionError, setActionError] = useState<ShownError>(NO_ERROR)
  // Presentation only: the active-row pill glides when picked with the
  // pointer and moves instantly when picked from the keyboard.
  const [indicatorInstant, setIndicatorInstant] = useState(true)
  const version = useRef(0)
  const output = outputs.find(output => output.path === selected)
  // A deleted file can't be opened; Show in Finder shows the folder it was in, while that folder exists.
  const deletedFolder = useDeletedOutputFolder(cwd, output, open)
  useEffect(() => { version.current++; setSelected(''); setVersionId(''); setPreview(''); setImage(''); setError(NO_ERROR); setActionError(NO_ERROR); setLoading(false) }, [sessionId, cwd])
  const select = async (output: SessionOutput, id = defaultOutputVersion(output)) => {
    const revision = ++version.current
    setSelected(output.path); setVersionId(id); setPreview(''); setImage(''); setError(NO_ERROR); setActionError(NO_ERROR)
    // The working copy of a deleted file is gone: the preview says so instead of reading it.
    if (output.deleted && !id) { setLoading(false); return }
    setLoading(true)
    try {
      if (!cwd) return
      const file = await readSessionOutput(cwd, sessionId, output.path, id || undefined)
      if (version.current !== revision) return
      setImage(file.imageDataUrl ?? '')
      setPreview(file.binary ? `Binary file · ${file.bytes.toLocaleString()} bytes\n${output.path}` : file.content + (file.truncated ? '\n\n[Preview limited to 256 KB]' : ''))
    } catch (failure) { if (version.current === revision) setError(shownError(failure, id ? 'saved' : 'current')) }
    finally { if (version.current === revision) setLoading(false) }
  }
  // The selected output was deleted, restored or got another saved copy while selected. A saved
  // copy still offered stays on screen; the working file, or a copy no longer offered, is picked
  // again: after a delete or restore as a click picks it, otherwise the working file is read again.
  const shape = outputShape(output)
  const shown = useRef({ path: '', shape: '' })
  useEffect(() => {
    const last = shown.current
    shown.current = { path: selected, shape }
    if (!output || last.path !== selected || last.shape === shape) return
    if (versionId && offersVersion(output, versionId)) return
    const deletedChanged = last.shape.startsWith('deleted') !== !!output.deleted
    if (deletedChanged || versionId) void select(output)
    else if (!output.deleted) void select(output, '')
  }, [selected, shape])
  const openTrace = async () => {
    if (!cwd || !output) return
    setTraceBusy(true); setError(NO_ERROR)
    try { await openBrowserTrace(cwd, sessionId, output.path, versionId || undefined) }
    catch (failure) { setError(shownError(failure, versionId ? 'saved' : 'current')) }
    finally { setTraceBusy(false) }
  }
  // The working file in its default app, or selected in Finder.
  const act = async (action: typeof openPath, path: string, subject: OutputErrorSubject) => {
    if (!cwd) return
    setActionError(NO_ERROR)
    try { await action(cwd, path) }
    catch (failure) { setActionError(shownError(failure, subject)) }
  }
  const deletedCurrent = !!output?.deleted && !versionId
  // A deleted working file says so even while an earlier preview of it is still in state.
  const previewState = error.message ? 'error' : deletedCurrent ? 'deleted' : image ? 'image' : loading ? 'loading' : preview ? 'text' : 'empty'
  return <section className="gc-side-view gc-outputs" hidden={!open} tabIndex={-1} aria-labelledby="outputs-title">
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="outputs-title" className="gc-side-title"><FolderOutput size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Outputs</span>{!!outputs.length && <span className="gc-outputs-count">{outputs.length} {outputs.length === 1 ? 'file' : 'files'}</span>}</h2>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" aria-label="Close outputs" onClick={(event) => onClose(event.detail > 0)}><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>
    {!outputs.length ? <div className="gc-outputs-empty"><span className="gc-modal-icon gc-outputs-empty-icon" aria-hidden="true"><FolderOutput size={18} strokeWidth={ICON_STROKE}/></span><strong>No tracked outputs yet.</strong><small>Files created or changed during this session appear here, with a saved version for each change. Earlier outputs may only have a current file.</small></div> : <div className="gc-outputs-content">
      <nav aria-label="Output files" onPointerDown={() => setIndicatorInstant(false)} onKeyDown={() => setIndicatorInstant(true)}>{[...outputs].sort((a,b) => b.updatedAt - a.updatedAt).map(output => {
        const Icon = output.deleted ? FileMinus2 : FileCode2
        return <button type="button" className={selected === output.path ? 'active' : ''} onClick={(event) => { if (event.detail < 2) void select(output) }} onDoubleClick={() => { if (!output.deleted) void act(openPath, output.path, 'open') }} key={output.path} title={output.path}>
          {selected === output.path && <motion.span className="gc-output-indicator" aria-hidden="true" layoutId="gc-output-indicator" layoutDependency={selected} transformTemplate={flatProjection} initial={false} style={{ borderRadius: 10 }} transition={indicatorInstant ? { duration: 0 } : springIndicator}/>}
          <Icon size={16} strokeWidth={ICON_STROKE} data-status={output.deleted ? 'deleted' : undefined}/><span><strong>{output.path.split('/').pop()}</strong><span className="gc-output-directory">{(cwd ? output.path.replace(`${cwd}/`, '') : output.path).split('/').slice(0, -1).join('/') || '.'}</span><small>{output.deleted && <span className="gc-output-badge" data-status="deleted">Deleted</span>}{output.tool} · {output.deleted ? '' : `${output.bytes?.toLocaleString() ?? '—'} bytes · `}{savedVersions(output).length} versions</small></span>
        </button>
      })}</nav>
      <div className="gc-output-detail">
        {output && <div className="gc-output-version"><label>Version <span className="gc-output-select"><select aria-label="Output version" value={versionId} onChange={event => void select(output, event.target.value)}><option value="">{output.deleted ? 'Current file (deleted)' : 'Current file'}</option>{output.deleted && hasBaselineCopy(output) && <option value={BASELINE_VERSION}>Before this session</option>}{output.versions?.map((version, index) => <option key={version.id} value={version.id} disabled={!!version.notKept}>v{versionNumber(output, index)} · {new Date(version.createdAt).toLocaleString()}{version.notKept ? ` · ${NOT_KEPT_LABEL}` : ''}</option>)}</select><ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/></span></label>{output.deleted && <small role="status" data-tone="deleted"><FileMinus2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>Deleted during this session.</small>}{output.snapshotError && <small role="status"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>{output.snapshotError}</small>}{[missingCopiesNote(output), droppedVersionsNote(output)].filter(Boolean).map(note => <small key={note} role="status"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>{note}</small>)}<div className="gc-output-actions">{output.path.endsWith('trace.zip') && <><button type="button" className="gc-btn gc-btn-ghost" disabled={traceBusy || deletedCurrent} onClick={() => void openTrace()}>Open trace viewer</button><button type="button" className="gc-btn gc-btn-ghost" onClick={() => void closeBrowserTrace().catch(failure => setError(shownError(failure, 'open')))}>Close viewer</button></>}<button type="button" className="gc-btn gc-btn-ghost" disabled={!cwd || !!output.deleted} onClick={() => void act(openPath, output.path, 'open')}>Open</button><button type="button" className="gc-btn gc-btn-ghost" disabled={!cwd || (!!output.deleted && !deletedFolder)} title={deletedFolder ? 'Shows the folder it was in' : undefined} onClick={() => void (output.deleted ? deletedFolder && act(revealPath, deletedFolder, 'folder') : act(revealPath, output.path, 'reveal'))}>Show in Finder</button></div></div>}
        {output && actionError.message && <p role="alert" className="gc-output-alert" title={actionError.detail || undefined}>{actionError.message}</p>}
        <div className="gc-output-preview" data-state={previewState === 'deleted' ? 'empty' : previewState}>{previewState === 'error' ? <p role="alert" title={error.detail || undefined}>{error.message}</p> : previewState === 'image' ? <img src={image} alt={`Output ${selected.split('/').pop()}`} className="gc-output-image"/> : previewState === 'deleted' ? <div className="gc-output-hint"><p>This file was deleted.</p><small>{output && (savedVersions(output).length || hasBaselineCopy(output)) ? 'Select a saved version to see what it held.' : 'No copy of it was saved, so its contents can’t be shown.'}</small></div> : previewState === 'empty' ? <div className="gc-output-hint"><p>Select an output to preview.</p><small>Saved versions preserve the bytes from each change and are checked before preview. Select Current file to read the working copy. Snapshots support files up to 64 MiB.</small></div> : <pre className={loading ? 'gc-shimmer-text' : undefined}>{loading ? 'Loading preview…' : preview}</pre>}</div>
      </div>
    </div>}
  </section>
}
