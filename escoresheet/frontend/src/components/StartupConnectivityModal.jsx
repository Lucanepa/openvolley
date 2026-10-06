import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, X } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'

// All services shown to the user
const DISPLAY_KEYS = ['db', 'supabase', 'api', 'server', 'websocket', 'scoreboard']

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

  // App is ready when DB works AND at least one sync path works (cloud backend OR WebSocket).
  // The status key is still called 'supabase'; it is the OpenVolley backend now.
  const dbOk = isStatusOk(connectionStatuses.db)
  const supabaseOk = isStatusOk(connectionStatuses.supabase)
  const websocketOk = connectionStatuses.websocket === 'connected'
  const primaryOk = dbOk && (supabaseOk || websocketOk)

  const coreChecked = ['db', 'supabase', 'websocket'].every(key =>
    connectionStatuses[key] !== 'unknown' && connectionStatuses[key] !== 'connecting'
  )
  const hasErrors = coreChecked && !primaryOk
  // Scoring needs only the local database: once the checks are done it can go
  // on, synced or not (the queue keeps retrying, the header shows 'Offline').
  // Only a synced start closes by itself; online with both sync paths down the
  // scorer chooses (Dismiss or Go Offline), as before.
  const canContinue = primaryOk || (hasErrors && dbOk)

  // Reloaded without network: nothing to wait for, resume silently. The header's
  // connection indicator shows 'Offline'; offline mode is NOT switched on (that
  // would persist and hide this check and the sign-in banner on later loads).
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const update = () => setBrowserOffline(navigator.onLine === false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    if (open && browserOffline && !hasAutoDismissed.current) {
      hasAutoDismissed.current = true
      onDismiss?.()
    }
  }, [open, browserOffline, onDismiss])

  // Countdown + auto-dismiss once the sync works
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

  if (!open || browserOffline) return null

  // Show DB + cloud always, show fallback services only when connected
  const visibleKeys = [
    'db', 'supabase',
    ...['api', 'server', 'websocket', 'scoreboard'].filter(key => connectionStatuses[key] === 'connected')
  ]

  const labelMap = {
    api: t('connectionStatus.api', 'API'),
    server: t('connectionStatus.server', 'Server'),
    websocket: t('connectionStatus.webSocket', 'WebSocket'),
    scoreboard: t('connectionStatus.scoreboard', 'Scoreboard'),
    db: t('connectionStatus.database', 'Database'),
    supabase: t('connectionStatus.cloud', 'Cloud sync')
  }


  const getStatusIcon = (status) => {
    if (status === 'unknown' || status === 'connecting') {
      return <Loader2 size={18} className="animate-spin text-stone-400" aria-hidden="true" />
    }
    if (status === 'not_available' || status === 'not_configured') {
      return <span className="text-base leading-none text-stone-400" aria-hidden="true">–</span>
    }
    if (isStatusOk(status)) {
      return <Check size={18} strokeWidth={2.5} className="text-green-600" aria-hidden="true" />
    }
    return <X size={18} strokeWidth={2.5} className="text-red-600" aria-hidden="true" />
  }

  const getStatusText = (status) => {
    if (status === 'unknown' || status === 'connecting') return t('connectionStatus.connecting', 'Connecting')
    if (status === 'connected' || status === 'synced' || status === 'syncing' || status === 'live') return t('connectionStatus.connected', 'Connected')
    if (status === 'not_available') return t('connectionStatus.naStatic', 'N/A (static)')
    if (status === 'not_configured') return t('connectionStatus.notConfigured', 'Not configured')
    if (status === 'disconnected') return t('connectionStatus.disconnected', 'Disconnected')
    if (status === 'error') return t('connectionStatus.error', 'Error')
    if (status === 'offline') return t('connectionStatus.offline', 'Offline')
    if (status === 'auth_required') return t('connectionStatus.signInToSync', 'Sign in to sync')
    return t('connectionStatus.unknown', 'Unknown')
  }

  const getTextClass = (status) => {
    if (status === 'unknown' || status === 'connecting') return 'text-stone-500'
    if (status === 'not_available' || status === 'not_configured') return 'text-stone-500'
    if (isStatusOk(status)) return 'text-green-700'
    return 'text-red-700'
  }

  return (
    <div
      className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
      style={{ zIndex: 2000, pointerEvents: 'auto' }}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="startup-connectivity-title" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h3 id="startup-connectivity-title" className="mb-3 text-center text-lg font-bold text-stone-900">
          {primaryOk
            ? (supabaseOk
              ? t('startupConnectivity.allConnected', 'All services connected!')
              : t('startupConnectivity.connectedViaServer', 'Connected via local server'))
            : t('startupConnectivity.connecting', 'Connecting...')}
        </h3>

        <div className="divide-y divide-stone-100">
          {visibleKeys.map((key) => {
            const status = connectionStatuses[key] || 'unknown'
            return (
              <div
                key={key}
                className={cn('flex min-h-10 items-center gap-3 py-2 transition-opacity', status === 'unknown' && 'opacity-70')}
              >
                <div className="flex w-6 shrink-0 justify-center">
                  {getStatusIcon(status)}
                </div>
                <span className="min-w-[90px] text-sm font-semibold text-stone-900">
                  {labelMap[key] || key}
                </span>
                <span className={cn('ml-auto text-xs font-medium', getTextClass(status))}>
                  {getStatusText(status)}
                </span>
              </div>
            )
          })}
        </div>

        {/* Info when some connections failed */}
        {hasErrors && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-sm leading-snug text-amber-800">
            {t('startupConnectivity.noConnection', 'No server or cloud connection available. Scoring still works offline.')}
            <br />
            <span className="text-xs text-stone-600">
              {t('startupConnectivity.backgroundRetry', 'Connection will keep retrying in the background.')}
            </span>
          </div>
        )}

        {/* Buttons */}
        <div className="mt-5 flex flex-col items-center gap-2.5">
          {canContinue && (
            /* Dismiss: synced (with countdown), or checks done and scoring works locally (no countdown) */
            <button
              type="button"
              onClick={onDismiss}
              className={cn('inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-slate-800', FOCUS_RING)}
            >
              {t('startupConnectivity.dismiss', 'Dismiss')}
              {primaryOk && (
                <span className="text-xs font-normal tabular-nums text-white/70">
                  ({countdown}s)
                </span>
              )}
            </button>
          )}
          {!primaryOk && (
            /* Go Offline - when primary checks fail or still connecting */
            <button
              type="button"
              onClick={onGoOffline}
              className={cn('inline-flex h-11 w-full items-center justify-center rounded-xl border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-50', FOCUS_RING)}
            >
              {t('startupConnectivity.goOffline', 'Go offline')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
