import React from 'react'
import ReactDOM from 'react-dom/client'
import UploadRosterApp from './UploadRosterApp'
import './styles.css'
import './i18n'  // Initialize i18n for localization
import { AlertProvider } from './contexts/AlertContext'
import { AuthProvider } from './contexts/AuthContext'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AlertProvider>
        <UploadRosterApp />
      </AlertProvider>
    </AuthProvider>
  </React.StrictMode>
)

