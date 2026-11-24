import { useEffect, useState } from 'react'

/** How long the relay must report the scorer gone before the tablet warns. */
export const SCORER_AWAY_MS = 20000

/**
 * True once the relay has reported the scorer device gone (scorerPresent
 * false) for `delayMs` without a break: a laptop closed, an app crashed, the
 * scorer's Wi-Fi lost. A reconnect within the delay (a page reload, a short
 * dropout) shows nothing; `null` (unknown, an older relay) never warns.
 * @param {boolean|null} scorerPresent useRealtimeConnection's scorerPresent
 * @param {{ delayMs?: number, enabled?: boolean }} [options]
 */
export function useScorerAway(scorerPresent, { delayMs = SCORER_AWAY_MS, enabled = true } = {}) {
  const [away, setAway] = useState(false)
  useEffect(() => {
    if (!enabled || scorerPresent !== false) {
      setAway(false)
      return undefined
    }
    const timer = setTimeout(() => setAway(true), delayMs)
    return () => clearTimeout(timer)
  }, [scorerPresent, delayMs, enabled])
  return away
}
