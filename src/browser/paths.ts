import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeRuntimeRoot } from '../runtime/node.js'
declare const GCODE_COMPILED_CLI: boolean | undefined
declare const GCODE_BROWSER_WORKER: boolean | undefined
export const compiledBrowserWorker = () => typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI
export function browserRuntimeRoot(): string {
  if (typeof GCODE_BROWSER_WORKER !== 'undefined' && GCODE_BROWSER_WORKER) return dirname(fileURLToPath(import.meta.url))
  return compiledBrowserWorker() ? resolve(dirname(process.execPath), '../../browser-runtime') : resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/runtime/browser')
}
export function browserWorkerArgs(request: string): string[] {
  return [join(browserRuntimeRoot(), 'worker.mjs'), request]
}
export const browserNodePath = () => join(nodeRuntimeRoot(), 'bin/node')
export const browserDriverPath = () => join(browserRuntimeRoot(), 'driver/playwright-core')
