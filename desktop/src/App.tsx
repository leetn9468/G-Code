import { NetworkIncidentDialog, NetworkIncidentNotice } from './components/session/NetworkIncidentDialog'
import { guardEligible } from '../../src/shared/networkGuard'
import { BudgetReachedDialog } from './components/session/BudgetReachedDialog'
import { configuredBudgetModels, useBudgetEnvironment } from './components/settings/SessionBudgetField'
import { normalizeBudget, type BudgetHandoff } from '../../src/shared/sessionBudget'
import { terminalTool } from '../../src/shared/runtimeEvents'
import { SessionControls } from './components/session/SessionControls'
import { ActivityPanel } from './components/session/ActivityPanel'
import { Outputs } from './components/session/Outputs'
import type { SessionPermission } from '../../src/shared/sessionControls'
// G-Code Desktop — project, conversation, and on-demand tools.

import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { AlertCircle, X } from 'lucide-react'
import { MotionConfig } from 'motion/react'
import { isTooltipEscape, TooltipProvider } from './components/shell/Tooltip'
import { TitleBar } from './components/layout/TitleBar'
import { SessionList } from './components/layout/SessionList'
import { SidebarResize } from './components/layout/SidebarResize'
import { sidebarWidth } from './lib/sidebar'
import { ChatArea } from './components/layout/ChatArea'
import { StatusBar } from './components/layout/StatusBar'
import { ProviderSelector } from './components/providers/ProviderSelector'
import { Settings } from './components/settings/Settings'
import type { ProviderName } from './lib/providers'
import { PROVIDER_DEFAULT_MODEL, PROVIDERS } from './lib/providers'
import { localModelLabel } from './lib/localModel'
import { getModelFor, useReloadOnFocus, useSettings } from './lib/settings'
import { useAppearanceTheme } from './lib/theme'
import { createChatWorkspace, isTauri, listSearchableSessions, loadSavedSession, validateWorkingDirectory, type SavedSession } from './lib/tauri'
import { projectName } from './lib/projects'
import { executionBlockReason, type ExecutionEnvironment } from './lib/environments'
import { NewProject } from './components/projects/NewProject'
import { EnvironmentSelector } from './components/environments/EnvironmentSelector'
import { useWorkingDirectory } from './lib/workspace'
import { useSavedSessions } from './lib/useSavedSessions'
import { useSessionStatus } from './lib/sessionStatus'
import { BOOT_SESSION_ID, browseNotice, browseSendBlock, emptyChatView, RUN_OVER_SETTLE_MS, runningChatName, savedChatView, workInProgress, type ChatBrowse } from './lib/chatBrowse'
import { useChatSession } from './components/chat/useChatSession'
import { ToolApproval } from './components/chat/ToolApproval'
import { CommandPalette, type PaletteAction } from './components/shell/CommandPalette'
import { TerminalPanel } from './components/terminal/TerminalPanel'
import { SidePanel, type SideView } from './components/layout/SidePanel'
import { ChangesPanel } from './components/side/ChangesPanel'
import { FilesPanel } from './components/side/FilesPanel'
import { BrowserPanel } from './components/side/BrowserPanel'
import { TasksPanel } from './components/side/TasksPanel'
import { ContextFullDialog } from './components/session/ContextFullDialog'
import { KeepAwakeControl } from './components/layout/KeepAwakeControl'
import { setKeepAwake } from './lib/tauri'

const SESSION_SHORT_ID = 'boot-0000'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('G-Code Desktop failed to render', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 32,
        background: 'var(--background)',
        color: 'var(--text-primary)',
      }}>
        <section role="alert" style={{
          width: 'min(680px, 100%)',
          padding: 20,
          border: '1px solid var(--error)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--error-subtle)',
        }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 16 }}>G-Code Desktop could not render</h1>
          <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)' }}>
            {this.state.error.message || 'An unknown React error occurred.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '7px 10px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--surface-elevated)',
            }}
          >
            Reload app
          </button>
        </section>
      </main>
    )
  }
}

export function App() {
  const { settings, update, reload: reloadSettingsFile, loaded, error: settingsError, notice: settingsNotice, dismissNotice: dismissSettingsNotice } = useSettings()
  useAppearanceTheme(settings.appearance.theme, loaded)
  const [permission, setPermission] = useState<SessionPermission>('default')
  // Right side panel: Terminal, Outputs or the execution environment, one at a
  // time. A pointer click slides it; ⌃`, Escape and the palette are instant
  // (frequency gate, as the sidebar). Hiding the terminal keeps its shells.
  const [sideView, setSideView] = useState<SideView | null>(null)
  const sideViewRef = useRef(sideView)
  sideViewRef.current = sideView
  // The view stays on screen while the panel slides closed.
  const [sideLeaving, setSideLeaving] = useState<SideView | null>(null)
  const sideShown = sideView ?? sideLeaving
  const [sideAnimating, setSideAnimating] = useState(false)
  useEffect(() => {
    if (!sideAnimating) return
    // Fallback for when no slide transition runs (reduced motion, interrupted).
    const timer = window.setTimeout(() => { setSideAnimating(false); setSideLeaving(null) }, 400)
    return () => window.clearTimeout(timer)
  }, [sideAnimating, sideView])
  const [sideFocus, setSideFocus] = useState(0)
  const [terminalFocus, setTerminalFocus] = useState(0)
  const [terminalNew, setTerminalNew] = useState(0)
  const terminalOpen = sideView === 'terminal'
  // Each show hands the view the keyboard: the shell, or the Outputs / environment view.
  const showSide = (view: SideView, slide = false) => {
    setSideAnimating(slide && !sideViewRef.current)
    setSideLeaving(null)
    sideViewRef.current = view
    setSideView(view)
    if (view === 'terminal') setTerminalFocus((value) => value + 1)
    else setSideFocus((value) => value + 1)
  }
  /** Closes the panel; with `only`, just when that view is the one showing. */
  const closeSide = useCallback((only?: SideView, slide = false) => {
    const current = sideViewRef.current
    if (!current || (only && current !== only)) return
    sideViewRef.current = null
    setSideAnimating(slide)
    setSideLeaving(slide ? current : null)
    setSideView(null)
    // After the panel is gone (and after a closing palette restored focus into
    // it), land on the approval tray, the composer, the view's header icon, or
    // (while a reply streams and both are disabled) the Stop button.
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !active.closest('.gc-side-slot')) return
      const next = document.querySelector<HTMLElement>('.gc-approval-tray') ?? document.querySelector<HTMLElement>('.gc-composer textarea:not(:disabled)') ?? document.querySelector<HTMLElement>(`.gc-${current}-trigger:not(:disabled)`) ?? document.querySelector<HTMLElement>('.gc-abort-button')
      next?.focus({ preventScroll: true })
    })
  }, [])
  const toggleSide = (view: SideView, slide = false) => { if (sideViewRef.current === view) closeSide(view, slide); else showSide(view, slide) }
  const newTerminal = () => { setTerminalNew((value) => value + 1); showSide('terminal') }
  const hideTerminal = useCallback((slide = false) => closeSide('terminal', slide), [closeSide])
  const toggleTerminal = () => toggleSide('terminal')
  const [railWidth, setRailWidth] = useState(240)
  useEffect(() => { if (loaded) setRailWidth(sidebarWidth(settings.ui.sidebarWidth)) }, [loaded, settings.ui.sidebarWidth])
  const [providerModalOpen, setProviderModalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // ⌘P and ⌘, open their dialogs without animation (keyboard-initiated, like
  // ⌘K); pointer opens keep the spring. Cleared after close, so the exit of a
  // shortcut-opened dialog is instant too.
  const [shortcutDialog, setShortcutDialog] = useState<'provider' | 'settings' | null>(null)
  useEffect(() => { if (!providerModalOpen && !settingsOpen) setShortcutDialog(null) }, [providerModalOpen, settingsOpen])
  const [projectModalOpen, setProjectModalOpen] = useState(false)
  const [pendingResume, setPendingResume] = useState<{ session: SavedSession; revision: number; provider: ProviderName } | null>(null)
  const navigationRevision = useRef(0)
  const resumedRevision = useRef(0)
  // View only: while a saved chat opens, ChatArea keeps the previous
  // conversation on screen through the moment the session is empty. Any other
  // navigation bumps the revision and ends the hold; so do the resume settling
  // (loaded or failed), an error before it starts, and a fallback timeout.
  const [resumeHold, setResumeHold] = useState<number | null>(null)
  // A chat opened while work is in progress: on screen only. Null when the screen shows the live session.
  const [browsing, setBrowsing] = useState<ChatBrowse | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 900)
  // Only a pointer click on the titlebar toggle slides the sidebar. ⌘B, the
  // palette, launch (saved width) and keyboard resizing change it instantly.
  const [sidebarAnimating, setSidebarAnimating] = useState(false)
  useEffect(() => {
    if (!sidebarAnimating) return
    // Fallback for when no slide transition runs (reduced motion, interrupted).
    const timer = window.setTimeout(() => setSidebarAnimating(false), 400)
    return () => window.clearTimeout(timer)
  }, [sidebarAnimating, sidebarOpen])
  const [settingsTab, setSettingsTab] = useState<'provider' | 'mcp'>('provider')
  const [workspacePickerError, setWorkspacePickerError] = useState<string | null>(null)
  const choosingWorkspace = useRef(false)
  const workspace = useWorkingDirectory(settings.workspace.workingDirectory, loaded)

  const currentProvider = settings.provider.currentProvider
  const currentModel = getModelFor(settings, currentProvider)
  const modelLabel = currentProvider === 'local' ? localModelLabel(settings.provider.localModelPath) : currentModel
  const chat = useChatSession(currentProvider, currentModel, settings.provider.ollamaHost, settings.provider.localModelPath, settings.provider.localRuntimePath, workspace.cwd, settings.execution.environment, permission, settings.effort, settings.provider.localContext, settings.execution.sessionBudget)

  useEffect(() => { if (chat.runtimePermission) setPermission(chat.runtimePermission) }, [chat.runtimePermission])
  // Replacing the live session now would end this work, so opening a chat only changes the screen.
  const liveWork = workInProgress(chat)
  // What the conversation, its panels and its dialogs show. `chat` stays the live session (status lights, keep-awake, the activity panel).
  const view = browsing ? { ...chat, ...browsing.view } : chat
  const viewCwd = browsing ? browsing.cwd : workspace.cwd

  // Background work the Tasks view shows: shells, plus sub-agents and workflows still running.
  const runningTasks = chat.backgroundTasks.filter(task => task.status === 'running').length
    + chat.tools.filter(tool => (tool.name === 'Agent' || tool.name === 'Workflow') && !terminalTool(tool.state)).length
  // Keep the Mac awake while G-Code works (or always, or never). Releasing waits
  // a minute, so the gap between two turns does not let the Mac fall asleep.
  const [pendingBudget, setPendingBudget] = useState<{ handoff: BudgetHandoff; sessionId: string; provider: ProviderName; model: string } | null>(null)
  const budgetContinuing = useRef(false)
  const budgetEnvironment = useBudgetEnvironment()
  const budgetTarget = settings.execution.sessionBudget ? normalizeBudget(settings.execution.sessionBudget).handoffModel : chat.budget?.handoffModel
  const handoffModel = configuredBudgetModels(settings, budgetEnvironment).find(model => model.value === budgetTarget && !model.problem)
  const continueBudget = async () => {
    if (budgetContinuing.current || !handoffModel || !chat.budget?.handoff) return
    budgetContinuing.current = true
    const pending = { handoff: chat.budget.handoff, sessionId: chat.sessionId, provider: handoffModel.provider, model: handoffModel.model }
    chat.setBudgetOpen(false)
    const saved = await update(previous => ({ ...previous, provider: { ...previous.provider, currentProvider: pending.provider, perProviderModel: { ...previous.provider.perProviderModel, [pending.provider]: pending.model } } }))
    if (saved) setPendingBudget(pending)
    else { budgetContinuing.current = false; chat.setBudgetOpen(true) }
  }
  useEffect(() => {
    if (!pendingBudget || currentProvider !== pendingBudget.provider || currentModel !== pendingBudget.model) return
    chat.continueBudget(pendingBudget.handoff, pendingBudget.sessionId)
    setPendingBudget(null)
    budgetContinuing.current = false
  }, [pendingBudget, currentProvider, currentModel, chat.continueBudget])

  const keepAwake = settings.execution.keepAwake
  const wantAwake = keepAwake === 'always' || (keepAwake === 'working' && (chat.streaming || runningTasks > 0))
  const [awake, setAwake] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    if (wantAwake) { void setKeepAwake(true).then(setAwake).catch(() => setAwake(false)); return }
    const timer = window.setTimeout(() => { void setKeepAwake(false).then(setAwake).catch(() => {}) }, keepAwake === 'off' ? 0 : 60_000)
    return () => window.clearTimeout(timer)
  }, [wantAwake, keepAwake])
  // Other views ask the Browser view to show a URL or a project file.
  const [browserRequest, setBrowserRequest] = useState<{ url?: string; path?: string; nonce: number }>()
  const openInBrowser = (target: { url?: string; path?: string }) => { setBrowserRequest(previous => ({ ...target, nonce: (previous?.nonce ?? 0) + 1 })); showSide('browser') }
  // The Files tree reloads when the session writes something.
  const filesRefresh = view.outputs.reduce((latest, output) => Math.max(latest, output.updatedAt), 0)

  const savedChats = useSavedSessions(chat.sessionId, chat.sessionRunning, chat.streaming)
  const errorCount = chat.messages.filter((message) => message.role === 'error').length
  // The context-full question waits for the user like an approval; the session
  // that takes over from a handoff starts its turn without sendTurn.
  // A returned steer's resend starts its turn without sendTurn too.
  const sessionStatus = useSessionStatus(chat.sessionId, chat.streaming, Boolean(chat.approval || chat.contextFull || chat.budget?.phase === 'held' || chat.networkIncident && !chat.networkIncident.decision), errorCount, Boolean(chat.handoffFrom) || chat.resendPending)
  // A reply streams, or the session that takes over from a handoff is starting
  // (from the handoff on, as sendBlockedReason: also the render between the end
  // of the old turn and the takeover's start).
  const busy = chat.streaming || chat.takeover
  // settings.json can change outside the app (the engine reads execution.contextBudget
  // from it each turn): read it again when Settings opens and when the window gets
  // focus. While a turn runs, fields that would restart the session wait for a later read.
  const busyRef = useRef(busy)
  busyRef.current = busy || liveWork
  const reloadSettings = useCallback(() => reloadSettingsFile({ keepSession: busyRef.current }), [reloadSettingsFile])
  useReloadOnFocus(reloadSettings)
  useEffect(() => { if (settingsOpen) void reloadSettings() }, [settingsOpen, reloadSettings])
  // While a turn streams the composer steers it instead of starting another.
  const sendTurn = (text: string) => { if (browsing) return; if (chat.streaming) { void chat.steer(text); return } sessionStatus.beginTurn(); void chat.send(text) }
  // A new chat's file is written only as its first turn gets going, so until
  // the saved list has it the sidebar shows a provisional row (view only) that
  // can carry the running / needs-you light. The saved record replaces it.
  const provisional: SavedSession | null = chat.sessionId !== SESSION_SHORT_ID && workspace.cwd && chat.messages.some((message) => message.role === 'user')
    && !savedChats.sessions.some((session) => session.sessionId === chat.sessionId && session.cwd === workspace.cwd)
    ? { sessionId: chat.sessionId, cwd: workspace.cwd, savedAt: Date.now(), provider: currentProvider, messages: chat.messages.filter((message) => message.role === 'user' || message.role === 'assistant').map(({ id, role, content, timestamp }) => ({ id, role: role as 'user' | 'assistant', content, timestamp })) }
    : null
  const sidebarSessions = provisional ? [provisional, ...savedChats.sessions] : savedChats.sessions
  const abortTurn = () => { sessionStatus.interrupt(); void chat.abort() }
  const clearChat = () => { if (liveWork) { void newChat(); return } sessionStatus.interrupt(); void chat.clear() }
  useEffect(() => { if (paletteOpen) savedChats.refresh() }, [paletteOpen, savedChats.refresh])

  const activeProject = settings.workspace.projects.find((project) => project.path === viewCwd)
  /** Back to the live session, which never stopped. */
  const showRunningChat = () => { navigationRevision.current++; setPendingResume(null); setBrowsing(null) }
  const browseNewChat = (project?: string) => {
    navigationRevision.current++; setPendingResume(null); setWorkspacePickerError(null)
    setBrowsing({ target: { kind: 'new', project }, cwd: project ?? workspace.cwd, view: emptyChatView() })
  }
  const browseSavedChat = async (session: SavedSession) => {
    const revision = ++navigationRevision.current
    setPendingResume(null); setWorkspacePickerError(null)
    try {
      const canonical = await validateWorkingDirectory(session.cwd)
      if (canonical !== session.cwd) throw new Error('The saved working folder has changed. Open its original location to resume safely.')
      const saved = await loadSavedSession(session.sessionId, canonical)
      if (revision !== navigationRevision.current) return
      setBrowsing({ target: { kind: 'saved', session }, cwd: canonical, view: savedChatView(saved, session.sessionId, canonical, currentProvider) })
    } catch (failure) { if (revision === navigationRevision.current) setWorkspacePickerError(String(failure)) }
  }
  const selectProject = async (path: string, register = false, promoted = false) => {
    const revision = ++navigationRevision.current
    setPendingResume(null); setWorkspacePickerError(null)
    if (!promoted && !liveWork) setBrowsing(null)
    try {
      const canonical = await validateWorkingDirectory(path)
      if (revision !== navigationRevision.current) return
      if (liveWork && !promoted) {
        // The settings are what the live session runs from: only the project list changes.
        if (register && !settings.workspace.projects.some((project) => project.path === canonical)) {
          const saved = await update((previous) => ({ ...previous, workspace: { ...previous.workspace, projects: previous.workspace.projects.some((project) => project.path === canonical) ? previous.workspace.projects : [...previous.workspace.projects, { path: canonical, name: projectName(canonical) }] } }))
          if (!saved) throw new Error('The project was opened, but its settings could not be saved.')
          if (revision !== navigationRevision.current) return
        }
        browseNewChat(canonical)
        return
      }
      sessionStatus.interrupt()
      await chat.newSession()
      if (revision !== navigationRevision.current) return
      const saved = await update((previous) => ({ ...previous, workspace: {
        ...previous.workspace, workingDirectory: canonical,
        projects: register && !previous.workspace.projects.some((project) => project.path === canonical)
          ? [...previous.workspace.projects, { path: canonical, name: projectName(canonical) }]
          : previous.workspace.projects,
      } }))
      if (!saved) throw new Error('The project was opened, but its settings could not be saved.')
      workspace.refresh()
    } catch (failure) { if (revision === navigationRevision.current) setWorkspacePickerError(String(failure)) }
  }
  const chooseWorkspace = async () => {
    if (choosingWorkspace.current) return
    if (!isTauri()) { setWorkspacePickerError('Open projects in the desktop app.'); return }
    choosingWorkspace.current = true; setWorkspacePickerError(null)
    try {
      const selected = await open({ title: 'Add an existing project folder', directory: true, multiple: false, defaultPath: workspace.cwd })
      if (typeof selected === 'string') await selectProject(selected, true)
    } catch (error) { setWorkspacePickerError(String(error)) }
    finally { choosingWorkspace.current = false }
  }
  const newRecentChat = async (promoted = false) => {
    if (liveWork && !promoted) { browseNewChat(); return }
    const revision = ++navigationRevision.current
    setPendingResume(null); setWorkspacePickerError(null)
    if (!promoted) setBrowsing(null)
    if (!isTauri()) { setWorkspacePickerError('Create chats in the desktop app.'); return }
    try {
      sessionStatus.interrupt()
      await chat.newSession()
      if (revision !== navigationRevision.current) return
      const path = await createChatWorkspace()
      if (revision !== navigationRevision.current) return
      await update((previous) => ({ ...previous, workspace: { ...previous.workspace, workingDirectory: path } }))
    } catch (failure) { if (revision === navigationRevision.current) setWorkspacePickerError(String(failure)) }
  }
  const newChat = () => {
    if (liveWork) { browseNewChat(activeProject?.path); return Promise.resolve() }
    if (!activeProject) return newRecentChat()
    navigationRevision.current++; setPendingResume(null); setBrowsing(null); sessionStatus.interrupt()
    return chat.newSession()
  }
  const resumeChat = async (session: SavedSession, promoted = false) => {
    if (liveWork && !promoted) {
      if (session.sessionId === chat.sessionId && session.cwd === workspace.cwd) showRunningChat()
      else await browseSavedChat(session)
      return
    }
    const revision = ++navigationRevision.current
    setPendingResume(null); setWorkspacePickerError(null)
    if (!promoted) setBrowsing(null)
    setResumeHold(revision)
    try {
      const canonical = await validateWorkingDirectory(session.cwd)
      if (canonical !== session.cwd) throw new Error('The saved working folder has changed. Open its original location to resume safely.')
      if (revision !== navigationRevision.current) return
      sessionStatus.interrupt()
      await chat.newSession()
      if (revision !== navigationRevision.current) return
      const provider = session.provider && PROVIDERS.includes(session.provider as ProviderName) ? session.provider as ProviderName : currentProvider
      await update((previous) => ({ ...previous, workspace: { ...previous.workspace, workingDirectory: canonical }, provider: { ...previous.provider, currentProvider: provider }, execution: { ...previous.execution, environment: 'local' } }))
      if (revision === navigationRevision.current) setPendingResume({ session, revision, provider })
    } catch (failure) { if (revision === navigationRevision.current) { setWorkspacePickerError(String(failure)); setResumeHold(null) } }
  }
  useEffect(() => {
    if (!pendingResume || pendingResume.revision !== navigationRevision.current || resumedRevision.current === pendingResume.revision) return
    if (workspace.error) { setWorkspacePickerError(workspace.error); setPendingResume(null); setResumeHold(null); return }
    if (workspace.cwd !== pendingResume.session.cwd || currentProvider !== pendingResume.provider || settings.execution.environment !== 'local') return
    resumedRevision.current = pendingResume.revision
    setPendingResume(null)
    void chat.resumeSession(pendingResume.session.sessionId)
  }, [pendingResume, workspace.cwd, workspace.error, currentProvider, settings.execution.environment, chat.resumeSession])
  // chat.resumeSession turns streaming on synchronously and off once the saved
  // chat is in (or failed), so "started for this revision and not streaming"
  // means it has settled.
  const holdingConversation = resumeHold !== null && resumeHold === navigationRevision.current && !(resumedRevision.current === resumeHold && !chat.streaming)
  useEffect(() => {
    if (resumeHold === null) return
    if (!holdingConversation) { setResumeHold(null); return }
    const timer = window.setTimeout(() => setResumeHold(null), 3000)
    return () => window.clearTimeout(timer)
  }, [resumeHold, holdingConversation])
  // The work is over: the chat on screen takes the session through the ordinary open path.
  useEffect(() => {
    if (!browsing || liveWork || browsing.promoting) return
    const timer = window.setTimeout(() => {
      setBrowsing((current) => current && { ...current, promoting: true })
      const { target } = browsing
      if (target.kind === 'saved') void resumeChat(target.session, true)
      else if (target.project) void selectProject(target.project, false, true)
      else void newRecentChat(true)
    }, RUN_OVER_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [browsing, liveWork])
  // The open went through (or has had time to): the overlay gives way to the session it became.
  useEffect(() => {
    if (!browsing?.promoting) return
    const opened = browsing.target.kind === 'saved' ? chat.sessionId === browsing.target.session.sessionId : chat.sessionId === BOOT_SESSION_ID
    if (opened && !chat.streaming) { setBrowsing(null); return }
    const timer = window.setTimeout(() => setBrowsing(null), 5000)
    return () => window.clearTimeout(timer)
  }, [browsing, chat.sessionId, chat.streaming])
  const changeEnvironment = (environment: ExecutionEnvironment) => {
    if (busy || browsing) return
    navigationRevision.current++; setPendingResume(null); sessionStatus.interrupt()
    void update((previous) => ({ ...previous, execution: { ...previous.execution, environment } }))
  }

  // Keyboard shortcuts. Handover §6.6. The context-full question is a modal
  // dialog too: its Escape means Stop (the dialog answers it), not abortTurn.
  const contextFullOpen = Boolean(view.contextFull)
  const modalOpen = providerModalOpen || settingsOpen || paletteOpen || projectModalOpen || contextFullOpen || view.budgetOpen || view.networkOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.isComposing) return
      // ⌃` toggles the terminal (OpenCode / VS Code binding, by key position)
      // and ⌃⌥T opens another. They work while a tool approval waits (the tray
      // is not modal: checking something in a shell first is the point), not
      // over a modal dialog. The side panel is not modal either.
      const terminalKey = e.ctrlKey && !e.metaKey && (e.code === 'Backquote' || (e.altKey && e.code === 'KeyT'))
      if (terminalKey && !modalOpen) {
        e.preventDefault()
        if (e.code === 'Backquote') toggleTerminal(); else newTerminal()
        return
      }
      if (modalOpen || view.approval) {
        if (['p', 'k', 'n', 'o', ',', '/', 'b', 'enter', 'l', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) e.preventDefault()
        return
      }
      const target = e.target as Element | null
      // Inside the terminal, ⌃ keys belong to the shell.
      if (target?.closest?.('.gc-terminal-panel') && !e.metaKey) return
      // Anywhere in the side panel, ⌘↩/⌘↑/⌘↓/⌘L act on the chat composer, not here (⌘↑/⌘↓ still scroll the Outputs list).
      if (target?.closest?.('.gc-side-slot') && ['enter', 'arrowup', 'arrowdown', 'l'].includes(e.key.toLowerCase())) return
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setShortcutDialog('provider'); setProviderModalOpen(true) }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setPaletteOpen(true) }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void newChat() }
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); void chooseWorkspace() }
      if (e.key === ',') { e.preventDefault(); setShortcutDialog('settings'); setSettingsOpen(true) }
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setSidebarOpen((value) => !value) }
      if (e.key === 'Enter') { e.preventDefault(); document.dispatchEvent(new Event('gcode-send')) }
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); clearChat() }
      if (e.key === 'ArrowUp') { e.preventDefault(); document.dispatchEvent(new CustomEvent('gcode-history', { detail: 'previous' })) }
      if (e.key === 'ArrowDown') { e.preventDefault(); document.dispatchEvent(new CustomEvent('gcode-history', { detail: 'next' })) }
    }
    const onEscape = (e: KeyboardEvent) => {
      // Escape in the side panel closes Outputs / the environment view, or belongs to the shell.
      // Not while a message is being written in the composer (it stays usable during a turn).
      const target = e.target as (Element & { value?: unknown }) | null
      if (target?.tagName === 'TEXTAREA' && target.closest?.('.gc-composer') && String(target.value ?? '').trim()) return
      if (e.key === 'Escape' && (!e.defaultPrevented || isTooltipEscape(e)) && !target?.closest?.('.gc-side-slot') && view.streaming && !view.approval && !modalOpen) { e.preventDefault(); abortTurn() }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onEscape)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('keydown', onEscape) }
  }, [chat, view, liveWork, providerModalOpen, settingsOpen, paletteOpen, projectModalOpen, modalOpen, settings, activeProject, sideView])

  const handleProviderSwitch = (p: ProviderName, closeSelector = true) => {
    void update((previous) => ({ ...previous, provider: { ...previous.provider, currentProvider: p } }))
    if (closeSelector) setProviderModalOpen(false)
  }

  const handleModelChange = (provider: ProviderName, model: string) => {
    void update((previous) => ({
      ...previous,
      provider: { ...previous.provider, perProviderModel: { ...previous.provider.perProviderModel, [provider]: model } },
    }))
  }

  const handleApiKeyChange = async (provider: Exclude<ProviderName, 'ollama' | 'local'>, apiKey: string) => {
    await update((previous) => ({
      ...previous,
      provider: { ...previous.provider, apiKeys: { ...previous.provider.apiKeys, [provider]: apiKey } },
    }))
  }

  const handleOllamaHostChange = (ollamaHost: string) => {
    void update((previous) => ({ ...previous, provider: { ...previous.provider, ollamaHost } }))
  }

  const handleLocalPathChange = (field: 'localModelPath' | 'localRuntimePath', path: string) => {
    void update((previous) => ({ ...previous, provider: { ...previous.provider, [field]: path } }))
  }

  const paletteActions: PaletteAction[] = [
    { id: 'new-project', name: 'New project', section: 'Project', run: () => setProjectModalOpen(true) },
    { id: 'environment', name: 'Choose execution environment', section: 'Navigation', run: () => showSide('environment') },
    { id: 'recent-chat', name: 'New chat outside projects', section: 'Chat', run: () => void newRecentChat() },
    { id: 'project', name: 'Open project folder', section: 'Project', shortcut: '⌘O', run: () => void chooseWorkspace() },
    { id: 'provider', name: 'Switch provider', section: 'Navigation', shortcut: '⌘P', run: () => setProviderModalOpen(true) },
    { id: 'settings', name: 'Open settings', section: 'Navigation', shortcut: '⌘,', run: () => { setSettingsTab('provider'); setSettingsOpen(true) } },
    { id: 'clear', name: 'Clear chat and start new session', section: 'Chat', shortcut: '⌘L', run: clearChat },
    { id: 'new', name: 'New session', section: 'Session', shortcut: '⌘N', run: () => void newChat() },
    { id: 'sidebar', name: 'Toggle sidebar', section: 'Navigation', shortcut: '⌘B', run: () => setSidebarOpen((value) => !value) },
    { id: 'mcp', name: 'Manage MCP servers', section: 'Tools', run: () => { setSettingsTab('mcp'); setSettingsOpen(true) } },
    { id: 'terminal', name: terminalOpen ? 'Hide terminal' : 'Show terminal', section: 'Tools', shortcut: '⌃`', run: toggleTerminal },
    { id: 'terminal-new', name: 'New terminal', section: 'Tools', shortcut: '⌃⌥T', run: newTerminal },
    { id: 'changes', name: 'Show changes', section: 'Tools', run: () => showSide('changes') },
    { id: 'files', name: 'Show files', section: 'Tools', run: () => showSide('files') },
    { id: 'browser', name: 'Show browser', section: 'Tools', run: () => showSide('browser') },
    { id: 'tasks', name: 'Show background tasks', section: 'Tools', run: () => showSide('tasks') },
  ]

  const runningName = runningChatName(chat.messages)
  const needsAnswer = Boolean(chat.approval || chat.contextFull)

  if (!loaded) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 12,
      }}>
        Loading…
      </div>
    )
  }

  return (
    <MotionConfig reducedMotion="user">
    <TooltipProvider>
    <div className="gc-app" style={{
      '--fs-chat': `${settings.appearance.chatFontSize}px`,
      '--sidebar-width': `${railWidth}px`,
    } as CSSProperties}>
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={(source) => { setSidebarAnimating(source === 'pointer'); setSidebarOpen((value) => !value) }} />

      {/* Bare drag region: only the canvas gaps around the panel (its padding) drag the window. */}
      <div className={`gc-workbench${sidebarOpen ? '' : ' is-sidebar-hidden'}${sidebarAnimating ? ' is-sidebar-animating' : ''}${sideAnimating ? ' is-side-animating' : ''}`} data-tauri-drag-region>
        <div id="session-sidebar" className={`gc-sidebar-slot${sidebarOpen ? '' : ' is-closed'}`} aria-hidden={!sidebarOpen || undefined} onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === 'width') setSidebarAnimating(false) }}>
          <div className="gc-sidebar-clip"><SessionList activityPanel={<ActivityPanel modelRuntime={chat.modelRuntime} metrics={chat.inferenceMetrics} tools={chat.tools} streaming={chat.streaming} activity={chat.activity} cwd={workspace.cwd} approval={chat.approval} permission={permission} errorCount={errorCount} sessionRunning={chat.sessionRunning} environment={settings.execution.environment}/>} cwd={viewCwd} projects={settings.workspace.projects} sessions={sidebarSessions} loading={savedChats.loading} error={savedChats.error ?? savedChats.unreadable} deleting={savedChats.deleting} onRefresh={savedChats.refresh} onDelete={savedChats.remove} currentSessionId={view.sessionId} runningSessionId={liveWork ? chat.sessionId : undefined} statusOf={(id) => sessionStatus.statusOf(id, id === chat.sessionId)} onNew={() => void newChat()} onNewRecent={() => void newRecentChat()} onResume={(session) => { if (session === provisional) { if (browsing) showRunningChat() } else void resumeChat(session) }} onSelectProject={(path) => void selectProject(path)} onNewProject={() => setProjectModalOpen(true)} onOpenSearch={() => setPaletteOpen(true)} onOpenSettings={() => { setSettingsTab('provider'); setSettingsOpen(true) }} onOpenMcp={() => { setSettingsTab('mcp'); setSettingsOpen(true) }} /></div>
          {sidebarOpen && <SidebarResize width={railWidth} onChange={setRailWidth} onCommit={width => void update(previous => ({ ...previous, ui: { ...previous.ui, sidebarWidth: width } }))}/>}
        </div>
        <main className="gc-main-panel">
          {(browsing && !browsing.promoting || settingsError || settingsNotice || workspacePickerError || workspace.error || chat.handoffNotices.length > 0) && <div className="gc-shell-alerts">
            {browsing && !browsing.promoting && <div role="status" className="gc-shell-alert gc-browse-notice"><span>{browseNotice(runningName, needsAnswer)}</span><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={showRunningChat}>Open</button><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={abortTurn}>Stop</button></div>}
            {settingsNotice && <div role="status" className="gc-shell-alert"><span>{settingsNotice}</span><button type="button" className="gc-btn gc-btn-ghost gc-btn-sm" onClick={dismissSettingsNotice}>Dismiss</button></div>}
            {settingsError && <div role="alert" className="gc-shell-alert"><AlertCircle size={15} /><span>{settingsError}</span></div>}
            {workspacePickerError && <div role="alert" className="gc-shell-alert"><AlertCircle size={15} /><span>{workspacePickerError}</span></div>}
            {workspace.error && workspace.error !== workspacePickerError && <div role="alert" className="gc-shell-alert"><AlertCircle size={15} /><span>{workspace.error}</span></div>}
            {/* Out of the conversation, so opening another chat cannot erase where a handoff is saved; one per handoff that did not continue. */}
            {chat.handoffNotices.map((notice) => <div key={notice.path} role="alert" className="gc-shell-alert gc-handoff-notice"><AlertCircle size={15} /><span>{notice.message}</span><button type="button" className="gc-btn-icon" style={{ width: 24, height: 24, margin: '-2px -6px -2px 0' }} aria-label="Dismiss handoff notice" onClick={() => chat.dismissHandoffNotice(notice.path)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button></div>)}
          </div>}
        <ChatArea
          onOutputs={(event) => toggleSide('outputs', event.detail > 0)}
          outputCount={view.outputs.length}
          sideView={sideView}
          onTerminal={(event) => toggleSide('terminal', event.detail > 0)}
          onSidePanel={(view, event) => toggleSide(view, event.detail > 0)}
          changeCount={view.outputs.length}
          runningTaskCount={browsing ? 0 : runningTasks}
          sessionControls={<>{settings.execution.networkGuard?.enabled && !guardEligible(currentProvider, settings.provider.ollamaHost) && <p className="gc-controls-note">Guillotine Mode paused · Cloud models need network access.</p>}{view.networkIncident && <NetworkIncidentNotice incident={view.networkIncident} onReview={() => chat.setNetworkOpen(true)}/>}<SessionControls budget={view.budget} onBudget={() => chat.setBudgetOpen(true)} effort={settings.effort} permission={permission} provider={currentProvider} model={currentModel} disabled={busy || Boolean(browsing)} context={view.context} hasMessages={view.messages.some(m => m.role === 'user')} onEffort={effort => void update(previous => ({ ...previous, effort }))} onPermission={setPermission} onCompact={focus => sendTurn(`/compact ${focus}`.trim())}/></>}
          provider={currentProvider}
          model={modelLabel}
          messages={view.messages}
          tools={view.tools}
          streaming={view.streaming}
          activity={view.activity}
          cwd={viewCwd}
          projectLabel={activeProject?.name || (viewCwd ? 'Recents' : undefined)}
          environment={settings.execution.environment}
          onEnvironmentClick={(event) => toggleSide('environment', event.detail > 0)}
          onOpenProject={() => void chooseWorkspace()}
          onProviderClick={browsing ? undefined : () => setProviderModalOpen(true)}
          sendDisabledReason={browsing ? browseSendBlock(runningName, Boolean(browsing.promoting)) : chat.sendBlockedReason || executionBlockReason(settings.execution.environment) || (!workspace.cwd ? workspace.checking ? 'Checking project folder…' : 'Open a project folder (⌘O) before sending.' : (currentProvider === 'local' || currentProvider === 'ollama') && !currentModel ? 'Choose a local model in Provider (⌘P) before sending.' : undefined)}
          history={view.history}
          onSend={sendTurn}
          onNewChat={() => void newChat()}
          onResumeSession={browsing ? undefined : id => void chat.resumeSession(id)}
          onAbort={abortTurn}
          draft={chat.draft}
          approval={<ToolApproval cwd={workspace.cwd} request={view.approval} queue={view.approvalQueue} onRespond={(allowed, allowAll, timedOut, scope) => void chat.respond(allowed, allowAll, timedOut, scope)} />}
          // While the session that takes over from a handoff starts, the handed-off conversation stays on screen (not the welcome page) until the continuation replaces it.
          holdConversation={!browsing && (holdingConversation || chat.takeover)}
        />
        </main>
        <SidePanel open={sideView !== null} focusRequest={sideFocus} onClose={() => closeSide()} onSlideEnd={() => { setSideAnimating(false); setSideLeaving(null) }}>
          <TerminalPanel open={terminalOpen} shown={sideShown === 'terminal'} cwd={viewCwd} cwdPending={workspace.checking} focusRequest={terminalFocus} newRequest={terminalNew} onHide={hideTerminal} />
          <Outputs open={sideShown === 'outputs'} onClose={(slide) => closeSide('outputs', slide)} outputs={view.outputs} cwd={viewCwd} sessionId={view.sessionId}/>
          <ChangesPanel open={sideShown === 'changes'} onClose={(slide) => closeSide('changes', slide)} outputs={view.outputs} cwd={viewCwd} sessionId={view.sessionId}/>
          <FilesPanel open={sideShown === 'files'} onClose={(slide) => closeSide('files', slide)} cwd={viewCwd} refreshKey={filesRefresh} onOpenInBrowser={(path) => openInBrowser({ path })}/>
          <BrowserPanel open={sideShown === 'browser'} onClose={(slide) => closeSide('browser', slide)} cwd={viewCwd} tasks={view.backgroundTasks} request={browserRequest}/>
          <TasksPanel open={sideShown === 'tasks'} onClose={(slide) => closeSide('tasks', slide)} tasks={view.backgroundTasks} tools={view.tools} workflowRuns={view.workflowRuns} onStop={(id) => void chat.stopTask(id)} onOpenUrl={(url) => openInBrowser({ url })}/>
          <EnvironmentSelector open={sideShown === 'environment'} current={settings.execution.environment} busy={busy || Boolean(browsing)} takeover={view.takeover} onClose={(slide) => closeSide('environment', slide)} onChange={changeEnvironment} />
        </SidePanel>
      </div>

      <StatusBar
        projectLabel={activeProject?.name || (viewCwd ? 'Recents' : undefined)}
        sessionShortId={view.sessionId === 'boot-0000' ? SESSION_SHORT_ID : view.sessionId.slice(0, 8)}
        cwd={viewCwd || settings.workspace.workingDirectory || ''}
        sessionRunning={view.sessionRunning}
        onOpenProject={() => void chooseWorkspace()}
        streaming={view.streaming}
        turnCount={view.history.length}
        toolCallCount={view.tools.length}
        errorCount={view.messages.filter((message) => message.role === 'error').length}
        // The live session's local model only: not beside another chat opened for reading, never for a cloud model.
        generationSpeed={!browsing && currentProvider === 'local' ? chat.generationSpeed : null}
        keepAwakeControl={<KeepAwakeControl value={keepAwake} active={awake} onChange={value => void update(previous => ({ ...previous, execution: { ...previous.execution, keepAwake: value } }))}/>}
      />

      <ProviderSelector
        open={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        currentProvider={currentProvider}
        onSwitch={handleProviderSwitch}
        perProviderModel={settings.provider.perProviderModel}
        apiKeys={settings.provider.apiKeys}
        onModelChange={handleModelChange}
        localModelPath={settings.provider.localModelPath}
        localRuntimePath={settings.provider.localRuntimePath}
        localContext={settings.provider.localContext}
        onLocalContextChange={(localContext) => { void update(previous => ({ ...previous, provider: { ...previous.provider, localContext } })) }}
        onLocalModelPathChange={(path) => handleLocalPathChange('localModelPath', path)}
        onLocalRuntimePathChange={(path) => handleLocalPathChange('localRuntimePath', path)}
        ollamaHost={settings.provider.ollamaHost}
        onOllamaHostChange={handleOllamaHostChange}
        onApiKeyChange={handleApiKeyChange}
        getDefaultModel={(p) => PROVIDER_DEFAULT_MODEL[p]}
        sessionHasMessages={chat.history.length > 0}
        instant={shortcutDialog === 'provider'}
      />

      <NetworkIncidentDialog incident={view.networkIncident} open={view.networkOpen} onClose={() => chat.setNetworkOpen(false)} onDecision={choice => void chat.decideNetwork(choice)}/>
      <BudgetReachedDialog budget={view.budget} open={view.budgetOpen} model={handoffModel?.label} onContinue={() => void continueBudget()} onAdd={usd => void chat.addBudget(usd)} onClose={() => chat.setBudgetOpen(false)} />
      <Settings
        budgetEnvironment={budgetEnvironment}
        cwd={viewCwd}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={(patch) => update(patch)}
        initialTab={settingsTab}
        instant={shortcutDialog === 'settings'}
      />

      <ContextFullDialog request={view.contextFull} onChoose={choice => void chat.answerContextFull(choice)} />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} sessions={savedChats.sessions} loading={savedChats.loading} error={savedChats.error} onResume={(session) => void resumeChat(session)} loadSearchable={listSearchableSessions} />

      <NewProject open={projectModalOpen} onClose={() => setProjectModalOpen(false)} onCreated={(path) => selectProject(path, true)} onAddExisting={chooseWorkspace} />
    </div>
    </TooltipProvider>
    </MotionConfig>
  )
}
