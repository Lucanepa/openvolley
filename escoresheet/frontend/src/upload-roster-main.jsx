// First: the error reporter listens while the rest loads (utils/errorReport, privacy 1.22)
import './utils/errorReport/boot'
import { setErrorTool } from './utils/errorReport'
import React from 'react'
import ReactDOM from 'react-dom/client'
import UploadRosterApp from './UploadRosterApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'
import { setAppEntry } from './utils/appEntry'
import { initTheme } from './utils/theme'

// Not the scoretable: this page never saves a match backup (utils/appEntry)
setAppEntry('upload_roster')
setErrorTool('roster')

// Clean up cache_bust query parameter (added by cache clear / update flow).
// Keep the rest of the query: ?match=&team= attach tablets to the live match.
stripCacheBustParam()

// The roster page scrolls as a document (styles.css: html.ov-page-scroll); the
// scoring screens keep their locked, full-window frame
document.documentElement.classList.add('ov-page-scroll')

initTheme()
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="upload_roster">
      <AuthProvider>
        <AlertProvider>
          <UploadRosterApp />
        </AlertProvider>
      </AuthProvider>
      <div className="ov-kit ov-kit-host"><UiHost /></div>
    </ErrorBoundary>
  </React.StrictMode>
)

