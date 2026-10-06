import React from 'react'
import ReactDOM from 'react-dom/client'
import ManagerApp from './ManagerApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n' // Initialize i18n for localization
import { AuthProvider } from './contexts/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'

// manager.openvolley.app ships no service worker (scripts/subdomains.config.js:
// pwa false): an admin console must never run a stale build from a cache.
stripCacheBustParam()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="manager">
      <AuthProvider>
        <ManagerApp />
      </AuthProvider>
      <div className="ov-kit ov-kit-host"><UiHost /></div>
    </ErrorBoundary>
  </React.StrictMode>
)
