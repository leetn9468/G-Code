/** Joining controls carry ordinary writing/emoji semantics. Tags need context. */
export const isDisplayJoiner = (ch: string): boolean => /[\u200c\u200d]/u.test(ch)

/** Only the three RGI subdivision flags may carry invisible tag characters:
 * black flag followed by gbeng, gbsct or gbwls, then CANCEL TAG. A single VS16
 * after an emoji base is presentation, not an arbitrary selector payload.
 * Skin-tone modifiers and regional indicators cannot themselves take VS16. */
export function mapDisplayControls(text: string, replace: (ch: string) => string): string {
  return text.replace(/\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}|(?![\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}])\p{Emoji}\ufe0f|[\p{Cc}\p{Cf}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    ch => ch.length > 2 || ch.length > 1 && ch.endsWith('\ufe0f') || isDisplayJoiner(ch) ? ch : replace(ch))
}

/** Display-only escaping. Never use the result as a tool's execution input. */
export function escapeDisplayControls(text: string, multiline = false): string {
  return mapDisplayControls(text, ch => {
    // JSON pretty-printing owns its line layout; paths and labels do not.
    if (multiline && (ch === '\n' || ch === '\t')) return ch
    const code = ch.codePointAt(0)!
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
  })
}

/** Prose is not an approval label: keep ordinary directional marks, soft hyphens
 * and word joiners, but never allow terminal commands or bidi embedding/override
 * and isolate controls. The caller normalizes streamed CRLF before this step. */
export function escapeResponseControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}
