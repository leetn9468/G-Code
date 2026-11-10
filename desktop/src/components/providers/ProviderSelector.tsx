// Browse providers without switching, then configure one provider at a time.
// Two panes: a provider list whose selection pill glides between rows
// (pointer only), and a detail pane that cross-fades when the selection changes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { ArrowRight, Check, CircleAlert, RefreshCw, X } from 'lucide-react'
import { Modal } from '../shell/Modal'
import { Tooltip } from '../shell/Tooltip'
import { GLogo } from '@/icons/GLogo'
import { easeOut, flatProjection, springIndicator } from '@/lib/motion'
import { ProviderRow } from './ProviderRow'
import { ProviderTile } from './ProviderTile'
import { LocalGGUFPicker } from './LocalGGUFPicker'
import { useLocalModelStatus } from '@/lib/localModel'
import type { ProviderName, ProviderRowStatus } from '@/lib/providers'
import { PROVIDER_DISPLAY, PROVIDER_SHORT_NAME, connectionTestMessage, providerErrorMessage } from '@/lib/providers'
import type { ProviderEnvStatus } from '@/lib/tauri'
import { getProviderEnvStatus, isTauri, testProvider } from '@/lib/tauri'
import { DEFAULT_OLLAMA_HOST, useOllamaModels } from '@/lib/ollama'
import './providers.css'

interface Props {
  open: boolean
  onClose: () => void
  currentProvider: ProviderName
  onSwitch: (provider: ProviderName, closeSelector?: boolean) => void
  perProviderModel: Partial<Record<ProviderName, string>>
  apiKeys: Partial<Record<Exclude<ProviderName, 'ollama' | 'local'>, string>>
  ollamaHost?: string
  localModelPath?: string
  localRuntimePath?: string
  localContext?: number
  onLocalContextChange?: (context: number) => void
  onLocalModelPathChange: (path: string) => void
  onLocalRuntimePathChange: (path: string) => void
  onOllamaHostChange: (host: string) => void
  onModelChange: (provider: ProviderName, model: string) => void
  onApiKeyChange: (provider: Exclude<ProviderName, 'ollama' | 'local'>, apiKey: string) => Promise<void>
  getDefaultModel: (provider: ProviderName) => string
  sessionHasMessages: boolean
  /** Opened from a keyboard shortcut: appear and close without animation. */
  instant?: boolean
}

/** Detail pane cross-fade: opacity + 2px blur, 80ms out / 160ms in. Instant when
    the change was not pointer-driven (keyboard, or the reset on open). Under
    reduced motion only the opacity fade remains. */
const paneSwap = (blur: boolean): Variants => ({
  initial: (animate: boolean) => (animate ? { opacity: 0, filter: blur ? 'blur(2px)' : 'none' } : { opacity: 1, filter: 'none' }),
  animate: (animate: boolean) => ({
    opacity: 1,
    filter: animate && blur ? 'blur(0px)' : 'none',
    transition: { duration: animate ? 0.16 : 0, ease: easeOut },
    transitionEnd: { filter: 'none' },
  }),
  exit: (animate: boolean) => ({ opacity: 0, filter: animate && blur ? 'blur(2px)' : 'none', transition: { duration: animate ? 0.08 : 0, ease: easeOut } }),
})
const PANE_SWAP = paneSwap(true)
const PANE_FADE = paneSwap(false)

export function ProviderSelector({
  open,
  onClose,
  currentProvider,
  onSwitch,
  perProviderModel,
  apiKeys,
  ollamaHost,
  localModelPath,
  localRuntimePath,
  localContext,
  onLocalContextChange,
  onLocalModelPathChange,
  onLocalRuntimePathChange,
  onOllamaHostChange,
  onModelChange,
  onApiKeyChange,
  getDefaultModel,
  sessionHasMessages,
  instant = false,
}: Props) {
  const [envStatus, setEnvStatus] = useState<ProviderEnvStatus | null>(null)
  const { status: ollama, checking: checkingModels, refresh: refreshModels } = useOllamaModels(open, ollamaHost)
  const local = useLocalModelStatus(open, localModelPath, localRuntimePath)
  const [hostDraft, setHostDraft] = useState(ollamaHost ?? '')
  useEffect(() => setHostDraft(ollamaHost ?? ''), [ollamaHost, open])
  const [checking, setChecking] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<ProviderName | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>(currentProvider)
  const [testResult, setTestResult] = useState<{ provider: ProviderName; message: string; tone?: 'success' | 'error' } | null>(null)
  const [checkingConnection, setCheckingConnection] = useState(false)
  // Presentation only: the selection pill glides and the detail pane cross-fades
  // for pointer clicks; keyboard activation and the reset on open are instant.
  const [pointerSwitch, setPointerSwitch] = useState(false)
  const reduceMotion = useReducedMotion()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const useRefButton = useRef<HTMLButtonElement>(null)
  const hadConfirmation = useRef(false)

  useEffect(() => { if (open) setSelectedProvider(currentProvider) }, [open, currentProvider])
  useEffect(() => { if (open) setPointerSwitch(false) }, [open])
  useEffect(() => {
    if (!open) return
    if (pendingSwitch) { hadConfirmation.current = true; cancelRef.current?.focus() }
    else if (hadConfirmation.current) { hadConfirmation.current = false; useRefButton.current?.focus() }
  }, [pendingSwitch, open])

  const refresh = useCallback(async () => {
    setChecking(true)
    setTestResult(null)
    try {
      if (isTauri()) {
        setEnvStatus(await getProviderEnvStatus())
      } else {
        // Pure-Vite dev fallback so the UI renders without Tauri.
        setEnvStatus({
          anthropic: false,
          openai: false,
          gemini: false,
          deepseek: false,
          qwen: false,
          auto: null,
        })
      }
    } catch (err) {
      setTestResult({ provider: currentProvider, message: String(err) })
    } finally {
      setChecking(false)
    }
  }, [currentProvider])

  useEffect(() => {
    if (open) { void refresh(); setPendingSwitch(null) }
  }, [open, refresh])

  const rowStatus = (p: ProviderName): ProviderRowStatus => {
    if (p === currentProvider) return 'current'
    if (p === 'local') return !localModelPath ? 'not-configured' : local.status?.ready ? 'configured' : local.status?.error ? 'error' : 'not-configured'
    if (p === 'ollama') return ollama?.error ? 'error' : ollama?.running ? 'running' : 'not-configured'
    const configured = envStatus?.[p as Exclude<ProviderName, 'ollama' | 'local'>]
      || Boolean(apiKeys[p as Exclude<ProviderName, 'ollama' | 'local'>]?.trim())
    return configured ? 'configured' : 'not-configured'
  }

  const handleSelect = (p: ProviderName) => {
    if (p === currentProvider) return
    const status = rowStatus(p)
    if (sessionHasMessages) {
      setPendingSwitch(p)
      return
    }
    if (status === 'not-configured' || p === 'ollama' || p === 'local') {
      // Local and unconfigured providers stay open for model or credential setup.
      onSwitch(p, false)
      return
    }
    onSwitch(p, true)
  }

  const confirmSwitch = () => {
    if (pendingSwitch) {
      onSwitch(pendingSwitch, pendingSwitch !== 'ollama' && pendingSwitch !== 'local' && rowStatus(pendingSwitch) !== 'not-configured')
      setPendingSwitch(null)
    }
  }

  const cancelSwitch = () => setPendingSwitch(null)

  const handleTestConnection = async () => {
    const provider = selectedProvider
    const report = (message: string, tone?: 'success' | 'error') => setTestResult({ provider, message, tone })
    setCheckingConnection(true)
    report('Checking…')
    try {
      if (!isTauri()) { report('Connection checks run inside the desktop app.'); return }
      if (provider === 'local') {
        const result = await local.refresh()
        report(result.ready ? 'Model and local runtime found.' : result.error || 'Local model is not ready.', result.ready ? 'success' : 'error')
        return
      }
      if (provider === 'ollama') {
        const result = await refreshModels()
        report(result.running ? `Ollama reachable (${result.models.length} installed models).` : `Ollama unreachable: ${result.error ?? 'unknown'}`, result.running ? 'success' : 'error')
        return
      }
      // Cloud: one tiny real request ("Reply with OK.") with the chosen model.
      const model = (perProviderModel[provider] ?? getDefaultModel(provider)).trim()
      if (!model) { report('Choose a model first.', 'error'); return }
      try { report(connectionTestMessage(await testProvider(provider, model), model), 'success') }
      catch (error) { report(providerErrorMessage(provider, error), 'error') }
    } catch (error) { report(String(error), 'error') }
    finally { setCheckingConnection(false) }
  }

  const commitHost = () => {
    if (hostDraft.trim() !== (ollamaHost ?? '')) onOllamaHostChange(hostDraft.trim())
  }

  const providerGroups: Array<{ label: string; providers: ProviderName[] }> = [
    { label: 'On your Mac', providers: ['local', 'ollama'] },
    { label: 'Cloud', providers: ['anthropic', 'openai', 'gemini', 'deepseek', 'qwen'] },
  ]
  const selectedStatus = rowStatus(selectedProvider)
  const cloudProvider = selectedProvider !== 'local' && selectedProvider !== 'ollama' ? selectedProvider : null
  const busy = checking || checkingModels || local.checking
  const testButton = <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={checkingConnection || busy} onClick={() => void handleTestConnection()}>
    {checkingConnection && <i className="gc-spinner gc-provider-check-spinner" aria-hidden="true" />}
    {checkingConnection ? 'Checking…' : selectedProvider === 'local' ? 'Check files' : 'Test connection'}
  </button>

  return (
    <Modal open={open} onClose={pendingSwitch ? cancelSwitch : onClose} labelledBy={pendingSwitch ? 'provider-switch-title' : 'provider-selector-title'} width={pendingSwitch ? 480 : 760} maxHeight="min(720px, 88vh)" instant={instant}>
      {pendingSwitch ? <div className="gc-provider-confirm">
        <div className="gc-provider-confirm-mark"><GLogo size={24} /></div>
        <div className="gc-modal-heading"><h2 id="provider-switch-title">Switch to {PROVIDER_SHORT_NAME[pendingSwitch]}?</h2></div>
        <p>Switching provider starts a new session. Your current conversation stays saved and resumable.</p>
        <div className="gc-provider-confirm-route">
          <span><ProviderTile provider={currentProvider} size={18} />{PROVIDER_SHORT_NAME[currentProvider]}</span>
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" className="gc-provider-confirm-arrow" />
          <strong><ProviderTile provider={pendingSwitch} size={18} />{PROVIDER_SHORT_NAME[pendingSwitch]}</strong>
        </div>
        <div className="gc-provider-confirm-actions">
          <button ref={cancelRef} type="button" className="gc-btn gc-btn-ghost" onClick={cancelSwitch}>Keep current provider</button>
          <button type="button" className="gc-btn gc-btn-primary" onClick={confirmSwitch}>Switch provider</button>
        </div>
      </div> : <>
        <header className="gc-modal-header">
          <div className="gc-modal-icon"><GLogo size={20} /></div>
          <div className="gc-modal-heading"><h2 id="provider-selector-title">Models & providers</h2><p>Choose the intelligence behind your next idea.</p></div>
          <Tooltip content="Close" shortcut="Esc" side="bottom">
            <button type="button" className="gc-btn-icon gc-modal-close" aria-label="Close provider selector" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
          </Tooltip>
        </header>
        <div className="gc-provider-workspace">
          <motion.nav layoutScroll className="gc-provider-navigation" aria-label="Providers">
            <div className="gc-provider-nav-heading">
              <span>Providers</span>
              <Tooltip content="Refresh providers" side="bottom">
                <button type="button" className="gc-btn-icon gc-provider-refresh" aria-label="Refresh providers" disabled={busy} onClick={() => { void refresh(); void refreshModels(); void local.refresh() }}><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className={busy ? 'is-checking' : undefined} /></button>
              </Tooltip>
            </div>
            {providerGroups.map((group) => <div className="gc-provider-group" key={group.label}>
              <h3>{group.label}</h3>
              {group.providers.map((provider) => {
                const selected = selectedProvider === provider
                return <button key={provider} type="button" className={`gc-provider-nav-item${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={(event) => { setPointerSwitch(event.detail > 0); setSelectedProvider(provider); setTestResult(null) }}>
                  {selected && <motion.span layoutId="gc-provider-nav-pill" transformTemplate={flatProjection} className="gc-provider-nav-pill" transition={pointerSwitch ? springIndicator : { duration: 0 }} aria-hidden="true" />}
                  <span className="gc-provider-nav-content">
                    <ProviderTile provider={provider} size={24} />
                    <span className="gc-provider-nav-name">{PROVIDER_SHORT_NAME[provider]}</span>
                    {provider === currentProvider && <Check size={14} strokeWidth={2} className="gc-provider-current-check" aria-label="Current provider" />}
                  </span>
                </button>
              })}
            </div>)}
          </motion.nav>
          <AnimatePresence mode="wait" initial={false} custom={pointerSwitch}>
            <motion.div className="gc-provider-detail" key={selectedProvider} custom={pointerSwitch} variants={reduceMotion ? PANE_FADE : PANE_SWAP} initial="initial" animate="animate" exit="exit">
              <ProviderRow
                provider={selectedProvider}
                status={selectedStatus}
                model={perProviderModel[selectedProvider] ?? getDefaultModel(selectedProvider)}
                apiKey={cloudProvider ? apiKeys[cloudProvider] ?? '' : undefined}
                isAuto={envStatus?.auto === selectedProvider}
                ollamaStatus={ollama}
                checkingModels={checkingModels}
                credentialsConfigured={Boolean(cloudProvider && (envStatus?.[cloudProvider] || apiKeys[cloudProvider]?.trim()))}
                localModelControl={selectedProvider === 'local' && <LocalGGUFPicker localContext={localContext} onLocalContextChange={onLocalContextChange} modelPath={localModelPath} runtimePath={localRuntimePath} status={local.status} checking={local.checking} onModelPathChange={onLocalModelPathChange} onRuntimePathChange={onLocalRuntimePathChange} onRefresh={() => void local.refresh()} />}
                onModelChange={(model) => onModelChange(selectedProvider, model)}
                onApiKeyChange={cloudProvider ? async (key) => { await onApiKeyChange(cloudProvider, key); await refresh() } : undefined}
              />
              {selectedProvider === 'ollama' && <label className="gc-provider-field gc-provider-host">
                <span>Server address</span>
                <input className="gc-input-well" aria-label="Ollama server URL" spellCheck={false} value={hostDraft} placeholder={ollama?.host ?? DEFAULT_OLLAMA_HOST} onChange={(event) => setHostDraft(event.target.value)} onBlur={commitHost} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') event.currentTarget.blur() }} />
                <small>Use models installed or imported into this Ollama server.</small>
              </label>}
              <div className="gc-provider-check-row">
                {cloudProvider
                  ? <Tooltip content="Sends one short request to the model (a few tokens)" side="bottom" align="start">{testButton}</Tooltip>
                  : testButton}
              </div>
              {testResult?.provider === selectedProvider && <p className={`gc-provider-test-result${testResult.tone ? ` is-${testResult.tone}` : ''}`} role="status">
                {testResult.tone === 'success' && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                {testResult.tone === 'error' && <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />}
                <span>{testResult.message}</span>
              </p>}
            </motion.div>
          </AnimatePresence>
        </div>
        <footer className="gc-modal-footer gc-provider-footer">
          <p>Provider and model changes start a new session.</p>
          {selectedProvider === currentProvider
            ? <button type="button" className="gc-btn gc-btn-primary gc-provider-cta" onClick={onClose}>Done</button>
            : <button ref={useRefButton} type="button" className="gc-btn gc-btn-primary gc-provider-cta" aria-label={`Use ${PROVIDER_DISPLAY[selectedProvider]}`} onClick={() => handleSelect(selectedProvider)}>Use {PROVIDER_SHORT_NAME[selectedProvider]}<ArrowRight size={15} strokeWidth={2} aria-hidden="true" /></button>}
        </footer>
      </>}
    </Modal>
  )
}
