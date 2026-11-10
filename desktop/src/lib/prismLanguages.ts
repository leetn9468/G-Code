// Extra Prism grammars for agent output, plus fence-name normalisation.
// prism-react-renderer bundles ~30 grammars but not bash, diff, toml, docker,
// ini, java or ruby — the first two are the most common in a coding agent.
//
// Import order matters: ES modules evaluate depth-first in source order, so
// './prismTheme' (which assigns globalThis.Prism) runs before the grammar files
// that read that global. No top-level await: the build target is safari13.
import './prismTheme'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-diff'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-ini'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-ruby'

/** Fence names that map onto a registered grammar. Theme `languages` match the normalised name. */
export const LANG_ALIAS: Record<string, string> = {
  zsh: 'bash',
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  'shell-session': 'bash',
  patch: 'diff',
  dockerfile: 'docker',
  env: 'ini',
  dotenv: 'ini',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  rb: 'ruby',
  kt: 'kotlin',
  golang: 'go',
  'c++': 'cpp',
  hpp: 'cpp',
  h: 'c',
  'objective-c': 'objc',
  text: 'plain',
  txt: 'plain',
  plaintext: 'plain',
}

/** Human label for the code block header (the fence name as written, tidied). */
export function languageLabel(fence: string): string {
  const name = fence.trim().toLowerCase()
  if (!name || name === 'plain' || name === 'plaintext' || name === 'txt') return 'text'
  return name
}

/** Normalise a fence name to the Prism grammar id used by <Highlight> and the theme. */
export function prismLanguage(fence: string): string {
  const name = fence.trim().toLowerCase()
  return LANG_ALIAS[name] ?? (name || 'plain')
}
