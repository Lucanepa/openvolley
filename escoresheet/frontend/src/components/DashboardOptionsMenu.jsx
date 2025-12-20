/**
 * DashboardOptionsMenu Component
 * Collapsible options menu for dashboard headers
 * Includes connection type selector and clear cache functionality
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { db } from '../db/db'
import { CONNECTION_TYPES, CONNECTION_STATUS } from '../hooks/useRealtimeConnection'

/**
 * Clear all cached data
 */
async function clearAllCache() {
  const errors = []

  // Clear IndexedDB tables
  try {
    await db.matches.clear()
  } catch (e) {
    errors.push('matches: ' + e.message)
  }

  try {
    await db.teams.clear()
  } catch (e) {
    errors.push('teams: ' + e.message)
  }

  try {
    await db.players.clear()
  } catch (e) {
    errors.push('players: ' + e.message)
  }

  try {
    await db.sets.clear()
  } catch (e) {
    errors.push('sets: ' + e.message)
  }

  try {
    await db.events.clear()
  } catch (e) {
    errors.push('events: ' + e.message)
  }

  try {
    await db.sync_queue.clear()
  } catch (e) {
    errors.push('sync_queue: ' + e.message)
  }

  // Clear localStorage items related to the app
  try {
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (
        key.startsWith('referee') ||
        key.startsWith('bench') ||
        key.startsWith('livescore') ||
        key.startsWith('roster') ||
        key.startsWith('match') ||
        key === 'preferredConnection'
      )) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key))
  } catch (e) {
    errors.push('localStorage: ' + e.message)
  }

  // Clear service worker caches
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map(name => caches.delete(name)))
    }
  } catch (e) {
    errors.push('caches: ' + e.message)
  }

  return errors.length === 0 ? { success: true } : { success: false, errors }
}

export function DashboardOptionsMenu({
  connectionType = CONNECTION_TYPES.AUTO,
  activeConnection = null,
  connectionStatus = CONNECTION_STATUS.DISCONNECTED,
  onConnectionChange,
  onReconnect,
  showConnectionOptions = true
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [clearResult, setClearResult] = useState(null)
  const menuRef = useRef(null)

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [isOpen])

  // Handle clear cache
  const handleClearCache = useCallback(async () => {
    if (isClearing) return

    const confirmed = window.confirm(
      'Clear all cached data?\n\nThis will:\n- Clear all local match data\n- Clear sync queue\n- Clear service worker caches\n- Log you out of current match\n\nThe page will reload after clearing.'
    )

    if (!confirmed) return

    setIsClearing(true)
    setClearResult(null)

    try {
      const result = await clearAllCache()
      setClearResult(result)

      if (result.success) {
        // Reload the page after a short delay
        setTimeout(() => {
          window.location.reload()
        }, 500)
      }
    } catch (err) {
      setClearResult({ success: false, errors: [err.message] })
    } finally {
      setIsClearing(false)
    }
  }, [isClearing])

  // Handle connection type change
  const handleConnectionChange = useCallback((type) => {
    if (onConnectionChange) {
      onConnectionChange(type)
    }
    setIsOpen(false)
  }, [onConnectionChange])

  // Get status color
  const getStatusColor = () => {
    switch (connectionStatus) {
      case CONNECTION_STATUS.CONNECTED:
        return '#22c55e' // green
      case CONNECTION_STATUS.CONNECTING:
        return '#f59e0b' // amber
      case CONNECTION_STATUS.FALLBACK:
        return '#3b82f6' // blue
      case CONNECTION_STATUS.ERROR:
        return '#ef4444' // red
      default:
        return '#6b7280' // gray
    }
  }

  // Get connection label
  const getConnectionLabel = () => {
    if (activeConnection === 'supabase') return 'Supabase'
    if (activeConnection === 'websocket') return 'WebSocket'
    return 'None'
  }

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      {/* Menu toggle button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          fontSize: '12px',
          fontWeight: 600,
          background: isOpen ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '6px',
          cursor: 'pointer'
        }}
        title="Options"
      >
        <span style={{ fontSize: '14px' }}>&#9881;</span>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: getStatusColor()
        }} />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          minWidth: '240px',
          background: 'rgba(30, 30, 40, 0.98)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          zIndex: 1000,
          overflow: 'hidden'
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            fontSize: '13px',
            fontWeight: 600,
            color: 'rgba(255, 255, 255, 0.7)'
          }}>
            Options
          </div>

          {/* Connection status */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px'
            }}>
              <span style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
                Connection
              </span>
              <span style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 600,
                color: getStatusColor()
              }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: getStatusColor()
                }} />
                {connectionStatus === CONNECTION_STATUS.FALLBACK ? 'Fallback' : connectionStatus}
              </span>
            </div>
            <div style={{
              fontSize: '11px',
              color: 'rgba(255, 255, 255, 0.5)'
            }}>
              Active: {getConnectionLabel()}
            </div>
          </div>

          {/* Connection type selector */}
          {showConnectionOptions && (
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{
                fontSize: '12px',
                color: 'rgba(255, 255, 255, 0.6)',
                marginBottom: '8px'
              }}>
                Connection Type
              </div>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px'
              }}>
                {[
                  { type: CONNECTION_TYPES.AUTO, label: 'Auto (Recommended)', desc: 'Supabase primary, WebSocket fallback' },
                  { type: CONNECTION_TYPES.SUPABASE, label: 'Supabase Only', desc: 'Database realtime only' },
                  { type: CONNECTION_TYPES.WEBSOCKET, label: 'WebSocket Only', desc: 'Direct server connection' }
                ].map(({ type, label, desc }) => (
                  <button
                    key={type}
                    onClick={() => handleConnectionChange(type)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      padding: '8px 12px',
                      background: connectionType === type ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                      border: connectionType === type ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      width: '100%',
                      textAlign: 'left'
                    }}
                  >
                    <span style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: connectionType === type ? '#3b82f6' : '#fff'
                    }}>
                      {label}
                    </span>
                    <span style={{
                      fontSize: '10px',
                      color: 'rgba(255, 255, 255, 0.5)'
                    }}>
                      {desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Reconnect button */}
          {onReconnect && (
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <button
                onClick={() => {
                  onReconnect()
                  setIsOpen(false)
                }}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'rgba(59, 130, 246, 0.2)',
                  color: '#3b82f6',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Reconnect
              </button>
            </div>
          )}

          {/* Clear cache button */}
          <div style={{ padding: '12px 16px' }}>
            <button
              onClick={handleClearCache}
              disabled={isClearing}
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '12px',
                fontWeight: 600,
                background: isClearing ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.2)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '6px',
                cursor: isClearing ? 'not-allowed' : 'pointer',
                opacity: isClearing ? 0.6 : 1
              }}
            >
              {isClearing ? 'Clearing...' : 'Clear Cache & Data'}
            </button>
            {clearResult && !clearResult.success && (
              <div style={{
                marginTop: '8px',
                padding: '8px',
                background: 'rgba(239, 68, 68, 0.1)',
                borderRadius: '4px',
                fontSize: '11px',
                color: '#ef4444'
              }}>
                Some items failed to clear: {clearResult.errors?.join(', ')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DashboardOptionsMenu
