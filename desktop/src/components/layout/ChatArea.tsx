import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { ArrowDown, FolderOutput, Cloud, Monitor, FolderOpen, FolderTree, GitCompareArrows, Globe, ListChecks, SquareTerminal } from 'lucide-react'
import { GLogo } from '@/icons'
import type { ProviderName } from '@/lib/providers'
import type { ExecutionEnvironment } from '@/lib/environments'
import { workspaceLabel } from '@/lib/workspace'
import { easeOut } from '@/lib/motion'
import { MessageBubble } from '../chat/MessageBubble'
import { ToolCard } from '../chat/ToolCard'
import { StepGroup, stepsLive } from '../chat/StepGroup'
import { InputArea } from '../chat/InputArea'
import { chatTitle as sessionTitle } from '../sessions/SessionList'
import { Tooltip } from '../shell/Tooltip'
import type { SideView } from './SidePanel'
import type { ChatMessage, ToolExecution } from '../chat/types'

interface Props {
  sessionControls?: ReactNode
  /** The header icons toggle the side panel's views; the event tells a pointer click (it slides) from the keyboard. */
  onOutputs?: (event: MouseEvent<HTMLButtonElement>) => void
  outputCount?: number
  /** The side panel's current view, if it is open. */
  sideView?: SideView | null
  /** Embedded terminal: its icon shows when this is wired. */
  onTerminal?: (event: MouseEvent<HTMLButtonElement>) => void
  /** Changes, Files, Browser and Tasks: their icons show after Outputs when this is wired. */
  onSidePanel?: (view: SidePanelView, event: MouseEvent<HTMLButtonElement>) => void
  /** Badge on Changes. */
  changeCount?: number
  /** Running background tasks: a breathing yellow dot on Tasks. */
  runningTaskCount?: number
  provider: ProviderName
  model: string
  messages: ChatMessage[]
  tools: ToolExecution[]
  streaming: boolean
  activity?: string
  cwd?: string
  projectLabel?: string
  environment?: ExecutionEnvironment
  onEnvironmentClick?: (event: MouseEvent<HTMLButtonElement>) => void
  onOpenProject: () => void
  onProviderClick?: () => void
  sendDisabledReason?: string
  history: string[]
  /** `attachments`: files attached in the composer (absent for a typed message without any, and for Continue). */
  onSend: (text: string, attachments?: import('../../../../src/shared/attachments').AttachmentRef[]) => void
  /** Starts a new chat, for an error that offers one. */
  onNewChat?: () => void
  onResumeSession?: (sessionId: string) => void
  onAbort: () => void
  /** Text handed back to the composer. */
  draft?: { text: string; attachments?: import('../../../../src/shared/attachments').AttachmentRef[] }
  /** Tool approval tray, docked to the composer while a request is pending. */
  approval?: ReactNode
  /** A saved chat is opening: keep the conversation on screen while the
   *  session is briefly empty instead of flashing the welcome state. */
  holdConversation?: boolean
}

export type SidePanelView = Extract<SideView, 'changes' | 'files' | 'browser' | 'tasks'>

type TimelineItem =
  | { kind: 'message'; key: string; timestamp: number; value: ChatMessage }
  | { kind: 'tool'; key: string; timestamp: number; value: ToolExecution }

type FlowEntry =
  | { kind: 'message'; key: string; item: Extract<TimelineItem, { kind: 'message' }> }
  | { kind: 'tools'; key: string; items: Array<Extract<TimelineItem, { kind: 'tool' }>> }

// Leaving the welcome state with more new items than this means a saved
// conversation was opened, not a message sent: render it without entrances.
const LIVE_BATCH = 2
// Items whose timestamp (ms) is older than this are history, never live.
const LIVE_WINDOW_MS = 60_000

// Opening a saved chat used to mount its whole history in one commit: every
// reply's markdown parse and code highlighting, then layout of all of it, in a
// single main-thread task (~0.2–0.3 s for a 230-message chat) that froze the
// sidebar pill and every other animation. Now only the newest entries, a bit
// more than a viewport of text, mount with the chat; older history mounts
// above them in chunks inside transitions, which React renders in short slices
// between frames, and the reading position is kept while it does. Sizes are
// in characters of text; an entry's chrome counts as a couple of lines.
const HISTORY_TAIL_MIN = 6
const HISTORY_CHUNK_CHARS = 4000

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function entryChars(entry: FlowEntry) {
  return entry.kind === 'message' ? entry.item.value.content.length + 200 : entry.items.length * 120
}

/** Walk back from `end` until `chars` of text (and `min` entries) are covered. */
function historyStart(flow: FlowEntry[], end: number, chars: number, min = 1) {
  let index = Math.min(end, flow.length)
  let weight = 0
  while (index > 0 && (weight < chars || end - index < min)) weight += entryChars(flow[--index])
  return index
}

/** About 1.2 viewports of prose (~3.5 characters per pixel of height at the chat size). */
const tailChars = () => Math.max(3000, (typeof window === 'undefined' ? 900 : window.innerHeight) * 4)

function isRecent(timestamp: number, now: number) {
  // Only judge real millisecond timestamps; anything else counts as live.
  return !(timestamp > 1e12 && now - timestamp > LIVE_WINDOW_MS)
}

// Header icons: 12px glyphs of the old labelled pills, enlarged 20% (user decision 2026-10-16).
const HEADER_ICON = 14.4

const EMPTY_GROUPS: ReadonlySet<string> = new Set()

/** Only crossing a layout breakpoint changes descendant styles. A container
 * query on the whole transcript restyles every old message on each resize. */
export function chatWidthClasses(width: number): string[] {
  return [width <= 871 && 'is-tight', width <= 640 && 'is-compact', width <= 520 && 'is-narrow'].filter(Boolean) as string[]
}

export function ChatArea({ sessionControls, onOutputs, outputCount, sideView = null, onTerminal, onSidePanel, changeCount, runningTaskCount, provider, model, messages: sessionMessages, tools: sessionTools, streaming, activity, cwd, projectLabel, environment = 'local', onEnvironmentClick, onOpenProject, onProviderClick, sendDisabledReason, history, onSend, onNewChat, onResumeSession, onAbort, draft, approval, holdConversation = false }: Props) {
  const chatRef = useRef<HTMLElement>(null)
  const widthClasses = useRef<string[]>([])
  const applyWidthClasses = () => {
    for (const name of ['is-tight', 'is-compact', 'is-narrow']) chatRef.current?.classList.toggle(name, widthClasses.current.includes(name))
  }
  // React updates className when the welcome state changes. Restore measured
  // breakpoints without reading layout again on every streamed token.
  useIsomorphicLayoutEffect(applyWidthClasses)
  useIsomorphicLayoutEffect(() => {
    const chat = chatRef.current
    if (!chat || typeof ResizeObserver === 'undefined') return
    const update = (width: number) => {
      widthClasses.current = chatWidthClasses(width)
      applyWidthClasses()
      const breadcrumb = chat.querySelector<HTMLElement>('.gc-project-breadcrumb')
      if (breadcrumb) breadcrumb.style.maxWidth = width <= 520 ? `${width * 0.58}px` : ''
    }
    update(chat.clientWidth)
    const observer = new ResizeObserver(entries => { if (entries[0]) update(entries[0].contentRect.width) })
    observer.observe(chat)
    return () => observer.disconnect()
  }, [])
  const reduce = useReducedMotion()
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, state: stick } = useStickToBottom({ resize: reduce ? 'instant' : 'smooth', initial: 'instant' })
  // Oldest flow entries of a just-opened chat that are not mounted yet.
  const [unmounted, setUnmounted] = useState(0)
  // Step groups the reader expanded, by group key. Held here rather than in
  // the group, so re-renders, history backfill and a remount keep it.
  const [openGroups, setOpenGroups] = useState(EMPTY_GROUPS)
  const toggleGroup = useCallback((key: string) => setOpenGroups((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  }), [])
  // Opening a saved chat clears the session before its history arrives. The
  // welcome state used to fill that gap for a frame or two: a visible flash and
  // two full repaints of the panel per switch. While the switch is pending the
  // conversation that is on screen stays there, and the new one replaces it in
  // one paint. Only what is on screen is held (null while the welcome shows).
  const shownRef = useRef<{ messages: ChatMessage[]; tools: ToolExecution[] } | null>(null)
  const held = holdConversation && sessionMessages.length === 0 && sessionTools.length === 0 ? shownRef.current : null
  const messages = held ? held.messages : sessionMessages
  const tools = held ? held.tools : sessionTools
  const empty = messages.length === 0 && tools.length === 0

  const timeline: TimelineItem[] = [
    // A queued message stays last until the CLI adds it to the conversation.
    ...messages.map((message) => ({ kind: 'message' as const, key: `message-${message.id}`, timestamp: message.pending ? Number.MAX_SAFE_INTEGER : message.timestamp, value: message })),
    ...tools.map((tool) => ({ kind: 'tool' as const, key: `tool-${tool.id}`, timestamp: tool.startedAt, value: tool })),
  ].sort((left, right) => left.timestamp - right.timestamp)

  // Entrances play once, for items appended live. Restored history (first
  // render, a saved conversation opened, a session switch) renders still.
  // Refs are only written in the layout effect, so StrictMode's double render
  // computes the same answer.
  const knownRef = useRef<Set<string> | null>(null)
  const enteringRef = useRef<Set<string>>(new Set())
  const known = knownRef.current
  const fresh = known ? timeline.filter((item) => !known.has(item.key)) : []
  const fromWelcome = known !== null && known.size === 0 && fresh.length > 0
  // Nothing on screen was there before: another conversation replaced this one.
  const replaced = known !== null && known.size > 0 && fresh.length > 0 && fresh.length === timeline.length
  const live = fresh.length > 0 && !replaced && (!fromWelcome || fresh.length <= LIVE_BATCH)
  const now = Date.now()
  const entering = live
    ? new Set([...enteringRef.current, ...fresh.filter((item) => isRecent(item.timestamp, now)).map((item) => item.key)])
    : enteringRef.current
  // Land on the latest message instantly instead of spring-scrolling through history.
  const jumpToEnd = fromWelcome || replaced
  // Another conversation starts with every group folded.
  if (jumpToEnd && openGroups.size > 0) setOpenGroups(EMPTY_GROUPS)

  useIsomorphicLayoutEffect(() => {
    shownRef.current = empty ? null : { messages, tools }
    const keys = new Set(timeline.map((item) => item.key))
    knownRef.current = keys
    enteringRef.current = new Set([...entering].filter((key) => keys.has(key)))
    if (jumpToEnd) void scrollToBottom('instant')
  })

  // use-stick-to-bottom only watches the content. When the viewport itself
  // grows while pinned (the approval tray closing, a taller window), the
  // browser clamps scrollTop and the hook reads that scroll as the reader
  // scrolling up, so the rest of the reply stopped following. Treat it like
  // the hook treats a content resize: flag a resize difference so that scroll
  // event is ignored, and clear it once the event has been handled (the same
  // rAF + timeout the hook uses for its own resizes).
  const pinnedRef = useRef(isAtBottom)
  pinnedRef.current = isAtBottom
  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    let height = viewport.clientHeight
    const observer = new ResizeObserver(() => {
      const grew = viewport.clientHeight - height
      height = viewport.clientHeight
      if (grew <= 0 || !pinnedRef.current) return
      stick.resizeDifference = grew
      requestAnimationFrame(() => setTimeout(() => { if (stick.resizeDifference === grew) stick.resizeDifference = 0 }, 1))
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [empty, scrollRef, stick])

  // Runs of consecutive tool calls share one rail; two or more fold into a
  // step group. A group is keyed by the message before it, not by its first
  // tool: the session keeps only the last 100 tools, and dropping the oldest
  // must not remount a visible group (that would replay entrances and
  // collapse expanded rows).
  const flow: FlowEntry[] = []
  let after = 'start'
  for (const item of timeline) {
    const previous = flow[flow.length - 1]
    if (item.kind === 'tool') {
      if (previous?.kind === 'tools') previous.items.push(item)
      else flow.push({ kind: 'tools', key: `tools-after-${after}`, items: [item] })
    } else {
      flow.push({ kind: 'message', key: item.key, item })
      after = item.key
    }
  }
  // A group is live while the turn streams and nothing follows it yet.
  const lastEntry = flow[flow.length - 1]
  // A chat that replaced the view starts with only its newest entries mounted.
  const tailStart = jumpToEnd ? historyStart(flow, flow.length, tailChars(), HISTORY_TAIL_MIN) : -1
  if (tailStart >= 0 && tailStart !== unmounted) setUnmounted(tailStart)
  const hidden = tailStart >= 0 ? tailStart : Math.min(unmounted, flow.length)

  // Mount the next older chunk a frame after each commit, so the newest
  // entries paint first. The transition renders in slices and yields to
  // frames (and to typing or streaming, which interrupt it).
  const flowRef = useRef(flow)
  useEffect(() => {
    if (!hidden) return
    const frame = requestAnimationFrame(() => startTransition(() => setUnmounted((count) => historyStart(flowRef.current, count, HISTORY_CHUNK_CHARS))))
    return () => cancelAnimationFrame(frame)
  }, [hidden])

  // Entries mounted above the reader would push the view down (WebKit has no
  // scroll anchoring, and Chromium's is turned off meanwhile so both behave the
  // same). Before paint, stay pinned to the end or shift scrollTop by exactly
  // the height that was added above.
  const mountedFrom = useRef(0)
  useIsomorphicLayoutEffect(() => {
    flowRef.current = flow
    const added = jumpToEnd ? 0 : mountedFrom.current - hidden
    mountedFrom.current = hidden
    const viewport = scrollRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    if (added > 0 && stick.isAtBottom) stick.scrollTop = stick.targetScrollTop
    else if (added > 0) {
      const previousFirst = content.children[added] as HTMLElement | undefined
      const first = content.firstElementChild as HTMLElement | null
      if (previousFirst && first) stick.scrollTop = viewport.scrollTop + previousFirst.offsetTop - first.offsetTop
    }
    // Toggled here rather than rendered as a prop: it must still be set while
    // the last chunk is measured, or Chromium would anchor on top of the shift.
    viewport.toggleAttribute('data-backfill', hidden > 0)
  })

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  // Name the chat by its first prompt, like the sidebar row does.
  const chatTitle = messages.some((message) => message.role === 'user') ? sessionTitle({ messages }).split('\n')[0].trim() : undefined

  const send = (text: string, attachments?: import('../../../../src/shared/attachments').AttachmentRef[]) => {
    onSend(text, attachments)
    // A bare scrollToBottom() springs even under reduced motion; pass the mode.
    void scrollToBottom(reduce ? 'instant' : 'smooth')
  }

  return (
    <section ref={chatRef} className={`gc-chat ${empty ? 'gc-chat-welcome' : ''}`} aria-label="Chat">
      {/* The header is the window's title bar: "deep" lets the chat title and gaps drag the window; its buttons still click. */}
      <div className="gc-chat-header" data-tauri-drag-region="deep">
        <div className="gc-chat-breadcrumb">
          <button type="button" className="gc-project-breadcrumb" onClick={onOpenProject} title={cwd || 'Open project folder · ⌘O'} aria-label="Open project folder (⌘O)">
            <FolderOpen size={15} strokeWidth={1.75} /><span>{projectLabel || workspaceLabel(cwd)}</span>
          </button>
          <span className="gc-breadcrumb-divider" aria-hidden="true">/</span>
          <span className="gc-chat-heading" title={empty ? undefined : chatTitle || undefined}>{empty ? 'New chat' : chatTitle || 'Conversation'}</span>
        </div>
        <div className="gc-chat-header-spacer" />
        {/* Icon-only column at the panel's upper right: environment, terminal, outputs, then changes, files, browser and tasks. Each opens its view in the side panel (again: closes it). */}
        <div className="gc-chat-header-actions">
          {onEnvironmentClick && <Tooltip content={environment === 'local' ? 'Local · runs on this Mac' : 'Cloud · not configured'} side="left"><button type="button" className="gc-header-icon gc-environment-trigger" data-environment={environment} onClick={onEnvironmentClick} disabled={streaming && sideView !== 'environment'} aria-label="Choose execution environment" aria-pressed={sideView === 'environment'} aria-controls="gc-side-panel">{environment === 'local' ? <Monitor size={HEADER_ICON} strokeWidth={1.75} /> : <Cloud size={HEADER_ICON} strokeWidth={1.75} />}{environment === 'cloud' && <i className="gc-header-icon-warning" aria-hidden="true" />}</button></Tooltip>}
          {onTerminal && <Tooltip content="Terminal" shortcut="⌃`" side="left"><button type="button" className="gc-header-icon gc-terminal-trigger" onClick={onTerminal} aria-label="Toggle terminal" aria-pressed={sideView === 'terminal'} aria-controls="gc-terminal-panel"><SquareTerminal size={HEADER_ICON} strokeWidth={1.75} /></button></Tooltip>}
          <Tooltip content={outputCount ? `Outputs · ${outputCount} ${outputCount === 1 ? 'file' : 'files'}` : 'Outputs'} side="left"><button type="button" className="gc-header-icon gc-outputs-trigger" onClick={onOutputs} aria-label={outputCount ? `Outputs (${outputCount})` : 'Outputs'} aria-pressed={sideView === 'outputs'} aria-controls="gc-side-panel"><FolderOutput size={HEADER_ICON} strokeWidth={1.75} />{!!outputCount && <small aria-hidden="true">{outputCount}</small>}</button></Tooltip>
          {onSidePanel && <>
            <Tooltip content={changeCount ? `Changes · ${changeCount} ${changeCount === 1 ? 'file' : 'files'}` : 'Changes'} side="left"><button type="button" className="gc-header-icon gc-changes-trigger" onClick={(event) => onSidePanel('changes', event)} aria-label={changeCount ? `Changes (${changeCount})` : 'Changes'} aria-pressed={sideView === 'changes'} aria-controls="gc-side-panel"><GitCompareArrows size={HEADER_ICON} strokeWidth={1.75} />{!!changeCount && <small aria-hidden="true">{changeCount}</small>}</button></Tooltip>
            <Tooltip content="Files" side="left"><button type="button" className="gc-header-icon gc-files-trigger" onClick={(event) => onSidePanel('files', event)} aria-label="Files" aria-pressed={sideView === 'files'} aria-controls="gc-side-panel"><FolderTree size={HEADER_ICON} strokeWidth={1.75} /></button></Tooltip>
            <Tooltip content="Browser" side="left"><button type="button" className="gc-header-icon gc-browser-trigger" onClick={(event) => onSidePanel('browser', event)} aria-label="Browser" aria-pressed={sideView === 'browser'} aria-controls="gc-side-panel"><Globe size={HEADER_ICON} strokeWidth={1.75} /></button></Tooltip>
            <Tooltip content={runningTaskCount ? `Tasks · ${runningTaskCount} running` : 'Tasks'} side="left"><button type="button" className="gc-header-icon gc-tasks-trigger" onClick={(event) => onSidePanel('tasks', event)} aria-label={runningTaskCount ? `Tasks (${runningTaskCount} running)` : 'Tasks'} aria-pressed={sideView === 'tasks'} aria-controls="gc-side-panel"><ListChecks size={HEADER_ICON} strokeWidth={1.75} />{!!runningTaskCount && <i className="gc-header-icon-running" aria-hidden="true" />}</button></Tooltip>
          </>}
        </div>
      </div>

      <div className="gc-conversation-body">
        {empty && cwd ? (
          // With a project open the welcome is the mark and one line, centred on the panel.
          <div className="gc-chat-empty is-welcome">
            <div className="gc-welcome">
              <div className="gc-welcome-mark"><GLogo size={44} /></div>
              <p className="gc-welcome-line">A little clarity. A lot of possibility.</p>
            </div>
          </div>
        ) : empty ? (
          <div className="gc-chat-empty">
            <div className="gc-welcome-mark"><GLogo size={44} /></div>
            <div className="gc-welcome-eyebrow">A little clarity. A lot of possibility.</div>
            <h1>Open your project</h1>
            <p>Choose a folder. Bring your next idea to life.</p>
            <button type="button" onClick={onOpenProject} className="gc-btn gc-btn-primary gc-open-project"><FolderOpen size={16} strokeWidth={1.75} />Open project folder…<kbd className="gc-kbd inverse">⌘O</kbd></button>
          </div>
        ) : (
          <div className="gc-stream-viewport">
            <div ref={scrollRef} className="gc-message-stream">
              <div ref={contentRef} className="gc-chat-flow">
                {(hidden ? flow.slice(hidden) : flow).map((entry) => entry.kind === 'message'
                  ? (
                    <div key={entry.key} className={`gc-flow-item${entering.has(entry.key) ? ' gc-enter' : ''}`} data-kind={entry.item.value.role}>
                      <MessageBubble message={entry.item.value} pinActions={entry.item.value === lastAssistant} onSend={entry.item.value.role === 'error' ? onSend : undefined} continueDisabled={entry.item.value.role === 'error' && (streaming || !!sendDisabledReason)} onNewChat={entry.item.value.role === 'error' ? onNewChat : undefined} onResumeSession={entry.item.value.role === 'error' && entry.item.value.metadata?.action === 'resume-session' ? onResumeSession : undefined} />
                    </div>
                  )
                  : entry.items.length > 1
                  ? (
                    <StepGroup
                      key={entry.key}
                      groupKey={entry.key}
                      steps={entry.items.map((item) => ({ key: item.key, tool: item.value, entering: entering.has(item.key) }))}
                      live={stepsLive(entry.items.map((item) => item.value), streaming, entry === lastEntry)}
                      expanded={openGroups.has(entry.key)}
                      onToggle={toggleGroup}
                    />
                  )
                  : (
                    <div key={entry.key} className="gc-flow-item gc-tool-group" data-kind="tools">
                      {entry.items.map((item) => (
                        <div key={item.key} className={`gc-tool-slot${entering.has(item.key) ? ' gc-enter' : ''}`}>
                          <ToolCard tool={item.value} />
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
            <AnimatePresence>
              {!isAtBottom && (
                <motion.div
                  key="jump"
                  className="gc-scroll-bottom-wrap"
                  initial={{ opacity: 0, transform: reduce ? 'none' : 'translateY(8px) scale(0.96)' }}
                  animate={{ opacity: 1, transform: 'none', transition: { duration: 0.2, ease: easeOut } }}
                  exit={{ opacity: 0, transform: reduce ? 'none' : 'translateY(4px) scale(0.96)', transition: { duration: 0.15, ease: easeOut } }}
                >
                  <Tooltip content="Jump to latest">
                    <button
                      className="gc-scroll-bottom"
                      type="button"
                      aria-label="Jump to latest"
                      onClick={(event) => {
                        void scrollToBottom(reduce ? 'instant' : 'smooth')
                        // The button unmounts once the stream reaches the bottom; a
                        // keyboard press (detail 0) hands focus to the composer
                        // instead of dropping it to <body>.
                        if (event.detail !== 0) return
                        const chat = event.currentTarget.closest('.gc-chat')
                        const next = chat?.querySelector<HTMLElement>('.gc-composer textarea:not(:disabled)') ?? chat?.querySelector<HTMLElement>('.gc-abort-button')
                        next?.focus({ preventScroll: true })
                      }}
                    >
                      <ArrowDown size={16} strokeWidth={1.75} />
                    </button>
                  </Tooltip>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <InputArea sessionControls={sessionControls} sendDisabledReason={sendDisabledReason} streaming={streaming} activity={activity} history={history} onSend={send} onAbort={onAbort} draft={draft} provider={provider} model={model} onProviderClick={onProviderClick} cwd={cwd} projectLabel={projectLabel} onOpenProject={onOpenProject} tray={approval} />

      </div>
    </section>
  )
}
