import { escapeResponseControls } from '../shared/displayText.js'

/** A display-only stream adapter. Keep a trailing CR until the next text chunk
 * (including empty chunks), then normalize CRLF without changing stored text. */
export function terminalTextWriter(write: (text: string) => void) {
  let pendingCR = false
  return {
    write(text: string) {
      if (!text) return
      text = (pendingCR ? '\r' : '') + text
      pendingCR = text.endsWith('\r')
      if (pendingCR) text = text.slice(0, -1)
      write(escapeResponseControls(text.replace(/\r\n/g, '\n')))
    },
    flush() {
      if (pendingCR) write('\\u000d')
      pendingCR = false
    },
  }
}
