import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { ArrowUp, ChevronDown, FolderOpen, Square } from 'lucide-react'
import { ProviderTile } from '../providers/ProviderTile'
import { Tooltip } from '../shell/Tooltip'
import { PROVIDER_DISPLAY, type ProviderName } from '@/lib/providers'
import { workspaceLabel } from '@/lib/workspace'
import { easeOut, swap } from '@/lib/motion'
import { shortModelName } from '../../../../src/shared/modelNames'
import { mergeDraft } from './turnEvents'

interface Props {
  sessionControls?: ReactNode
  streaming: boolean
  activity?: string
  sendDisabledReason?: string
  history: string[]
  /** Also called while a turn streams: the text then steers that turn. */
  onSend: (text: string) => void
  onAbort: () => void
  provider?: ProviderName
  model?: string
  onProviderClick?: () => void
  cwd?: string
  projectLabel?: string
  onOpenProject?: () => void
  /** Text handed back to the composer; it goes before what is typed there now. */
  draft?: { text: string }
  /** Docked above the composer (tool approval). */
  tray?: ReactNode
}

/** Caption text changes: a quick crossfade with a 2px blur to mask the seam. */
const hintSwap: Variants = {
  initial: { opacity: 0, filter: 'blur(2px)' },
  animate: { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.15, ease: easeOut } },
  exit: { opacity: 0, filter: 'blur(2px)', transition: { duration: 0.1, ease: easeOut } },
}

// Clicks on these keep their own behaviour; anything else in the card focuses the textarea.
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="dialog"]'

export function InputArea({ sessionControls, streaming, activity, sendDisabledReason, history, onSend, onAbort, provider, model, onProviderClick, cwd, projectLabel, onOpenProject, draft, tray }: Props) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState(history.length)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const modelDescriptionId = useId()

  const resize = () => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 8 * 25)}px`
  }
  useEffect(resize, [value])
  useEffect(() => {
    const element = textarea.current
    if (!element) return
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize() }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => setHistoryIndex(history.length), [history.length])
  useEffect(() => {
    if (draft) { setValue(current => mergeDraft(draft.text, current)); textarea.current?.focus() }
  }, [draft])

  const cycleHistory = (direction: 'previous' | 'next') => {
    if (!history.length) return
    const next = direction === 'previous'
      ? Math.max(0, historyIndex - 1)
      : Math.min(history.length, historyIndex + 1)
    setHistoryIndex(next)
    setValue(next === history.length ? '' : history[next] ?? '')
  }
  const submit = () => {
    const text = value.trim()
    if (!text || sendDisabledReason || composing.current) return
    onSend(text)
    setValue('')
    setHistoryIndex(history.length)
  }

  useEffect(() => {
    const send = () => submit()
    const navigate = (event: Event) => cycleHistory((event as CustomEvent<'previous' | 'next'>).detail)
    document.addEventListener('gcode-send', send)
    document.addEventListener('gcode-history', navigate)
    return () => { document.removeEventListener('gcode-send', send); document.removeEventListener('gcode-history', navigate) }
  })

  // Clicking empty space in the card (padding, toolbar gaps) focuses the textarea.
  // Only for targets inside the card's own DOM: portaled menus and dialogs rendered
  // by the session controls bubble through React but must keep their own focus.
  const focusFromCard = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (event.button !== 0 || !event.currentTarget.contains(target) || target.closest(INTERACTIVE)) return
    const element = textarea.current
    if (!element || element.disabled) return
    event.preventDefault()
    element.focus()
  }

  const sendDisabled = !value.trim() || Boolean(sendDisabledReason)
  const hint = streaming ? (activity || 'Working…') : (sendDisabledReason || 'Enter to send · Shift+Enter for a new line')
  // Progress counters ("Loading model… 42%") update in place; only a new message crossfades.
  const hintKey = `${streaming ? 'busy' : 'idle'}:${hint.replace(/[\d.,%]+/g, '#')}`
  const hasLeading = Boolean(provider || onOpenProject)
  // Cloud ids read short in the pill (claude-opus-5-5 → Opus 5.5); local file
  // and Ollama tag names stay as chosen. The full id stays in the tooltip and
  // the button's accessible description.
  const modelLabel = !model ? 'Choose a model' : provider === 'local' || provider === 'ollama' ? model.replace(/\.gguf$/i, '') : shortModelName(model)

  return (
    <div className="gc-input-region">
      {tray}
      <div className={`gc-composer${streaming ? ' is-streaming' : ''}`} onMouseDown={focusFromCard}>
        <textarea
          ref={textarea}
          aria-label="Message G-Code"
          aria-describedby="composer-hint"
          rows={2}
          value={value}
          placeholder={streaming ? 'Add to this turn…' : 'Ask anything, or describe what you want to build…'}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
            if (event.key === 'ArrowUp' && !event.shiftKey && !value.includes('\n')) { event.preventDefault(); cycleHistory('previous') }
            if (event.key === 'ArrowDown' && !event.shiftKey && !value.includes('\n')) { event.preventDefault(); cycleHistory('next') }
          }}
        />
        <div className="gc-composer-toolbar">
          {provider && <Tooltip content={`${PROVIDER_DISPLAY[provider]} · ${model || 'Choose a model'}`} shortcut="⌘P" align="start">
            <button type="button" className="gc-composer-pill gc-model-picker" onClick={onProviderClick} disabled={!onProviderClick} aria-label="Choose provider and model (⌘P)" aria-describedby={modelDescriptionId} data-model={model || undefined}>
              <ProviderTile provider={provider} size={18} /><span>{modelLabel}</span><ChevronDown className="gc-pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
              <span id={modelDescriptionId} className="sr-only">{PROVIDER_DISPLAY[provider]} · {model || 'no model chosen'}</span>
            </button>
          </Tooltip>}
          {onOpenProject && <Tooltip content={cwd || 'Open a project'} align="start">
            <button type="button" className="gc-composer-pill gc-composer-project" onClick={onOpenProject} aria-label="Choose project folder">
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" /><span>{projectLabel || (cwd ? workspaceLabel(cwd) : 'Project')}</span>
            </button>
          </Tooltip>}
          {sessionControls && hasLeading && <span className="gc-toolbar-divider" aria-hidden="true" />}
          {sessionControls}
          <span className="gc-composer-spacer" />
          <div className="gc-send-slot">
            <AnimatePresence initial={false}>
              {streaming ? (
                <motion.span key="stop" className="gc-send-swap" variants={swap} initial="initial" animate="animate" exit="exit">
                  <button type="button" className="gc-abort-button" onClick={onAbort} aria-label="Abort generation">
                    <Square size={11} strokeWidth={2} fill="currentColor" aria-hidden="true" /><span>Stop</span>
                  </button>
                </motion.span>
              ) : (
                <motion.span key="send" className="gc-send-swap" variants={swap} initial="initial" animate="animate" exit="exit">
                  <Tooltip content="Send message" shortcut="↵" align="end">
                    <button
                      type="button"
                      className={`gc-send-button${sendDisabled ? '' : ' is-ready'}`}
                      onClick={submit}
                      disabled={sendDisabled}
                      aria-label="Send message"
                      title={sendDisabledReason || undefined}
                    >
                      <ArrowUp size={17} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      {/* While an approval tray is docked the run waits on the user, so
          composer.css settles the spinner into a static amber dot and stops
          the shimmer. It keys on the tray's DOM, which exists only while a
          request is pending (the `tray` element itself is always passed). */}
      <div className="gc-composer-caption">
        <span id="composer-hint" className={`gc-input-hint${streaming ? ' is-active' : ''}`} role="status">
          {streaming && <i className="gc-spinner" aria-hidden="true" />}
          <span className="gc-input-hint-text">
            <AnimatePresence initial={false}>
              <motion.span key={hintKey} className={streaming ? 'gc-shimmer-text' : undefined} variants={hintSwap} initial="initial" animate="animate" exit="exit">{hint}</motion.span>
            </AnimatePresence>
          </span>
        </span>
        {value.length > 0 && <span className="gc-character-count">{value.length.toLocaleString()} chars</span>}
      </div>
    </div>
  )
}
