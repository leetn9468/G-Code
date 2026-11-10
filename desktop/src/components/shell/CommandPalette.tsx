import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowUpRight, CircleAlert, Command, Compass, FolderOpen, MessageSquare, MessageSquarePlus, Search, SearchX, SquarePen, Wrench, X, type LucideIcon } from 'lucide-react'
import type { SavedSession } from '@/lib/tauri'
import { searchCommands, searchSessions } from '@/lib/search'
import { workspaceLabel } from '@/lib/workspace'
import { sessionKey } from '@/lib/projects'
import { flatProjection, springIndicator } from '@/lib/motion'
import { Modal } from './Modal'
import '@/styles/search.css'

export interface PaletteAction { id: string; name: string; section: string; shortcut?: string; run: () => void }
interface Props {
  open: boolean
  onClose: () => void
  actions: PaletteAction[]
  sessions: SavedSession[]
  /** The text of every chat, read only while Chats is open here: the list itself holds titles only. */
  loadSearchable?: () => Promise<SavedSession[]>
  loading: boolean
  error: string | null
  onResume: (session: SavedSession) => void
}
type SearchMode = 'commands' | 'chats'
const MODES: SearchMode[] = ['commands', 'chats']

// Presentation only: a glyph per command section so rows scan faster.
const SECTION_ICONS: Record<string, LucideIcon> = {
  Project: FolderOpen,
  Navigation: Compass,
  Chat: MessageSquarePlus,
  Session: SquarePen,
  Tools: Wrench,
}
const MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃'])
/** "⌘⇧P" → ["⌘", "⇧", "P"]: one chip per key. */
const shortcutKeys = (shortcut: string) => {
  const keys: string[] = []
  let rest = ''
  for (const char of shortcut) {
    if (MODIFIERS.has(char) && !rest) keys.push(char)
    else rest += char
  }
  return rest ? [...keys, rest] : keys
}
const ICON_STROKE = 1.75
// Search height: the panel's top edge is pinned (see Modal align="top"), so it
// grows downwards only and stays clear of the bottom of the window.
const PALETTE_MAX_HEIGHT = 'min(560px, calc(100vh - max(48px, (100vh - 480px) / 2) - 32px))'

/** The text of every chat while `active`; the window holds no reference to it after. WebKit may keep the memory for a while. */
export function useSearchableChats(active: boolean, load?: () => Promise<SavedSession[]>) {
  const [searchable, setSearchable] = useState<SavedSession[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  useEffect(() => {
    if (!active || !load) { setSearchable(null); setSearchError(null); return }
    let live = true
    void load().then(records => { if (live) setSearchable(records) }, failure => { if (live) setSearchError(`Could not read the chats' text, so only titles are searched: ${String(failure)}`) })
    return () => { live = false }
  }, [active, load])
  return { searchable, searchError }
}

/** What Chats searches: the chats' text once it is read. A chat the list hides (nothing written in it) stays hidden; the list decides, so the open chat stays. */
export function chatsToSearch(sessions: SavedSession[], searchable: SavedSession[] | null): SavedSession[] {
  if (!searchable) return sessions
  return searchable.filter(record => (record.messageCount ?? record.messages.length) > 0 || sessions.some(listed => listed.sessionId === record.sessionId && listed.cwd === record.cwd))
}

export function CommandPalette({ open, onClose, actions, sessions, loading, error, onResume, loadSearchable }: Props) {
  const [mode, setMode] = useState<SearchMode>('commands')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  // The tab thumb glides when switched with the pointer and jumps when
  // switched from the keyboard (keyboard actions never animate).
  const [thumbInstant, setThumbInstant] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<SearchMode, HTMLDivElement | null>>>({})
  const resultRefs = useRef<Array<HTMLDivElement | null>>([])
  const composing = useRef(false)
  const id = useId()
  const commands = useMemo(() => searchCommands(actions, query), [actions, query])
  const { searchable, searchError } = useSearchableChats(open && mode === 'chats', loadSearchable)
  const chats = useMemo(() => loading || error ? [] : searchSessions(chatsToSearch(sessions, searchable), query), [searchable, sessions, query, loading, error])
  const count = mode === 'commands' ? commands.length : chats.length
  const selectedIndex = Math.max(0, Math.min(selected, count - 1))
  const activeId = count ? `${id}-result-${mode}-${selectedIndex}` : undefined

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setThumbInstant(true)
    composing.current = false
    // The Modal first focuses its dialog in an effect. Focus the sole search
    // field after that effect, and cancel if the dialog closes immediately.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (open) resultRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex, mode, query])

  const changeMode = (next: SearchMode) => { setMode(next); setSelected(0) }
  const activate = (index: number) => {
    if (mode === 'commands') {
      const action = commands[index]
      if (!action) return
      action.run()
    } else {
      const result = chats[index]
      if (!result) return
      onResume(result.session)
    }
    onClose()
  }
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
    let next: SearchMode | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = mode === 'commands' ? 'chats' : 'commands'
    if (event.key === 'Home') next = 'commands'
    if (event.key === 'End') next = 'chats'
    if (event.key === 'Enter' || event.key === ' ') next = event.currentTarget.dataset.mode as SearchMode
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    setThumbInstant(true)
    changeMode(next)
    tabRefs.current[next]?.focus()
  }
  const navigateResults = (event: KeyboardEvent<HTMLDivElement>) => {
    const fromInput = event.target === inputRef.current
    const fromResult = event.target instanceof HTMLElement && Boolean(event.target.closest('[data-search-result]')) && resultsRef.current?.contains(event.target)
    if (!fromInput && !fromResult) return
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    if (!count) return
    if (event.key === 'Enter') { activate(selectedIndex); return }
    const next = event.key === 'ArrowDown' ? Math.min(count - 1, selectedIndex + 1) : Math.max(0, selectedIndex - 1)
    setSelected(next)
    if (fromResult) resultRefs.current[next]?.focus()
  }

  const chatEmpty = loading
      ? ['Loading chats…', 'Reading saved conversations.']
      : error
        ? ['Could not load chats', error]
        : query.trim()
          ? ['No matching chats', 'Search a title or words from a conversation.']
          : ['No saved chats yet', 'Start a conversation to find it here.']
  const EmptyIcon = mode === 'commands' ? SearchX : error ? CircleAlert : query.trim() ? SearchX : MessageSquare

  return <Modal open={open} onClose={onClose} labelledBy={`${id}-title`} width={640} maxHeight={PALETTE_MAX_HEIGHT} align="top" instant>
    <h2 id={`${id}-title`} className="sr-only">Search G-Code</h2>
    <div className="gc-unified-search-header">
      <div className="gc-search-tabs" role="tablist" aria-label="Search in">
        {MODES.map((tab) => <div key={tab} ref={(element) => { tabRefs.current[tab] = element }} role="tab" id={`${id}-${tab}-tab`} aria-selected={mode === tab} aria-controls={`${id}-${tab}-panel`} tabIndex={mode === tab ? 0 : -1} data-mode={tab} className="gc-search-tab" onClick={() => { setThumbInstant(false); changeMode(tab); inputRef.current?.focus() }} onKeyDown={navigateTabs}>
          {mode === tab && <motion.span aria-hidden="true" className="gc-search-tab-thumb" layoutId={`${id}-tab-thumb`} layoutDependency={mode} transformTemplate={flatProjection} initial={false} style={{ borderRadius: 7 }} transition={thumbInstant ? { duration: 0 } : springIndicator} />}
          {tab === 'commands' ? <Command size={15} strokeWidth={ICON_STROKE} /> : <MessageSquare size={15} strokeWidth={ICON_STROKE} />}<span>{tab === 'commands' ? 'Commands' : 'Chats'}</span>
        </div>)}
      </div>
      <button type="button" className="gc-search-close" onClick={onClose} aria-label="Close search"><span className="gc-kbd">esc</span><X size={15} strokeWidth={ICON_STROKE} /></button>
    </div>
    <div className="gc-search-panel" id={`${id}-${mode}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}-tab`} onKeyDown={navigateResults}>
      <div className="gc-search-input-row">
        <Search size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <input ref={inputRef} type="text" role="combobox" aria-label={mode === 'commands' ? 'Search commands' : 'Search chat titles and conversation content'} aria-autocomplete="list" aria-expanded={count > 0} aria-controls={`${id}-results`} aria-activedescendant={activeId} aria-describedby={`${id}-hint`} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} placeholder={mode === 'commands' ? 'Find a command…' : 'Search titles and conversations…'} autoComplete="off" spellCheck={false} />
      </div>
      <div className="gc-search-context"><span title={mode === 'chats' ? searchError ?? undefined : undefined}>{mode === 'commands' ? 'Actions in G-Code' : searchError ?? (loadSearchable && !searchable ? 'All projects & Recents · reading conversations…' : 'All projects & Recents')}</span><span>{count > 0 ? `${count} ${count === 1 ? 'result' : 'results'}` : ''}</span></div>
      <div className="gc-search-results" ref={resultsRef} id={`${id}-results`} role="listbox" aria-label={mode === 'commands' ? 'Matching commands' : 'Matching chats'} aria-busy={mode === 'chats' && loading}>
        {mode === 'commands' ? commands.map((action, index) => {
          const Icon = SECTION_ICONS[action.section] ?? Command
          return <div key={action.id} ref={(element) => { resultRefs.current[index] = element }} id={`${id}-result-commands-${index}`} role="option" aria-selected={selectedIndex === index} tabIndex={-1} data-search-result className="gc-search-result" onMouseEnter={() => setSelected(index)} onMouseDown={(event) => event.preventDefault()} onFocus={() => setSelected(index)} onClick={() => activate(index)}>
            <span className="gc-search-result-icon" aria-hidden="true"><Icon size={15} strokeWidth={ICON_STROKE} /></span><div className="gc-search-result-copy"><strong>{action.name}</strong><span>{action.section}</span></div>{action.shortcut ? <span className="gc-search-shortcut">{shortcutKeys(action.shortcut).map((key, keyIndex) => <kbd key={keyIndex} className="gc-kbd">{key}</kbd>)}</span> : <ArrowUpRight size={15} strokeWidth={ICON_STROKE} className="gc-search-result-arrow" aria-hidden="true" />}
          </div>
        }) : chats.map((result, index) => <div key={sessionKey(result.session)} ref={(element) => { resultRefs.current[index] = element }} id={`${id}-result-chats-${index}`} role="option" aria-selected={selectedIndex === index} tabIndex={-1} data-search-result className="gc-search-result gc-search-chat-result" onMouseEnter={() => setSelected(index)} onMouseDown={(event) => event.preventDefault()} onFocus={() => setSelected(index)} onClick={() => activate(index)}>
          <span className="gc-search-result-icon" aria-hidden="true"><MessageSquare size={15} strokeWidth={ICON_STROKE} /></span><div className="gc-search-result-copy"><strong>{result.title}</strong>{result.snippet.trim() !== result.title.trim() && <span>{result.snippet || 'No conversation text yet.'}</span>}<small>{workspaceLabel(result.session.cwd)} · {result.match === 'content' ? 'Conversation match · ' : ''}{new Date(result.session.savedAt).toLocaleDateString()}</small></div><ArrowUpRight size={15} strokeWidth={ICON_STROKE} className="gc-search-result-arrow" aria-hidden="true" />
        </div>)}
      </div>
      {count === 0 && <div className="gc-search-empty" role={mode === 'chats' && error ? 'alert' : 'status'}>
        <span className={`gc-search-empty-icon${mode === 'chats' && error ? ' error' : ''}`} aria-hidden="true">{mode === 'chats' && loading ? <i className="gc-spinner" /> : <EmptyIcon size={18} strokeWidth={ICON_STROKE} />}</span>
        <strong>{mode === 'commands' ? 'No matching commands' : chatEmpty[0]}</strong><p>{mode === 'commands' ? 'Try another name or a shorter search.' : chatEmpty[1]}</p>
      </div>}
    </div>
    <div className="gc-search-footer" id={`${id}-hint`}><span><kbd className="gc-kbd">↑</kbd><kbd className="gc-kbd">↓</kbd> to navigate</span><span><kbd className="gc-kbd">↵</kbd> {mode === 'commands' ? 'to run' : 'to open chat'}</span></div>
  </Modal>
}
