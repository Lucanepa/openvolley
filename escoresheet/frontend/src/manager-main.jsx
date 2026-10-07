import React from 'react'
import ReactDOM from 'react-dom/client'
import ManagerApp from './ManagerApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n' // Initialize i18n for localization
import { AuthProvider } from './contexts/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'
import { takeAuthLinkFromLocation } from './utils/authLinks'

// manager.openvolley.app ships no service worker (scripts/build-subdomains.js,
// subdomains.manager.pwa: false): an admin console must never run a stale
// build from a cache.
stripCacheBustParam()

// #reset?token= / #confirm?token= from the account emails: read once and
// removed from the address bar and history before anything renders or logs.
const authLink = takeAuthLinkFromLocation()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="manager">
      <AuthProvider>
        <ManagerApp authLink={authLink} />
      </AuthProvider>
      <div className="ov-kit ov-kit-host"><UiHost /></div>
    </ErrorBoundary>
  </React.StrictMode>
)
