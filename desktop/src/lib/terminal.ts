// IPC for the embedded terminal (src-tauri/src/terminal.rs): one PTY per tab.
// Output arrives on a Channel as raw bytes (an ArrayBuffer) that xterm.js
// decodes as one UTF-8 stream, so a character split across chunks stays
// intact; the exit notice follows the last output on the same Channel.

import { Channel, invoke } from '@tauri-apps/api/core'

export type TerminalEvent =
  | { kind: 'output'; data: Uint8Array }
  | { kind: 'exit'; code: number | null }

export async function openTerminal(cwd: string | undefined, cols: number, rows: number, onEvent: (event: TerminalEvent) => void): Promise<number> {
  const channel = new Channel<ArrayBuffer | { kind: 'exit'; code: number | null }>()
  channel.onmessage = (message) => {
    // A throw here would stop the Channel's in-order delivery for good.
    try {
      if (message instanceof ArrayBuffer) onEvent({ kind: 'output', data: new Uint8Array(message) })
      else if (message?.kind === 'exit') onEvent(message)
    } catch (error) { console.error('terminal output', error) }
  }
  return invoke<number>('terminal_open', { cwd: cwd || null, cols, rows, onEvent: channel })
}

export const writeTerminal = (id: number, data: string) => invoke<void>('terminal_write', { id, data })
export const resizeTerminal = (id: number, cols: number, rows: number) => invoke<void>('terminal_resize', { id, cols, rows })
/** Flow control: xterm parsed `bytes` more of the output (the backend pauses above 2 MiB unacknowledged). */
export const ackTerminal = (id: number, bytes: number) => invoke<void>('terminal_ack', { id, bytes })
export const closeTerminal = (id: number) => invoke<void>('terminal_close', { id })
/** Ends PTYs left by an earlier page load (a webview reload keeps the backend alive). */
export const closeAllTerminals = () => invoke<void>('terminal_close_all')
