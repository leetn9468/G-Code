import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe, LogIn, LogOut, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { browserMcpPreset, isTauri, mcpLogin, mcpLoginCancel, mcpLogout, mcpRegistryAdd, mcpRegistrySearch, readMcpConfig, testMcpConnection, writeMcpConfig, type McpRegistryEntry } from '@/lib/tauri'
import { parseMcpArguments, parseMcpConfig, remoteAuth, serverNameFor, timeoutProblem, validServerName, valuesToFill, type McpConfig, type McpServer } from '@/lib/mcpConfig'
import { NodeEnvironmentInfo } from '../settings/NodeEnvironment'
import { DshPlugins } from './DshPlugins'

type Probe = { status: string; error?: string; tools?: string[]; resources?: number; prompts?: string[] }
type Kind = 'local' | 'remote'
type SignIn = 'none' | 'bearer' | 'api_key' | 'oauth2'
const TRANSPORTS: Array<[NonNullable<McpServer['transport']>, string]> = [['auto', 'Automatic'], ['http', 'Streamable HTTP'], ['sse', 'HTTP + SSE (legacy)']]
const SIGN_INS: Array<[SignIn, string]> = [['none', 'No sign-in'], ['bearer', 'Bearer token'], ['api_key', 'API key'], ['oauth2', 'OAuth (browser sign-in)']]

/** A select well (called inline, so its control is part of the form's own tree). */
function selectWell<T extends string>(label: string, value: T, options: Array<[T, string]>, onChange: (value: T) => void, disabled?: boolean) {
  return <span className="gc-select-well"><select className="gc-input-well" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value as T)}>
    {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
  </select><ChevronDown size={16} strokeWidth={1.75} className="gc-select-chevron" aria-hidden="true" /></span>
}

/** "stdio", or "remote · Streamable HTTP · OAuth" for a server reached at a URL. */
function serverKind(server: McpServer): string {
  if (!server.url) return 'stdio'
  const transport = TRANSPORTS.find(([value]) => value === (server.transport ?? 'auto'))?.[1] ?? 'Automatic'
  const auth = server.auth ? SIGN_INS.find(([value]) => value === server.auth!.type)?.[1].replace(' (browser sign-in)', '') : undefined
  return ['remote', transport, auth].filter(Boolean).join(' · ')
}

function registryKinds(entry: McpRegistryEntry): string {
  return [...entry.packages.map(p => p.registryType), ...entry.remotes.map(r => `remote ${r.type}`)].join(' · ') || 'no runnable package'
}

/**
 * The sign-in waiting for the browser, one at a time. It outlives the panel: Settings can close while
 * the browser is open, and reopening shows it with its Cancel and its result.
 */
type PendingSignIn = { server: string; done: Promise<{ said?: string; failure?: string }> }
let pendingSignIn: PendingSignIn | null = null
function beginSignIn(server: string): PendingSignIn {
  const pending: PendingSignIn = { server, done: mcpLogin(server).then(said => ({ said }), failure => ({ failure: String(failure) })).finally(() => { if (pendingSignIn === pending) pendingSignIn = null }) }
  pendingSignIn = pending
  return pending
}

export function McpManager({ cwd }: { cwd?: string }) {
  const [config, setConfig] = useState<McpConfig>({ mcpServers: {} })
  const [kind, setKind] = useState<Kind>('local')
  const [name, setName] = useState(''), [command, setCommand] = useState(''), [args, setArgs] = useState('')
  const [url, setUrl] = useState(''), [transport, setTransport] = useState<NonNullable<McpServer['transport']>>('auto')
  const [signIn, setSignIn] = useState<SignIn>('none'), [token, setToken] = useState(''), [headerName, setHeaderName] = useState('')
  const [clientId, setClientId] = useState(''), [scope, setScope] = useState('')
  const [statuses, setStatuses] = useState<Record<string, Probe>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false)
  const [query, setQuery] = useState(''), [results, setResults] = useState<{ entries: McpRegistryEntry[]; source: 'official' | 'built-in'; error?: string } | null>(null)
  const [signingIn, setSigningIn] = useState<string | null>(() => pendingSignIn?.server ?? null)
  const operation = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (operation.current) return
    if (!isTauri()) { setError('MCP configuration is available in the desktop app.'); return }
    operation.current = true; setBusy(true); setLoaded(false); setError(null)
    try {
      const next = parseMcpConfig(await readMcpConfig())
      if (mounted.current) { setConfig(next); setLoaded(true); setStatuses({}) }
    } catch (failure) { if (mounted.current) setError(`Could not read MCP configuration: ${String(failure)}`) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  const followSignIn = useCallback((pending: PendingSignIn) => {
    setSigningIn(pending.server)
    setError(null)
    setNotice(`Your browser opens to sign in to "${pending.server}". Come back here when it says you can close it, or cancel the sign-in below.`)
    void pending.done.then(({ said, failure }) => {
      if (!mounted.current) return
      setSigningIn(null)
      setNotice(said ?? null)
      if (failure) setError(failure)
    })
  }, [])
  useEffect(() => { if (pendingSignIn) followSignIn(pendingSignIn) }, [followSignIn])

  /** Runs one operation at a time; its failure shows as the manager's error. */
  const exclusive = async <T,>(work: () => Promise<T>, failurePrefix = ''): Promise<T | undefined> => {
    if (operation.current) return undefined
    operation.current = true; setBusy(true); setError(null)
    try { return await work() }
    catch (failure) { if (mounted.current) setError(`${failurePrefix}${String(failure)}`); return undefined }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const persist = async (next: McpConfig): Promise<boolean> => {
    if (!loaded) return false
    // Only what this save changes goes in: `gcode mcp` may have changed the file since the panel read it.
    return await exclusive(async () => { parseMcpConfig(next); const written = await writeMcpConfig(next, config); if (mounted.current) setConfig(written ? parseMcpConfig(written) : next); return true }, 'Could not save MCP configuration: ') ?? false
  }
  const ready = !!name.trim() && (kind === 'local' ? !!command.trim() : !!url.trim() && (!['bearer', 'api_key'].includes(signIn) || !!token.trim()))
  const add = async () => {
    if (!ready || !loaded || operation.current) return
    try {
      const serverName = name.trim()
      if (Object.hasOwn(config.mcpServers, serverName)) throw new Error('A server with this name already exists.')
      if (!validServerName(serverName)) throw new Error('The server name must be 1-32 letters, digits, "_" or "-", not start with "-", and not be "dsh" or "__proto__".')
      const auth = remoteAuth(signIn, token, headerName, clientId, scope)
      const server: McpServer = kind === 'local'
        ? { name: serverName, command: command.trim(), args: parseMcpArguments(args), enabled: true }
        : { name: serverName, url: url.trim(), ...(transport !== 'auto' ? { transport } : {}), ...(auth ? { auth } : {}), enabled: true }
      if (await persist({ ...config, mcpServers: { ...config.mcpServers, [serverName]: server } })) {
        setName(''); setCommand(''); setArgs(''); setUrl(''); setToken(''); setHeaderName(''); setClientId(''); setScope('')
        setNotice(signIn === 'oauth2' && kind === 'remote' ? `Added "${serverName}". Sign in to it below before starting a chat.` : null)
      }
    } catch (failure) { setError(String(failure)) }
  }
  /** Turns a server on or off; everything else in its entry stays as it is. */
  const setEnabled = async (serverName: string, enabled: boolean) => {
    if (await persist({ ...config, mcpServers: { ...config.mcpServers, [serverName]: { ...config.mcpServers[serverName], enabled } } })) {
      setStatuses((current) => { const states = { ...current }; delete states[serverName]; return states })
      setNotice(`${enabled ? 'Enabled' : 'Disabled'} "${serverName}". New chats load the change.`)
    }
  }
  const remove = async (serverName: string) => {
    const next = { ...config.mcpServers }; delete next[serverName]
    // Its sign-in goes with it: a token must not outlive the server, with no row left to sign out from.
    const signedIn = config.mcpServers[serverName]?.auth?.type === 'oauth2'
    const kept = signedIn ? await exclusive(async () => { try { await mcpLogout(serverName); return '' } catch (failure) { return String(failure) } }) : ''
    if (kept === undefined) return
    if (await persist({ ...config, mcpServers: next })) {
      setStatuses((current) => { const states = { ...current }; delete states[serverName]; return states })
      setNotice(kept ? `Removed "${serverName}", but its saved sign-in could not be cleared (${kept}), so its tokens stay in ~/.gcode/auth.` : null)
    }
  }
  const probe = async (serverName: string) => {
    if (operation.current || !loaded) return
    operation.current = true; setBusy(true)
    setStatuses((current) => ({ ...current, [serverName]: { status: 'checking' } }))
    try {
      const result = await testMcpConnection(serverName)
      if (mounted.current) setStatuses((current) => ({ ...current, [serverName]: result }))
    } catch (failure) {
      if (mounted.current) setStatuses((current) => ({ ...current, [serverName]: { status: 'error', error: String(failure) } }))
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const signInTo = async (serverName: string, out: boolean) => {
    if (!out) { if (!pendingSignIn) followSignIn(beginSignIn(serverName)); return }
    const said = await exclusive(() => mcpLogout(serverName))
    if (said !== undefined && mounted.current) setNotice(said)
  }
  const search = async () => {
    const found = await exclusive(() => mcpRegistrySearch(query.trim()), 'Could not search the MCP Registry: ')
    if (found && mounted.current) setResults(found)
  }
  const addFromRegistry = async (entry: McpRegistryEntry, remote: boolean) => {
    const base = serverNameFor(entry.name)
    let serverName = base
    for (let n = 2; Object.hasOwn(config.mcpServers, serverName) || serverName === 'dsh'; n++) serverName = `${base.slice(0, 29)}-${n}`
    const said = await exclusive(() => mcpRegistryAdd(serverName, entry.name, remote), 'Could not add the server: ')
    if (said === undefined) return
    if (mounted.current) setNotice(said)
    await refresh()
  }

  return <div className="gc-mcp">
    <div className="gc-feature-heading">
      <div><h3>MCP servers</h3><p>Global configuration at <code>~/.gcode/mcp.json</code>. Changes save immediately. Start a new chat (New / ⌘N) to apply them.</p></div>
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className={busy && !loaded ? 'is-spinning' : undefined} />Refresh</button>
    </div>
    {error && <p role="alert" className="gc-feature-error">{error}</p>}
    {notice && <p role="status" className="gc-mcp-notice">{notice}</p>}
    <div className="gc-mcp-preset">
      <span className="gc-mcp-preset-icon" aria-hidden="true"><Globe size={18} strokeWidth={1.75} /></span>
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={!loaded || busy || !!config.mcpServers.gcode_browser} onClick={() => void (async () => { try { const preset = await browserMcpPreset(); await persist({ ...config, mcpServers: { ...config.mcpServers, gcode_browser: preset } }) } catch (failure) { setError(String(failure)) } })()}>Add built-in browser</button>
      <p>Interactive browser for local projects: navigate, inspect, click, fill and capture in an isolated profile. Each tool uses the session permission checks. Start a new chat after adding it.</p>
    </div>
    <div className="gc-mcp-kind" role="group" aria-label="Server type">
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" aria-pressed={kind === 'local'} onClick={() => setKind('local')}>Local command</button>
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" aria-pressed={kind === 'remote'} onClick={() => setKind('remote')}>Remote URL</button>
    </div>
    {kind === 'local' ? <div className="gc-mcp-add">
      <input className="gc-input-well" aria-label="Server name" spellCheck={false} placeholder="Server name" value={name} onChange={(event) => setName(event.target.value)} />
      <input className="gc-input-well" aria-label="Server command" spellCheck={false} placeholder="Executable path or command" value={command} onChange={(event) => setCommand(event.target.value)} />
      <input className="gc-input-well" aria-label="Server arguments as JSON" spellCheck={false} placeholder={'["--path", "/my project"]'} value={args} onChange={(event) => setArgs(event.target.value)} />
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={!loaded || busy || !ready} onClick={() => void add()}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />Add</button>
    </div> : <div className="gc-mcp-add is-remote">
      <input className="gc-input-well" aria-label="Server name" spellCheck={false} placeholder="Server name" value={name} onChange={(event) => setName(event.target.value)} />
      <input className="gc-input-well" aria-label="Server URL" spellCheck={false} type="url" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
      {selectWell('Transport', transport, TRANSPORTS, setTransport)}
      {selectWell('Sign-in', signIn, SIGN_INS, setSignIn)}
      {(signIn === 'bearer' || signIn === 'api_key') && <input className="gc-input-well" aria-label="Token or $VARIABLE" type="password" autoComplete="off" spellCheck={false} placeholder="Token, or $VARIABLE" value={token} onChange={(event) => setToken(event.target.value)} />}
      {signIn === 'api_key' && <input className="gc-input-well" aria-label="API key header" spellCheck={false} placeholder="Header (default X-API-Key)" value={headerName} onChange={(event) => setHeaderName(event.target.value)} />}
      {signIn === 'oauth2' && <><input className="gc-input-well" aria-label="OAuth client ID" spellCheck={false} placeholder="Client ID (optional; registered automatically)" value={clientId} onChange={(event) => setClientId(event.target.value)} />
        <input className="gc-input-well" aria-label="OAuth scopes" spellCheck={false} placeholder="Scopes (optional)" value={scope} onChange={(event) => setScope(event.target.value)} /></>}
      <p>{signIn === 'oauth2' ? 'After adding, use Sign in: your browser opens to the server\'s sign-in page and G-Code keeps the token in ~/.gcode/auth.' : 'A token typed here is saved in ~/.gcode/mcp.json (readable only by you). Write $NAME to read it from that environment variable instead.'}</p>
      <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={!loaded || busy || !ready} onClick={() => void add()}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />Add</button>
    </div>}
    {!loaded ? <div className="gc-feature-empty">{busy ? 'Reading MCP configuration…' : 'Refresh successfully before changing configuration.'}</div> : Object.keys(config.mcpServers).length === 0 ? <div className="gc-feature-empty">No MCP servers configured.</div> : <div className="gc-mcp-list">{Object.entries(config.mcpServers).map(([serverName, server]) => {
      const state = statuses[serverName] ?? { status: 'untested' }
      // A registry entry waiting for its values is disabled. An enabled server may mean an empty value, and it runs.
      const toFill = server.enabled === false ? valuesToFill(server) : []
      const signing = signingIn === serverName
      const inventory = state.status === 'connected' && Array.isArray(state.tools)
        ? [`Tools reported by probe (${state.tools.length}): ${state.tools.length ? state.tools.join(', ') : 'none'}`, typeof state.resources === 'number' ? `${state.resources} resource${state.resources === 1 ? '' : 's'}` : '', state.prompts?.length ? `prompts: ${state.prompts.join(', ')}` : ''].filter(Boolean).join(' · ') : ''
      return <article key={serverName} className="gc-mcp-server">
        <header>
          <div><strong>{serverName}</strong><span>{serverKind(server)}{server.enabled === false ? ' · disabled' : ''}{typeof server.timeoutSeconds === 'number' && !timeoutProblem(server.timeoutSeconds) ? ` · calls up to ${server.timeoutSeconds} s` : ''}</span></div>
          <em className={`gc-mcp-state ${state.status}`}>{state.status === 'checking' ? <i className="gc-spinner" aria-hidden="true" /> : <i className="gc-mcp-state-dot" aria-hidden="true" />}{state.status === 'connected' ? 'probe succeeded' : state.status}</em>
        </header>
        <code>{server.url ?? `${server.command} ${(server.args ?? []).map((arg) => JSON.stringify(arg)).join(' ')}`}</code>
        {timeoutProblem(server.timeoutSeconds) && <p role="alert">{timeoutProblem(server.timeoutSeconds)}</p>}
        {state.error ? <p role="alert">{state.error}</p> : inventory ? <p>{inventory}</p> : <p>{state.status === 'checking' ? 'Checking the server handshake and tool inventory…' : toFill.length ? `Needs filling in before it can run: ${toFill.join('; ')}. Edit ~/.gcode/mcp.json, press Refresh, then enable it.` : server.enabled === false ? 'Disabled: nothing runs until you enable it. The command above is what it will run.' : 'Test the server to read its tool inventory.'}</p>}
        <footer>
          {server.auth?.type === 'oauth2' && <>
            {signing
              ? <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={() => void mcpLoginCancel().catch((failure) => setError(String(failure)))}><X size={14} strokeWidth={1.75} aria-hidden="true" />Cancel sign-in</button>
              : <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy || !!signingIn} onClick={() => void signInTo(serverName, false)}><LogIn size={14} strokeWidth={1.75} aria-hidden="true" />Sign in</button>}
            <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy || signing} onClick={() => void signInTo(serverName, true)}><LogOut size={14} strokeWidth={1.75} aria-hidden="true" />Sign out</button>
          </>}
          <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy || (server.enabled === false && toFill.length > 0)} onClick={() => void setEnabled(serverName, server.enabled === false)}>{server.enabled === false ? 'Enable' : 'Disable'}</button>
          {server.enabled !== false && !toFill.length && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy} onClick={() => void probe(serverName)}>Test connection</button>}
          <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm gc-mcp-remove" disabled={busy || signing} onClick={() => void remove(serverName)}><Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />Remove</button>
        </footer>
      </article>
    })}</div>}
    <section className="gc-mcp-registry" aria-labelledby="mcp-registry-title">
      <h4 id="mcp-registry-title">Find a server</h4>
      <p>Search the official MCP Registry. Its entries are published by third parties and run with your permissions, so an entry is added disabled: check its source and command, then enable it.</p>
      <form className="gc-mcp-search" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <input className="gc-input-well" aria-label="Search the MCP Registry" spellCheck={false} placeholder="filesystem, github, postgres…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="gc-btn gc-btn-ghost gc-btn-sm is-field" disabled={busy}><Search size={14} strokeWidth={1.75} aria-hidden="true" />Search</button>
      </form>
      {results && <>
        {results.source === 'built-in' && <p className="gc-mcp-registry-note">The MCP Registry could not be reached{results.error ? ` (${results.error})` : ''}; these are G-Code's built-in reference servers.</p>}
        {results.entries.length === 0 ? <div className="gc-feature-empty">No servers found.</div> : <ul className="gc-mcp-results">{results.entries.map(entry => {
          const local = entry.packages.some(p => ['npm', 'pypi', 'oci'].includes(p.registryType))
          return <li key={entry.name} className="gc-mcp-server">
            <header><div><strong title={entry.name}>{entry.name}{entry.version ? `@${entry.version}` : ''}</strong><span>{registryKinds(entry)}</span></div></header>
            <p>{entry.description || 'No description.'}{entry.repository && <> · <bdi>{entry.repository}</bdi></>}</p>
            <footer>
              {local && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy || !loaded} onClick={() => void addFromRegistry(entry, false)}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />Add server</button>}
              {entry.remotes.length > 0 && <button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" disabled={busy || !loaded} onClick={() => void addFromRegistry(entry, true)}><Globe size={14} strokeWidth={1.75} aria-hidden="true" />Add remote</button>}
            </footer>
          </li>
        })}</ul>}
      </>}
    </section>
    <DshPlugins cwd={cwd} />
    {/* The runtime MCP servers launch with: a footnote under the list, not above the heading. */}
    <NodeEnvironmentInfo cwd={cwd} />
  </div>
}
