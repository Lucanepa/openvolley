import { useEffect, useRef, useState } from 'react'

export const COLLAPSE_TRANSITION = 'all 0.3s ease-in-out'

/**
 * The transition of a bar that collapses: on while it collapses or expands
 * (for `ms` after the change), 'none' otherwise. A permanent 'all 0.3s'
 * also animated an app scale change (the header 40 -> 50 px over 0.3 s),
 * moving everything under it frame by frame.
 */
export function useCollapseTransition(collapsed, ms = 400) {
  const lastRef = useRef(collapsed)
  const untilRef = useRef(0)
  const [, wake] = useState(0)
  if (lastRef.current !== collapsed) {
    lastRef.current = collapsed
    untilRef.current = Date.now() + ms
  }
  const active = Date.now() < untilRef.current
  // Off again once the animation is over, also without another render
  useEffect(() => {
    if (!active) return undefined
    const id = setTimeout(() => wake((n) => n + 1), Math.max(0, untilRef.current - Date.now()))
    return () => clearTimeout(id)
  }, [active])
  return active ? COLLAPSE_TRANSITION : 'none'
}
