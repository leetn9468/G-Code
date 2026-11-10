import { NetworkGuardField } from './NetworkGuardField'
import { SessionBudgetField } from './SessionBudgetField'
import type { ProviderEnvStatus } from '@/lib/tauri'
// Settings modal. Handover §1 View 7.
// Layout: header · vertical tab rail (active pill glides on pointer clicks) ·
// content pane that cross-fades per tab and scrolls · footer (Cancel / Save).

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Boxes, ChevronDown, Eye, EyeOff, Info, Lock, Palette, Plug, X, type LucideIcon } from 'lucide-react'
import { PermissionsTab } from './PermissionsTab'
import { Modal } from '../shell/Modal'
import { GhostButton, PrimaryButton } from '../shell/Button'
import { Tooltip } from '../shell/Tooltip'
import { ProviderTile } from '../providers/ProviderTile'
import { LocalGGUFPicker } from '../providers/LocalGGUFPicker'
import { useLocalModelStatus } from '@/lib/localModel'
import { LocalModelPicker } from '../providers/LocalModelPicker'
import { DEFAULT_OLLAMA_HOST, useOllamaModels } from '@/lib/ollama'
import { flatProjection, springIndicator } from '@/lib/motion'
import type { GCodeSettings } from '@/lib/settings'
import { useAppearanceTheme } from '@/lib/theme'
import type { ProviderName } from '@/lib/providers'
import { PROVIDERS, PROVIDER_DISPLAY, PROVIDER_ENV_VAR } from '@/lib/providers'
import { getContextLimit } from '../../../../src/shared/contextWindows'
import { getModelFor } from '@/lib/settings'
import { McpManager } from '../mcp/McpManager'
import { CONTEXT_BUDGET_PRESETS, mergeEdits, settingsEdits, validContextBudget, withEdits, type KeepAwake, type SettingsEdits } from '@/lib/settings'

interface Props {
  budgetEnvironment?: ProviderEnvStatus | null
  open: boolean
  cwd?: string
  onClose: () => void
  settings: GCodeSettings
  /** Save receives a function: the dialog's edits laid over the newest settings. */
  onUpdate: (patch: Partial<GCodeSettings> | ((previous: GCodeSettings) => GCodeSettings)) => Promise<boolean>
  initialTab?: 'provider' | 'mcp'
  /** Opened from a keyboard shortcut: appear and close without animation. */
  instant?: boolean
}

type Tab = 'permissions' | 'provider' | 'mcp' | 'appearance'

// Available tabs first; the not-yet-available ones sit at the end of the rail
// behind a hairline (settings.css) so every visit starts on a usable item.
const TABS: Array<{ id: Tab; label: string; icon: LucideIcon; disabled?: boolean }> = [
  { id: 'provider', label: 'Provider', icon: Boxes },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'permissions', label: 'Permissions', icon: Lock },
]

const FONT_SIZES = [15, 16, 17, 18] as const

const selectChevron = <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="gc-select-chevron" />

/** 100000 → "100K tokens", 1500000 → "1.5M tokens". */
export function contextBudgetLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${parseFloat((tokens / 1_000_000).toFixed(2))}M tokens` : `${parseFloat((tokens / 1000).toFixed(1))}K tokens`
}
/** The select's value ("auto" or a token count) as the setting: undefined is Auto. */
export function contextBudgetChoice(value: string): number | undefined {
  return value === 'auto' ? undefined : validContextBudget(Number(value))
}

/** Auto, the presets, and a value set outside the app (settings.json) so the select can show it. */
export function ContextBudgetField({ value, modelWindow = 2_000_000, onChange }: { value?: number; modelWindow?: number; onChange: (value: number | undefined) => void }) {
  const candidate = validContextBudget(value)
  const budget = candidate !== undefined && candidate <= modelWindow ? candidate : undefined
  const options = budget !== undefined && !CONTEXT_BUDGET_PRESETS.includes(budget) ? [...CONTEXT_BUDGET_PRESETS, budget].sort((a, b) => a - b) : CONTEXT_BUDGET_PRESETS
  return <div className="gc-settings-section">
    <div className="gc-settings-section-head"><h3>Context budget</h3><p>When a turn reaches 85% of the budget, G-Code asks whether to continue in a new session. A smaller budget costs less per request.</p></div>
    <label>Budget
      <span className="gc-select-well"><select className="gc-input-well" value={budget ?? 'auto'} onChange={event => onChange(contextBudgetChoice(event.currentTarget.value))}>
        <option value="auto">Auto (the model’s full window)</option>
        {options.filter(tokens => tokens <= modelWindow).map(tokens => <option key={tokens} value={String(tokens)}>{contextBudgetLabel(tokens)}</option>)}
      </select>{selectChevron}</span>
    </label>
  </div>
}

/** Roving tab focus follows only the enabled tabs, wrapping at either end. */
export function settingsTabForKey(current: string, key: string): Tab | undefined {
  const tabs = TABS.filter(tab => !tab.disabled).map(tab => tab.id)
  const index = Math.max(0, tabs.indexOf(current as Tab))
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs.at(-1)
  if (key === 'ArrowDown' || key === 'ArrowRight') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowUp' || key === 'ArrowLeft') return tabs[(index + tabs.length - 1) % tabs.length]
}

/**
 * The dialog's unsaved edits, kept as the changed fields only: when `settings`
 * is refreshed from disk while the dialog is open, every field the user has
 * not edited shows the new value, the edited ones keep the user's, and Save
 * lays just the edited fields over the newest settings.
 */
export function useSettingsDraft(settings: GCodeSettings) {
  const [edits, setEdits] = useState<SettingsEdits | null>(null)
  const effective = edits ? withEdits(settings, edits) : settings
  /** `patch` holds whole sections built from `effective`; only the fields it changes become edits. */
  const edit = (patch: Partial<GCodeSettings>) => {
    const changes = settingsEdits(effective, { ...effective, ...patch })
    setEdits(current => mergeEdits(current, changes))
  }
  const reset = useCallback(() => setEdits(null), [])
  return { effective, edits, edit, reset }
}

export function Settings({ open, onClose, settings, onUpdate, cwd, initialTab = 'provider', instant = false, budgetEnvironment }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('provider')
  const { effective, edits: dirty, edit, reset } = useSettingsDraft(settings)
  useAppearanceTheme(effective.appearance.theme, open, () => settings.appearance.theme)
  const [saving, setSaving] = useState(false)
  // Presentation only: pointer clicks glide the tab pill and cross-fade the pane.
  const [pointerSwitch, setPointerSwitch] = useState(false)
  useEffect(() => { if (open) { setActiveTab(initialTab); reset() } }, [open, initialTab, reset])
  useEffect(() => { if (open) setPointerSwitch(false) }, [open])

  const commit = async () => {
    if (!dirty || saving) return
    setSaving(true)
    const saved = await onUpdate(previous => withEdits(previous, dirty))
    setSaving(false)
    if (saved) { reset(); onClose() }
  }
  const cancel = () => {
    reset()
    onClose()
  }

  return (
    <Modal open={open} onClose={cancel} labelledBy="settings-title" width={760} instant={instant}>
      <header className="gc-modal-header">
        <div className="gc-modal-heading"><h2 id="settings-title">Settings</h2></div>
        <Tooltip content="Close" shortcut="Esc" side="bottom">
          <button type="button" className="gc-btn-icon gc-modal-close" aria-label="Close" onClick={cancel}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      </header>

      <div className="gc-settings-body">
        {/* Vertical tab rail */}
        <nav role="tablist" aria-orientation="vertical" aria-labelledby="settings-title" className="gc-settings-tabs">
          {TABS.map((t) => {
            const selected = activeTab === t.id
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={selected ? 'settings-panel' : undefined}
                disabled={t.disabled}
                tabIndex={selected ? 0 : -1}
                onKeyDown={event => {
                  const next = settingsTabForKey(t.id, event.key)
                  if (!next) return
                  event.preventDefault()
                  setPointerSwitch(false)
                  setActiveTab(next)
                  event.currentTarget.closest('[role="tablist"]')?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus()
                }}
                className="gc-settings-tab"
                onClick={(event) => {
                  if (t.disabled) return
                  setPointerSwitch(event.detail > 0)
                  setActiveTab(t.id)
                }}
              >
                {selected && <motion.span layoutId="gc-settings-tab-pill" transformTemplate={flatProjection} className="gc-settings-tab-pill" transition={pointerSwitch ? springIndicator : { duration: 0 }} aria-hidden="true" />}
                <span className="gc-settings-tab-content">
                  <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span className="gc-settings-tab-label">{t.label}</span>
                  {t.disabled && <span className="gc-settings-tab-tag">Phase 3</span>}
                </span>
              </button>
            )
          })}
        </nav>

          <div
            key={activeTab}
            role="tabpanel"
            id="settings-panel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className={`gc-settings-panel${pointerSwitch ? ' is-switching' : ''}`}
          >
            {activeTab === 'provider' && (
              <><ProviderTab
                settings={effective}
                onUpdate={edit}
              /><NetworkGuardField settings={effective} onUpdate={edit}/><SessionBudgetField settings={effective} onUpdate={edit} environment={budgetEnvironment}/><div className="gc-settings-section">
                <div className="gc-settings-section-head"><h3>Keep this Mac awake</h3><p>Stops the Mac from sleeping so long tasks and dev servers keep running. The display can still turn off.</p></div>
                <label>Stay awake
                  <span className="gc-select-well"><select className="gc-input-well" value={effective.execution.keepAwake}
                    onChange={event => edit({ execution: { ...effective.execution, keepAwake: event.currentTarget.value as KeepAwake } })}>
                    <option value="working">While G-Code is working</option>
                    <option value="always">Whenever G-Code is open</option>
                    <option value="off">Never</option>
                  </select>{selectChevron}</span>
                </label>
              </div>{effective.provider.currentProvider !== 'local' && <ContextBudgetField modelWindow={getContextLimit(getModelFor(effective, effective.provider.currentProvider))} value={effective.execution.contextBudget}
                onChange={contextBudget => edit({ execution: { ...effective.execution, contextBudget } })}/>}</>
            )}
            {activeTab === 'permissions' && <PermissionsTab cwd={cwd} />}
            {activeTab === 'mcp' && (
              <McpManager cwd={cwd} />
            )}
            {activeTab === 'appearance' && (
              <AppearanceTab
                settings={effective}
                onUpdate={edit}
              />
            )}
          </div>
      </div>

      <footer className="gc-modal-footer">
        {/* The live region stays mounted so the hint is announced when it appears. */}
        <span className="gc-settings-status" role="status">
          {dirty && <span className="gc-settings-dirty"><i aria-hidden="true" />Unsaved changes</span>}
        </span>
        <div className="gc-settings-footer-actions">
          <GhostButton onClick={cancel}>
            Cancel
          </GhostButton>
          <PrimaryButton onClick={() => void commit()} disabled={!dirty || saving} loading={saving}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </footer>
    </Modal>
  )
}

function ProviderTab({
  settings,
  onUpdate,
}: {
  settings: GCodeSettings
  onUpdate: (p: Partial<GCodeSettings>) => void
}) {
  const [visibleKeys, setVisibleKeys] = useState<Partial<Record<ProviderName, boolean>>>({})
  const { status: ollama, checking, refresh } = useOllamaModels(true, settings.provider.ollamaHost)

  const local = useLocalModelStatus(true, settings.provider.localModelPath, settings.provider.localRuntimePath)

  const updateProvider = (provider: GCodeSettings['provider']) => onUpdate({ provider })

  return (
    <div className="gc-settings-section">
      <div className="gc-settings-section-head">
        <h3>Default provider</h3>
        <p>
          Choose which provider G-Code uses at startup. Each provider stores its last-used model separately.
        </p>
      </div>

      <div className="gc-settings-providers">
        {PROVIDERS.map((p) => {
          const model = settings.provider.perProviderModel[p] ?? getModelFor(settings, p)
          const isCurrent = settings.provider.currentProvider === p
          const apiKey = p === 'ollama' || p === 'local' ? '' : settings.provider.apiKeys[p] ?? ''
          return (
            <div key={p} className={`gc-settings-provider${isCurrent ? ' is-current' : ''}`}>
              <button
                type="button"
                className="gc-settings-provider-head"
                aria-pressed={isCurrent}
                onClick={() => updateProvider({ ...settings.provider, currentProvider: p })}
              >
                <ProviderTile provider={p} size={22} />
                <span className="gc-settings-provider-name">{PROVIDER_DISPLAY[p]}</span>
                <span aria-hidden="true" className="gc-settings-radio" />
              </button>
              <div className={`gc-settings-provider-fields${p === 'ollama' || p === 'local' ? ' is-single' : ''}`}>
                {p === 'local' ? <LocalGGUFPicker localContext={settings.provider.localContext} onLocalContextChange={(localContext) => updateProvider({ ...settings.provider, localContext })} modelPath={settings.provider.localModelPath} runtimePath={settings.provider.localRuntimePath} status={local.status} checking={local.checking} onModelPathChange={(localModelPath) => updateProvider({ ...settings.provider, localModelPath })} onRuntimePathChange={(localRuntimePath) => updateProvider({ ...settings.provider, localRuntimePath })} onRefresh={() => void local.refresh()} /> : p === 'ollama' ? (
                  <LocalModelPicker model={model} status={ollama} checking={checking} onChange={(value) => updateProvider({ ...settings.provider, perProviderModel: { ...settings.provider.perProviderModel, ollama: value } })} />
                ) : <input
                  className="gc-input-well"
                  aria-label={`${PROVIDER_DISPLAY[p]} model`}
                  spellCheck={false}
                  placeholder={model}
                  value={model}
                  onChange={(e) => updateProvider({
                    ...settings.provider,
                    perProviderModel: { ...settings.provider.perProviderModel, [p]: e.target.value },
                  })}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).blur() }}
                />}
                {p === 'local' ? null : p !== 'ollama' ? (
                  <div className="gc-settings-secret">
                    <input
                      className="gc-input-well"
                      type={visibleKeys[p] ? 'text' : 'password'}
                      aria-label={`${PROVIDER_DISPLAY[p]} API key`}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={`$${PROVIDER_ENV_VAR[p]}`}
                      value={apiKey}
                      onChange={(e) => updateProvider({
                        ...settings.provider,
                        apiKeys: { ...settings.provider.apiKeys, [p]: e.target.value },
                      })}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).blur() }}
                    />
                    <button
                      type="button"
                      className="gc-btn-icon gc-secret-toggle"
                      aria-label={visibleKeys[p] ? 'Hide API key' : 'Show API key'}
                      onClick={() => setVisibleKeys((current) => ({ ...current, [p]: !current[p] }))}
                    >
                      {visibleKeys[p] ? <EyeOff size={15} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={15} strokeWidth={1.75} aria-hidden="true" />}
                    </button>
                  </div>
                ) : (
                  <div className="gc-settings-host">
                    <input
                      className="gc-input-well"
                      aria-label="Ollama server URL"
                      spellCheck={false}
                      placeholder={ollama?.host ?? DEFAULT_OLLAMA_HOST}
                      value={settings.provider.ollamaHost ?? ''}
                      onChange={(event) => updateProvider({ ...settings.provider, ollamaHost: event.target.value })}
                    />
                    <GhostButton className="gc-btn-sm is-field" onClick={() => void refresh()} disabled={checking}>Refresh models</GhostButton>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="gc-settings-callout" role="note">
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>
          The <code>--provider</code> CLI flag overrides this default at launch.
          System environment variables override saved API keys when both are present.
        </span>
      </div>
    </div>
  )
}

export function AppearanceTab({
  settings,
  onUpdate,
}: { settings: GCodeSettings; onUpdate: (p: Partial<GCodeSettings>) => void }) {
  // The thumb glides for pointer clicks; keyboard activation moves it instantly.
  const [pointer, setPointer] = useState(false)
  return (
    <div className="gc-settings-section">
      <div className="gc-settings-section-head"><h3 id="settings-theme">Theme</h3></div>
      <div className="gc-segmented" role="group" aria-labelledby="settings-theme">
        {(['dark', 'light', 'system'] as const).map((theme) => <button key={theme} type="button" className="gc-segmented-item" aria-pressed={settings.appearance.theme === theme} onClick={() => onUpdate({ appearance: { ...settings.appearance, theme } })}>
          {settings.appearance.theme === theme && <span className="gc-segmented-thumb" aria-hidden="true" />}
          <span className="gc-segmented-label">{theme[0].toUpperCase() + theme.slice(1)}</span>
        </button>)}
      </div>
      <div className="gc-settings-section-head"><h3 id="settings-chat-font-size">Chat font size</h3></div>
      <div className="gc-segmented" role="group" aria-labelledby="settings-chat-font-size">
        {FONT_SIZES.map((size) => {
          const selected = settings.appearance.chatFontSize === size
          return (
            <button
              key={size}
              type="button"
              className="gc-segmented-item"
              aria-pressed={selected}
              onClick={(event) => {
                setPointer(event.detail > 0)
                onUpdate({ appearance: { ...settings.appearance, chatFontSize: size as 15 | 16 | 17 | 18 } })
              }}
            >
              {selected && <motion.span layoutId="gc-settings-font-thumb" transformTemplate={flatProjection} className="gc-segmented-thumb" transition={pointer ? springIndicator : { duration: 0 }} aria-hidden="true" />}
              <span className="gc-segmented-label">{size}px</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
