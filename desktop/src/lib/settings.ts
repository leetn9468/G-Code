import { guardHost, type NetworkGuardSettings } from '../../../src/shared/networkGuard'
import { normalizeBudget, type BudgetSettings } from '../../../src/shared/sessionBudget'
import { EFFORTS, type Effort } from '../../../src/shared/sessionControls'
// Client-side settings schema + persistence hook.
//
// Persists to ~/.gcode/settings.json via Tauri IPC (see src-tauri/src/settings.rs).
// Schema shape follows handover §11.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderName } from './providers'
import { PROVIDERS, PROVIDER_DEFAULT_MODEL } from './providers'
import { isTauri, loadSettings, saveSettings } from './tauri'
import type { ExecutionEnvironment } from './environments'
import { normalizeProjects, type Project } from './projects'
import { SIDEBAR_DEFAULT, sidebarWidth } from './sidebar'
import { normalizeTheme, type ThemePreference } from './theme'

/** When G-Code holds off system sleep: while a reply or background task runs, the whole time it is open, or never. */
export type KeepAwake = 'working' | 'always' | 'off'
export const KEEP_AWAKE_OPTIONS: readonly KeepAwake[] = ['working', 'always', 'off']

/** Context budget bounds (tokens). Unset means the model's full window. The engine reads execution.contextBudget each turn. */
export const CONTEXT_BUDGET_MIN = 100_000
export const CONTEXT_BUDGET_MAX = 2_000_000
export const CONTEXT_BUDGET_PRESETS: readonly number[] = [100_000, 200_000, 400_000]
/** An integer from CONTEXT_BUDGET_MIN to CONTEXT_BUDGET_MAX, else undefined (Auto). */
export function validContextBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= CONTEXT_BUDGET_MIN && value <= CONTEXT_BUDGET_MAX ? value : undefined
}

export const LOCAL_CONTEXT_DEFAULT = 262_144
export const LOCAL_CONTEXT_PRESETS = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576] as const
export function validLocalContext(value: unknown): number { return typeof value === 'number' && (LOCAL_CONTEXT_PRESETS as readonly number[]).includes(value) ? value : LOCAL_CONTEXT_DEFAULT }
export function migratedContextBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 50_000 && value < CONTEXT_BUDGET_MIN ? CONTEXT_BUDGET_MIN : validContextBudget(value)
}
export function contextBudgetMigrationNote(raw: unknown): string | undefined {
  const value = (raw as { execution?: { contextBudget?: unknown } } | null)?.execution?.contextBudget
  return migratedContextBudget(value) === CONTEXT_BUDGET_MIN && value !== CONTEXT_BUDGET_MIN
    ? 'Saved context budget raised to 100,000 tokens to leave room for the system prompt and reply reserve.' : undefined
}

export interface GCodeSettings {
  workspace: { workingDirectory?: string; projects: Project[] }
  effort: Effort
  execution: { environment: ExecutionEnvironment; keepAwake: KeepAwake; contextBudget?: number; sessionBudget?: BudgetSettings; networkGuard?: NetworkGuardSettings }
  provider: {
    currentProvider: ProviderName
    ollamaHost?: string
    localModelPath?: string
    localRuntimePath?: string
    localContext?: number
    perProviderModel: Partial<Record<ProviderName, string>>
    apiKeys: Partial<Record<Exclude<ProviderName, 'ollama' | 'local'>, string>>
  }
  ui: {
    sidebarWidth?: number
  }
  appearance: { chatFontSize: 15 | 16 | 17 | 18; theme: ThemePreference }
}

export const DEFAULT_SETTINGS: GCodeSettings = {
  effort: 'medium',
  workspace: { projects: [] },
  execution: { environment: 'local', keepAwake: 'working' },
  provider: {
    currentProvider: 'anthropic',
    localContext: LOCAL_CONTEXT_DEFAULT,
    perProviderModel: {},
    apiKeys: {},
  },
  ui: {
    sidebarWidth: SIDEBAR_DEFAULT,
  },
  appearance: { chatFontSize: 16, theme: 'dark' },
}

export function mergeWithDefaults(raw: unknown): GCodeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const r = raw as Partial<GCodeSettings>
  const candidateProvider = r.provider?.currentProvider
  const currentProvider = candidateProvider && PROVIDERS.includes(candidateProvider)
    ? candidateProvider
    : DEFAULT_SETTINGS.provider.currentProvider
  const candidateFontSize = r.appearance?.chatFontSize
  const chatFontSize = candidateFontSize && [15, 16, 17, 18].includes(candidateFontSize)
    ? candidateFontSize
    : DEFAULT_SETTINGS.appearance.chatFontSize
  const perProviderModel: GCodeSettings['provider']['perProviderModel'] = {}
  const apiKeys: GCodeSettings['provider']['apiKeys'] = {}
  for (const provider of PROVIDERS) {
    const model = r.provider?.perProviderModel?.[provider]
    if (typeof model === 'string' && model.trim()) perProviderModel[provider] = model.trim()
    if (provider !== 'ollama' && provider !== 'local') {
      const key = r.provider?.apiKeys?.[provider]
      if (typeof key === 'string') apiKeys[provider] = key.trim()
    }
  }
  return {
    effort: EFFORTS.includes(r.effort as Effort) ? r.effort! : 'medium',
    workspace: {
      projects: normalizeProjects(r.workspace?.projects, r.workspace?.workingDirectory),
      workingDirectory: typeof r.workspace?.workingDirectory === 'string' && r.workspace.workingDirectory.trim() ? r.workspace.workingDirectory : undefined,
    },
    execution: {
      environment: r.execution?.environment === 'cloud' ? 'cloud' : 'local',
      keepAwake: KEEP_AWAKE_OPTIONS.includes(r.execution?.keepAwake as KeepAwake) ? r.execution!.keepAwake : 'working',
      contextBudget: migratedContextBudget(r.execution?.contextBudget),
      networkGuard: { enabled: r.execution?.networkGuard?.enabled === true, allowlist: Array.isArray(r.execution?.networkGuard?.allowlist) ? r.execution.networkGuard.allowlist.map(guardHost).filter((h): h is string => !!h) : [] },
      ...(r.execution?.sessionBudget ? { sessionBudget: normalizeBudget(r.execution.sessionBudget) } : {}),
    },
    provider: {
      currentProvider,
      ollamaHost: typeof r.provider?.ollamaHost === 'string' ? r.provider.ollamaHost.trim() || undefined : undefined,
      localModelPath: typeof r.provider?.localModelPath === 'string' ? r.provider.localModelPath.trim() || undefined : undefined,
      localRuntimePath: typeof r.provider?.localRuntimePath === 'string' ? r.provider.localRuntimePath.trim() || undefined : undefined,
      localContext: validLocalContext(r.provider?.localContext),
      perProviderModel,
      apiKeys,
    },
    ui: {
      sidebarWidth: sidebarWidth(r.ui?.sidebarWidth),
    },
    appearance: {
      chatFontSize,
      theme: normalizeTheme(r.appearance?.theme),
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function overlay(base: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = isRecord(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete result[key]
    else if (isRecord(value)) result[key] = overlay(result[key], value)
    else result[key] = value
  }
  return result
}

/** Deep equality for JSON-like values; a missing key equals undefined. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]))
  if (!isRecord(a) || !isRecord(b)) return false
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => same(a[key], b[key]))
}

/** The fields of `next` that differ from `previous`, as an overlay: changed leaves, undefined where one was removed. Arrays count as one value. */
function changedFields(previous: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const before = isRecord(previous) ? previous : {}
  const changes: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const was = before[key], now = next[key]
    if (same(was, now)) continue
    changes[key] = isRecord(was) && isRecord(now) ? changedFields(was, now) : now
  }
  return changes
}

/**
 * The settings.json to write: the desktop's changes laid over what the file
 * holds now. With `previous` (the settings as the app last loaded or saved
 * them), only the fields that differ from it are written, and everything else
 * stays exactly as it is on disk: the app loads the file once, so a value
 * edited there while it is open (execution.contextBudget, provider.ollamaHost…)
 * survives an unrelated save. Without `previous`, all of `next` is laid over.
 * Fields the desktop does not manage always survive (the CLI reads `workflows`
 * and `provider.apiKeys` from the same file, and newer versions may add more).
 * A field changed to undefined is removed; arrays are replaced whole. The
 * legacy execution.maxIterations is dropped: the main conversation has no step
 * limit any more.
 */
export function settingsForDisk(onDisk: unknown, next: GCodeSettings, previous?: GCodeSettings): Record<string, unknown> {
  const own = next as unknown as Record<string, unknown>
  const merged = overlay(onDisk, previous ? changedFields(previous, own) : own)
  if (isRecord(merged.execution) && 'maxIterations' in merged.execution) {
    const { maxIterations: _legacy, ...execution } = merged.execution
    merged.execution = execution
  }
  // An old session-list filter nothing reads any more.
  if (isRecord(merged.ui) && 'sessionListFilter' in merged.ui) {
    const { sessionListFilter: _legacy, ...ui } = merged.ui
    merged.ui = ui
  }
  if (isRecord(merged.execution)) {
    const clamped = migratedContextBudget(merged.execution.contextBudget)
    if (clamped !== undefined && clamped !== merged.execution.contextBudget) merged.execution = { ...merged.execution, contextBudget: clamped }
  }
  return merged
}

/** Edits to settings as an overlay: only the changed leaves, undefined where a field was cleared. Arrays count as one value. */
export type SettingsEdits = Record<string, unknown>
/** The fields of `next` that differ from `base`, as edits. */
export function settingsEdits(base: GCodeSettings, next: GCodeSettings): SettingsEdits {
  return changedFields(base, next as unknown as Record<string, unknown>)
}
/** Folds later edits into earlier ones. A cleared (undefined) field stays an edit. */
export function mergeEdits(earlier: SettingsEdits | null, later: SettingsEdits): SettingsEdits {
  const result: SettingsEdits = { ...(earlier ?? {}) }
  for (const [key, value] of Object.entries(later)) result[key] = isRecord(value) && isRecord(result[key]) ? mergeEdits(result[key] as SettingsEdits, value) : value
  return result
}
/** `settings` with the edited fields replaced (undefined clears one); every other field follows `settings`. */
export function withEdits(settings: GCodeSettings, edits: SettingsEdits): GCodeSettings {
  return overlay(settings, edits) as unknown as GCodeSettings
}

/** The fields the desktop hands to the session or that restart it: project folder, provider and model, Ollama host, local model, execution environment. */
function sessionFields(settings: GCodeSettings) {
  const { currentProvider, ollamaHost, localModelPath, localRuntimePath, localContext, perProviderModel } = settings.provider
  return { workingDirectory: settings.workspace.workingDirectory, environment: settings.execution.environment, currentProvider, ollamaHost, localModelPath, localRuntimePath, localContext, perProviderModel }
}

/**
 * `target` with the session fields (see sessionFields) taken from `source`. A
 * reload while a turn runs leaves those for a later one, so editing
 * settings.json cannot stop the turn.
 */
export function withSessionFields(target: GCodeSettings, source: GCodeSettings): GCodeSettings {
  const { workingDirectory, environment, ...provider } = sessionFields(source)
  return {
    ...target,
    workspace: { ...target.workspace, workingDirectory },
    execution: { ...target.execution, environment },
    provider: { ...target.provider, ...provider },
  }
}

/** settings.json is read again this long after the window's last focus event. */
export const SETTINGS_FOCUS_RELOAD_MS = 300
/** Calls `reload` SETTINGS_FOCUS_RELOAD_MS after the window gets focus, debounced: a burst of focus events reads the file once. */
export function useReloadOnFocus(reload: () => unknown, delayMs = SETTINGS_FOCUS_RELOAD_MS) {
  const latest = useRef(reload)
  latest.current = reload
  useEffect(() => {
    if (typeof window === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onFocus = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void latest.current() }, delayMs)
    }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus); if (timer !== undefined) clearTimeout(timer) }
  }, [delayMs])
}

export function getModelFor(settings: GCodeSettings, provider: ProviderName): string {
  if (provider === 'local') return settings.provider.localModelPath?.trim() ? 'local-gguf' : ''
  return settings.provider.perProviderModel[provider]?.trim() || PROVIDER_DEFAULT_MODEL[provider]
}

/**
 * useSettings — reads on mount, exposes an updater that writes back to disk
 * immediately and `reload()`, which reads the file again (App calls it when
 * the Settings dialog opens and when the window gets focus), so a value edited
 * in settings.json while the app is open shows and is compared against.
 * Falls back to DEFAULT_SETTINGS + in-memory-only if we're not running under
 * Tauri (pure Vite dev).
 */
export function useSettings() {
  const [settings, setSettings] = useState<GCodeSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const migrationShown = useRef(false)
  const [error, setError] = useState<string | null>(null)
  /** The last read failed: its error stands until a read succeeds. */
  const readFailed = useRef(false)
  const current = useRef(settings)
  const ready = useRef(false)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const revision = useRef(0)
  /** The settings as last loaded or saved: a save writes only what changed since. */
  const synced = useRef<GCodeSettings>(DEFAULT_SETTINGS)

  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const raw = isTauri() ? await loadSettings() : {}
        const next = isTauri() ? mergeWithDefaults(raw) : DEFAULT_SETTINGS
        const migration = contextBudgetMigrationNote(raw)
        if (migration && !migrationShown.current) { migrationShown.current = true; if (active) setNotice(migration) }
        if (migration && isTauri()) { const migrated = settingsForDisk(raw, next, next); await saveSettings(migrated) }
        if (active) { current.current = next; synced.current = next; setSettings(next) }
      } catch (failure) {
        // Showing defaults meanwhile; update() writes nothing until the file can be read again.
        readFailed.current = true
        if (active) setError(`Could not load settings: ${String(failure)}`)
      } finally {
        if (active) { ready.current = true; setLoaded(true) }
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const update = useCallback((patch: Partial<GCodeSettings> | ((prev: GCodeSettings) => GCodeSettings)): Promise<boolean> => {
    if (!ready.current) return Promise.resolve(false)
    const next = typeof patch === 'function' ? patch(current.current) : { ...current.current, ...patch }
    current.current = next
    setSettings(next)
    const change = ++revision.current
    // Preserve update order even if disk writes complete at different speeds.
    const write = writes.current.then(async () => {
      if (!isTauri()) return
      // Read the file again right before writing, and write only what changed
      // in the app since the last load or save, so edits made outside the app
      // (or by a newer CLI) survive: unknown fields and the desktop's own alike.
      // A read that fails stops the save (nothing here knows what the file holds), and the change
      // stays in the app: the next save or reload that can read the file carries it.
      const base = await loadSettings()
      const payload = settingsForDisk(base, next, synced.current)
      await saveSettings(payload)
      synced.current = next
    })
    writes.current = write.catch(() => {})
    return write.then(() => {
      if (change === revision.current) setError(null)
      return true
    }, (failure) => {
      if (change === revision.current) setError(`Could not save settings: ${String(failure)}`)
      return false
    })
  }, [])

  /**
   * Reads settings.json again and takes its values into the snapshot. Changes
   * the app has not written yet (a save that failed) stay. A file that is
   * missing changes nothing; one that cannot be read changes nothing and says so. With
   * `keepSession` (a turn is running), the fields that restart the session
   * keep their values in the app and in what a save compares against, so a
   * later save does not overwrite them in the file and a later reload takes
   * them. Resolves whether the file was taken.
   */
  const reload = useCallback(async ({ keepSession = false }: { keepSession?: boolean } = {}): Promise<boolean> => {
    if (!ready.current || !isTauri()) return false
    // Queued saves land first (they read the file themselves); a save started meanwhile wins.
    await writes.current
    const at = revision.current
    let raw: unknown
    try { raw = await loadSettings() }
    catch (failure) {
      readFailed.current = true
      if (mounted.current) setError(`Could not load settings: ${String(failure)}`)
      return false
    }
    if (readFailed.current) { readFailed.current = false; if (mounted.current) setError(null) }
    if (!mounted.current || at !== revision.current || !isRecord(raw) || Object.keys(raw).length === 0) return false
    const fromDisk = mergeWithDefaults(raw)
    const migration = contextBudgetMigrationNote(raw)
    if (migration && !migrationShown.current) { migrationShown.current = true; setNotice(migration) }
    if (migration) {
      const repair = writes.current.then(async () => {
        const latest = await loadSettings()
        if (!contextBudgetMigrationNote(latest)) { raw = latest; return }
        const normalized = mergeWithDefaults(latest)
        raw = settingsForDisk(latest, normalized, normalized)
        await saveSettings(raw as Record<string, unknown>)
      })
      writes.current = repair.catch(() => {})
      try { await repair } catch (failure) { setError(`Could not migrate context budget: ${String(failure)}`); return false }
      if (!mounted.current || at !== revision.current) return false
    }
    let next = mergeWithDefaults(settingsForDisk(raw, current.current, synced.current))
    let base = fromDisk
    if (keepSession) { next = withSessionFields(next, current.current); base = withSessionFields(fromDisk, synced.current) }
    // The file holds the app's own session fields, only normalized ('' read back as unset, trimmed): keep them as they are, so nothing restarts for nothing.
    else if (same(sessionFields(mergeWithDefaults(current.current)), sessionFields(next))) next = withSessionFields(next, current.current)
    synced.current = base
    if (!same(next, current.current)) { current.current = next; setSettings(next) }
    return true
  }, [])

  return { settings, update, reload, loaded, error, notice, dismissNotice: () => setNotice(null) }
}
