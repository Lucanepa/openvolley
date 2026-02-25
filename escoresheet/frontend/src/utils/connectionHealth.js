/**
 * Connection Health Utilities
 * Provides heartbeat-based health status for connected devices.
 * Extracted from Scoreboard.jsx for reuse across components.
 */

/**
 * Determine connection health based on last heartbeat timestamp.
 * @param {string|null} lastHeartbeat - ISO timestamp of last heartbeat
 * @param {Object} [thresholds] - Configurable thresholds in milliseconds
 * @param {number} [thresholds.connected=15000] - Max age for "connected" (green)
 * @param {number} [thresholds.stale=30000] - Max age for "stale" (yellow)
 * @returns {{ status: 'connected'|'stale'|'disconnected', color: string, ageMs: number|null }}
 */
export function getHeartbeatHealth(lastHeartbeat, thresholds = {}) {
  const { connected: connectedMs = 15000, stale: staleMs = 30000 } = thresholds

  if (!lastHeartbeat) {
    return { status: 'disconnected', color: '#ef4444', ageMs: null }
  }

  const heartbeatTime = new Date(lastHeartbeat).getTime()
  if (isNaN(heartbeatTime)) {
    return { status: 'disconnected', color: '#ef4444', ageMs: null }
  }

  const ageMs = Date.now() - heartbeatTime

  if (ageMs < connectedMs) {
    return { status: 'connected', color: '#22c55e', ageMs }
  }
  if (ageMs < staleMs) {
    return { status: 'stale', color: '#eab308', ageMs }
  }
  return { status: 'disconnected', color: '#ef4444', ageMs }
}

/**
 * Build a summary of all tablet connection statuses for a match.
 * @param {Object} match - Match object with connection flags and heartbeat fields
 * @returns {{ roles: Array, overallStatus: 'ok'|'issues'|'none', connectedCount: number, expectedCount: number }}
 */
export function getTabletStatusSummary(match) {
  if (!match) return { roles: [], overallStatus: 'none', connectedCount: 0, expectedCount: 0 }

  const roles = []

  if (match.refereeConnectionEnabled) {
    const health1 = getHeartbeatHealth(match.lastReferee1Heartbeat)
    const health2 = getHeartbeatHealth(match.lastReferee2Heartbeat)
    // Use the best status between referee 1 and 2
    const bestHealth = health1.status === 'connected' ? health1
      : health2.status === 'connected' ? health2
      : health1.status === 'stale' ? health1
      : health2.status === 'stale' ? health2
      : health1
    roles.push({
      role: 'referee',
      label: 'Referee',
      enabled: true,
      ...bestHealth
    })
  }

  if (match.homeTeamConnectionEnabled) {
    roles.push({
      role: 'bench_home',
      label: 'Home Bench',
      enabled: true,
      ...getHeartbeatHealth(match.lastHomeTeamHeartbeat)
    })
  }

  if (match.awayTeamConnectionEnabled) {
    roles.push({
      role: 'bench_away',
      label: 'Away Bench',
      enabled: true,
      ...getHeartbeatHealth(match.lastAwayTeamHeartbeat)
    })
  }

  const expectedCount = roles.length
  const connectedCount = roles.filter(r => r.status === 'connected').length
  const hasStale = roles.some(r => r.status === 'stale')
  const hasDisconnected = roles.some(r => r.status === 'disconnected')

  let overallStatus = 'none'
  if (expectedCount > 0) {
    overallStatus = (hasDisconnected || hasStale) ? 'issues' : 'ok'
  }

  return { roles, overallStatus, connectedCount, expectedCount }
}

/**
 * Format age in milliseconds to a human-readable relative time string.
 * @param {number|null} ageMs - Age in milliseconds
 * @returns {string} e.g., "2s", "1m", "5m", "--"
 */
export function formatAge(ageMs) {
  if (ageMs == null) return '--'
  if (ageMs < 1000) return '<1s'
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s`
  return `${Math.floor(ageMs / 60000)}m`
}
