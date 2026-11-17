import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '../ui/cn.js'
import { MenuPopover } from '../ui/MenuPopover.jsx'
import { StatusPill } from '../ui/StatusPill.jsx'
import { updatesByReload } from '../utils/appUpdate'
import { applyServiceWorkerUpdate } from '../hooks/useServiceWorker'
import { FOCUS_RING, KIT_SCOPE, STATUS_PILL, STATUS_TONES } from './chromeClasses'

import { useConnectionSummary, statusColorOf, SYNCING_SHOW_AFTER_MS } from '../hooks/useConnectionSummary'

// (re-exported: tests and callers import them from here)
export { useConnectionSummary, SYNCING_SHOW_AFTER_MS }
export default function ConnectionStatus({
  connectionStatuses = {},
  connectionDebugInfo = {},
  onCheckStatus,
  onRetryErrors,
  queueStats = null,
  position = 'right', // 'left' | 'right' | 'center'
  size = 'normal', // 'normal' | 'small' | 'large'
  // The dot and the chevron only, the status as the button's name: a phone's
  // header has no room for the word (2026-10-13)
  compact = false
}) {
  const { t } = useTranslation()
  const {
    stats, pendingCount, errorCount, serverBehind, authRequired, updateRequired, updateNeeded, shownStatuses, overallStatus, statusInfo, pillText
  } = useConnectionSummary({ connectionStatuses, queueStats })

  const [showConnectionMenu, setShowConnectionMenu] = useState(false)
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for
  const buttonRef = useRef(null)

  // Close menus when clicking outside
  useEffect(() => {
    // (the popover closes itself on a press outside it: ui/MenuPopover.jsx)
    const handleClickOutside = (e) => {
      if (showDebugMenu && !e.target.closest('[data-debug-menu]')) {
        setShowDebugMenu(null)
      }
    }

    if (showDebugMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [showConnectionMenu, showDebugMenu])

  const getStatusColor = (status, key) => statusColorOf(t, status, key)

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

  const sizeClasses = {
    normal: { pill: '', dot: 'h-2 w-2', chevron: 12 },
    small: { pill: 'h-6 px-2 text-[10px]', dot: 'h-1.5 w-1.5', chevron: 10 },
    large: { pill: 'h-9 px-3 text-sm', dot: 'h-2.5 w-2.5', chevron: 14 }
  }

  const currentSize = sizeClasses[size] || sizeClasses.normal
  const overallTone = STATUS_TONES[statusInfo.tone] || STATUS_TONES.neutral
  // The compact pill shows only the dot and the error badge: its name says both
  const compactLabel = errorCount > 0
    ? t('connectionStatus.withErrors', '{{status}}, {{count}} sync errors', { status: pillText, count: errorCount })
    : pillText

  return (
    <div style={{ position: 'relative' }} data-connection-menu>
      <span className={KIT_SCOPE}>
        <button
          type="button"
          ref={buttonRef}
          aria-expanded={showConnectionMenu}
          onClick={(e) => {
            e.stopPropagation()
            setShowConnectionMenu(!showConnectionMenu)
          }}
          aria-label={compact ? compactLabel : undefined}
          title={compact ? compactLabel : undefined}
          className={cn(STATUS_PILL, FOCUS_RING, overallTone.pill, currentSize.pill, compact && 'px-2')}
        >
          <span className={cn('inline-block shrink-0 rounded-full', currentSize.dot, overallTone.dot)}></span>
          {(!compact || errorCount > 0) && (
            <span className="inline-flex items-center">
              {!compact && pillText}
              {errorCount > 0 && (
                <span className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold tabular-nums text-white', !compact && 'ml-1')}>
                  {errorCount}
                </span>
              )}
            </span>
          )}
          {/* the compact pill (a phone's header) has no room for the arrow */}
          {!compact && (
            <ChevronDown size={currentSize.chevron} aria-hidden="true" className={cn('opacity-70 transition-transform', showConnectionMenu && 'rotate-180')} />
          )}
        </button>
      </span>

      {/* Connection Status Menu */}
      {showConnectionMenu && (
        <MenuPopover
          open
          onClose={() => setShowConnectionMenu(false)}
          anchorRef={buttonRef}
          label={t('connectionStatus.title', 'Connection status')}
          role="dialog"
          align="start"
          closeLabel={t('common.close', 'Close')}
          panelProps={{ 'data-connection-menu': '' }}
          className="min-w-[220px] max-w-[300px] overflow-x-hidden p-3 text-stone-800"
        >
          <div className="menu-own-title mb-1 border-b border-stone-100 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
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
            // (an update needed: the box below says what to do)
            const expandable = !isConnected && !isReady && status !== 'update_required'

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
                {key === 'supabase' && (pendingCount > 0 || errorCount > 0 || authRequired || updateRequired) && (
                  <div className="mx-1.5 mb-2 flex flex-col gap-1 rounded-lg border border-stone-200 bg-stone-50 p-2 text-[11px]">
                    {updateRequired && (
                      <div className="flex flex-col gap-1.5 text-amber-800">
                        <span>
                          {updatesByReload()
                            ? t('connectionStatus.updateNeededHint', 'Update needed: reload the app after this rally. This version is too old for the server; the changes stay on this device and are sent after the update.')
                            : t('connectionStatus.updateNeededAppHint', 'Update needed: install the app update after this match. This version is too old for the server; the changes stay on this device and are sent after the update.')}
                        </span>
                        {updatesByReload() && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              // the newer build, when the worker has it (else a plain reload)
                              applyServiceWorkerUpdate({ checkForUpdate: true })
                            }}
                            className={cn('inline-flex h-8 items-center self-start rounded-lg border-0 bg-slate-900 px-2.5 text-[11px] font-semibold tracking-normal text-white hover:bg-slate-800 transition-colors cursor-pointer', FOCUS_RING)}
                          >
                            {t('connectionStatus.reloadNow', 'Reload now')}
                          </button>
                        )}
                      </div>
                    )}
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
                    {stats.serverBehind > 0 && (
                      <div className="flex flex-col gap-0.5 text-amber-800">
                        <div className="flex justify-between gap-2">
                          <span>{t('connectionStatus.waitingForServerUpdate', 'Waiting for a server update:')}</span>
                          <span className="font-bold tabular-nums">{stats.serverBehind}</span>
                        </div>
                        <span>{t('connectionStatus.waitingForServerUpdateHint', 'The server does not know some data of this app version yet. The changes stay on this device and are sent again every hour.')}</span>
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
        </MenuPopover>
      )}
    </div>
  )
}
