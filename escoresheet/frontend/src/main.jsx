import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyLayout, loadLayout } from './lib/layout'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Apply saved layout on boot
const saved = loadLayout(); if (saved) applyLayout(saved)


