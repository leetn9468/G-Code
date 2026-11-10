/**
 * How long a stream is read after the provider's end marker: long enough for what follows it (the
 * final usage chunk, [DONE], the socket closing), and then the reply is complete whatever the socket
 * does. A proxy that held the connection open kept a whole reply waiting for 300 s and then lost it.
 * Exported for tests.
 */
export const STREAM_END = { graceMs: 10_000 }

/** Told when the provider's end marker arrives; readSSEData then stops reading after STREAM_END.graceMs. */
export class EndMarker {
  private timer?: ReturnType<typeof setTimeout>
  private expire?: () => void
  private readonly expired = new Promise<void>(resolve => { this.expire = resolve })
  /** The end marker arrived. The consumer calls it between records, so no read is in flight. */
  seen(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.expire!(), STREAM_END.graceMs)
    this.timer.unref?.()
  }
  /** A read, or the end of the stream once the grace period is over. */
  read(read: Promise<ReadableStreamReadResult<Uint8Array>>): Promise<ReadableStreamReadResult<Uint8Array>> {
    return this.timer ? Promise.race([read, this.expired.then(() => ({ done: true, value: undefined }) as const)]) : read
  }
  stop(): void { clearTimeout(this.timer) }
}

/** Decode SSE records across arbitrary network/UTF-8 boundaries. `end`: see EndMarker. */
export async function* readSSEData(body: ReadableStream<Uint8Array>, end?: EndMarker): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fields: string[] = []
  function consume(line: string): string | undefined {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) {
      if (!fields.length) return undefined
      const data = fields.join('\n')
      fields = []
      return data
    }
    if (line.startsWith('data:')) fields.push(line.slice(5).replace(/^ /, ''))
    return undefined
  }
  try {
    while (true) {
      const { done, value } = await (end ? end.read(reader.read()) : reader.read())
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const data = consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (data !== undefined) yield data
      }
      if (done) break
    }
    if (buffer) {
      const data = consume(buffer)
      if (data !== undefined) yield data
    }
    if (fields.length) yield fields.join('\n')
  } finally {
    end?.stop()
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
