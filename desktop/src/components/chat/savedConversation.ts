import type { SavedSession } from '../../lib/tauri'
import { terminalTool } from '../../../../src/shared/runtimeEvents'
import type { ChatMessage, ToolExecution } from './types'

export function savedConversation(saved: SavedSession, sessionId: string, cwd: string, provider: string) {
  if (saved.sessionId !== sessionId || saved.cwd !== cwd) throw new Error('Saved session identity does not match this project.')
  if (saved.provider && saved.provider !== provider) throw new Error(`This session uses ${saved.provider}. Select that provider before resuming it.`)
  const messages: ChatMessage[] = saved.messages.map((message) => ({ ...message, content: String(message.content), timestamp: message.timestamp ?? Date.now(), streaming: false }))
  // A message of attached files only has no words to recall with the arrow keys.
  return { messages, history: messages.filter((message) => message.role === 'user' && message.content).map((message) => message.content) }
}

/** A saved chat's tool cards: a call that never settled cannot still be running. */
export function savedTools(saved: SavedSession, now = Date.now()): ToolExecution[] {
  return (saved.toolHistory ?? []).map(tool => terminalTool(tool.state) ? tool : { ...tool, state: 'cancelled' as const, error: 'Previous process ended before this call settled', completedAt: now })
}

/** Discard only the unsaved turn; earlier completed conversation remains visible. */
export function beforeInterruptedTurn(messages: ChatMessage[], turnId?: string) {
  const boundary = turnId ? messages.findIndex((message) => message.id === turnId) : -1
  return (boundary < 0 ? messages : messages.slice(0, boundary)).map((message) => ({ ...message, streaming: false }))
}
