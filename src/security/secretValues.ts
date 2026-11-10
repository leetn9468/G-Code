/**
 * @file secretValues.ts
 * @brief The API keys and tokens G-Code holds, and taking them out of what tools return.
 *
 * Tools may not read G-Code's key files, but a command can print a key in ways no name check sees
 * (`cat "$(echo ~)/.gc""ode/settings.json"`, `env`, a script). So the values themselves are masked in
 * every tool result, before it reaches the model, the frames or the saved session. An encoded key
 * (base64, say) would still get through: this is a net under the refusals, not a sandbox.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_KEY_ENV } from '../llm/provider.js'
import { tailOutput } from '../utils/textUnits.js'

/** Shorter values could be ordinary words: masking them would damage results, and they are not real keys. */
const SHORTEST = 12
const MASK = '[hidden: API key]'
/** Fields of G-Code's settings, ~/.gcode/mcp.json and ~/.gcode/auth/* that hold a secret, not the name or address of one. */
const SECRET_FIELD = /key|token|secret|passw|credential|authorization|bearer|cookie|(?:^|[_-])(?:pat|pwd|jwt)(?:$|[_-])/i
const NOT_A_VALUE = /(?:env|url|uri|endpoint|header(?:name)?|type|method|path|dir|file|name|id)$/i
/** What stands in for a secret in a configuration file, or is a place and not a value. */
const NOT_A_SECRET = /\$\{|\$\(|^\$|^<.*>$|^your[-_]|changeme|example|x{6,}|^(?:\/|~|\.\.?\/|https?:)/i

interface Found { values: Set<string>; variables: Set<string> }

function keep(text: string, found: Found): void {
  // `Bearer abc`: the secret is the last word.
  const value = text.trim().split(/\s+/).pop() ?? ''
  if (value && !NOT_A_SECRET.test(value)) found.values.add(value)
}

function secretsInUrl(text: string, found: Found): void {
  try {
    const url = new URL(text.trim())
    if (url.password) keep(decodeURIComponent(url.password), found)
    if (url.username) keep(decodeURIComponent(url.username), found)
    for (const [name, value] of url.searchParams) if (SECRET_FIELD.test(name)) keep(value, found)
  } catch { /* Not a URL after all: it holds nothing to find. */ }
}

/** `--api-key VALUE`, `--token=VALUE`, `Authorization: Bearer VALUE` in a server's command line. */
function secretsInArguments(items: unknown[], found: Found): void {
  items.forEach((item, index) => {
    if (typeof item !== 'string') return
    const flag = /^--?([\w-]+)(?:=(.*))?$/.exec(item)
    if (flag && SECRET_FIELD.test(flag[1]!) && !NOT_A_VALUE.test(flag[1]!)) {
      const value = flag[2] ?? items[index + 1]
      if (typeof value === 'string') keep(value, found)
    } else if (/^(?:authorization|cookie|[\w-]*key)\s*:/i.test(item)) keep(item, found)
    else if (/^https?:/i.test(item)) secretsInUrl(item, found)
  })
}

function collect(value: unknown, field: string, found: Found): void {
  if (typeof value === 'string') {
    const text = value.trim()
    const named = /^\$\{(\w+)\}$/.exec(text)
    if (/^https?:/i.test(text)) secretsInUrl(text, found)
    else if (named && SECRET_FIELD.test(field)) found.variables.add(named[1]!)
    // tokenEnv, clientSecretEnv: the name of the variable that holds the secret.
    else if (/env$/i.test(field) && SECRET_FIELD.test(field)) found.variables.add(text)
    else if (SECRET_FIELD.test(field) && !NOT_A_VALUE.test(field)) keep(text, found)
  } else if (Array.isArray(value)) {
    if (field === 'args') secretsInArguments(value, found)
    else value.forEach(item => collect(item, field, found))
  } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) collect(child, key, found)
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined /* Missing or not JSON: it holds no key we can know. */ }
}

const stamp = (path: string) => { try { const { mtimeMs, size } = statSync(path); return `${path}:${mtimeMs}:${size}` } catch { return '' } }
const entries = (path: string) => { try { return readdirSync(path) } catch { return [] } }

let saved: { signature: string; found: Found } | undefined

/** What ~/.gcode/settings.json, its backup, ~/.gcode/mcp.json and ~/.gcode/auth hold; read again only when one of them changed. */
function savedSecrets(): Found {
  const home = join(homedir(), '.gcode')
  const auth = join(home, 'auth')
  const files = entries(auth).map(name => join(auth, name))
  const signature = [join(home, 'settings.json'), join(home, 'settings.json.bak'), join(home, 'mcp.json'), ...files].map(stamp).join('|')
  if (saved?.signature === signature) return saved.found
  const found: Found = { values: new Set(), variables: new Set() }
  // The backup beside the settings file holds what the file held before its last save.
  for (const name of ['settings.json', 'settings.json.bak']) {
    const settings = readJson(join(home, name)) as { provider?: { apiKeys?: unknown } } | undefined
    if (settings?.provider?.apiKeys && typeof settings.provider.apiKeys === 'object') {
      for (const key of Object.values(settings.provider.apiKeys)) if (typeof key === 'string') found.values.add(key.trim())
    }
    collect(settings, '', found)
  }
  collect(readJson(join(home, 'mcp.json')), '', found)
  for (const file of files) collect(readJson(file), '', found)
  saved = { signature, found }
  return found
}

/** The API keys and tokens G-Code knows of, longest first (one may hold another). */
export function knownSecrets(): string[] {
  const { values: stored, variables } = savedSecrets()
  const values = new Set(stored)
  for (const name of [...Object.values(PROVIDER_KEY_ENV), ...variables]) { const value = process.env[name]?.trim(); if (value) values.add(value) }
  return [...values].filter(value => value.length >= SHORTEST).sort((a, b) => b.length - a.length)
}

/**
 * Whether a file's bytes hold a key G-Code knows of, as UTF-8 or UTF-16 text. Compared on the bytes of
 * the whole file, so invalid text around a key changes nothing and no read boundary can cut one. An
 * encoded key (base64, say) is not seen, as in masking.
 */
export function holdsKnownKey(bytes: Buffer): boolean {
  return knownSecrets().some(secret => bytes.includes(Buffer.from(secret, 'utf8'))
    || bytes.includes(Buffer.from(secret, 'utf16le')) || bytes.includes(Buffer.from(secret, 'utf16le').swap16()))
}

/** `text` with every key G-Code knows of replaced. */
export function maskSecrets(text: string): string {
  let masked = text
  for (const secret of knownSecrets()) if (masked.includes(secret)) masked = masked.split(secret).join(MASK)
  return masked
}

/**
 * Like maskSecrets, for a stretch of output already cut at one end: what is left at the cut may be
 * part of a key, which no longer reads as one, so everything a key could still reach is dropped.
 */
export function maskSecretsInCutText(text: string, cut: 'start' | 'end'): string {
  const reach = (knownSecrets()[0]?.length ?? 1) - 1
  const masked = maskSecrets(text)
  return !reach ? masked : cut === 'start' ? masked.slice(reach) : masked.slice(0, Math.max(0, masked.length - reach))
}

/** A key's start shorter than this says nothing, and ordinary text often ends that way. */
const SHORTEST_PART = 4

/**
 * `text`, of a command still running, without what may be a key it is halfway through printing: the
 * end that matches a key's start. It shows once the rest has come, as the key's mask or as what it is.
 */
export function withoutUnfinishedKey(text: string): string {
  let cut = 0
  for (const secret of knownSecrets()) {
    for (let length = Math.min(secret.length - 1, text.length); length >= SHORTEST_PART && length > cut; length--) {
      if (text.endsWith(secret.slice(0, length))) { cut = length; break }
    }
  }
  return cut ? text.slice(0, text.length - cut) : text
}

/**
 * The end of `output`, at most `units` long, with every key masked: masked before it is cut, so no
 * part of a key is left at the cut. `lostStart`: `output` itself no longer has its start.
 * `running`: more output may follow (see withoutUnfinishedKey).
 */
export function maskedTail(output: string, units: number, lostStart = false, running = false): string {
  const reach = (knownSecrets()[0]?.length ?? 1) - 1
  // One more than is shown: the cut below always falls inside what is left, and starts it on a whole character or line.
  const wide = output.length > units + reach + 1 ? output.slice(output.length - units - reach - 1) : output
  const cut = lostStart || wide.length < output.length
  const masked = cut ? maskSecretsInCutText(wide, 'start') : maskSecrets(wide)
  const end = running ? withoutUnfinishedKey(masked) : masked
  return tailOutput(end, cut ? Math.min(units, Math.max(0, end.length - 1)) : units)
}

/**
 * Masks a stream that is written out as it arrives, in Latin-1 form (one unit per byte, so any bytes
 * pass unchanged). `text` is what is new, after what was held back last time; returns what can go out
 * now and what to hold back, which may be the start of a key. `final`: nothing more is coming, and
 * `cut`: the stream goes on past what was kept, so a part of a key at the very end is dropped.
 */
export function maskStream(text: string, secrets: readonly string[], final: boolean, cut = false): { out: string; held: string } {
  if (!secrets.length) return { out: text, held: '' }
  const reach = secrets[0]!.length - 1
  let end = final ? text.length : Math.max(0, text.length - reach)
  // A whole key that crosses the point goes out with the rest, as its mask.
  for (let changed = !final; changed;) {
    changed = false
    for (const secret of secrets) {
      const at = text.indexOf(secret, Math.max(0, end - secret.length + 1))
      if (at >= 0 && at < end && at + secret.length > end) { end = at + secret.length; changed = true }
    }
  }
  let out = text.slice(0, end)
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(MASK)
  if (final && cut) {
    for (let length = Math.min(reach, out.length); length > 0; length--) {
      const tail = out.slice(out.length - length)
      if (secrets.some(secret => secret.startsWith(tail))) { out = out.slice(0, out.length - length); break }
    }
  }
  return { out, held: text.slice(end) }
}

/** A tool result's content (text, or blocks with text in them) with every key G-Code knows of replaced. */
export function maskSecretsInContent<T>(content: T): T {
  if (typeof content === 'string') return maskSecrets(content) as T
  if (!Array.isArray(content)) return content
  return content.map(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
    ? { ...block, text: maskSecrets((block as { text: string }).text) } : block) as T
}
