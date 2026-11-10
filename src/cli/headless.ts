/**
 * @file headless.ts
 * @brief Headless mode — NDJSON output to stdout
 *
 * Used with -p / --print flag. Runs a single query, outputs structured
 * JSON, and exits. Designed for piping into other tools.
 */

import { frameJSON } from './frames.js'

// ============================================================================
// NDJSON Output Types
// ============================================================================

interface NDJSONEvent {
  type: 'result' | 'error'
  timestamp: number
  data: unknown
}

// ============================================================================
// Output Functions
// ============================================================================

function emit(event: NDJSONEvent): void {
  writeQuietly(process.stdout, frameJSON(event) + '\n')
}

// ============================================================================
// Output That Outlives The Terminal
// ============================================================================

/**
 * How a write to stdout or stderr fails once nobody can read it: EIO after a terminal hangup,
 * EPIPE when whatever reads the pipe is gone, and ERR_STREAM_DESTROYED for a write after one
 * of those.
 */
export function isClosedOutputError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return code === 'EIO' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

/** Writes `text`, or drops it when the terminal or pipe is gone. For shutdown paths, which must run to the end. */
export function writeQuietly(stream: NodeJS.WritableStream, text: string): void {
  try { stream.write(text) } catch (error) { if (!isClosedOutputError(error)) throw error }
}

let outputGuarded = false

/**
 * A failed write to stdout or stderr arrives as an 'error' event, and an 'error' event nobody
 * listens to is an uncaught exception: after a terminal hangup the process would exit with code 1
 * at the first prompt or newline, the 'exit' hook would SIGKILL the background shells right after
 * their SIGTERM, and the final session save and MCP shutdown would never run. These listeners
 * drop the errors of output nobody can read (see isClosedOutputError); any other error still
 * surfaces. Safe to call more than once.
 */
export function guardOutputStreams(): void {
  if (outputGuarded) return
  outputGuarded = true
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: unknown) => { if (!isClosedOutputError(error)) throw error })
  }
}

/** The run's answer; `extra` adds fields to its data (such as the calls the run refused). */
export function emitResult(content: string, extra?: Record<string, unknown>): void {
  emit({
    type: 'result',
    timestamp: Date.now(),
    data: { content, ...extra },
  })
}

export function emitError(message: string): void {
  emit({
    type: 'error',
    timestamp: Date.now(),
    data: { message },
  })
}
