/**
 * @file slashCommands.ts
 * @brief What a user message runs besides the built-in commands: `/<skill> args` (or a skill's
 *        trigger alias such as /commit), `/mcp__<server>__<prompt> args`, and skills whose trigger
 *        pattern the message matches. The user's words stay the message; the instructions go in the
 *        turn's context block (src/engine/systemPrompt.ts), so the saved conversation shows what was
 *        typed and the model gets what it ran.
 */

import { userWords } from '../shared/execution.js'
import { findUserSkill, getSkills } from '../skills/loader.js'
import { renderSkill, skillMarker } from '../skills/skillTool.js'
import type { Skill } from '../skills/types.js'
import { getMCPClients, getMcpPrompt, mcpModelNotices } from '../mcp/manager.js'
import type { MCPPromptMessage } from '../mcp/client.js'
import type { MCPPromptDefinition } from '../mcp/types.js'
import type { TurnInvocation } from '../engine/systemPrompt.js'
import { maskSecrets } from '../security/secretValues.js'
import { escapeDisplayControls } from '../shared/displayText.js'

/** The CLI's own commands: a skill or prompt of the same name never replaces one. */
export const BUILT_IN_COMMANDS = new Set(['/exit', '/quit', '/reset', '/clear', '/status', '/tools', '/todos', '/help', '/compact', '/context', '/workflows', '/session-controls', '/network-decision', '/budget-add'])

/** What an MCP prompt adds to the context block at most. */
const PROMPT_LIMIT = 100_000

export type SlashTarget =
  | { kind: 'skill'; skill: Skill; command: string; args: string }
  | { kind: 'prompt'; server: string; prompt: MCPPromptDefinition; command: string; args: string }

/** The skill or MCP prompt a message starting with `/name` runs, if any (built-ins excluded). */
export function resolveSlashCommand(input: string): SlashTarget | undefined {
  const match = /^(\/[A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match || BUILT_IN_COMMANDS.has(match[1]!.toLowerCase())) return
  const command = match[1]!, args = (match[2] ?? '').trim()
  if (command.startsWith('/mcp__')) {
    for (const client of getMCPClients()) {
      const prefix = `/mcp__${client.server.name}__`
      if (!command.startsWith(prefix)) continue
      const prompt = client.prompts.find(p => p.name === command.slice(prefix.length))
      if (prompt) return { kind: 'prompt', server: client.server.name, prompt, command, args }
    }
    return
  }
  const skill = findUserSkill(command)
  return skill ? { kind: 'skill', skill, command, args } : undefined
}

/**
 * A prompt's arguments from what follows the command: `name=value` pairs (quotes allowed), the whole
 * text for a prompt with one argument, or words in the prompt's argument order (the last takes the rest).
 */
export function promptArguments(prompt: MCPPromptDefinition, text: string, command = `/${prompt.name}`): Record<string, string> {
  const declared = prompt.arguments ?? []
  const names = declared.map(a => a.name)
  const values: Record<string, string> = {}
  if (/^[A-Za-z_][\w.-]*=/.test(text)) {
    const pair = /([A-Za-z_][\w.-]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*))\s*/gy
    let found: RegExpExecArray | null, end = 0
    while ((found = pair.exec(text))) {
      if (!names.includes(found[1]!)) throw new Error(`${command} has no argument "${found[1]}". Its arguments: ${names.join(', ') || 'none'}.`)
      values[found[1]!] = found[2] !== undefined ? found[2].replace(/\\(.)/g, '$1') : found[3] ?? found[4] ?? ''
      end = pair.lastIndex
    }
    if (end < text.length) throw new Error(`Write ${command}'s arguments as name=value (quote values with spaces): ${text.slice(end, end + 40)}`)
  } else if (text && declared.length === 1) values[names[0]!] = text
  else if (text) {
    if (!declared.length) throw new Error(`${command} takes no arguments.`)
    const words = text.split(/\s+/)
    names.forEach((name, i) => {
      const word = i === names.length - 1 ? words.slice(i).join(' ') : words[i]
      if (word) values[name] = word
    })
  }
  const missing = declared.filter(a => a.required && !values[a.name]).map(a => a.name)
  if (missing.length) throw new Error(`${command} needs ${missing.join(', ')}. Usage: ${command} ${declared.map(a => `${a.name}=…`).join(' ')}`)
  return values
}

function promptText(message: MCPPromptMessage): string {
  const content = message.content as Record<string, any>
  if (content?.type === 'text' && typeof content.text === 'string') return content.text
  if (content?.type === 'resource' && content.resource) {
    const resource = content.resource as { uri?: string; text?: string; mimeType?: string }
    return typeof resource.text === 'string' ? `[resource ${resource.uri ?? ''}]\n${resource.text}` : `[resource ${resource.uri ?? ''}: ${resource.mimeType ?? 'binary'} content, not shown]`
  }
  if (content?.type === 'image' || content?.type === 'audio') return `[${content.type} ${content.mimeType ?? ''}, not shown]`
  return JSON.stringify(content)
}

/** The instructions an MCP prompt sent, as the context block carries them. */
export function renderPrompt(target: Extract<SlashTarget, { kind: 'prompt' }>, result: { description?: string; messages: MCPPromptMessage[] }): string {
  // Not a tool result, so nothing else masks it; before the cut, which could leave part of a key.
  let body = maskSecrets(result.messages.map(message => `[${message.role}]\n${promptText(message)}`).join('\n\n')) || '(The prompt returned no messages.)'
  if (body.length > PROMPT_LIMIT) body = `${body.slice(0, PROMPT_LIMIT)}\n[Prompt cut at ${PROMPT_LIMIT} characters of ${body.length}.]`
  return [
    `The user ran the MCP prompt "${target.prompt.name}" of server "${target.server}" with ${target.command}. Its messages follow; carry out what they ask as the user's request.`,
    `<mcp-prompt server="${target.server}" name="${target.prompt.name}">`, body, '</mcp-prompt>',
  ].join('\n')
}

/**
 * The context-block entries for one user message: what its `/command` runs (`target`), else the
 * skills whose trigger pattern it matches (each once per conversation).
 */
export async function turnInvocations(input: string, target: SlashTarget | undefined, signal?: AbortSignal): Promise<TurnInvocation[]> {
  // What this chat lacks: said once per conversation, and again only if it changes.
  return [...mcpModelNotices().map(text => ({ once: text, text })), ...await messageInvocations(input, target, signal)]
}

async function messageInvocations(input: string, target: SlashTarget | undefined, signal?: AbortSignal): Promise<TurnInvocation[]> {
  if (target?.kind === 'prompt') {
    const args = promptArguments(target.prompt, target.args, target.command)
    return [{ text: renderPrompt(target, await getMcpPrompt(target.server, target.prompt.name, args, signal ?? AbortSignal.timeout(30_000))) }]
  }
  if (target?.kind === 'skill') {
    const rendered = renderSkill(target.skill, target.args || undefined)
    if ('error' in rendered) throw new Error(rendered.error)
    return [{ text: `The user ran the skill "${target.skill.name}" with ${target.command}. Follow its instructions for this request:\n${rendered.text}` }]
  }
  const invocations: TurnInvocation[] = []
  const words = userWords(input)
  for (const skill of getSkills()) {
    if (!words || !skill.userInvocable || !skill.trigger?.test(words)) continue
    const rendered = renderSkill(skill)
    if ('error' in rendered) continue
    invocations.push({ once: skillMarker(skill.name), text: `The user's message matches the trigger of the skill "${skill.name}". Its instructions follow; use them where they fit the request:\n${rendered.text}` })
  }
  return invocations
}

/** Help lines for the skills and MCP prompts a user can run. */
export function userCommandHelp(): string[] {
  const lines: string[] = []
  for (const skill of getSkills()) if (skill.userInvocable) lines.push(`  /${skill.name}${skill.aliases.filter(a => a !== `/${skill.name}`).map(a => `, ${a}`).join('')}  ${skill.description}`)
  for (const client of getMCPClients()) for (const prompt of client.prompts) {
    // A server's words go to a terminal here: no control sequence of theirs may reach it.
    lines.push(escapeDisplayControls(`  /mcp__${client.server.name}__${prompt.name}${(prompt.arguments ?? []).map(a => a.required ? ` ${a.name}=…` : ` [${a.name}=…]`).join('')}  ${prompt.description ?? ''}`.trimEnd()))
  }
  return lines.length ? ['Skills and MCP prompts:', ...lines] : []
}
