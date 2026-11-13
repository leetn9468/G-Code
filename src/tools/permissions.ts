import { isProtectedRuntimePath } from '../security/resources.js'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { withUserPermissionRules } from '../session/permissionFiles.js'
import { matchesRules, allowedWebRuleHost, hasUnresolvedCommand } from './permissionMatcher.js'
import { blockedCommand } from './impl/BashTool.js'
import { lspRunsProgram } from './impl/LSPTool.js'
import { isProjectPath, isPersonalOutput, autoInspectionCommand, pathTarget, webTarget, isWebHostApproved, type PathTarget, type WebTarget } from '../session/scopedPermission.js'
import { isAttachedFile } from '../session/attachments.js'
import { expandPath } from '../utils/path.js'
/**
 * @file permissions.ts
 * @brief Tool permission evaluation
 *
 * Evaluation order:
 * 1. Hard refusals (key files, catastrophic commands, non-web URLs, Plan writes)
 * 2. alwaysDenyRules — deny immediately if match
 * 3. alwaysAllowRules — allow immediately if match
 * 4. alwaysAskRules — prompt user if match
 * 5. Scope asks (reads outside the project, new web hosts) — ask in every mode but bypass
 * 6. Fall back to permission mode default behavior
 */

import type { ToolPermissionContext, PermissionRule } from '../types.js'
import type { PermissionDecision, PermissionResult } from './tool.js'

/**
 * A policy decision. `scoped` marks one made from this call's own target (a path outside the
 * project, a web host not approved yet): unlike a mode default, it holds in Manual (default) mode too.
 */
export interface PolicyResult extends PermissionResult {
  scoped?: boolean
  /** A domain grant applies only to this initial host, including redirects. */
  webRuleHost?: string
}

// ============================================================================
// Permission Evaluation
// ============================================================================

export function evaluatePermission(
  toolName: string,
  context: ToolPermissionContext,
  input?: unknown,
  cwd?: string,
): PolicyResult {
  context = withUserPermissionRules(context, cwd)
  // What this call reaches. A refusal (G-Code's key files, a non-web URL) holds in every mode, whatever the rules say.
  const scope = input !== undefined ? toolScope(toolName, input, cwd) : undefined
  if (scope?.decision === 'deny') return scope
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  // LSP's format action rewrites its file (prettier --write, black, gofmt -w): it is a file edit.
  const lspFormat = toolName === 'LSP' && args.action === 'format'
  // Its diagnostics run the project's own programs (see lspRunsProgram): a command, not a read.
  const lspCommand = toolName === 'LSP' && args.action === 'diagnostics' && lspRunsProgram(args)
  if ((['FileWrite', 'FileEdit', 'NotebookEdit'].includes(toolName) || lspFormat) && cwd) {
    const path = toolName === 'NotebookEdit' ? args.notebook_path : args.file_path
    const target = typeof path === 'string' ? writeTarget(path, cwd) : undefined
    if (target?.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
  }
  const refused = toolName === 'Bash' && typeof args.command === 'string' ? blockedCommand(args.command, cwd ?? process.cwd()) : undefined
  if (refused) return { decision: 'deny', reason: refused }

  // Plan mode is a read-only boundary, including after entering it mid-turn. A read-only (explore)
  // sub-agent stays inside it: its own calls are checked in plan mode too.
  if (context.mode === 'plan' && (!PLAN_TOOLS.has(toolName) && !(toolName === 'Agent' && args.subagent_type === 'explore') || lspFormat)) {
    return { decision: 'deny', reason: 'Plan mode — read-only' }
  }
  if (context.mode === 'plan' && lspCommand) return { decision: 'deny', reason: "Plan mode — read-only: this diagnostics call runs the project's own programs" }

  if (matchesRules(toolName, context.alwaysDenyRules, input, cwd)) {
    const unknown = toolName === 'Bash' && hasUnresolvedCommand(input)
    return { decision: 'deny', reason: unknown ? 'Blocked by a deny rule: the command name comes from a variable, a substitution or input, so G-Code cannot tell whether the rule covers it. Write the command name out.' : 'Blocked by a deny rule' }
  }

  // The model cannot promote itself out of a user-selected read-only mode.
  if (context.mode === 'plan' && toolName === 'ExitPlanMode') return { decision: 'ask', reason: 'Leaving Plan requires approval' }

  // 2. Check allow rules
  if (matchesRules(toolName, context.alwaysAllowRules, input, cwd, true)) {
    return { decision: 'allow', reason: 'Matched allow rule', ...(toolName === 'WebFetch' ? { webRuleHost: allowedWebRuleHost(context.alwaysAllowRules, input) } : {}) }
  }

  // 3. Check ask rules
  if (matchesRules(toolName, context.alwaysAskRules, input, cwd)) {
    return { decision: 'ask', reason: 'Matched ask rule' }
  }

  // Reading outside the project or contacting a new web host asks in every mode but bypass.
  if (scope && context.mode !== 'bypass') return scope

  // 4. Fall back to mode default
  if (context.mode === 'acceptEdits' || context.mode === 'auto') {
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const editPath = toolName === 'NotebookEdit' ? args.notebook_path : args.file_path
    if (['FileWrite', 'FileEdit', 'NotebookEdit'].includes(toolName) || lspFormat) {
      if (isProjectPath(editPath, cwd)) {
        // In the project by its path, but not an ordinary project file: asks here too.
        const reason = typeof editPath === 'string' && cwd ? writeApprovalReason(editPath, cwd) : undefined
        return reason ? { decision: 'ask', reason } : { decision: 'allow', reason: 'Project-scoped edit' }
      }
      const outside = typeof editPath === 'string' && cwd ? writeTarget(editPath, cwd) : undefined
      if (outside && !outside.inside) return { decision: 'ask', reason: writeOutsideReason(outside) }
    }
    // Its file is always in the project (.gcode/team-memory; the tool refuses a link out of it).
    if (toolName === 'TeamMemoryWrite') return { decision: 'allow', reason: 'Project-scoped edit' }
    if (PLAN_TOOLS.has(toolName) && toolName !== 'ExitPlanMode' && !lspFormat && !lspCommand) return { decision: 'allow', reason: 'Inspection tool' }
    // A read-only sub-agent asks in no mode (user decision 2026-11-01); each of its calls is checked on its own.
    if (toolName === 'Agent' && args.subagent_type === 'explore') return { decision: 'allow', reason: 'Read-only sub-agent' }
    // Manual runs these without asking: they stay inside the session, so a looser mode does not ask either.
    if (SESSION_TOOLS.has(toolName)) return { decision: 'allow', reason: 'Session tool' }
    if (context.mode === 'auto' && toolName === 'Bash' && autoInspectionCommand(args.command)) return { decision: 'allow', reason: 'Auto inspection command' }
    return { decision: 'ask', reason: 'Outside automatic approval scope' }
  }
  return modeDefault(context.mode)
}

export const PLAN_TOOLS = new Set([
  'FileRead', 'Grep', 'Glob', 'ListDir', 'LSP', 'WebFetch', 'WebSearch', 'BrowserPlanCheck',
  'TodoWrite', 'ToolSearch', 'TaskGet', 'TaskList',
  'TaskOutput', 'EnterPlanMode', 'ExitPlanMode', 'Skill',
  'ListMcpResources', 'ReadMcpResource',
])

/** Task records, a background task of this session, a pause: nothing outside the session changes. */
const SESSION_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskStop', 'Sleep'])

export function hasAskRule(toolName: string, context: ToolPermissionContext, input?: unknown, cwd?: string): boolean {
  context = withUserPermissionRules(context, cwd)
  return matchesRules(toolName, context.alwaysAskRules, input, cwd)
}

// ============================================================================
// Scope: what one call reaches
// ============================================================================

/** The path each reading tool reaches, resolved the way that tool resolves it. */
const READ_PATHS: Record<string, (args: Record<string, unknown>, cwd: string) => string | undefined> = {
  FileRead: (args, cwd) => typeof args.file_path === 'string' ? expandPath(args.file_path, cwd) : undefined,
  Grep: (args, cwd) => resolve(cwd, typeof args.path === 'string' ? args.path : '.'),
  Glob: (args, cwd) => resolve(cwd, typeof args.path === 'string' ? args.path : '.'),
  ListDir: (args, cwd) => resolve(cwd, typeof args.path === 'string' ? args.path : '.'),
  LSP: (args, cwd) => typeof args.file_path === 'string' ? resolve(cwd, args.file_path) : undefined,
}

/** How the approval names each reading tool's action: what it does, and the same as a noun phrase. */
const READ_ACTIONS: Record<string, [string, string]> = {
  FileRead: ['Read a file', 'Reading'], LSP: ['Read a file', 'Reading'],
  Grep: ['Search', 'Searching'], Glob: ['Search', 'Searching'], ListDir: ['List a folder', 'Listing'],
}

/** The scope decision for one call: a read or search target, or a web host. Undefined when the call stays in scope. */
export function toolScope(toolName: string, input: unknown, cwd?: string): PolicyResult | undefined {
  if (toolName === 'WebFetch') return webScope(input)
  return cwd ? readScope(toolName, input, cwd) : undefined
}

/**
 * Reading and searching tools: G-Code's own settings and key files are refused; a target outside
 * the project (by its real path, so symlinks count) asks. Undefined inside the project.
 */
export function readScope(toolName: string, input: unknown, cwd: string): PolicyResult | undefined {
  const locate = READ_PATHS[toolName]
  if (!locate) return undefined
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  let path: string | undefined
  try { path = locate(args, cwd) } catch (error) { return { decision: 'deny', reason: error instanceof Error ? error.message : String(error) } }
  if (path === undefined) return undefined
  const target = pathTarget(path, cwd)
  if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved) }
  // A file the user attached to a message is read as a project file is (the user chose it); only FileRead, only that file.
  if (target.inside || toolName === 'FileRead' && (isPersonalOutput(target.resolved, cwd) || isAttachedFile(target.resolved))) return undefined
  const [action, noun] = READ_ACTIONS[toolName]!
  return { decision: 'ask', scoped: true, reason: `${action} outside the project: ${target.resolved}${linkNote(target)}. ${noun} anything outside ${target.root} needs your approval.` }
}

/** WebFetch: only http and https URLs; a host not approved in this session asks. */
export function webScope(input: unknown): PolicyResult | undefined {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const target = webTarget(args.url)
  if (!target) return { decision: 'deny', reason: 'WebFetch only fetches http and https URLs.' }
  if (isWebHostApproved(target.host)) return undefined
  return { decision: 'ask', scoped: true, reason: webFetchReason(target) }
}

/** The approval text for a web host not approved yet. */
export function webFetchReason(target: WebTarget): string {
  return `Fetch from ${target.host}${target.local ? ', an address on this computer or local network' : ''}. This host is not approved in this session yet; if you allow it, WebFetch can use it until the session ends.`
}

/** The refusal for G-Code's own settings and key files. */
export function secretRefusal(resolved: string, action: 'read' | 'change' = 'read'): string {
  if (resolved.replaceAll('\\', '/').includes('/.gcode/incidents')) return 'Incident evidence is read-only and unavailable to tools. Review it in the Guillotine Mode incident list in Settings.'
  if (action === 'change' && isProtectedRuntimePath(resolved)) return 'G-Code runtime files are read-only to tools. Rebuild the runtime from trusted source to update them.'
  return `${resolved} holds G-Code's own settings or API keys; tools may not ${action} it.${action === 'change' ? ' Use G-Code\'s Settings instead.' : ''}`
}

/** Where a write or edit of `path` (as FileWrite and FileEdit resolve it) really lands. Undefined when the path is invalid. */
export function writeTarget(path: string, cwd: string): PathTarget | undefined {
  try { const target = pathTarget(expandPath(path, cwd), cwd); if (target && isProtectedRuntimePath(target.resolved)) target.secret = true; return target } catch { return undefined }
}

/**
 * Why a write inside the project still needs an approval in Accept edits and Auto, as the approval
 * says it; undefined for an ordinary project file. Git runs programs its own files name
 * (core.fsmonitor, diff.external, hooks), and `git status` is an Auto inspection command, so an
 * edit of those is a way to run a command. A hard link is another name of a file that may live
 * outside the project.
 */
export function writeApprovalReason(path: string, cwd: string): string | undefined {
  const target = writeTarget(path, cwd)
  if (!target?.inside) return undefined
  const parts = relative(target.root, target.resolved).split(sep).map(part => part.toLowerCase())
  const name = parts.at(-1)!
  // A folder with HEAD and config beside each other can be taken for a bare repository: git reads that config too.
  const sibling = name === 'config' ? 'HEAD' : name === 'head' ? 'config' : undefined
  if (parts.includes('.git') || (sibling && existsSync(join(dirname(target.resolved), sibling)))) {
    return `Changes git's own files (${target.resolved}). Git can run programs named there, so this needs your approval.`
  }
  try {
    const file = statSync(target.resolved)
    if (file.isFile() && file.nlink > 1) return `Changes a file with ${file.nlink} names (hard links): ${target.resolved}. Its other names, possibly outside the project, show the change too.`
  } catch { /* A new file has one name. */ }
  return undefined
}

/** The approval text for a write that lands outside the project. */
export function writeOutsideReason(target: PathTarget): string {
  return `Writes outside the project: ${target.resolved}${linkNote(target)}`
}

function linkNote(target: PathTarget): string {
  return target.viaLink ? ' (a symbolic link in the project leads there)' : ''
}

// ============================================================================
// Internal
// ============================================================================

function modeDefault(mode: string): PolicyResult {
  switch (mode) {
    case 'bypass':
      return { decision: 'allow', reason: 'Bypass mode' }
    case 'plan':
      return { decision: 'allow', reason: 'Plan mode — read-only tool' }
    case 'default':
    default:
      return { decision: 'ask', reason: 'Default mode — user approval required' }
  }
}
