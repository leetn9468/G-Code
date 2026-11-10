import { ChevronDown } from 'lucide-react'
import type { OllamaStatus } from '@/lib/tauri'
import { installedModelName } from '@/lib/ollama'
import './providers.css'

interface Props {
  model: string
  status: OllamaStatus | null
  checking: boolean
  onChange: (model: string) => void
}

export function LocalModelPicker({ model, status, checking, onChange }: Props) {
  const models = status?.models ?? []
  const installed = installedModelName(model, models)
  const stale = Boolean(model && !installed)
  const selectable = Boolean(status?.running && models.length && !checking)

  return (
    <div className="gc-local-model-select" onClick={(event) => event.stopPropagation()}>
      <div className="gc-select-well">
        <select
          aria-label="Ollama (Local) model"
          value={installed ?? model}
          onChange={(event) => onChange(event.target.value)}
          disabled={!selectable}
          className="gc-provider-select gc-input-well"
        >
          <option value="" disabled>{checking ? 'Discovering installed models…' : models.length ? 'Select an installed model' : 'No models available'}</option>
          {stale && <option value={model} disabled>{model} — {status?.running ? 'not installed' : 'not verified'}</option>}
          {models.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="gc-select-chevron" />
      </div>
      <p role="status" className={`gc-local-model-status${stale || status?.error ? ' warning' : ''}`}>
        {checking && <i className="gc-spinner gc-local-model-spinner" aria-hidden="true" />}
        {checking ? 'Reading models from Ollama…'
          : !status ? 'Refresh to discover installed models.'
            : !status.running ? `Ollama unavailable at ${status.host}. ${status.error ?? 'Start Ollama, then refresh.'}`
              : !models.length ? 'Ollama is running but has no installed models. Pull or import a model in Ollama, then refresh.'
                : stale ? 'The saved model is not installed on this server. Select one from the list.'
                  : `${models.length} installed ${models.length === 1 ? 'model' : 'models'} · ${status.host}`}
      </p>
    </div>
  )
}
