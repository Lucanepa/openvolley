import { createContext, useContext, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const AlertContext = createContext(null)

const TYPE_COLORS = {
  error: '#ef4444',
  success: '#22c55e',
  warning: '#f59e0b',
  info: '#3b82f6'
}

const TYPE_ICONS = {
  error: '!',
  success: '✓',
  warning: '⚠',
  info: 'i'
}

function AlertModal({ alert, onClose }) {
  const { t } = useTranslation()

  if (!alert) return null

  const color = TYPE_COLORS[alert.type] || TYPE_COLORS.info
  const icon = TYPE_ICONS[alert.type] || TYPE_ICONS.info

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100000
      }}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
      }}
    >
      <div
        style={{
          width: 'min(90vw, 400px)',
          background: '#111827',
          border: `2px solid ${color}`,
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            background: `${color}20`,
            borderBottom: `1px solid ${color}40`
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: color,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: 16
            }}
          >
            {icon}
          </span>
          <span style={{ fontWeight: 600, color, textTransform: 'capitalize' }}>
            {t(`alert.${alert.type}`, alert.type)}
          </span>
        </div>

        {/* Body */}
        <div style={{ padding: '16px', color: '#e5e7eb', lineHeight: 1.5 }}>
          {alert.message}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 24px',
              background: color,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontWeight: 500,
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            {t('common.ok', 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AlertProvider({ children }) {
  const [alerts, setAlerts] = useState([])

  const showAlert = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random()
    setAlerts(prev => [...prev, { id, message, type }])
  }, [])

  const closeAlert = useCallback((id) => {
    setAlerts(prev => prev.filter(a => a.id !== id))
  }, [])

  // Show only the first alert (queue behavior)
  const currentAlert = alerts[0] || null

  return (
    <AlertContext.Provider value={{ showAlert }}>
      {children}
      <AlertModal
        alert={currentAlert}
        onClose={() => currentAlert && closeAlert(currentAlert.id)}
      />
    </AlertContext.Provider>
  )
}

export function useAlert() {
  const context = useContext(AlertContext)
  if (!context) {
    throw new Error('useAlert must be used within an AlertProvider')
  }
  return context
}
