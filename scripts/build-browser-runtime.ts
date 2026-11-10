#!/usr/bin/env bun
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareNodeRuntime } from './build-node-runtime.js'
const root = join(import.meta.dir, '..')
const output = join(root, 'desktop/runtime/browser')
const nodeRoot = await prepareNodeRuntime()
const node = join(nodeRoot, 'bin/node')
if (!existsSync(node) || !existsSync(join(output, 'browsers'))) throw new Error('Missing pinned Node/Chromium payload.')
mkdirSync(join(output, 'driver'), { recursive: true })
rmSync(join(output, 'driver/playwright-core'), { recursive: true, force: true })
cpSync(join(root, 'node_modules/playwright-core'), join(output, 'driver/playwright-core'), { recursive: true })
// Playwright forces all pages to appear focused. That masks visibilitychange
// regressions. Keep a narrowly pinned, opt-in patch for owned verification runs.
const corePath = join(output, 'driver/playwright-core/lib/coreBundle.js')
const upstreamCore = readFileSync(corePath, 'utf8')
const focusGuard = 'if (this._isMainFrame() && !skipDefaultOverrides)'
if (upstreamCore.split(focusGuard).length !== 2) throw new Error('Playwright focus patch no longer applies; review the pinned version before building')
writeFileSync(corePath, upstreamCore.replace(focusGuard, '// G-Code modification: opt out of synthetic focus for real-tab visibility checks.\n          if (this._isMainFrame() && !skipDefaultOverrides && process.env.GCODE_REAL_TAB_VISIBILITY !== "1")'))
writeFileSync(join(output, 'driver/playwright-core/GCODE-PATCH-NOTICE.txt'), 'Modified by G-Code on 2026-10-15: lib/coreBundle.js skips Emulation.setFocusEmulationEnabled(true) only when GCODE_REAL_TAB_VISIBILITY=1. This allows real Chromium tab visibility during owned verification runs. All original notices are retained. Upstream source remains unchanged in the project node_modules; the build applies this single guarded replacement.\n')
const build = await Bun.build({ entrypoints: [join(root, 'src/browser/entry.ts')], target: 'node', format: 'esm', outdir: output, naming: 'worker.mjs', define: { GCODE_BROWSER_WORKER: 'true', GCODE_COMPILED_CLI: 'false' } })
if (!build.success) throw new Error(build.logs.join('\n'))
const mcp = await Bun.build({ entrypoints: [join(root, 'src/browser/mcp.ts')], target: 'node', format: 'esm', outdir: output, naming: 'mcp.mjs', define: { GCODE_BROWSER_WORKER: 'true', GCODE_COMPILED_CLI: 'false' } })
if (!mcp.success) throw new Error(mcp.logs.join('\n'))
// Under Guillotine Mode Chromium starts through this file, which tools cannot change (a protected runtime root).
const chromiumGuard = join(output, 'chromium-guard.sh')
writeFileSync(chromiumGuard, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p "$GCODE_BROWSER_CHROMIUM_PROFILE" "$GCODE_CHROMIUM_EXECUTABLE" "$@"\n', { mode: 0o755 })
chmodSync(chromiumGuard, 0o755)
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const source = JSON.parse(readFileSync(join(nodeRoot, 'source.json'), 'utf8'))
// The shared preparer signs and verifies Node before either consumer is built.
writeFileSync(join(output, 'runtime-manifest.json'), JSON.stringify({ node: source, nodeRuntime: '../node-runtime', nodeManifestSha256: sha256(join(nodeRoot, 'runtime-manifest.json')), legacyNodeLauncherSha256: sha256(join(output, 'node/bin/node')), signedNodeSha256: sha256(node), workerSha256: sha256(join(output, 'worker.mjs')), mcpSha256: sha256(join(output, 'mcp.mjs')), chromiumGuardSha256: sha256(chromiumGuard), playwright: JSON.parse(readFileSync(join(output, 'driver/playwright-core/package.json'), 'utf8')).version, focusPatch: { upstreamSha256: createHash('sha256').update(upstreamCore).digest('hex'), patchedSha256: sha256(corePath), notice: 'driver/playwright-core/GCODE-PATCH-NOTICE.txt' }, browsers: JSON.parse(readFileSync(join(output, 'driver/playwright-core/browsers.json'), 'utf8')) }, null, 2))
writeFileSync(join(output, 'README.txt'), 'Owned browser verification runtime. Playwright core: Apache-2.0 (driver/playwright-core/LICENSE and ThirdPartyNotices.txt). Shared Node/npm license and dependency notices: ../node-runtime/THIRD-PARTY-NOTICES.txt. Chromium notices retained inside browsers. No personal profile or user Node installation required.\n')
