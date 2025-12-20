/**
 * useDashboardServer Hook
 * Polls the backend server for connection status and connected dashboard clients
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getLocalIP, getServerStatus } from '../utils/networkInfo'

/**
 * Get WebSocket server URL
 */
function getWsServerUrl() {
  const backendUrl = import.meta.env.VITE_BACKEND_URL
  if (backendUrl) {
    return backendUrl
  }
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
  const hostname = window.location.hostname
  // In production (HTTPS), use same origin without port (Cloudflare handles routing)
  if (window.location.protocol === 'https:') {
    return `${protocol}://${hostname}`
  }
  return `${protocol}://${hostname}:8080`
}

/**
 * Fetch connected dashboard clients from the server
 */
async function fetchConnectedDashboards(matchId = null) {
  try {
    const serverUrl = getWsServerUrl()
    const url = matchId
      ? `${serverUrl}/api/server/connections?matchId=${matchId}`
      : `${serverUrl}/api/server/connections`

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      return { success: false, error: 'Server not responding' }
    }

    const data = await response.json()
    return { success: true, ...data }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

/**
 * Hook to manage dashboard server state and polling
 * @param {Object} options
 * @param {boolean} options.enabled - Whether to enable polling
 * @param {number} options.pollInterval - Polling interval in ms (default 5000)
 * @param {number|null} options.matchId - Filter connections by matchId
 */
export function useDashboardServer({ enabled = true, pollInterval = 5000, matchId = null } = {}) {
  const [serverStatus, setServerStatus] = useState({
    running: false,
    ip: null,
    port: 8080,
    wsPort: 8080,
    mode: 'local'
  })
  const [connectedDashboards, setConnectedDashboards] = useState([])
  const [dashboardCounts, setDashboardCounts] = useState({
    total: 0,
    referees: 0,
    benches: 0
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const pollIntervalRef = useRef(null)
  const isMountedRef = useRef(true)

  // Fetch server status and connected clients
  const refresh = useCallback(async () => {
    if (!isMountedRef.current) return

    try {
      // Fetch local IP and server status in parallel
      const [localIP, status, connectionsData] = await Promise.all([
        getLocalIP(),
        getServerStatus(),
        fetchConnectedDashboards(matchId)
      ])

      if (!isMountedRef.current) return

      setServerStatus({
        running: status.running || connectionsData.success,
        ip: localIP,
        port: window.location.port || 5173,
        wsPort: status.wsPort || 8080,
        mode: status.mode || 'local'
      })

      if (connectionsData.success) {
        setConnectedDashboards(connectionsData.clients || [])
        setDashboardCounts({
          total: connectionsData.dashboardClients || 0,
          referees: connectionsData.referees || 0,
          benches: connectionsData.benches || 0
        })
        setError(null)
      } else {
        setError(connectionsData.error)
      }
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err.message)
      setServerStatus(prev => ({ ...prev, running: false }))
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
      }
    }
  }, [matchId])

  // Start/stop polling based on enabled state
  useEffect(() => {
    isMountedRef.current = true

    if (enabled) {
      // Initial fetch
      refresh()

      // Set up polling
      pollIntervalRef.current = setInterval(refresh, pollInterval)
    }

    return () => {
      isMountedRef.current = false
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [enabled, pollInterval, refresh])

  // Build connection URL for display
  const connectionUrl = serverStatus.ip
    ? `http://${serverStatus.ip}:${serverStatus.port}`
    : null

  const wsConnectionUrl = serverStatus.ip
    ? `ws://${serverStatus.ip}:${serverStatus.wsPort}`
    : null

  return {
    // Server status
    serverRunning: serverStatus.running,
    serverIP: serverStatus.ip,
    serverPort: serverStatus.port,
    wsPort: serverStatus.wsPort,
    serverMode: serverStatus.mode,
    connectionUrl,
    wsConnectionUrl,

    // Connected dashboards
    connectedDashboards,
    dashboardCount: dashboardCounts.total,
    refereeCount: dashboardCounts.referees,
    benchCount: dashboardCounts.benches,

    // State
    loading,
    error,

    // Actions
    refresh
  }
}

export default useDashboardServer
