import { usableSavedSession } from './savedRecord'
import type { ContextStatus, SessionOutput, SessionTool } from '../../../src/shared/sessionControls'
import type { DshSettings, DshProbe } from './dshConfig'
import { tokenCalibration, type TokenCalibration } from '../../../src/shared/tokenCalibration'
// Thin wrappers around the Tauri v2 IPC surface exposed by src-tauri/src/lib.rs.
// Keeps every `invoke()` call in one file so consumers stay type-safe.

import { executionBlockReason, type ExecutionEnvironment } from './environments'
import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { ToolApprovalRequest } from '../components/chat/types'

/** Who asks, when it is not the main conversation: a workflow's agent or a sub-agent, with its display label. */
export interface ApprovalOrigin { kind: 'workflow' | 'agent'; label: string; runId?: string; agentId?: string }

export interface DesktopToolApprovalRequest extends ToolApprovalRequest {
  requestId: string
  suggestedRule?: string
  projectRoot?: string
  workflowSource?: { kind: 'inline' | 'session' | 'project' | 'global'; path?: string }
  /** Set on a workflow agent's request (CLIs from before `origin` send only these two). */
  runId?: string
  agentId?: string
  network?: { hosts: string[]; scope: 'call' | 'session' }
  origin?: ApprovalOrigin
}

// The existing send_message IPC carries explicit, escaped frames. Ordinary
// input is always wrapped too, so pasted frame text cannot become a command.
const inputFrame = (payload: unknown) => `\x1e${JSON.stringify(payload)}\x1e`

export interface ProviderEnvStatus {
  anthropic: boolean
  openai: boolean
  gemini: boolean
  deepseek: boolean
  qwen: boolean
  auto: string | null   // ProviderName, or null if none configured
}

export interface OllamaStatus {
  running: boolean
  host: string
  model_count: number | null
  models: string[]
  error: string | null
}

export async function getProviderEnvStatus(): Promise<ProviderEnvStatus> {
  return invoke<ProviderEnvStatus>('get_env_status')
}

export interface NodeEnvironment { version: string | null; path: string | null; builtIn: boolean }
export async function getNodeEnvironment(cwd?: string): Promise<NodeEnvironment> {
  return invoke<NodeEnvironment>('get_node_environment', { cwd })
}

export async function checkOllamaRunning(host?: string): Promise<OllamaStatus> {
  return invoke<OllamaStatus>('check_ollama', { host })
}

export async function loadSettings<T = Record<string, unknown>>(): Promise<T> {
  return invoke<T>('read_settings')
}

export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  return invoke('write_settings', { settings })
}

export interface PermissionSnapshot { rules: import('../../../src/shared/permissionRules').PermissionFile; projectRoot?: string | null }
export async function readPermissions(cwd?: string): Promise<PermissionSnapshot> { return invoke('read_permissions', { cwd }) }
export async function changePermission(rule: string, deny: boolean, remove: boolean, cwd?: string): Promise<PermissionSnapshot> { return invoke('change_permission', { rule, deny, remove, cwd }) }

export async function copyToClipboard(text: string): Promise<void> {
  return writeText(text)
}

export async function startSession(provider: string, model: string, cwd: string, resumeId?: string, ollamaHost?: string, localModelPath?: string, localRuntimePath?: string, executionEnvironment: ExecutionEnvironment = 'local', localContext?: number, calibration?: TokenCalibration, handoffSessionId?: string): Promise<number> {
  const blocked = executionBlockReason(executionEnvironment)
  if (blocked) throw new Error(blocked)
  return invoke<number>('start_session', { provider, model, resumeId, ollamaHost, localModelPath, localRuntimePath, localContext, contextCalibration: resumeId ? undefined : tokenCalibration(calibration, model), handoffSessionId: resumeId ? undefined : handoffSessionId, cwd, executionEnvironment })
}

export async function validateWorkingDirectory(path: string): Promise<string> { return invoke('validate_working_directory', { path }) }

export interface SavedSession {
  sessionId: string
  cwd: string
  /** In a list, only what a row shows: the first user message. A chat loads whole when it is opened. */
  messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number; metadata?: Record<string, unknown> }>
  /** How many messages the saved chat has, when `messages` holds only part of them. */
  messageCount?: number
  savedAt: number
  sessionContext?: { turn_count?: number; tool_call_count?: number; error_count?: number }
  provider?: string
  permissionContext?: { mode: import('../../../src/shared/sessionControls').SessionPermission }
  contextStatus?: ContextStatus
  networkHold?: import('../../../src/shared/networkGuard').NetworkHold
  budget?: import('../../../src/shared/sessionBudget').SessionBudget
  usageTotals?: import('../../../src/shared/usageTotals').UsageTotals
  outputs?: SessionOutput[]
  toolHistory?: SessionTool[]
}

export async function listAllSavedSessions(): Promise<SavedSession[]> { return (await invoke<SavedSession[]>('list_all_sessions')).map(usableSavedSession) }
/** The text of every chat, for search while it is open. */
export async function listSearchableSessions(): Promise<SavedSession[]> { return (await invoke<SavedSession[]>('list_searchable_sessions')).map(usableSavedSession) }
/** Records and project folders the last list left out because they could not be read. */
export async function unreadableSessionCount(): Promise<number> { return invoke('unreadable_session_count') }
export async function createProject(parent: string, name: string): Promise<string> { return invoke('create_project', { parent, name }) }
export async function createChatWorkspace(): Promise<string> { return invoke('create_chat_workspace') }
export async function loadSavedSession(id: string, cwd: string): Promise<SavedSession> { return usableSavedSession(await invoke<SavedSession>('load_session', { id, cwd })) }
/** Deletes a chat and its data. Resolves with what stays for a reason of its own, if anything. */
export async function deleteSavedSession(id: string, cwd: string): Promise<string | null> { return invoke('delete_session', { id, cwd }) }
export async function readMcpConfig<T>(): Promise<T> { return invoke('read_mcp_config') }
/** Writes under the lock `gcode mcp` takes. `base`: the file as it was read, so a change made elsewhere since then survives. Resolves with the file as written. */
export async function writeMcpConfig<T>(config: T, base?: T): Promise<T | undefined> { return invoke('write_mcp_config', { config, base }) }
export async function testMcpConnection(serverName: string): Promise<{ status: string; error?: string; tools?: string[]; resources?: number; prompts?: string[] }> { return invoke('test_mcp_connection', { serverName }) }
/** One entry of the official MCP Registry (or of G-Code's built-in list when it cannot be reached), as `gcode mcp search --json` gives it. */
export interface McpRegistryEntry { name: string; description: string; version?: string; repository?: string; packages: Array<{ registryType: string; identifier: string; version?: string }>; remotes: Array<{ type: 'streamable-http' | 'sse'; url: string }> }
export async function mcpRegistrySearch(query: string): Promise<{ entries: McpRegistryEntry[]; source: 'official' | 'built-in'; error?: string }> { return invoke('mcp_registry_search', { query }) }
/** Adds a registry entry as server `name` (its remote endpoint with `remote`); returns what the CLI said. */
export async function mcpRegistryAdd(name: string, registryName: string, remote: boolean): Promise<string> { return invoke('mcp_registry_add', { name, registryName, remote }) }
export async function mcpLogin(serverName: string): Promise<string> { return invoke('mcp_login', { serverName }) }
/** Stops the sign-in that is waiting; mcpLogin then resolves with what to tell the user. */
export async function mcpLoginCancel(): Promise<void> { return invoke('mcp_login_cancel') }
export async function mcpLogout(serverName: string): Promise<string> { return invoke('mcp_logout', { serverName }) }
export async function readDshSettings(): Promise<{ dsh: unknown; guillotine: boolean }> { return invoke('read_dsh_settings') }
export async function writeDshSettings(config: DshSettings): Promise<void> { return invoke('write_dsh_settings', { config }) }
export async function dshStatus(cwd: string): Promise<DshProbe> { return invoke('dsh_status', { cwd }) }
export async function dshInstall(cwd?: string): Promise<string> { return invoke('dsh_install', { cwd: cwd ?? null }) }

/** `attachments`: absolute paths of files attached to the message (see src/shared/attachments.ts). */
export async function sendMessage(text: string, attachments: ReadonlyArray<string> = []): Promise<void> {
  return invoke('send_message', { text: inputFrame({ type: 'message', text, ...(attachments.length ? { attachments } : {}) }) })
}

/** A picked, dropped or pasted file as the composer learns it (desktop/src-tauri/src/attachments.rs). */
export interface AttachmentInfo {
  path: string
  name: string
  kind: 'image' | 'file'
  bytes: number
  mediaType?: string
  /** The whole image as base64 (images up to 8 MB), for a thumbnail. */
  preview?: string
  /** Why it cannot be attached. */
  problem?: string
}

export async function inspectAttachments(paths: string[]): Promise<AttachmentInfo[]> {
  return invoke<AttachmentInfo[]>('inspect_attachments', { paths })
}

/** Saves pasted image bytes (base64) as a file of the user's own and returns it as an attachment. */
export async function savePastedImage(data: string): Promise<AttachmentInfo> {
  return invoke<AttachmentInfo>('save_pasted_image', { data })
}

/** Deletes a pasted image removed from the composer before it was sent (only files savePastedImage made). */
export async function discardPastedImage(path: string): Promise<void> {
  return invoke('discard_pasted_image', { path })
}

/** Text for the running turn: the CLI adds it at the next safe point, or returns it (a 'steer' event says which). */
export async function sendSteer(id: string, text: string): Promise<void> {
  return invoke('send_message', { text: inputFrame({ type: 'steer', id, text }) })
}

export async function stopSession(): Promise<void> {
  return invoke('stop_session')
}

export async function respondToolApproval(requestId: string, allowed: boolean, _allowAll: boolean, networkScope?: 'call' | 'session'): Promise<void> {
  if (!requestId) throw new Error('Approval requires requestId')
  return invoke('send_message', { text: inputFrame({ type: 'approval', requestId, allowed, ...(networkScope ? { networkScope } : {}) }) })
}

/**
 * Detect whether we're running inside the Tauri shell. Used to skip IPC calls
 * during pure-Vite dev (bun run dev without `tauri dev`).
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export interface LocalModelStatus {
  metadata?: { trained_context: number; max_context: number } | null
  applied_context?: number | null
  context_reason?: string | null
  model_path: string | null
  runtime_path: string | null
  ready: boolean
  error: string | null
}

export async function checkLocalModel(modelPath?: string, runtimePath?: string): Promise<LocalModelStatus> {
  return invoke<LocalModelStatus>('check_local_model', { modelPath, runtimePath })
}

/** A saved output version (versionId, or BASELINE_VERSION), or the file as it is now; `absent` when that file did not exist. */
export async function readSessionOutput(cwd: string, sessionId: string, path: string, versionId?: string): Promise<FilePreview> { return invoke('read_session_output', { cwd, sessionId, path, versionId }) }
export async function openBrowserTrace(cwd: string, sessionId: string, path: string, versionId?: string): Promise<void> { return invoke('open_browser_trace', { cwd, sessionId, path, versionId }) }
export async function closeBrowserTrace(): Promise<void> { return invoke('close_browser_trace') }
export async function browserMcpPreset(): Promise<import('./mcpConfig').McpServer> { return invoke('browser_mcp_preset') }

// ---------------------------------------------------------------------------
// Side panel: Files, Changes, Browser, Tasks, keep-awake, provider models.
// ---------------------------------------------------------------------------

/** A file's preview: text (first 256 KB), an image data URL, a binary notice, or absent (did not exist). */
export interface FilePreview { content: string; bytes: number; truncated: boolean; binary: boolean; imageDataUrl?: string; absent?: boolean }
export interface DirectoryEntry { name: string; path: string; dir: boolean; link: boolean; size?: number | null; modified?: number | null }
export interface DirectoryListing { path: string; entries: DirectoryEntry[]; truncated: boolean }

/** One folder level inside the project (path omitted: the project root). */
export async function listDirectory(cwd: string, path?: string): Promise<DirectoryListing> { return invoke('list_directory', { cwd, path }) }
export async function readProjectFile(cwd: string, path: string): Promise<FilePreview> { return invoke('read_project_file', { cwd, path }) }
/** Opens a project file in its default app; programs and scripts are refused (use revealPath). */
export async function openPath(cwd: string, path: string): Promise<void> { return invoke('open_path', { cwd, path }) }
/** Selects a project file or folder in Finder. */
export async function revealPath(cwd: string, path: string): Promise<void> { return invoke('reveal_path', { cwd, path }) }
/** The file at the last commit (git projects only); `absent` when it was not committed. */
export async function gitHeadFile(cwd: string, path: string): Promise<FilePreview> { return invoke('git_head_file', { cwd, path }) }
/** Output version 'baseline' is the file before the session first changed it. */
export const BASELINE_VERSION = 'baseline'

/** Holds off system sleep (caffeinate); resolves to whether it is now held. */
export async function setKeepAwake(active: boolean): Promise<boolean> { return invoke('set_keep_awake', { active }) }

/** Serves a project folder (default: the project root) on 127.0.0.1 and returns its address. */
export async function previewServe(cwd: string, folder?: string): Promise<string> { return invoke('preview_serve', { cwd, folder }) }
export async function previewStop(): Promise<void> { return invoke('preview_stop') }
/** Whether anything answers at an http(s) address, and whether the page forbids being framed. */
export async function probeUrl(url: string): Promise<{ reachable: boolean; status?: number; frameBlocked?: boolean; error?: string }> { return invoke('probe_url', { url }) }

export interface ProviderModel { id: string; name?: string | null }
/** The models this provider's saved key can use (asked from the provider's API). */
export async function listProviderModels(provider: string): Promise<ProviderModel[]> { return invoke('list_provider_models', { provider }) }
/** Sends one tiny real request ("Reply with OK."). */
export async function testProvider(provider: string, model: string): Promise<{ model: string; reply: string; ms: number }> { return invoke('test_provider', { provider, model }) }

/** Answers the CLI's context-full question. */
export async function respondContextFull(requestId: string, choice: import('../../../src/shared/execution').ContextFullChoice): Promise<void> {
  return invoke('send_message', { text: inputFrame({ type: 'context-choice', requestId, choice }) })
}
/** Stops a background shell task. */
export async function stopBackgroundTask(id: string): Promise<void> {
  return invoke('send_message', { text: inputFrame({ type: 'task-control', id, action: 'stop' }) })
}

export interface IncidentSummary { id: string; at: number; model: string | { provider: string; name: string }; destination: string; decision?: string }
/** The incidents, and how many folders could not be read and are not among them. */
export async function listNetworkIncidents(): Promise<{ rows: IncidentSummary[]; unreadable: number }> {
  if (!isTauri()) return { rows: [], unreadable: 0 }
  const reply = await invoke<IncidentSummary[] | { rows: IncidentSummary[]; unreadable: number }>('list_network_incidents')
  return Array.isArray(reply) ? { rows: reply, unreadable: 0 } : reply
}
export async function readNetworkEvidence(id: string): Promise<string> { return invoke('read_network_evidence', { id }) }
export async function revealNetworkIncident(id: string): Promise<void> { return invoke('reveal_network_incident', { id }) }
export async function deleteNetworkIncident(id: string): Promise<void> { return invoke('delete_network_incident', { id, confirmed: true }) }
