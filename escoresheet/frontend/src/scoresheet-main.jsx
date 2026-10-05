import React from 'react'
import ReactDOM from 'react-dom/client'
import ScoresheetApp from './ScoresheetApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import ErrorBoundary from './components/ErrorBoundary'
import { stripCacheBustParam } from './hooks/useServiceWorker'

// Clean up cache_bust query parameter (added by cache clear / update flow).
// Keep the rest of the query: ?match=&team= attach tablets to the live match.
stripCacheBustParam()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="scoresheet">
      <ScoresheetApp />
    </ErrorBoundary>
  </React.StrictMode>,
)
