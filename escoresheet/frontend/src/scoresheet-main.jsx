import React from 'react'
import ReactDOM from 'react-dom/client'
import ScoresheetApp from './ScoresheetApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import ErrorBoundary from './components/ErrorBoundary'
import { UiHost } from './ui/UiHost.jsx'
import { stripCacheBustParam } from './hooks/useServiceWorker'
import { setAppEntry } from './utils/appEntry'

// Not the scoretable: this page never saves a match backup (utils/appEntry)
setAppEntry('scoresheet')

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
