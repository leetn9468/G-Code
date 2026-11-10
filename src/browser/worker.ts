import { assertToolFile } from '../session/scopedPermission.js'
/** Isolated, owned Playwright run. No attachment to personal browser profiles. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, writeFile, stat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, extname, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { browserPlanSchema } from './plan.js'
import { browserDriverPath, browserRuntimeRoot } from './paths.js'
import { BLOCKED_LIMIT, assertObservation, consoleError, entryFolder, entryPath, hiddenPath, ownBlock, previewType, refusedLoad, seedPage } from './observations.js'
import { devServerLog, startDevServer } from './devServer.js'
import { headUnits } from '../utils/textUnits.js'
import type { Browser, BrowserServer, Page } from 'playwright-core'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** A failure as the report gives it: a plain Error's message alone, since the tool result adds its own 'Error: '. Named errors (TimeoutError) keep their name. */
const failureText = (error: unknown) => error instanceof Error && error.name === 'Error' ? error.message : String(error)
export function inside(root: string, path: string): boolean { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part) }

const BROWSER_ARGS = ['--no-proxy-server', '--password-store=basic', '--use-mock-keychain']
/**
 * Chromium under the guard runs in the loopback-only Seatbelt profile the engine made (see browserProfile),
 * started through chromium-guard.sh, which tools cannot change. No profile means no launch. Names resolve
 * to nothing inside Chromium: its own lookups would otherwise reach the system resolver and port 53.
 */
export function guardedChromium(executable: string) {
  const profile = process.env.GCODE_BROWSER_CHROMIUM_PROFILE
  if (!profile) throw new Error('Missing browser sandbox profile; Chromium was not started.')
  const wrapper = join(browserRuntimeRoot(), 'chromium-guard.sh')
  if (!existsSync(wrapper)) throw new Error('Bundled browser sandbox launcher is missing; Chromium was not started. Rebuild or reinstall the full G-Code app.')
  return { executablePath: wrapper, chromiumSandbox: false, args: [...BROWSER_ARGS, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost'], env: { ...process.env, GCODE_CHROMIUM_EXECUTABLE: executable } as Record<string, string> }
}

export async function runBrowserWorker(requestPath: string): Promise<void> {
  assertToolFile(requestPath)
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as { cwd: string; output: string; plan: unknown; planHash: string; sessionId: string; assessment?: Record<string, unknown> }
  const plan = browserPlanSchema.parse(request.plan)
  const root = await realpath(request.cwd)
  const output = await realpath(request.output)
  if (!inside(root, output)) throw new Error('Verification output must belong to this project')
  const entry = await realpath(resolve(root, plan.entry))
  if (!inside(root, entry) || extname(entry) !== '.html') throw new Error('Entry must be a project HTML file')
  assertToolFile(entry)
  const entryHash = hash(await readFile(entry))
  const emit = (detail: string) => process.stdout.write(JSON.stringify({ progress: detail }) + '\n')
  const startedAt = new Date().toISOString()
  const steps: Array<Record<string, unknown>> = []
  const errors: string[] = []
  // Requests to other origins the run aborted, reported apart from page errors.
  const blocked = new Set<string>()
  const block = (href: string) => { if (blocked.size < BLOCKED_LIMIT) blocked.add(headUnits(href, 500)) }
  const artifacts: string[] = []
  let ownedServer: BrowserServer | undefined; let browser: Browser | undefined; let page: Page | undefined
  let development: Awaited<ReturnType<typeof startDevServer>> | undefined
  let opened: string | undefined
  const servedFiles = new Map<string, string>()
  // Project files the preview refused for their type, by URL path: their failed loads say why.
  const refusedTypes = new Map<string, string>()
  let cancelled = false; let failure: string | undefined; let browserVersion: string | undefined
  const cancel = () => { cancelled = true; void browser?.close().catch(() => {}) }
  const delay = async (ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) { if (cancelled) throw new Error('Verification cancelled'); await new Promise(done => setTimeout(done, Math.min(50, until - Date.now()))) }
  }
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel)
  const folder = entryFolder(root, entry)
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      if (hiddenPath(path, folder)) { res.writeHead(403).end(); return }
      const file = await realpath(resolve(root, '.' + (path === '/' ? '/' + relative(root, entry) : path)))
      if (!inside(root, file) || !(await stat(file)).isFile()) { res.writeHead(403).end(); return }
      const type = previewType(extname(file))
      if (!type) { refusedTypes.set(path, extname(file)); res.writeHead(403).end(); return }
      assertToolFile(file)
      const bytes = await readFile(file); servedFiles.set(relative(root, file), hash(bytes))
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch { res.writeHead(404).end() }
  })
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot bind preview server')
    if (plan.version === 2 && plan.server) {
      emit('Starting owned development server')
      // A server that failed to start still wrote its log, and the log is where its cause is.
      development = await startDevServer(plan.server, root, output, () => cancelled).catch(error => {
        if (existsSync(devServerLog(output))) artifacts.push(devServerLog(output))
        throw error
      })
      artifacts.push(development.logPath)
    }
    const origin = development?.origin ?? `http://127.0.0.1:${address.port}`
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(browserRuntimeRoot(), 'browsers')
    if (plan.steps.some(step => step.action === 'background')) process.env.GCODE_REAL_TAB_VISIBILITY = '1'
    // Keep Playwright's dynamic files outside the compiled CLI and pinned in the bundle.
    const require = createRequire(join(browserDriverPath(), 'package.json'))
    const playwright = require(browserDriverPath()) as typeof import('playwright-core')
    emit('Launching isolated Chromium')
    const guarded = process.env.GCODE_BROWSER_GUARD === '1'
    // Nothing guarded puts a window on screen, and a windowed Chromium has never run under this profile.
    if (guarded && plan.headed) throw new Error('A headed browser is not available under Guillotine Mode. Remove "headed" from the plan.')
    // The first run of the bundled Chromium can wait on macOS; a kill restarts that wait.
    ownedServer = await playwright.chromium.launchServer({ host: '127.0.0.1', headless: !plan.headed, timeout: 90_000,
      ...(guarded ? guardedChromium((playwright.chromium.executablePath as (options: { channel: string }) => string)({ channel: 'chromium' })) : { channel: 'chromium', chromiumSandbox: true, args: BROWSER_ARGS }) })
    process.stdout.write(JSON.stringify({ browserPid: ownedServer.process()?.pid }) + '\n')
    browser = await playwright.chromium.connect(ownedServer.wsEndpoint(), { timeout: 10000 })
    browserVersion = browser.version()
    if (cancelled) throw new Error('Verification cancelled')
    const context = await browser.newContext({ viewport: plan.viewport, serviceWorkers: 'block', acceptDownloads: false })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) block(url.href)
      if (url.origin !== origin && process.env.GCODE_BROWSER_GUARD === '1') process.stdout.write(JSON.stringify({ networkBlocked: url.href }) + '\n')
      return url.origin === origin ? route.continue() : route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url())
      if (!(development && url.host === new URL(origin).host && url.protocol === 'ws:') && process.env.GCODE_BROWSER_GUARD === '1') process.stdout.write(JSON.stringify({ networkBlocked: url.href }) + '\n')
      if (development && url.host === new URL(origin).host && url.protocol === 'ws:') socket.connectToServer()
      else { block(url.href); socket.close() }
    })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    page = await context.newPage()
    if (plan.version === 2) await seedPage(page, plan.seed)
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => { if (errors.length < 30) errors.push(headUnits(String(error), 2000)) })
    page.on('console', message => { if (message.type() === 'error' && !ownBlock(message.text()) && errors.length < 30) errors.push(headUnits(refusedLoad(message, refusedTypes) ?? consoleError(message), 2000)) })
    page.on('dialog', dialog => { errors.push(`Unexpected ${dialog.type()}: ${headUnits(dialog.message(), 500)}`); void dialog.dismiss() })
    opened = development?.url ?? origin + entryPath(root, entry)
    const response = await page.goto(opened, { waitUntil: 'load', timeout: 15000 })
    if (!response?.ok()) throw new Error(`Preview HTTP ${response?.status() ?? 'unavailable'}`)
    const saved: Record<string, unknown> = {}
    for (const [index, step] of plan.steps.entries()) {
      if (cancelled) throw new Error('Verification cancelled')
      const start = Date.now(); emit(`Check ${index + 1}/${plan.steps.length}: ${step.name}`)
      let observed: unknown
      try {
        switch (step.action) {
          case 'click': await page.locator(step.selector).click(); break
          case 'press': await page.keyboard.press(step.key); break
          case 'fill': await page.locator(step.selector).fill(step.value); break
          case 'check': await page.locator(step.selector).setChecked(step.checked); break
          case 'select': await page.locator(step.selector).selectOption(step.value); break
          case 'expect': observed = await assertObservation(page, step.expected, step.timeout_ms, () => cancelled); break
          case 'wait': await delay(step.ms); break
          case 'capture': saved[step.key] = await page.evaluate(({ code, saved }) => new Function('saved', `return (${code})`)(saved), { code: step.expression, saved }); break
          case 'assert': {
            // Strict boolean success; strings, missing values and exceptions never pass.
            await page.waitForFunction(({ code, saved }) => new Function('saved', `return (${code})`)(saved) === true, { code: step.expression, saved }, { timeout: step.timeout_ms, polling: 100 }); break
          }
          case 'viewport': await page.setViewportSize({ width: step.width, height: step.height }); break
          case 'screenshot': { const path = join(output, `${String(index + 1).padStart(2, '0')}-screenshot.png`); await page.screenshot({ path, fullPage: true }); artifacts.push(path); break }
          case 'background': {
            const cdp = await context.newCDPSession(page)
            // Let Chromium report real tab visibility instead of Playwright's
            // forced focus. Never patch document.hidden or dispatch fake events.
            await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
            const other = await context.newPage()
            try {
              await other.goto('about:blank'); await other.bringToFront()
              await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { timeout: 3000 })
              await delay(step.ms)
            } finally { await other.close(); await page.bringToFront(); await cdp.detach() }
            break
          }
        }
        steps.push({ name: step.name, action: step.action, status: 'passed', durationMs: Date.now() - start, ...(step.action === 'expect' ? { expected: step.expected, observed } : {}) })
      } catch (error) {
        steps.push({ name: step.name, action: step.action, status: 'failed', durationMs: Date.now() - start, error: headUnits(failureText(error), 5000) })
        for (const rest of plan.steps.slice(index + 1)) steps.push({ name: rest.name, action: rest.action, status: 'skipped' })
        throw error
      }
    }
    if (errors.length) throw new Error(`${errors.length} browser console/page error(s)`)
    const final = join(output, 'final.png'); await page.screenshot({ path: final, fullPage: true }); artifacts.push(final)
  } catch (error) {
    failure = headUnits(failureText(error), 6000)
    for (const rest of plan.steps.slice(steps.length)) steps.push({ name: rest.name, action: rest.action, status: 'skipped' })
    if (page && !page.isClosed()) { const path = join(output, 'failure.png'); try { await page.screenshot({ path }); artifacts.push(path) } catch {} }
  } finally {
    if (browser) {
      const trace = join(output, 'trace.zip')
      try { await browser.contexts()[0]?.tracing.stop({ path: trace }); artifacts.push(trace) } catch {}
      await browser.close().catch(() => {})
    }
    await ownedServer?.close().catch(() => {})
    await development?.stop()
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel)
  }
  const reportPath = join(output, 'report.json')
  const report = { status: cancelled ? 'cancelled' : failure ? 'failed' : 'passed', sessionId: request.sessionId, startedAt, finishedAt: new Date().toISOString(), engine: 'Playwright Chromium', browserVersion,
    entry, entrySha256: entryHash, ...(opened ? { url: opened } : {}), planSha256: request.planHash, assessment: request.assessment,
    seed: plan.version === 2 ? plan.seed : null, servedFiles: Object.fromEntries(servedFiles),
    developmentServer: development ? { command: development.command, args: development.args, url: development.url, sourceBinding: 'Entry hash is project provenance; development server responses may be transformed' } : undefined,
    steps, errors, ...(blocked.size ? { blockedRequests: [...blocked] } : {}), failure, artifacts: [...artifacts, reportPath],
    checks: { passed: steps.filter(step => step.status === 'passed').length, failed: steps.filter(step => step.status === 'failed').length, skipped: steps.filter(step => step.status === 'skipped').length },
    assertions: { passed: steps.filter(step => ['assert','expect'].includes(String(step.action)) && step.status === 'passed').length, failed: steps.filter(step => ['assert','expect'].includes(String(step.action)) && step.status === 'failed').length, skipped: steps.filter(step => ['assert','expect'].includes(String(step.action)) && step.status === 'skipped').length },
    cleanup: 'Owned browser and preview server closed; personal browser untouched' }
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ report: reportPath }) + '\n')
  process.exitCode = report.status === 'passed' ? 0 : 1
}
