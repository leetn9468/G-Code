#!/usr/bin/env bun
/**
 * @file build.ts
 * @brief G-Code build script
 *
 * Builds CLI and public library entries plus TypeScript declarations.
 * Bundles all dependencies for standalone Node.js execution.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, cpSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const ENTRY = join(ROOT, 'src', 'cli', 'cli.ts')
const LIB_ENTRY = join(ROOT, 'src', 'index.ts')
const OUT_DIR = join(ROOT, 'dist')

async function build(): Promise<void> {
  const start = performance.now()

  console.log('')
  console.log('  G-Code Build')
  console.log('  O-Research')
  console.log('  ─────────────────────────────')

  // Clean
  if (existsSync(OUT_DIR)) {
    const { rmSync } = await import('node:fs')
    rmSync(OUT_DIR, { recursive: true })
  }
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(OUT_DIR, 'licenses'), { recursive: true })
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(ROOT, 'src/security/vendor', name), join(OUT_DIR, 'licenses', `sandbox-runtime-0.0.81-${name}`))

  console.log('  [1/4] Compiling...')

  const result = await Bun.build({
    entrypoints: [ENTRY, LIB_ENTRY],
    outdir: OUT_DIR,
    naming: '[name].[ext]',
    target: 'node',
    format: 'esm',
    sourcemap: 'external',
    minify: false,
    external: [],
  })

  if (!result.success) {
    console.error('')
    console.error('  Build failed:')
    for (const log of result.logs) {
      console.error(`    ${log}`)
    }
    process.exit(1)
  }

  // Add Node.js shebang to the output
  console.log('  [2/4] Adding shebang...')
  const cliPath = join(OUT_DIR, 'cli.js')
  if (existsSync(cliPath)) {
    const { readFileSync } = await import('node:fs')
    const content = readFileSync(cliPath, 'utf-8')
    if (!content.startsWith('#!')) {
      writeFileSync(cliPath, '#!/usr/bin/env bun\n' + content)
    }
    try {
      chmodSync(cliPath, 0o755)
    } catch (err) {
      // chmod is a no-op on Windows filesystems; on POSIX it's required for
      // the shebang to execute directly. Warn either way so failures are visible.
      console.warn(`  [warn] chmod +x on ${cliPath} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log('  [3/4] Generating public declarations...')
  const declarations = Bun.spawn([
    process.execPath,
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', join(ROOT, 'tsconfig.json'),
    '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
    '--outDir', OUT_DIR,
  ], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if (await declarations.exited !== 0) throw new Error('Public declaration generation failed')
  for (const name of ['cli.js', 'index.js', 'index.d.ts']) {
    if (!existsSync(join(OUT_DIR, name))) throw new Error(`Build did not generate ${name}`)
  }

  // Report output
  console.log('  [4/4] Verifying output...')
  const outputs = result.outputs.map((o) => ({
    path: o.path,
    size: o.size,
  }))

  const elapsed = (performance.now() - start).toFixed(0)

  console.log('')
  console.log('  Output:')
  for (const out of outputs) {
    const sizeKB = (out.size / 1024).toFixed(1)
    console.log(`    ${out.path} (${sizeKB} KB)`)
  }

  // Check for source map
  const mapPath = cliPath + '.map'
  if (existsSync(mapPath)) {
    const { statSync } = await import('node:fs')
    const mapSize = (statSync(mapPath).size / 1024).toFixed(1)
    console.log(`    ${mapPath} (${mapSize} KB)`)
  }

  console.log('')
  console.log(`  Build complete in ${elapsed}ms`)
  console.log('')
}

build().catch((err) => {
  console.error(`Build error: ${err}`)
  process.exit(1)
})
