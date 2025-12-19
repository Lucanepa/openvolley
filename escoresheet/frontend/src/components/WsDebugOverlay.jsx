import { useState, useEffect } from 'react'
import { getWsDebugInfo, forceReconnect, getWebSocketStatus } from '../utils/serverDataSync'

/**
 * On-screen debug overlay for WebSocket debugging on mobile devices
 * Triple-tap anywhere to toggle visibility
 */
export default function WsDebugOverlay({ matchId }) {
  const [visible, setVisible] = useState(false)
  const [debugInfo, setDebugInfo] = useState(null)
  const [tapCount, setTapCount] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  // Triple-tap to toggle
  useEffect(() => {
    let timeout
    const handleTap = () => {
      setTapCount(prev => {
        const newCount = prev + 1
        if (newCount >= 3) {
          setVisible(v => !v)
          return 0
        }
        return newCount
      })

      clearTimeout(timeout)
      timeout = setTimeout(() => setTapCount(0), 500)
    }

    document.addEventListener('click', handleTap)
    return () => {
      document.removeEventListener('click', handleTap)
      clearTimeout(timeout)
    }
  }, [])

  // Refresh debug info periodically when visible
  useEffect(() => {
    if (!visible) return

    const refresh = () => {
      if (matchId) {
        setDebugInfo(getWsDebugInfo(matchId))
      }
    }

    refresh()
    const interval = setInterval(refresh, 1000)
    return () => clearInterval(interval)
  }, [visible, matchId, refreshKey])

  const handleForceReconnect = (e) => {
    e.stopPropagation()
    if (matchId) {
      forceReconnect(matchId)
      setRefreshKey(k => k + 1)
    }
  }

  const formatTime = (ts) => {
    if (!ts) return 'Never'
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const formatAgo = (ts) => {
    if (!ts) return ''
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    return `${Math.floor(secs / 3600)}h ago`
  }

  if (!visible) return null

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        bottom: 10,
        left: 10,
        right: 10,
        maxHeight: '50vh',
        overflowY: 'auto',
        background: 'rgba(0, 0, 0, 0.9)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: '11px',
        padding: '10px',
        borderRadius: '8px',
        zIndex: 99999,
        border: '1px solid #0f0'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong style={{ color: '#fff' }}>WebSocket Debug</strong>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleForceReconnect}
            style={{
              padding: '4px 8px',
              fontSize: '10px',
              background: '#f60',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Force Reconnect
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setVisible(false) }}
            style={{
              padding: '4px 8px',
              fontSize: '10px',
              background: '#666',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Close
          </button>
        </div>
      </div>

      {debugInfo ? (
        <div style={{ lineHeight: '1.6' }}>
          <div>
            <span style={{ color: '#888' }}>Status:</span>{' '}
            <span style={{
              color: debugInfo.readyStateLabel === 'OPEN' ? '#0f0' :
                     debugInfo.readyStateLabel === 'CONNECTING' ? '#ff0' : '#f00'
            }}>
              {debugInfo.readyStateLabel}
            </span>
          </div>
          <div>
            <span style={{ color: '#888' }}>URL:</span> {debugInfo.wsUrl || 'N/A'}
          </div>
          <div>
            <span style={{ color: '#888' }}>Connected:</span>{' '}
            {formatTime(debugInfo.connectedAt)} {debugInfo.connectedAt && <span style={{ color: '#888' }}>({formatAgo(debugInfo.connectedAt)})</span>}
          </div>
          <div>
            <span style={{ color: '#888' }}>Last message:</span>{' '}
            {formatTime(debugInfo.lastMessageAt)} {debugInfo.lastMessageAt && <span style={{ color: '#888' }}>({formatAgo(debugInfo.lastMessageAt)})</span>}
          </div>
          <div>
            <span style={{ color: '#888' }}>Last ping:</span>{' '}
            {formatTime(debugInfo.lastPingAt)} {debugInfo.lastPingAt && <span style={{ color: '#888' }}>({formatAgo(debugInfo.lastPingAt)})</span>}
          </div>
          <div>
            <span style={{ color: '#888' }}>Last pong:</span>{' '}
            {formatTime(debugInfo.lastPongAt)} {debugInfo.lastPongAt && <span style={{ color: '#888' }}>({formatAgo(debugInfo.lastPongAt)})</span>}
          </div>
          <div>
            <span style={{ color: '#888' }}>Messages received:</span> {debugInfo.messagesReceived}
          </div>
          <div>
            <span style={{ color: '#888' }}>Connection attempts:</span> {debugInfo.connectionAttempts}
          </div>
          <div>
            <span style={{ color: '#888' }}>Reconnect attempts:</span> {debugInfo.reconnectAttempts}
          </div>
          <div>
            <span style={{ color: '#888' }}>Subscribers:</span> {debugInfo.subscriberCount}
          </div>
          {debugInfo.lastError && (
            <div style={{ color: '#f66' }}>
              <span style={{ color: '#888' }}>Last error:</span>{' '}
              {formatTime(debugInfo.lastError.time)} - {debugInfo.lastError.message}
            </div>
          )}
          {debugInfo.errors.length > 0 && (
            <div style={{ marginTop: '8px', borderTop: '1px solid #333', paddingTop: '8px' }}>
              <div style={{ color: '#888' }}>Recent errors ({debugInfo.errors.length}):</div>
              {debugInfo.errors.slice(-5).map((err, i) => (
                <div key={i} style={{ color: '#f66', fontSize: '10px' }}>
                  {formatTime(err.time)} - {err.message}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: '#888' }}>Loading debug info...</div>
      )}

      <div style={{ marginTop: '8px', color: '#666', fontSize: '10px' }}>
        Triple-tap anywhere to hide. Match ID: {matchId}
      </div>
    </div>
  )
}
