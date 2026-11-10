import { assertToolFile } from './scopedPermission.js'
import { readdirSync, statSync, lstatSync, realpathSync, readFileSync, mkdirSync, rmSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { getProjectDirectory } from '../state/store.js'
import { createHash, randomUUID } from 'node:crypto'
import { KEPT_VERSIONS, type OutputBaseline, type SessionOutput, type SnapshotNotKept } from '../shared/sessionControls.js'
import { isProjectPath } from './scopedPermission.js'
import { holdsKnownKey } from '../security/secretValues.js'

const SNAPSHOT_LIMIT = 64 * 1024 * 1024

const ignoredFolders = new Set<string>()
const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const lexists = (path: string) => { try { lstatSync(path); return true } catch { return false } }

/**
 * Marks a folder G-Code generates inside a project (session snapshots, session memory, tool output,
 * handoffs) as ignored: a `.gitignore` holding `*`, written once if the folder has none. Git then
 * never stages the folder, and ripgrep in a git repository skips it. The project's own .gitignore
 * is never touched.
 *
 * `cwd` is the project; by default the folder above the `.gcode` that holds `directory`. Nothing
 * is created or written unless the folder's real path is inside the project's real path, and a
 * folder that is a symlink is never followed (even to somewhere inside the project): a `.gcode`
 * or `.gcode/<folder>` that leads elsewhere gets no ignore file there.
 */
export function ignoreGeneratedFolder(directory: string, cwd = projectOf(directory)): void {
  const file = join(directory, '.gitignore')
  if (!cwd || (ignoredFolders.has(directory) && lexists(file))) return
  try {
    if (isLink(directory) || !isProjectPath(directory, cwd)) return
    mkdirSync(directory, { recursive: true })
    // Checked again on what now exists: the folder itself, then its real path.
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return
    const real = realpathSync(directory)
    if (!isProjectPath(real, cwd)) return
    // 'wx' never follows or replaces an existing entry (a symlink included).
    if (!lexists(join(real, '.gitignore'))) writeFileSync(join(real, '.gitignore'), '*\n', { flag: 'wx' })
    ignoredFolders.add(directory)
  } catch { /* An unwritable folder only loses the ignore rule. */ }
}

/** The project a generated folder `<project>/.gcode/<name>` belongs to; undefined for any other folder. */
function projectOf(directory: string): string | undefined {
  const gcode = dirname(directory)
  return basename(gcode) === '.gcode' ? dirname(gcode) : undefined
}

/** Generated folder names, including legacy project copies; never committable settings, skills or hooks. */
export const GENERATED_FOLDERS = ['outputs', 'session-memory', 'tool-output', 'transfers', 'verification', 'browser-mcp', 'handoffs', 'todos', 'learned'] as const
export type GeneratedFolder = typeof GENERATED_FOLDERS[number]
/** Gives each generated folder that exists under `cwd`/.gcode its ignore file (see ignoreGeneratedFolder); creates none. */
export function ignoreGeneratedFolders(cwd: string): void {
  for (const name of GENERATED_FOLDERS) {
    const directory = join(cwd, '.gcode', name)
    if (lexists(directory) && !isLink(directory)) ignoreGeneratedFolder(directory, cwd)
  }
}

/** These internal records must not appear in project searches or git changes. */
const PERSONAL_FOLDERS = new Set<GeneratedFolder>(['outputs', 'session-memory', 'tool-output', 'learned'])
export function generatedDataPath(cwd: string, name: GeneratedFolder): string {
  return PERSONAL_FOLDERS.has(name) ? join(getProjectDirectory(cwd), name) : join(cwd, '.gcode', name)
}

/** Build one component at a time so a planted link receives no generated files. */
function personalFolder(cwd: string, name: GeneratedFolder): string {
  let directory = realpathSync(homedir())
  for (const part of ['.gcode', 'projects', basename(getProjectDirectory(cwd)), name]) {
    directory = join(directory, part)
    if (!lexists(directory)) mkdirSync(directory, { mode: 0o700 })
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) throw new Error('Generated data folder must be a real directory inside the personal project store')
  }
  return directory
}

/** Create internal data in the personal project store; keep user-facing project folders ignored and contained. */
export function generatedFolder(cwd: string, name: GeneratedFolder): string {
  if (PERSONAL_FOLDERS.has(name)) return personalFolder(cwd, name)
  const directory = join(cwd, '.gcode', name)
  const escapes = () => new Error(`.gcode/${name} leads outside the project (through a symbolic link), so G-Code does not write there. Remove the link, or point it to a folder inside the project.`)
  realpathSync(cwd) // A project folder that is gone throws its own error, not the one above.
  // Checked on the nearest existing folder first, so a link out of the project gets no folder created through it.
  if (!isProjectPath(directory, cwd)) throw escapes()
  ignoreGeneratedFolder(directory, cwd)
  mkdirSync(directory, { recursive: true })
  // And on what now exists, in case a link appeared in between.
  if (!isProjectPath(realpathSync(directory), cwd)) throw escapes()
  return directory
}

/**
 * A snapshot's file extension, from its bytes alone (the same bytes always get the same name): PNG
 * and JPEG keep theirs, which the desktop preview shows as images; anything else is `.snap`, so
 * tools that pick files by extension (linters, test runners, a project's own scripts) skip the copies.
 */
function snapshotSuffix(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg'
  return '.snap'
}

/** A session's snapshot folder is named by a hash of its id. */
const sessionFolderName = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex')

/**
 * Writes bytes once into the session's content-addressed snapshot folder. The one way bytes get
 * there, so this is where a file holding a known key is left out: no copy of the key goes into the
 * store, on any path (file tools, MCP edits, commands, baselines). The result then says so.
 */
function storeSnapshot(cwd: string, sessionId: string, bytes: Buffer): { sha256: string; snapshotPath: string } | { sha256: string; notKept: SnapshotNotKept } {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (holdsKnownKey(bytes)) return { sha256, notKept: 'holds-key' }
  const outputs = generatedFolder(cwd, 'outputs')
  const directory = join(outputs, sessionFolderName(sessionId))
  if (isLink(directory)) throw new Error('Snapshot folder is a symbolic link')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const snapshotPath = join(realpathSync(directory), sha256 + snapshotSuffix(bytes))
  if (!snapshotPath.startsWith(outputs + sep) || isLink(snapshotPath)) throw new Error('Snapshot file escapes the personal project store')
  // Whole or not at all: a write that fails (a full disk) must not leave a file under the content's hash.
  const write = () => {
    const temporary = `${snapshotPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o400 })
      renameSync(temporary, snapshotPath)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
      throw error
    }
  }
  if (!existsSync(snapshotPath)) write()
  else {
    const existing = readFileSync(snapshotPath)
    if (createHash('sha256').update(existing).digest('hex') !== sha256) {
      // The start of these very bytes is a write an older version did not finish, not evidence of anything.
      if (existing.length >= bytes.length || !bytes.subarray(0, existing.length).equals(existing)) throw new Error('Snapshot integrity mismatch; existing evidence was retained')
      write()
    }
  }
  // These bytes are in use again, whatever was dropped before.
  droppedSnapshots.get(sessionId)?.delete(snapshotPath)
  return { sha256, snapshotPath }
}

/** Per session, the snapshots of versions just dropped, until the record that no longer lists them is saved (see releaseDroppedSnapshots). */
const droppedSnapshots = new Map<string, Set<string>>()

/** Keeps a record's last KEPT_VERSIONS versions; the record says which went. Their bytes go later: the record is not saved yet. */
function keepLastVersions(record: SessionOutput, sessionId: string): void {
  const versions = record.versions ?? []
  const over = versions.length - KEPT_VERSIONS
  if (over <= 0) return
  const gone = versions.slice(0, over)
  record.versions = versions.slice(over)
  const earlier = record.droppedVersions
  record.droppedVersions = { count: (earlier?.count ?? 0) + over, oldestAt: earlier?.oldestAt ?? gone[0]!.createdAt, newestAt: gone.at(-1)!.createdAt }
  const paths = droppedSnapshots.get(sessionId) ?? new Set<string>()
  for (const version of gone) if (version.snapshotPath) paths.add(version.snapshotPath)
  droppedSnapshots.set(sessionId, paths)
}

const SNAPSHOT_FILE = /^[0-9a-f]{64}\.(?:snap|png|jpg)$/

/**
 * Removes the bytes of versions dropped from the session's records. Call once the records are saved:
 * a crash before this leaves files nothing lists (deleting the chat removes them), never a record
 * listing what is gone. Snapshots are content-addressed, so bytes another record of the session still
 * lists stay (the baseline, a later version with the same content, another file with the same
 * content), and so do those of a baseline `held` and not yet in a record. A session's snapshots are
 * only its own. A path from a saved record is not trusted: only a plain snapshot file in this
 * session's folder of the personal store is removed; a legacy copy in the project stays.
 */
export function releaseDroppedSnapshots(cwd: string, sessionId: string, outputs: readonly SessionOutput[] | undefined, held?: Map<string, OutputBaseline>): void {
  const dropped = droppedSnapshots.get(sessionId)
  if (!dropped?.size) return
  droppedSnapshots.delete(sessionId)
  const used = new Set<string>()
  for (const output of outputs ?? []) {
    if (output.baseline?.snapshotPath) used.add(output.baseline.snapshotPath)
    for (const version of output.versions ?? []) if (version.snapshotPath) used.add(version.snapshotPath)
  }
  for (const baseline of held?.values() ?? []) if (baseline.snapshotPath) used.add(baseline.snapshotPath)
  let folder: string
  try { folder = join(generatedFolder(cwd, 'outputs'), sessionFolderName(sessionId)) } catch { return }
  for (const path of dropped) {
    if (used.has(path) || dirname(path) !== folder || !SNAPSHOT_FILE.test(basename(path))) continue
    try { if (lstatSync(path).isFile()) rmSync(path) } catch { /* Gone already, or it stays until the chat is deleted. */ }
  }
}

/** The real path a file has, or will have once created (its nearest existing folder resolved). */
export function outputKey(path: string, cwd: string): string | undefined {
  const target = join(cwd, relative(cwd, path.startsWith('/') ? path : join(cwd, path)))
  // FileWrite creates missing folders, so a new file's folders may not exist yet either.
  const missing: string[] = []
  for (let existing = target; ;) {
    try { return join(realpathSync(existing), ...missing) } catch { /* Not created yet. */ }
    const parent = dirname(existing)
    if (parent === existing) return undefined
    missing.unshift(basename(existing))
    existing = parent
  }
}

/** Baselines whose bytes are still only in memory (see captureBaseline), with where they go once saved. */
const unsaved = new WeakMap<OutputBaseline, { cwd: string; sessionId: string; bytes: Buffer }>()

/**
 * The file before a tool first changes it in this session, for the Changes view. Taken before the
 * tool runs, and kept in memory: the snapshot is written only once an output record uses it (see
 * savedBaseline), so a call that fails or is refused leaves no copy behind.
 */
export function captureBaseline(path: string, cwd: string, sessionId: string): [string, OutputBaseline] | undefined {
  if (!isProjectPath(path, cwd)) return
  const key = outputKey(path, cwd)
  if (!key) return
  const createdAt = Date.now()
  if (!existsSync(key)) return [key, { absent: true, bytes: 0, createdAt }]
  try {
    const stat = statSync(key)
    if (!stat.isFile() || stat.size > SNAPSHOT_LIMIT) return
    assertToolFile(key); const bytes = readFileSync(key)
    const baseline: OutputBaseline = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, createdAt }
    unsaved.set(baseline, { cwd, sessionId, bytes })
    return [key, baseline]
  } catch { /* No baseline; the Changes view falls back to the first version. */ }
}

/** `baseline` with its snapshot written (see captureBaseline); undefined when that fails. */
function savedBaseline(baseline: OutputBaseline): OutputBaseline | undefined {
  const pending = unsaved.get(baseline)
  if (!pending) return baseline
  try { return { ...storeSnapshot(pending.cwd, pending.sessionId, pending.bytes), bytes: pending.bytes.length, createdAt: baseline.createdAt } }
  catch { return undefined }
}

/** The baseline `baselines` holds for `key`, saved (and kept saved there). */
function takeBaseline(baselines: Map<string, OutputBaseline> | undefined, key: string): OutputBaseline | undefined {
  const held = baselines?.get(key)
  if (!held) return
  const saved = savedBaseline(held)
  // Not saved (a full disk): it stays in memory, so a later record can still save it.
  if (saved && saved !== held) baselines!.set(key, saved)
  return saved
}

/**
 * Whether the file `key` still is what `baseline` holds, so that a call that failed changed nothing.
 * False when it cannot tell (a file that cannot be read now): the baseline is then kept.
 */
export function baselineStillCurrent(key: string, baseline: OutputBaseline | undefined): boolean {
  if (!baseline) return true
  if (baseline.absent) return !lexists(key)
  try { assertToolFile(key); return createHash('sha256').update(readFileSync(key)).digest('hex') === baseline.sha256 }
  catch { return false }
}

/**
 * The output record for `path` after `tool` wrote it. `writer` names the engine that wrote it (a
 * session's sub-agents and workflow agents record into the session under their own), so commands of
 * other sessions and sibling agents running meanwhile can tell the write apart (see commandOutputs).
 */
export function outputRecord(path: string, cwd: string, tool: string, sessionId?: string, previous?: SessionOutput, baselines?: Map<string, OutputBaseline>, writer?: string, claim?: boolean): SessionOutput | undefined {
  if (!isProjectPath(path, cwd)) return
  try {
    const full = realpathSync(join(cwd, relative(cwd, path.startsWith('/') ? path : join(cwd, path))))
    const stat = statSync(full)
    if (!stat.isFile()) return
    const baseline = previous?.baseline ?? takeBaseline(baselines, full)
    const record: SessionOutput = { path: full, tool, bytes: stat.size, updatedAt: Date.now(), versions: previous?.versions ?? [], ...(baseline ? { baseline } : {}), ...(previous?.droppedVersions ? { droppedVersions: previous.droppedVersions } : {}) }
    if (!sessionId) return record
    journalWrite(cwd, sessionId, full, fingerprint(stat), writer, claim)
    try {
      if (stat.size > SNAPSHOT_LIMIT) throw new Error('Snapshot not saved: file exceeds 64 MiB. Current file remains available.')
      assertToolFile(full); const bytes = readFileSync(full)
      if (bytes.length > SNAPSHOT_LIMIT) throw new Error('Snapshot not saved: file grew beyond 64 MiB.')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (previous?.versions?.at(-1)?.sha256 === sha256 && !previous.snapshotError) {
        // Unchanged since the last version; a file that was deleted is back.
        if (!previous.deleted) return { ...previous, tool }
        const { deleted: _deleted, ...restored } = previous
        return { ...restored, tool, bytes: bytes.length, updatedAt: record.updatedAt }
      }
      record.versions = [...record.versions!, { id: randomUUID(), ...storeSnapshot(cwd, sessionId, bytes), bytes: bytes.length, createdAt: record.updatedAt }]
      keepLastVersions(record, sessionId)
    } catch (error) { record.snapshotError = String(error) }
    return record
  } catch { /* Missing output is not a completed artifact. */ }
}

/** projectSnapshot lists at most this many files; a smaller listing is complete. */
export const SNAPSHOT_FILES = 4000
/** Folders never listed: version control, dependencies, G-Code's own folder, and tool caches nobody writes by hand. */
const SKIPPED = new Set(['.git', 'node_modules', '.gcode', 'target', '.venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.gradle', '.dart_tool', '.angular', '.expo'])
/** When each listing was started, for the writes other sessions made while a command ran (see commandOutputs). */
const listedAt = new WeakMap<Map<string, string>, number>()

/** A .gitignore pattern as a regular expression on a path relative to the folder of the .gitignore. */
function globRegex(pattern: string): RegExp | undefined {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] !== '*') { source += '[^/]*'; continue }
      // '**/' is any folders (none included); a trailing or inner '**' is anything.
      if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2 } else { source += '.*'; index++ }
    } else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 2)
      if (end < 0) { source += '\\['; continue }
      source += `[${pattern.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      index = end
    } else if (char === '\\' && index + 1 < pattern.length) source += pattern[++index]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  try { return new RegExp(`^${source}$`) } catch { return undefined }
}

/**
 * Whether the project's own .gitignore (at its root) leaves a folder out, by its path relative to
 * the project (with '/') and its name. Git's rules for a folder: a pattern without a slash (other
 * than a trailing one) matches the name at any depth, one with a slash matches the path; the last
 * matching pattern wins, so a '!' pattern can keep a folder in. Files inside an ignored folder
 * cannot be re-included, so the whole folder is left out. Build output (dist/, build/) is usually
 * listed there: it is not the project's source, and recording it would bury the real changes.
 */
function gitignoredFolders(cwd: string): ((path: string, name: string) => boolean) | undefined {
  let text: string
  try { assertToolFile(join(cwd, '.gitignore')); text = readFileSync(join(cwd, '.gitignore'), 'utf8') } catch { return undefined }
  const rules: Array<{ regex: RegExp; anchored: boolean; negated: boolean }> = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    line = line.replace(/\/+$/, '')
    const anchored = line.includes('/')
    line = line.replace(/^\//, '')
    const regex = line ? globRegex(line) : undefined
    if (regex) rules.push({ regex, anchored, negated })
  }
  if (!rules.length) return undefined
  return (path, name) => {
    let ignored = false
    for (const rule of rules) if (rule.regex.test(rule.anchored ? path : name)) ignored = !rule.negated
    return ignored
  }
}

/**
 * The project's files (path → size:mtime:ctime), skipping symlinks, dependency folders, caches,
 * G-Code's own folder and the folders the project's .gitignore leaves out (build output). The
 * session's `outputs` are listed wherever they are, so a command that deletes or rewrites one
 * (a script FileWrite saved under .gcode/) changes the session's Changes too.
 */
export function projectSnapshot(cwd: string, outputs: readonly SessionOutput[] = []): Map<string, string> {
  const result = new Map<string, string>()
  listedAt.set(result, Date.now())
  const ignored = gitignoredFolders(cwd)
  const walk = (directory: string, depth: number, prefix: string) => {
    if (depth > 8 || result.size >= SNAPSHOT_FILES) return
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (result.size >= SNAPSHOT_FILES) return
        if (entry.isSymbolicLink() || SKIPPED.has(entry.name) || entry.name.startsWith('.gcode-write-')) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          const shown = prefix + entry.name
          if (!ignored?.(shown, entry.name)) walk(path, depth + 1, `${shown}/`)
        } else if (entry.isFile()) {
          // A file that went away since readdir is one entry: the rest of the folder must still be listed, or it reads as created next time.
          try { result.set(path, fingerprint(statSync(path))) } catch { /* Gone: not listed. */ }
        }
      }
    } catch { /* Inaccessible directories are not attributed. */ }
  }
  walk(cwd, 0, '')
  let root = cwd
  if (outputs.length) try { root = realpathSync(cwd) } catch { /* Keep as given. */ }
  for (const output of outputs) {
    if (result.size >= SNAPSHOT_FILES) break
    if (output.deleted) continue
    // Outputs are kept by real path; the walk lists paths under cwd as given.
    const shown = relative(root, output.path)
    if (!shown || shown.startsWith('..') || shown.startsWith(sep)) continue
    const path = join(cwd, shown)
    if (result.has(path)) continue
    try { const stat = lstatSync(path); if (stat.isFile()) result.set(path, fingerprint(stat)) } catch { /* Gone already. */ }
  }
  return result
}
const fingerprint = (stat: { size: number; mtimeMs: number; ctimeMs: number }) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

// ---------------------------------------------------------------------------
// Writes, shared by the sessions of a project. A command's changes are what its
// listings before and after differ in, and another session's (or a sibling
// agent's) FileEdit, FileWrite or command while it runs differs too: the journal
// tells them apart.
// ---------------------------------------------------------------------------

const JOURNAL = 'writes.jsonl'
/** The journal is cut back to its recent lines past this size. */
const JOURNAL_LIMIT = 256 * 1024
const JOURNAL_AGE_MS = 30 * 60_000

/**
 * `fingerprint` is DELETED for a file a command removed; `writer`: the engine that wrote it (see
 * outputRecord); `claim`: known only from a command's listings, where another command running then
 * could have made the change. `phase`, with the command's id and process: a command began or ended
 * (path and fingerprint are empty).
 */
interface JournalEntry { session: string; writer?: string; path: string; fingerprint: string; at: number; claim?: boolean; command?: string; phase?: 'start' | 'end'; pid?: number }
const DELETED = 'deleted'

function readJournal(file: string): JournalEntry[] {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as JournalEntry
      if (typeof entry.session === 'string' && typeof entry.path === 'string' && typeof entry.fingerprint === 'string' && Number.isFinite(entry.at)) entries.push(entry)
    } catch { /* A line cut short by a crash. */ }
  }
  return entries
}

/** Records that a tool of `sessionId` (by `writer`) left `path` (its real path) with `seen` (a fingerprint, or DELETED). Best effort. */
function journalWrite(cwd: string, sessionId: string, path: string, seen: string, writer?: string, claim?: boolean): void {
  journalLine(cwd, { session: sessionId, ...(writer ? { writer } : {}), path, fingerprint: seen, at: Date.now(), ...(claim ? { claim } : {}) })
}

function journalLine(cwd: string, entry: JournalEntry): void {
  try {
    const directory = generatedFolder(cwd, 'outputs')
    const file = join(directory, JOURNAL)
    if (isLink(file)) return
    // One short line per write: appends from several processes do not interleave.
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    if (statSync(file).size > JOURNAL_LIMIT) {
      const recent = readJournal(file).filter(entry => entry.at > Date.now() - JOURNAL_AGE_MS).map(entry => `${JSON.stringify(entry)}\n`)
      // The newest lines up to half the limit stay: a command that changed many files must not
      // rewrite the whole journal on each of its appends.
      let from = recent.length
      for (let size = 0; from > 0 && size + recent[from - 1]!.length <= JOURNAL_LIMIT / 2;) size += recent[--from]!.length
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, recent.slice(from).join(''), { mode: 0o600 })
        renameSync(temporary, file)
      } catch (error) {
        try { rmSync(temporary, { force: true }) } catch { /* Nothing written, or the folder cannot be changed. */ }
        throw error
      }
    }
  } catch { /* Without the entry, a concurrent command may be credited with this write, as before. */ }
}

const journalEntries = (cwd: string) => [...readJournal(join(cwd, '.gcode', 'outputs', JOURNAL)), ...readJournal(join(generatedDataPath(cwd, 'outputs'), JOURNAL))]

/**
 * The real paths that other sessions, and other writers of this one, wrote since `since`, with the
 * fingerprints they left. An entry of this session with no writer (or the same one) is this one's own.
 * `contested`: this command's window is known, and a claim by another session's command that ended
 * within it says nothing about who made the change: both commands saw it, either may have made it.
 */
function foreignWrites(entries: readonly JournalEntry[], sessionId: string, since: number, writer: string | undefined, contested: boolean): Map<string, Set<string>> {
  const writes = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.phase || (entry.session === sessionId && (!entry.writer || entry.writer === writer)) || entry.at < since) continue
    if (contested && entry.claim && entry.session !== sessionId) continue
    const seen = writes.get(entry.path) ?? new Set<string>()
    seen.add(entry.fingerprint)
    writes.set(entry.path, seen)
  }
  return writes
}

/** A command is recorded as running for at most this long: a call that never reported its end (a process stopped mid-call) must not count for ever. */
const COMMAND_OPEN_MS = JOURNAL_AGE_MS
/** File times and the clock differ by up to this (a file system with whole seconds). */
const CLOCK_SLACK_MS = 1000
/** Listings of a command with its id in the journal (see commandListing). */
const commandIds = new WeakMap<Map<string, string>, string>()

/** projectSnapshot for a command about to run, with the journal knowing it runs from before the listing on. */
export function commandListing(cwd: string, sessionId: string, outputs: readonly SessionOutput[] | undefined, writer?: string): Map<string, string> {
  const command = randomUUID()
  journalLine(cwd, { session: sessionId, ...(writer ? { writer } : {}), path: '', fingerprint: '', at: Date.now(), command, phase: 'start', pid: process.pid })
  const listing = projectSnapshot(cwd, outputs)
  commandIds.set(listing, command)
  return listing
}

/** The windows of other sessions' commands that overlap one that began at `since`, up to now. */
function otherCommands(entries: readonly JournalEntry[], sessionId: string, since: number, now: number): Array<{ from: number; to: number }> {
  const ended = new Map<string, number>()
  for (const entry of entries) if (entry.phase === 'end' && entry.command) ended.set(entry.command, entry.at)
  const windows: Array<{ from: number; to: number }> = []
  for (const entry of entries) {
    if (entry.phase !== 'start' || !entry.command || entry.session === sessionId) continue
    const end = ended.get(entry.command)
    if (end !== undefined) { if (end >= since) windows.push({ from: entry.at, to: end }); continue }
    if (now - entry.at > COMMAND_OPEN_MS) continue
    try { process.kill(entry.pid ?? 0, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue }
    windows.push({ from: entry.at, to: now })
  }
  return windows
}

// ---------------------------------------------------------------------------
// Bytes from before a command. A shell command can change or delete any file, and
// once it has run the earlier bytes are gone. So before each command the project's
// small text files are kept in memory (the first command reads them all, later
// ones only the files whose fingerprint changed since), and a file the command
// changes or deletes gets those bytes as its baseline. Only the bytes that become
// a baseline are written to the session's snapshot folder.
// ---------------------------------------------------------------------------

/** Files larger than this get no remembered bytes (no baseline when a command changes them). */
export const REMEMBER_FILE_LIMIT = 1024 * 1024
/** At most this many bytes are remembered per project. */
export const REMEMBER_TOTAL_LIMIT = 20 * 1024 * 1024
/** Projects remembered at once (the least recently used is dropped). */
const REMEMBERED_PROJECTS = 2

interface ProjectContent {
  /** Path as listed → the bytes the file had at that fingerprint. */
  files: Map<string, { fingerprint: string; bytes: Buffer }>
  /** Files not kept (binary), by the fingerprint they had, so they are not read again until they change. */
  binary: Map<string, string>
  total: number
}
const remembered = new Map<string, ProjectContent>()

/** The paths of a listing of `cwd` in the form output records use (the project's real path). */
function realPaths(cwd: string): (path: string) => string {
  let root = cwd
  try { root = realpathSync(cwd) } catch { /* Keep the listed form. */ }
  // The listing never follows a symlink inside the project, so only `cwd` itself needs resolving.
  return path => path.startsWith(cwd + sep) ? root + path.slice(cwd.length) : path
}

export interface RememberStats { files: number; read: number; bytes: number; ms: number }

/**
 * Before a command that may change files: keeps the bytes of the project's small text files as they
 * are in `listing` (from projectSnapshot), at most 1 MiB per file and 20 MiB per project, binaries
 * left out. Only files whose fingerprint changed since the last call are read; files that already
 * have an output record are skipped (their baseline is known).
 */
export function rememberProjectContent(cwd: string, listing: Map<string, string>, known: readonly SessionOutput[] = []): RememberStats {
  const started = performance.now()
  let project = remembered.get(cwd)
  if (project) remembered.delete(cwd)
  else project = { files: new Map(), binary: new Map(), total: 0 }
  remembered.set(cwd, project)
  while (remembered.size > REMEMBERED_PROJECTS) remembered.delete(remembered.keys().next().value!)
  // Bytes for a fingerprint that no longer matches are stale.
  for (const [path, entry] of project.files) if (listing.get(path) !== entry.fingerprint) { project.files.delete(path); project.total -= entry.bytes.length }
  for (const [path, seen] of project.binary) if (listing.get(path) !== seen) project.binary.delete(path)
  const real = realPaths(cwd)
  const recorded = new Set(known.map(output => output.path))
  const pending: Array<[path: string, seen: string, size: number]> = []
  for (const [path, seen] of listing) {
    if (project.files.has(path) || project.binary.has(path) || recorded.has(real(path))) continue
    const size = Number(seen.slice(0, seen.indexOf(':')))
    if (size <= REMEMBER_FILE_LIMIT) pending.push([path, seen, size])
  }
  // Smallest first: when the budget runs out, the most files keep a baseline.
  pending.sort((a, b) => a[2] - b[2])
  let read = 0, bytes = 0
  for (const [path, seen, size] of pending) {
    if (project.total + size > REMEMBER_TOTAL_LIMIT) break
    try {
      assertToolFile(path); const content = readFileSync(path)
      read++; bytes += content.length
      // Changed while being read: these bytes belong to no listed fingerprint.
      if (fingerprint(statSync(path)) !== seen) continue
      if (content.subarray(0, 8000).includes(0)) { project.binary.set(path, seen); continue }
      if (project.total + content.length > REMEMBER_TOTAL_LIMIT) continue
      project.files.set(path, { fingerprint: seen, bytes: content })
      project.total += content.length
    } catch { /* Unreadable: no baseline for it. */ }
  }
  return { files: project.files.size, read, bytes, ms: performance.now() - started }
}

/** Forgets what rememberProjectContent kept (all projects, or one). */
export function forgetProjectContent(cwd?: string): void {
  if (cwd === undefined) remembered.clear()
  else remembered.delete(cwd)
}

/** The file's remembered bytes at `seen` (its fingerprint before the command), stored as a baseline snapshot. */
function rememberedBaseline(cwd: string, sessionId: string, path: string, seen: string | undefined): OutputBaseline | undefined {
  const entry = remembered.get(cwd)?.files.get(path)
  if (!entry || entry.fingerprint !== seen) return
  try { return { ...storeSnapshot(cwd, sessionId, entry.bytes), bytes: entry.bytes.length, createdAt: Date.now() } }
  catch { /* No baseline; the Changes view falls back to the last commit or the first version. */ }
}

/** A file a running command or MCP tool reports itself: its remembered bytes from the listing taken before that call started. */
export function listedBaseline(cwd: string, sessionId: string, path: string, listings: Iterable<Map<string, string>>): OutputBaseline | undefined {
  for (const listing of listings) if (listing.has(path)) return rememberedBaseline(cwd, sessionId, path, listing.get(path))
}

/**
 * Output records for what a command did to the project, from projectSnapshot listings taken before
 * and after it:
 * - a file that is new gets baseline `absent` (when the listing before was complete);
 * - a file that changed and has no record yet gets its remembered bytes from before as baseline;
 * - a file that is gone (deleted, or moved or renamed away) is recorded `deleted`, keeping its
 *   earlier baseline and versions; only when both listings are complete, so a capped listing never
 *   reads as a deletion.
 * New baselines are also added to `baselines`.
 *
 * A file that another session or another writer of this one (a sibling agent) wrote or deleted while
 * the command ran, and that is still as it left it, is that writer's change, not the command's (see
 * journalWrite); a file the command changed again afterwards is the command's. A file rewritten with
 * the same bytes (`sed -i` that matched nothing, `touch`) did not change. A listing from commandListing
 * also knows which commands of other sessions overlapped this one: what they changed cannot be told
 * apart, so it stays in both sessions' records, marked `shared`, and no session loses a file it wrote.
 */
export function commandOutputs(cwd: string, sessionId: string, tool: string, before: Map<string, string>, after: Map<string, string>, known: readonly SessionOutput[] = [], baselines = new Map<string, OutputBaseline>(), writer?: string): SessionOutput[] {
  const results: SessionOutput[] = []
  const previousFor = (key: string) => known.find(output => output.path === key)
  const since = listedAt.get(before)
  const command = commandIds.get(before)
  const now = Date.now()
  const entries = since === undefined ? [] : journalEntries(cwd)
  const foreign = since === undefined ? undefined : foreignWrites(entries, sessionId, since, writer, !!command)
  const others = since === undefined || !command ? [] : otherCommands(entries, sessionId, since, now)
  if (command) journalLine(cwd, { session: sessionId, ...(writer ? { writer } : {}), path: '', fingerprint: '', at: now, command, phase: 'end', pid: process.pid })
  /** A change made while another session's command ran cannot be told from that command's: `seen` holds when it was made. */
  const mayBeOthers = (seen?: string) => {
    const changed = seen === undefined ? NaN : Number(seen.slice(seen.lastIndexOf(':') + 1))
    return others.some(other => !Number.isFinite(changed) || (changed >= other.from - CLOCK_SLACK_MS && changed <= other.to + CLOCK_SLACK_MS))
  }
  for (const [path, seen] of after) {
    if (before.get(path) === seen) continue
    const key = outputKey(path, cwd)
    if (!key) continue
    if (foreign?.get(key)?.has(seen)) continue
    const previous = previousFor(key)
    if (sameBytes(cwd, path, before.get(path), previous)) continue
    if (!previous && !baselines.has(key)) {
      const baseline = !before.has(path)
        ? before.size < SNAPSHOT_FILES ? { absent: true, bytes: 0, createdAt: Date.now() } : undefined
        : rememberedBaseline(cwd, sessionId, path, before.get(path))
      if (baseline) baselines.set(key, baseline)
    }
    const record = outputRecord(path, cwd, tool, sessionId, previous, baselines, writer, !!command)
    if (record) results.push(mayBeOthers(seen) ? { ...record, shared: true } : record)
  }
  if (before.size >= SNAPSHOT_FILES || after.size >= SNAPSHOT_FILES) return results
  for (const [path, seen] of before) {
    if (after.has(path) || existsSync(path)) continue
    const key = outputKey(path, cwd)
    if (!key || !isProjectPath(key, cwd)) continue
    if (foreign?.get(key)?.has(DELETED)) continue
    const previous = previousFor(key)
    if (previous?.deleted) continue
    const baseline = previous ? previous.baseline : takeBaseline(baselines, key) ?? rememberedBaseline(cwd, sessionId, path, seen)
    if (baseline && !previous) baselines.set(key, baseline)
    journalWrite(cwd, sessionId, key, DELETED, writer, !!command)
    results.push({ path: key, tool, bytes: 0, updatedAt: Date.now(), versions: previous?.versions ?? [], ...(baseline ? { baseline } : {}), ...(previous?.droppedVersions ? { droppedVersions: previous.droppedVersions } : {}), deleted: true, ...(mayBeOthers() ? { shared: true } : {}) })
  }
  return results
}

/**
 * Whether a file a command rewrote still has the bytes it had: those of its last recorded version,
 * or (with no record yet) the bytes remembered from before the command at `seen`. False when that
 * is not known (binary or large files have no remembered bytes).
 */
function sameBytes(cwd: string, path: string, seen: string | undefined, previous: SessionOutput | undefined): boolean {
  const last = previous && !previous.deleted && !previous.snapshotError ? previous.versions?.at(-1)?.sha256 : undefined
  const kept = previous ? undefined : remembered.get(cwd)?.files.get(path)
  const earlier = kept && kept.fingerprint === seen ? kept.bytes : undefined
  if (!last && !earlier) return false
  try {
    if (statSync(path).size > SNAPSHOT_LIMIT) return false
    assertToolFile(path); const bytes = readFileSync(path)
    return last ? createHash('sha256').update(bytes).digest('hex') === last : bytes.equals(earlier!)
  } catch { return false }
}

/** Folders under `.gcode` that hold a new subfolder per run (BrowserVerify, the browser MCP server). */
const RUN_FOLDERS = ['verification', 'browser-mcp']
/**
 * Whether a file a tool reported (onArtifacts) can only have been created by it: BrowserPlan saves
 * create-only, BrowserVerify and the browser MCP server write into a new folder per run.
 */
export function createdArtifact(tool: string, path: string, cwd: string): boolean {
  if (tool === 'BrowserPlan' || tool === 'BrowserVerify') return true
  let root = cwd
  try { root = realpathSync(cwd) } catch { /* Keep as given. */ }
  return RUN_FOLDERS.some(folder => path.startsWith(join(root, '.gcode', folder) + sep))
}
