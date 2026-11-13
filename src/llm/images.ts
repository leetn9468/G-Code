import { crc32, inflateSync } from 'node:zlib'
import type { ImageBlock, LLMMessage, LLMRequestOptions, ToolResultBlock, VisionCapabilities } from './types.js'
import { RequestNotSentError } from './retry.js'
import { isNativeLayout, nativeContent } from './nativeBlocks.js'

const MiB = 1024 * 1024
/** Which models take inline images, and their limits: shared with the desktop, which checks attachments before sending. */
export { visionCapabilities } from '../shared/vision.js'

type ImageInfo = { mediaType: ImageBlock['source']['media_type']; width: number; height: number; animated?: boolean }
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const EOI = Buffer.from([0xff, 0xd9])

/**
 * Read dimensions from bounded encoded bytes; no external decoder or process. The structure is
 * checked as far as it is cheap: a PNG needs its pixel data and end chunk, a JPEG a scan and its
 * end marker, so a file cut short is refused here instead of by the provider.
 */
export function imageInfo(bytes: Buffer): ImageInfo {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    let animated = false, pixels = false, end = false
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG image: the file ends inside a chunk. Use a complete file.')
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') animated = true
      if (type === 'IDAT') pixels = true
      offset += length + 12
      if (type === 'IEND') { end = true; break }
    }
    if (!end) throw new Error('Truncated PNG image: it has no end chunk. Use a complete file.')
    if (!pixels) throw new Error('Invalid PNG image: it has no pixel data.')
    return { mediaType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), animated }
  }
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    let i = 13 + ((bytes[10]! & 0x80) ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0), frames = 0
    const skipBlocks = () => { while (i < bytes.length) { const size = bytes[i++]!; if (!size) return; i += size } throw new Error('Truncated GIF image') }
    while (i < bytes.length) {
      const marker = bytes[i++]
      if (marker === 0x3b) break
      if (marker === 0x21) { i++; skipBlocks() }
      else if (marker === 0x2c && i + 9 <= bytes.length) { frames++; const flags = bytes[i + 8]!; i += 9 + ((flags & 0x80) ? 3 * 2 ** ((flags & 7) + 1) : 0); i++; skipBlocks() }
      else throw new Error('Invalid GIF image')
    }
    if (!frames) throw new Error('GIF image contains no frame')
    return { mediaType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), animated: frames > 1 }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 > bytes.length) throw new Error('Truncated WebP image')
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { mediaType: 'image/webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, animated: !!(bytes[20]! & 2) }
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d,1,0x2a]))) return { mediaType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 } }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2, frame: ImageInfo | undefined, scan: number | undefined
    while (i + 4 <= bytes.length) {
      if (bytes[i++] !== 0xff) break
      while (bytes[i] === 0xff) i++
      const marker = bytes[i++]!
      if (marker === 0xd9) break
      if (marker === 0xda) { scan = i; break }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = bytes.readUInt16BE(i)
      if (length < 2 || i + length > bytes.length) break
      if (!frame && SOF_MARKERS.has(marker) && length >= 8) frame = { mediaType: 'image/jpeg', width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) }
      i += length
    }
    if (frame) {
      // The scan data never holds FF D9 (an FF in it is stuffed), so a file cut inside it has no end marker after the scan.
      if (scan === undefined || bytes.lastIndexOf(EOI) < scan) throw new Error('Truncated JPEG image: the file ends before the image data does. Use a complete file.')
      return frame
    }
  }
  throw new Error('Invalid or unsupported image. Use a complete PNG, JPEG, GIF or WebP file.')
}

/** Bytes of PNG pixel data before compression: a filter byte per row, for each Adam7 pass when interlaced. */
function pngRawSize(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number {
  const rows = (w: number, h: number) => w > 0 && h > 0 ? h * (1 + Math.ceil(w * bitsPerPixel / 8)) : 0
  if (!interlaced) return rows(width, height)
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const
  return passes.reduce((sum, [x, y, dx, dy]) => sum + rows(Math.ceil((width - x) / dx), Math.ceil((height - y) / dy)), 0)
}
/** At most this much PNG pixel data is decompressed to check it; a larger image has its start checked. */
const MAX_VERIFIED_PIXEL_BYTES = 16 * MiB
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * Check the encoded data itself, not only the headers: every PNG chunk checksum and the pixel
 * data's compression. A file whose headers are intact but whose data is damaged otherwise passes
 * the header check and is rejected by the provider on every later request.
 */
function verifyImageData(bytes: Buffer, info: ImageInfo): void {
  if (info.mediaType !== 'image/png') return
  const corrupt = (why: string) => new Error(`Corrupt PNG image: ${why}. Re-export or re-download the file.`)
  const data: Buffer[] = []
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8), body = bytes.subarray(offset + 8, offset + 8 + length)
    if (crc32(body, crc32(type)) !== bytes.readUInt32BE(offset + 8 + length)) throw corrupt(`the checksum of its ${type.toString('ascii')} chunk does not match`)
    if (type.toString('ascii') === 'IDAT') data.push(body)
    if (type.toString('ascii') === 'IEND') break
    offset += length + 12
  }
  const bitDepth = bytes[24]!, channels = PNG_CHANNELS[bytes[25]!]
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) throw corrupt('its header is invalid')
  const expected = pngRawSize(info.width, info.height, channels * bitDepth, bytes[28] === 1)
  const limit = Math.min(expected, MAX_VERIFIED_PIXEL_BYTES)
  let inflated: Buffer
  try { inflated = inflateSync(Buffer.concat(data), { maxOutputLength: limit }) }
  catch (error) {
    // More data than the limit: everything up to it decompressed, which is all that is checked.
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return
    throw corrupt('its pixel data does not decompress')
  }
  if (inflated.length < expected) throw corrupt('its pixel data is incomplete')
}

/**
 * The checks an image passes before it is sent: size, a readable header with real dimensions, the
 * provider's per-side limit, a still image. `deep` (FileRead) also checks the encoded data, once,
 * when the image enters the conversation.
 */
export function checkImage(bytes: Buffer, caps: VisionCapabilities, options: { deep?: boolean } = {}) {
  if (bytes.length > caps.maxBytes) throw new Error(`Image is ${(bytes.length / MiB).toFixed(1)} MiB, over ${caps.provider}'s ${caps.maxBytes / MiB} MiB inline limit. Resize or compress the image.`)
  const info = imageInfo(bytes)
  if (!info.width || !info.height) throw new Error(`Invalid image: its header gives ${info.width}×${info.height} pixels. Use a complete PNG, JPEG, GIF or WebP file.`)
  if (info.width > caps.maxDimension || info.height > caps.maxDimension) throw new Error(`Image dimensions ${info.width}×${info.height} exceed the ${caps.maxDimension} px per-side limit. Resize the image.`)
  if (info.animated) throw new Error('Animated images are not sent. Export a single still frame as PNG or JPEG.')
  if (options.deep) verifyImageData(bytes, info)
  return info
}

/** An inline image's decoded facts, read once per block object (requests and estimates reuse them). */
type ImageFacts = ImageInfo & { bytes: number; canonical: boolean }
const factCache = new WeakMap<object, ImageFacts | Error>()
function imageFacts(image: ImageBlock): ImageFacts {
  const cached = factCache.get(image)
  if (cached instanceof Error) throw cached
  if (cached) return cached
  try {
    if (image.source?.type !== 'base64' || typeof image.source.data !== 'string') throw new Error('Image data is not inline base64.')
    const bytes = Buffer.from(image.source.data, 'base64')
    const facts = { ...imageInfo(bytes), bytes: bytes.length, canonical: bytes.toString('base64') === image.source.data }
    factCache.set(image, facts)
    return facts
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    factCache.set(image, failure)
    throw failure
  }
}

/** Why the provider would refuse this image block, or undefined when it can be sent. */
export function imageProblem(image: ImageBlock, caps: VisionCapabilities): string | undefined {
  const data = image.source?.data
  if (image.source?.type !== 'base64' || typeof data !== 'string' || data.length > Math.ceil(caps.maxBytes / 3) * 4) return `Image exceeds ${caps.maxBytes / MiB} MiB inline limit. Resize or compress the image.`
  let facts: ImageFacts
  try { facts = imageFacts(image) } catch (error) { return (error as Error).message }
  if (!facts.canonical) return 'Invalid image base64 data'
  if (!facts.width || !facts.height) return `Invalid image: its header gives ${facts.width}×${facts.height} pixels. Use a complete PNG, JPEG, GIF or WebP file.`
  if (facts.width > caps.maxDimension || facts.height > caps.maxDimension) return `Image dimensions ${facts.width}×${facts.height} exceed the ${caps.maxDimension} px per-side limit. Resize the image.`
  if (facts.animated) return 'Animated images are not sent. Export a single still frame as PNG or JPEG.'
  if (facts.mediaType !== image.source.media_type) return 'Image MIME type does not match its bytes'
}

export function toolResultText(content: ToolResultBlock['content']): string {
  return typeof content === 'string' ? content : content.map(b => b.type === 'text' ? b.text : `[Image: ${b.source.media_type}]`).join('\n')
}

export function requestImages(messages: LLMMessage[]): ImageBlock[] {
  return messages.flatMap(m => typeof m.content === 'string' ? [] : m.content.flatMap(b => b.type === 'image' ? [b] : b.type === 'tool_result' && Array.isArray(b.content) ? b.content.filter((v): v is ImageBlock => v.type === 'image') : []))
}

/** Thrown before anything is sent: nothing is billed, and the same request would fail again. */
export function validateImages(options: LLMRequestOptions, caps?: VisionCapabilities): void {
  const images = requestImages(options.messages)
  if (!images.length) return
  if (!caps) throw new RequestNotSentError('The selected model does not support image input. Select a supported vision model to continue this conversation.')
  if (images.length > caps.maxImages) throw new RequestNotSentError(`Too many images in one request: ${images.length}; ${caps.provider} accepts at most ${caps.maxImages}.`)
  for (const image of images) {
    const problem = imageProblem(image, caps)
    if (problem) throw new RequestNotSentError(problem)
  }
}

export function validateImageRequestSize(body: unknown, caps?: VisionCapabilities): void {
  if (caps && Buffer.byteLength(JSON.stringify(body)) > caps.maxRequestBytes) throw new RequestNotSentError(`Request exceeds ${caps.provider}'s ${caps.maxRequestBytes / MiB} MiB inline request limit because of the images in the conversation.`, 'size')
}

/** Room a request keeps for the system prompt, the tools and the new turn next to its images. */
export const IMAGE_REQUEST_RESERVE = MiB

/** The messages as a request carries them: role and content, without the saved provider continuation. */
const sentShape = (messages: LLMMessage[]) => messages.map(message => ({ role: message.role, content: message.content }))

/** The images the next request carries and the size of its messages as JSON. */
export function imageLoad(messages: LLMMessage[]): { images: number; bytes: number } {
  const images = requestImages(messages).length
  return { images, bytes: images ? Buffer.byteLength(JSON.stringify(sentShape(messages))) : 0 }
}

/**
 * The capabilities a tool sees, with what the conversation already holds: an image that would take
 * the next request over the model's image count or request size is refused when it is read.
 */
export function withImageBudget(caps: VisionCapabilities | undefined, messages: () => LLMMessage[]): VisionCapabilities | undefined {
  return caps && { ...caps, inContext: () => imageLoad(messages()) }
}

/**
 * Input tokens for one image of this size, as each provider bills it. Anthropic (and an unknown
 * provider) shrinks the image to the model's limits (2576 px and about 3.75 MP on high-resolution
 * models, 1568 px and about 1.15 MP before them), then bills about one token per 28×28 px patch;
 * OpenAI fits it into 2048 px, brings the short side to 768 px and bills 85 plus 170 per 512 px
 * tile; Gemini bills 258 per 768 px tile (258 for a small image).
 */
export function imageTokenEstimate(width: number, height: number, caps?: VisionCapabilities): number {
  if (!(width > 0 && height > 0)) return 0
  if (caps?.provider === 'openai') {
    const fit = Math.min(1, 2048 / Math.max(width, height))
    const short = Math.min(1, 768 / (Math.min(width, height) * fit))
    return 85 + 170 * Math.ceil(width * fit * short / 512) * Math.ceil(height * fit * short / 512)
  }
  if (caps?.provider === 'gemini') return width <= 384 && height <= 384 ? 258 : 258 * Math.ceil(width / 768) * Math.ceil(height / 768)
  const scale = anthropicScale(width, height, caps), pixelsPerToken = (caps?.highRes ?? true) ? 784 : 750
  return Math.max(1, Math.ceil((width * scale) * (height * scale) / pixelsPerToken))
}

/** How much Anthropic (and an unknown provider) shrinks an image: to 2576 px and about 3.75 MP, or 1568 px and 1.15 MP. */
function anthropicScale(width: number, height: number, caps?: VisionCapabilities): number {
  const high = caps?.highRes ?? true
  const maxEdge = high ? 2576 : 1568, maxPixels = high ? 3_750_000 : 1_150_000
  return Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
}

/** The size the model sees an image at, after the provider shrinks it (Gemini tiles it instead). */
export function imageShownSize(width: number, height: number, caps?: VisionCapabilities): { width: number; height: number } {
  if (!(width > 0 && height > 0) || caps?.provider === 'gemini') return { width, height }
  let scale: number
  if (caps?.provider === 'openai') {
    const fit = Math.min(1, 2048 / Math.max(width, height))
    scale = fit * Math.min(1, 768 / (Math.min(width, height) * fit))
  } else scale = anthropicScale(width, height, caps)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
/** An image whose header cannot be read: the most a high-resolution image costs. */
const UNREADABLE_IMAGE_TOKENS = 4_784

function imageTokens(image: ImageBlock, caps?: VisionCapabilities): number {
  try { const facts = imageFacts(image); return imageTokenEstimate(facts.width, facts.height, caps) } catch { return UNREADABLE_IMAGE_TOKENS }
}

/** The image tokens of these messages alone (estimateMessages includes them). */
export function estimateImageTokens(messages: LLMMessage[], caps?: VisionCapabilities): number {
  return requestImages(messages).reduce((sum, image) => sum + imageTokens(image, caps), 0)
}

/**
 * A message as the request sends it. An assistant reply with a provider continuation is replayed
 * from it: an array payload (Anthropic, Gemini) replaces the content, an object payload (an
 * OpenAI-compatible reasoning_content) is sent beside it. The saved continuation itself is never
 * counted twice.
 */
function sentMessage(message: LLMMessage): { role: LLMMessage['role']; content: LLMMessage['content'] | unknown[]; extra?: unknown } {
  const payload = message.role === 'assistant' ? message.continuation?.payload : undefined
  if (Array.isArray(payload)) return { role: message.role, content: payload }
  // Anthropic's stored thinking and its places: the native blocks rebuilt from the content.
  if (isNativeLayout(payload)) return { role: message.role, content: nativeContent(message.content, payload) }
  if (payload && typeof payload === 'object') return { role: message.role, content: message.content, extra: payload }
  return { role: message.role, content: message.content }
}

/**
 * Estimate the messages as sent: images by the provider's image formula (`caps` names it; without
 * it Anthropic's), never base64 characters as language tokens, and each message once.
 */
export function estimateMessages(messages: LLMMessage[], estimate: (text: string) => number, caps?: VisionCapabilities): number {
  let imageTotal = 0
  const imageEstimate = (image: ImageBlock) => {
    imageTotal += imageTokens(image, caps)
    return { type: 'image', media_type: image.source?.media_type }
  }
  const body = messages.map(message => {
    const sent = sentMessage(message)
    if (!Array.isArray(sent.content)) return sent
    return { ...sent, content: (sent.content as Array<{ type?: unknown; content?: unknown }>).map(block =>
      block?.type === 'image' ? imageEstimate(block as ImageBlock) : block?.type === 'tool_result' && Array.isArray(block.content)
        ? { ...block, content: (block.content as Array<{ type?: unknown }>).map(child => child?.type === 'image' ? imageEstimate(child as ImageBlock) : child) } : block) }
  })
  return estimate(JSON.stringify(body)) + imageTotal
}
