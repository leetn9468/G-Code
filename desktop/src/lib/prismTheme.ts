// gcodeNight — theme-aware code palette for chat, diffs and tool output.
// CSS tokens preserve the dark inks and switch to AA light inks without re-tokenizing.
// Every token colour is WCAG AA (≥ 6:1) on --surface-inset (#141414) and
// still ≥ 4.6:1 on --surface-elevated (#2B2B2B). Neutral greys for structure,
// the azure accents for keywords and tags. Comments are not italic:
// there is no italic system face for PingFang, and synthetic oblique Chinese
// comments look broken.

import { Prism, type PrismTheme } from 'prism-react-renderer'

// prismjs grammar files (bash, diff, toml, …) extend a global `Prism`. Register
// prism-react-renderer's own instance here so lib/prismLanguages.ts, which
// imports this module first, adds its grammars to the instance <Highlight> uses.
// This is the documented pattern without top-level await (build target safari13).
;(globalThis as { Prism?: typeof Prism }).Prism = Prism

export const gcodeNight: PrismTheme = {
  plain: { color: 'var(--text-code)', backgroundColor: 'var(--surface-inset)' }, // 12.68 (9.74)
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata', 'hashbang', 'blockquote'], style: { color: 'var(--code-comment)' } }, // 6.07 (4.67)
    { types: ['punctuation', 'template-punctuation', 'interpolation-punctuation', 'regex-delimiter', 'script-punctuation', 'attr-equals'], style: { color: 'var(--code-punctuation)' } }, // 7.75 (5.95)
    { types: ['operator', 'arrow', 'combinator', 'entity'], style: { color: 'var(--code-operator)' } }, // 10.56 (8.12)
    { types: ['keyword', 'atrule', 'rule', 'important', 'module', 'control-flow'], style: { color: 'var(--accent)' } }, // 8.71 (6.69) brand accent
    { types: ['tag'], style: { color: 'var(--accent-hover)' } }, // 12.41 (9.54)
    { types: ['selector'], style: { color: 'var(--accent)' } }, // 8.71 (6.69): apart from property names
    { types: ['function', 'method', 'generic-function', 'function-definition', 'function-variable', 'url', 'coord'], style: { color: 'var(--code-function)' } }, // 9.76 (7.5)
    { types: ['class-name', 'maybe-class-name', 'known-class-name', 'builtin', 'console', 'namespace', 'attr-name', 'generic'], style: { color: 'var(--code-class)' } }, // 9.6 (7.37)
    { types: ['string', 'char', 'attr-value', 'template-string', 'triple-quoted-string', 'code-snippet', 'string-property'], style: { color: 'var(--code-string)' } }, // 11.55 (8.71)
    { types: ['number', 'boolean', 'constant', 'null', 'symbol', 'unit', 'hexcode', 'color', 'lifetime-annotation'], style: { color: 'var(--code-number)' } }, // 9.44 (7.12)
    { types: ['property', 'property-access', 'literal-property', 'key'], style: { color: 'var(--code-property)' } }, // 13.02 (10.01)
    { types: ['variable', 'parameter', 'imports', 'exports', 'interpolation', 'content'], style: { color: 'var(--text-primary)' } }, // 15.65 (11.80)
    { types: ['regex', 'regex-source', 'language-regex', 'char-class', 'quantifier', 'regex-flags', 'decorator', 'annotation', 'macro', 'attribute', 'shebang'], style: { color: 'var(--code-regex)' } }, // 10.15 (7.66)
    { types: ['inserted', 'inserted-sign'], style: { color: 'var(--success)' } }, // 7.68: an inserted line is success, not brand
    { types: ['deleted', 'deleted-sign'], style: { color: 'var(--code-deleted)' } }, // 9.02 (6.80)
    { types: ['changed'], style: { color: 'var(--code-regex)' } },
    { types: ['title'], style: { color: 'var(--accent)', fontWeight: '600' } },
    { types: ['bold'], style: { fontWeight: '600' } },
    { types: ['italic'], style: { fontStyle: 'italic' } },
    { types: ['url'], languages: ['markdown', 'md'], style: { textDecorationLine: 'underline' } },
    { types: ['atrule', 'key'], languages: ['yaml', 'yml', 'toml'], style: { color: 'var(--code-property)' } },
    { types: ['parameter'], languages: ['bash', 'sh', 'shell'], style: { color: 'var(--code-class)' } },
    { types: ['variable', 'environment'], languages: ['bash', 'sh', 'shell'], style: { color: 'var(--code-number)' } },
  ],
}

/** Prism quirk: a Python decorator is typed [decorator, annotation, punctuation] and the last type wins (grey). */
export const DECORATOR_STYLE = { color: 'var(--code-regex)' } as const
