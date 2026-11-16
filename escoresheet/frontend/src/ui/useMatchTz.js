import { useEffect, useRef } from 'react'
import { getMatchTz, setMatchTz } from './format.js'

// The match zones of the views open now, newest last (the referee view and the
// sheet it opens over it, for example): clocks read the newest one.
const holders = []
const apply = () => setMatchTz(holders.length ? holders[holders.length - 1] : null)

/**
 * Clocks read the match's own zone (match.tz, domain/sheetInputs) while the
 * calling view is mounted; the tool's zone again once no such view is open
 * (ui/format currentTz). The zone is also set during the first render, so the
 * first paint already prints the match's clock.
 * @param {string|null|undefined} tz
 */
export function useMatchTz(tz) {
  const zone = tz || null
  const registered = useRef(false)
  if (!registered.current && zone && getMatchTz() !== zone) setMatchTz(zone)
  useEffect(() => {
    holders.push(zone)
    registered.current = true
    apply()
    return () => {
      const i = holders.lastIndexOf(zone)
      if (i >= 0) holders.splice(i, 1)
      registered.current = false
      apply()
    }
  }, [zone])
}
