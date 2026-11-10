// Shared motion vocabulary. Every animated surface should use these presets so
// the app moves with one rhythm: quick, critically damped springs for UI and
// short ease-outs for opacity.
//
// Reduced motion: <MotionConfig reducedMotion="user"> in App only neutralises
// positional keys (x, y, scale, width, height…), not the full `transform`
// strings used here (full strings are what Motion 13 can hardware-accelerate).
// So every transform-based preset is registered through motionSafe(), which
// swaps it in place for an opacity-only version while the system asks for
// reduced motion, and back when the setting changes.

import type { Transition, Variants } from 'motion/react'

// Springs are critically damped (bounce 0) so UI settles without wobble; they
// stay interruptible, which matters for expand-then-Escape and hover glides.
// Never mix stiffness/damping/mass with visualDuration/bounce: physics keys
// switch Motion back to its underdamped defaults.

/** Height auto / collapsible content. */
export const springCollapse: Transition = { type: 'spring', bounce: 0, visualDuration: 0.28 }
/** Sliding indicators (layoutId): selection pills, segmented thumbs. Pointer-driven only. */
export const springIndicator: Transition = { type: 'spring', bounce: 0, visualDuration: 0.25 }

/** `transformTemplate` for layoutId indicators: Motion projects layout
 *  animations with translate3d(), and a 3D transform makes WebKit composite the
 *  indicator plus everything painted above it that overlaps the glide, so each
 *  glide allocated, rasterised and dropped a stack of backing stores (~40 ms
 *  before the first frame in the native app). The same move as a 2D translate
 *  only repaints the indicator's old and new rects. */
export const flatProjection = (_latest: unknown, generated: string) =>
  generated ? generated.replace(/translate3d\(([^,]+),\s*([^,]+),[^)]*\)/, 'translate($1, $2)') : 'none'

export const easeOut = [0.23, 1, 0.32, 1] as const
export const fade: Transition = { duration: 0.16, ease: easeOut }

const reducedFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16, ease: easeOut } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: easeOut } },
}

const registry: Array<{ target: Variants; full: Variants; reduced: Variants }> = []
const reduceQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

function fill(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

/**
 * Registers transform-based variants so they become opacity-only under
 * reduced motion. Returns a stable object; use it like any Variants.
 */
export function motionSafe(full: Variants, reduced: Variants = reducedFade): Variants {
  const target: Variants = { ...(reduceQuery?.matches ? reduced : full) }
  registry.push({ target, full, reduced })
  return target
}

/** Press feedback for motion buttons: whileTap={press}. Plain buttons use CSS :active. */
export const press: Record<string, string> = { transform: 'scale(0.96)' }

reduceQuery?.addEventListener?.('change', (event) => {
  for (const entry of registry) fill(entry.target as Record<string, unknown>, (event.matches ? entry.reduced : entry.full) as Record<string, unknown>)
  fill(press, event.matches ? {} : { transform: 'scale(0.96)' })
})
if (reduceQuery?.matches) fill(press, {})

/** Modal panels. */
export const modalIn = motionSafe({
  initial: { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
  animate: { opacity: 1, transform: 'translateY(0px) scale(1)', transition: { duration: 0.22, ease: easeOut } },
  exit: { opacity: 0, transform: 'translateY(4px) scale(0.98)', transition: { duration: 0.15, ease: easeOut } },
})

/** Scrims behind modals. */
export const scrimIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: easeOut } },
  exit: { opacity: 0, transition: { duration: 0.16, ease: easeOut } },
}

/** Collapsible height animation (use with AnimatePresence initial={false}).
 *  Height is positional, so reduced motion already makes it instant. */
export const collapse: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { height: springCollapse, opacity: { duration: 0.18, delay: 0.04 } } },
  exit: { height: 0, opacity: 0, transition: { height: { type: 'spring', bounce: 0, visualDuration: 0.2 }, opacity: { duration: 0.1 } } },
}

/** Icon/label swaps inside a fixed box (send ⇄ stop, copy ⇄ copied). */
export const swap = motionSafe({
  initial: { opacity: 0, transform: 'scale(0.25)', filter: 'blur(4px)' },
  animate: { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)', transition: { type: 'spring', bounce: 0, duration: 0.3 } },
  exit: { opacity: 0, transform: 'scale(0.25)', filter: 'blur(4px)', transition: { duration: 0.15, ease: easeOut } },
}, {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.12 } },
  exit: { opacity: 0, transition: { duration: 0.08 } },
})
