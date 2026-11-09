import { useEffect, useRef, useState } from 'react'
import TimeoutCountdown from './TimeoutCountdown.jsx'

/** How long the time-out ring takes to move from the popup to the court. */
export const COUNTDOWN_FLIGHT_MS = 450

/**
 * The time-out ring moving from the closed "Recorded" popup to its place on
 * the referee screen: a copy drawn at the popup's ring (`from`, a DOMRect)
 * slides to the court's (`to`), then `onDone` shows the court's own ring.
 */
export default function CountdownFlight({ from, to, countdown, fontFamily, onDone }) {
  const [landed, setLanded] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    // two frames: the copy is drawn at the start before it moves
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setLanded(true)) })
    const done = setTimeout(() => doneRef.current(), COUNTDOWN_FLIGHT_MS + 50)
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(done) }
  }, [])

  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  const scale = from.width > 0 ? to.width / from.width : 1
  return (
    <div
      aria-hidden="true"
      data-testid="countdown-flight"
      style={{
        position: 'fixed',
        left: from.left,
        top: from.top,
        width: from.width,
        height: from.height,
        zIndex: 1100,
        pointerEvents: 'none',
        transform: landed ? `translate(${dx}px, ${dy}px) scale(${scale})` : 'none',
        transition: `transform ${COUNTDOWN_FLIGHT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
      }}
    >
      <TimeoutCountdown countdown={countdown} fontFamily={fontFamily} />
    </div>
  )
}
