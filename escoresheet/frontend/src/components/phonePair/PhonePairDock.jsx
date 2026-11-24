import { useLayoutEffect, useRef } from 'react'
import { registerPhonePairDock } from './phonePairStore'

/**
 * The place a screen keeps in its own bar for the "Phone keyboard" indicator
 * (PhonePairHost), so a live pairing never lies over a control: the phone
 * scoreboard's header, the tablet scoreboard's toolbar (or its folded strip).
 * `display: contents`: empty, it takes no room (and no gap) in the bar.
 *
 * @param {{ variant: 'phone'|'toolbar'|'strip' }} props the indicator's size there
 */
export default function PhonePairDock({ variant }) {
  const ref = useRef(null)
  useLayoutEffect(() => registerPhonePairDock(ref.current), [])
  return <span ref={ref} data-phone-pair-dock="" data-variant={variant} style={{ display: 'contents' }} />
}
