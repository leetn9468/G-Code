// Sidebar status lights for chats (macOS traffic-light colours):
//   running   — a turn is in progress (yellow, breathing)
//   attention — waiting for the user: a tool approval or the context-full question, or the turn ended in an error (red)
//   done      — the turn finished (green)
// View state only, derived from the chat session; nothing is persisted. Chats
// that ran no turn in this window show no light.

import { useCallback, useEffect, useReducer, useRef } from 'react'

export type SessionStatus = 'running' | 'attention' | 'done'

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  attention: 'Needs your attention',
  done: 'Finished',
}

const BOOT_SESSION = 'boot-0000'

export interface TurnState {
  /** send() was called; the turn starts when the chat starts streaming. */
  armed: boolean
  /** The turn that is streaming, with the chat's error count when it began. */
  running: { errors: number } | null
  /** How each chat's last turn in this window ended. */
  settled: Readonly<Record<string, SessionStatus>>
}

export type TurnEvent =
  | { type: 'begin' }
  | { type: 'streaming'; on: boolean; sessionId: string; errors: number }
  /** Stop, a new chat, another chat or project: the turn did not finish. */
  | { type: 'interrupt'; sessionId: string }

export const initialTurnState: TurnState = { armed: false, running: null, settled: {} }

export function turnReducer(state: TurnState, event: TurnEvent): TurnState {
  switch (event.type) {
    case 'begin':
      return state.armed ? state : { ...state, armed: true }
    case 'interrupt': {
      if (!state.armed && !state.running) return state
      // An unfinished turn must not leave an earlier turn's "Finished" behind.
      const { [event.sessionId]: _previous, ...settled } = state.settled
      return { armed: false, running: null, settled: state.running ? settled : state.settled }
    }
    case 'streaming':
      // Opening a saved chat streams too, but never after begin(): no light.
      if (event.on) return state.armed ? { ...state, armed: false, running: { errors: event.errors } } : state
      if (!state.running) return state
      if (event.sessionId === BOOT_SESSION) return { ...state, running: null }
      return {
        ...state,
        running: null,
        // Any error reported during the turn (not just a trailing one) needs the user.
        settled: { ...state.settled, [event.sessionId]: event.errors > state.running.errors ? 'attention' : 'done' },
      }
  }
}

export function statusOf(state: TurnState, live: { streaming: boolean; awaitingApproval: boolean }, sessionId: string, active: boolean): SessionStatus | undefined {
  if (active && live.awaitingApproval) return 'attention'
  if (active && state.running && live.streaming) return 'running'
  return state.settled[sessionId]
}

/**
 * `awaitingUser`: a tool approval or another question (the context-full choice) waits.
 * `takeover`: the session that takes over from a handoff is starting. Its turn
 * does not go through the composer's send (beginTurn), so it is armed here,
 * before its streaming starts, and lights like any other turn.
 */
export function useSessionStatus(sessionId: string, streaming: boolean, awaitingUser: boolean, errorCount: number, takeover = false) {
  const [state, dispatch] = useReducer(turnReducer, initialTurnState)
  const latest = useRef({ sessionId, errorCount })
  latest.current = { sessionId, errorCount }

  // Declared before the streaming effect: when both change in one render, the turn is armed first.
  useEffect(() => { if (takeover) dispatch({ type: 'begin' }) }, [takeover])
  useEffect(() => {
    dispatch({ type: 'streaming', on: streaming, sessionId: latest.current.sessionId, errors: latest.current.errorCount })
  }, [streaming])

  const beginTurn = useCallback(() => dispatch({ type: 'begin' }), [])
  const interrupt = useCallback(() => dispatch({ type: 'interrupt', sessionId: latest.current.sessionId }), [])
  const lightOf = useCallback((id: string, active: boolean) => statusOf(state, { streaming, awaitingApproval: awaitingUser }, id, active), [state, streaming, awaitingUser])

  return { beginTurn, interrupt, statusOf: lightOf }
}
