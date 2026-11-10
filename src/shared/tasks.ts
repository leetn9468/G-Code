/** A shell started with Bash `run_in_background`, as the Tasks panel and TaskOutput see it. */
export type ShellStatus = 'running' | 'completed' | 'failed' | 'stopped'
export interface BackgroundShellInfo {
  id: string
  kind: 'shell'
  command: string
  description?: string
  cwd: string
  pid?: number
  status: ShellStatus
  exitCode: number | null
  startedAt: number
  endedAt?: number
  /** The last few KB of combined stdout/stderr. */
  tail: string
  outputBytes: number
}
