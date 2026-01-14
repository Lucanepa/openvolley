import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initLogger } from './utils/logger'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'
import { LoggingProvider } from './contexts/LoggingContext'

// Initialize logger to capture console output
initLogger()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AlertProvider>
        <LoggingProvider>
          <App />
        </LoggingProvider>
      </AlertProvider>
    </AuthProvider>
  </React.StrictMode>
)


