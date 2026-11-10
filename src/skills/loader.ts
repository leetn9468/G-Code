/**
 * @file loader.ts
 * @brief Load skills from filesystem directories
 *
 * A skill is a flat `<name>.md` or a bundle `<name>/SKILL.md` directly under a
 * skill root, starting with YAML frontmatter (`name` and `description` required).
 * Nested `**\/SKILL.md` files are not discovered, as in DeepSeek Harness.
 *
 * Roots, lowest priority first (a later root's skill replaces a same-name one):
 *   bundled < ~/.agents/skills < ~/.dsh/skills < ~/.gcode/skills
 *           < <project>/.agents/skills < <project>/.dsh/skills < <cwd>/.gcode/skills
 * The DSH and .agents roots follow DeepSeek Harness: DSH_HOME / DSH_AGENTS_HOME
 * override the user homes, the project is the nearest ancestor holding `.git`
 * (else the cwd), and the user DSH root's `.system` child is skipped.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type { Skill, SkillFrontmatter } from './types.js'

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * The top-level scalar keys of a YAML frontmatter block: plain, quoted, block (`|`, `>`) and
 * multi-line plain values. Nested maps and lists (`metadata:`) read as ''.
 */
function parseYamlScalars(block: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    const raw = (kv[2] ?? '').trim()
    const more: string[] = []
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === '' || /^\s/.test(lines[i + 1]!))) more.push(lines[++i]!)
    const indented = more.map(line => line.trim())
    const doubleQuoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw)
    const singleQuoted = /^'((?:[^']|'')*)'/.exec(raw)
    const value = raw.replace(/(^|\s)#.*$/, '').trim() // A plain value ends at a comment.
    const block = /^([|>])[+-]?$/.exec(value)
    if (doubleQuoted) {
      fields[key] = doubleQuoted[1]!.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')
    } else if (singleQuoted) {
      fields[key] = singleQuoted[1]!.replace(/''/g, "'")
    } else if (block) {
      fields[key] = (block[1] === '|' ? indented.join('\n') : indented.join(' ').replace(/ {2,}/g, ' ')).trim()
    } else if (value && more.some(line => line.trim()) && !more.some(line => /^\s+(-\s|[\w-]+:(\s|$))/.test(line))) {
      fields[key] = [value, ...indented.map(line => line.replace(/(^|\s)#.*$/, '').trim())].filter(Boolean).join(' ')
    } else {
      fields[key] = value
    }
  }
  return fields
}

/** YAML booleans DSH accepts for its invocation keys; undefined for anything else. */
function yamlBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(v)) return true
  if (['false', 'no', 'off', '0'].includes(v)) return false
  return undefined
}

/** Skill names are tool arguments and catalog entries: letters, digits and `-_.:`, at most 64. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

type Parsed = { frontmatter: SkillFrontmatter; body: string } | { frontmatter: null; body: string; problem?: string }

export function parseFrontmatter(raw: string): Parsed {
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = content.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/)
  if (!match) return { frontmatter: null, body: content }

  const fm = parseYamlScalars(match[1]!)
  const body = (match[2] ?? '').replace(/^\n+/, '')

  if (!fm['name'] || !fm['description']) return { frontmatter: null, body: content, problem: 'needs a name and a description' }
  if (!SKILL_NAME.test(fm['name'])) return { frontmatter: null, body: content, problem: `has an invalid name ${JSON.stringify(fm['name'].slice(0, 70))}` }
  let modelInvocable = true
  if (fm['disable-model-invocation'] !== undefined) {
    const disabled = yamlBoolean(fm['disable-model-invocation'])
    if (disabled === undefined) return { frontmatter: null, body: content, problem: 'has a disable-model-invocation value that is not true or false' }
    modelInvocable = !disabled
  }
  let userInvocable = true
  if (fm['user-invocable'] !== undefined) {
    const invocable = yamlBoolean(fm['user-invocable'])
    if (invocable === undefined) return { frontmatter: null, body: content, problem: 'has a user-invocable value that is not true or false' }
    userInvocable = invocable
  }

  return {
    frontmatter: {
      name: fm['name'],
      description: fm['description'],
      whenToUse: fm['whenToUse'] || fm['when_to_use'] || undefined,
      trigger: fm['trigger'],
      args: fm['args'],
      enabled: fm['enabled'] !== 'false',
      modelInvocable,
      userInvocable,
    },
    body,
  }
}

/**
 * A trigger's top-level alternatives shaped like a command ("/commit") become aliases: they run the
 * skill only when a message starts with them, so a path such as src/commit.ts never does. The other
 * alternatives stay a pattern that loads the skill when a user message matches it.
 */
export function splitTrigger(trigger: string): { aliases: string[]; pattern: string } {
  const parts: string[] = []
  let depth = 0, inClass = false, start = 0
  for (let i = 0; i < trigger.length; i++) {
    const c = trigger[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === '|' && depth === 0) { parts.push(trigger.slice(start, i)); start = i + 1 }
  }
  parts.push(trigger.slice(start))
  const alias = (part: string) => /^\/[A-Za-z][\w-]*$/.test(part.trim())
  return { aliases: parts.filter(alias).map(part => part.trim()), pattern: parts.filter(part => part.trim() && !alias(part)).join('|') }
}

// ============================================================================
// Directory Loading
// ============================================================================

const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  process.stderr.write(`[skills] ${message}\n`)
}

const isDirectory = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }
const isFile = (path: string) => { try { return statSync(path).isFile() } catch { return false } }

/** The largest skill file read, at load and when it is run: every root is read at every launch, a project's too. */
export const MAX_SKILL_BYTES = 1024 * 1024

/**
 * Why this skill file must not be read now, or undefined. Its size is checked first, because the
 * read is whole. A project skill's real path stays in the project: a read outside it needs an
 * approval, which a launch cannot ask for, and the Skill tool would otherwise pass one on as its own.
 */
export function skillFileProblem(filePath: string, within?: string): string | undefined {
  if (within) {
    const real = (path: string) => { try { return realpathSync(path) } catch { return undefined } }
    const file = real(filePath), root = real(within)
    if (file && root && file !== root && !file.startsWith(root + sep)) return `it leads out of the project, to ${file}. Reading outside the project needs an approval, so a project skill cannot come from there: copy it into the project, or into ~/.gcode/skills, or read it with FileRead`
  }
  let size: number
  try { const info = statSync(filePath); if (!info.isFile()) return 'it is not a regular file'; size = info.size } catch { return undefined }
  if (size > MAX_SKILL_BYTES) return `it is ${(size / 1024 ** 2).toFixed(1)} MB, and a skill file may be at most ${MAX_SKILL_BYTES / 1024 ** 2} MB: move the details into files in a bundle that its instructions name`
  return undefined
}

function loadSkillFile(filePath: string, source: Skill['source'], baseDir?: string, within?: string): Skill | undefined {
  const problem = skillFileProblem(filePath, within)
  if (problem) { warnOnce(`Skipped ${filePath}: ${problem}.`); return undefined }
  let raw: string
  try { raw = readFileSync(filePath, 'utf-8') } catch { return undefined }
  const parsed = parseFrontmatter(raw)
  if (!parsed.frontmatter) {
    // A bundle's SKILL.md is meant as a skill; a flat .md without frontmatter may just be a README.
    if (parsed.problem || baseDir) warnOnce(`Skipped ${filePath}: its frontmatter ${parsed.problem ?? 'is missing'}.`)
    return undefined
  }
  const { frontmatter, body } = parsed
  if (frontmatter.enabled === false) return undefined

  const { aliases, pattern } = splitTrigger(frontmatter.trigger ?? '')
  let trigger: RegExp | undefined
  if (pattern) {
    try { trigger = new RegExp(pattern, 'i') } catch { warnOnce(`${filePath}: its trigger is not a valid regular expression; only /${frontmatter.name} runs it.`) }
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    whenToUse: frontmatter.whenToUse,
    trigger,
    aliases,
    content: body,
    filePath,
    baseDir,
    source,
    ...(within ? { within } : {}),
    modelInvocable: frontmatter.modelInvocable,
    userInvocable: frontmatter.userInvocable,
  }
}

/** The skills directly under one root: `<name>/SKILL.md` bundles and flat `<name>.md` files. */
export function loadSkillsFromDir(dir: string, source: Skill['source'], skip: ReadonlySet<string> = new Set(), within?: string): Skill[] {
  if (!existsSync(dir)) return []

  const skills: Skill[] = []
  let entries: string[]
  try { entries = readdirSync(dir).sort() } catch { return [] } // Dir not readable

  for (const entry of entries) {
    if (skip.has(entry)) continue
    const path = join(dir, entry)
    let skill: Skill | undefined
    if (isDirectory(path)) {
      const file = join(path, 'SKILL.md')
      if (isFile(file)) skill = loadSkillFile(file, source, path, within)
    } else if (entry.endsWith('.md') && isFile(path)) {
      skill = loadSkillFile(path, source, undefined, within)
    }
    if (skill) skills.push(skill)
  }

  return skills
}

/** The nearest ancestor of `cwd` holding `.git` (DSH's project root), else `cwd`. */
function projectRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return resolve(cwd)
  }
}

/** Every skill root, lowest priority first. */
export function skillRoots(cwd: string, bundledDir: string): Array<{ dir: string; source: Skill['source']; skip?: ReadonlySet<string>; within?: string }> {
  const home = homedir()
  const dshHome = process.env['DSH_HOME']?.trim() || join(home, '.dsh')
  const agentsHome = process.env['DSH_AGENTS_HOME']?.trim() || join(home, '.agents')
  const project = projectRoot(cwd)
  return [
    { dir: bundledDir, source: 'bundled' },
    { dir: join(agentsHome, 'skills'), source: 'user' },
    { dir: join(dshHome, 'skills'), source: 'user', skip: new Set(['.system']) },
    { dir: join(home, '.gcode', 'skills'), source: 'user' },
    { dir: join(project, '.agents', 'skills'), source: 'project', within: project },
    { dir: join(project, '.dsh', 'skills'), source: 'project', within: project },
    { dir: join(cwd, '.gcode', 'skills'), source: 'project', within: project },
  ]
}

// ============================================================================
// Public API
// ============================================================================

let loadedSkills: Skill[] = []

/**
 * Load skills from all roots (see the file header), a later root replacing a same-name skill.
 */
export function loadAllSkills(cwd: string): Skill[] {
  // Load bundled skills (shipped with G-Code)
  let bundledDir: string
  try {
    bundledDir = process.env['GCODE_BUNDLED_SKILLS_DIR']
      ?? join(dirname(fileURLToPath(import.meta.url)), 'bundled')
  } catch {
    bundledDir = join(__dirname, 'bundled')
  }

  const byName = new Map<string, Skill>()
  const seen = new Set<string>()
  for (const root of skillRoots(cwd, bundledDir)) {
    const dir = resolve(root.dir)
    if (seen.has(dir)) continue // A project at the home directory: its roots are the user's.
    seen.add(dir)
    for (const skill of loadSkillsFromDir(dir, root.source, root.skip, root.within)) byName.set(skill.name, skill)
  }

  loadedSkills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  return loadedSkills
}

/** The skills the last loadAllSkills found. */
export function getSkills(): ReadonlyArray<Skill> {
  return loadedSkills
}

/** The skill a user command runs: `/<name>` or one of its trigger's aliases ("/commit"). */
export function findUserSkill(command: string): Skill | undefined {
  const invocable = loadedSkills.filter(skill => skill.userInvocable)
  return invocable.find(skill => `/${skill.name}` === command) ?? invocable.find(skill => skill.aliases.includes(command))
}
