export type MessageRole = 'user' | 'assistant' | 'system' | 'error'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  streaming?: boolean
  /** A user message sent while a turn ran that the CLI has not added to the conversation yet. */
  pending?: boolean
  /** `action`: an error that offers a next step ('new-chat': the session is open in another G-Code process). `steer`: saved by the CLI for text sent while its turn ran. `attachments`: files sent with a user message. */
  metadata?: { tokenCount?: number; interrupted?: boolean; reason?: string; action?: 'new-chat' | 'resume-session'; sessionId?: string; steer?: boolean; attachments?: import('../../../../src/shared/attachments').AttachmentRef[] }
}

export type ToolState = import('../../../../src/shared/runtimeEvents').ToolPhase

export interface ToolExecution {
  id: string
  name: string
  state: ToolState
  input?: unknown
  output?: unknown
  error?: string
  startedAt: number
  /** When it began to execute (startedAt is when its arguments began to stream); absent in older sessions. */
  runningAt?: number
  completedAt?: number
  updatedAt?: number
  detail?: string
  inputPreview?: string
  inputChars?: number
}

export interface ToolApprovalRequest {
  toolName: string
  description: string
  reason?: string
  filePath?: string
  input?: unknown
  source?: string
}
