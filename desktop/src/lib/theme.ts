import { useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from './tauri'

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'
export const THEME_CACHE_KEY = 'gcode-resolved-theme'
export const THEME_CHANGE_EVENT = 'gcode-theme-change'

export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'system' ? value : 'dark'
}

export function resolveTheme(theme: ThemePreference, systemDark: boolean): ResolvedTheme {
  return theme === 'system' ? systemDark ? 'dark' : 'light' : theme
}

/** Run before React mounts so asynchronous settings cannot flash the wrong surface. */
export function bootstrapTheme(): ResolvedTheme {
  let theme: ResolvedTheme = 'dark'
  try { if (localStorage.getItem(THEME_CACHE_KEY) === 'light') theme = 'light' } catch { /* Storage may be unavailable in a restricted webview. */ }
  document.documentElement.dataset.theme = theme
  return theme
}

/** Colour changes are immediate even where hover styles normally transition. */
export function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement
  if (root.dataset.theme !== theme) {
    root.classList.add('gc-theme-switching')
    root.dataset.theme = theme
    void root.offsetHeight
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
    requestAnimationFrame(() => root.classList.remove('gc-theme-switching'))
  }
  try { localStorage.setItem(THEME_CACHE_KEY, theme) } catch { /* The current view still follows the preference. */ }
}

/** Wait for saved settings; the cached first paint stays in place until then. */
export function useAppearanceTheme(theme: ThemePreference, loaded: boolean, restore?: () => ThemePreference) {
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  useEffect(() => {
    if (!loaded) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyTheme(resolveTheme(theme, media.matches))
    apply()
    if (isTauri()) void getCurrentWindow().setTheme(theme === 'system' ? null : theme).catch(() => {})
    if (theme === 'system') media.addEventListener('change', apply)
    return () => {
      media.removeEventListener('change', apply)
      const saved = restoreRef.current?.()
      if (saved) {
        applyTheme(resolveTheme(saved, media.matches))
        if (isTauri()) void getCurrentWindow().setTheme(saved === 'system' ? null : saved).catch(() => {})
      }
    }
  }, [theme, loaded])
}
