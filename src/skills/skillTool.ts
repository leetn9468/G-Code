/**
 * @file skillTool.ts
 * @brief SkillTool — one tool that lists the loaded skills and loads one by name
 *
 * The tool's prompt is the catalog: each model-invocable skill's name and a
 * capped description, frozen with the session's tool definitions. A call re-reads
 * the skill's file, so an edited body applies without a restart, and returns its
 * instructions with the bundle directory that relative paths in them resolve against.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tools/tool.js'
import { parseFrontmatter, skillFileProblem } from './loader.js'
import { MAX_TOOL_RESULT_CHARS } from '../engine/microcompact.js'
import { headUnits } from '../utils/textUnits.js'
import type { Skill } from './types.js'

export const SKILL_TOOL = 'Skill'
/** A catalog entry's description is cut to this many characters. */
export const CATALOG_DESCRIPTION_MAX = 250

const inputSchema = z.object({
  skill: z.string().describe('Exact name of a skill from the list'),
  args: z.string().optional().describe('Arguments for the skill'),
})

type SkillInput = z.infer<typeof inputSchema>

function catalogLine(skill: Skill): string {
  const text = [skill.description, skill.whenToUse && `Use when: ${skill.whenToUse}`].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return `- ${skill.name}: ${text.length > CATALOG_DESCRIPTION_MAX ? `${text.slice(0, CATALOG_DESCRIPTION_MAX - 1).trimEnd()}…` : text}`
}

/** What a skill adds to a message at most, as an MCP prompt does. */
export const SKILL_BODY_CHARS = 100_000
/** What it returns through the Skill tool at most: a longer result would be cut by microcompaction, whose note speaks of commands. */
const SKILL_RESULT_CHARS = MAX_TOOL_RESULT_CHARS - 2000

/**
 * A skill's instructions as the model gets them, read from its file now (an edited body applies
 * without a restart): `{args}` in the body takes the arguments (empty without any), or they follow it.
 */
export function renderSkill(skill: Skill, args?: string, limit = SKILL_BODY_CHARS): { text: string } | { error: string } {
  // The file may have changed since it was loaded.
  const problem = skillFileProblem(skill.filePath, skill.within)
  if (problem) return { error: `Skill ${skill.name} cannot be used now: ${problem}.` }
  let content: string
  try {
    const parsed = parseFrontmatter(readFileSync(skill.filePath, 'utf-8'))
    if (!parsed.frontmatter) return { error: `Skill ${skill.name} is no longer valid: ${skill.filePath} lost its frontmatter.` }
    content = parsed.body
  } catch {
    return { error: `Skill ${skill.name} is no longer available: ${skill.filePath} cannot be read.` }
  }
  if (content.includes('{args}')) content = content.replace(/\{args\}/g, () => args ?? '')
  else if (args) content = `${content.trimEnd()}\n\nArguments: ${args}`
  // A body this size would fill the context each time it runs, and in a message it can fail the whole turn.
  if (content.length > limit) content = `${headUnits(content, limit)}\n\n[This skill is ${content.length.toLocaleString('en-US')} characters long and only the first ${limit.toLocaleString('en-US')} are shown. The rest is in ${skill.filePath}: read the part you need with FileRead offset and limit.]`
  const base = skill.baseDir ? `Base directory: ${skill.baseDir} (relative paths in these instructions are relative to it)\n\n` : ''
  return { text: `${skillMarker(skill.name)}\n${base}${content.trim()}\n</skill>` }
}

/** The opening tag of a rendered skill: an earlier one in the conversation means it is loaded. */
export const skillMarker = (name: string) => `<skill name="${name}">`

/**
 * The Skill tool for these skills, or undefined when none may be invoked by the model.
 */
export function createSkillTool(skills: ReadonlyArray<Skill>): Tool<SkillInput, string> | undefined {
  const invocable = skills.filter(skill => skill.modelInvocable)
  if (invocable.length === 0) return undefined
  const byName = new Map(invocable.map(skill => [skill.name, skill]))
  // prompt() is what the model gets in the request's tools; description is the short summary.
  const catalog = `Load a skill: instructions for a kind of task. Before doing a task that a skill below covers, call this with its exact name and follow the instructions it returns; the summary here is not the instructions.
Skills:
${invocable.map(catalogLine).join('\n')}`

  return {
    name: SKILL_TOOL,
    description: `Load a skill's instructions by name. Skills: ${invocable.map(skill => skill.name).join(', ')}.`,
    inputSchema,
    concurrencySafe: true,

    async call(input, _context: ToolUseContext): Promise<ToolResult<string>> {
      const skill = byName.get(input.skill.trim())
      if (!skill) {
        return { success: false, error: `Unknown skill ${JSON.stringify(input.skill.slice(0, 80))}. Available: ${[...byName.keys()].join(', ')}.` }
      }

      const rendered = renderSkill(skill, input.args, SKILL_RESULT_CHARS)
      return 'error' in rendered ? { success: false, error: rendered.error } : { success: true, output: rendered.text }
    },

    async checkPermissions(_input, _context): Promise<PermissionResult> {
      return { decision: 'allow', reason: 'Skill execution' }
    },

    prompt(): string {
      return catalog
    },
  }
}
