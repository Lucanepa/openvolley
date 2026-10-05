import React from 'react'
import ReactDOM from 'react-dom/client'
import LivescoreApp from './LivescoreApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import { stripCacheBustParam } from './hooks/useServiceWorker'

// Clean up cache_bust query parameter (added by cache clear / update flow).
// Keep the rest of the query: ?match=&team= attach tablets to the live match.
stripCacheBustParam()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="livescore">
      <AuthProvider>
        <AlertProvider>
          <LivescoreApp />
        </AlertProvider>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)

