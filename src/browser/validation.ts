import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { browserPlanSchema, type BrowserPlan } from './plan.js'
import { isProjectPath, assertToolFile } from '../session/scopedPermission.js'

/** Independent of the generator: the runner always calls this on saved bytes. */
export function inspectBrowserPlan(raw: string, cwd: string): { plan: BrowserPlan; assessment: Record<string, unknown> } {
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Plan exceeds 128 KiB')
  const plan = browserPlanSchema.parse(JSON.parse(raw))
  const entry = resolve(cwd, plan.entry)
  assertToolFile(entry)
  let file = false
  try { file = statSync(entry).isFile() } catch { /* Missing: refused below, with where it was looked for. */ }
  if (!isProjectPath(entry, cwd) || !file || extname(entry) !== '.html') {
    throw new Error(`Entry must be a project HTML file; "${plan.entry}" resolves against the project root to ${entry}${file || existsSync(entry) ? '' : ', which does not exist'}`)
  }
  const assertions = plan.steps.filter(step => step.action === 'assert' || step.action === 'expect').length
  return { plan, assessment: {
    schema: plan.version, assertions, planSha256: createHash('sha256').update(raw).digest('hex'),
    entry: realpathSync(entry), entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    independentValidation: plan.version === 2 ? 'Structured observations; no page evaluation supplied by the plan' : 'Legacy expressions require human review; mutation-free assertions cannot be established',
    coverage: 'Only the named assertions are covered; this is not proof of complete application coverage',
    seed: plan.version === 2 ? plan.seed : null,
  } }
}
