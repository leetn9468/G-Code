// Looking at another chat while a task runs. The desktop has one CLI process and
// one live session (and, for a local model, one llama-server holding the model's
// memory), so opening a chat normally replaces it. While work is in progress that
// would end the work, so opening a chat only changes what is on screen: the live
// session, its process and the settings it was started from are left alone, and the
// chat shown here is read-only until the work is over.

import type { ContextStatus, SessionOutput } from '../../../src/shared/sessionControls'
import { terminalTool } from '../../../src/shared/runtimeEvents'
import type { BackgroundShellInfo } from '../../../src/shared/tasks'
import type { ChatMessage, ToolExecution } from '../components/chat/types'
import { savedConversation, savedTools } from '../components/chat/savedConversation'
import type { WorkflowRunView } from '../components/chat/useChatSession'
import type { SavedSession } from './tauri'

/** How long the work must stay over before the chat on screen takes the session: a workflow's end and the turn it starts are separate events. */
export const RUN_OVER_SETTLE_MS = 1000

export interface LiveWork {
  streaming: boolean
  /** A saved chat is being opened: `streaming` is on for it, but no work is running. */
  restoring: boolean
  takeover: boolean
  resendPending: boolean
  backgroundTasks: ReadonlyArray<Pick<BackgroundShellInfo, 'status'>>
  tools: ReadonlyArray<Pick<ToolExecution, 'name' | 'state'>>
  workflowRuns: Readonly<Record<string, Pick<WorkflowRunView, 'status'>>>
}

/** True while replacing the live session would end something: a turn, its handoff or resend, a sub-agent, a workflow, a background shell. */
export function workInProgress(live: LiveWork): boolean {
  return (live.streaming && !live.restoring) || live.takeover || live.resendPending
    || live.backgroundTasks.some(task => task.status === 'running')
    || live.tools.some(tool => (tool.name === 'Agent' || tool.name === 'Workflow') && !terminalTool(tool.state))
    || Object.values(live.workflowRuns).some(run => !run.status)
}

/** What the screen shows for a chat that is only being looked at. Shaped like the live session's fields, so the views need no second code path. */
export interface ChatView {
  sessionId: string
  messages: ChatMessage[]
  tools: ToolExecution[]
  history: string[]
  outputs: SessionOutput[]
  context: ContextStatus | null
  streaming: false
  activity: ''
  sessionRunning: false
  approval: null
  approvalQueue: []
  contextFull: null
  budget: null
  budgetOpen: false
  networkIncident: null
  networkOpen: false
  backgroundTasks: []
  workflowRuns: Record<string, never>
  takeover: false
}

const idle = {
  streaming: false, activity: '', sessionRunning: false, approval: null, approvalQueue: [], contextFull: null,
  budget: null, budgetOpen: false, networkIncident: null, networkOpen: false, backgroundTasks: [], workflowRuns: {}, takeover: false,
} as const satisfies Partial<ChatView>

export const BOOT_SESSION_ID = 'boot-0000'

export function emptyChatView(): ChatView {
  return { ...idle, approvalQueue: [], backgroundTasks: [], workflowRuns: {}, sessionId: BOOT_SESSION_ID, messages: [], tools: [], history: [], outputs: [], context: null }
}

/** A saved chat as it reads on disk. Uses the chat's own provider: nothing is resumed, so a different current provider is not a reason to refuse it. */
export function savedChatView(saved: SavedSession, sessionId: string, cwd: string, currentProvider: string): ChatView {
  const { messages, history } = savedConversation(saved, sessionId, cwd, saved.provider ?? currentProvider)
  return {
    ...idle, approvalQueue: [], backgroundTasks: [], workflowRuns: {}, sessionId, messages, history,
    tools: savedTools(saved), outputs: saved.outputs ?? [],
    context: saved.contextStatus ? { ...saved.contextStatus, usageTotals: saved.usageTotals ?? saved.contextStatus.usageTotals } : null,
  }
}

export type BrowseTarget =
  | { kind: 'saved'; session: SavedSession }
  /** A new chat: in this project folder, or outside projects without one. */
  | { kind: 'new'; project?: string }

export interface ChatBrowse {
  target: BrowseTarget
  cwd: string | undefined
  view: ChatView
  /** The work is over and the chat on screen is taking the session through the ordinary open path. */
  promoting?: boolean
}

const TITLE_CHARS = 60

/** The running chat's name for the notices: its first prompt's first line, in quotes. */
export function runningChatName(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const first = messages.find(message => message.role === 'user')
  const line = typeof first?.content === 'string' ? first.content.trim().split('\n')[0]!.trim() : ''
  if (!line) return 'Another chat'
  const chars = Array.from(line)
  return `“${chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('')}…` : line}”`
}

/** The notice above a chat that is only being looked at. */
export function browseNotice(name: string, waiting: boolean): string {
  return waiting ? `${name} is waiting for your answer. It stays paused until you open it.` : `${name} is still running. Reading this chat doesn’t stop it.`
}

/** Why the composer is closed in that chat. */
export function browseSendBlock(name: string, promoting: boolean): string {
  return promoting ? 'Opening this chat…' : `${name} is still running. Open it or stop it to send here.`
}
