// G-Code's mark: a single "/" (user decision 2026-10-16). In the interface the
// slash carries the azure branding gradient (Dark Azure → Light Azure, bottom
// to top); the wordmark is "/ G-Code". The app icon (src-tauri/icons/source.svg)
// is the white slash on the branding-gradient tile. Keep the path aligned with
// public/gcode-logo.svg and source.svg.

import { useId } from 'react'

interface Props {
  size?: number
}

export const SLASH_PATH = 'M16 58H27L48 6H37Z'

export function GLogo({ size = 14 }: Props) {
  // One gradient per instance: several marks can be on screen at once.
  const gradient = `gc-logo-${useId().replace(/:/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className="gc-logo">
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#1279A8" style={{ stopColor: 'var(--logo-from)' }} />
          <stop offset="1" stopColor="#BFD8E3" style={{ stopColor: 'var(--logo-to)' }} />
        </linearGradient>
      </defs>
      <path d={SLASH_PATH} fill={`url(#${gradient})`} />
    </svg>
  )
}
