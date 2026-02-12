import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initLogger } from './utils/logger'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'
import { LoggingProvider } from './contexts/LoggingContext'
import { ScaleProvider } from './contexts/ScaleContext'

// Initialize logger to capture console output
initLogger()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ScaleProvider>
      <AuthProvider>
        <AlertProvider>
          <LoggingProvider>
            <App />
          </LoggingProvider>
        </AlertProvider>
      </AuthProvider>
    </ScaleProvider>
  </React.StrictMode>
)


