import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Primary services shown to the user — these are what matters
const PRIMARY_KEYS = ['db', 'supabase']
// Fallback services — only shown when they're connected (hidden otherwise)
const FALLBACK_KEYS = ['api', 'server', 'websocket', 'scoreboard']
const ALL_KEYS = [...PRIMARY_KEYS, ...FALLBACK_KEYS]

const AUTO_DISMISS_SECONDS = 5

const isStatusOk = (status) => {
  return status === 'connected' ||
    status === 'live' ||
    status === 'scheduled' ||
    status === 'synced' ||
    status === 'syncing' ||
    status === 'test_mode' ||
    status === 'not_applicable' ||
    status === 'not_available' ||
    status === 'not_configured' ||
    status === 'no_match'
}

export default function StartupConnectivityModal({
  open,
  connectionStatuses = {},
  onDismiss,
  onGoOffline
}) {
  const { t } = useTranslation()
  const hasAutoDismissed = useRef(false)
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS)

  // Reset when modal opens fresh
  useEffect(() => {
    if (open) {
      hasAutoDismissed.current = false
      setCountdown(AUTO_DISMISS_SECONDS)
    }
  }, [open])

  // Only primary services gate dismissal
  const primaryOk = PRIMARY_KEYS.every(key => isStatusOk(connectionStatuses[key]))
  const primaryChecked = PRIMARY_KEYS.every(key => connectionStatuses[key] !== 'unknown' && connectionStatuses[key] !== 'connecting')
  const hasErrors = primaryChecked && PRIMARY_KEYS.some(key => !isStatusOk(connectionStatuses[key]))

  // Countdown + auto-dismiss once primary services are OK
  useEffect(() => {
    if (!open || !primaryOk || hasAutoDismissed.current) return

    setCountdown(AUTO_DISMISS_SECONDS)

    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          if (!hasAutoDismissed.current) {
            hasAutoDismissed.current = true
            onDismiss?.()
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [open, primaryOk, onDismiss])

  if (!open) return null

  // Only show fallback services if they're connected — hide them otherwise
  const visibleKeys = [
    ...PRIMARY_KEYS,
    ...FALLBACK_KEYS.filter(key => connectionStatuses[key] === 'connected')
  ]

  const labelMap = {
    api: t('connectionStatus.api', 'API'),
    server: t('connectionStatus.server', 'Server'),
    websocket: t('connectionStatus.webSocket', 'WebSocket'),
    scoreboard: t('connectionStatus.scoreboard', 'Scoreboard'),
    db: t('connectionStatus.database', 'Database'),
    supabase: t('connectionStatus.supabase', 'Supabase')
  }

  const getStatusIcon = (status) => {
    if (status === 'unknown' || status === 'connecting') {
      return (
        <span
          style={{
            display: 'inline-block',
            width: 20,
            height: 20,
            border: '2px solid #3b82f6',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'startup-spin 1s linear infinite'
          }}
        />
      )
    }
    if (status === 'not_available' || status === 'not_configured') {
      return <span style={{ color: '#9ca3af', fontSize: 20, lineHeight: '20px' }}>—</span>
    }
    if (isStatusOk(status)) {
      return <span style={{ color: '#22c55e', fontSize: 20 }}>✓</span>
    }
    return <span style={{ color: '#ef4444', fontSize: 20 }}>✗</span>
  }

  const getStatusText = (status) => {
    if (status === 'unknown' || status === 'connecting') return t('connectionStatus.connecting', 'Connecting')
    if (status === 'connected' || status === 'synced' || status === 'syncing' || status === 'live') return t('connectionStatus.connected', 'Connected')
    if (status === 'not_available') return t('connectionStatus.naStatic', 'N/A (Static)')
    if (status === 'not_configured') return t('connectionStatus.notConfigured', 'Not Configured')
    if (status === 'disconnected') return t('connectionStatus.disconnected', 'Disconnected')
    if (status === 'error') return t('connectionStatus.error', 'Error')
    if (status === 'offline') return t('connectionStatus.offline', 'Offline')
    return t('connectionStatus.unknown', 'Unknown')
  }

  const getTextColor = (status) => {
    if (status === 'unknown' || status === 'connecting') return '#3b82f6'
    if (status === 'not_available' || status === 'not_configured') return '#9ca3af'
    if (isStatusOk(status)) return '#22c55e'
    return '#ef4444'
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.9)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        pointerEvents: 'auto'
      }}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <style>
        {`
          @keyframes startup-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}
      </style>

      <div
        style={{
          background: '#111827',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 16,
          padding: 32,
          minWidth: 320,
          maxWidth: '90vw'
        }}
      >
        <h3 style={{
          margin: '0 0 24px 0',
          textAlign: 'center',
          color: '#fff',
          fontSize: 18
        }}>
          {primaryOk
            ? t('startupConnectivity.allConnected', 'All services connected!')
            : t('startupConnectivity.connecting', 'Connecting...')}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visibleKeys.map((key) => {
            const status = connectionStatuses[key] || 'unknown'
            return (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  opacity: status === 'unknown' ? 0.7 : 1,
                  transition: 'opacity 0.3s'
                }}
              >
                <div style={{ width: 24, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                  {getStatusIcon(status)}
                </div>
                <span style={{ fontWeight: 600, color: '#fff', fontSize: 14, minWidth: 90 }}>
                  {labelMap[key] || key}
                </span>
                <span style={{
                  color: getTextColor(status),
                  fontSize: 13,
                  marginLeft: 'auto'
                }}>
                  {getStatusText(status)}
                </span>
              </div>
            )
          })}
        </div>

        {/* Info when some connections failed */}
        {hasErrors && (
          <div style={{
            marginTop: 20,
            padding: 12,
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: 8,
            color: '#f59e0b',
            fontSize: 13,
            textAlign: 'center',
            lineHeight: 1.5
          }}>
            {t('startupConnectivity.serverUnavailable', 'Scoring works fully offline. Referee, bench, and livescore sync via Supabase — server is only needed as fallback.')}
            <br />
            <span style={{ color: '#9ca3af', fontSize: 12 }}>
              {t('startupConnectivity.backgroundRetry', 'Connection will keep retrying in the background.')}
            </span>
          </div>
        )}

        {/* Buttons */}
        <div style={{
          marginTop: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          alignItems: 'center'
        }}>
          {primaryOk ? (
            /* Dismiss button with countdown when all OK */
            <button
              onClick={onDismiss}
              style={{
                padding: '10px 24px',
                background: 'rgba(34, 197, 94, 0.15)',
                color: '#22c55e',
                border: '1px solid rgba(34, 197, 94, 0.4)',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
                maxWidth: 240,
                transition: 'all 0.2s'
              }}
            >
              {t('startupConnectivity.dismiss', 'Dismiss')}
              <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 8, opacity: 0.7 }}>
                ({countdown}s)
              </span>
            </button>
          ) : (
            /* Go Offline - when primary checks fail or still connecting */
            <button
              onClick={onGoOffline}
              style={{
                padding: '10px 24px',
                background: 'transparent',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
                maxWidth: 240,
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('startupConnectivity.goOffline', 'Go Offline')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
