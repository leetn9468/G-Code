import { basename, dirname, relative, sep } from 'node:path'
import type { ConsoleMessage, Page } from 'playwright-core'
import type { z } from 'zod'
import type { expectationSchema } from './plan.js'

/** Most blocked URLs a run reports. */
export const BLOCKED_LIMIT = 30

/** What the run tells the model about the requests it blocked. */
export const BLOCKED_NOTE = "G-Code's isolated browser has no external network, so it blocked these requests to other origins. They are not counted as page errors; a page that needs them (web fonts, CDN scripts) renders or runs without them here."

/**
 * The file types G-Code's preview server serves, by extension: the web's own (pages, scripts,
 * styles, data, images, fonts, media). Another type is refused, and its failed load says so
 * (refusedLoad): .ttf, .webp and .jpeg fonts and images were refused as bare 403 page errors.
 */
export const PREVIEW_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'application/xml', '.vtt': 'text/vtt', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
}

/** The Content-Type the preview serves `extension` with (any letter case), or undefined when it refuses that type. */
export function previewType(extension: string): string | undefined {
  return PREVIEW_TYPES[extension.toLowerCase()]
}

/**
 * A failed load of a project file the preview refused for its type (`refused`: URL path → its
 * extension), worded as G-Code's refusal; undefined for any other console error.
 */
export function refusedLoad(message: ConsoleMessage, refused: ReadonlyMap<string, string>): string | undefined {
  const url = message.location()?.url
  if (!url || !refused.size || !message.text().startsWith('Failed to load resource')) return
  let path: string
  try { path = decodeURIComponent(new URL(url).pathname) } catch { return }
  const type = refused.get(path)
  return type === undefined ? undefined : `Not served: ${url}. G-Code's preview server serves web file types only, not ${type || 'files without an extension'}; a page that needs it can be served by a development server (the plan's server option).`
}

/**
 * The console error Chromium logs for a request G-Code's own route aborted ('blockedbyclient': a
 * font, CDN or analytics origin other than the preview's). The owned browser has no extensions, so
 * only G-Code blocks requests: counted as a page error, it failed a run whose checks all passed,
 * without saying which URL was blocked or that G-Code blocked it.
 */
export function ownBlock(text: string): boolean {
  return /net::ERR_BLOCKED_BY_CLIENT/.test(text)
}

/**
 * The entry's folder in the project, as a URL path without slashes at its ends ('' in the root).
 * A preview opened every entry at '/', so a page in a subfolder loaded its relative URLs from the
 * project root: the root's same-named files, or a 404 that did not say which file was missing.
 */
export function entryFolder(root: string, entry: string): string {
  return relative(root, dirname(entry)).split(sep).filter(Boolean).join('/')
}

/** Where a preview opens the entry: '/' for a page in the project root, else its own path. */
export function entryPath(root: string, entry: string): string {
  const folder = entryFolder(root, entry)
  return folder ? `/${[...folder.split('/'), basename(entry)].map(encodeURIComponent).join('/')}` : '/'
}

/**
 * A path a preview refuses: one in a dot-folder or node_modules (.git, .env), except below the
 * entry's own folder, which the plan chose (a copy under .gcode/ to compare against).
 */
export function hiddenPath(pathname: string, folder: string): boolean {
  const own = folder && pathname.startsWith(`/${folder}/`) ? pathname.slice(folder.length + 1) : pathname
  return own.split('/').some(part => part.startsWith('.') || part === 'node_modules')
}

/** A console error as a report lists it: a failed load names its URL, which Chromium's text leaves out. */
export function consoleError(message: ConsoleMessage): string {
  const text = message.text(), url = message.location()?.url
  return url && text.startsWith('Failed to load resource') && !text.includes(url) ? `${text}: ${url}` : text
}

/**
 * Text as a page shows it: runs of whitespace one space, ends trimmed, as Playwright's toHaveText
 * reads it. Raw textContent keeps the source's line breaks and indentation, so a heading written
 * across lines failed an exact check of the words it shows, and the model rewrote the page to fit.
 */
export function shownText(text: string): string {
  return text.replace(/​/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * An element's text with a line break and each block's edges read as whitespace, and what is not
 * displayed left out: textContent ran "Grown in<br>the mist" together as "Grown inthe mist".
 * Letters stay as written (no text-transform), so a check is of the words, not their styling.
 */
function renderedText(root: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.nodeValue ?? ''); return }
    if (!(node instanceof Element)) return
    if (node.tagName === 'BR') { parts.push(' '); return }
    const display = getComputedStyle(node).display
    if (display === 'none') return
    const block = display !== 'contents' && !display.startsWith('inline')
    if (block) parts.push(' ')
    node.childNodes.forEach(walk)
    if (block) parts.push(' ')
  }
  root.childNodes.forEach(walk)
  return parts.join('')
}

export async function observe(page: Page, expected: z.infer<typeof expectationSchema>): Promise<unknown> {
  switch (expected.kind) {
    case 'text': return shownText(await page.locator(expected.selector).evaluate(renderedText, undefined, { timeout: 500 }))
    case 'value': return page.locator(expected.selector).inputValue({ timeout: 500 })
    case 'visible': return page.locator(expected.selector).isVisible()
    case 'checked': return page.locator(expected.selector).isChecked({ timeout: 500 })
    case 'count': return page.locator(expected.selector).count()
    case 'title': return page.title()
    case 'path': return new URL(page.url()).pathname
    case 'no-horizontal-overflow': return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  }
}

export async function assertObservation(page: Page, expected: z.infer<typeof expectationSchema>, timeout: number, cancelled: () => boolean): Promise<unknown> {
  const target = expected.kind === 'text' ? shownText(expected.equals) : 'equals' in expected ? expected.equals : true
  const deadline = Date.now() + timeout
  let observed: unknown, lastError: unknown
  do {
    if (cancelled()) throw new Error('Verification cancelled')
    try { observed = await observe(page, expected); if (observed === target) return observed } catch (error) { lastError = error }
    await new Promise(resolve => setTimeout(resolve, 75))
  } while (Date.now() < deadline)
  throw new Error(`Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed) ?? 'unavailable'}${lastError ? ` (${String(lastError)})` : ''}`)
}

export async function seedPage(page: Page, seed: number): Promise<void> {
  await page.addInitScript(value => {
    let state = value >>> 0
    Math.random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296 }
  }, seed)
}
