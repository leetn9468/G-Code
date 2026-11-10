/**
 * The CLI refuses to open a session that another G-Code process has open (SessionLockedError in
 * src/state/store.ts): "Session <id> is open in another G-Code process (pid N). Close it there
 * first, or start a new chat." It arrives as start_session's error, or with a "Fatal:" prefix
 * from an older desktop backend that forwarded the stderr line.
 */
const SESSION_LOCKED = /^(?:Fatal:\s*)?Session ([A-Za-z0-9_-]+) is open in another G-Code process(?: \(pid (\d+)\))?\./
const SESSION_TAKEN_OVER = /^(?:Fatal:\s*)?Session ([A-Za-z0-9_-]+) was taken over by another G-Code process(?:\s|\.)/

export interface SessionLock { sessionId: string; pid?: number; lost?: boolean }

export function sessionLock(error: string): SessionLock | undefined {
  const takeover = SESSION_TAKEN_OVER.exec(error.trim())
  if (takeover) return { sessionId: takeover[1], lost: true }
  const match = SESSION_LOCKED.exec(error.trim())
  if (!match) return undefined
  return match[2] ? { sessionId: match[1], pid: Number(match[2]) } : { sessionId: match[1] }
}

/** What the chat says instead: what happened to the message, and what to do. */
export function sessionLockMessage(lock: SessionLock): string {
  if (lock.lost) return 'Another G-Code process took over this chat. This copy has stopped saving. Close the chat there, then resume here to load its latest saved progress.'
  return `This chat is open in another G-Code process${lock.pid ? ` (pid ${lock.pid})` : ''}, so your message was not sent. Close the chat there and send it again, or start a new chat.`
}
