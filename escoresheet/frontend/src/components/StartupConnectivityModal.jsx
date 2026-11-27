import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CloudOff, Loader2, X } from 'lucide-react'
import { cn, FOCUS_RING } from '../ui'

// All services shown to the user, each with its row from the dialog's first
// frame: a service whose check has not answered yet reads 'Connecting'. The
// list used to start with Database and Cloud sync only and add API, Server,
// WebSocket and Scoreboard as each check answered 'connected' (App's
// checkConnectionStatuses runs after the first render), so a 2-row dialog grew
// to 6 rows half a second to a second later and read as a second dialog
// (owner 27.11.2026).
const DISPLAY_KEYS = ['db', 'supabase', 'api', 'server', 'websocket', 'scoreboard']

// The fallback services: the app needs the database and one sync path (cloud
// or relay, primaryOk below), so one of these not reached is no issue of its
// own. It reads quiet (a dash, stone text), never a red cross; before it was
// left out of the list.
const FALLBACK_KEYS = new Set(['api', 'server', 'websocket', 'scoreboard'])

const isPending = (status) => !status || status === 'unknown' || status === 'connecting'

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
  // True only while a countdown interval runs, so a stale 0 left from an
  // earlier opening can never dismiss a reopened modal at once.
  const counting = useRef(false)
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS)

  // Reset on every open/close: the component stays mounted while closed, so
  // the countdown must not keep its 0 into the next opening.
  useEffect(() => {
    if (open) hasAutoDismissed.current = false
    setCountdown(AUTO_DISMISS_SECONDS)
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

  // Every row has answered. Until then the heading reads 'Connecting...' and
  // no countdown runs: the heading said 'All services connected!' (and the
  // 5 s countdown ran) as soon as the database and the cloud answered, over
  // rows still reading 'Connecting'. Dismiss is offered as soon as the sync
  // works (canContinue), only the countdown waits.
  const allAnswered = DISPLAY_KEYS.every(key => !isPending(connectionStatuses[key]))
  const allFine = DISPLAY_KEYS.every(key => isStatusOk(connectionStatuses[key]))
  const settledOk = primaryOk && allAnswered

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

  // Countdown once the sync works and every row has answered. The updater only counts down: calling
  // onDismiss (a parent setState) from inside it would update App while this
  // component renders. The effect below dismisses when it reaches 0.
  useEffect(() => {
    if (!open || !settledOk || hasAutoDismissed.current) return

    setCountdown(AUTO_DISMISS_SECONDS)

    const interval = setInterval(() => {
      counting.current = true
      setCountdown(prev => (prev <= 1 ? 0 : prev - 1))
    }, 1000)

    return () => {
      counting.current = false
      clearInterval(interval)
    }
  }, [open, settledOk])

  // Auto-dismiss when the countdown reaches 0 (once per opening)
  useEffect(() => {
    if (open && settledOk && counting.current && countdown === 0 && !hasAutoDismissed.current) {
      hasAutoDismissed.current = true
      onDismiss?.()
    }
  }, [open, settledOk, countdown, onDismiss])

  if (!open || browserOffline) return null

  const labelMap = {
    api: t('connectionStatus.api', 'API'),
    server: t('connectionStatus.server', 'Server'),
    websocket: t('connectionStatus.webSocket', 'WebSocket'),
    scoreboard: t('connectionStatus.scoreboard', 'Scoreboard'),
    db: t('connectionStatus.database', 'Database'),
    supabase: t('connectionStatus.cloud', 'Cloud sync')
  }


  const getStatusIcon = (status, key) => {
    if (isPending(status)) {
      return <Loader2 size={18} className="animate-spin text-stone-400" aria-hidden="true" />
    }
    // Offline is a normal state in a hall without internet, not an error
    if (status === 'offline') {
      return <CloudOff size={18} className="text-stone-500" aria-hidden="true" />
    }
    const dash = <span className="text-base leading-none text-stone-500" aria-hidden="true">–</span>
    if (status === 'not_available' || status === 'not_configured') return dash
    if (isStatusOk(status)) {
      return <Check size={18} strokeWidth={2.5} className="text-green-600" aria-hidden="true" />
    }
    if (FALLBACK_KEYS.has(key)) return dash
    return <X size={18} strokeWidth={2.5} className="text-red-600" aria-hidden="true" />
  }

  const getStatusText = (status) => {
    if (isPending(status)) return t('connectionStatus.connecting', 'Connecting')
    if (status === 'connected' || status === 'synced' || status === 'syncing' || status === 'live') return t('connectionStatus.connected', 'Connected')
    if (status === 'not_available') return t('connectionStatus.naStatic', 'N/A (static)')
    if (status === 'not_configured') return t('connectionStatus.notConfigured', 'Not configured')
    if (status === 'disconnected') return t('connectionStatus.disconnected', 'Disconnected')
    if (status === 'error') return t('connectionStatus.error', 'Error')
    if (status === 'offline') return t('connectionStatus.offline', 'Offline')
    if (status === 'auth_required') return t('connectionStatus.signInToSync', 'Sign in to sync')
    return t('connectionStatus.unknown', 'Unknown')
  }

  const getTextClass = (status, key) => {
    if (isPending(status)) return 'text-stone-500'
    if (status === 'not_available' || status === 'not_configured' || status === 'offline') return 'text-stone-500'
    if (isStatusOk(status)) return 'text-green-700'
    if (FALLBACK_KEYS.has(key)) return 'text-stone-500'
    return 'text-red-700'
  }

  return (
    <div
      className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
      style={{ zIndex: 2000, pointerEvents: 'auto' }}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* max-h + scroll: all six rows from the start, so a phone held
          sideways (390 px high) still reaches the buttons */}
      <div role="dialog" aria-modal="true" aria-labelledby="startup-connectivity-title" className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <h3 id="startup-connectivity-title" className="mb-3 text-center text-lg font-bold text-stone-900">
          {/* From the rows: 'Connecting...' while one has not answered; then
              'All services connected!' only when every row is fine, 'Connected
              via local server' when the relay carries the sync without the
              cloud, and the plain 'Connection status' for any other result (a
              fallback service not reached, no sync path: the note below says
              which) */}
          {!allAnswered
            ? t('startupConnectivity.connecting', 'Connecting...')
            : primaryOk && allFine
              ? t('startupConnectivity.allConnected', 'All services connected!')
              : primaryOk && !supabaseOk
                ? t('startupConnectivity.connectedViaServer', 'Connected via local server')
                : t('connectionStatus.title', 'Connection status')}
        </h3>

        <div className="divide-y divide-stone-100">
          {DISPLAY_KEYS.map((key) => {
            const status = connectionStatuses[key] || 'unknown'
            return (
              <div
                key={key}
                data-service={key}
                data-status={status}
                className={cn('flex min-h-10 items-center gap-3 py-2 transition-opacity', status === 'unknown' && 'opacity-70')}
              >
                <div className="flex w-6 shrink-0 justify-center">
                  {getStatusIcon(status, key)}
                </div>
                <span className="min-w-[90px] text-sm font-semibold text-stone-900">
                  {labelMap[key] || key}
                </span>
                <span className={cn('ml-auto text-xs font-medium', getTextClass(status, key))}>
                  {getStatusText(status)}
                </span>
              </div>
            )
          })}
        </div>

        {/* Venue mode: the local server carries the match, the cloud copy waits */}
        {primaryOk && !supabaseOk && connectionStatuses.supabase === 'offline' && (
          <p className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-center text-xs leading-snug text-stone-600">
            {t('startupConnectivity.cloudWaits', 'No internet: cloud sync starts as soon as this device is online. Matches are kept here and on the local server.')}
          </p>
        )}

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
              {settledOk && (
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
