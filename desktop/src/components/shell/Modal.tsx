// Modal shell — used by Provider Selector, Settings, search and other dialogs.
// Focus trap, Escape and scrim click close; animated enter and exit (an
// Escape close skips the exit animation).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition, type Variants } from 'motion/react'
import { modalIn, scrimIn } from '@/lib/motion'

// Exits resolve against AnimatePresence `custom` (an exiting element keeps the
// props of its last render, so the flag can't travel as a prop). A dialog
// dismissed with Escape disappears at once — keyboard actions never animate —
// while a pointer close keeps the eased exit. modalIn is swapped in place when
// the reduced-motion setting changes, so the panel variants read it lazily.
const INSTANT_EXIT: TargetAndTransition = { opacity: 0, transition: { duration: 0 } }
const panelVariants: Variants = {
  get initial() { return modalIn.initial },
  get animate() { return modalIn.animate },
  exit: (viaKeyboard?: boolean) => (viaKeyboard ? INSTANT_EXIT : modalIn.exit) as TargetAndTransition,
}
const scrimVariants: Variants = {
  ...scrimIn,
  exit: (viaKeyboard?: boolean) => (viaKeyboard ? INSTANT_EXIT : scrimIn.exit) as TargetAndTransition,
}

interface Props {
  open: boolean
  onClose: () => void
  labelledBy: string       // id of the header element
  width: number            // px
  maxHeight?: string       // e.g. '60vh', '640px'
  /** Keyboard-summoned, high-frequency surfaces (⌘K) open and close without motion. */
  instant?: boolean
  /** 'top' pins the panel's top edge (search) so it doesn't jump as its content changes. */
  align?: 'center' | 'top'
  children: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
const TOP_OFFSET = 'max(48px, (100vh - 480px) / 2)'

export function Modal({ open, onClose, labelledBy, width, maxHeight, instant = false, align = 'center', children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  // Set in the same batch as the parent's close when Escape dismisses the dialog.
  const [closedByKeyboard, setClosedByKeyboard] = useState(false)

  // Forget an Escape the parent ignored (a busy dialog stays open), and reset
  // on reopen, so a later pointer close still plays the exit.
  useEffect(() => {
    if (open && closedByKeyboard) setClosedByKeyboard(false)
  }, [open, closedByKeyboard])

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setClosedByKeyboard(true)
        close.current()
      }
      if (e.key === 'Tab') {
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
          .filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (!first) { e.preventDefault(); panelRef.current?.focus(); return }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          e.preventDefault(); last?.focus()
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) {
          e.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    // Focus the panel so keyboard events are captured.
    panelRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', handleKey)
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  if (typeof document === 'undefined') return null

  const defaultMaxHeight = align === 'top' ? `calc(100vh - ${TOP_OFFSET} - 24px)` : 'calc(100vh - 48px)'

  return createPortal(
    <AnimatePresence custom={closedByKeyboard}>
      {open && <ModalLayer key="gc-modal" align={align} onClose={onClose}>
        <motion.div aria-hidden className="gc-modal-scrim" variants={scrimVariants} initial={instant ? false : 'initial'} animate="animate" exit={instant ? undefined : 'exit'} />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          ref={panelRef}
          className="gc-modal-panel"
          style={{ width, maxHeight: maxHeight ?? defaultMaxHeight }}
          variants={panelVariants}
          initial={instant ? false : 'initial'}
          animate="animate"
          exit={instant ? undefined : 'exit'}
        >
          {children}
        </motion.div>
      </ModalLayer>}
    </AnimatePresence>,
    document.body,
  )
}

/** Full-window layer. While a dialog plays its exit it stops taking pointer
 *  input (data-state="closed"), so clicks reach whatever is underneath. */
function ModalLayer({ align, onClose, children }: { align: 'center' | 'top'; onClose: () => void; children: ReactNode }) {
  const present = useIsPresent()
  return <div
    className="gc-modal-layer"
    data-align={align}
    data-state={present ? 'open' : 'closed'}
    onMouseDown={(e) => {
      // Scrim click closes; panel clicks don't.
      if (e.target === e.currentTarget) onClose()
    }}
  >
    {children}
  </div>
}
