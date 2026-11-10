import { createHash } from 'node:crypto'

/** JSON with object keys sorted at every level, so equal values always give the same text. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
