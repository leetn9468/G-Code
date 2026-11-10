import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { PermissionRule } from '../types.js'
import { parsePermissionRule, balancedRuleCommand } from '../shared/permissionRules.js'
import { realTarget, webTarget, withinPath } from '../session/scopedPermission.js'
import { expandPath } from '../utils/path.js'
import { assessCommandRisk, commandsRun, parseShellCommands, type RunCommand } from './impl/BashTool.js'
import { lspRunsProgram } from './impl/LSPTool.js'

const READ = new Set(['FileRead', 'Grep', 'Glob', 'ListDir', 'LSP'])
const EDIT = new Set(['FileWrite', 'FileEdit', 'NotebookEdit'])
const toolMatches = (rule: string, tool: string) => rule === '*' || rule === tool || /^mcp__[^_]+(?:_[^_]+)*$/.test(rule) && tool.startsWith(rule + '__')
const argsOf = (input: unknown): Record<string, unknown> => input && typeof input === 'object' ? input as Record<string, unknown> : {}

/** Match actual words, not a joined string: one quoted argument cannot turn into several words. */
function bashMatches(rule: PermissionRule, command: ReturnType<typeof parseShellCommands>[number]): boolean {
  const parsed = rule.rule ? parsePermissionRule(rule.rule, !!rule.projectRoot) : undefined
  if (!parsed || parsed.kind === 'tool') return toolMatches(rule.tool, 'Bash') || !!rule.pattern && legacyPattern(rule.pattern, 'Bash')
  if (parsed.kind !== 'bash' || !parsed.value) return false
  const pieces = parseShellCommands(parsed.value)
  if (pieces.length !== 1 || /\$|`|[<>]\(/.test(parsed.value)) return false
  const wanted = pieces[0]!
  if (wanted.words.length === 0 || wanted.input !== undefined || command.input !== undefined) return false
  if (parsed.prefix && (wanted.redirects.length || command.redirects.length)) return false
  if (!parsed.prefix && JSON.stringify(wanted.redirects) !== JSON.stringify(command.redirects)) return false
  return wanted.words.every((word, index) => word === command.words[index]) && (parsed.prefix || wanted.words.length === command.words.length)
}

/**
 * A deny or ask rule against what a command really runs (see commandsRun): the rule's words are
 * matched the same way, and a command word only the running shell can know matches every Bash rule.
 */
function bashRunMatches(rule: PermissionRule, run: RunCommand): boolean {
  const parsed = rule.rule ? parsePermissionRule(rule.rule, !!rule.projectRoot) : undefined
  if (!parsed || parsed.kind !== 'bash' || !parsed.value) return false
  if (parseShellCommands(parsed.value).length !== 1 || /\$|`|[<>]\(/.test(parsed.value)) return false
  if (run.unresolved) return true
  const wanted = commandsRun(parsed.value)[0]
  if (!wanted?.words.length) return false
  // A rule that names a redirection means that one; any other redirection does not change what runs.
  if (wanted.redirects.length && JSON.stringify(wanted.redirects) !== JSON.stringify(run.redirects)) return false
  return wanted.words.every((word, index) => word === run.words[index]) && (parsed.prefix || wanted.words.length === run.words.length)
}

interface MatchBudget { remaining: number }
/** Bounded wildcard matching; hostile repeated stars never become a backtracking regexp. */
function globMatches(glob: string, path: string, budget: MatchBudget): boolean | undefined {
  let previous = new Uint8Array(path.length + 1); previous[0] = 1
  for (let i = 0; i < glob.length; i++) {
    if ((budget.remaining -= path.length + 1) < 0) return undefined
    const current = new Uint8Array(path.length + 1), char = glob[i]!
    if (char === '*') {
      const across = glob[i + 1] === '*'
      if (across) i++
      current[0] = previous[0]!
      for (let j = 1; j <= path.length; j++) current[j] = previous[j]! || (across || path[j - 1] !== '/') && current[j - 1]! ? 1 : 0
      // **/ also includes no intervening segment.
      if (across && glob[i + 1] === '/') {
        i++
        const slash = new Uint8Array(path.length + 1)
        for (let j = 0; j <= path.length; j++) slash[j] = previous[j]! || j > 0 && path[j - 1] === '/' && current[j - 1]! ? 1 : 0
        previous = slash; continue
      }
    } else for (let j = 1; j <= path.length; j++) current[j] = char === path[j - 1] ? previous[j - 1]! : 0
    previous = current
  }
  return previous[path.length] === 1
}

/** A rule's fixed prefix stays literal, so a link in its tree cannot grant its destination. */
function pathMatches(rule: PermissionRule, glob: string, input: unknown, tool: string, cwd?: string, allow = false, budget: MatchBudget = { remaining: 1_000_000 }): boolean {
  if (!cwd) return false
  const args = argsOf(input)
  const value = tool === 'NotebookEdit' ? args.notebook_path : READ.has(tool) && !['FileRead', 'LSP'].includes(tool) ? args.path ?? '.' : args.file_path
  if (typeof value !== 'string') return false
  let target: string | undefined
  try { target = realTarget(['FileRead', 'FileWrite', 'FileEdit', 'NotebookEdit'].includes(tool) ? expandPath(value, cwd) : resolve(cwd, value)) } catch { return false }
  if (!target) return false
  const home = realTarget(homedir()) ?? homedir()
  const absolute = glob.startsWith('~/') ? join(home, glob.slice(2)) : glob.startsWith('/') ? glob : rule.projectRoot ? join(rule.projectRoot, glob) : undefined
  if (!absolute) return false
  let matched = globMatches(absolute, target, budget)
  if (matched === false && absolute.endsWith('/**')) matched = globMatches(absolute.slice(0, -3), target, budget)
  if (matched === undefined) return !allow
  let directory = false
  if (['Grep', 'Glob', 'ListDir'].includes(tool)) { try { directory = statSync(target).isDirectory() } catch { directory = true } }
  if (!directory) return matched
  // A directory search reaches descendants too. An allow must cover the whole tree; a deny
  // touching any possible descendant blocks the search rather than leaking that descendant.
  if (allow) return absolute.endsWith('/**') && matched
  const fixed = absolute.split('*')[0]!.replace(/\/$/, '') || '/'
  return matched || withinPath(fixed, target) || absolute.includes('*') && withinPath(target, fixed)

}

function legacyPattern(pattern: string, tool: string): boolean {
  try { return new RegExp(pattern).test(tool) } catch { return false }
}

function oneMatches(rule: PermissionRule, tool: string, input?: unknown, cwd?: string, allow = false, budget: MatchBudget = { remaining: 1_000_000 }): boolean {
  if (!rule.rule) return toolMatches(rule.tool, tool) || !!rule.pattern && legacyPattern(rule.pattern, tool)
  const parsed = parsePermissionRule(rule.rule, !!rule.projectRoot)
  if (!parsed) return false
  if (parsed.kind === 'tool') return toolMatches(parsed.tool, tool)
  // A rule that allows reading a path does not allow running the programs an LSP action starts, or rewriting a file.
  if (parsed.kind === 'read' && allow && tool === 'LSP' && (argsOf(input).action === 'format' || lspRunsProgram(input))) return false
  if (parsed.kind === 'read' || parsed.kind === 'edit') return (parsed.kind === 'read' ? READ : EDIT).has(tool) && pathMatches(rule, parsed.value!, input, tool, cwd, allow, budget)
  if (parsed.kind === 'web' && tool === 'WebFetch') {
    const host = webTarget(argsOf(input).url)?.host
    const domain = parsed.value!
    return !!host && (domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host !== domain.slice(2) : host === domain)
  }
  return false
}

/** Deny/ask applies to any constituent; an allow must cover every command independently. */
export function matchesRules(tool: string, rules: ReadonlyArray<PermissionRule>, input?: unknown, cwd?: string, allow = false): boolean {
  const budget = { remaining: 1_000_000 }
  if (tool !== 'Bash' || input === undefined) return rules.some(rule => oneMatches(rule, tool, input, cwd, allow, budget))
  const command = argsOf(input).command
  if (typeof command !== 'string') return false
  if (allow && (!balancedRuleCommand(command) || /\$|`|[<>]\(/.test(command) || assessCommandRisk(command, cwd ?? process.cwd()))) return false
  const pieces = parseShellCommands(command)
  const match = (piece: typeof pieces[number]) => rules.some(rule => bashMatches(rule, piece))
  if (allow) return pieces.length > 0 && pieces.every(match)
  if (pieces.some(match)) return true
  // Deny and ask rules also see through wrappers and into scripts. Allow stays literal: matching less is its safe side.
  return !!rules.length && commandsRun(command).some(run => rules.some(rule => bashRunMatches(rule, run)))
}

/** Whether a command's name is only known when it runs (`$R f`), which is why a Bash deny rule refused it. */
export function hasUnresolvedCommand(input: unknown): boolean {
  const command = argsOf(input).command
  return typeof command === 'string' && commandsRun(command).some(run => run.unresolved)
}

/** A domain rule carries its exact host into redirect handling, without approving future hosts. */
export function allowedWebRuleHost(rules: ReadonlyArray<PermissionRule>, input: unknown): string | undefined {
  return rules.some(rule => rule.rule && parsePermissionRule(rule.rule)?.kind === 'web' && oneMatches(rule, 'WebFetch', input)) ? webTarget(argsOf(input).url)?.host : undefined
}

/** Narrow, editable suggestions; a dangerous/substituted shell call has no automatic grant. */
export function suggestedPermissionRule(tool: string, input: unknown, cwd?: string, prefix = false): string | undefined {
  const args = argsOf(input)
  if (tool === 'Bash' && typeof args.command === 'string') {
    const command = args.command.trim()
    if (/\$|`|[<>]\(/.test(command) || assessCommandRisk(command, cwd ?? process.cwd()) || parseShellCommands(command).length !== 1) return
    const rule = `Bash(${command}${prefix && !parseShellCommands(command)[0]?.redirects.length ? ':*' : ''})`
    return parsePermissionRule(rule) ? rule : undefined
  }
  if (tool === 'WebFetch') { const target = webTarget(args.url); return target ? `WebFetch(domain:${target.host})` : undefined }
  // No path rule covers an LSP action that runs a program, so none is offered.
  if (tool === 'LSP' && (args.action === 'format' || lspRunsProgram(args))) return
  if ((READ.has(tool) || EDIT.has(tool)) && cwd) {
    const value = tool === 'NotebookEdit' ? args.notebook_path : args.file_path ?? args.path
    if (typeof value !== 'string') return
    let path: string | undefined
    try { path = realTarget(expandPath(value, cwd)) } catch { return }
    if (!path) return
    const glob = prefix && READ.has(tool) ? `${dirname(path)}/**` : path
    const rule = `${READ.has(tool) ? 'Read' : 'Edit'}(${glob})`
    return parsePermissionRule(rule) ? rule : undefined
  }
  return /^mcp__/.test(tool) ? tool : undefined
}
