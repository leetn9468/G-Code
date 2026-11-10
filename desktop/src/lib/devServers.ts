// Pure helpers for the side panel's Browser and Tasks views: the local
// dev-server addresses that background commands print, what the Browser's
// address field means, which project folder a file is served from, and the
// Browser's own back/forward history (pages loaded through the panel).

import type { BackgroundShellInfo } from '../../../src/shared/tasks'

// ---- Terminal text ------------------------------------------------------

// CSI (colours, cursor moves), OSC (titles, hyperlinks), C1 CSI and the
// remaining two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Output as a terminal would leave it: no escape codes, and a carriage
 *  return (progress bars, spinners) keeps only what was written after it. */
export function terminalText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, '\n').split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n')
}

// ---- Dev servers --------------------------------------------------------

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']
// A local address with a port: localhost, 127.0.0.1, [::1], and the
// wildcard binds 0.0.0.0 / [::] that servers print for "all interfaces".
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:[/?#][^\s'"`<>()[\]{}]*)?/gi

/** Wildcard binds are not addresses: 0.0.0.0 is opened as 127.0.0.1, [::] as [::1]. */
function localUrl(url: URL): URL {
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  else if (url.hostname === '[::]') url.hostname = '[::1]'
  return url
}

/** Local http(s) addresses with a port in `text` (ANSI codes ignored),
 *  deduplicated, the last printed first. */
export function findDevServerUrls(text: string): string[] {
  const found: string[] = []
  for (const match of stripAnsi(text).matchAll(LOCAL_URL)) {
    try {
      const href = localUrl(new URL(match[0].replace(/[.,;:!?]+$/, ''))).href
      const at = found.indexOf(href)
      if (at >= 0) found.splice(at, 1)
      found.push(href)
    } catch { /* not a URL after all (e.g. a port above 65535) */ }
  }
  return found.reverse()
}

export interface DevServer {
  url: string
  taskId: string
  /** The task's description, or else its command. */
  label: string
}

/** Addresses printed by running background commands, newest first: newer
 *  commands before older ones, and within one command the last printed
 *  first. `seen` (by task id) keeps addresses that have scrolled out of a
 *  long-running server's output tail; finished tasks are dropped from it. */
export function detectDevServers(tasks: readonly BackgroundShellInfo[], seen?: Map<string, string[]>): DevServer[] {
  const running = tasks.filter(task => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  if (seen) for (const id of [...seen.keys()]) if (!running.some(task => task.id === id)) seen.delete(id)
  const servers: DevServer[] = []
  for (const task of running) {
    let urls = findDevServerUrls(task.tail)
    if (seen) {
      urls = [...urls, ...(seen.get(task.id) ?? []).filter(url => !urls.includes(url))]
      seen.set(task.id, urls)
    }
    const label = task.description?.trim() || task.command
    for (const url of urls) if (!servers.some(server => server.url === url)) servers.push({ url, taskId: task.id, label })
  }
  return servers
}

/** Shared between the Browser and Tasks views, so both keep an address a busy server printed long ago. */
export const seenDevServers = new Map<string, string[]>()

// ---- Address field ------------------------------------------------------

export type Address =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'invalid'; message: string }

const LOCAL_HOST_PORT = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:[/?#].*)?$/i
const HOST_WITH_PORT = /^(?:[a-z\d-]+(?:\.[a-z\d-]+)*|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}(?:[/?#].*)?$/i
// A bare domain gets https only for common web TLDs, so `index.html` or
// `notes.md` stay file paths.
const WEB_DOMAIN = /^(?:[a-z\d-]+\.)+(?:com|org|net|io|dev|app|ai|co|so|sh|me|xyz|site|page|cn|uk|de|jp|edu|gov)(?::\d{1,5})?(?:[/?#].*)?$/i

function asUrl(text: string): Address {
  try {
    const url = localUrl(new URL(text))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'invalid', message: 'Only http and https addresses open here.' }
    return { kind: 'url', url: url.href }
  } catch { return { kind: 'invalid', message: `Not a valid address: ${text}` } }
}

/** What the Browser's address field asks for: a web address
 *  (`localhost:5173`, `127.0.0.1:3000/x`, `http(s)://…`) or a project file
 *  or folder, relative to the project or absolute (`dist/index.html`). */
export function parseAddress(raw: string): Address {
  const input = raw.trim()
  if (!input) return { kind: 'invalid', message: 'Enter an address or a file path.' }
  if (/^https?:\/\//i.test(input)) return asUrl(input)
  if (/^file:\/\//i.test(input)) {
    try { return { kind: 'path', path: decodeURIComponent(new URL(input).pathname) } }
    catch { return { kind: 'invalid', message: `Not a valid file address: ${input}` } }
  }
  if (LOCAL_HOST_PORT.test(input) || HOST_WITH_PORT.test(input)) return asUrl(`http://${input}`)
  if (WEB_DOMAIN.test(input)) return asUrl(`https://${input}`)
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return { kind: 'invalid', message: 'Only http and https addresses open here.' }
  return { kind: 'path', path: input }
}

/** Whether the app's content security policy lets the panel frame this
 *  address (frame-src: any https page; http only on this Mac). */
export function canFrame(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))
  } catch { return false }
}

export function isLocalAddress(href: string): boolean {
  try { return LOCAL_HOSTS.includes(new URL(href).hostname) } catch { return false }
}

// ---- Serving project files ----------------------------------------------

/** Build output folders the Browser offers to preview (plus the project root). */
export const BUILD_FOLDERS = ['dist', 'build', 'out', 'public'] as const

export interface PreviewTarget {
  /** Project folder to serve ('' = the project root). */
  folder: string
  /** Path inside it to open ('' = its index). */
  file: string
  /** Tried when serving `folder` fails (a path without an extension that turned out to be a file). */
  fallback?: { folder: string; file: string }
}

/** Which folder serves a project file, and the path to open inside it. A
 *  file under a build folder is served from that folder, so a build's
 *  root-relative asset links (`/assets/app.js`) resolve; any other file is
 *  served from its own folder. A path without an extension is a folder. */
export function previewTarget(path: string, cwd?: string): PreviewTarget {
  let relative = path.trim()
  const root = cwd?.replace(/\/+$/, '')
  if (root && relative === root) relative = ''
  else if (root && relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1)
  const absolute = relative.startsWith('/')
  const parts = relative.split('/').filter(part => part && part !== '.')
  const join = (segments: string[]) => (absolute ? '/' : '') + segments.join('/')
  if (!parts.length) return { folder: absolute ? '/' : '', file: '' }
  if (relative.endsWith('/')) return { folder: join(parts), file: '' }
  if (!absolute && parts.length > 1 && (BUILD_FOLDERS as readonly string[]).includes(parts[0])) return { folder: parts[0], file: parts.slice(1).join('/') }
  const parent = { folder: join(parts.slice(0, -1)), file: parts.at(-1)! }
  if (!parent.file.includes('.')) return { folder: join(parts), file: '', fallback: parent }
  return parent
}

/** The served address of `file` under a preview server's root address (which ends in '/'). */
export function servedUrl(base: string, file: string): string {
  return (base.endsWith('/') ? base : `${base}/`) + file.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

// ---- Panel history --------------------------------------------------------

/** Pages loaded through the panel; `index` is the page shown (-1: none). */
export interface PageHistory { entries: string[]; index: number }

export const EMPTY_HISTORY: PageHistory = { entries: [], index: -1 }
const HISTORY_LIMIT = 100

export function samePage(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  try { return new URL(a).href === new URL(b).href } catch { return a === b }
}

export const currentPage = (history: PageHistory): string | undefined => history.entries[history.index]

/** A new page: drops the forward entries (the same page again changes nothing). */
export function pushPage(history: PageHistory, href: string): PageHistory {
  if (samePage(currentPage(history), href)) return history
  const entries = [...history.entries.slice(0, history.index + 1), href].slice(-HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

/** The page shown became another address (a redirect, or the URL a served page reports for itself). */
export function replacePage(history: PageHistory, href: string): PageHistory {
  if (history.index < 0) return pushPage(history, href)
  if (history.entries[history.index] === href) return history
  const entries = [...history.entries]
  entries[history.index] = href
  return { entries, index: history.index }
}

/** A page reported where it is now: the page shown, a step back or forward
 *  (the page used its own history), or a new page (a link or pushState). */
export function observePage(history: PageHistory, href: string): PageHistory {
  if (samePage(currentPage(history), href)) return history
  if (samePage(history.entries[history.index - 1], href)) return { ...history, index: history.index - 1 }
  if (samePage(history.entries[history.index + 1], href)) return { ...history, index: history.index + 1 }
  return pushPage(history, href)
}

/** Back or forward one page. Back from the first page reaches index -1, the
 *  Browser's start screen; Forward from there returns to the first page. */
export function stepPage(history: PageHistory, delta: -1 | 1): PageHistory {
  const index = history.index + delta
  return index < -1 || index >= history.entries.length ? history : { ...history, index }
}
