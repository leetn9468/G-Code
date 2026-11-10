#!/usr/bin/env bun
/** Build the desktop's private CLI; no user runtime is needed. */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const destination = join(root, 'desktop', 'runtime', 'gcode')
const bin = join(destination, 'bin')
const executable = process.platform === 'win32' ? 'gcode.exe' : 'gcode'
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function filesIn(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) => item.isDirectory()
    ? filesIn(join(path, item.name)) : [join(path, item.name)]).sort()
}

async function run(args: string[]): Promise<string> {
  console.log(`  ${args[0]} ${args.slice(1).join(' ')}`)
  const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'inherit' })
  const output = await new Response(child.stdout).text()
  if (output) process.stdout.write(output)
  if (await child.exited !== 0) throw new Error(`Build command failed: ${args[0]}`)
  return output
}

await run([process.execPath, 'run', join(root, 'scripts/build-browser-runtime.ts')])
// Only this generated payload is bundled.
rmSync(destination, { recursive: true, force: true })
mkdirSync(bin, { recursive: true })
if (process.platform === 'darwin') await run(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=15.0', join(root, 'src/security/native/guard-processes.c'), '-lsandbox', '-o', join(bin, 'guard-processes')])
cpSync(join(root, 'src', 'skills', 'bundled'), join(destination, 'skills'), { recursive: true })
// Ship only the adapter and installation lock. DSH packages (including native
// koffi binaries) are explicitly installed into the user's separate runtime.
const dsh = join(destination, 'dsh')
mkdirSync(dsh, { recursive: true })
const bridge = await Bun.build({ entrypoints: [join(root, 'src/dsh/bridge.ts')], target: 'node',
  outdir: dsh, naming: 'bridge.mjs', define: { GCODE_COMPILED_CLI: 'false' } })
if (!bridge.success) throw new Error(bridge.logs.join('\n'))
cpSync(join(root, 'src/dsh/runtime-lock'), join(dsh, 'runtime-lock'), { recursive: true })
const relink = join(destination, 'relink')
mkdirSync(relink, { recursive: true })
// Keep a self-contained JS input so this application can be recompiled with a
// replacement Bun runtime without the original G-Code source checkout.
const js = await Bun.build({ entrypoints: [join(root, 'src', 'cli', 'cli.ts')], target: 'bun',
  outdir: relink, naming: 'cli.js', define: { GCODE_BUILD_VERSION: JSON.stringify(version), GCODE_COMPILED_CLI: 'true' } })
if (!js.success) throw new Error(js.logs.join('\n'))
writeFileSync(join(relink, 'README.txt'), `This is the bundled application input for recompilation with a replacement Bun runtime.\nBun version used: ${Bun.version}\nBun source: https://github.com/oven-sh/bun/tree/bun-v${Bun.version}\nUpstream runtime license and library-source links: ../licenses/Bun-LICENSE.md\n\nFrom this directory, with a replacement Bun built from upstream source:\nbun build --compile cli.js --outfile ../bin/gcode --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json\n\nOn macOS, sign the replacement executable and the containing app before launch.\n`)
await run([process.execPath, 'build', '--compile', join(relink, 'cli.js'),
  '--outfile', join(bin, executable),
  '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
  '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json'])

const binaries = [join(bin, executable), ...(process.platform === 'darwin' ? [join(bin, 'guard-processes')] : [])]
const nativeDependencies: Record<string, string[]> = {}
for (const binary of binaries) {
  chmodSync(binary, 0o755)
  if (process.platform === 'darwin') {
    const dependencies = await run(['otool', '-L', binary])
    nativeDependencies[relative(destination, binary)] = dependencies.split('\n').slice(1).map((line) => line.trim()).filter(Boolean)
    for (const line of dependencies.split('\n').slice(1)) {
      const dependency = line.trim().split(' ')[0]
      if (dependency && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) {
        throw new Error(`Unbundled dependency in ${binary}: ${dependency}`)
      }
    }
    await run(['codesign', '--force', '--sign', '-', binary])
    await run(['codesign', '--verify', '--strict', binary])
  }
}
await run([join(bin, executable), '--version'])
const licenses = join(destination, 'licenses')
mkdirSync(licenses, { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, 'src/security/vendor', name), join(licenses, `sandbox-runtime-0.0.81-${name}`))
const pinnedNotices = JSON.parse(readFileSync(join(root, 'desktop/licenses/sources.json'), 'utf8'))
const bunNoticeName = `bun-${Bun.version}-LICENSE.md`
const bunNotice = join(root, 'desktop/licenses', bunNoticeName)
if (!pinnedNotices[bunNoticeName] || sha256(bunNotice) !== pinnedNotices[bunNoticeName].sha256) {
  throw new Error(`Missing or changed upstream license notice for Bun ${Bun.version}. Add its pinned notice under desktop/licenses.`)
}
cpSync(bunNotice, join(licenses, 'Bun-LICENSE.md'))
const jsDependencies: Record<string, { version: string; license: string }> = {}
function includeDependency(name: string): void {
  if (jsDependencies[name]) return
  const folder = join(root, 'node_modules', name)
  const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  const notice = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md'].map((file) => join(folder, file)).find(existsSync)
  if (!notice) throw new Error(`Missing license for bundled dependency ${name}`)
  cpSync(notice, join(licenses, `${name.replaceAll('/', '-')}-LICENSE`))
  jsDependencies[name] = { version: pkg.version, license: pkg.license }
  for (const dependency of Object.keys(pkg.dependencies ?? {})) includeDependency(dependency)
}
for (const name of Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies)) includeDependency(name)
const sourceFiles = [
  ...filesIn(join(root, 'src')),
  ...['package.json', 'bun.lock', 'scripts/build-desktop-runtime.ts', 'scripts/build-browser-runtime.ts', 'scripts/build-node-runtime.ts', 'desktop/licenses/node-source.json'].map((path) => join(root, path)).filter(existsSync),
].sort()
const sourceHashes = Object.fromEntries(sourceFiles.map((path) => [relative(root, path), sha256(path)]))
writeFileSync(join(destination, 'source-manifest.json'), JSON.stringify(sourceHashes, null, 2) + '\n')
writeFileSync(join(destination, 'runtime-manifest.json'), JSON.stringify({
  version, platform: process.platform, architecture: process.arch, bunVersion: Bun.version,
  bunRevision: (await run([process.execPath, '--revision'])).trim(), bunRuntimeSha256: sha256(process.execPath),
  licenses: { sandboxRuntime: { version: '0.0.81', license: 'Apache-2.0', source: 'https://github.com/anthropics/sandbox-runtime', adapted: true, licenseSha256: sha256(join(root, 'src/security/vendor/LICENSE')), noticeSha256: sha256(join(root, 'src/security/vendor/NOTICE')) }, bun: pinnedNotices[bunNoticeName], cliDependencies: jsDependencies },
  executables: Object.fromEntries(binaries.map((path) => [path.split('/').at(-1), sha256(path)])),
  nativeDependencies,
  payloadFiles: Object.fromEntries(filesIn(destination).map((path) => [relative(destination, path), sha256(path)])),
  nodeToolchain: { resource: '../node-runtime', manifestSha256: sha256(join(root, 'desktop/runtime/node/runtime-manifest.json')) },
}, null, 2) + '\n')
console.log(`Desktop runtime ready: ${destination}`)
