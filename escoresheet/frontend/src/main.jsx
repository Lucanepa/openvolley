import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initLogger } from './utils/logger'
import './i18n'  // Initialize i18n for localization

// Initialize logger to capture console output
initLogger()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)


