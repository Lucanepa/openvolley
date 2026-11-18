import { useEffect, useState } from 'react'
import { secondsLeft } from '../../utils/countdownClock'

/**
 * The seconds left of a running countdown, ticking in the component that
 * shows them. The time-out countdown was Scoreboard state: each second (and,
 * before, ten times a second) it rendered the whole scoring screen. On a
 * small tablet that held up touches during a time-out: a substitution
 * dragged in could not be confirmed until the time-out was over (owner,
 * 17.11.2026). Now only the digits and the bar render each second.
 *
 * @param {{ anchor: number, duration: number } | null} clock countdownAnchor() and length (s)
 * @param {number} [fallback] shown without a clock
 */
export function useCountdownSeconds (clock, fallback) {
  const anchor = clock?.anchor
  const duration = clock?.duration
  const [seconds, setSeconds] = useState(() => (clock ? secondsLeft(anchor, duration) : fallback))
  useEffect(() => {
    if (anchor == null || duration == null) return undefined
    const tick = () => setSeconds(secondsLeft(anchor, duration)) // the same number renders nothing
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [anchor, duration])
  return clock ? seconds : fallback
}

/** Render prop: `<CountdownSeconds clock={...}>{(seconds) => ...}</CountdownSeconds>` */
export default function CountdownSeconds ({ clock, fallback, children }) {
  return children(useCountdownSeconds(clock, fallback))
}
