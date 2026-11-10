#!/usr/bin/env bun
import { currentGuard, NetworkStopped, setNetworkGuard } from '../security/guard.js'
import { configureNetworkGuard } from '../security/settings.js'
import { guardEligible, CLOUD_GUARD_REASON } from '../shared/networkGuard.js'
import { workflowTasks } from '../workflow/tasks.js'
import { frameJSON } from './frames.js'
import { sessionCacheRatio } from '../shared/cache.js'
import { emitDesktopEvent } from './repl.js'
import { configureWorkflowTool } from '../workflow/WorkflowTool.js'
import { workflowSettings } from '../workflow/settings.js'
import { configureProviderLimits } from '../workflow/limiter.js'
/**
 * @file cli.ts
 * @brief G-Code CLI entry point
 *
 * Commander.js-based argument parsing.
 * Supports interactive REPL and headless (-p/--print) modes.
 */

import { Command, InvalidArgumentError, Option } from 'commander'
import { configureSessionBudget, handoffProviderOptions } from '../session/budgetSettings.js'
import { BudgetReached } from '../session/budget.js'
import { prepareBudgetTakeover } from '../session/budgetTakeover.js'
import { budgetContinuation, parseBudgetModel, createBudget, MONEY_SCALE, budgetModelProblem } from '../shared/sessionBudget.js'
import { getVersion, printVersion } from './branding.js'
import { startREPL } from './repl.js'
import { emitResult, emitError, guardOutputStreams, writeQuietly } from './headless.js'
import { tidyInBackground } from '../session/leftovers.js'
import { acquireSessionLock, createAppStore, saveSession, getLatestSession, loadSession, restoreSession, sessionNotLoadedMessage } from '../state/store.js'
import type { CLIOptions } from '../types.js'
import type { LLMClient } from '../llm/types.js'
import { PROVIDER_KEY_ENV, getProviderDisplayName, providerApiKey, type KeyedProvider } from '../llm/provider.js'
import { EFFORTS, PERMISSIONS, type Effort } from '../shared/sessionControls.js'
import { parseTokenCalibration } from '../shared/tokenCalibration.js'
import { constants as osConstants } from 'node:os'
import { listOllamaModels } from '../llm/ollama.js'
import { resolveCLIProvider } from './providerConfig.js'
import { configureAgentTool } from '../tools/impl/AgentTool.js'
import { setPlanModeStore } from '../tools/impl/PlanModeTool.js'
import { QueryEngine, abortActiveQueries, settleActiveQueries } from '../engine/queryEngine.js'
import { getTools } from '../tools/registry.js'
import { initMCP, shutdownMCP } from '../mcp/manager.js'
import { initSkills } from '../skills/index.js'
import { resolveSlashCommand, turnInvocations } from './slashCommands.js'
import { resolveRuntimeArtifacts } from './artifacts.js'
import { escapeDisplayControls } from '../shared/displayText.js'
import { backgroundShells } from '../tools/backgroundShells.js'
import { permissionRule, readPermissionFile, requireReadablePermissionFile } from '../session/permissionFiles.js'
import { permissionSummary } from './permissionSummary.js'
import type { PermissionDenial } from '../shared/permissionRules.js'

// ============================================================================
// Commander Program
// ============================================================================

const program = new Command()
const dollars = (value: string) => {
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1_000_000) throw new InvalidArgumentError('Use a nonnegative USD amount up to 1000000.')
  return Number(value)
}

program
  .name('gcode')
  .description('G-Code — AI Coding Agent')
  .version(getVersion(), '-V, --ver', 'Output version number')
  // Parse version flags with the other options: a prompt or option value may itself be
  // "--version"/"-v", and everything after "--" is a positional argument.
  .option('-v, --version', 'Output version and product name')
  .on('option:version', () => { printVersion(); process.exit(0) })
  .option('--verbose', 'Log MCP server diagnostics to stderr', false)
  .option('-p, --print <prompt>', 'Headless mode: run single query, output NDJSON')
  .option('--model <model>', 'Select model')
  .option('--guillotine-mode', 'Guillotine Mode: stop the work when a tool reaches an unapproved network destination (local models only)', false)
  .addOption(new Option('--network-guard', 'Old name of --guillotine-mode').hideHelp())
  .option('--budget-usd <n>', 'Session spending limit in USD (default: off)', dollars)
  .option('--budget-reserve-usd <n>', 'Keep this USD amount for a handoff (default: 0.50)', dollars)
  .option('--handoff-model <provider:model>', 'Automatically continue a budget handoff with this model in headless mode')
  .option('--permission-mode <mode>', 'Permission mode (default, plan, acceptEdits, auto, bypass)', 'default')
  .option('--effort <level>', 'Reasoning effort (low, medium, high, extra, max); the desktop sets it per message instead')
  .option('--allow <rule>', 'Allow a permission rule (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
  .option('--deny <rule>', 'Deny a permission rule in every mode (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
  .option('--fail-on-denial', 'Exit 3 if a finished headless run refused any calls', false)
  .option('--allow-workflow', 'Allow approved workflows in headless mode', false)
  .option('--fast', 'Use an explicitly selected fast model (requires --model)')
  .option('--provider <name>', 'LLM provider: anthropic, openai, gemini, deepseek, qwen, ollama, local')
  .option('--base-url <url>', 'Local/OpenAI-compatible server address (Ollama default: OLLAMA_HOST or http://localhost:11434)')
  .option('--list-models', 'List models installed on the selected Ollama server')
  .option('-c, --continue', 'Resume the most recent session')
  .option('--resume <sessionId>', 'Resume a specific session by ID')
  .argument('[prompt]', 'Optional prompt for headless mode')
  .addHelpText('after', `
Permission rules (personal file: ~/.gcode/permissions.json):
  ToolName                       Every call; mcp__server includes that server's tools
  Bash(npm test)                 Exact simple command
  Bash(npm run test:*)           Command prefix at a word boundary
  Read(~/docs/**)                FileRead, Grep, Glob, ListDir and LSP symbols
  Edit(/absolute/project/**)     FileWrite, FileEdit and NotebookEdit
  WebFetch(domain:example.com)   One host; *.example.com matches subdomains
  Paths start with ~/ or /; project rules may use relative paths. * stays in
  one path segment; ** crosses segments. Every command of a compound must match.
  Safety checks, Plan read-only restrictions and deny rules always win.

Headless exit codes:
  0       Finished, including refusals by default
  1       Provider/API error, crash, bad arguments or cleanup failure
  3       Finished with refusals, only with --fail-on-denial
  5       Stopped by Guillotine Mode; evidence kept read-only
  4       Stopped at budget; handoff written (save failure exits 1)
  128+N   Stopped by signal N (SIGINT: 130, SIGTERM: 143)
`)

let dshCommand: Promise<void> | undefined
const dshProgram = program.command('dsh').description('Manage explicitly configured DeepSeek Harness tool plugins')
for (const action of ['status', 'install'] as const) {
  const command = dshProgram.command(action).description(action === 'status' ? 'Inspect plugin status without installing anything' : 'Explicitly install pinned plugin packages from npm')
  if (action === 'status') command.option('--json', 'Print structured status')
  command.action((_options, cmd) => {
    dshCommand = import('../dsh/commands.js').then(({ runDshCommand }) => runDshCommand(action, cmd.optsWithGlobals()))
  })
}
let mcpCommand: Promise<void> | undefined
const mcpProgram = program.command('mcp').description('Find, add and manage MCP servers in ~/.gcode/mcp.json')
const collect = (value: string, previous: string[] = []) => [...previous, value]
const mcpActions: Array<[string, string, string]> = [
  ['list', '', 'List the configured MCP servers'],
  ['search', '[words...]', 'Search the official MCP Registry'],
  ['add', '<name> [registryName]', 'Add a server from the registry, or your own with --url or --command'],
  ['remove', '<name>', 'Remove a server and its saved sign-in'],
  ['enable', '<name>', 'Enable a server'],
  ['disable', '<name>', 'Disable a server'],
  ['test', '<name>', 'Connect to a server and list what it offers'],
  ['login', '<name>', 'Sign in to a remote server in the browser (OAuth)'],
  ['logout', '<name>', "Forget a remote server's saved sign-in"],
]
for (const [action, args, description] of mcpActions) {
  const command = mcpProgram.command(`${action}${args ? ` ${args}` : ''}`).description(description)
  if (['list', 'search', 'test'].includes(action)) command.option('--json', 'Print structured output')
  if (action === 'add') {
    command.option('--remote', "Use the registry entry's remote endpoint instead of its local package")
      .option('--url <url>', 'A remote server address').option('--transport <type>', 'Remote transport: auto, http or sse')
      .option('--header <name=value>', 'A header for a remote server (repeatable)', collect)
      .option('--bearer-env <variable>', 'Send the token in this environment variable as a bearer token')
      .option('--api-key-env <variable>', 'Send the key in this environment variable as an API key').option('--api-key-header <name>', 'The API key header (default X-API-Key)')
      .option('--oauth', 'Sign in with OAuth (`gcode mcp login`)').option('--client-id <id>', 'OAuth client id (otherwise registered automatically)').option('--scope <scopes>', 'OAuth scopes')
      .option('--command <command>', 'A local server command').option('--arg <value>', 'An argument for the local command (repeatable)', collect)
      .option('--env <name=value>', 'An environment variable for the local command (repeatable)', collect)
      .option('--disabled', 'Add the server disabled')
  }
  command.action((...parts: unknown[]) => {
    const cmd = parts.at(-1) as { optsWithGlobals(): Record<string, unknown> }
    const positional = parts.slice(0, -2).flatMap(value => Array.isArray(value) ? value : value === undefined ? [] : [String(value)])
    mcpCommand = import('../mcp/commands.js').then(({ runMcpCommand }) => runMcpCommand(action, positional, cmd.optsWithGlobals()))
  })
}
// Keep the existing positional-prompt behavior alongside the new subcommands.
program.action(() => {})
program.parse(process.argv)

const opts = program.opts() as CLIOptions & { ver?: string }
// --network-guard is the old spelling of --guillotine-mode; both turn the guard on.
if ((opts as { guillotineMode?: boolean }).guillotineMode) opts.networkGuard = true
const promptArg = program.args[0]
/** The signal that ended the run early, if one did (see shutdownOnSignal). */
let stoppedBy: NodeJS.Signals | undefined

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  if (dshCommand) { await dshCommand; return }
  if (mcpCommand) { await mcpCommand; return }
  const cliAllow = (opts.allow ?? []).map(rule => permissionRule(rule, 'cli'))
  const cliDeny = (opts.deny ?? []).map(rule => permissionRule(rule, 'cli'))
  if (opts.effort !== undefined && !(EFFORTS as readonly string[]).includes(opts.effort)) throw new Error(`Invalid --effort "${opts.effort}". Choose one of: ${EFFORTS.join(', ')}.`)
  if (!(PERMISSIONS as readonly string[]).includes(opts.permissionMode)) {
    const close = PERMISSIONS.find(mode => mode.toLowerCase() === String(opts.permissionMode).toLowerCase())
    throw new Error(`Invalid --permission-mode "${opts.permissionMode}". Choose one of: ${PERMISSIONS.join(', ')}.${close ? ` Did you mean ${close}?` : ''}`)
  }
  // -p (or a prompt argument) asks for headless mode whatever the prompt is; an empty prompt is an error, not the REPL.
  const headless = typeof opts.print === 'string' || promptArg !== undefined
  const headlessPrompt = typeof opts.print === 'string' ? opts.print : promptArg
  if (headless && !headlessPrompt?.trim()) throw new Error('-p/--print needs a non-empty prompt.')
  // An empty id (an unset shell variable) is a mistake, not --resume left out: it must not start a new session.
  if (opts.resume !== undefined && !opts.resume.trim()) throw new Error('--resume needs a session ID.')
  if (opts.listModels) {
    if (opts.provider !== undefined && opts.provider !== 'ollama') throw new Error('--list-models is supported with --provider ollama.')
    const models = await listOllamaModels(opts.baseUrl)
    process.stdout.write(models.length ? `${models.join('\n')}\n` : 'No models are installed on this Ollama server.\n')
    return
  }
  if (opts.networkGuard && opts.provider && !guardEligible(opts.provider, opts.baseUrl ?? (opts.provider === 'ollama' ? process.env.OLLAMA_HOST : process.env.GCODE_LOCAL_BASE_URL))) throw new Error(`--guillotine-mode refused. ${CLOUD_GUARD_REASON}`)
  configureProviderLimits(workflowSettings(process.cwd()).concurrency)
  // Validate configuration before creating a session.
  requireReadablePermissionFile()
  if (opts.provider && Object.hasOwn(PROVIDER_KEY_ENV, opts.provider) && !providerApiKey(opts.provider as KeyedProvider)) {
    const keyed = opts.provider as KeyedProvider
    throw new Error(`No API key for ${getProviderDisplayName(keyed)}. Set ${PROVIDER_KEY_ENV[keyed]}, or save a key in G-Code Settings.`)
  }
  const { client: llmClient, provider, model: resolvedModel } = await resolveCLIProvider(opts)
  if (provider) process.stderr.write(`[llm] Provider: ${getProviderDisplayName(provider)}\n`)
  if (headless && !llmClient) {
    throw new Error('No LLM configured. Set a provider API key or use --provider ollama --model <installed-name>.')
  }
  // Session resume logic
  const cwd = process.cwd()
  let store = createAppStore(undefined, cwd)
  // One process per session: a second one (the desktop and a terminal --resume, two terminals)
  // would overwrite the other's saves. Refused before anything is saved or started. The lock comes
  // before the session is read: a copy read first could miss the last save of a process that was
  // just closing.
  const lock = (sessionId: string) => /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? acquireSessionLock(cwd, sessionId, { onLost: error => {
    const event = { type: 'system', text: error.message }
    if (headless) writeQuietly(process.stdout, frameJSON(event) + '\n')
    else emitDesktopEvent(event)
    if (process.stdout.isTTY) writeQuietly(process.stderr, `\n${error.message}\n`)
    abortActiveQueries()
  } }) : () => {}
  let releaseSession: () => void

  if (opts.resume) {
    releaseSession = lock(opts.resume)
    const session = loadSession(cwd, opts.resume)
    if (session) {
      store = restoreSession(session)
      process.stderr.write(`[session] Resumed session ${opts.resume}\n`)
    } else {
      releaseSession()
      throw new Error(sessionNotLoadedMessage(cwd, opts.resume))
    }
  } else if (opts.continue) {
    const latest = getLatestSession(cwd, count => process.stderr.write(`[session] ${count} saved session file${count === 1 ? '' : 's'} of this folder could not be read and ${count === 1 ? 'was' : 'were'} skipped.\n`))
    if (latest) {
      releaseSession = lock(latest.sessionId)
      store = restoreSession(loadSession(cwd, latest.sessionId) ?? latest)
      process.stderr.write(`[session] Resumed latest session ${latest.sessionId} (saved ${new Date(latest.savedAt).toLocaleString()})\n`)
    } else {
      process.stderr.write(`[session] No previous sessions found for this folder.\n`)
      releaseSession = lock(store.getState().sessionId)
    }
  } else releaseSession = lock(store.getState().sessionId)

  // Desktop handoff metadata travels outside user/model text and is only for a fresh session.
  const calibration = !opts.resume && !opts.continue ? parseTokenCalibration(process.env.GCODE_CONTEXT_CALIBRATION, resolvedModel ?? llmClient?.modelIdentity?.('')?.model ?? '') : undefined
  if (calibration) store.setState(() => ({ contextCalibration: calibration }))
  if (!opts.resume && !opts.continue && process.env.GCODE_HANDOFF_SESSION_ID) {
    const previous = loadSession(cwd, process.env.GCODE_HANDOFF_SESSION_ID)
    if (previous?.promptSnapshot?.cwd === cwd) store.setState(() => ({ promptSnapshot: restoreSession(previous).getState().promptSnapshot }))
  }

  configureSessionBudget(store, opts)
  if (!opts.resume && !opts.continue && process.env.GCODE_HANDOFF_SESSION_ID) {
    const previous = loadSession(cwd, process.env.GCODE_HANDOFF_SESSION_ID)?.budget
    if (previous?.phase === 'held') store.setState(() => ({ budget: createBudget({ enabled: true, limitUsd: previous.stages[0]!.limit / MONEY_SCALE, reserveUsd: previous.reserve / MONEY_SCALE, handoffModel: previous.handoffModel }) }))
  }

  store.setState((current) => ({ permissionContext: { ...current.permissionContext, mode: opts.permissionMode, loadUserRules: true, alwaysAllowRules: cliAllow, alwaysDenyRules: cliDeny }, ...(opts.effort ? { effort: opts.effort as Effort } : {}) }))
  readPermissionFile()
  setPlanModeStore(store)
  if (llmClient) {
    configureAgentTool(llmClient, store, resolvedModel)
    configureWorkflowTool({ client: llmClient, provider: provider!, model: resolvedModel, store,
      tools: () => getTools(store.getState().permissionContext, store.getState().cwd) })
  }
  const state = store.getState()

  // Register shutdown handlers
  let cleanupTask: Promise<void> | undefined
  const cleanup = () => cleanupTask ??= (async () => {
    const failures: string[] = []
    const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
    abortActiveQueries()
    await workflowTasks.shutdown(state.sessionId)
    // One failure must not prevent the remaining owned processes from closing. Background
    // shells get SIGTERM and up to 1.5 s before SIGKILL; the process 'exit' hook cannot wait.
    const settled = await Promise.allSettled([settleActiveQueries(), shutdownMCP(), backgroundShells.stopAll()])
    for (const result of settled) if (result.status === 'rejected') failures.push(errorMessage(result.reason))
    try { saveSession(store.getState(), { force: true }) } catch (error) { failures.push(`Session save failed: ${errorMessage(error)}`) }
    releaseSession()
    try { await currentGuard()?.close(); setNetworkGuard() } catch (error) { failures.push(errorMessage(error)) }
    if (failures.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`)
  })()

  const shutdownOnSignal = (signal: NodeJS.Signals) => {
    stoppedBy ??= signal
    // A -p run a signal stopped did not finish: it exits as a shell reports a signal (130 for
    // Ctrl-C, 143 for SIGTERM), so a script or `timeout` never reads it as success.
    const code = headless ? 128 + (osConstants.signals[signal] ?? 0) : 0
    void cleanup().then(() => process.exit(code), (error: unknown) => {
      // After SIGHUP the terminal may be gone; the exit code still reports the failure.
      writeQuietly(process.stderr, `Fatal: ${escapeDisplayControls(error instanceof Error ? error.message : String(error), true)}\n`)
      process.exit(1)
    })
  }
  // SIGHUP (terminal closed) and SIGQUIT take the same path as SIGTERM, so background
  // shells and other owned processes are stopped instead of orphaned.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) process.on(signal, shutdownOnSignal)

  // The desktop shows a workflow's nodes under the Workflow call that runs it (its Tasks view).
  const unsubscribeWorkflows = workflowTasks.onEvent((event, task) => {
    if (task?.sessionId !== state.sessionId) return
    const frame = task.toolUseId ? { ...event, toolUseId: task.toolUseId } : event
    process.stdout.write(headless ? frameJSON(frame) + '\n' : `\x1e${frameJSON(frame)}\x1e`)
  })

  // Initialize all tools before exposing the model catalog.
  try {
    await configureNetworkGuard(store, { ...opts, provider, model: resolvedModel }, incident => { const event = { type: 'network_incident', incident, sessionId: incident.sessionId }; if (headless) writeQuietly(process.stdout, frameJSON(event) + '\n'); else emitDesktopEvent(event) })
    currentGuard()?.bind(async () => {
      abortActiveQueries()
      workflowTasks.stopAll(store.getState().sessionId)
      await backgroundShells.stopAll()
      // The originating query may be awaiting evidence; it is fenced by the latch. Writers receive their own abort signal.
      if (!await settleActiveQueries(1500, { writersOnly: true })) throw new Error('Budget writers did not settle after the network stop.')
    })
    currentGuard()?.bindNotices(text => { const event = { type: 'system', text }; if (headless) writeQuietly(process.stdout, frameJSON(event) + '\n'); else emitDesktopEvent(event) })
    const artifacts = resolveRuntimeArtifacts()
    process.env.GCODE_BUNDLED_SKILLS_DIR = artifacts.skills
    initSkills(cwd, opts.verbose)
    await initMCP(cwd, opts.verbose, { provider })
    if (headless) {
      void tidyInBackground(store.getState().cwd, notice => writeQuietly(process.stderr, `[session] ${notice}\n`))
      await runHeadlessMode(headlessPrompt!, store, llmClient, resolvedModel)
    } else {
      await startREPL({
        store,
        llmClient,
        model: resolvedModel,
        verbose: opts.verbose,
      })
    }
  } catch (error) {
    try { await currentGuard()?.check() } catch (stopped) { if (stopped instanceof NetworkStopped && headless) { emitError(stopped.message); process.exitCode = 5; return } throw stopped }
    throw error
  } finally {
    try { await cleanup() } finally { unsubscribeWorkflows() }
  }
}

// ============================================================================
// Headless Mode Runner
// ============================================================================

async function runHeadlessMode(
  input: string,
  store: ReturnType<typeof createAppStore>,
  llmClient?: LLMClient,
  model?: string,
  allowTakeover = true,
): Promise<void> {
  // Run through query engine if LLM available
  if (llmClient) {
    const tools = getTools(store.getState().permissionContext, store.getState().cwd)
    const denied: PermissionDenial[] = []
    const engine = new QueryEngine({
      client: llmClient,
      tools,
      store,
      model,
      verbose: opts.verbose,
      isHeadless: true, allowWorkflow: opts.allowWorkflow,
      onPermissionDenial: denial => denied.push(denial),
      onGateConfirm: async name => name === 'Workflow' && !!opts.allowWorkflow,
      onText: (_text) => { /* collected by engine */ },
      onRuntime: event => {
        if (event.type === 'budget-reached' || event.type === 'budget-status') writeQuietly(process.stdout, frameJSON(event) + '\n')
        // Beside the run's result, not in it: stdout and the exit code stay the turn's.
        if (event.saveWarning) writeQuietly(process.stderr, `[session] ${String(event.text)}\n`)
      },
    })

    try {
      const target = resolveSlashCommand(input)
      const result = await engine.submitQuery(input, { invocations: await turnInvocations(input, target) })
      emitResult(result.response, { cache_read_ratio: sessionCacheRatio(store.getState().usageTotals) ?? null, ...(denied.length ? { permission_denials: denied } : {}) })
      if (opts.failOnDenial && denied.length) process.exitCode = 3
    } catch (err) {
      if (err instanceof NetworkStopped) {
        let failure: unknown; try { await currentGuard()?.check() } catch (error) { if (!(error instanceof NetworkStopped)) failure = error }
        if (failure) { emitError(String(failure)); process.exitCode = 1; return }
        emitError(`Stopped by Guillotine Mode. Evidence: ${currentGuard()?.incident?.path ?? store.getState().networkHold?.incident.path ?? 'unavailable; session held'}`); process.exitCode = 5
      } else if (err instanceof BudgetReached) {
        const budget = store.getState().budget!, handoff = budget.handoff
        if (!handoff?.path) { emitError(handoff?.saveError ?? 'Stopped at budget; the handoff could not be saved.'); process.exitCode = 1 }
        else {
          process.stderr.write(`[session] Budget reached. Handoff saved to ${handoff.path}\n`)
          const selection = allowTakeover ? parseBudgetModel(opts.handoffModel ?? '') : undefined
          if (!selection) process.exitCode = 4
          else {
            const problem = budgetModelProblem(selection.provider, selection.model)
            if (problem) throw new Error(problem)
            await prepareBudgetTakeover(store)
            const resolved = await resolveCLIProvider(handoffProviderOptions(selection, opts))
            if (!resolved.client) throw new Error('The handoff model is not configured.')
            const next = createAppStore(undefined, store.getState().cwd)
            next.setState(() => ({ permissionContext: store.getState().permissionContext, promptSnapshot: store.getState().promptSnapshot,
              budget: createBudget({ enabled: true, limitUsd: budget.stages[0]!.limit / MONEY_SCALE, reserveUsd: budget.reserve / MONEY_SCALE }), effort: store.getState().effort }))
            const release = acquireSessionLock(next.getState().cwd, next.getState().sessionId)
            setPlanModeStore(next)
            configureAgentTool(resolved.client, next, resolved.model ?? selection.model)
            configureWorkflowTool({ client: resolved.client, provider: resolved.provider!, model: resolved.model ?? selection.model, store: next, tools: () => getTools(next.getState().permissionContext, next.getState().cwd) })
            if (currentGuard()) {
              await configureNetworkGuard(next, { ...handoffProviderOptions(selection, opts), model: resolved.model ?? selection.model, networkGuard: guardEligible(resolved.provider!, (handoffProviderOptions(selection, opts) as { baseUrl?: string }).baseUrl) }, incident => writeQuietly(process.stdout, frameJSON({ type: 'network_incident', incident, sessionId: incident.sessionId }) + '\n'))
              currentGuard()?.bind(async () => { abortActiveQueries(); workflowTasks.stopAll(next.getState().sessionId); await backgroundShells.stopAll(); if (!await settleActiveQueries(1500, { writersOnly: true })) throw new Error('Budget writers did not settle after the network stop.') })
            }
            try { await runHeadlessMode(budgetContinuation(handoff, store.getState().sessionId), next, resolved.client, resolved.model ?? selection.model, false) }
            finally { await workflowTasks.shutdown(next.getState().sessionId); saveSession(next.getState(), { force: true }); release() }
          }
        }
      } else {
      // A signal aborts the query: say so, not "The operation was aborted."
      emitError(stoppedBy ? `Stopped by ${stoppedBy} before the run finished.` : err instanceof Error ? err.message : String(err))
      process.exitCode = 1
      }
    }
    const summary = permissionSummary(denied, store.getState().permissionContext, store.getState().cwd)
    if (summary) process.stderr.write(`[permissions] ${summary}\n`)
  } else {
    emitError('No LLM configured. Set a provider API key or use --provider ollama --model <installed-name>.')
    process.exitCode = 1
  }
}

// ============================================================================
// Run
// ============================================================================

// A hung-up terminal or a closed pipe makes writes fail with EIO/EPIPE; that must not end the
// process before the shutdown sequence has saved the session and stopped what it owns.
guardOutputStreams()
main().catch((err) => {
  writeQuietly(process.stderr, `Fatal: ${escapeDisplayControls(err instanceof Error ? err.message : String(err), true)}\n`)
  process.exit(1)
})
