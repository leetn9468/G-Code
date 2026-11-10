/** Resolve trusted runtime assets independently of the project being edited. */
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const GCODE_COMPILED_CLI: boolean | undefined
export interface RuntimeArtifacts { skills: string }
interface ArtifactOptions {
  compiled?: boolean
  execPath?: string
  moduleUrl?: string
  env?: NodeJS.ProcessEnv
}
function matches(path: string, directory: boolean): boolean {
  try { const stat = statSync(path); return directory ? stat.isDirectory() : stat.isFile() } catch { return false }
}

export function resolveRuntimeArtifacts(options: ArtifactOptions = {}): RuntimeArtifacts {
  const env = options.env ?? process.env
  const compiled = options.compiled ?? (typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI)
  const executableDir = dirname(options.execPath ?? process.execPath)
  const roots: string[] = []
  if (!compiled) {
    // src/cli/artifacts.ts and the bundled dist/cli.js have different depths.
    // Never discover executables in cwd: it is the user's untrusted project.
    const scriptDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
    roots.push(resolve(scriptDir, '..', '..'), resolve(scriptDir, '..'))
  }
  const asset = (key: string, candidates: string[], directory: boolean): string => {
    const explicit = env[key]
    if (explicit !== undefined) {
      if (!explicit || !matches(explicit, directory)) throw new Error(`${key} does not point to an existing ${directory ? 'directory' : 'file'}: ${explicit}`)
      return resolve(explicit)
    }
    const found = candidates.find((path) => matches(path, directory))
    if (!found) throw new Error(`Required G-Code runtime asset is missing (${key}). Reinstall G-Code.`)
    return found
  }
  const skills = asset('GCODE_BUNDLED_SKILLS_DIR', compiled
    ? [join(executableDir, '..', 'skills')]
    : roots.map((root) => join(root, 'src', 'skills', 'bundled')), true)
  return { skills }
}
