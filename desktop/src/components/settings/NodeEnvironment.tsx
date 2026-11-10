import { useEffect, useState } from 'react'
import { getNodeEnvironment, isTauri, type NodeEnvironment } from '@/lib/tauri'

export function nodeEnvironmentLabel(info: NodeEnvironment): string {
  if (!info.version) return 'Node.js: version unavailable'
  return info.builtIn ? `Node.js: G-Code built-in ${info.version} (no Node found on this Mac)`
    : `Node.js: your Node ${info.version} (${info.path})`
}

/** Notices of the bundled tool runtimes, written by their build scripts into public/licenses. */
const BUNDLED_NOTICES = ['/licenses/node-toolchain-LICENSES.txt', '/licenses/ripgrep-LICENSES.txt']

/** The same native PATH discovery used to launch tools; this is not a setting. */
export function NodeEnvironmentInfo({ cwd }: { cwd?: string }) {
  const [info, setInfo] = useState<NodeEnvironment | null>(null)
  const [error, setError] = useState(false)
  const [notices, setNotices] = useState('')
  const [noticesError, setNoticesError] = useState(false)
  useEffect(() => {
    let live = true
    if (!isTauri()) { setError(true); return }
    setInfo(null); setError(false)
    void getNodeEnvironment(cwd).then(value => { if (live) setInfo(value) }, () => { if (live) setError(true) })
    return () => { live = false }
  }, [cwd])
  const showNotices = async (open: boolean) => {
    if (!open || notices) return
    try {
      const texts = await Promise.all(BUNDLED_NOTICES.map(async (path) => {
        const response = await fetch(path)
        if (!response.ok) throw new Error('Missing notices')
        return response.text()
      }))
      setNotices(texts.join('\n\n')); setNoticesError(false)
    } catch { setNoticesError(true) }
  }
  return <section className="gc-settings-section gc-node-environment" aria-label="Node.js environment">
    <p className="gc-settings-note" role="status" title={info?.builtIn ? 'No eligible Node was found on the tool PATH. Missing or unsafe discovered folders are skipped.' : undefined}>{info ? nodeEnvironmentLabel(info) : error ? 'Node.js: environment unavailable' : 'Node.js: checking environment…'}</p>
    <details className="gc-settings-notices" onToggle={event => void showNotices(event.currentTarget.open)}>
      <summary>Open-source notices</summary>
      <p>Node.js, npm, npx and their bundled dependencies, and ripgrep.</p>
      <pre tabIndex={0} aria-label="Node.js, npm and ripgrep licenses">{notices || (noticesError ? 'Could not load notices.' : 'Loading notices…')}</pre>
    </details>
  </section>
}
