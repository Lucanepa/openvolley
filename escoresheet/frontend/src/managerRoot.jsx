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
import { ManagerBrandProvider } from './managerBrand'

/**
 * Starts the manager console of one brand (src/managerBrand.js):
 * manager-main.jsx (OpenVolley, manager.openvolley.app) and
 * manager-beach-main.jsx (OpenBeach, manager-beach.openvolley.app).
 * @param {'indoor' | 'beach'} app
 */
export function renderManager(app) {
  // Neither manager ships a service worker (scripts/build-subdomains.js,
  // pwa: false): an admin console must never run a stale build from a cache.
  stripCacheBustParam()

  // #reset?token= / #confirm?token= from the account emails: read once and
  // removed from the address bar and history before anything renders or logs.
  const authLink = takeAuthLinkFromLocation()

  // The auth calls of OpenBeach's manager carry app: 'beach' (its mails, and
  // sign-up joins OpenBeach); OpenVolley's send what they always sent.
  const authApp = app === 'beach' ? 'beach' : null

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary name="manager">
        <ManagerBrandProvider app={app}>
          <AuthProvider app={authApp}>
            <ManagerApp authLink={authLink} />
          </AuthProvider>
        </ManagerBrandProvider>
        <div className="ov-kit ov-kit-host"><UiHost /></div>
      </ErrorBoundary>
    </React.StrictMode>
  )
}
