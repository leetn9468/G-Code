// Keep-awake button for the status strip: a coffee cup that opens a small
// radio menu (while working / whenever open / never). App decides when the Mac
// is actually held awake (setKeepAwake) and passes that in as `active`, shown
// as a quiet azure dot on the cup.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, Coffee } from 'lucide-react'
import { Tooltip } from '../shell/Tooltip'
import { KEEP_AWAKE_OPTIONS, type KeepAwake } from '@/lib/settings'
import '@/styles/workbench-controls.css'

export const KEEP_AWAKE_LABELS: Record<KeepAwake, string> = {
  working: 'While G-Code is working',
  always: 'Whenever G-Code is open',
  off: 'Never',
}

/** The tooltip and accessible name: the setting, then whether it holds the Mac awake right now. */
export function keepAwakeDescription(value: KeepAwake, active: boolean): { title: string; detail: string } {
  const title = value === 'off' ? 'Keep Mac awake: off' : `Keep Mac awake: ${KEEP_AWAKE_LABELS[value].replace(/^\w/, (c) => c.toLowerCase())}`
  const detail = active ? 'Your Mac is being kept awake now'
    : value === 'off' ? 'Your Mac sleeps as usual'
    : value === 'working' ? 'Not active: G-Code is idle'
    : 'Not active right now'
  return { title, detail }
}

interface Props {
  value: KeepAwake
  /** The Mac is being kept awake right now. */
  active: boolean
  onChange: (value: KeepAwake) => void
}

export function KeepAwakeControl({ value, active, onChange }: Props) {
  const { title, detail } = keepAwakeDescription(value, active)
  return <DropdownMenu.Root>
    <Tooltip side="top" align="end" content={<span className="gc-keep-awake-tip"><span>{title}</span><span>{detail}</span></span>}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`gc-keep-awake-trigger is-${value}${active ? ' is-active' : ''}`}
          aria-label={`${title}. ${detail}.`}
          data-active={active || undefined}
        >
          <span className="gc-keep-awake-icon" aria-hidden="true">
            <Coffee size={14} strokeWidth={1.75} />
            {active && <i className="gc-keep-awake-dot" />}
          </span>
          <span className="gc-keep-awake-label" aria-hidden="true">Caffeinate</span>
        </button>
      </DropdownMenu.Trigger>
    </Tooltip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="gc-menu gc-keep-awake-menu" side="top" align="end" sideOffset={8} collisionPadding={12} loop>
        <DropdownMenu.Label className="gc-menu-label">Keep Mac awake</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={value} onValueChange={(next) => { if (next !== value) onChange(next as KeepAwake) }}>
          {KEEP_AWAKE_OPTIONS.map((option) => <DropdownMenu.RadioItem key={option} value={option} className="gc-menu-item">
            <DropdownMenu.ItemIndicator className="gc-menu-item-indicator"><Check size={14} strokeWidth={2} /></DropdownMenu.ItemIndicator>
            {KEEP_AWAKE_LABELS[option]}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="gc-menu-separator" />
        <DropdownMenu.Label className="gc-menu-footnote gc-keep-awake-note">
          {active && <i className="gc-keep-awake-dot is-inline" aria-hidden="true" />}
          <span>{active ? 'Awake now. ' : ''}Holds off idle sleep; the display can still turn off.</span>
        </DropdownMenu.Label>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
