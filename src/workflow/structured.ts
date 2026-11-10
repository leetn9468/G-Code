import Ajv, { type ValidateFunction } from 'ajv'
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
const cache = new Map<string, { validate: ValidateFunction; errors: () => string }>()

export function schemaValidator(schema: Record<string, unknown>) {
  const key = JSON.stringify(schema)
  const cached = cache.get(key)
  if (cached) return cached
  const options = { allErrors: true, strict: false, validateFormats: false }
  const validator = String(schema.$schema ?? '').includes('2020-12') ? new Ajv2020(options)
    : String(schema.$schema ?? '').includes('2019-09') ? new Ajv2019(options) : new Ajv(options)
  const validate = validator.compile(schema)
  if ((validate as { $async?: boolean }).$async) throw new Error('Workflow schemas must be synchronous')
  const compiled = { validate, errors: () => validator.errorsText(validate.errors) }
  // Schemas are model-authored; bound the process cache without limiting runs.
  if (cache.size >= 256) cache.delete(cache.keys().next().value!)
  cache.set(key, compiled)
  return compiled
}

/** Last complete JSON object, respecting strings and nested braces. */
export function lastJSONObject(text: string): unknown {
  let depth = 0, start = -1, quoted = false, escape = false
  const blocks: string[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (depth && quoted) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') quoted = false
      continue
    }
    if (depth && char === '"') quoted = true
    else if (char === '{') { if (depth++ === 0) start = index }
    else if (char === '}' && depth && --depth === 0) blocks.push(text.slice(start, index + 1))
  }
  if (!blocks.length) throw new Error('Final answer contains no JSON object')
  return JSON.parse(blocks.at(-1)!)
}
