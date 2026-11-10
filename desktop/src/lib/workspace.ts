import { useCallback, useEffect, useState } from 'react'
import { isTauri, validateWorkingDirectory } from './tauri'

export function workspaceLabel(path?: string): string {
  return path ? path.split(/[\\/]/).filter(Boolean).at(-1) || path : 'Open a project'
}

export function useWorkingDirectory(path: string | undefined, loaded: boolean) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ source?: string; cwd?: string; checking: boolean; error?: string }>({ checking: false })
  const refresh = useCallback(() => { setState({ source: path, checking: Boolean(path) }); setRevision((current) => current + 1) }, [path])
  useEffect(() => {
    if (!loaded || !path) { setState({ source: path, checking: false }); return }
    let active = true
    setState({ source: path, checking: true })
    const validate = isTauri() ? validateWorkingDirectory(path) : Promise.reject(new Error('Open projects in the desktop app.'))
    void validate.then((cwd) => { if (active) setState({ source: path, cwd, checking: false }) },
      (error) => { if (active) setState({ source: path, checking: false, error: String(error) }) })
    return () => { active = false }
  }, [path, loaded, revision])
  // Never expose the previous project's directory while a new path is being
  // checked; configuration changes must stop the old session immediately.
  if (state.source !== path) return { cwd: undefined, checking: Boolean(path), error: undefined, refresh }
  return { ...state, refresh }
}
