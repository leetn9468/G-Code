import { protectedRuntimeRoots } from './resources.js'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { seatbeltBaseline } from './vendor/seatbelt.js'

export function incidentRoot(): string { return join(realpathSync(homedir()), '.gcode', 'incidents') }
export function ensureIncidentRoot(): string {
  const root = incidentRoot()
  for (const p of [dirname(root), root]) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Incident storage must not be a symbolic link.')
    mkdirSync(p, { recursive: true, mode: 0o700 })
  }
  chmodSync(root, 0o700)
  return root
}
/** Seatbelt is pathname based: an existing extra hard link must stop launch, not pass as protected. */
export function assertIncidentLinks(): void {
  const root = incidentRoot()
  if (!existsSync(root)) return
  const visit = (path: string) => {
    const s = lstatSync(path)
    if (s.isSymbolicLink() || s.isFile() && s.nlink !== 1) throw new Error(`Tool refused: ${path} has another name somewhere (an unsafe alias). Delete the other link to it in Finder, then try again.`)
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
  }
  visit(root)
}
/**
 * `kill` (default): a denied connection also SIGKILLs the offender. That action makes macOS report
 * nearly every denial: plain denials of nonblocking sockets (Node, Bun) went unreported in 8 of 50
 * round-10b samples, so an attempt would be blocked but not seen, and the chain not cut. With it, about
 * 1 attempt in 300 was still killed but never logged; its crash report then trips
 * the incident (killReports.ts).
 * The price is a macOS crash report per real attempt (and Apple's "quit unexpectedly" dialog for an
 * app-bundled interpreter such as Xcode's python3). The monitor's own curl probe uses a blocking
 * connect whose plain denials report about 99 times in 100, so it passes `kill: false` and leaves no
 * crash report per fence; FENCE_PROBES covers the rest.
 */
export function toolProfile(tag: string, network: boolean, forbiddenPorts: number[] = [], ownProxyPorts: number[] = [], kill = true): string {
  const stop = kill ? ' (with send-signal SIGKILL)' : ''
  const root = incidentRoot(), quote = JSON.stringify
  const gcode = dirname(root)
  const lines = [seatbeltBaseline(tag), '(allow file-read*)', '(allow file-write*)']
  // macOS pkill/pgrep obtain their process list through this read-only service.
  // Signals and task ports remain restricted to this inherited sandbox.
  lines.push('(allow mach-lookup (global-name "com.apple.sysmond"))')
  if (network) {
    lines.push(`(deny network-outbound${stop} (with message "${tag} egress"))`)
    // Darwin 24.6 also runs this check on link(2), against the file being linked: it leaves no record and
    // does not stop the link, but the action above still fires, so every hard link (git add, git commit,
    // ln, tar) died. A socket is always a socket vnode, also through a symbolic link,
    // and these types cannot take a connection. A hard link to a socket file still dies; nothing else does.
    lines.push('(allow network-outbound (vnode-type REGULAR-FILE SYMLINK FIFO))')
    // getaddrinfo sorts numeric results through this read-only kernel control, also for 127.0.0.1. No packet.
    lines.push('(allow network-outbound (control-name "com.apple.netsrc"))')
    // The routing table is read and written by messages to the kernel; only root can change it. No packet.
    lines.push('(allow system-socket (socket-domain AF_ROUTE))')
    // An inherited policy marker remains observable after fork, setsid and reparenting.
    // No service is registered under this random name; it grants no actual IPC.
    lines.push(`(allow mach-lookup (global-name "com.gcode.guard.${tag}"))`)
    // Required by macOS user-space violation reporting (notably Node 24).
    // Denying this local reporter can block egress without emitting its evidence.
    lines.push('(allow mach-lookup (global-name "com.apple.diagnosticd"))')
    const excluded = [...new Set(forbiddenPorts)].filter(port => !ownProxyPorts.includes(port))
    // libuv binds an unspecified source address before connect. Bind is not
    // egress: remote access is still decided solely by network-outbound.
    lines.push('(allow network-bind (local ip "*:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))')
    lines.push('(allow network-outbound (remote unix-socket (literal "/private/var/run/syslog")))')
    // A specific deny must have a different action message from deny-default.
    // Darwin 24.6 otherwise coalesces it and the broad localhost allow wins.
    for (const port of excluded) lines.push(`(deny network-outbound (remote ip "localhost:${port}")${stop} (with message "${tag} proxy-port"))`)
    lines.push(`(deny network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder"))${stop} (with message "${tag} resolver"))`)
  } else lines.push('(allow network*)')
  for (const path of protectedRuntimeRoots()) lines.push(`(deny file-write* (subpath ${quote(path)}) (with message "${tag} runtime"))`)
  // What decides the next session must not be a tool's to change: its allowlist, rules, servers, and a saved chat's hold and grants.
  for (const rule of nextSessionRules(gcode)) lines.push(`(deny ${rule} (with message "${tag} next-session"))`)
  // Last rules protect both bytes and movement. Ancestors themselves cannot be renamed; siblings remain writable.
  lines.push(`(deny file-read* file-write* (subpath ${quote(root)}) (with message "${tag} evidence"))`)
  for (const protectedPath of [root, ...protectedRuntimeRoots()]) for (let p = protectedPath; p !== '/'; p = dirname(p)) lines.push(`(deny file-write-unlink (literal ${quote(p)}) (with message "${tag} ancestor"))`)
  return lines.join('\n')
}

/** A literal path inside an SBPL regular expression. Anything unusual matches loosely, which only denies more. */
const regexPath = (path: string) => path.replace(/[^A-Za-z0-9/_ -]/g, c => c === '.' ? '\\.' : '.+')

/**
 * Seatbelt rules for the files read at the next launch, outside any sandbox. Engine code writes them in
 * process, so this stops only sandboxed tools. A rename of ~/.gcode itself is already refused: it is an
 * ancestor of the evidence. A link would give the same file another name to write through, so its source
 * is refused too. Each file's real path counts as well when it is a symbolic link.
 */
function nextSessionRules(gcode: string): string[] {
  const home = regexPath(gcode), rules: string[] = []
  for (const name of ['settings.json', 'settings.json.bak', 'permissions.json', 'mcp.json']) {
    // Seatbelt ignores letter case here: ~/.gcode/SETTINGS.JSON is refused too, also when no such file exists yet.
    rules.push(`file-write* file-link (literal ${JSON.stringify(join(gcode, name))})`)
    try { const real = realpathSync(join(gcode, name)); if (real !== join(gcode, name)) rules.push(`file-write* file-link (literal ${JSON.stringify(real)})`) } catch { /* Not there yet. */ }
  }
  // Saved chats: ~/.gcode/projects/<project>/<session>.json. Folders of their own below that stay writable (outputs).
  rules.push(`file-write* file-link (regex #"^${home}/projects/[^/]+/[^/]+\\.json$")`)
  // Moving a folder away, changing the file and moving it back would pass the rule above.
  rules.push(`file-write-unlink (regex #"^${home}/projects(/[^/]+)?$")`)
  return rules
}

/**
 * The trusted browser under Guillotine Mode: the tool profile with no kill, so a denied attempt stops
 * that connection and its record holds the work, plus what Chromium needs to start. A loopback-only
 * kernel rule closes WebRTC, WebTransport and anything else that does not pass G-Code's page route.
 * Chromium's own sandbox cannot apply inside this one (macOS refuses a second sandbox), so it is off.
 * Chromium's network process tests reachability with a UDP connect to port 443 by itself, which sends no
 * packet: that one form is denied under a message the monitor does not count.
 */
export const BROWSER_PROBE_MESSAGE = 'browser-probe'
export function browserProfile(tag: string, forbiddenPorts: number[]): string {
  return [toolProfile(tag, true, forbiddenPorts, [], false),
    '(allow network-bind)', '(allow mach-register)', '(allow mach-lookup)', '(allow iokit-open)', '(allow sysctl-read)', '(allow file-issue-extension)', '(allow file-map-executable)', '(allow hid-control)',
    `(deny network-outbound (remote udp "*:443") (with message "${tag} ${BROWSER_PROBE_MESSAGE}"))`,
  ].join('\n')
}
