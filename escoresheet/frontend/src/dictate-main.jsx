import React from 'react'
import ReactDOM from 'react-dom/client'
import DictateApp from './DictateApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import { setAppEntry } from './utils/appEntry'

// Not the scoretable: a read-only page, it never saves a match backup (utils/appEntry)
setAppEntry('dictate')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="dictate">
      <DictateApp />
    </ErrorBoundary>
  </React.StrictMode>
)
