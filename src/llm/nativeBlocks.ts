/**
 * @file nativeBlocks.ts
 * @brief How a saved Anthropic reply keeps its native content blocks.
 *
 * A reply is replayed with its native blocks: its signed thinking goes back byte for byte, in its
 * place among the text and tool calls. The saved message's wire content already holds that text
 * and those calls, so the continuation stores only the thinking blocks (and any block the wire
 * content cannot hold), with their places: the text blocks by length, the tool calls by id. The
 * native list is rebuilt from the wire content when the reply is sent again.
 *
 * Sessions saved before this kept the whole native list as the payload (an array); those still
 * replay it as saved (see replayHistory in src/llm/anthropic.ts).
 */

import type { ContentBlock } from './types.js'

/**
 * The continuation provider of a reply saved in the layout form. Not 'anthropic': a G-Code from
 * before the layout sends the payload of an 'anthropic' continuation (for the same model) as the
 * message's content, and a layout is not a content list, so every request of the session would
 * fail there. Under this tag such a runtime does not know the continuation and sends the saved
 * content: the reply's text and tool calls, without its thinking, which is a valid request.
 * Replies saved under 'anthropic' in the layout form (by the first runtime that wrote it) are
 * still read.
 */
export const ANTHROPIC_LAYOUT_PROVIDER = 'anthropic-layout'

/** One native block of a saved reply: kept whole, or where the wire content holds it. */
export type NativeSlot =
  /** A thinking or redacted_thinking block (or another block the wire content does not hold), as the API sent it. */
  | { block: Record<string, unknown> }
  /** A text block: the next `text` UTF-16 units of the wire content's text. */
  | { text: number }
  /** A tool call: the wire content's tool_use block with this id. */
  | { tool: string }

/** A reply's native blocks, as a continuation payload stores them. */
export interface NativeLayout { layout: NativeSlot[] }

const THINKING = new Set(['thinking', 'redacted_thinking'])

/** A continuation payload in the layout form (not the native list older sessions saved). */
export function isNativeLayout(payload: unknown): payload is NativeLayout {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as { layout?: unknown }).layout)
}

/**
 * The layout of a reply's native blocks: thinking (and any block the engine does not keep) whole,
 * text blocks by length, tool calls by id. An empty text block is left out: it cannot be sent.
 */
export function nativeLayout(blocks: ReadonlyArray<Record<string, unknown>>): NativeLayout {
  const layout: NativeSlot[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') { if (block.text) layout.push({ text: block.text.length }) }
    else if (block.type === 'tool_use' && typeof block.id === 'string') layout.push({ tool: block.id })
    else layout.push({ block })
  }
  return { layout }
}

/**
 * The native blocks a layout describes, rebuilt from the reply's saved content: the stored blocks
 * in their places, the text cut back into its native blocks, each tool call where it was. What the
 * saved content holds beyond the layout (a "(no reply text)" note) follows at the end; text the
 * engine did not keep is not sent.
 */
export function nativeContent(content: string | ContentBlock[], payload: NativeLayout): unknown[] {
  const blocks: ContentBlock[] = typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content
  const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const calls = new Map(blocks.flatMap(block => block.type === 'tool_use' ? [[block.id, block] as const] : []))
  const placed = new Set<string>()
  const native: unknown[] = []
  let cursor = 0
  for (const slot of payload.layout) {
    if (!slot || typeof slot !== 'object') continue
    if ('block' in slot) native.push(slot.block)
    else if ('text' in slot) {
      const piece = text.slice(cursor, cursor + Math.max(0, slot.text))
      cursor += piece.length
      if (piece) native.push({ type: 'text', text: piece })
    } else if ('tool' in slot) {
      const call = calls.get(slot.tool)
      if (call && !placed.has(slot.tool)) { placed.add(slot.tool); native.push(call) }
    }
  }
  const rest = text.slice(cursor)
  if (rest) native.push({ type: 'text', text: rest })
  for (const block of blocks) {
    if (block.type === 'tool_use' ? !placed.has(block.id) : block.type !== 'text' && !THINKING.has(block.type)) native.push(block)
  }
  return native
}
