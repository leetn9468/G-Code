export const EFFORTS = ['low', 'medium', 'high', 'extra', 'max'] as const
export type Effort = typeof EFFORTS[number]
export const PERMISSIONS = ['default', 'plan', 'acceptEdits', 'auto', 'bypass'] as const
export type SessionPermission = typeof PERMISSIONS[number]
export const PERMISSION_LABELS: Record<SessionPermission, string> = { default: 'Manual', plan: 'Plan', acceptEdits: 'Accept edits', auto: 'Auto', bypass: 'Bypass' }
export const PERMISSION_DETAILS: Record<SessionPermission, string> = {
  default: 'Ask before edits and commands that need approval. Reads outside this project and fetches from new web hosts also ask.',
  plan: 'Read-only exploration. File changes and shell commands are blocked. Leaving Plan requires approval.',
  acceptEdits: 'Allow file edits inside this project. Shell commands and outside-project changes still ask.',
  auto: 'Allow project edits and a small set of inspection commands. Unknown commands and external tools still ask.',
  bypass: 'Skip permission prompts. Explicit deny rules and tool safety checks still apply.',
}
/**
 * For a -p run: the permission modes that would allow calls of `tools` that needed approval in
 * `mode`. acceptEdits only allows file edits in the project, so it helps only file tools refused in
 * the default mode; anything else needs bypass.
 */
export function allowingModes(mode: string, tools: readonly string[]): Array<'acceptEdits' | 'bypass'> {
  return mode === 'default' && tools.length && tools.every(tool => ['FileWrite', 'FileEdit', 'NotebookEdit', 'TeamMemoryWrite'].includes(tool)) ? ['acceptEdits', 'bypass'] : ['bypass']
}
export { REPLY_RESERVE } from './outputLimits.js'
export const LOCAL_THINKING_BUDGET: Record<Effort, number> = { low: 256, medium: 512, high: 1024, extra: 2048, max: 4096 }
import { nativeEffort } from './effort.js'
import { NO_OUTPUT_LIMIT, outputBudget } from './outputLimits.js'
export function effortDescription(provider: string, effort: Effort, model = ''): string {
  const budget = outputBudget(model, effort, provider === 'local' || provider === 'ollama' ? NO_OUTPUT_LIMIT : undefined)
  const wire = nativeEffort(provider, model, effort, budget)
  const native = (wire.output_config as { effort?: string } | undefined)?.effort ?? wire.reasoning_effort ?? (wire.thinkingConfig as { thinkingLevel?: string; thinkingBudget?: number } | undefined)?.thinkingLevel
  const thinking = wire.thinking_budget ?? (wire.thinkingConfig as { thinkingBudget?: number } | undefined)?.thinkingBudget
  return provider === 'local'
    ? `Thinking budget: up to ${LOCAL_THINKING_BUDGET[effort].toLocaleString()} tokens when supported by the GGUF template. Total output is capped by remaining context.`
    : provider === 'ollama' ? 'No output budget: the reply can use all remaining context. Ollama has no native reasoning control here, so every level behaves the same.'
    : `Output budget: up to ${budget.toLocaleString()} tokens. ${Object.keys(wire).length ? `Model thinking: ${native ?? `up to ${Number(thinking).toLocaleString()} tokens`}. Some levels share the same provider setting.` : 'Native reasoning control is unavailable for this model; only the output budget changes.'}`
}
export interface ContextStatus {
  used: number; limit: number; system: number; tools: number; conversation: number; reserved: number; safety: number
  /**
   * The room for the reply that the engine's own context-full check adds to the input: its output
   * reserve plus safety margin. The check compacts or asks once used + checkReserved reaches 85% of
   * limit. It differs from `reserved` (the request's max_tokens) for managed local models.
   * Absent in statuses saved before it existed.
   */
  checkReserved?: number
  estimated: boolean; phase: 'request' | 'next-turn' | 'response'; compactions: number
  /** 'budget': the user's context budget (execution.contextBudget or GCODE_CONTEXT_LIMIT), not the model, sets the limit. */
  limitSource: 'runtime' | 'model-default' | 'fallback' | 'budget' | 'provider-limit'
  source?: 'estimate' | 'calibrated-estimate' | 'runtime-tokenizer' | 'provider-count' | 'provider-usage'
  lastUsage?: import('../llm/types.js').TokenUsage
  /**
   * The response is still arriving: lastUsage is what the provider reported as it started (its
   * output count is partial), and usageTotals do not include this request yet.
   */
  inFlight?: boolean
  usageTotals?: import('./usageTotals.js').UsageTotals
  measuredAt?: number
  /**
   * Provider input tokens per estimated token, learned from the last response. Saved so a
   * resumed session checks its first request with the calibrated estimate, not the raw one.
   */
  scale?: number
}
/** Why a version's bytes were not stored: the file held a known API key or token (see holdsKnownKey). */
export type SnapshotNotKept = 'holds-key'
/** A saved copy of a file. With `notKept` there are no bytes behind it (no snapshotPath): it says the version existed and why it cannot be read. */
export interface OutputVersion { id: string; sha256: string; snapshotPath?: string; bytes: number; createdAt: number; notKept?: SnapshotNotKept }
/** The file as it was before the session first changed it: a snapshot, or absent (the session created it). */
export interface OutputBaseline { sha256?: string; snapshotPath?: string; bytes: number; absent?: boolean; createdAt: number; notKept?: SnapshotNotKept }
/** Versions of a file kept, besides the copy from before the session: the older ones are dropped as new ones come. */
export const KEPT_VERSIONS = 20
/** The oldest versions, dropped to keep KEPT_VERSIONS: versions 1 to `count` of the file, saved between these times. */
export interface DroppedVersions { count: number; oldestAt: number; newestAt: number }
/** A file the session created or changed. `deleted`: a tool (a shell command's rm or mv) removed it; the baseline and versions are kept. */
/** `shared`: another session's command ran in the project when this change was made, and a command's changes are only known from listings: it may be theirs. */
export interface SessionOutput { path: string; tool: string; updatedAt: number; bytes?: number; versions?: OutputVersion[]; baseline?: OutputBaseline; snapshotError?: string; deleted?: boolean; shared?: boolean; droppedVersions?: DroppedVersions }
export type SessionTool = import('./runtimeEvents.js').ToolProgress
