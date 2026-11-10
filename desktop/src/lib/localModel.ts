import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { checkLocalModel, isTauri, type LocalModelStatus } from './tauri'

export function localModelLabel(path?: string): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Choose a GGUF file or MLX folder (⌘P)'
}

export function useLocalModelStatus(open: boolean, modelPath?: string, runtimePath?: string) {
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const requestId = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++requestId.current
    setChecking(true)
    try {
      const result = isTauri()
        ? await checkLocalModel(modelPath, runtimePath)
        : { ready: false, model_path: modelPath || null, runtime_path: runtimePath || null, error: 'Open the desktop app to choose and run a local model.' }
      if (request === requestId.current) setStatus(result)
      return result
    } catch (error) {
      const result = { ready: false, model_path: modelPath || null, runtime_path: runtimePath || null, error: String(error) }
      if (request === requestId.current) setStatus(result)
      return result
    } finally { if (request === requestId.current) setChecking(false) }
  }, [modelPath, runtimePath])
  useEffect(() => {
    setStatus(null); setChecking(open)
    const timer = open ? setTimeout(() => void refresh(), 250) : undefined
    return () => { clearTimeout(timer); requestId.current++ }
  }, [open, refresh])
  useEffect(() => {
    if (!open || !isTauri()) return
    let active = true; let unlisten: (() => void) | undefined
    void listen<Record<string, unknown>>('cli-runtime-state', ({ payload }) => {
      if (!active || payload.kind !== 'model') return
      if (payload.phase === 'ready' && typeof payload.appliedContext === 'number') setStatus(value => value ? { ...value, applied_context: payload.appliedContext as number, context_reason: typeof payload.contextReason === 'string' ? payload.contextReason : null } : value)
      else if (['server_start', 'failed', 'cancelled'].includes(String(payload.phase))) setStatus(value => value ? { ...value, applied_context: null, context_reason: null } : value)
    }).then(stop => { if (active) unlisten = stop; else stop() })
    return () => { active = false; unlisten?.() }
  }, [open, refresh])
  return { status, checking, refresh }
}
