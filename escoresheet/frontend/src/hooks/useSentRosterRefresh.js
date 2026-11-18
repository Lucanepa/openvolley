/**
 * Keeps the device's copy of a game's sent rosters fresh while Match Setup is
 * open (db/023, offline first: the screen only ever reads db.game_rosters).
 *
 * 17.11.2026: a team manager sent the roster at 19:40 while the scorer had
 * Match Setup open since 19:32; the screen had asked once, when it opened, and
 * the card never appeared. Now it asks again every SENT_ROSTER_POLL_MS, and at
 * once when the screen comes back (tab or app shown again, window focused,
 * connection back). Never offline, never while hidden, never two at a time,
 * and not again within SENT_ROSTER_MIN_GAP_MS (focus and visibility come
 * together).
 */

import { useEffect, useRef } from 'react'

export const SENT_ROSTER_POLL_MS = 60 * 1000
export const SENT_ROSTER_MIN_GAP_MS = 5 * 1000

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/**
 * Start asking (`refresh`, async) now, on a timer and when the screen comes
 * back. Returns the function that stops it.
 */
export function startSentRosterWatch({
  refresh,
  intervalMs = SENT_ROSTER_POLL_MS,
  minGapMs = SENT_ROSTER_MIN_GAP_MS,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  isOnline = browserOnline,
  now = () => Date.now()
}) {
  let stopped = false
  let inFlight = false
  let last = -Infinity
  const tick = () => {
    if (stopped || inFlight || !isOnline()) return
    if (doc?.visibilityState === 'hidden') return
    if (now() - last < minGapMs) return
    inFlight = true
    last = now()
    Promise.resolve()
      .then(refresh)
      .catch(() => { /* the cache stays as it is */ })
      .finally(() => { inFlight = false })
  }
  const onVisibility = () => { if (doc?.visibilityState !== 'hidden') tick() }
  tick()
  const timer = setInterval(tick, intervalMs)
  doc?.addEventListener?.('visibilitychange', onVisibility)
  // Capacitor's app coming back to the front (Android, iOS)
  doc?.addEventListener?.('resume', tick)
  win?.addEventListener?.('focus', tick)
  win?.addEventListener?.('online', tick)
  return () => {
    stopped = true
    clearInterval(timer)
    doc?.removeEventListener?.('visibilitychange', onVisibility)
    doc?.removeEventListener?.('resume', tick)
    win?.removeEventListener?.('focus', tick)
    win?.removeEventListener?.('online', tick)
  }
}

/** startSentRosterWatch while `enabled`; `refresh` may change between renders. */
export function useSentRosterRefresh(enabled, refresh, { intervalMs = SENT_ROSTER_POLL_MS } = {}) {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!enabled) return undefined
    return startSentRosterWatch({ refresh: () => refreshRef.current?.(), intervalMs })
  }, [enabled, intervalMs])
}
