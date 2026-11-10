import type { ToolPermissionContext } from '../types.js'
import type { PermissionDenial } from '../shared/permissionRules.js'
import { allowingModes } from '../shared/sessionControls.js'
import { evaluatePermission } from '../tools/permissions.js'
import { escapeDisplayControls } from '../shared/displayText.js'

/** One actionable summary; hard refusals and deny rules never advertise a bypass that cannot work. */
export function permissionSummary(denials: readonly PermissionDenial[], context: ToolPermissionContext, cwd: string): string {
  if (!denials.length) return ''
  const counts = new Map<string, number>()
  for (const denial of denials) counts.set(denial.tool_name, (counts.get(denial.tool_name) ?? 0) + 1)
  const calls = [...counts].map(([tool, count]) => `${tool} ×${count}`).join(', ')
  const suggestions = [...new Set(denials.map(denial => denial.suggested_rule).filter((rule): rule is string => !!rule))]
  const hints = suggestions.slice(0, 3).map(rule => `--allow '${rule.replaceAll("'", "'\\''")}'`)
  if (suggestions.length) hints.push('a rule in ~/.gcode/permissions.json')
  const eligible = denials.every(denial => denial.reason.includes('This non-interactive run cannot ask for approval.') && denial.tool_name !== 'Workflow')
  if (eligible) {
    for (const mode of allowingModes(context.mode, [...counts.keys()])) {
      if (denials.every(denial => evaluatePermission(denial.tool_name, { ...context, mode }, denial.tool_input, cwd).decision === 'allow')) hints.push(`--permission-mode ${mode}`)
    }
  }
  return escapeDisplayControls(`${denials.length} call${denials.length === 1 ? ' was' : 's were'} refused: ${calls}.${hints.length ? ` Allow them with ${hints.join(', or ')}.` : ' Review the refusal reasons before running again.'}`)
}
