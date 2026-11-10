/** Live progress is separate from durable tool outcomes (DSH lifecycle reference). */
/** `refused`: the tool itself refused the call before it ran (a binary file, invalid input); `denied`: the user or the permission policy did. */
export const TOOL_PHASES = ['preparing', 'queued', 'validating', 'awaiting_approval', 'running', 'complete', 'failed', 'denied', 'refused', 'cancelled'] as const
export type ToolPhase = typeof TOOL_PHASES[number]
export const terminalTool = (phase: string) => ['complete', 'failed', 'denied', 'refused', 'cancelled'].includes(phase)
export const TOOL_LABELS: Record<ToolPhase, string> = { preparing: 'Preparing arguments', queued: 'Queued', validating: 'Validating', awaiting_approval: 'Awaiting approval', running: 'Running', complete: 'Complete', failed: 'Failed', denied: 'Denied', refused: 'Not run', cancelled: 'Cancelled' }
export interface ToolProgress {
  id: string; name: string; state: ToolPhase; startedAt: number; updatedAt?: number; completedAt?: number
  /** When the call began to execute; startedAt is when its arguments began to stream (its place in the timeline). */
  runningAt?: number
  input?: unknown; inputPreview?: string; inputChars?: number; output?: unknown; error?: string; detail?: string
}
/** One card per call; delayed progress cannot revive a settled outcome. */
export function mergeToolProgress(tools: ToolProgress[], next: ToolProgress): ToolProgress[] {
  const previous = tools.find(tool => tool.id === next.id)
  if (previous && terminalTool(previous.state)) return tools
  const value = { ...previous, ...next, startedAt: previous?.startedAt ?? next.startedAt }
  return previous ? tools.map(tool => tool.id === next.id ? value : tool) : [...tools, value].slice(-100)
}
export interface ModelRuntimeStatus {
  phase: 'file_check' | 'server_start' | 'model_loading' | 'ready' | 'failed' | 'cancelled' | 'stopped'
  requestedContext?: number; appliedContext?: number; contextReason?: string
  message: string; elapsedMs?: number; deadlineMs?: number; timestamp?: number
}
export interface InferenceMetrics { processing: boolean; promptTokens?: number; generatedTokens?: number; contextSize?: number; timestamp?: number }
/**
 * The engine discarded a reply that failed mid-stream and requests it again. A client drops the
 * last `text` characters of the turn's shown text and `thinking` characters of its shown thinking,
 * and removes the tool cards with these ids (the ids of the tool-state frames).
 */
export interface ReplyRestartEvent { type: 'reply-restart'; attempt: number; max: number; reason: string; text: number; thinking: number; tools: string[] }
/**
 * A message the user sent while a turn ran: accepted (`queued`), added to the conversation the model
 * sees within the turn (`delivered`), or not delivered in it (`returned`).
 */
export interface SteerEvent { type: 'steer'; id: string; state: 'queued' | 'delivered' | 'returned' }
