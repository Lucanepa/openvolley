import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import { initLogger } from './utils/logger'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'
import { LoggingProvider } from './contexts/LoggingContext'
import { ScaleProvider } from './contexts/ScaleContext'
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'
import { setAppEntry } from './utils/appEntry'
import { watchFormStack } from './utils/formLayout'
import { db } from './db/db'
import { startActivityLog } from './utils/activity'

// The scoretable: the only page that saves automatic match backups
setAppEntry('scorer')

// Clean up cache_bust query parameter (added by cache clear / update flow).
// Keep the rest of the query: ?match=&team= attach tablets to the live match.
stripCacheBustParam()

// Initialize logger to capture console output
initLogger()

// The match activity log (scoring, corrections, sync, app start/quit, errors):
// local, synced, and a daily file in the apps (utils/activity)
startActivityLog({ db })

// Portrait data entry: <body> carries ov-form-stack while a tablet is held
// upright, which switches on the one-field-per-row rules in tailwind.css for
// this app and its dialogs portalled to <body> (not for the other apps).
watchFormStack(document.body)

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="scorer">
      <ScaleProvider>
        <AuthProvider>
          <AlertProvider>
            <LoggingProvider>
              <App />
            </LoggingProvider>
          </AlertProvider>
        </AuthProvider>
      </ScaleProvider>
      <div className="ov-kit ov-kit-host"><UiHost /></div>
    </ErrorBoundary>
  </React.StrictMode>
)


