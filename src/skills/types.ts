/**
 * @file types.ts
 * @brief Skill type definitions
 *
 * A skill is a markdown file with frontmatter that defines a prompt-based
 * capability: a flat `<name>.md` or a bundle directory `<name>/SKILL.md`
 * (the layout DeepSeek Harness and other agents use). The Skill tool lists
 * the loaded skills and returns one's instructions on demand.
 */

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  /** A regex: alternatives shaped like `/name` are command aliases, the rest load the skill when a user message matches. */
  trigger?: string
  args?: string     // Expected argument format
  enabled?: boolean
  /** `disable-model-invocation: true` keeps the skill out of the model's catalog. */
  modelInvocable: boolean
  /** `user-invocable: false` keeps the skill from `/name` and from its trigger. */
  userInvocable: boolean
}

export interface Skill {
  name: string
  description: string
  whenToUse?: string
  /** Matches a user message that should load the skill (once per session); the trigger's non-alias part. */
  trigger?: RegExp
  /** Commands ("/commit") that run the skill like `/<name>`, from the trigger. */
  aliases: string[]
  content: string  // The markdown body as loaded (the Skill tool re-reads the file on each call)
  filePath: string
  /** A bundle's directory: files its instructions name (scripts/, references/…) are relative to it. */
  baseDir?: string
  source: 'bundled' | 'user' | 'project'
  /** A project skill: the project folder, which its file (by real path) may not lead out of. */
  within?: string
  modelInvocable: boolean
  userInvocable: boolean
}
