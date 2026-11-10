/** Resource roots that trusted unsandboxed browser launchers load. Model tools may not alter them. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
declare const GCODE_COMPILED_CLI: boolean | undefined
declare const GCODE_BROWSER_WORKER: boolean | undefined
export function protectedRuntimeRoots(): string[] {
  if (typeof GCODE_COMPILED_CLI !== 'undefined' && GCODE_COMPILED_CLI) return ['..', '../../node-runtime', '../../browser-runtime'].map(p => canonical(resolve(dirname(process.execPath), p)))
  const here = dirname(fileURLToPath(import.meta.url))
  if (typeof GCODE_BROWSER_WORKER !== 'undefined' && GCODE_BROWSER_WORKER) return [here, resolve(here, '../node-runtime'), resolve(here, '../node')].map(canonical)
  // Seatbelt matches pathnames literally. A source snapshot or relocated
  // resource may be a symlink, so protect the actual files loaded by workers.
  return ['../../desktop/runtime/browser', '../../desktop/runtime/node', '../../desktop/runtime/gcode'].map(p => canonical(resolve(here, p)))
}
const canonical = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
const folded = (path: string) => process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path
/** Include case aliases and existing hard links to code loaded outside Seatbelt. */
export function isProtectedRuntimePath(path: string): boolean {
  const roots = protectedRuntimeRoots().map(canonical), target = folded(canonical(path))
  if (roots.some(root => target === folded(root) || target.startsWith(folded(root) + '/'))) return true
  let identity: string
  try { const s = statSync(path); if (!s.isFile() || s.nlink < 2) return false; identity = `${s.dev}:${s.ino}` } catch { return false }
  const matches = (p: string): boolean => {
    try {
      const s = lstatSync(p)
      if (s.isDirectory()) return readdirSync(p).some(name => matches(resolve(p, name)))
      return s.isFile() && `${s.dev}:${s.ino}` === identity
    } catch { return false }
  }
  return roots.some(matches)
}
/** A pathname policy cannot protect pre-existing hard links outside the bundle. */
export function assertRuntimeLinks(): void {
  const visit = (path: string) => {
    const s = lstatSync(path)
    if (s.isFile() && s.nlink !== 1) throw new Error(`Trusted runtime has an extra hard link: ${path}`)
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(resolve(path, name))
  }
  for (const root of protectedRuntimeRoots()) if (existsSync(root)) visit(canonical(root))
}
