import React from 'react'
import ReactDOM from 'react-dom/client'
import DictateApp from './DictateApp'
import './tailwind.css' // also brings in styles.css (legacy layer) and the volleyui tokens
import './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import { setAppEntry } from './utils/appEntry'

// Not the scoretable: a read-only page, it never saves a match backup (utils/appEntry)
setAppEntry('dictate')

// styles.css locks html, body and #root (overflow: hidden) for the full-screen
// scoring views; this page is a document and must scroll (a phone could not)
for (const el of [document.documentElement, document.body, document.getElementById('root')]) {
  if (el) { el.style.overflow = 'visible'; el.style.overflowY = 'auto'; el.style.height = 'auto' }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary name="dictate">
      <DictateApp />
    </ErrorBoundary>
  </React.StrictMode>
)
