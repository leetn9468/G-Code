import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { dshInstall, dshStatus, isTauri, readDshSettings, writeDshSettings } from '@/lib/tauri'
import { defaultDshSettings, editableDshSettings, exactVersion, localPluginPath, packageName, pluginStatus, probeForPlugin, type DshPlugin, type DshProbe, type DshSettings } from '@/lib/dshConfig'

export function DshPlugins({ cwd }: { cwd?: string }) {
  const [config, setConfig] = useState(defaultDshSettings)
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [guillotine, setGuillotine] = useState(false)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
  const [probe, setProbe] = useState<DshProbe | null>(null)
  const [kind, setKind] = useState('npm'), [name, setName] = useState(''), [version, setVersion] = useState(''), [path, setPath] = useState('')
  const operation = useRef(false), mounted = useRef(true)
  const request = useRef({ cwd, generation: 0 })
  if (request.current.cwd !== cwd) request.current = { cwd, generation: request.current.generation + 1 }
  useEffect(() => {
    mounted.current = true
    if (!isTauri()) { setError('Plugin configuration is available in the desktop app.'); return }
    void readDshSettings().then(value => {
      const next = editableDshSettings(value.dsh)
      if (mounted.current) { setConfig(next); setGuillotine(value.guillotine); setLoaded(true) }
    }).catch(failure => { if (mounted.current) setError(String(failure)) })
    return () => { mounted.current = false; request.current.generation++ }
  }, [])
  useEffect(() => { setProbe(null) }, [cwd])

  const run = async (work: () => Promise<void>) => {
    if (!loaded || operation.current) return
    operation.current = true; setBusy(true); setError(null); setNotice(null)
    try { await work() } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const persist = async (next: DshSettings) => {
    await writeDshSettings(next)
    if (mounted.current) { request.current.generation++; setConfig(next); setProbe(null); setNotice('Saved. Start a new chat to apply plugin changes.') }
  }
  const add = () => run(async () => {
    let entry: DshPlugin
    if (kind === 'npm') {
      if (!packageName(name.trim()) || !exactVersion(version.trim())) throw new Error('Enter an npm package name and an exact version, such as 0.2.2-alpha.2.')
      entry = { package: name.trim(), version: version.trim(), enabled: true, config: {} }
    } else {
      if (!localPluginPath(path)) throw new Error('Choose an absolute .js or .mjs plugin file.')
      entry = { path, enabled: true, config: {} }
    }
    await persist({ ...config, plugins: [...config.plugins, entry] })
    if (mounted.current) { setName(''); setVersion(''); setPath('') }
  })
  const choose = () => run(async () => {
    const selected = await open({ title: 'Choose a DeepSeek Harness plugin', directory: false, multiple: false, filters: [{ name: 'JavaScript plugin', extensions: ['mjs', 'js'] }] })
    if (mounted.current && typeof selected === 'string') setPath(selected)
  })
  const refresh = () => run(async () => {
    if (!cwd) throw new Error('Select a project folder to check plugin status.')
    const generation = ++request.current.generation
    const current = () => mounted.current && request.current.generation === generation && request.current.cwd === cwd
    setProbe(null)
    // A fresh read also picks up Guillotine changes made in another settings panel.
    const saved = await readDshSettings(), next = editableDshSettings(saved.dsh)
    if (!current()) return
    setConfig(next); setGuillotine(saved.guillotine)
    let result: DshProbe
    try { result = await dshStatus(cwd) } catch (failure) { if (current()) throw failure; return }
    if (current()) { setProbe(result); if (result.error) setError(result.error) }
  })
  const install = () => run(async () => {
    const saved = await readDshSettings()
    if (mounted.current) setGuillotine(saved.guillotine)
    if (saved.guillotine) throw new Error('Installation is unavailable while Guillotine Mode is on.')
    const result = await dshInstall(cwd)
    if (mounted.current) { setProbe(null); setNotice(`${result.trim()} Refresh status to check plugins.`) }
  })
  const disabled = !loaded || busy
  return <section className="gc-settings-section gc-dsh-plugins" aria-label="DeepSeek Harness plugins">
    <div className="gc-settings-section-head"><h3>DeepSeek Harness plugins</h3><p>User configuration at <code>~/.gcode/settings.json</code>. Changes save immediately and apply to new chats.</p></div>
    {error && <p role="alert" className="gc-feature-error">{error}</p>}
    {notice && <p role="status" className="gc-settings-note">{notice}</p>}
    <label className="gc-settings-check"><input type="checkbox" checked={config.enabled} disabled={disabled} onChange={event => void run(() => persist({ ...config, enabled: event.currentTarget.checked }))} />Enable DeepSeek Harness plugins</label>
    {!loaded ? <p className="gc-settings-note">Reading plugin configuration…</p> : config.plugins.length === 0 ? <div className="gc-feature-empty">No plugins configured.</div> : <div className="gc-mcp-list">{config.plugins.map((plugin, index) => {
      const label = plugin.package ? `${plugin.package}@${plugin.version}` : plugin.path
      const state = probeForPlugin(config.plugins, index, probe)
      return <article className="gc-mcp-server" key={`${index}:${label}`}>
        <code>{label}</code>
        <label className="gc-settings-check"><input type="checkbox" aria-label={`Enable ${label}`} checked={plugin.enabled} disabled={disabled} onChange={event => { const enabled = event.currentTarget.checked; void run(() => persist({ ...config, plugins: config.plugins.map((item, i) => i === index ? { ...item, enabled } : item) })) }} />Enabled</label>
        <p role="status">{pluginStatus(plugin, config.enabled, state)}</p>
        {state?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}
        <footer><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={disabled} onClick={() => void run(() => persist({ ...config, plugins: config.plugins.filter((_, i) => i !== index) }))}>Remove plugin</button></footer>
      </article>
    })}</div>}
    <h4 className="gc-settings-subhead">Add plugin</h4>
    <div className="gc-settings-field"><label htmlFor="dsh-plugin-source">Plugin source</label><select id="dsh-plugin-source" className="gc-input-well" value={kind} disabled={disabled} onChange={event => setKind(event.target.value)}><option value="npm">npm package</option><option value="local">Local file</option></select></div>
    {kind === 'npm' ? <>
      <div className="gc-settings-field"><label htmlFor="dsh-package">npm package</label><input id="dsh-package" className="gc-input-well" spellCheck={false} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></div>
      <div className="gc-settings-field"><label htmlFor="dsh-version">Exact version</label><input id="dsh-version" className="gc-input-well" spellCheck={false} value={version} disabled={disabled} onChange={event => setVersion(event.target.value)} /></div>
    </> : <div className="gc-settings-field"><label htmlFor="dsh-path">Plugin file</label><div className="gc-settings-inline"><input id="dsh-path" className="gc-input-well" value={path} readOnly disabled={disabled} /><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={disabled} onClick={() => void choose()}>Choose file…</button></div></div>}
    <div className="gc-settings-inline"><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={disabled || (kind === 'npm' ? !name.trim() || !version.trim() : !path)} onClick={() => void add()}>Add plugin</button></div>
    <p className="gc-settings-note">Install downloads the locked runtime and configured npm packages from npm to <code>~/.gcode/dsh/runtime</code>. Only install plugins you trust.</p>
    {guillotine && <p className="gc-settings-note">Installation is unavailable while Guillotine Mode is on.</p>}
    <div className="gc-settings-inline"><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={disabled || guillotine} onClick={() => void install()}>{busy ? 'Working…' : 'Install'}</button><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={disabled || !cwd} onClick={() => void refresh()}>Refresh status</button></div>
    <p className="gc-settings-note">Refresh status runs enabled plugins for the selected project. Tool calls use the existing MCP approval and Guillotine checks.</p>
  </section>
}
