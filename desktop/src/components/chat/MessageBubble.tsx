// One message in the conversation. Document, not chat bubbles: the assistant
// writes into the full reading column behind a small G mark; the user's prompt
// is a compact right-aligned card. Time, tokens and Copy appear on hover/focus.

import { memo, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { collapse } from '@/lib/motion'
import { AlertCircle, Check, ChevronRight, Copy, History } from 'lucide-react'
import { GLogo } from '@/icons'
import { copyToClipboard } from '@/lib/tauri'
import { swap } from '@/lib/motion'
import { Tooltip } from '../shell/Tooltip'
import { MarkdownContent } from './MarkdownContent'
import type { ChatMessage } from './types'
import { GhostButton } from '../shell/Button'
import { CONTINUE_TURN, isIterationLimit, parseContinuation, type ContinuationParts } from '../../../../src/shared/execution'

const COPIED_MS = 1600

// One shared formatter: constructing an Intl.DateTimeFormat per message per
// render was a measurable share of opening a long saved chat.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function timeLabel(timestamp: number) {
  return TIME_FORMAT.format(timestamp)
}

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await copyToClipboard(text)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
  }
  return (
    <>
      <Tooltip content={copied ? 'Copied' : 'Copy'}>
        <button type="button" className="gc-message-action" onClick={() => void copy()} aria-label="Copy message" data-copied={copied ? '' : undefined}>
          <AnimatePresence initial={false}>
            <motion.span key={copied ? 'check' : 'copy'} className="gc-icon-swap" variants={swap} initial="initial" animate="animate" exit="exit">
              {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
            </motion.span>
          </AnimatePresence>
        </button>
      </Tooltip>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </>
  )
}

function MessageMeta({ message, copyable }: { message: ChatMessage; copyable: boolean }) {
  return (
    <footer className="gc-message-meta">
      <span className="gc-message-meta-text">
        {message.pending ? 'Queued' : timeLabel(message.timestamp)}
        {message.metadata?.tokenCount != null && <> · {message.metadata.tokenCount} tokens</>}
      </span>
      {copyable && <CopyMessage text={message.content} />}
    </footer>
  )
}

interface Props {
  message: ChatMessage
  /** Keep the meta row and actions visible (the latest assistant reply). */
  pinActions?: boolean
  onSend?: (text: string) => void
  continueDisabled?: boolean
  /** Starts a new chat: offered by an error whose next step is one (the session is open elsewhere). */
  onNewChat?: () => void
  onResumeSession?: (sessionId: string) => void
}

// Memoised: the session keeps unchanged messages as the same objects, so a
// streamed token or any App-level state change re-renders only the message
// that changed instead of the whole history.
export const MessageBubble = memo(function MessageBubble({ message, pinActions = false, onSend, continueDisabled, onNewChat, onResumeSession }: Props) {
  if (message.role === 'system') {
    return <div className="gc-message-system"><span>{message.content}</span></div>
  }

  if (message.role === 'error') {
    return (
      <article className="gc-message gc-message-error">
        <AlertCircle className="gc-message-error-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
        <div className="gc-message-error-body">
          <div className="gc-message-text">{message.content}</div>
          {onSend && isIterationLimit(message.content) && <GhostButton disabled={continueDisabled} onClick={() => onSend(CONTINUE_TURN)}>Continue</GhostButton>}
          {onNewChat && message.metadata?.action === 'new-chat' && <GhostButton onClick={onNewChat}>New chat</GhostButton>}
          {onResumeSession && message.metadata?.action === 'resume-session' && message.metadata.sessionId && <GhostButton onClick={() => onResumeSession(message.metadata!.sessionId!)}>Resume chat</GhostButton>}
          {message.streaming && <span className="gc-stream-caret" aria-label="Streaming" />}
          <MessageMeta message={message} copyable={false} />
        </div>
      </article>
    )
  }

  if (message.role === 'user') {
    const continuation = parseContinuation(message.content)
    if (continuation) return <ContinuationCard message={message} parts={continuation} pinActions={pinActions} />
    return (
      <article className="gc-message gc-message-user" data-pinned={pinActions ? '' : undefined} data-pending={message.pending ? '' : undefined}>
        <div className="gc-message-card">
          <div className="gc-message-text">{message.content}</div>
          {message.streaming && <span className="gc-stream-caret" aria-label="Streaming" />}
        </div>
        <MessageMeta message={message} copyable={!message.streaming} />
      </article>
    )
  }

  const streaming = !!message.streaming
  return (
    <article className="gc-message gc-message-assistant" data-streaming={streaming ? '' : undefined} data-pinned={pinActions && !streaming ? '' : undefined}>
      <div className="gc-message-mark" aria-hidden="true"><GLogo size={20} /></div>
      <div className="gc-message-body">
        <MarkdownContent content={message.content} streaming={streaming} caret={streaming} />
        <MessageMeta message={message} copyable={!streaming} />
      </div>
    </article>
  )
})

/** The first message of a session that took over after a handoff: the request it continues, with the handoff behind a disclosure. */
function ContinuationCard({ message, parts, pinActions }: { message: ChatMessage; parts: ContinuationParts; pinActions: boolean }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const file = parts.path?.split('/').slice(-3).join('/')
  return (
    <article className="gc-message gc-message-user gc-continuation" data-pinned={pinActions ? '' : undefined}>
      <div className="gc-message-card">
        <div className="gc-continuation-eyebrow"><History size={14} strokeWidth={1.75} aria-hidden="true" />Continued from session {parts.previousSessionId.slice(0, 8)}</div>
        <div className="gc-message-text">{parts.request ?? 'The original request was not recorded; see the handoff.'}</div>
        <button type="button" className="gc-continuation-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />{open ? 'Hide handoff' : 'Show handoff'}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div key="handoff" id={bodyId} className="gc-continuation-body" variants={collapse} initial="initial" animate="animate" exit="exit">
              <div className="gc-continuation-notes"><MarkdownContent content={parts.handoff} /></div>
              {file && <div className="gc-continuation-path" title={parts.path}>Saved at …/{file}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <MessageMeta message={message} copyable />
    </article>
  )
}
