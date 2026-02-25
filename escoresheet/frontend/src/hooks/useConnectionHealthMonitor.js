import { useEffect, useRef } from 'react'
import { getTabletStatusSummary } from '../utils/connectionHealth'

/**
 * Monitor connection health for connected tablets during a live match.
 * Fires a callback when a previously-connected device transitions to disconnected.
 *
 * @param {Object} match - Current match object with heartbeat fields
 * @param {Function} onDeviceDisconnected - Called with { role, label } when a device drops
 * @param {Object} [options]
 * @param {number} [options.interval=5000] - Check interval in ms
 * @param {boolean} [options.enabled=true] - Enable/disable monitoring
 */
export function useConnectionHealthMonitor(match, onDeviceDisconnected, options = {}) {
  const { interval = 5000, enabled = true } = options
  const prevStatusRef = useRef({}) // { [role]: 'connected'|'stale'|'disconnected' }

  useEffect(() => {
    if (!enabled || !match) return

    const check = () => {
      const summary = getTabletStatusSummary(match)
      const prevStatuses = prevStatusRef.current

      for (const role of summary.roles) {
        const prev = prevStatuses[role.role]
        // Only alert when transitioning FROM connected/stale TO disconnected
        if (prev && (prev === 'connected' || prev === 'stale') && role.status === 'disconnected') {
          onDeviceDisconnected?.({ role: role.role, label: role.label })
        }
        prevStatuses[role.role] = role.status
      }

      prevStatusRef.current = prevStatuses
    }

    // Initial check
    check()

    const timer = setInterval(check, interval)
    return () => clearInterval(timer)
  }, [match, onDeviceDisconnected, interval, enabled])

  // Return current summary for convenience
  return getTabletStatusSummary(match)
}
