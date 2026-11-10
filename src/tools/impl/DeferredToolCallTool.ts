/**
 * @file DeferredToolCallTool.ts
 * @brief Calls a tool whose definition the session does not send (deferred tool loading)
 *
 * In deferred mode (see toolLoading.ts) a session sends only the core tools in full. The others are
 * named in this tool's description; the model gets one's definition with ToolSearch and calls it
 * through this tool. The tool runner unwraps the call before anything else, so it passes every gate
 * exactly as a direct call: permissions, rules, the failure budget, cards and events all see the
 * real tool and input. The tool_use block in the history stays as the model sent it.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool, ToolResult } from '../tool.js'
import type { ToolUseBlock } from '../../llm/types.js'
import { formatInputIssues, normalizeToolInput } from '../inputNormalization.js'

export const DEFERRED_CALL = 'DeferredToolCall'

const inputSchema = z.object({
  tool: z.string().min(1).describe('Name of the tool to call'),
  input: z.record(z.unknown()).optional().describe('Its input, as its schema from ToolSearch describes'),
})

/**
 * A tool's input schema as a request sends it. An empty value schema (`additionalProperties: {}`,
 * `items: {}`, as zod-to-json-schema writes z.record(z.unknown()) and z.array(z.unknown())) means
 * "any value", but some local tool-call parsers read it as "an object": llama.cpp's Qwen XML format
 * turned every value of such a field into {}. It is sent in the plain forms every parser reads alike:
 * `additionalProperties: true`, and no `items` at all.
 */
export function toolJsonSchema(tool: Pick<Tool<unknown, unknown>, 'inputSchema' | 'inputJsonSchema'>): Record<string, unknown> {
  return anyValueSchemas(tool.inputJsonSchema ?? zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7', $refStrategy: 'none' })) as Record<string, unknown>
}

const isEmptySchema = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0

function anyValueSchemas(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anyValueSchemas)
  if (!schema || typeof schema !== 'object') return schema
  const entries = Object.entries(schema).flatMap(([key, value]): Array<[string, unknown]> =>
    key === 'additionalProperties' && isEmptySchema(value) ? [[key, true]]
    : key === 'items' && isEmptySchema(value) ? []
    // Inside `properties` every key is a field name, never a keyword.
    : key === 'properties' && value && typeof value === 'object' ? [[key, Object.fromEntries(Object.entries(value).map(([name, field]) => [name, anyValueSchemas(field)]))]]
    : [[key, anyValueSchemas(value)]])
  return Object.fromEntries(entries)
}

/**
 * The call a DeferredToolCall block stands for: the same id, the named tool and its input. An
 * error says why the wrapper itself is not a call (the refusal, as the model reads it); undefined
 * for any other block.
 */
export function unwrapDeferredCall(block: ToolUseBlock): { block: ToolUseBlock } | { error: string } | undefined {
  if (block.name !== DEFERRED_CALL) return undefined
  const parsed = inputSchema.safeParse(normalizeToolInput(inputSchema, block.input))
  if (!parsed.success) return { error: `Not run: invalid input for "${DEFERRED_CALL}":\n${formatInputIssues(inputSchema, parsed.error.issues)}` }
  const name = parsed.data.tool.trim()
  if (name === DEFERRED_CALL) return { error: `Not run: ${DEFERRED_CALL} cannot call itself; name the tool to call in "tool".` }
  return { block: { ...block, name, input: parsed.data.input ?? {} } }
}

/** The block as cards and events show it: a deferred call as the call it stands for. */
export function deferredView(block: ToolUseBlock): ToolUseBlock {
  const unwrapped = unwrapDeferredCall(block)
  return unwrapped && 'block' in unwrapped ? unwrapped.block : block
}

/** A few words on a tool, for the list of deferred tools: its first sentence, at most 80 characters. */
function summary(description: string): string {
  const line = description.replace(/\s+/g, ' ').trim()
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0].replace(/[.!?]$/, '') ?? line
  return sentence.length > 80 ? `${sentence.slice(0, 79).trimEnd()}…` : sentence
}

/** Its description in a deferred session: how to call, then the deferred tools, frozen with the session. */
export function deferredCallDescription(deferred: ReadonlyArray<Pick<Tool<unknown, unknown>, 'name' | 'description'>>): string {
  return `${DeferredToolCallTool.prompt()}\nTools loaded on demand:\n${deferred.map(tool => `- ${tool.name}: ${summary(tool.description)}`).join('\n')}`
}

export const DeferredToolCallTool: Tool<z.infer<typeof inputSchema>, string> = {
  name: DEFERRED_CALL,
  description: 'Call a tool that is loaded on demand',
  inputSchema,

  // The tool runner unwraps every DeferredToolCall block; this runs only if something bypasses it.
  async call(): Promise<ToolResult<string>> {
    return { success: false, error: `${DEFERRED_CALL} runs only through the tool runner.` }
  },

  async checkPermissions() { return { decision: 'allow' as const } },
  prompt() {
    return `${DEFERRED_CALL}: Call a tool listed below. Get its definition first with ToolSearch (query "select:Name,Other" or keywords), then call it here as {"tool": "Name", "input": {...}}. It runs exactly as a direct call would.`
  },
}
