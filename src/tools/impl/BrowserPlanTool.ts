import { z } from 'zod'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from '../tool.js'
import { structuredPlanSchema } from '../../browser/plan.js'
import { inspectBrowserPlan } from '../../browser/validation.js'
import { isProjectPath } from '../../session/scopedPermission.js'
import { writeTarget, secretRefusal } from '../permissions.js'

/** An error's own message: the tool runner adds the one "Error: " prefix. */
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const inputSchema = z.object({ plan_file: z.string().min(1), plan: structuredPlanSchema }).strict()
type PlanInput = z.infer<typeof inputSchema>

/** The plan as it would be saved, with its independent check. Throws why it cannot be: the same answer before approval and when it runs. */
function planToSave(input: PlanInput, cwd: string) {
  const path = resolve(cwd, input.plan_file)
  if (!isProjectPath(path, cwd)) throw new Error('Plan must stay inside the project')
  const target = writeTarget(path, cwd); if (target?.secret) throw new Error(secretRefusal(target.resolved, 'change'))
  const raw = JSON.stringify(input.plan, null, 2)
  return { path, raw, assessment: inspectBrowserPlan(raw, cwd).assessment }
}
// Create-only, and Node's bare "EEXIST: file already exists" does not say what to do instead.
const planExists = (planFile: string) => `Plan file already exists: ${planFile}. Plans are saved create-only; choose a new plan_file.`
export const BrowserPlanTool: Tool<PlanInput> = {
  name: 'BrowserPlan', description: 'Generate a seeded version-2 browser test plan from named actions and concrete expected UI states. Read the actual HTML/JS first and select meaningful scenarios. Validates independently and saves create-only; never claims execution passed. If the plan includes a server, its args must contain the literal {port}; G-Code assigns a free loopback port, so never hard-code one.', inputSchema,
  // What call() checks first is checked here too: a plan it would refuse is refused before anyone is asked, and shows as Not run (as in BrowserVerify and FileEdit).
  async checkPermissions(input, context) {
    try {
      if (existsSync(planToSave(input, context.cwd).path)) throw new Error(planExists(input.plan_file))
      return { decision: 'ask', reason: 'Save a new browser verification plan in this project' }
    } catch (error) { return { decision: 'deny', reason: errorMessage(error) } }
  },
  prompt() { return this.description },
  async call(input, context) {
    try {
      // Checked again: the entry or the plan file may have changed while the approval waited.
      const { path, raw, assessment } = planToSave(input, context.cwd)
      mkdirSync(dirname(path), { recursive: true })
      try { writeFileSync(path, raw, { flag: 'wx' }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(planExists(input.plan_file))
        throw error
      }
      context.onArtifacts?.([path])
      return { success: true, output: { plan_file: path, assessment, executed: false, next: 'Run BrowserPlanCheck on the saved file, then BrowserVerify after approval.' } }
    } catch (error) { return { success: false, error: errorMessage(error) } }
  },
}
const checkSchema = z.object({ plan_file: z.string().min(1) }).strict()
export const BrowserPlanCheckTool: Tool<z.infer<typeof checkSchema>> = {
  name: 'BrowserPlanCheck', description: 'Independently validate saved browser plan bytes, project boundaries, assertions and source hashes without launching a browser.', inputSchema: checkSchema,
  async checkPermissions() { return { decision: 'allow' } },
  prompt() { return this.description },
  async call(input, context) {
    try {
      const path = resolve(context.cwd, input.plan_file)
      if (!isProjectPath(path, context.cwd)) throw new Error('Plan must stay inside the project')
      const { assessment } = inspectBrowserPlan(readFileSync(path, 'utf8'), context.cwd)
      return { success: true, output: { ...assessment, executed: false } }
    } catch (error) { return { success: false, error: errorMessage(error) } }
  },
}
