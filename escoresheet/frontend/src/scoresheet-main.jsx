import React from 'react'
import ReactDOM from 'react-dom/client'
import ScoresheetApp from './ScoresheetApp'
import './styles.css'

// Clean up cache_bust query parameter (added by cache clear / update flow)
if (window.location.search.includes('cache_bust')) {
  window.history.replaceState(null, '', window.location.pathname)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ScoresheetApp />
  </React.StrictMode>,
)
