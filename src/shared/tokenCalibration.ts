/**
 * Provider tokens per local text estimate, bound to the model that supplied usage. `limit`: the
 * window the provider stated when it refused a request, when that is below what G-Code's catalog
 * says for the model (an account's window, a compatible vendor's).
 */
export interface TokenCalibration { model: string; scale: number; limit?: number }
/** A smaller stated limit is not taken: the session could not hold its own prompt and tools. */
export const MIN_LEARNED_LIMIT = 8_000

/** Persisted/IPC values are untrusted; do not coerce, clamp, or transfer between models. */
export function tokenCalibration(value: unknown, model?: string): TokenCalibration | undefined {
  if (!value || typeof value !== 'object') return
  const entry = value as Partial<TokenCalibration>
  if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 256
    || (model !== undefined && entry.model !== model)
    || typeof entry.scale !== 'number' || !Number.isFinite(entry.scale) || entry.scale < 0.5 || entry.scale > 4) return
  const limit = typeof entry.limit === 'number' && Number.isSafeInteger(entry.limit) && entry.limit >= MIN_LEARNED_LIMIT ? entry.limit : undefined
  return { model: entry.model, scale: entry.scale, ...(limit !== undefined ? { limit } : {}) }
}

export function parseTokenCalibration(text: string | undefined, model: string): TokenCalibration | undefined {
  if (!text || text.length > 2048) return
  try { return tokenCalibration(JSON.parse(text), model) } catch { return }
}
