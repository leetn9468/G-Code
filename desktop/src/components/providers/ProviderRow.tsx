import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronRight, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { swap } from '@/lib/motion'
import { ProviderTile } from './ProviderTile'
import { LocalModelPicker } from './LocalModelPicker'
import { ModelPicker } from './ModelPicker'
import type { OllamaStatus } from '@/lib/tauri'
import { listProviderModels } from '@/lib/tauri'
import type { ProviderName, ProviderRowStatus } from '@/lib/providers'
import { EMPTY_MODEL_LIST, PROVIDER_DESCRIPTION, PROVIDER_DISPLAY, PROVIDER_ENV_VAR, PROVIDER_SHORT_NAME, STATUS_LABEL, hasModelList, modelListCache, modelListSummary } from '@/lib/providers'

interface Props {
  provider: ProviderName
  status: ProviderRowStatus
  model: string
  apiKey?: string
  isAuto: boolean
  ollamaStatus?: OllamaStatus | null
  checkingModels?: boolean
  credentialsConfigured?: boolean
  localModelControl?: ReactNode
  onModelChange: (model: string) => void
  onApiKeyChange?: (apiKey: string) => void | Promise<void>
}

export function ProviderRow({ provider, status, model, apiKey = '', isAuto, ollamaStatus = null, checkingModels = false, credentialsConfigured = false, localModelControl, onModelChange, onApiKeyChange }: Props) {
  const [modelDraft, setModelDraft] = useState(model)
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey)
  const [showApiKey, setShowApiKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const cancelModelCommit = useRef(false)
  const cancelKeyCommit = useRef(false)
  const envVar = provider === 'ollama' || provider === 'local' ? null : PROVIDER_ENV_VAR[provider]
  const modelInputId = useId()
  // API providers can list their models; the list is cached for this app session.
  const listProvider = hasModelList(provider) ? provider : null
  const readModelList = () => (listProvider ? modelListCache.get(listProvider) : EMPTY_MODEL_LIST)
  const modelList = useSyncExternalStore(modelListCache.subscribe, readModelList, readModelList)
  const refreshModelList = () => { if (listProvider) void modelListCache.refresh(listProvider, listProviderModels) }

  useEffect(() => setModelDraft(model), [model])
  useEffect(() => setApiKeyDraft(apiKey), [apiKey])

  const pickModel = (id: string) => {
    setModelDraft(id)
    if (id !== model) onModelChange(id)
  }

  const handleModelCommit = () => {
    if (cancelModelCommit.current) { cancelModelCommit.current = false; return }
    if (modelDraft.trim() && modelDraft.trim() !== model) onModelChange(modelDraft.trim())
  }
  const handleApiKeyCommit = async () => {
    if (cancelKeyCommit.current) { cancelKeyCommit.current = false; return }
    if (apiKeyDraft === apiKey) return
    setSaveError(null)
    try {
      await onApiKeyChange?.(apiKeyDraft.trim())
      // Another key may see other models: drop the old list until it is refreshed.
      if (listProvider) modelListCache.forget(listProvider)
    }
    catch (error) { setSaveError(String(error)) }
  }

  return <section className="gc-provider-configuration" aria-label={`${PROVIDER_DISPLAY[provider]} settings`}>
    <div className="gc-provider-detail-heading">
      <span className="gc-provider-detail-mark"><ProviderTile provider={provider} size={26} /></span>
      <div className="gc-provider-detail-title">
        <h3>{PROVIDER_SHORT_NAME[provider]}</h3>
        <span className={`gc-provider-status ${status}`}><i className="gc-provider-status-dot" aria-hidden="true" />{STATUS_LABEL[status]}</span>
      </div>
    </div>
    <p className="gc-provider-description">{PROVIDER_DESCRIPTION[provider]}</p>
    {provider === 'local' ? localModelControl : provider === 'ollama' ? <div className="gc-provider-field"><span>Installed model</span><LocalModelPicker model={model} status={ollamaStatus} checking={checkingModels} onChange={onModelChange} /></div> : <>
      <div className="gc-provider-field gc-provider-model-field">
        <label className="gc-provider-field-title" htmlFor={modelInputId}>Model</label>
        <div className="gc-provider-model-row">
          <input id={modelInputId} className="gc-input-well" aria-label={`${PROVIDER_DISPLAY[provider]} model`} spellCheck={false} placeholder={model} value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} onBlur={handleModelCommit} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelModelCommit.current = true; setModelDraft(model); event.currentTarget.blur() }
          }} />
          {listProvider && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field gc-provider-models-refresh" disabled={modelList.loading} aria-busy={modelList.loading || undefined} onClick={refreshModelList}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className={modelList.loading ? 'is-checking' : undefined} />Refresh models
          </button>}
        </div>
        {listProvider && <ModelListStatus provider={provider} loading={modelList.loading} error={modelList.error} count={modelList.models?.length ?? null} fetchedAt={modelList.fetchedAt} />}
        {modelList.models && modelList.models.length > 0 && <ModelPicker models={modelList.models} value={model} onPick={pickModel} label={`Search ${PROVIDER_SHORT_NAME[provider]} models`} />}
      </div>
      <label className="gc-provider-field"><span>API key</span><div className="gc-provider-secret"><input className="gc-input-well" type={showApiKey ? 'text' : 'password'} aria-label={`${PROVIDER_DISPLAY[provider]} API key`} autoComplete="off" spellCheck={false} placeholder="Paste your API key" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} onBlur={() => void handleApiKeyCommit()} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelKeyCommit.current = true; setApiKeyDraft(apiKey); event.currentTarget.blur() }
      }} /><button type="button" className="gc-btn-icon gc-secret-toggle" aria-label={showApiKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowApiKey((visible) => !visible)}>
        <AnimatePresence initial={false}>
          <motion.span key={showApiKey ? 'hide' : 'show'} className="gc-secret-toggle-icon" variants={swap} initial="initial" animate="animate" exit="exit">
            {showApiKey ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
          </motion.span>
        </AnimatePresence>
      </button></div><small className={credentialsConfigured ? 'has-credential' : undefined}>{credentialsConfigured ? <><Check size={14} strokeWidth={2} aria-hidden="true" /> Credential detected{apiKey ? ' in settings' : ' in your environment'}.</> : 'Add a key to use this provider.'}</small></label>
      {saveError && <p role="alert" className="gc-provider-save-error">Could not save API key: {saveError}</p>}
      <details className="gc-provider-environment gc-disclosure"><summary><ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="gc-disclosure-chevron" />Use an environment variable</summary><div className="gc-disclosure-body"><p>Set <code>{envVar}</code> in the shell that launches G-Code.</p>{isAuto && <p>This provider was detected in your environment.</p>}</div></details>
    </>}
  </section>
}

/** One line under the model field: loading, the API's error, or what was fetched. */
function ModelListStatus({ provider, loading, error, count, fetchedAt }: { provider: ProviderName; loading: boolean; error: string | null; count: number | null; fetchedAt: number | null }) {
  if (loading) return <small className="gc-provider-models-status" role="status"><i className="gc-spinner gc-provider-check-spinner" aria-hidden="true" />Asking {PROVIDER_SHORT_NAME[provider]} for its models…</small>
  if (error) return <p className="gc-provider-models-error" role="alert">{error}{count !== null && fetchedAt !== null ? ` · showing the list from ${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
  if (count !== null && fetchedAt !== null) return <small className="gc-provider-models-status" role="status">{modelListSummary(count, fetchedAt)}{count ? ' · pick one below or type any model id' : ''}</small>
  return <small className="gc-provider-models-status">Type a model id, or refresh to list the models your key can use.</small>
}
