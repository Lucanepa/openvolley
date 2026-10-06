import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../db/db'
import { useSyncQueueStats } from '../hooks/useSyncQueue'
import { ChevronDown } from 'lucide-react'
import { cn } from '../ui/cn.js'
import { StatusPill } from '../ui/StatusPill.jsx'
import { FOCUS_RING, KIT_SCOPE, POPOVER_PANEL, STATUS_PILL, STATUS_TONES } from './chromeClasses'

// The local server + WebSocket path (LAN relay) works on its own, cloud or not
function isServerWebsocketViable(serverStatus, websocketStatus) {
  return serverStatus === 'connected' && (websocketStatus === 'connected' || websocketStatus === 'no_match')
}

export default function ConnectionStatus({
  connectionStatuses = {},
  connectionDebugInfo = {},
  onCheckStatus,
  onRetryErrors,
  queueStats = null,
  position = 'right', // 'left' | 'right' | 'center'
  size = 'normal' // 'normal' | 'small' | 'large'
}) {
  const { t } = useTranslation()

  // Queue counts come from a live query on the local sync queue (callers used
  // to pass the sync status string here, so pending/failed jobs never showed).
  // queueStats may still carry counts (tests) and authRequired; a caller that
  // passes the status string still gets 'auth_required' recognised.
  const liveCounts = useSyncQueueStats()
  const given = queueStats && typeof queueStats === 'object' ? queueStats : {}
  const count = (key) => (typeof given[key] === 'number' ? given[key] : (liveCounts?.[key] || 0))
  const stats = { pending: count('pending'), error: count('error'), failed: count('failed') }
  const pendingCount = stats.pending
  const errorCount = stats.error + stats.failed
  const authRequired = given.authRequired === true || queueStats === 'auth_required'

  // The browser's own view of the network (the 'Online' switch is offline mode)
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    const update = () => setBrowserOffline(navigator.onLine === false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Offline as far as the browser knows: a socket to the cloud relay can stay
  // OPEN without any data flowing (no close until a send times out), so a
  // 'connected' WebSocket is not believed then, unless the local server answers
  // too (offline desktop app / LAN scoretable, where the relay is local).
  const shownStatuses = browserOffline && connectionStatuses.websocket === 'connected' && connectionStatuses.server !== 'connected'
    ? { ...connectionStatuses, websocket: 'disconnected' }
    : connectionStatuses

  const [showConnectionMenu, setShowConnectionMenu] = useState(false)
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, maxHeight: 0 })
  const buttonRef = useRef(null)
  const menuRef = useRef(null)

  // Calculate menu position based on button position
  const calculateMenuPosition = useCallback(() => {
    if (!buttonRef.current) return

    const buttonRect = buttonRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const menuMaxWidth = 300
    const menuPadding = 12
    const gap = 8 // Gap between button and menu

    // Calculate horizontal position
    let left = buttonRect.left

    // Ensure menu doesn't go off the right edge
    if (left + menuMaxWidth > viewportWidth - menuPadding) {
      left = viewportWidth - menuMaxWidth - menuPadding
    }

    // Ensure menu doesn't go off the left edge
    if (left < menuPadding) {
      left = menuPadding
    }

    // Calculate vertical position and max height
    const spaceBelow = viewportHeight - buttonRect.bottom - gap - menuPadding
    const spaceAbove = buttonRect.top - gap - menuPadding
    let top
    let maxHeight

    // Prefer positioning below, but if not enough space, position above
    if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
      // Position below the button
      top = buttonRect.bottom + gap
      maxHeight = Math.max(200, Math.min(spaceBelow, viewportHeight - top - menuPadding))
    } else {
      // Position above the button
      const estimatedHeight = Math.min(400, spaceAbove)
      top = buttonRect.top - estimatedHeight - gap
      maxHeight = Math.max(200, Math.min(estimatedHeight, spaceAbove))
    }

    setMenuPosition({ top, left, maxHeight })
  }, [])

  // Recalculate menu position when menu is shown or window is resized
  useEffect(() => {
    if (showConnectionMenu) {
      calculateMenuPosition()
      const handleResize = () => calculateMenuPosition()
      window.addEventListener('resize', handleResize)
      window.addEventListener('scroll', handleResize, true)
      return () => {
        window.removeEventListener('resize', handleResize)
        window.removeEventListener('scroll', handleResize, true)
      }
    }
  }, [showConnectionMenu, calculateMenuPosition])

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showConnectionMenu && !e.target.closest('[data-connection-menu]')) {
        setShowConnectionMenu(false)
      }
      if (showDebugMenu && !e.target.closest('[data-debug-menu]')) {
        setShowDebugMenu(null)
      }
    }

    if (showConnectionMenu || showDebugMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [showConnectionMenu, showDebugMenu])

  // Each status: its word and a kit tone (pill + dot + text, chromeClasses
  // STATUS_TONES). Offline is a normal state for a hall without network, so it
  // reads neutral, not as an error.
  const getStatusColor = (status, key) => {
    if (status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing') {
      return { tone: 'ok', text: status === 'syncing' ? t('connectionStatus.syncing', 'Syncing') : t('connectionStatus.connected', 'Connected') }
    } else if (status === 'awaiting_match') {
      return { tone: 'ok', text: t('connectionStatus.connected', 'Connected') }
    } else if (status === 'attention') {
      return { tone: 'error', text: t('connectionStatus.error', 'Error') }
    } else if (status === 'no_match') {
      // For websocket, "no_match" means waiting for a match to be selected - show as gray/ready
      const text = key === 'websocket' ? t('connectionStatus.noMatch', 'No match') : t('connectionStatus.ready', 'Ready')
      return { tone: 'neutral', text }
    } else if (status === 'offline') {
      return { tone: 'neutral', text: t('connectionStatus.offline', 'Offline') }
    } else if (status === 'disconnected' || status === 'error') {
      return { tone: 'error', text: status === 'error' ? t('connectionStatus.error', 'Error') : t('connectionStatus.disconnected', 'Disconnected') }
    } else if (status === 'not_configured' || status === 'not_applicable') {
      return { tone: 'warn', text: t('connectionStatus.notConfigured', 'Not configured') }
    } else if (status === 'not_available') {
      return { tone: 'neutral', text: t('connectionStatus.naStatic', 'N/A (static)') }
    } else if (status === 'connecting') {
      return { tone: 'warn', text: t('connectionStatus.connecting', 'Connecting') }
    } else if (status === 'auth_required') {
      return { tone: 'warn', text: t('connectionStatus.signInToSync', 'Sign in to sync') }
    } else if (status === 'test_mode') {
      return { tone: 'violet', text: t('connectionStatus.testMode', 'Test mode') }
    } else {
      return { tone: 'neutral', text: t('connectionStatus.unknown', 'Unknown') }
    }
  }

  const labelMap = {
    api: t('connectionStatus.api', 'API'),
    server: t('connectionStatus.server', 'Server'),
    websocket: t('connectionStatus.webSocket', 'WebSocket'),
    scoreboard: t('connectionStatus.scoreboard', 'Scoreboard'),
    match: t('connectionStatus.match', 'Match'),
    db: t('connectionStatus.database', 'Database'),
    // status key 'supabase' is the self-hosted OpenVolley cloud backend now
    supabase: t('connectionStatus.cloud', 'Cloud sync')
  }

  const getOverallStatus = () => {
    // Helper to check if a status is considered "OK"
    const isStatusOk = (status) => {
      return status === 'connected' ||
        status === 'live' ||
        status === 'scheduled' ||
        status === 'synced' ||
        status === 'syncing' ||
        status === 'test_mode' ||
        status === 'not_applicable' ||
        status === 'not_available' ||
        status === 'no_match' // No match is OK - just waiting for match selection
    }

    const serverStatus = connectionStatuses.server
    const websocketStatus = connectionStatuses.websocket
    const supabaseStatus = connectionStatuses.supabase
    const matchStatus = connectionStatuses.match

    // Check if Server+WebSocket path is viable
    const serverWebsocketViable = isServerWebsocketViable(serverStatus, websocketStatus)

    // Check if Supabase path is viable
    const supabaseViable = supabaseStatus === 'connected'

    // At least one connection path must be working
    const hasViableConnection = serverWebsocketViable || supabaseViable

    if (!hasViableConnection) {
      // Unreachable cloud and no local server: offline, not an error
      if (supabaseStatus === 'offline') return 'offline'
      return 'attention' // No viable connection path
    }

    // Check if we're waiting for match selection
    const waitingForMatch =
      websocketStatus === 'no_match' ||
      matchStatus === 'no_match' ||
      matchStatus === 'disconnected' ||
      matchStatus === 'unknown'

    if (waitingForMatch) {
      return 'awaiting_match'
    }

    return 'connected'
  }

  // No network as far as the browser knows, but a local server (offline
  // desktop / LAN scoretable serving tablets) can still be connected: then the
  // match runs normally and only the cloud copy waits ('Syncing...' + count).
  const overallStatus = browserOffline && !isServerWebsocketViable(connectionStatuses.server, connectionStatuses.websocket)
    ? 'offline'
    : errorCount > 0
      ? 'attention'
      : authRequired
        ? 'auth_required'
        : getOverallStatus()
  const statusInfo = getStatusColor(overallStatus)

  const sizeClasses = {
    normal: { pill: '', dot: 'h-2 w-2', chevron: 12 },
    small: { pill: 'h-6 px-2 text-[10px]', dot: 'h-1.5 w-1.5', chevron: 10 },
    large: { pill: 'h-9 px-3 text-sm', dot: 'h-2.5 w-2.5', chevron: 14 }
  }

  const currentSize = sizeClasses[size] || sizeClasses.normal
  const overallTone = STATUS_TONES[statusInfo.tone] || STATUS_TONES.neutral

  return (
    <div style={{ position: 'relative' }} data-connection-menu>
      <span className={KIT_SCOPE}>
        <button
          type="button"
          ref={buttonRef}
          aria-expanded={showConnectionMenu}
          onClick={(e) => {
            e.stopPropagation()
            if (!showConnectionMenu) {
              calculateMenuPosition()
            }
            setShowConnectionMenu(!showConnectionMenu)
          }}
          className={cn(STATUS_PILL, FOCUS_RING, overallTone.pill, currentSize.pill)}
        >
          <span className={cn('inline-block shrink-0 rounded-full', currentSize.dot, overallTone.dot)}></span>
          <span className="inline-flex items-center">
            {overallStatus === 'connected' ? (pendingCount > 0 ? t('connectionStatus.syncingDots', 'Syncing...') : t('connectionStatus.connected', 'Connected')) :
              overallStatus === 'awaiting_match' ? t('connectionStatus.ready', 'Ready') :
                overallStatus === 'offline'
                  ? (pendingCount > 0
                    ? t('connectionStatus.offlinePending', 'Offline ({{count}} waiting)', { count: pendingCount })
                    : t('connectionStatus.offline', 'Offline'))
                  : overallStatus === 'auth_required' ? t('connectionStatus.signInToSync', 'Sign in to sync') :
                    t('connectionStatus.error', 'Error')}
            {errorCount > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold tabular-nums text-white">
                {errorCount}
              </span>
            )}
          </span>
          <ChevronDown size={currentSize.chevron} aria-hidden="true" className={cn('opacity-70 transition-transform', showConnectionMenu && 'rotate-180')} />
        </button>
      </span>

      {/* Connection Status Menu */}
      {showConnectionMenu && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          className={cn('fixed w-max min-w-[220px] max-w-[300px] overflow-y-auto overflow-x-hidden', POPOVER_PANEL)}
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
            zIndex: 1000
          }}
        >
          <div className="mb-1 border-b border-stone-100 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
            {t('connectionStatus.title', 'Connection status')}
          </div>
          {Object.entries(shownStatuses).map(([key, status]) => {
            const itemStatusInfo = getStatusColor(status, key)
            const itemTone = STATUS_TONES[itemStatusInfo.tone] || STATUS_TONES.neutral

            let displayText = itemStatusInfo.text
            if (key === 'match' && status !== 'no_match' && status !== 'unknown') {
              displayText = status.charAt(0).toUpperCase() + status.slice(1)
            }

            const isConnected = status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing'
            const isReady = key === 'match' && status === 'no_match'
            const debugInfo = connectionDebugInfo[key]
            const expandable = !isConnected && !isReady

            return (
              <div key={key} className="relative border-b border-stone-100 last:border-b-0" data-debug-menu>
                <div
                  onClick={(e) => {
                    if (expandable) {
                      e.stopPropagation()
                      setShowDebugMenu(showDebugMenu === key ? null : key)
                    }
                  }}
                  className={cn(
                    'flex min-h-9 items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-xs transition-colors',
                    expandable ? 'cursor-pointer hover:bg-stone-50' : 'cursor-default'
                  )}
                >
                  <span className="font-semibold text-stone-700">{labelMap[key] || key}:</span>
                  <div className="flex items-center gap-1.5">
                    <StatusPill className={itemTone.tint}>{displayText}</StatusPill>
                    {expandable && (
                      <ChevronDown size={12} aria-hidden="true" className={cn('text-stone-400 transition-transform', showDebugMenu === key && 'rotate-180')} />
                    )}
                  </div>
                </div>

                {/* Queue stats for the cloud backend */}
                {key === 'supabase' && (pendingCount > 0 || errorCount > 0 || authRequired) && (
                  <div className="mx-1.5 mb-2 flex flex-col gap-1 rounded-lg border border-stone-200 bg-stone-50 p-2 text-[11px]">
                    {authRequired && (
                      <div className="text-amber-800">
                        {t('connectionStatus.signInToSyncHint', 'Not signed in: changes are kept on this device until you sign in.')}
                      </div>
                    )}
                    {pendingCount > 0 && (
                      <div className="flex justify-between gap-2 text-sky-800">
                        <span>{t('connectionStatus.pendingBackgroundSync', 'Pending background sync:')}</span>
                        <span className="font-bold tabular-nums">{pendingCount}</span>
                      </div>
                    )}
                    {stats.failed > 0 && (
                      <div className="flex justify-between gap-2 text-red-700">
                        <span>{t('connectionStatus.refusedByServer', 'Refused by the server:')}</span>
                        <span className="font-bold tabular-nums">{stats.failed}</span>
                      </div>
                    )}
                    {errorCount > 0 && (
                      <div className="flex items-center justify-between gap-2 text-red-700">
                        <span>{t('connectionStatus.synchronizationErrors', 'Synchronization errors:')}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold tabular-nums">{errorCount}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onRetryErrors?.()
                            }}
                            className={cn('inline-flex h-8 items-center rounded-lg border-0 bg-slate-900 px-2.5 text-[11px] font-semibold tracking-normal text-white hover:bg-slate-800 transition-colors cursor-pointer', FOCUS_RING)}
                          >
                            {t('common.retryAll', 'Retry all')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Debug Menu - inline instead of absolute to avoid overflow */}
                {expandable && showDebugMenu === key && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="mx-1.5 mb-2 break-words rounded-lg border border-stone-200 bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-700"
                  >
                    <div className="mb-2 text-xs font-semibold text-red-700">
                      {t('connectionStatus.statusInformation', 'Status information')}
                    </div>
                    <div className="mb-1.5">
                      <strong className="font-semibold text-stone-900">{t('connectionStatus.statusLabel', 'Status:')}</strong> {(() => {
                        const statusText = (debugInfo?.status || status || '').toString()
                        return statusText
                          .replace(/_/g, ' ')
                          .split(' ')
                          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                          .join(' ')
                      })()}
                    </div>
                    <div className="mb-1.5">
                      <strong className="font-semibold text-stone-900">{t('connectionStatus.messageLabel', 'Message:')}</strong> {debugInfo?.message || t('connectionStatus.connectionIssueDetected', 'Connection issue detected')}
                    </div>
                    {debugInfo?.details && (
                      <div className="mt-2 border-t border-stone-200 pt-2 text-[10px] text-stone-500">
                        {debugInfo.details}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
