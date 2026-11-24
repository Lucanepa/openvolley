// First: the error reporter listens while the rest loads (utils/errorReport, privacy 1.22)
import './utils/errorReport/boot'
import { setErrorTool } from './utils/errorReport'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n' // the page's words and the scoresheet components' (useTranslation)
import ScoresheetApp from './ScoresheetApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './utils/cqFontScale' // undoes WebKitGTK's double page zoom on font sizes in container units
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'
import { setAppEntry } from './utils/appEntry'

// Not the scoretable: this page never saves a match backup (utils/appEntry)
setAppEntry('scoresheet')
setErrorTool('scoresheet')

// Clean up cache_bust query parameter (added by cache clear / update flow).
// Keep the rest of the query: ?match=&team= attach tablets to the live match.
stripCacheBustParam()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="scoresheet">
      <ScoresheetApp />
      <div className="ov-kit ov-kit-host"><UiHost /></div>
    </ErrorBoundary>
  </React.StrictMode>,
)
