/** Desktop messages travel as one JSON line, preserving multiline user input. */
export function parseInputLine(line: string): string {
  if (!line.startsWith('\x1e')) return line.trim()
  if (!line.endsWith('\x1e')) throw new Error('Incomplete desktop input frame')
  const frame = JSON.parse(line.slice(1, -1)) as { type?: unknown; text?: unknown }
  if (frame.type !== 'message' || typeof frame.text !== 'string') throw new Error('Invalid desktop input frame')
  return frame.text.trim()
}

/** Workflow controls bypass the turn queue so they can stop a busy engine. */
export function parseWorkflowControl(line: string): import('../workflow/tasks.js').WorkflowControl | null {
  if (!line.startsWith('\x1e') || !line.endsWith('\x1e')) return null
  const frame = JSON.parse(line.slice(1, -1))
  if (frame?.type !== 'workflow-control') return null
  if (typeof frame.runId !== 'string' || !frame.runId || !['skip', 'stop'].includes(frame.action)
    || frame.agentId !== undefined && typeof frame.agentId !== 'string'
    || frame.action === 'skip' && !frame.agentId) throw new Error('Invalid workflow-control frame')
  return { type: 'workflow-control', runId: frame.runId, agentId: frame.agentId, action: frame.action }
}

/** The desktop's answer to a context-full request. */
export function parseContextChoice(line: string): { requestId: string; choice: import('../shared/execution.js').ContextFullChoice } | null {
  if (!line.startsWith('\x1e') || !line.endsWith('\x1e')) return null
  const frame = JSON.parse(line.slice(1, -1))
  if (frame?.type !== 'context-choice') return null
  if (typeof frame.requestId !== 'string' || !frame.requestId || !['handoff', 'compact', 'stop'].includes(frame.choice)) throw new Error('Invalid context-choice frame')
  return { requestId: frame.requestId, choice: frame.choice }
}

/** Stop a background shell from the desktop's Tasks panel; bypasses the turn queue. */
export function parseTaskControl(line: string): { id: string; action: 'stop' } | null {
  if (!line.startsWith('\x1e') || !line.endsWith('\x1e')) return null
  const frame = JSON.parse(line.slice(1, -1))
  if (frame?.type !== 'task-control') return null
  if (typeof frame.id !== 'string' || !frame.id || frame.action !== 'stop') throw new Error('Invalid task-control frame')
  return { id: frame.id, action: 'stop' }
}

/** A message the desktop sends while a turn runs, to steer it; bypasses the turn queue. */
export function parseSteerFrame(line: string): { id: string; text: string } | null {
  if (!line.startsWith('\x1e') || !line.endsWith('\x1e')) return null
  const frame = JSON.parse(line.slice(1, -1))
  if (frame?.type !== 'steer') return null
  if (typeof frame.id !== 'string' || !frame.id || typeof frame.text !== 'string' || !frame.text.trim()) throw new Error('Invalid steer frame')
  return { id: frame.id, text: frame.text.trim() }
}
