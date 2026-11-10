/** Read the leading metadata declaration without evaluating JavaScript. */
export interface WorkflowMeta {
  name: string
  description: string
  phases?: string[]
  whenToUse?: string
}

export function parseWorkflow(source: string): { meta: WorkflowMeta; script: string } {
  let pos = 0
  const fail = (): never => { throw new Error(`Invalid workflow meta literal at offset ${pos}`) }
  const space = () => {
    for (;;) {
      const match = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(source.slice(pos))
      if (!match) break
      pos += match[0].length
    }
  }
  const token = (value: string) => {
    space()
    if (!source.startsWith(value, pos)) fail()
    pos += value.length
  }
  const string = (): string => {
    const quote = source[pos++]
    let result = ''
    while (pos < source.length) {
      const char = source[pos++]!
      if (char === quote) return result
      if (char === '\n' || char === '\r') fail()
      if (char !== '\\') { result += char; continue }
      const escape = source[pos++]!
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'" }
      if (escape === 'u' || escape === 'x') {
        const length = escape === 'u' ? 4 : 2
        const hex = source.slice(pos, pos + length)
        if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(hex)) fail()
        result += String.fromCharCode(parseInt(hex, 16)); pos += length
      } else if (escape in simple) result += simple[escape]
      else fail()
    }
    return fail()
  }
  const value = (depth = 0): unknown => {
    if (depth > 64) fail()
    space()
    const char = source[pos]
    if (char === '"' || char === "'") return string()
    if (char === '{' || char === '[') {
      pos++
      const object = char === '{'
      const result: any = object ? Object.create(null) : []
      const end = object ? '}' : ']'
      space()
      while (source[pos] !== end) {
        if (object) {
          space()
          let key: string
          if (source[pos] === '"' || source[pos] === "'") key = string()
          else {
            const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(pos))
            if (!match) return fail()
            key = match[0]; pos += key.length
          }
          token(':')
          if (Object.hasOwn(result, key)) fail()
          result[key] = value(depth + 1)
        } else result.push(value(depth + 1))
        space()
        if (source[pos] === end) break
        token(','); space()
      }
      token(end)
      return result
    }
    const literal = /^(true|false|null)(?![\w$])/.exec(source.slice(pos))
    if (literal) { pos += literal[0].length; return JSON.parse(literal[0]) }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$.])/.exec(source.slice(pos))
    if (number) {
      pos += number[0].length
      const result = Number(number[0])
      if (!Number.isFinite(result)) fail()
      return result
    }
    return fail()
  }
  space()
  const start = pos
  const declaration = /^export\s+const\s+meta\s*=\s*/.exec(source.slice(pos))
  if (!declaration) throw new Error('Workflow must begin with export const meta = {...}')
  pos += declaration[0].length
  if (source[pos] !== '{') fail()
  const raw = value() as Record<string, unknown>
  const end = pos
  space()
  if (source[pos] === ';') pos++
  else if (pos < source.length && (!source.slice(end, pos).includes('\n') || /^(?:[([.+*/?,`=\-<>&|%^]|!=|(?:in|instanceof)\b)/.test(source.slice(pos)))) fail()
  if (typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new Error('Workflow meta requires nonempty name and description strings')
  }
  if (raw.phases !== undefined && (!Array.isArray(raw.phases) || raw.phases.some(p => typeof p !== 'string'))) throw new Error('meta.phases must be strings')
  if (raw.whenToUse !== undefined && typeof raw.whenToUse !== 'string') throw new Error('meta.whenToUse must be a string')
  return {
    meta: { name: raw.name, description: raw.description, ...(raw.phases ? { phases: raw.phases as string[] } : {}), ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}) },
    script: source.slice(0, start) + source.slice(start).replace(/^export\s+/, ''),
  }
}

export const parseWorkflowMeta = (source: string): WorkflowMeta => parseWorkflow(source).meta
