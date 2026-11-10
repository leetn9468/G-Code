// Shared tooltip for icon-only and truncated controls (Radix Tooltip).
// The first tooltip in a group waits; neighbours open instantly (skipDelay).
// Prefer inline labels; use this where a control has no visible text.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import * as RadixTooltip from '@radix-ui/react-tooltip'

const ProvidedContext = createContext(false)

// Radix dismisses an open tooltip on Escape and marks the event as handled.
// Escape presses that only closed a tooltip are recorded here so global
// Escape actions (stopping a response) still run on the same key press.
const tooltipEscapes = new WeakSet<Event>()
export const isTooltipEscape = (event: Event) => tooltipEscapes.has(event)

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={500} skipDelayDuration={300}>
    <ProvidedContext.Provider value>{children}</ProvidedContext.Provider>
  </RadixTooltip.Provider>
}

interface Props {
  content: ReactNode
  /** Keyboard shortcut shown as a chip, e.g. "⌘K". */
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** Exactly one focusable element (button, link). */
  children: ReactElement
}

export function Tooltip({ content, shortcut, side = 'top', align = 'center', children }: Props) {
  const provided = useContext(ProvidedContext)
  const tooltip = <RadixTooltip.Root>
    <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content className="gc-tooltip" side={side} align={align} sideOffset={6} collisionPadding={8} onEscapeKeyDown={(event) => { tooltipEscapes.add(event) }}>
        <span>{content}</span>{shortcut && <kbd className="gc-kbd">{shortcut}</kbd>}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>
  // Components rendered on their own (tests, previews) still work without the app provider.
  return provided ? tooltip : <RadixTooltip.Provider delayDuration={500} skipDelayDuration={300}>{tooltip}</RadixTooltip.Provider>
}
