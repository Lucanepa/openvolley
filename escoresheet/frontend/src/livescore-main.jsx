import React from 'react'
import ReactDOM from 'react-dom/client'
import LivescoreApp from './LivescoreApp'
import './styles.css'
import './i18n'  // Initialize i18n for localization

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LivescoreApp />
  </React.StrictMode>,
)

