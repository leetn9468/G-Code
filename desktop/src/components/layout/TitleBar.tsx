import { PanelLeft } from 'lucide-react'

interface Props {
  sidebarOpen: boolean
  /** source tells pointer clicks (the sidebar slides) from keyboard activation (instant). */
  onToggleSidebar: (source: 'pointer' | 'keyboard') => void
}

// No full-width title row: the traffic lights and the sidebar toggle share one
// axis (--chrome-axis) in the top-left corner, over the sidebar column, and the
// conversation panel runs up to the top of the window beside them. The window
// is named by the sidebar brand and the panel breadcrumb.
export function TitleBar({ sidebarOpen, onToggleSidebar }: Props) {
  return (
    <header className={`gc-titlebar${sidebarOpen ? '' : ' is-sidebar-hidden'}`} data-tauri-drag-region="deep">
      <button type="button" className="gc-titlebar-toggle" onClick={(event) => onToggleSidebar(event.detail === 0 ? 'keyboard' : 'pointer')} aria-label={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (⌘B)`} aria-expanded={sidebarOpen} aria-controls="session-sidebar" title="Toggle sidebar · ⌘B">
        <PanelLeft size={16} strokeWidth={1.7} />
      </button>
    </header>
  )
}
