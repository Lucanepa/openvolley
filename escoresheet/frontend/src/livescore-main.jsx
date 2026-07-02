import React from 'react'
import ReactDOM from 'react-dom/client'
import LivescoreApp from './LivescoreApp'
import './tailwind.css'
import './styles.css'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'

// Clean up cache_bust query parameter (added by cache clear / update flow)
if (window.location.search.includes('cache_bust')) {
  window.history.replaceState(null, '', window.location.pathname)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AlertProvider>
        <LivescoreApp />
      </AlertProvider>
    </AuthProvider>
  </React.StrictMode>,
)

