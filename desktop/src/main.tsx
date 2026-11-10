import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/global.css'
import { App, AppErrorBoundary } from './App'
import { isTauri } from './lib/tauri'
import { closeAllTerminals } from './lib/terminal'
import { bootstrapTheme } from './lib/theme'

bootstrapTheme()

// A webview reload keeps the Rust backend, so end the shells the previous page
// opened. Once per page load (here, not in a component effect that Fast Refresh
// would re-run and kill live shells).
if (isTauri()) void closeAllTerminals().catch(() => {})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)
