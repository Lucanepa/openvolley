// Debug Logger - the scoreboard's debug lines (EVENT_CREATED, POINT_AWARDED,
// ROTATION, UNDO_*, ...).
//
// Since 2.4.0 they go into the interaction log (utils/comprehensiveLogger,
// IndexedDB interaction_logs, category 'debug'): the same retention (30 days,
// 50,000 rows) and they are part of the diagnostic export. Before, the whole
// array was rewritten to localStorage at every entry (last 5000, quota
// failures silent) and never exported. The old localStorage copy is moved
// once at start (comprehensiveLogger.migrateDebugLogs).
// Local only, never synced. A state snapshot larger than 20 KB is dropped.

import { log as interactionLog, trimDebugData } from './comprehensiveLogger'
import { countSetsWon } from '../domain/matchEnd'

const RECENT_MAX = 200 // in-memory copy for the console (getLogs)

class DebugLogger {
  constructor() {
    this.recent = []
    this.enabled = true
  }

  log(action, data = {}, stateSnapshot = null) {
    if (!this.enabled) return
    const type = String(action || 'debug')
    const payload = trimDebugData(stateSnapshot ? { ...(data || {}), stateSnapshot } : data)
    const entry = { timestamp: new Date().toISOString(), action: type, data: payload }
    this.recent.push(entry)
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX)
    try {
      interactionLog('debug', type, 'DebugLogger', type, payload)
    } catch (e) {
      // logging must never break scoring
    }
    let toConsole = false
    try {
      toConsole = (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') || localStorage.getItem('debugLogConsole') === 'true'
    } catch { /* storage blocked */ }
    if (toConsole) console.log(`[DEBUG] ${type}`, payload)
  }

  // Log with full state snapshot
  logWithState(action, data, getStateSnapshot) {
    const stateSnapshot = typeof getStateSnapshot === 'function' ? getStateSnapshot() : getStateSnapshot
    this.log(action, data, stateSnapshot)
  }

  // The last entries of this page load (the full log is in the diagnostic export)
  getLogs() {
    return [...this.recent]
  }

  getLogsByAction(actionType) {
    return this.recent.filter(l => l.action.includes(actionType))
  }

  getRecentLogs(minutes = 30) {
    const cutoff = Date.now() - (minutes * 60 * 1000)
    return this.recent.filter(l => new Date(l.timestamp).getTime() > cutoff)
  }

  clear() {
    this.recent = []
  }

  exportAsJSON() {
    return JSON.stringify({ exportDate: new Date().toISOString(), totalLogs: this.recent.length, logs: this.recent }, null, 2)
  }

  setEnabled(enabled) {
    this.enabled = enabled
  }

  getCount() {
    return this.recent.length
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
    setIndex: currentSet?.index,

    // Scores (a set has its points and `finished`, no winner field)
    homeScore: currentSet?.homePoints,
    awayScore: currentSet?.awayPoints,
    homeSetsWon: countSetsWon(sets).home,
    awaySetsWon: countSetsWon(sets).away,

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
