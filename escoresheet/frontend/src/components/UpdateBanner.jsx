import { useState } from 'react'
import useServiceWorker from '../hooks/useServiceWorker'

/**
 * Banner that shows when a new version of the app is available
 * Place this on home/landing pages where it's safe to refresh
 */
export default function UpdateBanner({ showClearDataOption = false }) {
  const { needRefresh, updateServiceWorker, dismissUpdate } = useServiceWorker()
  const [clearData, setClearData] = useState(false)

  if (!needRefresh) return null

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10000,
      background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
      flexWrap: 'wrap'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        color: '#fff',
        fontSize: '14px',
        fontWeight: 500
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>New version available!</span>
      </div>

      {showClearDataOption && (
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          color: 'rgba(255, 255, 255, 0.9)',
          fontSize: '12px',
          cursor: 'pointer'
        }}>
          <input
            type="checkbox"
            checked={clearData}
            onChange={(e) => setClearData(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <span>Clear data</span>
        </label>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => updateServiceWorker(clearData)}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            background: '#fff',
            color: '#1d4ed8',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'transform 0.1s, box-shadow 0.1s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.02)'
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)'
            e.currentTarget.style.boxShadow = 'none'
          }}
        >
          Refresh to Update
        </button>
        <button
          onClick={dismissUpdate}
          style={{
            padding: '8px 12px',
            fontSize: '13px',
            fontWeight: 500,
            background: 'rgba(255, 255, 255, 0.2)',
            color: '#fff',
            border: '1px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'background 0.1s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.3)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
          }}
        >
          Later
        </button>
      </div>
    </div>
  )
}
