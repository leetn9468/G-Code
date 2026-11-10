// Searchable list of the models a provider's API offers (after G-Code Lite's
// model picker). The search field is an ARIA combobox that drives an always
// visible listbox: arrows and Page Up/Down move the active option, Enter picks
// it, Escape clears the search. With no match, Enter uses the typed text as a
// model id, so free-text entry keeps working from here too.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Search } from 'lucide-react'
import type { ProviderModel } from '@/lib/tauri'
import { shortModelName } from '../../../../src/shared/modelNames'
import './providers.css'

/** What a row shows: the provider's display name, else the short name. */
export function modelDisplayName(model: ProviderModel): string {
  return model.name?.trim() || shortModelName(model.id)
}

/** Every whitespace-separated word must appear in the id, the display name or the short name. */
export function filterModels(models: readonly ProviderModel[], query: string): ProviderModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...models]
  return models.filter((model) => {
    const haystack = `${model.id} ${model.name ?? ''} ${shortModelName(model.id)}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

const PAGE = 6
/** The next active index for a navigation key, or null when the key is not one. No wrap-around. */
export function moveActive(index: number, count: number, key: string): number | null {
  if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(key)) return null
  if (count <= 0) return -1
  switch (key) {
    case 'ArrowDown': return index < 0 ? 0 : Math.min(count - 1, index + 1)
    case 'ArrowUp': return index < 0 ? count - 1 : Math.max(0, index - 1)
    case 'PageDown': return Math.min(count - 1, Math.max(0, index) + PAGE)
    default: return Math.max(0, index - PAGE)
  }
}

/** What Enter picks: the active option, else the typed text as a free model id. */
export function resolvePick(visible: readonly ProviderModel[], active: number, query: string): string | null {
  const option = visible[active]
  if (option) return option.id
  return query.trim() || null
}

/** Where the active option starts: the current model when it is visible, else the first row. */
export function initialActive(visible: readonly ProviderModel[], value: string): number {
  const index = visible.findIndex((model) => model.id === value)
  return index >= 0 ? index : visible.length ? 0 : -1
}

interface Props {
  models: readonly ProviderModel[]
  /** The model in use (shown with a check). */
  value: string
  onPick: (id: string) => void
  /** Accessible name of the search field, e.g. "Search Claude models". */
  label: string
  /** Starting search text (restored drafts, tests). */
  initialQuery?: string
  disabled?: boolean
}

export function ModelPicker({ models, value, onPick, label, initialQuery = '', disabled = false }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const visible = useMemo(() => filterModels(models, query), [models, query])
  const [active, setActive] = useState(() => initialActive(visible, value))
  const listRef = useRef<HTMLUListElement>(null)
  // Keyboard moves and the first render keep the active row in view; hovering never scrolls.
  const reveal = useRef(true)
  const baseId = useId()
  const listId = `${baseId}-models`
  const optionId = (index: number) => `${baseId}-model-${index}`

  // A refreshed list re-finds the current model (idempotent on mount).
  useEffect(() => {
    setActive(initialActive(visible, value))
    reveal.current = true
  }, [models])
  const activeIndex = active >= 0 && active < visible.length ? active : -1
  const search = (text: string) => {
    setQuery(text)
    // A new search starts at the top; clearing it returns to the current model.
    setActive(text.trim() ? 0 : initialActive(models, value))
    reveal.current = true
  }

  useEffect(() => {
    if (!reveal.current) return
    reveal.current = false
    const list = listRef.current
    const option = activeIndex >= 0 ? list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`) : null
    if (!list || !option) return
    // Scroll the list only (scrollIntoView would also move the dialog pane).
    const top = option.offsetTop
    const bottom = top + option.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [activeIndex, visible])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const next = moveActive(activeIndex, visible.length, event.key)
    if (next !== null) {
      event.preventDefault()
      reveal.current = true
      setActive(next)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const id = resolvePick(visible, activeIndex, query)
      if (id) onPick(id)
      return
    }
    // Escape clears the search first; with an empty search it closes the dialog as usual.
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      search('')
    }
  }

  const activeOption = activeIndex >= 0 ? optionId(activeIndex) : undefined
  const typed = query.trim()

  return <div className="gc-model-list" data-disabled={disabled || undefined}>
    <div className="gc-model-list-search">
      <Search size={14} strokeWidth={1.75} aria-hidden="true" />
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search models"
        value={query}
        disabled={disabled}
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="gc-model-list-count" aria-hidden="true">{typed ? `${visible.length} of ${models.length}` : models.length}</span>
    </div>
    <ul ref={listRef} id={listId} role="listbox" aria-label={label.replace(/^Search /, '')} className="gc-model-list-options">
      {visible.map((model, index) => {
        const display = modelDisplayName(model)
        const current = model.id === value
        return <li
          key={model.id}
          id={optionId(index)}
          data-index={index}
          role="option"
          aria-selected={current}
          data-active={index === activeIndex || undefined}
          className={`gc-model-option${current ? ' is-current' : ''}`}
          // Keep focus in the search field; the click below picks.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => { if (index !== activeIndex) setActive(index) }}
          onClick={() => { if (!disabled) onPick(model.id) }}
        >
          <span className="gc-model-option-check" aria-hidden="true">{current && <Check size={14} strokeWidth={2} />}</span>
          <span className="gc-model-option-text">
            <span className="gc-model-option-name">{display}</span>
            {display !== model.id && <span className="gc-model-option-id">{model.id}</span>}
          </span>
        </li>
      })}
    </ul>
    {!visible.length && <p className="gc-model-list-empty" role="status">
      {typed ? <>No model matches “{typed}”. Press Enter to use it as the model id.</> : 'The provider listed no models.'}
    </p>}
  </div>
}
