import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deleteSavedSession, isTauri, listAllSavedSessions, unreadableSessionCount, type SavedSession } from './tauri'
import { sessionKey } from './projects'

/**
 * One read at a time. A call made while a read is in flight gets the next
 * read, which starts when the current one settles and is shared by every call
 * made in the meantime — so each result still comes from a read that began
 * after the call, but a burst of calls costs at most two reads.
 */
export function coalescedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined
  let next: Promise<T> | undefined
  const start = () => {
    const current = running = read()
    const settle = () => { if (running === current) running = undefined }
    current.then(settle, settle)
    return current
  }
  return () => {
    if (next) return next
    if (!running) return start()
    next = running.then(() => {}, () => {}).then(() => { next = undefined; return start() })
    return next
  }
}

/** What the list says about saved chats it could not read; null when there are none. */
export function unreadableNotice(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `${count} saved ${count === 1 ? 'chat or project folder' : 'chats or project folders'} could not be read and ${count === 1 ? 'is' : 'are'} not listed. The files were left as they are.`
}

/** One global inventory shared by project groups, Recents, and search. */
export function useSavedSessions(currentSessionId: string, sessionRunning: boolean, streaming = false) {
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What the last delete left, and why (a chat open elsewhere). */
  const [left, setLeft] = useState<string | null>(null)
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const request = useRef(0)
  const deletingRef = useRef(false)
  // Resuming a chat flips session id and streaming several times within one
  // list read; each read goes over every saved session.
  const [listAll] = useState(() => coalescedRead(listAllSavedSessions))
  const refresh = useCallback(() => {
    const revision = ++request.current
    if (!isTauri()) return
    setLoading(true)
    void listAll().then((records) => {
      if (revision === request.current) { setSessions(records); setLoading(false); setError(null) }
      void unreadableSessionCount().then(count => { if (revision === request.current) setUnreadable(unreadableNotice(count)) }, () => {})
    }, (failure) => {
      if (revision === request.current) { setError(`Could not refresh chats: ${String(failure)}`); setLoading(false) }
    })
  }, [listAll])
  useEffect(() => { refresh(); return () => { request.current++ } }, [refresh, currentSessionId, sessionRunning, streaming])
  const remove = async (session: SavedSession) => {
    if (deletingRef.current) return
    deletingRef.current = true; setDeleting(sessionKey(session))
    setLeft(null)
    try { const stays = await deleteSavedSession(session.sessionId, session.cwd); setError(null); setLeft(stays || null); refresh() }
    catch (failure) { setError(`Could not delete chat: ${String(failure)}`) }
    finally { deletingRef.current = false; setDeleting(null) }
  }
  // A session nobody wrote anything in has nothing to show or resume, unless it is the one open now.
  const shown = useMemo(() => sessions.filter(session => (session.messageCount ?? session.messages.length) > 0 || session.sessionId === currentSessionId), [sessions, currentSessionId])
  return { sessions: shown, loading, error: error ?? left, unreadable, deleting, refresh, remove }
}
