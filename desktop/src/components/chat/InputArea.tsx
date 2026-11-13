import { useEffect, useId, useRef, useState, type ClipboardEvent, type MouseEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { ArrowUp, ChevronDown, FileText, FolderOpen, Image as ImageIcon, Plus, Square, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { ProviderTile } from '../providers/ProviderTile'
import { Tooltip } from '../shell/Tooltip'
import { PROVIDER_DISPLAY, type ProviderName } from '@/lib/providers'
import { workspaceLabel } from '@/lib/workspace'
import { easeOut, swap } from '@/lib/motion'
import { shortModelName } from '../../../../src/shared/modelNames'
import { mergeDraft } from './turnEvents'
import { discardPastedImage, inspectAttachments, isTauri, savePastedImage, type AttachmentInfo } from '@/lib/tauri'
import { addAttachments, attachmentRefs, attachmentSendBlock, fileBase64, thumbnail, type ComposerAttachment } from '@/lib/attachments'
import { MAX_ATTACHMENTS, attachmentSize, type AttachmentRef } from '../../../../src/shared/attachments'

interface Props {
  sessionControls?: ReactNode
  streaming: boolean
  activity?: string
  sendDisabledReason?: string
  history: string[]
  /** Also called while a turn streams: the text then steers that turn (never with attachments). */
  onSend: (text: string, attachments?: AttachmentRef[]) => void
  onAbort: () => void
  provider?: ProviderName
  model?: string
  onProviderClick?: () => void
  cwd?: string
  projectLabel?: string
  onOpenProject?: () => void
  /** Text handed back to the composer; it goes before what is typed there now. Its attachments join the composer's. */
  draft?: { text: string; attachments?: AttachmentRef[] }
  /** Docked above the composer (tool approval). */
  tray?: ReactNode
}

/** Caption text changes: a quick crossfade with a 2px blur to mask the seam. */
const hintSwap: Variants = {
  initial: { opacity: 0, filter: 'blur(2px)' },
  animate: { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.15, ease: easeOut } },
  exit: { opacity: 0, filter: 'blur(2px)', transition: { duration: 0.1, ease: easeOut } },
}

/** While a turn runs, a message steers it as text only: files wait for the next message. */
export const ATTACH_WHILE_RUNNING = 'Attachments go with your next message, once this turn ends.'
const IDLE_HINT = 'Enter to send · Shift+Enter for a new line'

/**
 * The caption under the composer. A notice (files left out, files waiting for the turn to end) goes
 * first; while idle, why Send is off stays in view beside it. Otherwise the turn's activity, or why
 * Send is off, or how to send.
 */
export function composerHint({ notice, blocked, streaming, activity }: { notice?: string; blocked?: string; streaming: boolean; activity?: string }): string {
  if (notice) return blocked && !streaming ? `${notice} · ${blocked}` : notice
  return streaming ? (activity || 'Working…') : (blocked || IDLE_HINT)
}

/** An inspected file with its thumbnail drawn (images only). */
async function withThumbnail(info: AttachmentInfo): Promise<AttachmentInfo & { thumbnail?: string }> {
  if (info.kind !== 'image' || !info.preview || !info.mediaType) return info
  const drawn = await thumbnail(info.preview, info.mediaType)
  return { ...info, preview: undefined, ...(drawn ? { thumbnail: drawn } : {}) }
}

// Clicks on these keep their own behaviour; anything else in the card focuses the textarea.
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="dialog"]'

export function InputArea({ sessionControls, streaming, activity, sendDisabledReason, history, onSend, onAbort, provider, model, onProviderClick, cwd, projectLabel, onOpenProject, draft, tray }: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachmentList] = useState<ComposerAttachment[]>([])
  // The list as last set, for additions that finish after an await (a drop, a pick, a paste).
  const attached = useRef<ComposerAttachment[]>([])
  const setAttachments = (next: ComposerAttachment[]) => { attached.current = next; setAttachmentList(next) }
  // Screenshots pasted here and not sent yet: removing one deletes its file (nothing else refers to it).
  const pasted = useRef(new Set<string>())
  /** Why a file was left out, or why the message cannot go yet; shown in the caption until the next change. */
  const [notice, setNotice] = useState<string>()
  const [dropping, setDropping] = useState(false)
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
    if (!draft) return
    if (draft.text) setValue(current => mergeDraft(draft.text, current))
    if (draft.attachments?.length) setAttachments(addAttachments(draft.attachments.map(ref => ({ ...ref, bytes: ref.bytes ?? 0 })), attached.current).attachments)
    textarea.current?.focus()
  }, [draft])

  /** Adds inspected files to the list; says which were left out and why (`leftOut`: files there was no room for). */
  const attach = async (infos: AttachmentInfo[], leftOut = 0) => {
    const drawn = await Promise.all(infos.map(withThumbnail))
    const next = addAttachments(attached.current, drawn)
    setAttachments(next.attachments)
    const refused = [...next.refused, ...(leftOut ? [`${leftOut} more ${leftOut === 1 ? 'file was' : 'files were'} left out: one message takes at most ${MAX_ATTACHMENTS}`] : [])]
    setNotice(refused.length ? refused.join(' · ') : undefined)
    textarea.current?.focus()
  }
  // Only as many new files as there is room for are looked at: a dropped folder of photos would
  // otherwise send every image's bytes over IPC for thumbnails that are never shown.
  const attachPaths = async (paths: string[]) => {
    const fresh = paths.filter(path => !attached.current.some(attachment => attachment.path === path))
    const taken = fresh.slice(0, Math.max(0, MAX_ATTACHMENTS - attached.current.length))
    if (!fresh.length) return
    try { await attach(taken.length ? await inspectAttachments(taken) : [], fresh.length - taken.length) } catch (error) { setNotice(String(error)) }
  }
  const pickFiles = async () => {
    if (!isTauri()) return
    try {
      const picked = await open({ title: 'Attach files', multiple: true, directory: false, defaultPath: cwd })
      await attachPaths(picked === null ? [] : Array.isArray(picked) ? picked : [picked])
    } catch (error) { setNotice(String(error)) }
  }
  const removeAttachment = (path: string) => {
    setAttachments(attached.current.filter(attachment => attachment.path !== path))
    if (pasted.current.delete(path)) void discardPastedImage(path).catch(() => undefined)
    setNotice(undefined)
    textarea.current?.focus()
  }
  // A screenshot on the clipboard becomes a file of its own. Text on the clipboard pastes as text.
  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = [...event.clipboardData.items]
    if (items.some(item => item.kind === 'string' && item.type === 'text/plain')) return
    const images = items.filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file)
    if (!images.length || !isTauri()) return
    event.preventDefault()
    void (async () => {
      try {
        const saved = await Promise.all(images.map(async image => savePastedImage(await fileBase64(image))))
        for (const info of saved) if (!info.problem) pasted.current.add(info.path)
        await attach(saved)
      } catch (error) { setNotice(String(error)) }
    })()
  }
  // The while-running notice is about the turn that just ended.
  useEffect(() => { if (!streaming) setNotice(current => current === ATTACH_WHILE_RUNNING ? undefined : current) }, [streaming])
  // Files dropped anywhere on the window are attached here (the native drop carries their paths).
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined, gone = false
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload
      if (payload.type === 'enter' || payload.type === 'over') setDropping(true)
      else if (payload.type === 'leave') setDropping(false)
      else if (payload.type === 'drop') { setDropping(false); void attachPaths(payload.paths) }
    }).then(stop => { if (gone) stop(); else unlisten = stop }).catch(() => undefined)
    return () => { gone = true; unlisten?.() }
  }, []) // Registered once: attachPaths works through the ref and state setters only.

  const cycleHistory = (direction: 'previous' | 'next') => {
    if (!history.length) return
    const next = direction === 'previous'
      ? Math.max(0, historyIndex - 1)
      : Math.min(history.length, historyIndex + 1)
    setHistoryIndex(next)
    setValue(next === history.length ? '' : history[next] ?? '')
  }
  const attachBlock = attachmentSendBlock(attachments, provider, model)
  const submit = () => {
    const text = value.trim()
    if ((!text && !attachments.length) || sendDisabledReason || composing.current) return
    if (attachments.length && streaming) { setNotice(ATTACH_WHILE_RUNNING); return }
    if (attachBlock) { setNotice(attachBlock); return }
    onSend(text, attachments.length ? attachmentRefs(attachments) : undefined)
    pasted.current.clear() // Sent: the message refers to them now.
    setValue('')
    setAttachments([])
    setNotice(undefined)
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

  const sendDisabled = (!value.trim() && !attachments.length) || Boolean(sendDisabledReason) || Boolean(attachBlock)
  const hint = composerHint({ notice, blocked: sendDisabledReason || attachBlock, streaming, activity })
  // Progress counters ("Loading model… 42%") update in place; only a new message crossfades.
  const hintKey = `${streaming && !notice ? 'busy' : 'idle'}:${hint.replace(/[\d.,%]+/g, '#')}`
  const hasLeading = Boolean(provider || onOpenProject)
  // Cloud ids read short in the pill (claude-opus-5-5 → Opus 5.5); local file
  // and Ollama tag names stay as chosen. The full id stays in the tooltip and
  // the button's accessible description.
  const modelLabel = !model ? 'Choose a model' : provider === 'local' || provider === 'ollama' ? model.replace(/\.gguf$/i, '') : shortModelName(model)

  return (
    <div className="gc-input-region">
      {tray}
      <div className={`gc-composer${streaming ? ' is-streaming' : ''}${dropping ? ' is-dropping' : ''}`} onMouseDown={focusFromCard}>
        {attachments.length > 0 && <ul className="gc-attachments" aria-label="Attachments">
          {attachments.map(attachment => (
            <li key={attachment.path} className="gc-attachment" title={attachment.path}>
              {attachment.thumbnail
                ? <img className="gc-attachment-thumb" src={attachment.thumbnail} alt="" />
                : <span className="gc-attachment-icon" aria-hidden="true">{attachment.kind === 'image' ? <ImageIcon size={15} strokeWidth={1.75} /> : <FileText size={15} strokeWidth={1.75} />}</span>}
              <span className="gc-attachment-name">{attachment.name}</span>
              <span className="gc-attachment-size">{attachmentSize(attachment.bytes)}</span>
              <button type="button" className="gc-attachment-remove" onClick={() => removeAttachment(attachment.path)} aria-label={`Remove ${attachment.name}`}>
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>}
        <textarea
          ref={textarea}
          aria-label="Message G-Code"
          aria-describedby="composer-hint"
          rows={2}
          value={value}
          placeholder={streaming ? 'Add to this turn…' : 'Ask anything, or describe what you want to build…'}
          onChange={(event) => { setValue(event.target.value); if (notice) setNotice(undefined) }}
          onPaste={pasteImages}
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
          <Tooltip content="Attach files" align="start">
            <button type="button" className="gc-composer-pill gc-attach-button" onClick={() => void pickFiles()} aria-label="Attach files">
              <Plus size={17} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
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
                      title={sendDisabledReason || attachBlock || undefined}
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
        <span id="composer-hint" className={`gc-input-hint${streaming && !notice ? ' is-active' : ''}`} role="status">
          {streaming && !notice && <i className="gc-spinner" aria-hidden="true" />}
          <span className="gc-input-hint-text">
            <AnimatePresence initial={false}>
              <motion.span key={hintKey} className={streaming && !notice ? 'gc-shimmer-text' : undefined} variants={hintSwap} initial="initial" animate="animate" exit="exit">{hint}</motion.span>
            </AnimatePresence>
          </span>
        </span>
        {value.length > 0 && <span className="gc-character-count">{value.length.toLocaleString()} chars</span>}
      </div>
    </div>
  )
}
