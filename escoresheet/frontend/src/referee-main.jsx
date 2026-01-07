import React from 'react'
import ReactDOM from 'react-dom/client'
import RefereeApp from './RefereeApp'
import './styles.css'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AlertProvider>
        <RefereeApp />
      </AlertProvider>
    </AuthProvider>
  </React.StrictMode>,
)

