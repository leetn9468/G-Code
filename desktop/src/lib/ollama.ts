import { useCallback, useEffect, useRef, useState } from 'react'
import { checkOllamaRunning, isTauri, type OllamaStatus } from './tauri'

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

/** Ollama accepts an omitted :latest tag; keep the actual server name in the picker. */
export function installedModelName(model: string, models: string[]): string | undefined {
  const requested = model.trim()
  return models.find((name) => name === requested)
    ?? (!requested.split('/').at(-1)?.includes(':') ? models.find((name) => name === `${requested}:latest`) : undefined)
}

export function useOllamaModels(open: boolean, host?: string) {
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestId.current
    setChecking(true)
    try {
      const result: OllamaStatus = isTauri()
        ? await checkOllamaRunning(host?.trim())
        : { running: false, host: host || DEFAULT_OLLAMA_HOST, model_count: null, models: [], error: 'Open the desktop app to discover local models.' }
      if (request === requestId.current) setStatus(result)
      return result
    } catch (error) {
      const result: OllamaStatus = { running: false, host: host || DEFAULT_OLLAMA_HOST, model_count: null, models: [], error: String(error) }
      if (request === requestId.current) setStatus(result)
      return result
    } finally {
      if (request === requestId.current) setChecking(false)
    }
  }, [host])

  useEffect(() => {
    setStatus(null)
    setChecking(open)
    // Host edits are debounced; never let a slow response replace newer results.
    const timer = open ? setTimeout(() => void refresh(), 250) : undefined
    return () => { clearTimeout(timer); requestId.current++ }
  }, [open, refresh])

  return { status, checking, refresh }
}
