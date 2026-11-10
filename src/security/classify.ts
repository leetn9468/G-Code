import { parseShellCommands, unwrappedShellWords } from '../tools/impl/BashTool.js'
import { assertToolFile } from '../session/scopedPermission.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { guardHost } from '../shared/networkGuard.js'

export interface NetworkClassification { capable: boolean; hosts: string[]; reason: string }
/** The destinations of each connected MCP server (set by initMCP): a resource read reaches them. */
let mcpServerHosts: (server: string) => string[] = () => []
export function setMcpServerHosts(lookup: (server: string) => string[]): void { mcpServerHosts = lookup }
export function classifyNetwork(name: string, input: Record<string, unknown>, cwd: string): NetworkClassification {
  // A resource read talks to the named MCP server, as its tools do.
  if (name === 'ReadMcpResource') return { capable: true, hosts: mcpServerHosts(String(input.server ?? '')), reason: 'Guillotine Mode requires approval in every permission mode; Bash allow rules do not approve hosts.' }
  const hosts = new Set<string>()
  const related = ['Bash', 'LSP', 'WebFetch', 'WebSearch', 'BrowserVerify'].includes(name) || name.startsWith('mcp__')
  if (!related) return { capable: false, hosts: [], reason: '' }
  let text = typeof input.command === 'string' ? input.command : JSON.stringify(input)
  if (name === 'BrowserVerify') {
    try { const path = resolve(cwd, String(input.plan_file)); assertToolFile(path); const plan = JSON.parse(readFileSync(path, 'utf8')); text = plan.server ? [plan.server.command, ...(plan.server.args ?? [])].join(' ') : '' } catch { text = '' }
  }
  const commands = parseShellCommands(text).map(command => unwrappedShellWords(command.words)).filter(words => words.length)
  const programs = commands.map(words => ({ program: basename(words[0]!), args: words.slice(1) }))
  text += '\n' + programs.map(p => [p.program, ...p.args].join(' ')).join('\n')
  const add = (raw: string) => { try { const u = new URL(raw); if (u.hostname) hosts.add(`${u.hostname.toLowerCase()}:${u.port || ({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ssh:': '22', 'git:': '9418', 'ftp:': '21' } as Record<string, string>)[u.protocol] || '443'}`) } catch { const h = guardHost(raw); if (h) hosts.add(h) } }
  for (const url of text.match(/(?:https?|ssh|git|ftp|wss?):\/\/[^\s'"<>`;)]+/g) ?? []) add(url)
  let capable = ['WebFetch', 'WebSearch'].includes(name) || name.startsWith('mcp__')
  if (name === 'WebSearch') hosts.add('html.duckduckgo.com:443')
  if (name === 'LSP' && ['format', 'diagnostics'].includes(String(input.action))) capable = true
  const packages = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|create|exec|dlx|x|update)\b|npx\b)/.test(text) || name === 'LSP' && capable
  if (packages) {
    capable = true
    let registry = 'https://registry.npmjs.org'
    const scoped = new Map<string, string>()
    for (const path of [join(homedir(), '.npmrc'), join(cwd, '.npmrc')]) {
      try { assertToolFile(path); for (const line of readFileSync(path, 'utf8').split('\n')) { const m = /^\s*(@[^:]+:)?registry\s*=\s*(\S+)/.exec(line); if (m) { if (m[1]) scoped.set(m[1], m[2]!); else registry = m[2]! } } } catch { /* Defaults; unknown actual traffic is still denied. */ }
    }
    add(registry); for (const value of scoped.values()) add(value)
  }
  if (/\bpip(?:3)?\s+(?:install|download)\b/.test(text)) { capable = true; hosts.add('pypi.org:443'); hosts.add('files.pythonhosted.org:443') }
  for (const command of programs.filter(c => c.program === 'git')) {
    let root = cwd, args = [...command.args]
    while (args[0]?.startsWith('-')) { const option = args.shift()!; if (['-C', '-c', '--git-dir', '--work-tree'].includes(option)) { const value = args.shift(); if (option === '-C' && value) root = resolve(root, value) } }
    if (!['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(args[0] ?? '')) continue
    capable = true
    try {
      let git = join(root, '.git'), config = join(git, 'config')
      try { assertToolFile(git); const link = /^gitdir:\s*(.+)/.exec(readFileSync(git, 'utf8')); if (link) config = join(resolve(root, link[1]!), 'config'); } catch {}
      assertToolFile(config)
      for (const m of readFileSync(config, 'utf8').matchAll(/^\s*url\s*=\s*(.+)$/gm)) { const scp = /^[^@\s]+@([^:]+):/.exec(m[1]!); if (scp) add(`ssh://${scp[1]}`); else add(m[1]!) }
    } catch {}
    for (const m of text.matchAll(/\b[^@\s]+@([^:\s]+):/g)) add(`ssh://${m[1]}`)
  }
  if (/\b(?:curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp|brew|gh)\b|\bdocker\s+(?:pull|push|login)\b|\bopen\s+https?:/.test(text)) capable = true
  if (hosts.size) capable = true
  return { capable, hosts: [...hosts], reason: 'Guillotine Mode requires approval in every permission mode; Bash allow rules do not approve hosts.' }
}
