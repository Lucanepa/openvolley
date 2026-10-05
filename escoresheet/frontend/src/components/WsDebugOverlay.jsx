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
      className="no-print fixed bottom-2.5 left-2.5 right-2.5 max-h-[50vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 p-3 font-mono text-[11px] text-stone-200 shadow-card-lg"
      style={{ zIndex: 99999 }}
    >
      {/* Developer console: dark slate (the kit's tooltip surface), status words in their hue */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong className="font-sans text-xs font-semibold text-white">WebSocket Debug</strong>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleForceReconnect}
            className="inline-flex h-8 items-center rounded-lg border-0 bg-amber-400 px-3 font-sans text-[11px] font-semibold text-slate-900 hover:bg-amber-300 transition-colors cursor-pointer"
          >
            Force Reconnect
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setVisible(false) }}
            className="inline-flex h-8 items-center rounded-lg border border-slate-600 bg-transparent px-3 font-sans text-[11px] font-semibold text-stone-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>

      {debugInfo ? (
        <div className="leading-relaxed">
          <div>
            <span className="text-stone-400">Status:</span>{' '}
            <span className={
              debugInfo.readyStateLabel === 'OPEN' ? 'text-emerald-400' :
                debugInfo.readyStateLabel === 'CONNECTING' ? 'text-amber-300' : 'text-red-400'
            }>
              {debugInfo.readyStateLabel}
            </span>
          </div>
          <div>
            <span className="text-stone-400">URL:</span> {debugInfo.wsUrl || 'N/A'}
          </div>
          <div>
            <span className="text-stone-400">Connected:</span>{' '}
            {formatTime(debugInfo.connectedAt)} {debugInfo.connectedAt && <span className="text-stone-400">({formatAgo(debugInfo.connectedAt)})</span>}
          </div>
          <div>
            <span className="text-stone-400">Last message:</span>{' '}
            {formatTime(debugInfo.lastMessageAt)} {debugInfo.lastMessageAt && <span className="text-stone-400">({formatAgo(debugInfo.lastMessageAt)})</span>}
          </div>
          <div>
            <span className="text-stone-400">Last ping:</span>{' '}
            {formatTime(debugInfo.lastPingAt)} {debugInfo.lastPingAt && <span className="text-stone-400">({formatAgo(debugInfo.lastPingAt)})</span>}
          </div>
          <div>
            <span className="text-stone-400">Last pong:</span>{' '}
            {formatTime(debugInfo.lastPongAt)} {debugInfo.lastPongAt && <span className="text-stone-400">({formatAgo(debugInfo.lastPongAt)})</span>}
          </div>
          <div>
            <span className="text-stone-400">Messages received:</span> {debugInfo.messagesReceived}
          </div>
          <div>
            <span className="text-stone-400">Connection attempts:</span> {debugInfo.connectionAttempts}
          </div>
          <div>
            <span className="text-stone-400">Reconnect attempts:</span> {debugInfo.reconnectAttempts}
          </div>
          <div>
            <span className="text-stone-400">Subscribers:</span> {debugInfo.subscriberCount}
          </div>
          {debugInfo.lastError && (
            <div className="text-red-400">
              <span className="text-stone-400">Last error:</span>{' '}
              {formatTime(debugInfo.lastError.time)} - {debugInfo.lastError.message}
            </div>
          )}
          {debugInfo.errors.length > 0 && (
            <div className="mt-2 border-t border-slate-700 pt-2">
              <div className="text-stone-400">Recent errors ({debugInfo.errors.length}):</div>
              {debugInfo.errors.slice(-5).map((err, i) => (
                <div key={i} className="text-[10px] text-red-400">
                  {formatTime(err.time)} - {err.message}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-stone-400">Loading debug info...</div>
      )}

      <div className="mt-2 text-[10px] text-stone-500">
        Triple-tap anywhere to hide. Match ID: {matchId}
      </div>
    </div>
  )
}
