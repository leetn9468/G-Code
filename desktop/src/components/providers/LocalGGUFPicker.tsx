import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri, type LocalModelStatus } from '@/lib/tauri'
import { localModelLabel } from '@/lib/localModel'
import { LOCAL_CONTEXT_PRESETS, validLocalContext } from '@/lib/settings'
import { ChevronRight, FileCode2, FolderOpen } from 'lucide-react'
import './providers.css'

interface Props {
  modelPath?: string
  runtimePath?: string
  localContext?: number
  onLocalContextChange?: (context: number) => void
  status: LocalModelStatus | null
  checking: boolean
  onModelPathChange: (path: string) => void
  onRuntimePathChange: (path: string) => void
  onRefresh: () => void
}

export function LocalGGUFPicker({ modelPath, runtimePath, localContext, onLocalContextChange, status, checking, onModelPathChange, onRuntimePathChange, onRefresh }: Props) {
  const [error, setError] = useState<string | null>(null)
  const choose = async (kind: 'model' | 'mlx' | 'runtime') => {
    setError(null)
    if (!isTauri()) { setError('File selection is available in the desktop app.'); return }
    try {
      const selected = await open({
        title: kind === 'model' ? 'Choose a local GGUF model' : kind === 'mlx' ? 'Choose an MLX model folder' : 'Choose the llama-server executable',
        multiple: false,
        directory: kind === 'mlx',
        ...(kind === 'model' ? { filters: [{ name: 'GGUF model', extensions: ['gguf'] }] } : {}),
      })
      if (typeof selected === 'string') {
        if (kind !== 'runtime') onModelPathChange(selected)
        else onRuntimePathChange(selected)
      }
    } catch (failure) { setError(String(failure)) }
  }
  const warning = Boolean(error || status?.error)
  return (
    <div className="gc-local-model-control" onClick={(event) => event.stopPropagation()}>
      <span className="gc-provider-field-title">Model</span>
      <div className="gc-local-model-file">
        <span className="gc-local-model-icon" aria-hidden="true"><FileCode2 size={18} strokeWidth={1.75} /></span>
        <span className={`gc-local-model-name${modelPath ? '' : ' is-empty'}`} title={modelPath}>{localModelLabel(modelPath)}</span>
        <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void choose('model')}><FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />Choose GGUF…</button>
        <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void choose('mlx')}><FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />Choose MLX…</button>
      </div>
      <p role="status" className={`gc-local-model-status${warning ? ' warning' : ''}`}>
        {checking && <i className="gc-spinner gc-local-model-spinner" aria-hidden="true" />}
        {error ?? (checking ? 'Checking the model and local runtime…' : status?.ready ? 'Model and runtime found. The model loads when you send a message.' : status?.error ?? 'Choose a downloaded GGUF file or MLX model folder. No Ollama account or API key is required.')}
      </p>
      <label className="gc-provider-field-title">Local model context
        <select className="gc-input-well" value={validLocalContext(localContext)} onChange={event => onLocalContextChange?.(Number(event.currentTarget.value))} disabled={!onLocalContextChange}>
          {LOCAL_CONTEXT_PRESETS.map(context => {
            const unsupported = status?.metadata ? context > status.metadata.max_context : false
            const label = context === 1_048_576 ? '1M' : context === 262_144 ? '262K (default)' : `${context / 1024}K`
            return <option key={context} value={context} disabled={unsupported}>{label}{unsupported ? ' · Not supported by this model' : ''}</option>
          })}
        </select>
      </label>
      <p className="gc-local-model-status" role="status">{status?.applied_context ? `${status.applied_context.toLocaleString('en-US')} tokens applied${status.context_reason ? ` · ${status.context_reason}` : ''}` : 'The context is checked against model support and RAM before loading.'}</p>
      <details className="gc-local-runtime gc-disclosure">
        <summary><ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="gc-disclosure-chevron" />Local runtime</summary>
        <div className="gc-disclosure-body">
          <p className="gc-local-runtime-path">{runtimePath || status?.runtime_path || 'Automatically find llama-server'}</p>
          <div className="gc-local-runtime-actions">
            <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void choose('runtime')}>Choose llama-server…</button>
            {runtimePath && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => onRuntimePathChange('')}>Use automatic detection</button>}
            <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={onRefresh} disabled={checking}>Check files</button>
          </div>
          <p>GGUF files run on the llama.cpp llama-server executable. MLX model folders run on G-Code’s built-in MLX server. Other formats cannot be loaded directly.</p>
        </div>
      </details>
    </div>
  )
}
