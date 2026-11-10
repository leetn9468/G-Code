import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MCPClient } from '../mcp/client.js'
import { dshAssetDirectory, dshNodeRuntimeRoot, dshRuntimeDirectory, status } from './runtime.js'
import type { DshSettings } from './settings.js'

export function createDshClient(settings: DshSettings, cwd: string, verbose = false): MCPClient {
  const runtime = dshRuntimeDirectory(), installed = status(settings, runtime)
  if (installed.state !== 'READY') throw new Error(`${installed.state}: run gcode dsh install explicitly to prepare the pinned runtime.`)
  const assets = dshAssetDirectory(), bundled = join(assets, 'bridge.mjs')
  const config = existsSync(bundled)
    ? { name: 'dsh', command: join(dshNodeRuntimeRoot(), 'bin/node'), args: [bundled] }
    : { name: 'dsh', command: process.execPath, args: ['--no-install', '--no-env-file', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, join(assets, 'bridge.ts')] }
  return new MCPClient(config, { cwd, requestTimeoutMs: settings.toolTimeoutSeconds * 1000, dsh: {
    bootstrap: { runtime, cwd, plugins: settings.plugins, toolTimeoutSeconds: settings.toolTimeoutSeconds },
    ...(verbose ? { stderr: (text: string) => process.stderr.write(text) } : {}),
  } })
}
