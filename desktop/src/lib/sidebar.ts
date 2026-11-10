export const SIDEBAR_DEFAULT = 240
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = SIDEBAR_DEFAULT * 2
export function sidebarWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value))) : SIDEBAR_DEFAULT
}
