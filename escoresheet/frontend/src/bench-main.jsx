import React from 'react'
import ReactDOM from 'react-dom/client'
import BenchApp from './BenchApp'
import './styles.css'
import './i18n'  // Initialize i18n for localization

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BenchApp />
  </React.StrictMode>,
)

