import { currentGuard, currentCall, GUARD_PROXY_PORTS } from '../../security/guard.js'
import { browserProfile } from '../../security/protection.js'
import { assertRuntimeLinks } from '../../security/resources.js'
import { writeTarget, secretRefusal } from '../permissions.js'
import { prepareToolProcess, trackToolProcess } from '../../security/process.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { toolEnv } from '../../runtime/node.js'
import { readFileSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { Tool, ToolResult } from '../tool.js'
import { headUnits, tailUnits } from '../../utils/textUnits.js'
import { isProjectPath } from '../../session/scopedPermission.js'
import { browserPlanSchema } from '../../browser/plan.js'
import { BLOCKED_NOTE } from '../../browser/observations.js'
import { inspectBrowserPlan } from '../../browser/validation.js'
import { browserWorkerArgs, browserDriverPath, browserNodePath } from '../../browser/paths.js'
import { errorMessage } from './BrowserPlanTool.js'

const inputSchema = z.object({ plan_file: z.string().min(1).describe('Project-relative JSON verification plan. Use BrowserPlan to generate version 2.'), plan_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Required for version 2: use the exact planSha256 returned by BrowserPlanCheck.'), timeout_ms: z.number().int().min(5000).max(180000).optional() })
export const BrowserVerifyTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'BrowserVerify', description: 'Run real Chromium checks for a local web project. Generate a version-2 plan with BrowserPlan, independently inspect the saved bytes with BrowserPlanCheck, and pass its planSha256. Supports named interactions, structured read-only expectations, deterministic Math.random and an optional approved development server. Saves report, screenshots and trace; any failed check or browser error fails the run. Legacy version-1 expressions remain supported for reviewed existing plans. Uses an isolated owned browser, no personal profile or external network.', inputSchema,
  async checkPermissions(input, context) {
    try {
      const path = resolve(context.cwd, input.plan_file)
      if (!isProjectPath(path, context.cwd)) throw new Error('Plan must stay inside the project')
      const { plan, assessment } = inspectBrowserPlan(readFileSync(path, 'utf8'), context.cwd)
      if ((plan.version === 2 || input.plan_sha256) && input.plan_sha256 !== assessment.planSha256) throw new Error('Plan hash changed or missing. Run BrowserPlanCheck and use its exact planSha256.')
      return { decision: 'ask', reason: `Run ${plan.steps.length} browser steps (${assessment.assertions} assertions), plan SHA-256 ${assessment.planSha256}.${plan.version === 2 && plan.server ? ` Launch project development server: ${JSON.stringify([plan.server.command, ...plan.server.args])}; {port} is an assigned loopback port.` : ''}` }
    } catch (error) { return { decision: 'deny', reason: errorMessage(error) } }
  },
  prompt() { return 'BrowserVerify: run an independently checked browser plan. Version 2 requires plan_sha256 from BrowserPlanCheck. Supports an owned local development server from the approved plan. Do not claim a web app works from syntax checks alone.' },
  async call(input, context) {
    const planPath = resolve(context.cwd, input.plan_file)
    if (!isProjectPath(planPath, context.cwd)) return { success: false, error: 'Verification plan must be inside the project' }
    if (!existsSync(join(browserDriverPath(), 'package.json')) || !existsSync(browserNodePath())) return { success: false, error: 'Bundled browser runtime is missing. Rebuild or reinstall the full G-Code app.' }
    let plan
    let raw: string
    let assessment
    try { raw = readFileSync(planPath, 'utf8'); ({ plan, assessment } = inspectBrowserPlan(raw, context.cwd)) }
    catch (error) { return { success: false, error: `Invalid browser plan: ${errorMessage(error)}` } }
    if ((plan.version === 2 || input.plan_sha256) && input.plan_sha256 !== assessment.planSha256) return { success: false, error: 'Plan hash changed or missing. Recheck the saved plan before execution.' }
    if (!isProjectPath(resolve(context.cwd, plan.entry), context.cwd)) return { success: false, error: 'Browser entry must belong to the project' }
    const output = join(context.cwd, '.gcode', 'verification', randomUUID())
    if (!isProjectPath(output, context.cwd)) return { success: false, error: 'Verification output path escapes the project' }
    const target = writeTarget(output, context.cwd); if (target?.secret) return { success: false, error: secretRefusal(target.resolved, 'change') }
    try { assertRuntimeLinks() } catch (error) { return { success: false, error: errorMessage(error) } }
    mkdirSync(output, { recursive: true })
    if (!isProjectPath(realpathSync(output), context.cwd)) return { success: false, error: 'Verification output path changed' }
    const request = join(output, 'request.json')
    writeFileSync(request, JSON.stringify({ cwd: context.cwd, output, plan, assessment, planHash: createHash('sha256').update(raw).digest('hex'), sessionId: context.sessionId }, null, 2), { flag: 'wx' })
    const reportPath = join(output, 'report.json')
    return await new Promise<ToolResult<Record<string, unknown>>>(resolveResult => {
      const env: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase().startsWith('npm_config_'))) }
      const browserGuard = currentGuard(), browserCall = currentCall()
      const launch = prepareToolProcess(['/usr/bin/true'], toolEnv(env), context.cwd)
      // The trusted browser worker is the only process exception; its project dev-server uses this exact
      // profile, and Chromium a loopback-only one under the same tag, so its denials reach this call.
      const workerEnv = { ...launch.env, ...(browserGuard && launch.call ? { GCODE_BROWSER_GUARD_PROFILE: launch.argv[2], GCODE_BROWSER_GUARD: '1', GCODE_BROWSER_CHROMIUM_PROFILE: browserProfile(launch.call.tag, [...browserGuard.forbiddenPorts, ...GUARD_PROXY_PORTS]) } : {}) }
      const proc = spawn(browserNodePath(), browserWorkerArgs(request), { cwd: context.cwd, env: workerEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      trackToolProcess(browserCall, proc.pid, [browserNodePath(), ...browserWorkerArgs(request)], context.cwd, true)
      let stderr = '', pending = '', stopped = false, timedOut = false
      let ownedBrowserPid: number | undefined
      let ownedDevServerPid: number | undefined
      let force: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL' && ownedBrowserPid && process.platform !== 'win32') { try { process.kill(-ownedBrowserPid, signal) } catch {} }
        if (signal === 'SIGKILL' && ownedDevServerPid && process.platform !== 'win32') { try { process.kill(-ownedDevServerPid, signal) } catch {} }
        try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal); else proc.kill(signal) } catch {} }
      const cancel = () => { if (stopped) return; stopped = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 2500); force.unref() }
      const exit = () => kill('SIGKILL')
      process.once('exit', exit)
      context.signal?.addEventListener('abort', cancel, { once: true }); if (context.signal?.aborted) cancel()
      const timer = setTimeout(() => { timedOut = true; cancel() }, input.timeout_ms ?? 120000)
      // Decoded per stream, so a character split across two reads stays whole.
      proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8')
      proc.stdout.on('data', chunk => {
        pending += String(chunk)
        if (pending.length > 32000) pending = tailUnits(pending, 32000)
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); try { const event = JSON.parse(line); if (Number.isInteger(event.browserPid) && event.browserPid > 0) { ownedBrowserPid = event.browserPid; trackToolProcess(browserCall, ownedBrowserPid, ['BrowserVerify Chromium'], context.cwd, true) }; if (Number.isInteger(event.devServerPid) && event.devServerPid > 0) { ownedDevServerPid = event.devServerPid; trackToolProcess(browserCall, ownedDevServerPid, ['BrowserVerify dev server'], context.cwd) }; if (event.networkBlocked && typeof event.networkBlocked === 'string') { try { const url = new URL(event.networkBlocked); void browserGuard?.trip(browserCall, { layer: 'browser', host: url.hostname, port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)), url: url.href }) } catch {} } if (typeof event.progress === 'string') context.onProgress?.(headUnits(event.progress, 400)) } catch {} }
      })
      proc.stderr.on('data', chunk => { stderr = tailUnits(stderr + String(chunk), 12000) })
      proc.on('error', error => { stderr += String(error) })
      proc.on('close', code => {
        clearTimeout(timer); if (force) clearTimeout(force)
        context.signal?.removeEventListener('abort', cancel); process.off('exit', exit)
        // Reap any browser child if the worker crashed before its own finally.
        kill('SIGKILL')
        let report: Record<string, any>
        try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { report = { status: 'failed', failure: stderr || `Browser worker exited with code ${code}`, artifacts: [reportPath] } }
        if (stopped || code !== 0 || !['passed', 'failed'].includes(report.status)) report.status = context.signal?.aborted ? 'cancelled' : 'failed'
        if (timedOut) report.failure = `Verification timed out after ${input.timeout_ms ?? 120000}ms; owned processes were stopped`
        if (context.signal?.aborted) report.failure = 'Verification cancelled; owned processes were stopped'
        writeFileSync(reportPath, JSON.stringify(report, null, 2))
        const artifacts = [request, ...(Array.isArray(report.artifacts) ? report.artifacts : []), reportPath].filter((value): value is string => typeof value === 'string' && isProjectPath(value, context.cwd) && existsSync(value))
        context.onArtifacts?.([...new Set(artifacts)])
        resolveResult({ success: report.status === 'passed', output: { status: report.status, report: reportPath, ...(typeof report.url === 'string' ? { url: report.url } : {}), checks: report.checks, assertions: report.assertions, steps: report.steps, errors: report.errors, ...(Array.isArray(report.blockedRequests) && report.blockedRequests.length ? { blockedRequests: report.blockedRequests, blockedNote: BLOCKED_NOTE } : {}), failure: report.failure, artifacts: [...new Set(artifacts)] }, error: report.status === 'passed' ? undefined : String(report.failure || 'Browser verification failed') })
      })
    })
  },
}
