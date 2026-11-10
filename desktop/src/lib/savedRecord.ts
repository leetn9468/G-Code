import { validateBudget, type SessionBudget } from '../../../src/shared/sessionBudget'
import type { SavedSession } from './tauri'

/**
 * A saved record comes from disk: an older version or a hand edit can give any field any shape, and the
 * UI reads them directly, so one bad record took down the whole window (on every launch for
 * "messages":[null]). Each record is made safe once, here: a bad message is dropped, and a bad optional
 * field counts as absent. What the engine must enforce (a held budget, a network hold) it checks itself
 * when the chat resumes; this only decides what the window shows.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function usageTotals(value: unknown) {
  return isRecord(value) && finite(value.requests) && Array.isArray(value.byModel) && value.byModel.every(isRecord) ? value : undefined
}

function contextStatus(value: unknown) {
  if (!isRecord(value) || !finite(value.used) || !finite(value.limit)) return undefined
  const totals = usageTotals(value.usageTotals)
  const { usageTotals: _dropped, lastUsage, ...rest } = value
  return {
    ...rest,
    ...Object.fromEntries(['system', 'tools', 'conversation', 'reserved', 'safety', 'compactions'].map(field => [field, finite(value[field]) ? value[field] : 0])),
    ...(isRecord(lastUsage) ? { lastUsage } : {}), ...(totals ? { usageTotals: totals } : {}),
  }
}

function budget(value: unknown): SessionBudget | undefined {
  if (!isRecord(value)) return undefined
  try { validateBudget(value as unknown as SessionBudget); return value as unknown as SessionBudget } catch { return undefined }
}

function networkHold(value: unknown) {
  if (!isRecord(value) || !isRecord(value.incident)) return undefined
  const { id, destination, path } = value.incident
  return typeof id === 'string' && typeof destination === 'string' && typeof path === 'string' ? value : undefined
}

/** The record with anything the window cannot show left out. */
export function usableSavedSession(value: SavedSession): SavedSession {
  if (!isRecord(value)) return value
  const raw = value as unknown as Record<string, unknown>
  const { contextStatus: _context, outputs: _outputs, budget: _budget, toolHistory: _tools, networkHold: _hold, usageTotals: _usage, permissionContext: _permission, ...rest } = raw
  const context = contextStatus(raw.contextStatus), hold = networkHold(raw.networkHold), held = budget(raw.budget), totals = usageTotals(raw.usageTotals)
  return {
    ...rest,
    messages: (Array.isArray(raw.messages) ? raw.messages : []).filter(message => isRecord(message) && typeof message.role === 'string' && typeof message.content === 'string'),
    savedAt: finite(raw.savedAt) ? raw.savedAt : 0,
    ...(context ? { contextStatus: context } : {}),
    ...(Array.isArray(raw.outputs) ? { outputs: raw.outputs.filter(output => isRecord(output) && typeof output.path === 'string' && finite(output.updatedAt)) } : {}),
    ...(Array.isArray(raw.toolHistory) ? { toolHistory: raw.toolHistory.filter(tool => isRecord(tool) && typeof tool.id === 'string' && typeof tool.name === 'string' && typeof tool.state === 'string') } : {}),
    ...(held ? { budget: held } : {}), ...(hold ? { networkHold: hold } : {}), ...(totals ? { usageTotals: totals } : {}),
    ...(isRecord(raw.permissionContext) && typeof raw.permissionContext.mode === 'string' ? { permissionContext: raw.permissionContext } : {}),
  } as unknown as SavedSession
}
