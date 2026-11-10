import type { ChatMessage } from './types'

type ActiveMessage = { current: string | null }
type MessageUpdate = (messages: ChatMessage[]) => ChatMessage[]

/** Capture stream identity before React queues or replays the state update. */
export function assistantTextUpdate(active: ActiveMessage, text: string, timestamp: number, createId: () => string): MessageUpdate | null {
  if (!text || (!active.current && !text.trim())) return null
  const messageId = active.current ?? createId()
  active.current = messageId
  return (messages) => {
    if (messages.some((message) => message.id === messageId)) {
      return messages.map((message) => message.id === messageId ? { ...message, content: message.content + text } : message)
    }
    return [...messages, { id: messageId, role: 'assistant', content: text, timestamp, streaming: true }]
  }
}

/**
 * What the current turn's assistant-text events added, newest last: the message
 * each went to (null: a leading whitespace chunk that was not shown) and its
 * length. Consecutive chunks to one message share an entry. A reply replayed
 * after a dropped stream removes its characters from the tail of this log.
 */
export type StreamLog = Array<{ id: string | null; chars: number }>

export function recordStreamed(log: StreamLog, id: string | null, chars: number) {
  if (chars <= 0) return
  const last = log[log.length - 1]
  if (last && last.id === id) last.chars += chars
  else log.push({ id, chars })
}

/**
 * Removes the last `chars` characters (string length, as the CLI counts them)
 * that the turn streamed: each message loses its share from its end, and one
 * left empty is removed. The active message stays active unless all of its
 * text went, so the replayed reply continues in place.
 */
export function streamedTrimUpdate(active: ActiveMessage, log: StreamLog, chars: number): MessageUpdate | null {
  const cut = new Map<string, number>()
  let remaining = chars
  while (remaining > 0 && log.length) {
    const last = log[log.length - 1]!
    const take = Math.min(last.chars, remaining)
    if (last.id) cut.set(last.id, (cut.get(last.id) ?? 0) + take)
    last.chars -= take; remaining -= take
    if (!last.chars) log.pop()
  }
  if (!cut.size) return null
  if (active.current && cut.has(active.current) && !log.some(entry => entry.id === active.current)) active.current = null
  return (messages) => messages.flatMap((message) => {
    const n = cut.get(message.id)
    if (!n) return [message]
    const content = message.content.slice(0, Math.max(0, message.content.length - n))
    return content ? [{ ...message, content }] : []
  })
}

export function assistantCompleteUpdate(active: ActiveMessage): MessageUpdate | null {
  const messageId = active.current
  active.current = null
  if (!messageId) return null
  return (messages) => messages
    .filter((message) => message.id !== messageId || Boolean(message.content.trim()))
    .map((message) => message.id === messageId ? { ...message, streaming: false } : message)
}
