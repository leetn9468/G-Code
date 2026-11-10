/**
 * @file branding.ts
 * @brief Shadow Foundry branding and version display
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Version
// ============================================================================

let cachedVersion: string | null = null
declare const GCODE_BUILD_VERSION: string | undefined

export function getVersion(): string {
  if (cachedVersion) return cachedVersion
  if (typeof GCODE_BUILD_VERSION !== 'undefined') return GCODE_BUILD_VERSION

  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    cachedVersion = pkg.version ?? '0.1.0'
  } catch {
    cachedVersion = '0.1.0'
  }

  return cachedVersion!
}

// ============================================================================
// Banner
// ============================================================================

export function printBanner(): void {
  const version = getVersion()
  const lines = [
    '',
    '  G-Code',
    `  AI Coding Agent v${version}`,
    '  Shadow Foundry',
    '',
  ]
  process.stderr.write(lines.join('\n') + '\n')
}

export function printVersion(): void {
  console.log(`g-code ${getVersion()}`)
}
