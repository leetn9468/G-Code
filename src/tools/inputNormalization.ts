/**
 * Tool input as the schema expects it, from the shapes models commonly send instead: a whole input
 * sent as a JSON string, a number or boolean sent as a string, an object or array sent as JSON
 * text. Only exact forms convert ("12", "true", '{"a":1}'); anything else is left for the schema
 * to reject. The input is never changed in place: the tool_use block in history keeps what the
 * model sent, and a new value is returned only when something converted.
 */

import { ZodFirstPartyTypeKind, type ZodIssue, type ZodTypeAny } from 'zod'

const NUMERIC = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/
const BOOLEAN = /^(?:true|false)$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The schema under Optional, Default, Nullable and Effects (refine, transform, preprocess). */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  for (let depth = 0; depth < 16; depth++) {
    const def = schema._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny }
    if (def.typeName === ZodFirstPartyTypeKind.ZodOptional || def.typeName === ZodFirstPartyTypeKind.ZodDefault || def.typeName === ZodFirstPartyTypeKind.ZodNullable) schema = def.innerType!
    else if (def.typeName === ZodFirstPartyTypeKind.ZodEffects) schema = def.schema!
    else return schema
  }
  return schema
}

const kind = (schema: ZodTypeAny) => (unwrap(schema)._def as { typeName?: string }).typeName

function parseJSON(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** One value converted to what `schema` expects, or the value itself. */
function coerce(schema: ZodTypeAny, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  switch (kind(schema)) {
    case ZodFirstPartyTypeKind.ZodNumber: return NUMERIC.test(text) ? Number(text) : value
    case ZodFirstPartyTypeKind.ZodBoolean: return BOOLEAN.test(text) ? text.toLowerCase() === 'true' : value
    case ZodFirstPartyTypeKind.ZodObject:
    case ZodFirstPartyTypeKind.ZodRecord: { if (!text.startsWith('{')) return value; const parsed = parseJSON(text); return isRecord(parsed) ? parsed : value }
    case ZodFirstPartyTypeKind.ZodArray: { if (!text.startsWith('[')) return value; const parsed = parseJSON(text); return Array.isArray(parsed) ? parsed : value }
    default: return value
  }
}

/** An object's fields converted; with `items`, also the fields of objects inside its array fields. */
function normalizeFields(schema: ZodTypeAny, input: Record<string, unknown>, items: boolean): Record<string, unknown> {
  const object = unwrap(schema)
  if ((object._def as { typeName?: string }).typeName !== ZodFirstPartyTypeKind.ZodObject) return input
  const shape = (object._def as { shape: () => Record<string, ZodTypeAny> }).shape()
  let out: Record<string, unknown> | undefined
  for (const [key, field] of Object.entries(shape)) {
    if (!(key in input)) continue
    let value = coerce(field, input[key])
    const array = items && Array.isArray(value) ? unwrap(field) : undefined
    if (array && (array._def as { typeName?: string }).typeName === ZodFirstPartyTypeKind.ZodArray) {
      const element = (array._def as { type: ZodTypeAny }).type
      const list = value as unknown[]
      let changed: unknown[] | undefined
      list.forEach((item, index) => {
        const next = isRecord(item) ? normalizeFields(element, item, false) : item
        if (next !== item) (changed ??= [...list])[index] = next
      })
      if (changed) value = changed
    }
    if (value !== input[key]) (out ??= { ...input })[key] = value
  }
  return out ?? input
}

/** The input a tool receives (and its failure-budget identity uses); `input` itself is never mutated. */
export function normalizeToolInput(schema: ZodTypeAny, input: unknown): unknown {
  let value = input
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    const parsed = parseJSON(value.trim())
    if (isRecord(parsed)) value = parsed
  }
  return isRecord(value) ? normalizeFields(schema, value, true) : value
}

// ============================================================================
// Validation errors
// ============================================================================

function pathText(path: Array<string | number>): string {
  if (!path.length) return 'input'
  return path.map((part, index) => typeof part === 'number' ? `[${part}]` : index ? `.${part}` : part).join('')
}

/** The keys of the object schema at `path`, for naming the valid ones. */
function keysAt(schema: ZodTypeAny, path: Array<string | number>): string[] {
  let current: ZodTypeAny | undefined = schema
  for (const part of path) {
    if (!current) return []
    const def = unwrap(current)._def as { typeName?: string; shape?: () => Record<string, ZodTypeAny>; type?: ZodTypeAny }
    current = def.typeName === ZodFirstPartyTypeKind.ZodObject ? def.shape!()[String(part)]
      : def.typeName === ZodFirstPartyTypeKind.ZodArray ? def.type : undefined
  }
  if (!current) return []
  const def = unwrap(current)._def as { typeName?: string; shape?: () => Record<string, ZodTypeAny> }
  return def.typeName === ZodFirstPartyTypeKind.ZodObject ? Object.keys(def.shape!()) : []
}

function issueLine(schema: ZodTypeAny, issue: ZodIssue): string {
  const at = pathText(issue.path)
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? `- ${at}: missing (expected ${issue.expected})` : `- ${at}: expected ${issue.expected}, received ${issue.received}`
    case 'invalid_enum_value':
      return `- ${at}: expected one of ${issue.options.map(option => JSON.stringify(option)).join(', ')}, received ${JSON.stringify(issue.received)}`
    case 'invalid_literal':
      return `- ${at}: expected ${JSON.stringify(issue.expected)}, received ${JSON.stringify(issue.received)}`
    case 'unrecognized_keys': {
      const valid = keysAt(schema, issue.path)
      return `- ${at}: unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${issue.keys.join(', ')}${valid.length ? `; valid keys: ${valid.join(', ')}` : ''}`
    }
    default:
      return `- ${at}: ${issue.message}`
  }
}

/** A failed parse as one compact line per issue: where, what was expected, what came instead. */
export function formatInputIssues(schema: ZodTypeAny, issues: ZodIssue[]): string {
  return issues.map(issue => issueLine(schema, issue)).join('\n')
}
