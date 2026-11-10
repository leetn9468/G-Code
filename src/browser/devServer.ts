import { prepareToolProcess } from '../security/process.js'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tailUnits } from '../utils/textUnits.js'
import { toolEnv } from '../runtime/node.js'

export const devServerLog = (output: string) => join(output, 'dev-server.log')

export async function startDevServer(config: { command: string; args: string[]; path?: string; ready_timeout_ms: number }, cwd: string, output: string, cancelled: () => boolean) {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Cannot allocate development server port')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const origin = `http://127.0.0.1:${address.port}`, path = config.path ?? '/'
  const args = config.args.map(arg => arg.replaceAll('{port}', String(address.port)))
  const profile = process.env.GCODE_BROWSER_GUARD_PROFILE ?? (process.platform === 'darwin' ? prepareToolProcess(['/usr/bin/true'], toolEnv(), cwd).argv[2] : undefined)
  if (process.env.GCODE_BROWSER_GUARD === '1' && !profile) throw new Error('Missing browser development-server sandbox profile')
  const command = profile ? '/usr/bin/sandbox-exec' : config.command
  const guardedArgs = profile ? ['-p', profile, config.command, ...args] : args
  const child = spawn(command, guardedArgs, { cwd, env: toolEnv({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase().startsWith('npm_config_'))), ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /proxy$/i.test(key))), HOST: '127.0.0.1', PORT: String(address.port) }), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const logPath = devServerLog(output)
  let log = '', exited = false, error = '', ending = ''
  // Decoded per stream, so a character split across two reads stays whole.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  const append = (chunk: string) => { log = tailUnits(log + chunk, 64000) }
  child.stdout.on('data', append); child.stderr.on('data', append)
  child.once('error', failure => { error = String(failure); exited = true })
  const closed = new Promise<void>(resolve => child.once('close', (code, endSignal) => { ending = endSignal ? `signal ${endSignal}` : `exit code ${code}`; exited = true; resolve() }))
  const signal = (value: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value); else child.kill(value) } catch {} }
  const stop = async () => {
    signal('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })]); if (timer) clearTimeout(timer)
    signal('SIGKILL'); writeFileSync(logPath, log + (error ? '\n' + error : ''))
  }
  process.stdout.write(JSON.stringify({ devServerPid: child.pid }) + '\n')
  try {
    const deadline = Date.now() + config.ready_timeout_ms
    let ready = false, answer = ''
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('Verification cancelled while starting development server')
      // With its exit code, and said when it printed nothing: a server that never listened (a module
      // that starts only as the main script) ended with "exited before readiness: " and no clue.
      if (exited) throw new Error(`Development server exited before readiness${ending ? ` (${ending})` : ''}: ${error || tailUnits(log, 2000).trim() || 'it printed nothing'}`)
      try { const response = await fetch(origin + path, { signal: AbortSignal.timeout(500), redirect: 'manual' }); await response.body?.cancel(); if (response.ok) { ready = true; break } answer = `HTTP ${response.status}` } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    // Where it looked and what the server printed: a server listening only on localhost (::1), as
    // Vite does on macOS, printed its own URL while the probe of 127.0.0.1 timed out with no clue.
    if (!ready) throw new Error(`Development server readiness timed out after ${config.ready_timeout_ms} ms: ${origin + path} ${answer ? `answered ${answer}` : 'never answered'}. G-Code waits for an OK (2xx) answer at 127.0.0.1 on the port it passes as {port} and PORT; a server listening only on localhost or ::1 must be told to listen on 127.0.0.1 (for example with its --host option). Its output: ${tailUnits(log, 2000).trim() || 'it printed nothing'}`)
    return { origin, url: origin + path, stop, logPath, command: config.command, args, pid: child.pid }
  } catch (error) { await stop(); throw error }
}
