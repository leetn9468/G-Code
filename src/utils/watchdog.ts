import { spawn, type ChildProcess } from 'node:child_process'

/**
 * The watchdog for one process group: a separate tiny bash, detached into a group (and session)
 * of its own, with its stdio on /dev/null, so it never holds the output pipes and no signal to
 * the command's group reaches it. Once a second it checks that this process ($1) is alive and
 * that the command's group ($2) still exists. When the group is gone it exits. When this process
 * is gone (SIGKILLed or crashed, so no exit hook ran) it sends SIGTERM to the group, SIGKILL two
 * seconds later, and exits, so nothing the command started is left behind. Its sleep runs with
 * `command -p`, so the PATH it inherited cannot turn the wait into a busy loop.
 */
const WATCHDOG = `parent=$1 group=$2
while kill -0 "$parent" 2>/dev/null; do
  kill -0 -- "-$group" 2>/dev/null || exit 0
  command -p sleep 1
done
kill -0 -- "-$group" 2>/dev/null || exit 0
kill -TERM -- "-$group" 2>/dev/null
command -p sleep 2
kill -KILL -- "-$group" 2>/dev/null
exit 0`

/** Starts the watchdog for process group `pgid` (see WATCHDOG); it does not keep this process alive. POSIX only. */
export function watchGroup(pgid: number): ChildProcess | undefined {
  try {
    const watchdog = spawn('/bin/bash', ['-c', WATCHDOG, 'gcode-watchdog', String(process.pid), String(pgid)], { stdio: 'ignore', detached: true, env: process.env })
    watchdog.on('error', () => { /* Supervision is best effort; the exit hook still kills the group. */ })
    watchdog.unref()
    return watchdog
  } catch { return undefined }
}

/** Ends a watchdog whose group is gone or taken over (it would exit within a second anyway), with the sleep it is in. */
export function endWatchdog(watchdog: ChildProcess | undefined): void {
  if (!watchdog || watchdog.exitCode !== null || watchdog.signalCode !== null) return
  // It leads a group of its own (detached), which holds only it and its sleep.
  try { if (watchdog.pid) process.kill(-watchdog.pid, 'SIGKILL'); else watchdog.kill('SIGKILL') } catch {
    try { watchdog.kill('SIGKILL') } catch { /* Gone. */ }
  }
}
