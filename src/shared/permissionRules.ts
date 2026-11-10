/** Permission syntax shared by the engine and Settings; no project file can grant authority. */
export interface PermissionLists { allow: string[]; deny: string[] }
export interface PermissionFile extends PermissionLists { version: 1; projects: Record<string, PermissionLists> }
export type ParsedPermissionRule = { tool: string; kind: 'tool' | 'bash' | 'read' | 'edit' | 'web'; value?: string; prefix?: boolean }
export interface PermissionDenial { tool_name: string; tool_use_id: string; tool_input: unknown; reason: string; suggested_rule?: string }
export const PERMISSIONS_MAX_BYTES = 256 * 1024
export const PERMISSIONS_MAX_RULES = 1000
export const emptyPermissionFile = (): PermissionFile => ({ version: 1, allow: [], deny: [], projects: {} })

/** Reject incomplete shell words instead of silently accepting a truncated prefix. */
export function balancedRuleCommand(command: string): boolean {
  let quote = '', depth = 0
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (char === '\\' && quote !== "'") { if (++i >= command.length) return false; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth < 0) return false
  }
  return !quote && depth === 0
}

/** Deliberately small syntax; unsupported shell or glob grammar must not silently widen a rule. */
export function parsePermissionRule(rule: unknown, project = false): ParsedPermissionRule | undefined {
  if (typeof rule !== 'string' || !rule || rule.length > 4096 || rule.trim() !== rule || /[\u0000-\u001f\u007f]/.test(rule)) return
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(rule)) return { tool: rule, kind: 'tool' }
  const match = /^(Bash|Read|Edit|WebFetch)\((.+)\)$/.exec(rule)
  if (!match) return
  const tool = match[1]!, value = match[2]!
  if (!value.trim() || value.trim() !== value) return
  if (tool === 'Bash') {
    const prefix = value.endsWith(':*')
    const command = prefix ? value.slice(0, -2) : value
    if (!command || command.trim() !== command || !balancedRuleCommand(command)) return
    return { tool, kind: 'bash', value: command, prefix }
  }
  if (tool === 'WebFetch') {
    if (!value.startsWith('domain:')) return
    const domain = value.slice(7)
    // Hosts, not URLs; a wildcard matches subdomains only. Ports remain part of the authority.
    const host = domain.startsWith('*.') ? domain.slice(2) : domain
    if (!host || /[\s/@?#\\%*]/.test(host) || host.startsWith('.') || host.endsWith('.')) return
    try { const url = new URL(`https://${host}`); if (url.host.toLowerCase() !== host.toLowerCase() || url.pathname !== '/') return } catch { return }
    return { tool, kind: 'web', value: domain.toLowerCase() }
  }
  if (!value.startsWith('/') && !value.startsWith('~/') && (!project || value.startsWith('~'))) return
  if (/[\\?\[\]{}]/.test(value) || value.split('/').includes('..')) return
  return { tool, kind: tool === 'Read' ? 'read' : 'edit', value }
}

export function permissionRuleError(rule: string, project = false): string | undefined {
  if (!rule) return 'Enter a rule.'
  return parsePermissionRule(rule, project) ? undefined : 'Use a tool name, Bash(command), Read(path), Edit(path), or WebFetch(domain:host).'
}

export function describePermissionRule(rule: string, deny = false): string {
  const parsed = parsePermissionRule(rule, true)
  if (!parsed) return 'Invalid rule'
  const tail = deny ? ' is blocked' : ' without asking'
  if (parsed.kind === 'bash') return `${deny ? 'Running' : 'Run'} ${parsed.value}${parsed.prefix ? ' and its arguments' : ''}${tail}`
  if (parsed.kind === 'read' || parsed.kind === 'edit') return `${parsed.kind === 'read' ? deny ? 'Reading' : 'Read' : deny ? 'Editing' : 'Edit'} files matching ${parsed.value}${tail}`
  if (parsed.kind === 'web') return `${deny ? 'Fetching' : 'Fetch'} from ${parsed.value}${tail}`
  return `${deny ? 'Using' : 'Use'} ${parsed.tool}${tail}`
}
