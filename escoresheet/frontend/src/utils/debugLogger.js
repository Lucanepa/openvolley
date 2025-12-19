// Debug Logger - Comprehensive logging for all scoreboard actions
// Stores logs in memory and localStorage for persistence

const MAX_LOGS = 5000 // Keep last 5000 entries
const STORAGE_KEY = 'escoresheet_debug_logs'

class DebugLogger {
  constructor() {
    this.logs = []
    this.enabled = true
    this.loadFromStorage()
  }

  loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        this.logs = JSON.parse(stored)
      }
    } catch (e) {
      console.warn('Failed to load debug logs from storage:', e)
      this.logs = []
    }
  }

  saveToStorage() {
    try {
      // Keep only last MAX_LOGS entries
      if (this.logs.length > MAX_LOGS) {
        this.logs = this.logs.slice(-MAX_LOGS)
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.logs))
    } catch (e) {
      console.warn('Failed to save debug logs to storage:', e)
    }
  }

  log(action, data = {}, stateSnapshot = null) {
    if (!this.enabled) return

    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      action,
      data,
      stateSnapshot
    }

    this.logs.push(entry)
    this.saveToStorage()

    // Also log to console in dev mode
    if (process.env.NODE_ENV === 'development' || localStorage.getItem('debugLogConsole') === 'true') {
      console.log(`[DEBUG] ${action}`, data, stateSnapshot ? '(state snapshot included)' : '')
    }
  }

  // Log with full state snapshot
  logWithState(action, data, getStateSnapshot) {
    const stateSnapshot = typeof getStateSnapshot === 'function' ? getStateSnapshot() : getStateSnapshot
    this.log(action, data, stateSnapshot)
  }

  // Get all logs
  getLogs() {
    return [...this.logs]
  }

  // Get logs filtered by action type
  getLogsByAction(actionType) {
    return this.logs.filter(log => log.action.includes(actionType))
  }

  // Get logs from last N minutes
  getRecentLogs(minutes = 30) {
    const cutoff = Date.now() - (minutes * 60 * 1000)
    return this.logs.filter(log => new Date(log.timestamp).getTime() > cutoff)
  }

  // Clear all logs
  clear() {
    this.logs = []
    localStorage.removeItem(STORAGE_KEY)
  }

  // Export logs as JSON string
  exportAsJSON() {
    return JSON.stringify({
      exportDate: new Date().toISOString(),
      totalLogs: this.logs.length,
      logs: this.logs
    }, null, 2)
  }

  // Download logs as file
  downloadLogs(filename = null) {
    const json = this.exportAsJSON()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename || `debug_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // Enable/disable logging
  setEnabled(enabled) {
    this.enabled = enabled
  }

  // Get log count
  getCount() {
    return this.logs.length
  }
}

// Singleton instance
export const debugLogger = new DebugLogger()

// Helper function to create state snapshot from scoreboard data
export function createStateSnapshot(data) {
  if (!data) return null

  const { match, sets, currentSet, homeTeam, awayTeam, events } = data

  return {
    // Match info
    matchId: match?.id,
    setIndex: currentSet?.setIndex,

    // Scores
    homeScore: currentSet?.homeScore,
    awayScore: currentSet?.awayScore,
    homeSetsWon: sets?.filter(s => s.winner === 'home').length,
    awaySetsWon: sets?.filter(s => s.winner === 'away').length,

    // Service
    currentServe: currentSet?.currentServe,

    // Rotations (positions 1-6)
    homeRotation: currentSet?.homeRotation,
    awayRotation: currentSet?.awayRotation,

    // On court players
    homeOnCourt: currentSet?.homeOnCourt,
    awayOnCourt: currentSet?.awayOnCourt,

    // Libero tracking
    homeLiberoIn: currentSet?.homeLiberoIn,
    awayLiberoIn: currentSet?.awayLiberoIn,
    homeLiberoFor: currentSet?.homeLiberoFor,
    awayLiberoFor: currentSet?.awayLiberoFor,

    // Timeouts
    homeTimeouts: currentSet?.homeTimeouts,
    awayTimeouts: currentSet?.awayTimeouts,

    // Technical timeouts
    technicalTimeoutAt8: currentSet?.technicalTimeoutAt8,
    technicalTimeoutAt16: currentSet?.technicalTimeoutAt16,

    // Events count
    totalEvents: events?.length,

    // Rally state
    rallyInProgress: currentSet?.rallyInProgress,
    rallyStartTime: currentSet?.rallyStartTime
  }
}

export default debugLogger
