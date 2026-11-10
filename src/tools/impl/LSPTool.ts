/**
 * @file LSPTool.ts
 * @brief Language Server Protocol diagnostics tool
 *
 * Shells out to language-specific LSP commands for diagnostics,
 * symbol lookup, and formatting. Lightweight — no persistent LSP connection.
 */


import { resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult, ToolUseContext, PermissionResult } from '../tool.js'
import { headUnits } from '../../utils/textUnits.js'
import { runSubprocess } from '../../utils/subprocess.js'
import { secretRefusal, writeOutsideReason, writeTarget } from '../permissions.js'

const inputSchema = z.object({
  action: z.enum(['diagnostics', 'symbols', 'format']).describe('LSP action'),
  file_path: z.string().describe('File to analyze'),
  language: z.string().optional().describe('Language hint (ts, py, go, rust)'),
})

type LSPInput = z.infer<typeof inputSchema>

interface LSPOutput {
  action: string
  filePath: string
  output: string
}

const FORMAT_COMMANDS: Record<string, string> = {
  ts: 'npx prettier --write',
  tsx: 'npx prettier --write',
  js: 'npx prettier --write',
  jsx: 'npx prettier --write',
  json: 'npx prettier --write',
  css: 'npx prettier --write',
  html: 'npx prettier --write',
  md: 'npx prettier --write',
  py: 'python -m black',
  go: 'gofmt -w',
  rust: 'rustfmt',
}

/** What is kept of a command's output before it is cut for the result. */
const MAX_COMMAND_OUTPUT = 1024 * 1024

const DIAGNOSTIC_COMMANDS: Record<string, string> = {
  ts: 'npx tsc --noEmit --pretty 2>&1',
  tsx: 'npx tsc --noEmit --pretty 2>&1',
  py: 'python -m py_compile',
  go: 'go vet',
  rust: 'cargo check --message-format=short 2>&1',
  js: 'npx eslint --no-eslintrc --format compact',
}

/**
 * Runs one command without holding up the host: Stop reaches it at once, and sibling agents,
 * approvals and frames go on while it runs. `problem`: it did not start, or did not run to its end
 * and exit by itself. `text`: what it printed, stderr included (py_compile reports there).
 */
async function runCommand(argv: string[], context: ToolUseContext, timeoutMs: number, silentExit?: number): Promise<{ code?: number | null; text: string; problem?: string }> {
  const run = await runSubprocess(argv, { cwd: context.cwd, env: process.env, timeoutMs, maxOutput: MAX_COMMAND_OUTPUT, signal: context.signal, killOnExit: true })
  const text = [run.stdout, run.stderr].map(part => part.trim()).filter(Boolean).join('\n')
  const name = argv.slice(0, 2).join(' ')
  const partial = text ? ` What it printed before that:\n${headUnits(text, 15_000)}` : ''
  if (run.spawnError !== undefined) return { text, problem: `${argv[0]} could not run: ${run.spawnError}` }
  if (run.timedOut) return { text, problem: `${name} did not finish within ${timeoutMs / 1000} s and was stopped.${partial}` }
  if (run.interrupted) return { text, problem: `${name} was stopped before it finished.${partial}` }
  if (run.exitCode === null) return { text, problem: `${name} ended without an exit status${run.signal ? ` (${run.signal})` : ''}.${partial}` }
  if (run.exitCode !== 0 && run.exitCode !== silentExit && !text) return { text, problem: `${name} exited with code ${run.exitCode} and printed nothing, so it found out nothing about the file.` }
  return { code: run.exitCode, text: run.exitCode === 0 ? run.stdout : text }
}

/**
 * Whether this call starts a program chosen by the project: `npx` runs the project's
 * node_modules/.bin, `python -m` puts the project first on its module path, `cargo check` builds
 * build.rs, and the language argument picks the command whatever the file is. So it is a command,
 * not a read. Symbols (a fixed /usr/bin/grep) and an action with no command for the language start none.
 */
export function lspRunsProgram(input: unknown): boolean {
  const args = input && typeof input === 'object' ? input as { action?: unknown; file_path?: unknown; language?: unknown } : {}
  const table = args.action === 'diagnostics' ? DIAGNOSTIC_COMMANDS : args.action === 'format' ? FORMAT_COMMANDS : undefined
  if (!table) return false
  return Object.hasOwn(table, languageOf(args.language, args.file_path))
}

function languageOf(language: unknown, filePath: unknown): string {
  return typeof language === 'string' ? language : typeof filePath === 'string' ? filePath.split('.').pop() ?? '' : ''
}

/** Why a read-only sub-agent or workflow agent may not make this LSP call, in every mode; undefined when it may. */
export function lspReadOnlyRefusal(input: unknown, who: string): string | undefined {
  const action = (input as { action?: unknown } | undefined)?.action
  if (action === 'format') return `${who} only reads; format rewrites the file`
  return lspRunsProgram(input) ? `${who} runs no commands; diagnostics runs the project's own programs (a linter, a compiler, its node_modules/.bin). Symbols still works here; to run diagnostics use a general agent or Bash, which ask for approval` : undefined
}

export const LSPTool: Tool<LSPInput, LSPOutput> = {
  name: 'LSP',
  description: 'Run language diagnostics, symbol lookup, or formatting on a file',
  inputSchema,

  async call(input, context): Promise<ToolResult<LSPOutput>> {
    const filePath = resolve(context.cwd, input.file_path)
    const ext = languageOf(input.language, input.file_path)
    const done = (output: string): ToolResult<LSPOutput> => ({
      success: true,
      output: { action: input.action, filePath: input.file_path, output: headUnits(output, 15_000) },
    })

    switch (input.action) {
      case 'diagnostics': {
        const cmd = Object.hasOwn(DIAGNOSTIC_COMMANDS, ext) ? DIAGNOSTIC_COMMANDS[ext] : undefined
        if (!cmd) return done(`No diagnostic command for .${ext} files`)
        const run = await runCommand([...cmd.replace(/ 2>&1$/, '').split(' '), filePath], context, 30_000)
        if (run.problem) return { success: false, error: run.problem }
        // A non-zero exit is how these checkers report what they found: the findings are the result.
        return done(run.code === 0 ? run.text || 'No diagnostics found.' : `Exit code ${run.code}\n${run.text}`)
      }

      case 'symbols': {
        const run = await runCommand(['/usr/bin/grep', '-En', '^(function|class|interface|type|export|def|fn|struct|impl)', filePath], context, 10_000, 1)
        if (run.problem) return { success: false, error: run.problem }
        // grep exits 1 when nothing matched, 2 on an error (with its message).
        if (run.code !== 0 && run.text) return { success: false, error: `Symbol lookup failed: ${run.text}` }
        return done(run.text || 'No symbols found.')
      }

      case 'format': {
        const fmtCmd = Object.hasOwn(FORMAT_COMMANDS, ext) ? FORMAT_COMMANDS[ext] : undefined
        if (!fmtCmd) return done(`No formatter configured for .${ext} files. Use Bash with your preferred formatter.`)
        const run = await runCommand([...fmtCmd.split(' '), filePath], context, 30_000)
        if (run.problem) return { success: false, error: run.problem }
        if (run.code !== 0) return { success: false, error: `Formatting failed with exit code ${run.code}: ${headUnits(run.text, 15_000)}` }
        return done(run.text || 'File formatted successfully.')
      }
    }
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    if (input.action !== 'format') {
      if (!lspRunsProgram(input)) return { decision: 'allow', reason: 'Read-only diagnostics' }
      // Like a Bash command: it runs what the project put there, so it needs the approval a command needs.
      return { decision: 'ask', reason: `Diagnostics runs the project's own programs (${DIAGNOSTIC_COMMANDS[languageOf(input.language, input.file_path)]!.replace(/ 2>&1$/, '')}), which can execute code in this project; it needs the approval a command needs` }
    }
    // Formatting rewrites the file in place: it needs the approval a file edit needs.
    const target = writeTarget(input.file_path, context.cwd)
    if (!target) return { decision: 'deny', reason: 'Invalid file path (it contains a null byte).' }
    if (target.secret) return { decision: 'deny', reason: secretRefusal(target.resolved, 'change') }
    return { decision: 'ask', reason: target.inside ? 'Formatting rewrites the file; file edits require user approval' : writeOutsideReason(target) }
  },

  prompt(): string {
    return "LSP: Extract symbols, run language diagnostics (runs the project's own programs, so it needs a command's approval), or format files."
  },
}
