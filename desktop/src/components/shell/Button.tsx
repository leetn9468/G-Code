// Button primitives — Primary (Dark Azure), Ghost and Icon. Styles live in global.css
// (.gc-btn*) so every surface shares one hover, press and focus treatment.

import type { ButtonHTMLAttributes, ReactNode } from 'react'

type BaseProps = {
  children: ReactNode
  loading?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryButton({ children, disabled, loading, className, ...rest }: BaseProps) {
  return (
    <button type="button" disabled={disabled || loading} aria-busy={loading || undefined} className={`gc-btn gc-btn-primary${className ? ` ${className}` : ''}`} {...rest}>
      {loading && <i className="gc-spinner gc-btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export function GhostButton({ children, disabled, loading, className, ...rest }: BaseProps) {
  return (
    <button type="button" disabled={disabled || loading} aria-busy={loading || undefined} className={`gc-btn gc-btn-ghost${className ? ` ${className}` : ''}`} {...rest}>
      {loading && <i className="gc-spinner gc-btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}
