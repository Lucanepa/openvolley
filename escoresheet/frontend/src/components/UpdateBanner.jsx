import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import useServiceWorker from '../hooks/useServiceWorker'

// Get current version from package.json (injected by Vite at build time)
const currentVersion = __APP_VERSION__

/**
 * Modal popup that shows when a new version of the app is available
 */
export default function UpdateBanner() {
  const { t } = useTranslation()
  const { needRefresh, updateServiceWorker, dismissUpdate } = useServiceWorker()
  const [newVersion, setNewVersion] = useState(null)

  // Fetch the new version from server when update is detected
  useEffect(() => {
    if (needRefresh) {
      fetch(`/version.json?t=${Date.now()}`)
        .then(res => res.json())
        .then(data => setNewVersion(data.version))
        .catch(() => setNewVersion(null))
    }
  }, [needRefresh])

  // Don't show if no refresh needed or if versions are the same
  if (!needRefresh) return null
  if (newVersion && newVersion === currentVersion) return null

  return (
    <div
      onClick={dismissUpdate}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1f2937',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '12px',
          padding: '32px',
          maxWidth: '380px',
          width: '90%',
          textAlign: 'center',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
        }}
      >
        {/* Icon */}
        <div style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: 'rgba(59, 130, 246, 0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 16px'
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>

        {/* Title */}
        <h3 style={{
          margin: '0 0 8px 0',
          fontSize: '18px',
          fontWeight: 600,
          color: '#fff'
        }}>
          {t('options.updateAvailable', 'Update Available!')}
        </h3>

        {/* Version info */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 14px',
          background: 'rgba(59, 130, 246, 0.15)',
          borderRadius: '6px',
          marginBottom: '16px',
          fontSize: '14px',
          fontFamily: 'monospace',
          color: 'rgba(255, 255, 255, 0.8)'
        }}>
          <span>{currentVersion}</span>
          <span style={{ color: '#3b82f6' }}>→</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>{newVersion || '?'}</span>
        </div>

        {/* Description */}
        <p style={{
          margin: '0 0 24px 0',
          fontSize: '13px',
          color: 'rgba(255, 255, 255, 0.6)',
          lineHeight: 1.5
        }}>
          {t('options.updateDescription', 'A new version is available. Refresh to get the latest features and fixes.')}
        </p>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button
            onClick={dismissUpdate}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'rgba(255, 255, 255, 0.8)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'background 0.15s'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)' }}
          >
            {t('common.later', 'Later')}
          </button>
          <button
            onClick={() => updateServiceWorker()}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'background 0.15s'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#2563eb' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#3b82f6' }}
          >
            {t('options.refreshToUpdate', 'Refresh to Update')}
          </button>
        </div>
      </div>
    </div>
  )
}
