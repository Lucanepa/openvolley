import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../db/db'

export default function ConnectionStatus({
  connectionStatuses = {},
  connectionDebugInfo = {},
  onCheckStatus,
  onRetryErrors,
  queueStats = { pending: 0, error: 0 },
  position = 'right', // 'left' | 'right' | 'center'
  size = 'normal' // 'normal' | 'small' | 'large'
}) {
  const { t } = useTranslation()

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

  const getStatusColor = (status, key) => {
    if (status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing') {
      return { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.5)', dot: '#22c55e', text: status === 'syncing' ? t('connectionStatus.syncing', 'Syncing') : t('connectionStatus.connected', 'Connected') }
    } else if (status === 'awaiting_match') {
      return { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.5)', dot: '#22c55e', text: t('connectionStatus.connected', 'Connected') }
    } else if (status === 'attention') {
      return { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.5)', dot: '#ef4444', text: t('connectionStatus.error', 'Error') }
    } else if (status === 'no_match') {
      // For websocket, "no_match" means waiting for a match to be selected - show as gray/ready
      const text = key === 'websocket' ? t('connectionStatus.noMatch', 'No Match') : t('connectionStatus.ready', 'Ready')
      return { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af', text }
    } else if (status === 'disconnected' || status === 'error' || status === 'offline') {
      return { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.5)', dot: '#ef4444', text: status === 'error' ? t('connectionStatus.error', 'Error') : status === 'offline' ? t('connectionStatus.offline', 'Offline') : t('connectionStatus.disconnected', 'Disconnected') }
    } else if (status === 'not_configured' || status === 'not_applicable') {
      return { bg: 'rgba(245, 158, 11, 0.2)', border: 'rgba(245, 158, 11, 0.5)', dot: '#f59e0b', text: t('connectionStatus.notConfigured', 'Not Configured') }
    } else if (status === 'not_available') {
      return { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af', text: t('connectionStatus.naStatic', 'N/A (Static)') }
    } else if (status === 'connecting') {
      return { bg: 'rgba(234, 179, 8, 0.2)', border: 'rgba(234, 179, 8, 0.5)', dot: '#eab308', text: t('connectionStatus.connecting', 'Connecting') }
    } else if (status === 'test_mode') {
      return { bg: 'rgba(139, 92, 246, 0.2)', border: 'rgba(139, 92, 246, 0.5)', dot: '#8b5cf6', text: t('connectionStatus.testMode', 'Test Mode') }
    } else {
      return { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af', text: t('connectionStatus.unknown', 'Unknown') }
    }
  }

  const labelMap = {
    api: t('connectionStatus.api', 'API'),
    server: t('connectionStatus.server', 'Server'),
    websocket: t('connectionStatus.webSocket', 'WebSocket'),
    scoreboard: t('connectionStatus.scoreboard', 'Scoreboard'),
    match: t('connectionStatus.match', 'Match'),
    db: t('connectionStatus.database', 'Database'),
    supabase: t('connectionStatus.supabase', 'Supabase')
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
    const serverPathOk = serverStatus === 'connected'
    const websocketPathOk = websocketStatus === 'connected' || websocketStatus === 'no_match'
    const serverWebsocketViable = serverPathOk && websocketPathOk

    // Check if Supabase path is viable
    const supabaseViable = supabaseStatus === 'connected'

    // At least one connection path must be working
    const hasViableConnection = serverWebsocketViable || supabaseViable

    if (!hasViableConnection) {
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

  const overallStatus = queueStats.error > 0 ? 'attention' : getOverallStatus()
  const statusInfo = getStatusColor(overallStatus)

  const sizeStyles = {
    normal: {
      fontSize: '12px',
      padding: '4px 8px',
      dotSize: '8px'
    },
    small: {
      fontSize: '10px',
      padding: '3px 6px',
      dotSize: '6px'
    },
    large: {
      fontSize: '14px',
      padding: '6px 12px',
      dotSize: '10px'
    }
  }

  const currentSize = sizeStyles[size]

  return (
    <div style={{ position: 'relative' }} data-connection-menu>
      <div
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation()
          if (!showConnectionMenu) {
            calculateMenuPosition()
          }
          setShowConnectionMenu(!showConnectionMenu)
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          height: '25px',
          fontSize: currentSize.fontSize,
          padding: currentSize.padding,
          background: statusInfo.bg,
          border: `1px solid ${statusInfo.border}`,
          borderRadius: '4px',
          cursor: 'pointer',
          transition: 'all 0.2s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = statusInfo.bg.replace('0.2', '0.3')
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = statusInfo.bg
        }}
      >
        <span style={{
          display: 'inline-block',
          width: currentSize.dotSize,
          height: currentSize.dotSize,
          borderRadius: '50%',
          background: statusInfo.dot
        }}></span>
        <span>
          {overallStatus === 'connected' ? (queueStats.pending > 0 ? t('connectionStatus.syncingDots', 'Syncing...') : t('connectionStatus.connected', 'Connected')) :
            overallStatus === 'awaiting_match' ? t('connectionStatus.ready', 'Ready') :
              t('connectionStatus.error', 'Error')}
          {queueStats.error > 0 && (
            <span style={{
              background: '#ef4444',
              color: '#fff',
              fontSize: '9px',
              borderRadius: '10px',
              padding: '0px 5px',
              marginLeft: '4px',
              fontWeight: 800
            }}>
              {queueStats.error}
            </span>
          )}
        </span>
        <span style={{ fontSize: `${parseInt(currentSize.fontSize) - 2}px`, marginLeft: '4px' }}>
          {showConnectionMenu ? '▲' : '▼'}
        </span>
      </div>

      {/* Connection Status Menu */}
      {showConnectionMenu && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            maxWidth: '300px',
            width: 'max-content',
            minWidth: '200px',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '12px',
            maxHeight: `${menuPosition.maxHeight}px`,
            overflowY: 'auto',
            overflowX: 'hidden',
            zIndex: 1000,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.6)'
          }}
        >
          <div style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--muted)',
            marginBottom: '8px',
            paddingBottom: '4px',
            borderBottom: '1px solid var(--border)'
          }}>
            {t('connectionStatus.title', 'Connection Status')}
          </div>
          {Object.entries(connectionStatuses).map(([key, status]) => {
            const itemStatusInfo = getStatusColor(status, key)

            let displayText = itemStatusInfo.text
            if (key === 'match' && status !== 'no_match' && status !== 'unknown') {
              displayText = status.charAt(0).toUpperCase() + status.slice(1)
            }

            const isConnected = status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing'
            const isReady = key === 'match' && status === 'no_match'
            const debugInfo = connectionDebugInfo[key]

            return (
              <div key={key} style={{ position: 'relative' }} data-debug-menu>
                <div
                  onClick={(e) => {
                    if (!isConnected && !isReady) {
                      e.stopPropagation()
                      setShowDebugMenu(showDebugMenu === key ? null : key)
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 8px',
                    marginBottom: '4px',
                    fontSize: '12px',
                    background: itemStatusInfo.bg,
                    border: `1px solid ${itemStatusInfo.border}`,
                    borderRadius: '4px',
                    cursor: (!isConnected && !isReady) ? 'pointer' : 'default',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (!isConnected && !isReady) {
                      e.currentTarget.style.background = itemStatusInfo.bg.replace('0.2', '0.3')
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isConnected && !isReady) {
                      e.currentTarget.style.background = itemStatusInfo.bg
                    }
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{labelMap[key] || key}:</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{
                      display: 'inline-block',
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: itemStatusInfo.dot
                    }}></span>
                    <span style={{ color: status === 'no_match' ? 'rgba(156, 163, 175, 1)' : 'inherit' }}>{displayText}</span>
                    {!isConnected && !isReady && (
                      <span style={{ fontSize: '10px', marginLeft: '4px' }}>
                        {showDebugMenu === key ? '▲' : '▼'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Queue Stats for Supabase */}
                {key === 'supabase' && (queueStats.pending > 0 || queueStats.error > 0) && (
                  <div style={{
                    padding: '8px',
                    margin: '0 8px 8px',
                    background: 'var(--panel-2)',
                    borderRadius: '4px',
                    fontSize: '11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}>
                    {queueStats.pending > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#3b82f6' }}>
                        <span>{t('connectionStatus.pendingBackgroundSync', 'Pending background sync:')}</span>
                        <span style={{ fontWeight: 700 }}>{queueStats.pending}</span>
                      </div>
                    )}
                    {queueStats.error > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#ef4444' }}>
                        <span>{t('connectionStatus.synchronizationErrors', 'Synchronization errors:')}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: 700 }}>{queueStats.error}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onRetryErrors?.()
                            }}
                            style={{
                              padding: '2px 8px',
                              background: '#ef4444',
                              color: '#fff',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '10px',
                              fontWeight: 600,
                              cursor: 'pointer'
                            }}
                          >
                            {t('common.retryAll', 'Retry All')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Debug Menu - inline instead of absolute to avoid overflow */}
                {!isConnected && !isReady && showDebugMenu === key && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      marginTop: '4px',
                      marginBottom: '8px',
                      background: 'var(--panel-2)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      padding: '10px',
                      fontSize: '11px',
                      lineHeight: '1.5',
                      wordBreak: 'break-word'
                    }}
                  >
                    <div style={{
                      fontWeight: 600,
                      marginBottom: '8px',
                      color: '#ef4444',
                      fontSize: '12px'
                    }}>
                      {t('connectionStatus.statusInformation', 'Status Information')}
                    </div>
                    <div style={{ marginBottom: '6px', color: 'var(--text)' }}>
                      <strong>{t('connectionStatus.statusLabel', 'Status:')}</strong> {(() => {
                        const statusText = (debugInfo?.status || status || '').toString()
                        return statusText
                          .replace(/_/g, ' ')
                          .split(' ')
                          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                          .join(' ')
                      })()}
                    </div>
                    <div style={{ marginBottom: '6px', color: 'var(--text)' }}>
                      <strong>{t('connectionStatus.messageLabel', 'Message:')}</strong> {debugInfo?.message || t('connectionStatus.connectionIssueDetected', 'Connection issue detected')}
                    </div>
                    {debugInfo?.details && (
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)', color: 'var(--muted)', fontSize: '10px' }}>
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
