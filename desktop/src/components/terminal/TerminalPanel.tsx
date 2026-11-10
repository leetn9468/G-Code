import { THEME_CHANGE_EVENT } from '@/lib/theme'
// Embedded terminal: the Terminal view of the right side panel, one tab per
// shell (xterm.js + a PTY per tab, see lib/terminal.ts).
// Behaviour follows OpenCode's terminal dock:
// - tabs belong to the project folder; every chat in that folder shares them
// - opening the terminal with none for the folder starts "Terminal 1";
//   titles use the lowest free number; at most 20 terminals
// - hiding keeps the shells; closing a tab ends its shell; a shell that exits
//   closes its tab; the last tab closing hides the terminal
// G-Code differences: it opens in the side panel rather than below the
// conversation (the panel's left edge sets its width), and arriving in another
// folder never starts a shell or takes the keyboard on its own (each Recents
// chat is its own folder); the terminal hides there until it is opened again.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PanelRightClose, Plus, SquareTerminal, X } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { ackTerminal, closeTerminal, openTerminal, resizeTerminal, writeTerminal } from '@/lib/terminal'
import { isTauri } from '@/lib/tauri'
import '@/styles/terminal.css'

const STROKE = 1.75
const MAX_TERMINALS = 20
const RESIZE_DEBOUNCE_MS = 100
const REVEAL_FALLBACK_MS = 800
// Acks for parsed output go back in batches (xterm's flow-control guide).
const ACK_BATCH = 64 * 1024

interface Tab { key: number; n: number; title: string; cwd: string }

interface Props {
  /** The Terminal view is the side panel's current view. */
  open: boolean
  /** Still on screen while the side panel slides closed (defaults to open). */
  shown?: boolean
  cwd?: string
  /** The project folder is being checked (cwd is briefly unset): keep the current tabs. */
  cwdPending?: boolean
  /** Bumped whenever the active terminal should take the keyboard (shown, toggled). */
  focusRequest: number
  /** Bumped by ⌃⌥T: open another terminal in this folder. */
  newRequest: number
  /** slide: hidden with the pointer (the side panel slides closed). */
  onHide: (slide?: boolean) => void
}

const cssColor = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

// The palette lives in terminal.css as tokens; xterm needs literal colours.
function themeFromCss(): ITheme {
  const theme: Record<string, string> = {
    background: cssColor('--terminal-background', '#1A1A1A'),
    foreground: cssColor('--terminal-foreground', '#E0E0E0'),
    cursor: cssColor('--terminal-cursor', '#8CB9CC'),
    cursorAccent: cssColor('--terminal-background', '#1A1A1A'),
    selectionBackground: cssColor('--terminal-selection', 'rgba(224, 224, 224, .22)'),
  }
  for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    theme[name] = cssColor(`--ansi-${name}`, '#ffffff')
    theme[`bright${name[0].toUpperCase()}${name.slice(1)}`] = cssColor(`--ansi-bright-${name}`, '#ffffff')
  }
  return theme as ITheme
}

/** Printable output (not just whitespace or control bytes) has arrived. */
const hasVisibleOutput = (bytes: Uint8Array) => bytes.some((byte) => byte > 0x20 && byte !== 0x7f && byte !== 0x1b)

export function TerminalPanel({ open, shown = open, cwd, cwdPending = false, focusRequest, newRequest, onHide }: Props) {
  // Tabs belong to the settled folder; a folder that is still being checked
  // must not start a terminal of its own.
  const settledScope = useRef(cwd ?? '')
  if (!cwdPending) settledScope.current = cwd ?? ''
  const scope = settledScope.current
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeByScope, setActiveByScope] = useState<Record<string, number>>({})
  // Pointer selection of a tab hands it the keyboard (keyboard selection keeps focus on the tabs).
  const [tabFocus, setTabFocus] = useState(0)
  const [refused, setRefused] = useState(false)
  const nextKey = useRef(1)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const onHideRef = useRef(onHide)
  onHideRef.current = onHide
  const tablistRef = useRef<HTMLDivElement>(null)

  const scoped = tabs.filter((tab) => tab.cwd === scope)
  const active = scoped.some((tab) => tab.key === activeByScope[scope]) ? activeByScope[scope] : scoped.at(-1)?.key ?? null
  const select = (key: number) => setActiveByScope((current) => ({ ...current, [scope]: key }))

  const addTab = useCallback(() => {
    const current = tabsRef.current
    if (current.length >= MAX_TERMINALS) { setRefused(true); return }
    setRefused(false)
    const here = scopeRef.current
    const used = new Set(current.filter((tab) => tab.cwd === here).map((tab) => tab.n))
    let n = 1
    while (used.has(n)) n++
    const tab = { key: nextKey.current++, n, title: `Terminal ${n}`, cwd: here }
    tabsRef.current = [...current, tab]
    setTabs(tabsRef.current)
    setActiveByScope((selected) => ({ ...selected, [here]: tab.key }))
  }, [])

  const closeTab = useCallback((key: number) => {
    const current = tabsRef.current
    const index = current.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const closing = current[index]
    const rest = current.filter((tab) => tab.key !== key)
    tabsRef.current = rest
    setTabs(rest)
    setRefused(false)
    const siblings = rest.filter((tab) => tab.cwd === closing.cwd)
    // The neighbour to the right takes over, or the new last tab.
    const before = current.filter((tab) => tab.cwd === closing.cwd).findIndex((tab) => tab.key === key)
    setActiveByScope((selected) => selected[closing.cwd] !== key ? selected : { ...selected, [closing.cwd]: siblings[Math.min(before, siblings.length - 1)]?.key ?? -1 })
    if (!siblings.length && closing.cwd === scopeRef.current) onHideRef.current()
  }, [])

  // Opening the terminal (⌃`, the header button, the palette, ⌃⌥T) with no
  // terminal for this folder starts one; ⌃⌥T with terminals here adds another.
  // One effect, so a ⌃⌥T that also opens the terminal starts exactly one shell.
  const handled = useRef({ open: false, newRequest })
  useEffect(() => {
    if (cwdPending) return
    const opened = open && !handled.current.open
    const asked = newRequest !== handled.current.newRequest
    handled.current = { open, newRequest }
    if (!open) return
    if (tabsRef.current.every((tab) => tab.cwd !== scopeRef.current)) { if (opened || asked) addTab() }
    else if (asked) addTab()
  }, [open, newRequest, cwdPending, addTab])
  // Arriving in a folder with no terminal hides the terminal instead of
  // starting a shell in every folder visited (each Recents chat has its own).
  const shownScope = useRef(scope)
  useEffect(() => {
    if (cwdPending || shownScope.current === scope) return
    shownScope.current = scope
    setRefused(false)
    if (open && !tabsRef.current.some((tab) => tab.cwd === scope)) onHideRef.current()
  }, [scope, cwdPending, open])

  const setTitle = useCallback((key: number, title: string) => {
    setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, title } : tab))
  }, [])

  // Tabs: roving tabindex; arrows/Home/End move and select, Delete closes.
  const tabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = scoped.findIndex((tab) => tab.key === active)
    const targets: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: scoped.length - 1 }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (active === null) return
      event.preventDefault(); closeTab(active); return
    }
    if (!(event.key in targets)) return
    event.preventDefault()
    const target = scoped[(targets[event.key] + scoped.length) % scoped.length]
    if (!target) return
    select(target.key)
    requestAnimationFrame(() => tablistRef.current?.querySelector<HTMLElement>(`#gc-terminal-tab-${target.key}`)?.focus())
  }

  return (
    <section id="gc-terminal-panel" className="gc-side-view gc-terminal-panel" aria-label="Terminal" hidden={!(open || shown)}>
      {/* The header is the window's title bar here too: its gaps drag the window; its tabs and buttons still click. */}
      <header className="gc-side-header gc-terminal-bar" data-tauri-drag-region="deep">
        <div className="gc-terminal-strip">
          <div ref={tablistRef} className="gc-terminal-tabs" role="tablist" aria-label="Terminals" onKeyDown={tabKey}>
            {scoped.map((tab) => (
              <div key={tab.key} className={`gc-terminal-tab${tab.key === active ? ' is-active' : ''}`} role="presentation"
                onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.key) } }}>
                {/* Switches on press (no wait for release) and hands the shell the keyboard; keyboard selection stays on the tabs. */}
                <button type="button" role="tab" id={`gc-terminal-tab-${tab.key}`} aria-selected={tab.key === active} aria-controls={`gc-terminal-view-${tab.key}`} aria-keyshortcuts="Delete" tabIndex={tab.key === active ? 0 : -1} title={tab.cwd || undefined}
                  onMouseDown={(event) => { if (event.button === 0) { event.preventDefault(); select(tab.key); setTabFocus((value) => value + 1) } }} onClick={(event) => { if (event.detail === 0) select(tab.key) }}>
                  <SquareTerminal size={14} strokeWidth={STROKE} aria-hidden="true" /><span>{tab.title}</span>
                </button>
                {/* Pointer affordance only; from the keyboard, Delete closes the focused tab (keeps the tablist to tabs). */}
                <button type="button" className="gc-terminal-tab-close" tabIndex={-1} aria-hidden="true" title={`Close ${tab.title}`} onClick={() => closeTab(tab.key)}><X size={13} strokeWidth={STROKE} /></button>
              </div>
            ))}
          </div>
          <Tooltip content={tabs.length >= MAX_TERMINALS ? `At most ${MAX_TERMINALS} terminals` : 'New terminal'} shortcut={tabs.length >= MAX_TERMINALS ? undefined : '⌃⌥T'}>
            <button type="button" className="gc-side-icon" aria-label="New terminal" aria-disabled={tabs.length >= MAX_TERMINALS || undefined} onClick={addTab}><Plus size={15} strokeWidth={STROKE} /></button>
          </Tooltip>
        </div>
        <Tooltip content="Hide terminal" shortcut="⌃`"><button type="button" className="gc-side-icon" aria-label="Hide terminal" onClick={(event) => onHide(event.detail > 0)}><PanelRightClose size={16} strokeWidth={STROKE} /></button></Tooltip>
      </header>
      <div className="gc-terminal-views">
        {refused && !scoped.length && <p className="gc-terminal-empty" role="status">{MAX_TERMINALS} terminals are open in other folders. Close one there to start one here.</p>}
        {tabs.map((tab) => (
          <TerminalView key={tab.key} tab={tab} shown={tab.cwd === scope && tab.key === active} visible={open && tab.cwd === scope && tab.key === active} focusRequest={focusRequest + tabFocus} onTitle={setTitle} onExit={closeTab} />
        ))}
      </div>
    </section>
  )
}

interface ViewProps {
  tab: Tab
  /** The selected tab of the current folder (laid out even while the panel is hidden). */
  shown: boolean
  /** Shown and the panel is open. */
  visible: boolean
  focusRequest: number
  onTitle: (key: number, title: string) => void
  onExit: (key: number) => void
}

function TerminalView({ tab, shown, visible, focusRequest, onTitle, onExit }: ViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState(!isTauri())
  const callbacks = useRef({ onTitle, onExit })
  callbacks.current = { onTitle, onExit }

  // One xterm and one PTY for the life of the tab; hidden tabs stay mounted.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      // A terminal grid needs a monospaced face: the system one (SF Mono).
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      macOptionIsMeta: false,
      theme: themeFromCss(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    const updateTheme = () => { term.options.theme = themeFromCss() }
    window.addEventListener(THEME_CHANGE_EVENT, updateTheme)
    // Fit before spawning so the shell starts at its real size (no SIGWINCH reflow).
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()

    let disposed = false
    let id: number | null = null
    let sentSize = ''
    let parsed = 0
    const ack = () => {
      if (id === null || parsed < ACK_BATCH) return
      const bytes = parsed
      parsed = 0
      void ackTerminal(id, bytes).catch(() => {})
    }
    // Input and resizes go through one ordered lane: commands are async on the
    // Rust side, so separate invokes could land out of order. Input typed while
    // a write is in flight (or before the shell exists) is sent as one chunk.
    let lane: Promise<unknown> = Promise.resolve()
    let buffered = ''
    const flush = () => {
      lane = lane.then(() => {
        if (id === null || !buffered) return
        const chunk = buffered
        buffered = ''
        return writeTerminal(id, chunk).catch(() => {})
      })
    }
    const send = (data: string) => {
      const idle = !buffered
      buffered += data
      if (idle && id !== null) flush()
    }
    const pushSize = (cols: number, rows: number) => {
      const size = `${cols}x${rows}`
      if (id === null || size === sentSize) return
      sentSize = size
      const target = id
      lane = lane.then(() => resizeTerminal(target, cols, rows).catch(() => {}))
    }

    // ⌘ shortcuts, ⌃` and ⌃⌥T belong to the app; ⌘⌫ deletes the line (as in Terminal.app).
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.metaKey && event.key === 'Backspace') { send('\x15'); return false }
      if (event.metaKey) return false
      if (event.ctrlKey && (event.code === 'Backquote' || (event.altKey && event.code === 'KeyT'))) return false
      return true
    })
    const title = term.onTitleChange((value) => { if (value.trim()) callbacks.current.onTitle(tab.key, value.trim()) })
    const input = term.onData(send)
    // First size goes at spawn; later ones are debounced and deduplicated.
    let resizeTimer = 0
    const resize = term.onResize(({ cols, rows }) => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => pushSize(cols, rows), RESIZE_DEBOUNCE_MS)
    })

    // The view fades in on the shell's first visible output, never as a blank or half-drawn grid.
    const revealTimer = window.setTimeout(() => setRevealed(true), REVEAL_FALLBACK_MS)
    // Spawn after the current task: StrictMode's dev double-mount disposes the
    // first effect synchronously, so it never starts a second login shell.
    queueMicrotask(() => {
      if (disposed) return
      if (!isTauri()) { term.write('The terminal runs in the G-Code desktop app.\r\n'); return }
      const initialCols = term.cols, initialRows = term.rows
      openTerminal(tab.cwd, initialCols, initialRows, (event) => {
        if (disposed) return
        if (event.kind === 'output') {
          const bytes = event.data.byteLength
          term.write(event.data, () => { parsed += bytes; ack() })
          if (hasVisibleOutput(event.data)) setRevealed(true)
        } else callbacks.current.onExit(tab.key)
      }).then((opened) => {
        if (disposed) { void closeTerminal(opened).catch(() => {}); return }
        id = opened
        sentSize = `${initialCols}x${initialRows}`
        // The panel may have been resized while the shell was starting.
        pushSize(term.cols, term.rows)
        if (buffered) flush()
        ack()
      }).catch((failure) => { if (!disposed) { setError(String(failure)); setRevealed(true) } })
    })

    // Fit on every size change of the host (panel drag, window resize, shown
    // again), coalesced to one per frame and skipped while it has no size.
    let frame = 0
    const refit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit() })
    }
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    void document.fonts?.ready.then(() => { if (!disposed) refit() })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      window.clearTimeout(resizeTimer)
      window.clearTimeout(revealTimer)
      observer.disconnect()
      window.removeEventListener(THEME_CHANGE_EVENT, updateTheme)
      title.dispose(); input.dispose(); resize.dispose()
      if (id !== null) { const closing = id; lane = lane.then(() => closeTerminal(closing).catch(() => {})) }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [tab.key, tab.cwd])

  // Shown again: refit. Take the keyboard only when asked (a new tab, ⌃`, the
  // header button, a click on the tab), never because the folder changed.
  const focusedFor = useRef<number | null>(null)
  useEffect(() => {
    // Requests made while this tab is not on screen were for another tab.
    if (!visible) { if (focusedFor.current !== null) focusedFor.current = focusRequest; return }
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      if (focusedFor.current === focusRequest) return
      focusedFor.current = focusRequest
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, focusRequest])

  return (
    <div id={`gc-terminal-view-${tab.key}`} className="gc-terminal" role="tabpanel" aria-labelledby={`gc-terminal-tab-${tab.key}`} hidden={!shown}>
      {error && <p role="alert" className="gc-terminal-error">{error}</p>}
      <div ref={hostRef} className={`gc-terminal-host${revealed ? ' is-revealed' : ''}`}
        // Clicking anywhere in the well focuses the shell.
        onPointerDown={() => requestAnimationFrame(() => termRef.current?.focus())} />
    </div>
  )
}
