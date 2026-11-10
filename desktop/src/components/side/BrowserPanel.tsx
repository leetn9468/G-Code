import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Maximize2, Package, PanelRightClose, RotateCw, Server, Smartphone, Tablet, TriangleAlert, X } from 'lucide-react'
import { open as openInDefaultBrowser } from '@tauri-apps/plugin-shell'
import { Tooltip } from '../shell/Tooltip'
import { flatProjection, springIndicator } from '@/lib/motion'
import { isTauri, listDirectory, previewServe, previewStop, probeUrl } from '@/lib/tauri'
import { BUILD_FOLDERS, EMPTY_HISTORY, canFrame, currentPage, detectDevServers, isLocalAddress, observePage, parseAddress, previewTarget, pushPage, replacePage, seenDevServers, servedUrl, stepPage, type DevServer, type PageHistory } from '@/lib/devServers'
import type { BackgroundShellInfo } from '../../../../src/shared/tasks'
import '@/styles/browser.css'

const ICON_STROKE = 1.75
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads'
/** A page still without its load event after this long gets a "still loading" note. */
const SLOW_MS = 12_000
const STAGE_PAD = 12
const VIEWPORT_KEY = 'gcode.browser.viewport'

type ViewportId = 'fit' | 'tablet' | 'phone'
const VIEWPORTS: ReadonlyArray<{ id: ViewportId; label: string; name: string; width: number; Icon: typeof Maximize2 }> = [
  { id: 'fit', label: 'Fit', name: 'Fit', width: 0, Icon: Maximize2 },
  { id: 'tablet', label: '768', name: 'Tablet 768', width: 768, Icon: Tablet },
  { id: 'phone', label: '390', name: 'Phone 390', width: 390, Icon: Smartphone },
]

/** idle: start screen · refused: the app's CSP will not frame it · blank: loaded nothing (refused by the site, or no server). */
type LoadState = 'idle' | 'loading' | 'slow' | 'ready' | 'blank' | 'refused' | 'unreachable'
interface PageError { message: string; count: number }
interface Build { folder: string; modified?: number | null }
export interface BrowserRequest { url?: string; path?: string; nonce: number }

function storedViewport(): ViewportId {
  try { const value = localStorage.getItem(VIEWPORT_KEY); return value === 'tablet' || value === 'phone' ? value : 'fit' }
  catch { return 'fit' }
}
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)
const originOf = (href: string) => { try { return new URL(href).origin } catch { return '' } }
const isWebAddress = (href?: string) => !!href && /^https?:\/\//i.test(href)
/** localhost:5173, or localhost:5173/app/ when there is a path. */
function shortAddress(href: string) {
  try { const url = new URL(href); return url.host + (url.pathname === '/' ? '' : url.pathname) + url.search }
  catch { return href }
}
function ago(time?: number | null) {
  if (!time) return ''
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : new Date(time).toLocaleDateString()
}

/** The side panel's Browser view: previews the site the agent built (a
 *  build folder served on 127.0.0.1, or a dev server a background command
 *  started). Mounted while hidden, so the page and its history survive. */
export function BrowserPanel({ open, onClose, cwd, tasks, request }: { open: boolean; onClose: (slide?: boolean) => void; cwd?: string; tasks: BackgroundShellInfo[]; request?: BrowserRequest }) {
  // Mounted with an address to show (no effect round trip): it is the first page.
  const [boot] = useState(() => { const address = request?.url ? parseAddress(request.url) : undefined; return address?.kind === 'url' ? address.url : undefined })
  const [history, setHistoryState] = useState<PageHistory>(() => boot ? pushPage(EMPTY_HISTORY, boot) : EMPTY_HISTORY)
  const historyRef = useRef(history)
  const setHistory = (next: PageHistory) => { historyRef.current = next; setHistoryState(next) }
  // What the frame loads. Separate from the history: a page that moves on its
  // own (a link, pushState) must not be reloaded by a changed src.
  const [frame, setFrame] = useState<{ url: string; key: number } | null>(() => boot ? { url: boot, key: 1 } : null)
  const [loadState, setLoadState] = useState<LoadState>(() => boot ? canFrame(boot) ? 'loading' : 'refused' : 'idle')
  const [title, setTitle] = useState('')
  const [errors, setErrors] = useState<PageError[]>([])
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [viewport, setViewportState] = useState<ViewportId>(storedViewport)
  const [thumbGlides, setThumbGlides] = useState(false)
  const [builds, setBuilds] = useState<Build[] | null>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [externalHintDismissed, setExternalHintDismissed] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const errorsRef = useRef<HTMLDivElement>(null)
  /** Bumped by every navigation; a slower one that resolves late is dropped. */
  const navigation = useRef(0)
  /** Bumped by every load; a probe that answers late is ignored. */
  const probes = useRef(0)
  /** The next 'location' report replaces the page shown (a redirect or a normalised address) instead of adding one. */
  const expectReport = useRef(!!boot)
  /** Preview servers this panel started: origin → project folder; `served` is the one running now. */
  const servedFolders = useRef(new Map<string, string>())
  const served = useRef('')

  const servers = useMemo(() => detectDevServers(tasks, seenDevServers), [tasks])
  const finishedTasks = tasks.filter(task => task.status !== 'running').length
  const shownUrl = frame ? currentPage(history) ?? frame.url : undefined
  const errorTotal = errors.reduce((sum, error) => sum + error.count, 0)

  const setViewport = (next: ViewportId) => {
    setViewportState(next)
    try { localStorage.setItem(VIEWPORT_KEY, next) } catch { /* a convenience */ }
  }

  const resetPage = () => {
    setFrame(null); setLoadState('idle'); setTitle(''); setErrors([]); setErrorsOpen(false)
  }
  /** Shows `url` in a fresh frame (no joint session history with the app) as the page of `next`. */
  const load = (url: string, next: PageHistory) => {
    setHistory(next)
    setFrame(current => ({ url, key: (current?.key ?? 0) + 1 }))
    setLoadState(canFrame(url) ? 'loading' : 'refused')
    setTitle(''); setErrors([]); setErrorsOpen(false); setNotice(''); setEditing(false)
    expectReport.current = true
    // A frame cannot tell a dead server or a refused frame from a blank page; ask natively.
    const token = ++probes.current
    if (isTauri() && canFrame(url)) void probeUrl(url).then(result => {
      if (probes.current !== token) return
      if (!result.reachable) setLoadState('unreachable')
      else if (result.frameBlocked) setLoadState('blank')
    }).catch(() => { /* the frame's own load handling still applies */ })
  }
  const visit = (url: string) => load(url, pushPage(historyRef.current, url))

  /** Serves the first folder that works and opens the file in it. */
  const serveAndVisit = async (attempts: Array<{ folder: string; file: string }>, token: number) => {
    if (!cwd) { setNotice('Open a project folder to preview its files.'); return }
    setBusy(true); setNotice('')
    let failure: unknown = 'Nothing to serve'
    try {
      for (const attempt of attempts) {
        try {
          const base = await previewServe(cwd, attempt.folder || undefined)
          if (navigation.current !== token) return
          served.current = originOf(base)
          servedFolders.current.set(served.current, attempt.folder)
          visit(servedUrl(base, attempt.file))
          return
        } catch (error) { failure = error }
      }
      if (navigation.current === token) setNotice(describe(failure))
    } finally { if (navigation.current === token) setBusy(false) }
  }
  const openFile = (path: string) => {
    const target = previewTarget(path, cwd)
    return serveAndVisit([target, ...(target.fallback ? [target.fallback] : [])], ++navigation.current)
  }
  const go = (input: string) => {
    const address = parseAddress(input)
    if (address.kind === 'invalid') { ++navigation.current; setNotice(address.message); return }
    if (address.kind === 'path') return openFile(address.path)
    ++navigation.current
    setBusy(false)
    visit(address.url)
  }

  /** A served page whose server was replaced (another folder was served
   *  since) is served again; its entries move to the new address. */
  const ensureServed = async (url: string, next: PageHistory) => {
    const origin = originOf(url)
    const folder = servedFolders.current.get(origin)
    if (folder === undefined || !cwd || served.current === origin) return { url, history: next }
    const base = await previewServe(cwd, folder || undefined)
    const fresh = originOf(base)
    served.current = fresh
    servedFolders.current.set(fresh, folder)
    if (fresh === origin) return { url, history: next }
    const move = (href: string) => originOf(href) === origin ? fresh + href.slice(origin.length) : href
    return { url: move(url), history: { ...next, entries: next.entries.map(move) } }
  }
  const showEntry = async (next: PageHistory) => {
    const token = ++navigation.current
    const url = currentPage(next)
    if (!url) { setHistory(next); resetPage(); setBusy(false); return }
    try {
      const target = await ensureServed(url, next)
      if (navigation.current === token) load(target.url, target.history)
    } catch (error) { if (navigation.current === token) setNotice(describe(error)) }
  }
  const step = (delta: -1 | 1) => {
    const next = stepPage(historyRef.current, delta)
    if (next !== historyRef.current) void showEntry(next)
  }
  const reload = () => { if (frame) void showEntry(historyRef.current.index >= 0 ? historyRef.current : pushPage(historyRef.current, frame.url)) }
  const openExternally = () => { if (isWebAddress(shownUrl)) void openInDefaultBrowser(shownUrl!).catch(error => setNotice(describe(error))) }

  // Served pages report where they are and their errors (the preview
  // server's injected script); only the frame shown now is listened to.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      const data = event.data as { source?: unknown; type?: unknown; href?: unknown; title?: unknown; message?: unknown } | null
      if (!frameWindow || event.source !== frameWindow || !data || typeof data !== 'object' || data.source !== 'gcode-preview') return
      if (data.type === 'location' && typeof data.href === 'string' && isWebAddress(data.href)) {
        const current = historyRef.current
        setHistory(expectReport.current ? replacePage(current, data.href) : observePage(current, data.href))
        expectReport.current = false
        setTitle(typeof data.title === 'string' ? data.title.trim() : '')
        setLoadState('ready')
      } else if (data.type === 'error') {
        const message = (typeof data.message === 'string' && data.message.trim() ? data.message : 'Unknown error').slice(0, 4000)
        setErrors(list => {
          const at = list.findIndex(error => error.message === message)
          if (at < 0) return [...list, { message, count: 1 }].slice(-100)
          return list.map((error, index) => index === at ? { ...error, count: error.count + 1 } : error)
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // WebKit keeps a frame's empty initial document when the page refuses to
  // be framed (X-Frame-Options, frame-ancestors) or nothing answers; that
  // document is readable from here, a real page is not.
  const onFrameLoad = () => {
    let blank = false
    try { const href = iframeRef.current?.contentWindow?.location.href; blank = !href || href === 'about:blank' }
    catch { blank = false }
    setLoadState(blank ? 'blank' : 'ready')
  }
  useEffect(() => {
    if (loadState !== 'loading') return
    const timer = window.setTimeout(() => setLoadState(state => state === 'loading' ? 'slow' : state), SLOW_MS)
    return () => window.clearTimeout(timer)
  }, [loadState, frame?.key])

  // Another view asked to show an address or a project file.
  const handledRequest = useRef<number | undefined>(boot ? request?.nonce : undefined)
  useEffect(() => {
    if (!request || handledRequest.current === request.nonce) return
    handledRequest.current = request.nonce
    if (request.url) void go(request.url)
    else if (request.path) void openFile(request.path)
  }, [request?.nonce])

  // A different project: its pages, servers and history do not carry over.
  const lastCwd = useRef(cwd)
  useEffect(() => {
    if (lastCwd.current === cwd) return
    lastCwd.current = cwd
    ++navigation.current
    void previewStop().catch(() => {})
    servedFolders.current.clear(); served.current = ''
    setHistory(EMPTY_HISTORY); resetPage(); setNotice(''); setBusy(false); setBuilds(null); setDraft(''); setEditing(false)
  }, [cwd])

  // Start screen: build folders with an index.html (checked when shown, and after a background command finishes).
  useEffect(() => {
    if (!open || frame || !cwd) return
    let live = true
    void (async () => {
      try {
        const root = await listDirectory(cwd)
        const folders = BUILD_FOLDERS.flatMap(name => root.entries.filter(entry => entry.dir && entry.name === name))
        const found = await Promise.all(folders.map(async (folder): Promise<Build | null> => {
          try {
            const index = (await listDirectory(cwd, folder.name)).entries.find(entry => !entry.dir && entry.name.toLowerCase() === 'index.html')
            return index ? { folder: folder.name, modified: index.modified ?? folder.modified } : null
          } catch { return null }
        }))
        const rootIndex = root.entries.find(entry => !entry.dir && entry.name.toLowerCase() === 'index.html')
        if (live) setBuilds([...found.filter((build): build is Build => !!build), ...(rootIndex ? [{ folder: '', modified: rootIndex.modified }] : [])])
      } catch { if (live) setBuilds([]) }
    })()
    return () => { live = false }
  }, [open, cwd, !!frame, finishedTasks])

  // The device presets scale to the stage's width.
  useEffect(() => {
    const element = stageRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setStage({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [!!frame])

  // The errors popover closes on a click elsewhere.
  useEffect(() => {
    if (!errorsOpen) return
    const away = (event: PointerEvent) => { if (!errorsRef.current?.contains(event.target as Node)) setErrorsOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [errorsOpen])
  const popoverKey = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault() // keeps the side panel open
    setErrorsOpen(false)
    errorsRef.current?.querySelector<HTMLButtonElement>('.gc-browser-error-count')?.focus()
  }
  const addressKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || draft === (shownUrl ?? '')) return
    event.preventDefault()
    setDraft(shownUrl ?? '')
    event.currentTarget.select()
  }

  const preset = VIEWPORTS.find(entry => entry.id === viewport) ?? VIEWPORTS[0]
  const scale = preset.width && stage.width > STAGE_PAD * 2 ? Math.min(1, (stage.width - STAGE_PAD * 2) / preset.width) : 1
  const deviceStyle: CSSProperties | undefined = preset.width
    ? { width: preset.width, height: stage.height ? Math.max(0, (stage.height - STAGE_PAD * 2) / scale) : undefined, transform: `translateX(-50%) scale(${scale})` }
    : undefined
  const external = !!shownUrl && !isLocalAddress(shownUrl)
  const blocked = loadState === 'blank' || loadState === 'refused' || loadState === 'unreachable'

  return <section className="gc-side-view gc-browser" hidden={!open} tabIndex={-1} aria-labelledby="browser-title">
    <header className="gc-side-header" data-tauri-drag-region="deep">
      <h2 id="browser-title" className="gc-side-title"><Globe size={15} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>Browser</span>{frame && title && <span className="gc-browser-page-title" title={title}>{title}</span>}</h2>
      <Tooltip content="Open in browser"><button type="button" className="gc-side-icon" aria-label="Open in browser" aria-disabled={!isWebAddress(shownUrl) || undefined} onClick={openExternally}><ExternalLink size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
      <Tooltip content="Close" shortcut="Esc"><button type="button" className="gc-side-icon" aria-label="Close browser" onClick={(event) => onClose(event.detail > 0)}><PanelRightClose size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
    </header>

    <div className="gc-browser-toolbar">
      <Tooltip content="Back"><button type="button" className="gc-side-icon" aria-label="Back" aria-disabled={!frame || history.index < 0 || undefined} onClick={() => step(-1)}><ArrowLeft size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
      <Tooltip content="Forward"><button type="button" className="gc-side-icon" aria-label="Forward" aria-disabled={history.index >= history.entries.length - 1 || undefined} onClick={() => step(1)}><ArrowRight size={16} strokeWidth={ICON_STROKE}/></button></Tooltip>
      <Tooltip content="Reload"><button type="button" className="gc-side-icon" aria-label="Reload" aria-disabled={!frame || undefined} onClick={reload}><RotateCw size={15} strokeWidth={ICON_STROKE}/></button></Tooltip>
      <form className="gc-browser-address" onSubmit={(event) => {
        event.preventDefault()
        // A mistyped address stays in the field to fix; anything else hands the keyboard back.
        const valid = parseAddress(draft).kind !== 'invalid'
        void go(draft)
        if (valid) addressRef.current?.blur()
      }}>
        <input ref={addressRef} className="gc-input-well" type="text" inputMode="url" enterKeyHint="go" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
          aria-label="Address" placeholder="localhost:5173 or dist/index.html" value={editing ? draft : shownUrl ?? ''}
          onFocus={(event) => { setDraft(shownUrl ?? ''); setEditing(true); event.currentTarget.select() }} onBlur={() => setEditing(false)}
          onChange={(event) => { setDraft(event.target.value); setEditing(true) }} onKeyDown={addressKey}/>
      </form>
    </div>

    {frame && <div className="gc-browser-strip">
      <div className="gc-segmented gc-browser-viewports" role="group" aria-label="Viewport">
        {VIEWPORTS.map(entry => {
          const selected = entry.id === viewport
          return <button key={entry.id} type="button" className="gc-segmented-item" aria-pressed={selected} aria-label={entry.name} title={entry.width ? `${entry.name} px` : 'Fit the panel'} onClick={(event) => { setThumbGlides(event.detail > 0); setViewport(entry.id) }}>
            {selected && <motion.span layoutId="gc-browser-viewport-thumb" transformTemplate={flatProjection} className="gc-segmented-thumb" transition={thumbGlides ? springIndicator : { duration: 0 }} aria-hidden="true"/>}
            <span className="gc-segmented-label"><entry.Icon size={13} strokeWidth={ICON_STROKE} aria-hidden="true"/>{entry.label}</span>
          </button>
        })}
      </div>
      {scale < 1 && loadState !== 'refused' && <span className="gc-browser-scale" aria-label={`Scaled to ${Math.round(scale * 100)}%`}>{Math.round(scale * 100)}%</span>}
      {!!servers.length && <div className="gc-browser-chips" role="group" aria-label="Dev servers">
        {servers.map(server => <button key={server.url} type="button" className="gc-browser-chip" aria-pressed={originOf(server.url) === originOf(shownUrl ?? '')} title={`${server.url} · ${server.label}`} onClick={() => go(server.url)}>
          <span className="gc-browser-chip-light" aria-hidden="true"/>{shortAddress(server.url)}
        </button>)}
      </div>}
      {errorTotal > 0 && <div ref={errorsRef} className="gc-browser-errors" onKeyDown={popoverKey}>
        <button type="button" className="gc-browser-error-count" aria-expanded={errorsOpen} aria-controls="gc-browser-error-list" aria-label={`${errorTotal} page ${errorTotal === 1 ? 'error' : 'errors'}`} onClick={() => setErrorsOpen(value => !value)}>
          <TriangleAlert size={13} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>{errorTotal > 99 ? '99+' : errorTotal}</span>
        </button>
        {errorsOpen && <div id="gc-browser-error-list" className="gc-browser-popover" role="dialog" aria-label="Page errors">
          <div className="gc-browser-popover-head"><strong>Page errors</strong><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => { setErrors([]); setErrorsOpen(false) }}>Clear</button></div>
          <ol>{errors.map(error => <li key={error.message}><pre>{error.message}</pre>{error.count > 1 && <span className="gc-browser-error-repeat" aria-label={`${error.count} times`}>×{error.count}</span>}</li>)}</ol>
        </div>}
      </div>}
    </div>}

    {notice && <div className="gc-browser-notice" role="alert"><TriangleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/><span>{notice}</span><button type="button" className="gc-side-icon" aria-label="Dismiss" onClick={() => setNotice('')}><X size={14} strokeWidth={ICON_STROKE}/></button></div>}
    {frame && loadState === 'slow' && <div className="gc-browser-notice is-quiet" role="status"><span>Still loading. If the page stays blank, it may not allow being shown in a frame.</span><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={openExternally}>Open in browser</button></div>}
    {frame && external && !blocked && loadState !== 'slow' && !externalHintDismissed && <div className="gc-browser-notice is-quiet" role="note"><span>Some sites refuse to be shown inside another app. If this one stays blank, open it in your browser.</span><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={openExternally}>Open in browser</button><button type="button" className="gc-side-icon" aria-label="Dismiss" onClick={() => setExternalHintDismissed(true)}><X size={14} strokeWidth={ICON_STROKE}/></button></div>}

    {frame ? <div ref={stageRef} className="gc-browser-stage" data-viewport={viewport} aria-busy={loadState === 'loading' || busy || undefined}>
      {(loadState === 'loading' || busy) && <span className="gc-browser-progress" aria-hidden="true"/>}
      {loadState !== 'refused' && <div className={preset.width ? 'gc-browser-device' : 'gc-browser-fit'} style={deviceStyle}>
        <iframe key={frame.key} ref={iframeRef} className="gc-browser-frame" data-state={loadState} src={frame.url} sandbox={SANDBOX} title={title || 'Page preview'} onLoad={onFrameLoad}/>
      </div>}
      {blocked && <div className="gc-browser-blocked" role="alert">
        <span className="gc-modal-icon" aria-hidden="true"><Globe size={18} strokeWidth={ICON_STROKE}/></span>
        <strong>{loadState === 'refused' ? 'This address can’t be shown here.' : loadState === 'unreachable' ? `Nothing is answering at ${hostOf(shownUrl)}.` : 'This page didn’t load here.'}</strong>
        <small>{loadState === 'refused'
          ? 'The panel shows https pages, and http pages on this Mac (localhost, 127.0.0.1). Open it in your browser instead.'
          : loadState === 'unreachable'
            ? 'Start the server first (background commands are listed in Tasks), or check the address and port.'
            : 'The server may not be running, or the site doesn’t allow being shown inside another app (X-Frame-Options). Open it in your browser instead.'}</small>
        <div className="gc-browser-blocked-actions">
          <button type="button" className="gc-btn gc-btn-primary gc-btn-sm" disabled={!isWebAddress(shownUrl)} onClick={openExternally}><ExternalLink size={14} strokeWidth={ICON_STROKE} aria-hidden="true"/>Open in browser</button>
          {(loadState === 'blank' || loadState === 'unreachable') && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={reload}>Try again</button>}
        </div>
      </div>}
    </div> : <BrowserStart cwd={cwd} builds={builds} servers={servers} busy={busy} onBuild={(folder) => void serveAndVisit([{ folder, file: '' }], ++navigation.current)} onServer={(url) => go(url)}/>}
  </section>
}

/** What the panel offers while nothing is loaded: build output to serve, and running dev servers. */
export function BrowserStart({ cwd, builds, servers, busy, onBuild, onServer }: { cwd?: string; builds: Build[] | null; servers: DevServer[]; busy?: boolean; onBuild: (folder: string) => void; onServer: (url: string) => void }) {
  return <div className="gc-browser-start" aria-busy={busy || undefined}>
    <section className="gc-browser-group" aria-labelledby="browser-builds">
      <h3 id="browser-builds">Preview build{!!builds?.length && <span className="gc-outputs-count">{builds.length}</span>}</h3>
      {!cwd ? <p className="gc-browser-hint">Open a project folder to preview its build.</p>
        : builds === null ? <p className="gc-browser-hint gc-shimmer-text">Looking for build output…</p>
        : builds.length ? <ul>{builds.map(build => <li key={build.folder || '.'}>
          <button type="button" className="gc-browser-card" disabled={busy} onClick={() => onBuild(build.folder)} aria-label={`Preview build ${build.folder ? `${build.folder}/` : 'project root'}`}>
            <Package size={16} strokeWidth={ICON_STROKE} aria-hidden="true"/>
            <span><strong>{build.folder ? `${build.folder}/` : 'Project root'}</strong><small>index.html{build.modified ? ` · changed ${ago(build.modified)}` : ''}</small></span>
          </button>
        </li>)}</ul>
        : <p className="gc-browser-hint">No index.html in dist/, build/, out/, public/ or the project root yet.</p>}
    </section>
    <section className="gc-browser-group" aria-labelledby="browser-servers">
      <h3 id="browser-servers">Dev servers{!!servers.length && <span className="gc-outputs-count">{servers.length}</span>}</h3>
      {servers.length ? <ul>{servers.map(server => <li key={server.url}>
        <button type="button" className="gc-browser-card" onClick={() => onServer(server.url)} aria-label={`Open dev server ${shortAddress(server.url)}`}>
          <Server size={16} strokeWidth={ICON_STROKE} aria-hidden="true"/>
          <span><strong>{shortAddress(server.url)}</strong><small title={server.label}>{server.label}</small></span>
          <span className="gc-browser-chip-light" aria-hidden="true"/>
        </button>
      </li>)}</ul>
        : <p className="gc-browser-hint">Addresses printed by running background commands (Bash run_in_background), such as a Vite or Next dev server, appear here.</p>}
    </section>
    <p className="gc-browser-footnote">Type an address (localhost:5173) or a project file (dist/index.html) above.</p>
  </div>
}

function hostOf(url?: string) {
  try { return url ? new URL(url).host : 'this address' } catch { return 'this address' }
}
