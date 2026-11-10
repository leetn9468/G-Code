/** Bundled MCP adapter: isolated local-project browser, ordinary G-Code gates. */
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Browser, BrowserServer, Page } from 'playwright-core'
import { browserDriverPath, browserRuntimeRoot } from './paths.js'
import { isProjectPath, assertToolFile } from '../session/scopedPermission.js'
import { expectationSchema } from './plan.js'
import { BLOCKED_LIMIT, BLOCKED_NOTE, assertObservation, consoleError, entryFolder, entryPath, hiddenPath, ownBlock, previewType, refusedLoad } from './observations.js'

const schemas = {
  browser_open: z.object({ entry: z.string().optional(), url: z.string().url().optional() }).strict().refine(value => !!value.entry !== !!value.url, 'Provide either a project HTML entry or an explicit loopback URL'),
  browser_snapshot: z.object({}).strict(),
  browser_click: z.object({ selector: z.string().min(1).max(500) }).strict(),
  browser_fill: z.object({ selector: z.string().min(1).max(500), value: z.string().max(4000) }).strict(),
  browser_press: z.object({ key: z.string().min(1).max(80) }).strict(),
  browser_expect: z.object({ expected: expectationSchema }).strict(),
  browser_screenshot: z.object({}).strict(),
  browser_close: z.object({}).strict(),
}
const descriptions: Record<keyof typeof schemas, string> = {
  browser_open: 'Open a project HTML entry or explicit local loopback URL in a new isolated browser. Replaces only this adapter\'s browser.',
  browser_snapshot: 'Read visible page text and controls; no page script is accepted.',
  browser_click: 'Click a selector in the isolated page.', browser_fill: 'Fill a form input in the isolated page.', browser_press: 'Press a key in the isolated page.',
  browser_expect: 'Assert a concrete read-only page observation. Failure is an error, never a passing result.',
  browser_screenshot: 'Save a screenshot in the project and return its artifact path.', browser_close: 'Close the owned browser and preview server; save trace and action evidence.',
}
let browser: Browser | undefined, owner: BrowserServer | undefined, page: Page | undefined
let preview: ReturnType<typeof createServer> | undefined
/** Project files the preview refused for their type, by URL path: their failed loads say why. */
const refusedTypes = new Map<string, string>()
let output: string | undefined
let records: unknown[] = [], errors: string[] = [], blocked: string[] = []
const ownedBrowsers = new Set<BrowserServer>()
const root = await realpath(process.cwd())
let lifecycle = 0
async function close() {
  lifecycle++
  const activeBrowser = browser, activeOwner = owner, activePreview = preview, activeOutput = output
  const activeRecords = records, activeErrors = errors, activeBlocked = blocked
  browser = undefined; owner = undefined; page = undefined; preview = undefined; output = undefined; records = []; errors = []; blocked = []; refusedTypes.clear()
  const artifacts: string[] = []
  if (activeBrowser && activeOutput) { const path = join(activeOutput, 'trace.zip'); try { await activeBrowser.contexts()[0]?.tracing.stop({ path }); artifacts.push(path) } catch {} }
  await activeBrowser?.close().catch(() => {})
  if (activeOwner) { await activeOwner.close().catch(() => {}); ownedBrowsers.delete(activeOwner) }
  if (activePreview) { activePreview.closeAllConnections(); await new Promise<void>(done => activePreview.close(() => done())) }
  if (activeOutput) { const path = join(activeOutput, 'interaction.json'); await writeFile(path, JSON.stringify({ status: 'interaction-record', records: activeRecords, errors: activeErrors, ...(activeBlocked.length ? { blockedRequests: activeBlocked } : {}), coverage: 'Interactive actions only; no claim of complete project verification' }, null, 2)); artifacts.push(path) }
  return artifacts
}
async function snapshot() {
  if (!page) throw new Error('Open a page first')
  return { url: page.url(), title: await page.title(), errors: [...errors], ...(blocked.length ? { blockedRequests: [...blocked], blockedNote: BLOCKED_NOTE } : {}), ...await page.evaluate(() => {
    // Runs in the page, so it cannot import headUnits: a cut never keeps half of a surrogate pair.
    const head = (text: string, length: number) => text.length <= length ? text : text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length)
    const label = (element: Element) => element.getAttribute('aria-label') || (element.textContent == null ? undefined : head(element.textContent.trim(), 160))
    return { text: head(document.body.innerText, 32000), controls: Array.from(document.querySelectorAll('button,input,select,textarea,a')).slice(0, 100).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, role: element.getAttribute('role'), label: label(element), name: element.getAttribute('name') })) }
  }) }
}
async function call(name: keyof typeof schemas, args: any): Promise<Record<string, unknown>> {
  if (name === 'browser_close') return { artifacts: await close(), closed: true }
  if (name === 'browser_open') {
    const previousArtifacts = await close()
    // This adapter is a guard-off browser exception. The parent refuses it in guarded sessions.
    const revision = lifecycle
    const check = () => { if (revision !== lifecycle) throw new Error('Browser operation cancelled') }
    let url: URL
    if (args.url) {
      url = new URL(args.url)
      if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || !url.port) throw new Error('Use an explicit http loopback URL and port')
    } else {
      const entry = await realpath(resolve(root, args.entry))
      if (!isProjectPath(entry, root) || extname(entry) !== '.html') throw new Error('Entry must be a project HTML file')
      const folder = entryFolder(root, entry)
      preview = createServer(async (request, response) => {
        try {
          if (!['GET','HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return }
          const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
          if (hiddenPath(pathname, folder)) { response.writeHead(403).end(); return }
          const path = await realpath(resolve(root, '.' + (pathname === '/' ? '/' + relative(root, entry) : pathname)))
          if (!isProjectPath(path, root) || !(await stat(path)).isFile()) { response.writeHead(403).end(); return }
          const type = previewType(extname(path))
          if (!type) { refusedTypes.set(pathname, extname(path)); response.writeHead(403).end(); return }
          assertToolFile(path)
          response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : await readFile(path))
        } catch { response.writeHead(404).end() }
      })
      await new Promise<void>((done, reject) => { preview!.once('error', reject); preview!.listen(0, '127.0.0.1', done) })
      const address = preview.address(); if (!address || typeof address === 'string') throw new Error('Cannot open project preview')
      url = new URL(`http://127.0.0.1:${address.port}${entryPath(root, entry)}`)
    }
    check()
    output = join(root, '.gcode', 'browser-mcp', randomUUID())
    if (!isProjectPath(output, root)) throw new Error('Evidence folder escapes the project')
    await mkdir(output, { recursive: true }); check()
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(browserRuntimeRoot(), 'browsers')
    const playwright = createRequire(join(browserDriverPath(), 'package.json'))(browserDriverPath()) as typeof import('playwright-core')
    owner = await playwright.chromium.launchServer({ host: '127.0.0.1', headless: true, channel: 'chromium', chromiumSandbox: true, args: ['--no-proxy-server', '--password-store=basic', '--use-mock-keychain'] }); ownedBrowsers.add(owner); check()
    browser = await playwright.chromium.connect(owner.wsEndpoint()); check()
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    const block = (href: string) => { if (blocked.length < BLOCKED_LIMIT && !blocked.includes(href)) blocked.push(href.slice(0, 500)) }
    await context.route('**/*', route => { const target = route.request().url(); if (new URL(target).origin === url.origin) return route.continue(); block(target); return route.abort('blockedbyclient') })
    await context.routeWebSocket('**/*', socket => { const target = new URL(socket.url()); if (args.url && target.host === url.host && target.protocol === 'ws:') socket.connectToServer(); else { block(target.href); socket.close() } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    check(); page = await context.newPage(); check(); page.setDefaultTimeout(5000)
    page.on('pageerror', error => { if (errors.length < 30) errors.push(String(error)) })
    page.on('console', message => { if (message.type() === 'error' && !ownBlock(message.text()) && errors.length < 30) errors.push(refusedLoad(message, refusedTypes) ?? consoleError(message)) })
    page.on('dialog', dialog => { errors.push(`Unexpected dialog: ${dialog.type()}`); void dialog.dismiss() })
    const response = await page.goto(url.href, { waitUntil: 'load', timeout: 15000 })
    check(); if (!response?.ok()) throw new Error(`Browser HTTP ${response?.status() ?? 'unavailable'}`)
    return { ...await snapshot(), artifacts: previousArtifacts }
  }
  if (!page) throw new Error('Open a page first')
  switch (name) {
    case 'browser_click': await page.locator(args.selector).click(); break
    case 'browser_fill': await page.locator(args.selector).fill(args.value); break
    case 'browser_press': await page.keyboard.press(args.key); break
    case 'browser_expect': {
      const observed = await assertObservation(page, args.expected, 5000, () => !page)
      if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`)
      return { observed, assertionPassed: true }
    }
    case 'browser_screenshot': { const path = join(output!, `${randomUUID()}.png`); await page.screenshot({ path, fullPage: true }); return { artifacts: [path] } }
  }
  return snapshot()
}
async function dispatch(request: any) {
  const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  if (request.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gcode-browser', version: '1.0.0' } })
  if (request.method === 'tools/list') return reply({ tools: Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], inputSchema: zodToJsonSchema(schema, { $refStrategy: 'none' }) })) })
  if (request.method === 'resources/list') return reply({ resources: [] })
  if (request.method === 'prompts/list') return reply({ prompts: [] })
  if (request.method === 'ping') return reply({})
  if (request.method === 'tools/call') {
    const name = request.params?.name as keyof typeof schemas
    try {
      if (!Object.hasOwn(schemas, name)) throw new Error('Unknown browser tool')
      const args = schemas[name].parse(request.params.arguments ?? {})
      const result = await call(name, args)
      records.push({ name, args, status: 'complete', at: new Date().toISOString() })
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    } catch (error) {
      records.push({ name, status: 'failed', error: String(error), at: new Date().toISOString() })
      const artifacts = name === 'browser_open' ? await close() : []
      return reply({ isError: true, content: [{ type: 'text', text: String(error) }], structuredContent: { artifacts } })
    }
  }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n')
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = Promise.resolve()
const shutdown = () => { lines.close(); void close().finally(() => process.exit(0)); setTimeout(() => { for (const instance of ownedBrowsers) { const child = instance.process(); try { if (child?.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child?.kill('SIGKILL') } catch {} }; process.exit(1) }, 2500).unref() }
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, shutdown)
lines.on('line', line => {
  if (line.length > 1024 * 1024) return
  try { const request = JSON.parse(line); if (request.method === 'notifications/cancelled') { void close(); return }; pending = pending.then(() => dispatch(request)).then(() => {}, error => { process.stderr.write(String(error) + '\n') }) } catch {}
})
process.stdin.on('end', shutdown)
