/** The named references web text uses for punctuation; any other name is left as written. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
}

/**
 * HTML character references decoded in one pass: the named ones above, and every decimal (&#39;)
 * and hex (&#x27;) one. Replacing one reference after another left hex ones as written (search
 * results read "Neptune&#x27;s"), decoded "&amp;lt;" twice (to "<"), and cut a decimal reference
 * past U+FFFF (an emoji) to a lone surrogate.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? whole
    const code = decimal ? Number(decimal) : parseInt(hex!, 16)
    // NUL, surrogates and numbers past Unicode name no character: the reference stays as written.
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole
  })
}
