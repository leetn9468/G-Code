import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolProfile } from './protection.js'
declare const GCODE_COMPILED_CLI: boolean | undefined
const helper = typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI
  ? resolve(dirname(process.execPath), 'guard-processes')
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/runtime/gcode/bin/guard-processes')
export interface SandboxMember { tag: string; pid: number; ppid: number; pgid: number; start: string }
export function sandboxMembers(tags: string[], stop = false): SandboxMember[] {
  if (!tags.length) return []
  if (!existsSync(helper)) throw new Error('The native sandbox process tracker is missing. Rebuild the desktop runtime.')
  const text = execFileSync(helper, [stop ? 'stop' : 'list', ...tags], { encoding: 'utf8', timeout: 5000, maxBuffer: 4_000_000, env: { PATH: '/usr/bin:/bin' } })
  return text.trim().split('\n').filter(Boolean).map(line => {
    const m = /^(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+:\d+)$/.exec(line)
    if (!m || !tags[Number(m[1])]) throw new Error('Invalid native sandbox process report')
    return { tag: tags[Number(m[1])]!, pid: Number(m[2]), ppid: Number(m[3]), pgid: Number(m[4]), start: m[5]! }
  })
}
/** A working SPI and marker lookup are prerequisites, not assumptions. */
export async function verifySandboxMembership(): Promise<void> {
  const tag = `GCODE_GUARD_${randomUUID().replaceAll('-', '')}`
  const child = spawn('/usr/bin/sandbox-exec', ['-p', toolProfile(tag, true), '/bin/sleep', '60'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } })
  try {
    await new Promise(r => setTimeout(r, 60))
    if (!child.pid || !sandboxMembers([tag]).some(p => p.pid === child.pid)) throw new Error('The sandbox process tracker could not identify its self-test.')
    sandboxMembers([tag], true)
    if (sandboxMembers([tag]).length) throw new Error('The sandbox process tracker could not stop its self-test.')
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}
