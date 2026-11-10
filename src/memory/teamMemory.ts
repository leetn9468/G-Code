/**
 * @file teamMemory.ts
 * @brief Team memory — notes shared by everyone working in a project
 *
 * Stored in .gcode/team-memory/, one JSON file per topic, meant to be committed. Each entry carries
 * its author and time. The system prompt shows each topic's latest entries with the project memory;
 * the TeamMemoryWrite tool adds entries (with the user's approval, as a file write).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { roughTokenCount } from '../engine/context.js'
import { safeWriteFile, withWriteLock } from '../tools/impl/safeWrite.js'
import { headUnits } from '../utils/textUnits.js'

export interface TeamMemoryEntry {
  author: string
  timestamp: number
  content: string
}

export interface TeamMemoryTopic {
  name: string
  entries: TeamMemoryEntry[]
  tokens: number
}

export const TEAM_MEMORY_DIR = join('.gcode', 'team-memory')
/** Entries a topic file keeps; the oldest go first. */
const ENTRIES_KEPT = 200
/** The longest note the tool takes, and what the prompt shows of one that came with the repository. */
export const TEAM_NOTE_MAX = 2000
/** What the prompt shows of all topics together: every request carries it. */
const TEAM_SECTION_MAX = 24_000

const validEntry = (entry: unknown): entry is TeamMemoryEntry => !!entry && typeof entry === 'object'
  && typeof (entry as TeamMemoryEntry).author === 'string' && typeof (entry as TeamMemoryEntry).content === 'string' && !!(entry as TeamMemoryEntry).content.trim()
  && typeof (entry as TeamMemoryEntry).timestamp === 'number' && Number.isFinite((entry as TeamMemoryEntry).timestamp)
  && !Number.isNaN(new Date((entry as TeamMemoryEntry).timestamp).getTime())

/** Each topic file with its parsed topic (invalid entries dropped); unreadable files are skipped. */
function topicFiles(cwd: string): Array<{ file: string; topic: TeamMemoryTopic }> {
  const dir = join(cwd, TEAM_MEMORY_DIR)
  if (!existsSync(dir)) return []
  const found: Array<{ file: string; topic: TeamMemoryTopic }> = []
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const topic = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Partial<TeamMemoryTopic> | null
        if (!topic || typeof topic.name !== 'string' || !topic.name.trim() || !Array.isArray(topic.entries)) continue
        const entries = topic.entries.filter(validEntry)
        found.push({ file, topic: { name: topic.name, entries, tokens: entries.reduce((sum, entry) => sum + roughTokenCount(entry.content), 0) } })
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir not readable */ }
  return found
}

/** This project's topics that hold entries. */
export function readTeamMemory(cwd: string): TeamMemoryTopic[] {
  return topicFiles(cwd).map(({ topic }) => topic).filter(topic => topic.entries.length)
}

/** A topic's file name: letters and digits of any script, other runs as "-". */
export function teamMemoryFileName(topic: string): string {
  return `${topic.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'notes'}.json`
}

/** The file a topic is kept in, relative to the project: the one already holding it, else a new one. */
export function teamMemoryFile(cwd: string, topic: string): string {
  const existing = topicFiles(cwd).find(found => found.topic.name.trim().toLowerCase() === topic.trim().toLowerCase())
  return join(TEAM_MEMORY_DIR, existing?.file ?? teamMemoryFileName(topic))
}

let cachedAuthor: string | undefined
/** Who the notes are from: the project's git user.name, else the account name. */
export function teamMemoryAuthor(cwd: string): string {
  if (cachedAuthor) return cachedAuthor
  let name = ''
  try { name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* not a repository, or no git */ }
  if (!name) try { name = userInfo().username } catch { name = 'unknown' }
  return (cachedAuthor = name.slice(0, 80))
}

/**
 * Appends one entry to a topic (created when new); the file is replaced whole. Returns its path
 * relative to the project. Entries it cannot read as notes (a newer format, a teammate's hand edit)
 * stay as they are. Several writers: see appendTeamMemoryLocked.
 */
export function appendTeamMemory(cwd: string, topicName: string, author: string, content: string, timestamp = Date.now()): string {
  const name = topicName.trim()
  const relative = teamMemoryFile(cwd, name)
  const path = join(cwd, relative)
  let topic: { name: string; entries: unknown[] } = { name, entries: [] }
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TeamMemoryTopic> | null
    if (!saved || !Array.isArray(saved.entries)) throw new Error(`${relative} is not a team-memory topic file; fix or remove it first.`)
    topic = { name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : name, entries: saved.entries }
  }
  topic.entries = [...topic.entries, { author, timestamp, content: content.trim() }]
  // The oldest notes go first; the new one is the last in the list.
  for (let oldest = topic.entries.findIndex(validEntry); topic.entries.length > ENTRIES_KEPT && oldest < topic.entries.length - 1; oldest = topic.entries.findIndex(validEntry)) topic.entries.splice(oldest, 1)
  mkdirSync(join(cwd, TEAM_MEMORY_DIR), { recursive: true })
  safeWriteFile(path, JSON.stringify(topic, null, 2) + '\n')
  return relative
}

/** appendTeamMemory for sessions writing at the same time: each reads what the last one wrote. Throws, with nothing changed, when the wait runs out. */
export async function appendTeamMemoryLocked(cwd: string, topicName: string, author: string, content: string): Promise<string> {
  const path = join(cwd, teamMemoryFile(cwd, topicName.trim()))
  mkdirSync(join(cwd, TEAM_MEMORY_DIR), { recursive: true })
  return withWriteLock(path, () => appendTeamMemory(cwd, topicName, author, content))
}

/** The section is part of every request, and its text comes with the repository: both a note and the whole are bounded. */
export function formatTeamMemoryForPrompt(memoryTopics: readonly TeamMemoryTopic[]): string {
  if (memoryTopics.length === 0) return ''

  const lines = ['## Team Memory\n']
  let shown = 0
  const fits = (line: string) => (shown += line.length + 1) <= TEAM_SECTION_MAX
  topics: for (const topic of memoryTopics) {
    const heading = `### ${headUnits(topic.name, 200)}`
    if (!fits(heading)) { lines.push(`(More team notes are in ${TEAM_MEMORY_DIR}, not shown here.)`); break }
    lines.push(heading)
    for (const entry of topic.entries.slice(-5)) { // Last 5 per topic
      const date = new Date(entry.timestamp).toISOString().split('T')[0]
      const note = entry.content.length > TEAM_NOTE_MAX ? `${headUnits(entry.content, TEAM_NOTE_MAX)}… (cut at ${TEAM_NOTE_MAX} characters; the whole note is in ${TEAM_MEMORY_DIR})` : entry.content
      const line = `- [${headUnits(entry.author, 200)}, ${date}] ${note}`
      if (!fits(line)) { lines.push(`(More team notes are in ${TEAM_MEMORY_DIR}, not shown here.)`); break topics }
      lines.push(line)
    }
    lines.push('')
  }
  return lines.join('\n')
}
