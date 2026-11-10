import { createServer, connect, isIP, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

export interface Observation { layer: string; host?: string; port?: number; scheme?: string; url?: string; requestLine?: string; headers?: Record<string, string>; bodyPrefix?: string; bodyAvailability?: 'complete' | 'prefix-only' | 'not-yet-available'; bodyBytesCaptured?: number; raw?: string; pid?: number; sni?: string; reason?: string; forbiddenTarget?: boolean }
export interface CallProxy { port: number; socksPort: number; secret: string; close(): void }
type Allow = (host: string, port: number, address?: string) => boolean
const normalized = (url: URL) => `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`

/** Separate authenticated listeners. HTTP is parsed per request, including pipelined/chunked
 * requests; only CONNECT and SOCKS create a destination-bound tunnel. */
export async function callProxy(allow: Allow, incident: (o: Observation) => void, ports?: readonly [number, number]): Promise<CallProxy> {
  const secret = randomBytes(32).toString('hex'), sockets = new Set<Socket>()
  let closed = false
  const own = (s: Socket) => { sockets.add(s); s.on('error', () => s.destroy()); s.on('close', () => sockets.delete(s)); return s }
  const resolve = async (host: string, port: number, observation: Observation): Promise<string | undefined> => {
    if (closed) return
    if (!allow(host, port)) { incident({ ...observation, host, port }); return }
    // Connect to this resolved address, so a DNS alias cannot reach a forbidden user proxy.
    const address = isIP(host) ? host : (await lookup(host)).address
    if (!allow(host, port, address)) { incident({ ...observation, host, port, forbiddenTarget: true, reason: 'This destination resolves to a user proxy endpoint and cannot be approved.' }); return }
    return closed ? undefined : address
  }
  const parse = (bytes: Buffer) => {
    const [line = '', ...lines] = bytes.toString('latin1').split('\r\n')
    const m = /^([A-Z]+) ([^\s]+) HTTP\/1\.[01]$/.exec(line)
    if (!m) throw new Error('Invalid HTTP request line')
    const headers: Record<string, string> = {}
    for (const line of lines) { const h = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line); if (!h || headers[h[1]!.toLowerCase()] !== undefined) throw new Error('Invalid or duplicated HTTP header'); headers[h[1]!.toLowerCase()] = h[2]!.trim() }
    const method = m[1]!, tunnel = method === 'CONNECT', url = new URL(tunnel ? `https://${m[2]}` : m[2]!)
    if (url.username || url.password || (tunnel ? url.pathname !== '/' || !!url.search || !!url.hash : url.protocol !== 'http:')) throw new Error('Unsupported proxy target')
    if (!headers.host || normalized(new URL(`${url.protocol}//${headers.host}`)) !== normalized(url)) throw new Error('HTTP target and Host do not identify the same destination')
    const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || (tunnel ? 443 : 80))
    const authenticated = headers['proxy-authorization'] === `Basic ${Buffer.from(`gcode:${secret}`).toString('base64')}`
    delete headers['proxy-authorization']; delete headers['proxy-connection']
    if (headers['transfer-encoding'] && (headers['transfer-encoding'].toLowerCase() !== 'chunked' || headers['content-length'])) throw new Error('Ambiguous transfer encoding')
    if (headers['content-length'] && !/^(?:0|[1-9][0-9]*)$/.test(headers['content-length'])) throw new Error('Invalid content length')
    const length = Number(headers['content-length'] ?? 0)
    if (!Number.isSafeInteger(length)) throw new Error('Content length is too large')
    const observation: Observation = { layer: 'http-proxy', host, port, scheme: url.protocol, requestLine: line, headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k))), ...(tunnel ? { reason: 'CONNECT authority observed; TLS SNI and encrypted body are unknown.' } : { url: url.href }) }
    return { method, tunnel, url, host, port, authenticated, headers, length, observation, chunked: !!headers['transfer-encoding'] }
  }
  // A small strict framing parser is used because Bun 1.3.14's node:http parser silently drops
  // pipelined input. Only a CONNECT tunnel permits unrestricted bytes on an approved socket.
  const http = createServer(socket => {
    own(socket); socket.setTimeout(30000, () => socket.destroy())
    let pending = Buffer.alloc(0), remote: Socket | undefined, request: ReturnType<typeof parse> | undefined
    let state: 'headers' | 'resolving' | 'fixed' | 'chunk-size' | 'chunk-data' | 'chunk-end' | 'trailers' | 'done' | 'tunnel' = 'headers', remaining = 0
    const reject = (reason: string) => { incident({ layer: 'http-proxy', reason }); socket.destroy(); remote?.destroy() }
    const forward = (bytes: Buffer) => { if (bytes.length && !remote!.write(bytes)) { socket.pause(); remote!.once('drain', () => socket.resume()) } }
    const finish = () => { state = 'done' }
    const pump = () => {
      while (!closed && !socket.destroyed) {
        if (state === 'headers') {
          const end = pending.indexOf('\r\n\r\n')
          if (end < 0) { if (pending.length > 32768) reject('HTTP header limit exceeded; destination unknown.'); return }
          try { request = parse(pending.subarray(0, end)) } catch (error) { reject(String(error)); return }
          pending = pending.subarray(end + 4)
          if (!request.authenticated) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="G-Code"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
          const d = request; state = 'resolving'; socket.pause()
          const prefix = pending.subarray(0, Math.min(4096, d.chunked ? pending.length : d.length))
          void resolve(d.host, d.port, { ...d.observation, ...(!d.tunnel ? { bodyPrefix: prefix.toString('base64'), bodyBytesCaptured: prefix.length, bodyAvailability: !d.chunked && pending.length >= d.length && d.length <= 4096 ? 'complete' as const : prefix.length ? 'prefix-only' as const : 'not-yet-available' as const } : {}) }).then(address => {
            if (!address) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
            remote = own(connect({ host: address, port: d.port })); remote.once('error', () => socket.destroy()); socket.once('close', () => remote?.destroy())
            remote.once('connect', () => {
              if (d.tunnel) { state = 'tunnel'; socket.removeListener('data', receive); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (pending.length) remote!.write(pending); socket.pipe(remote!).pipe(socket); socket.resume(); return }
              d.headers.host = d.url.host; d.headers.connection = 'close'
              forward(Buffer.from(`${d.method} ${d.url.pathname}${d.url.search} HTTP/1.1\r\n${Object.entries(d.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`))
              state = d.chunked ? 'chunk-size' : 'fixed'; remaining = d.length
              remote!.pipe(socket); pump(); socket.resume()
            })
          }).catch(() => socket.destroy())
          return
        }
        if (state === 'resolving' || state === 'tunnel') return
        if (state === 'done') {
          if (!pending.length) return
          const end = pending.indexOf('\r\n\r\n')
          if (end < 0) { if (pending.length > 32768) reject('Additional HTTP bytes exceeded the header limit; destination unknown.'); return }
          try { const extra = parse(pending.subarray(0, end)); if (extra.authenticated && !allow(extra.host, extra.port)) incident({ ...extra.observation, bodyPrefix: pending.subarray(end + 4, end + 4 + 4096).toString('base64'), reason: 'Additional destination in pipelined HTTP traffic was blocked.' }) } catch (error) { reject(String(error)) }
          // Approved destinations also need a fresh HTTP connection. No trailing request is forwarded.
          socket.destroy(); remote?.destroy(); return
        }
        if (state === 'fixed' || state === 'chunk-data') {
          const bytes = pending.subarray(0, remaining); pending = pending.subarray(bytes.length); remaining -= bytes.length; forward(bytes)
          if (remaining) return
          if (state === 'fixed') finish(); else state = 'chunk-end'
          continue
        }
        if (state === 'chunk-size') {
          const end = pending.indexOf('\r\n'); if (end < 0) { if (pending.length > 128) reject('Chunk header exceeded limit.'); return }
          const size = pending.subarray(0, end).toString('ascii'); if (!/^[0-9a-fA-F]{1,8}$/.test(size)) { reject('Unsupported chunk framing.'); return }
          remaining = parseInt(size, 16); forward(pending.subarray(0, end + 2)); pending = pending.subarray(end + 2); state = remaining ? 'chunk-data' : 'trailers'; continue
        }
        if (state === 'chunk-end' || state === 'trailers') {
          if (pending.length < 2) return
          if (pending[0] !== 13 || pending[1] !== 10) { reject('Unsupported HTTP trailers or invalid chunk ending.'); return }
          forward(pending.subarray(0, 2)); pending = pending.subarray(2)
          if (state === 'trailers') finish(); else state = 'chunk-size'
        }
      }
    }
    const receive = (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); pump() }
    socket.on('data', receive)
  })
  const server = createServer(socket => {
    own(socket); socket.setTimeout(30000, () => socket.destroy())
    let data = Buffer.alloc(0), phase = 0
    const receive = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > 65536) { socket.destroy(); return }
      if (phase === 0 && data[0] !== 5) { socket.destroy(); return }
      if (phase === 0) {
        if (data.length < 2 || data.length < 2 + data[1]!) return
        if (!data.subarray(2, 2 + data[1]!).includes(2)) { socket.end(Buffer.from([5, 255])); return }
        data = data.subarray(2 + data[1]!); phase = 1; socket.write(Buffer.from([5, 2]))
      }
      if (phase === 1) {
        if (data.length < 2) return
        const offset = 2 + data[1]!
        if (data.length <= offset || data.length < offset + 1 + data[offset]!) return
        if (data[0] !== 1 || data.subarray(2, offset).toString() !== 'gcode' || data.subarray(offset + 1, offset + 1 + data[offset]!).toString() !== secret) { socket.end(Buffer.from([1, 1])); return }
        data = data.subarray(offset + 1 + data[offset]!); phase = 2; socket.write(Buffer.from([1, 0]))
      }
      if (phase === 2) {
        if (data.length < 5) return
        let host: string, end: number
        if (data[3] === 3) { end = 5 + data[4]!; if (data.length < end + 2) return; host = data.subarray(5, end).toString() }
        else if (data[3] === 1) { end = 8; if (data.length < 10) return; host = [...data.subarray(4, 8)].join('.') }
        else if (data[3] === 4) { end = 20; if (data.length < 22) return; host = Array.from({ length: 8 }, (_, i) => data.readUInt16BE(4 + i * 2).toString(16)).join(':') }
        else { socket.destroy(); return }
        if (data[0] !== 5 || data[1] !== 1 || data[2] !== 0) { socket.destroy(); return }
        const port = data.readUInt16BE(end), remainder = data.subarray(end + 2)
        socket.pause(); socket.removeListener('data', receive)
        void resolve(host, port, { layer: 'socks5', reason: 'SOCKS destination observed; TLS SNI and encrypted body are unknown.' }).then(address => {
          if (!address) { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return }
          const remote = own(connect({ host: address, port })); remote.once('error', () => socket.destroy())
          remote.once('connect', () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (remainder.length) remote.write(remainder); socket.pipe(remote).pipe(socket); socket.resume() })
          socket.once('close', () => remote.destroy())
        }).catch(() => socket.destroy())
      }
    }
    socket.on('data', receive)
  })
  // Seatbelt's localhost filter covers 127.0.0.1 and ::1. Own both, so its exception
  // cannot reach another service listening on the sibling loopback address.
  const http6 = createServer(socket => http.emit('connection', socket)), socks6 = createServer(socket => server.emit('connection', socket))
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(ports?.[0] ?? 0, '127.0.0.1', resolve) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ports?.[1] ?? 0, '127.0.0.1', resolve) })
    await new Promise<void>((resolve, reject) => { http6.once('error', reject); http6.listen({ port: (http.address() as { port: number }).port, host: '::1', ipv6Only: true }, resolve) })
    await new Promise<void>((resolve, reject) => { socks6.once('error', reject); socks6.listen({ port: (server.address() as { port: number }).port, host: '::1', ipv6Only: true }, resolve) })
  } catch (error) { http.close(); server.close(); http6.close(); socks6.close(); throw error }
  return { port: (http.address() as { port: number }).port, socksPort: (server.address() as { port: number }).port, secret, close() { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); server.close(); http.close(); http6.close(); socks6.close() } }
}
