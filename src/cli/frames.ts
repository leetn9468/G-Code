import { isDisplayJoiner } from '../shared/displayText.js'

const wellFormed = (text: string): string =>
  (text as string & { toWellFormed?: () => string }).toWellFormed?.() ?? text.replace(/\p{Cs}/gu, '�')

/** serde_json accepts Unicode scalar values, unlike JSON.stringify's lone
 * surrogate escapes. Repair strings and object keys before JSON encoding. */
export function frameJSON(event: unknown): string {
  return JSON.stringify(event, (_key, value) => {
    if (typeof value === 'string') return wellFormed(value)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.some(key => /\p{Cs}/u.test(key))) return Object.fromEntries(keys.map(key => [wellFormed(key), value[key]]))
    }
    return value
  // Frames also cross real terminals. Escape controls in the wire encoding,
  // without changing the strings recovered by JSON.parse / serde_json. JSON
  // requires UTF-16 escape pairs for supplementary scalar values.
  }).replace(/[\p{Cc}\p{Cf}\p{Bidi_Control}\u2028\u2029]/gu, ch => isDisplayJoiner(ch) ? ch
    : ch.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''))
}
