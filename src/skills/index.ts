/**
 * @file index.ts
 * @brief Skills barrel export + initialization
 */

import { registerTool, unregisterTool } from '../tools/registry.js'
import type { Tool } from '../tools/tool.js'
import { loadAllSkills } from './loader.js'
import { createSkillTool, SKILL_TOOL } from './skillTool.js'

export type { Skill, SkillFrontmatter } from './types.js'
export { loadAllSkills, getSkills, findUserSkill } from './loader.js'
export { createSkillTool, SKILL_TOOL } from './skillTool.js'

/**
 * Initialize skills: load from disk and register the Skill tool (replacing an earlier one).
 */
export function initSkills(cwd: string, verbose = false): number {
  const skills = loadAllSkills(cwd)

  unregisterTool(SKILL_TOOL)
  const tool = createSkillTool(skills)
  if (tool) registerTool(tool as Tool<unknown, unknown>)

  if (verbose && skills.length > 0) {
    process.stderr.write(`[skills] Loaded ${skills.length} skills: ${skills.map((s) => s.name).join(', ')}\n`)
  }

  return skills.length
}
