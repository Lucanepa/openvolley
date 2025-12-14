import { useState, useEffect, useCallback, useRef } from 'react'
import { db } from '../db/db'

export default function ConnectionStatus({ 
  connectionStatuses = {}, 
  connectionDebugInfo = {},
  onCheckStatus,
  position = 'right', // 'left' | 'right' | 'center'
  size = 'normal' // 'normal' | 'small' | 'large'
}) {
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

  const getStatusColor = (status) => {
    if (status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing') {
      return { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.5)', dot: '#22c55e', text: status === 'syncing' ? 'Syncing' : 'Connected' }
    } else if (status === 'awaiting_match') {
      return { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.5)', dot: '#22c55e', text: 'Connected' }
    } else if (status === 'attention') {
      return { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.5)', dot: '#ef4444', text: 'Error' }
    } else if (status === 'no_match') {
      return { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af', text: 'Ready' }
    } else if (status === 'disconnected' || status === 'error' || status === 'offline') {
      return { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.5)', dot: '#ef4444', text: status === 'error' ? 'Error' : status === 'offline' ? 'Offline' : 'Disconnected' }
    } else if (status === 'not_configured' || status === 'not_applicable') {
      return { bg: 'rgba(245, 158, 11, 0.2)', border: 'rgba(245, 158, 11, 0.5)', dot: '#f59e0b', text: 'Not Configured' }
    } else if (status === 'connecting') {
      return { bg: 'rgba(234, 179, 8, 0.2)', border: 'rgba(234, 179, 8, 0.5)', dot: '#eab308', text: 'Connecting' }
    } else if (status === 'test_mode') {
      return { bg: 'rgba(139, 92, 246, 0.2)', border: 'rgba(139, 92, 246, 0.5)', dot: '#8b5cf6', text: 'Test Mode' }
    } else {
      return { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af', text: 'Unknown' }
    }
  }

  const labelMap = {
    api: 'API',
    server: 'Server',
    websocket: 'WebSocket',
    scoreboard: 'Scoreboard',
    match: 'Match',
    db: 'Database',
    supabase: 'Supabase'
  }

  const getOverallStatus = () => {
    // Check all connection statuses
    const statuses = Object.entries(connectionStatuses)
    
    // Check if only match is disconnected
    const matchStatus = connectionStatuses.match
    const otherStatuses = statuses.filter(([key]) => key !== 'match')
    
    const onlyMatchDisconnected = (
      (matchStatus === 'no_match' || matchStatus === 'disconnected' || matchStatus === 'unknown') &&
      otherStatuses.every(([, status]) => {
        return status === 'connected' || 
               status === 'live' || 
               status === 'scheduled' || 
               status === 'synced' || 
               status === 'syncing' ||
               status === 'test_mode' ||
               status === 'not_applicable' // Not applicable is considered OK
      })
    )
    
    if (onlyMatchDisconnected) {
      return 'awaiting_match'
    }
    
    // If any status is not connected/ok, show attention
    const allConnected = statuses.every(([, status]) => {
      return status === 'connected' || 
             status === 'live' || 
             status === 'scheduled' || 
             status === 'synced' || 
             status === 'syncing' ||
             status === 'test_mode' ||
             status === 'not_applicable' // Not applicable is considered OK
    })
    
    if (allConnected && statuses.length > 0) {
      return 'connected'
    } else {
      return 'attention' // Use 'attention' instead of 'disconnected' for the overall status
    }
  }

  const overallStatus = getOverallStatus()
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
          gap: '6px',
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
          {overallStatus === 'connected' ? 'Connected' : 
           overallStatus === 'awaiting_match' ? 'Ready' : 
           'Error'}
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
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
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
            color: 'rgba(255, 255, 255, 0.6)',
            marginBottom: '8px',
            paddingBottom: '4px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            Connection Status
          </div>
          {Object.entries(connectionStatuses).map(([key, status]) => {
            const itemStatusInfo = getStatusColor(status)
            
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
                
                {/* Debug Menu - inline instead of absolute to avoid overflow */}
                {!isConnected && !isReady && showDebugMenu === key && debugInfo && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      marginTop: '4px',
                      marginBottom: '8px',
                      background: 'rgba(30, 30, 40, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
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
                      Status Information
                    </div>
                    <div style={{ marginBottom: '6px', color: 'rgba(255, 255, 255, 0.9)' }}>
                      <strong>Status:</strong> {(() => {
                        const statusText = (debugInfo.status || status || '').toString()
                        return statusText
                          .replace(/_/g, ' ')
                          .split(' ')
                          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                          .join(' ')
                      })()}
                    </div>
                    <div style={{ marginBottom: '6px', color: 'rgba(255, 255, 255, 0.8)' }}>
                      <strong>Message:</strong> {debugInfo.message || 'No additional information'}
                    </div>
                    {debugInfo.details && (
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.2)', color: 'rgba(255, 255, 255, 0.7)', fontSize: '10px' }}>
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
