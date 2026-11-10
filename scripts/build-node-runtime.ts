#!/usr/bin/env bun
/** One checksum-bound Node distribution for browser workers and all tool processes. */
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dir, '..')
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
function filesIn(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesIn(join(folder, entry.name)) : [join(folder, entry.name)]).sort()
}
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`Node runtime preparation failed: ${args[0]}`)
}

export async function prepareNodeRuntime() {
  const sourcePath = join(root, 'desktop/licenses/node-source.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const archive = join(root, 'desktop/runtime/downloads', source.source.split('/').at(-1))
  if (statSync(archive).size !== source.archiveBytes || digest(archive) !== source.archiveSha256) throw new Error('Pinned Node archive checksum does not match')
  const staging = mkdtempSync(join(root, 'desktop/runtime/.node-build-'))
  const output = join(root, 'desktop/runtime/node')
  try {
    const prefix = `node-${source.version}-darwin-arm64`
    await run(['/usr/bin/tar', '-xzf', archive, '-C', staging, '--strip-components=1', `${prefix}/bin/node`, `${prefix}/LICENSE`, `${prefix}/lib/node_modules/npm`])
    const node = join(staging, 'bin/node')
    if (digest(node) !== source.binarySha256) throw new Error('Extracted Node differs from pinned upstream binary')
    const npm = JSON.parse(readFileSync(join(staging, 'lib/node_modules/npm/package.json'), 'utf8'))
    if (npm.version !== source.npmVersion || npm.license !== 'Artistic-2.0') throw new Error('Unexpected npm version or license in pinned archive')
    for (const command of ['npm', 'npx']) {
      const wrapper = join(staging, 'bin', command)
      writeFileSync(wrapper, `#!/bin/sh\nset -eu\n# Use this distribution, even when another Node is on PATH.\ncase "$0" in */*) launcher=$0 ;; *) launcher=$(command -v "$0") ;; esac\nbin_dir=$(CDPATH= cd -- "\${launcher%/*}" && pwd -P)\nexec "$bin_dir/node" "$bin_dir/../lib/node_modules/npm/bin/${command}-cli.js" "$@"\n`)
      chmodSync(wrapper, 0o755)
    }
    cpSync(sourcePath, join(staging, 'source.json'))
    // Retain every upstream file, including nested dependency notices. A single
    // human-readable collection is also shipped to the Settings notices viewer.
    const notices = filesIn(staging).filter(file => /^(license|licence|copying|notice)(\.|$)/i.test(file.split('/').at(-1)!))
    const noticeText = `G-Code Node.js toolchain\nNode ${source.version}; npm / npx ${npm.version} (Artistic-2.0)\nSource: ${source.source}\n\n` + notices.map(file => `===== ${relative(staging, file)} =====\n\n${readFileSync(file, 'utf8')}\n`).join('\n')
    writeFileSync(join(staging, 'THIRD-PARTY-NOTICES.txt'), noticeText)
    writeFileSync(join(staging, 'README.txt'), 'Shared Node.js runtime for browser verification and tool processes. npm/npx wrappers invoke this bundled Node. All upstream npm files and dependency notices are retained. THIRD-PARTY-NOTICES.txt is also available in Settings > MCP > Open-source notices.\n')
    if (process.platform === 'darwin') {
      await run(['/usr/bin/codesign', '--force', '--sign', '-', node])
      await run(['/usr/bin/codesign', '--verify', '--strict', node])
    }
    const files = filesIn(staging)
    for (const file of files) {
      if (lstatSync(file).isSymbolicLink()) {
        const target = relative(realpathSync(staging), realpathSync(file))
        if (target === '..' || target.startsWith('../') || isAbsolute(target)) throw new Error(`Node payload link escapes its bundle: ${relative(staging, file)}`)
      }
    }
    writeFileSync(join(staging, 'runtime-manifest.json'), JSON.stringify({ node: source, npm: { version: npm.version, license: npm.license },
      signedNodeSha256: digest(node), payloadBytes: files.reduce((total, file) => total + statSync(file).size, 0),
      payloadFiles: Object.fromEntries(files.map(file => [relative(staging, file), digest(file)])),
      noticeFiles: notices.map(file => relative(staging, file)),
    }, null, 2) + '\n')
    rmSync(output, { recursive: true, force: true }); renameSync(staging, output)
    const publicNotice = join(root, 'desktop/public/licenses/node-toolchain-LICENSES.txt')
    mkdirSync(dirname(publicNotice), { recursive: true }); writeFileSync(publicNotice, noticeText)
    // A second copy would bloat the app and let browser/tool versions drift.
    rmSync(join(root, 'desktop/runtime/browser/node'), { recursive: true, force: true })
    // Previously saved browser MCP presets point here. Preserve that executable
    // path as a launcher, without preserving a second Node binary or user config.
    const legacy = join(root, 'desktop/runtime/browser/node/bin/node')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, '#!/bin/sh\nset -eu\ncase "$0" in */*) launcher=$0 ;; *) launcher=$(command -v "$0") ;; esac\nbin_dir=$(CDPATH= cd -- "${launcher%/*}" && pwd -P)\nruntime_parent=$(CDPATH= cd -- "$bin_dir/../../.." && pwd -P)\nif [ -x "$runtime_parent/node-runtime/bin/node" ]; then\n  exec "$runtime_parent/node-runtime/bin/node" "$@"\nfi\nexec "$runtime_parent/node/bin/node" "$@"\n')
    chmodSync(legacy, 0o755)
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }) }
  return output
}
if (import.meta.main) await prepareNodeRuntime()
