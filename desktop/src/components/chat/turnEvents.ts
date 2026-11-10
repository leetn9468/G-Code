// Events inside a running turn: steering (user text sent while the turn runs)
// and the replay of a reply that failed mid-stream. Pure helpers; the session
// hook owns the state.

/** Where a steered text is: sent to the CLI, accepted, in the conversation, or back with the desktop. */
export type SteerState = 'queued' | 'delivered' | 'returned'
export interface SteerEvent { id: string; state: SteerState }
export interface ReplyRestart { attempt: number; max: number; reason: string; text: number; thinking: number; tools: string[] }

const STEER_STATES: readonly string[] = ['queued', 'delivered', 'returned']
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

/** A steer event as the hook reads it; null when it is not one. */
export function parseSteerEvent(payload: Record<string, unknown>): SteerEvent | null {
  if (payload.type !== 'steer' || typeof payload.id !== 'string' || !payload.id || !STEER_STATES.includes(String(payload.state))) return null
  return { id: payload.id, state: payload.state as SteerState }
}

/** A reply-restart event as the hook reads it; null without its counts. */
export function parseReplyRestart(payload: Record<string, unknown>): ReplyRestart | null {
  if (payload.type !== 'reply-restart') return null
  const attempt = count(payload.attempt), max = count(payload.max), text = count(payload.text)
  if (attempt === undefined || max === undefined || text === undefined) return null
  return {
    attempt, max, text, thinking: count(payload.thinking) ?? 0,
    reason: typeof payload.reason === 'string' ? payload.reason.trim() : '',
    tools: Array.isArray(payload.tools) ? payload.tools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0) : [],
  }
}

/** The composer's status until the replayed reply shows output. */
export function replyRestartStatus(restart: Pick<ReplyRestart, 'attempt' | 'max' | 'reason'>): string {
  const reason = restart.reason.replace(/[\s.;:…]+$/, '')
  const again = `requesting the reply again (${restart.attempt}/${restart.max})…`
  return reason ? `${reason}; ${again}` : again.charAt(0).toUpperCase() + again.slice(1)
}

/**
 * A command's shape: "/" and a name, then a space or the end. A path such as
 * "/Users/me/app" has a second "/" in its first word, so it is words for the
 * model. The CLI's REPL reads commands with the same pattern.
 */
const COMMAND = /^\/[A-Za-z][\w-]*(?:\s|$)/

/** Text the CLI reads as a command ("/compact", "/budget-add 5"), not as words for the model. */
export function isCommandText(text: string): boolean {
  return COMMAND.test(text.trimStart())
}

/**
 * Text that may join the running turn. A command never does (the terminal's
 * rule too): it waits for the turn to end and then goes out on its own, so it
 * runs as it would have if typed between turns.
 */
export function isSteerableText(text: string): boolean {
  return !isCommandText(text)
}

/** The commands the desktop runs itself by starting a new chat; the CLI never sees them. */
export function resetsConversation(text: string): boolean {
  return text === '/clear' || text === '/reset'
}

/** Returned steers go out as one ordinary message, oldest first. */
export function resendText(texts: string[]): string {
  return texts.join('\n\n')
}

/**
 * How many of the returned texts (oldest first) go out as the next message: a
 * command alone, since the CLI reads a whole message that starts with "/" as
 * one command and anything joined to it would become its argument; otherwise
 * the plain texts up to the next command, joined. 0 for none.
 */
export function nextResendCount(texts: string[]): number {
  if (!texts.length) return 0
  if (isCommandText(texts[0]!)) return 1
  const command = texts.findIndex(isCommandText)
  return command < 0 ? texts.length : command
}

/**
 * The texts Stop hands back to the composer: those the stopped turn did not
 * save. A steer the CLI took just before Stop is in the saved conversation
 * (a user message marked `steer`, timed when the CLI added it, so after the
 * desktop sent it); handing it back too would put it in front of the model
 * twice. Each saved message accounts for one text.
 */
export function unsavedSteers(steers: ReadonlyArray<{ text: string; at: number }>, saved?: ReadonlyArray<{ role: string; content: string; timestamp: number; metadata?: { steer?: boolean } }>): string[] {
  const taken = (saved ?? []).filter(message => message.role === 'user' && message.metadata?.steer === true)
  return steers.filter(steer => {
    const match = taken.findIndex(message => message.content === steer.text && message.timestamp >= steer.at)
    if (match < 0) return true
    taken.splice(match, 1)
    return false
  }).map(steer => steer.text)
}

/** Text that comes back to the composer goes before what the user is typing now. */
export function mergeDraft(restored: string, current: string): string {
  return current.trim() ? `${restored}\n\n${current}` : restored
}
