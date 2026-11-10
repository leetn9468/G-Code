export type DshPlugin = ({ package: string; version: string; path?: never } | { path: string; package?: never; version?: never }) & { enabled: boolean; config: Record<string, unknown> }
export interface DshSettings { enabled: boolean; toolTimeoutSeconds: number; plugins: DshPlugin[] }
export const defaultDshSettings = (): DshSettings => ({ enabled: false, toolTimeoutSeconds: 60, plugins: [] })
export const exactVersion = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(v)
export const packageName = (v: unknown): v is string => typeof v === 'string' && v.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(v) && !['node_modules', 'favicon.ico'].includes(v)

export const pluginSpec = (plugin: DshPlugin): string => plugin.package ?? plugin.path
