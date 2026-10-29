import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { GHOST_CLICK_MS } from './useConfirmAction'
import { TAP_SLOP_PX, pressOfClick, pressDistance, trackPresses } from '../utils/pointerPresses'

/**
 * Start rally and Point A | Point B take turns in the same place (the phone's
 * rally buttons too). The second tap of a double tap, a finger bouncing or a
 * tablet registering one tap twice, landed on the button that had just
 * replaced the first one: a double tap on Start rally gave the rally to the
 * team under the finger, a triple tap on Point B gave one rally two points
 * (stress test 2026-10-25, taps 40 to 250 ms apart, all at the same place).
 *
 * Up to 3.0.6 every tap was ignored for GHOST_CLICK_MS after the buttons
 * changed, wherever it landed, timed when its click handler ran. That also
 * swallowed the deliberate click of a quick scorer: Start rally, then Point B
 * as soon as it shows (owner, 29.10.2026, desktop mouse: "I have to click
 * sometimes twice on the point box"). Point A | Point B are drawn 110-130 ms
 * after Start rally's press on a desktop, 160-570 ms (up to 1.2 s) with the
 * CPU 4x slower, so a Point press up to about 0.5 s after Start rally's
 * press (desktop; 0.6 s and more on a slow device) was dropped, without a
 * word (browser checks of 29.10.2026).
 *
 * A tap is now judged by its press (pointerdown, on the input's own clock)
 * and where it landed (utils/pointerPresses):
 *   - at the same place as the press before it (a double tap, a bounce, a
 *     re-tap of a scorer on a slow screen), or where unknown: ignored when it
 *     is pressed less than GHOST_CLICK_MS after the buttons changed or after
 *     that press, if that was on the rally buttons too (a triple tap is one
 *     burst) - as before, and on the press's clock;
 *   - elsewhere (aimed at the new button): ignored only when pressed before
 *     the new buttons were drawn or less than RALLY_TAP_REACTION_MS after (it
 *     was aimed at the old ones; nobody reacts to a button that fast).
 * Not when the screen first shows them (as before). Keys never pass through
 * here (a key does not bounce).
 */

// Nobody presses a button that fast in reaction to it being drawn: as a
// sprint start, where a reaction under 100 ms after the gun is a false start.
// A press that soon after the change was aimed at the screen before it (a
// quick scorer's Point came 118-280 ms after Point B was drawn: CPU 1x-4x)
export const RALLY_TAP_REACTION_MS = 100

const RALLY_BUTTON = '[data-help-id="scoreboard-start-rally"], [data-help-id="scoreboard-point-left"], [data-help-id="scoreboard-point-right"]'

function onRallyButton(target) {
  try {
    return !!target?.closest?.(RALLY_BUTTON)
  } catch {
    return false
  }
}

/**
 * Is a tap on the rally buttons the tail of an earlier tap?
 * @param {{ press: { t: number, x: number|null, y: number|null }, previous: { t: number, x: number|null, y: number|null, onRally?: boolean } | null, changedAt: number, ghostMs?: number, reactionMs?: number, slopPx?: number }} tap
 *   press: this tap's press; previous: the press before it (anywhere on the
 *   page; onRally: on the rally buttons); changedAt: when the rally buttons
 *   last changed (-Infinity: not since the screen opened). One clock
 *   (performance.now()).
 * @returns {null | 'double_tap' | 'too_soon'} null: the scorer's tap
 */
export function rallyTapVerdict({ press, previous, changedAt, ghostMs = GHOST_CLICK_MS, reactionMs = RALLY_TAP_REACTION_MS, slopPx = TAP_SLOP_PX }) {
  const distance = pressDistance(press, previous)
  if (distance != null && distance > slopPx) {
    return press.t - changedAt < reactionMs ? 'too_soon' : null
  }
  const from = Math.max(changedAt, previous?.onRally ? previous.t : -Infinity)
  return press.t - from < ghostMs ? 'double_tap' : null
}

/**
 * The rally buttons' tap guard for a screen showing `rallyStatus`
 * ('idle' | 'in_play'): returns check(clickEvent) → { verdict, ... }
 * (rallyTapVerdict; verdict null: the tap counts).
 */
export function useRallyTapGuard(rallyStatus) {
  const buttonsRef = useRef({ status: null, changedAt: -Infinity })
  // Drawn: a layout effect, before the next tap can reach them. Monotonic
  // clock: a device clock set back must not hold them.
  useLayoutEffect(() => {
    const buttons = buttonsRef.current
    if (buttons.status !== null && buttons.status !== rallyStatus) buttons.changedAt = performance.now()
    buttons.status = rallyStatus
  }, [rallyStatus])
  useEffect(() => { trackPresses() }, [])

  return useCallback((event) => {
    const native = event?.nativeEvent ?? event ?? null
    const { press, previous } = pressOfClick(native)
    const changedAt = buttonsRef.current.changedAt
    const prev = previous ? { ...previous, onRally: onRallyButton(previous.target) } : null
    const verdict = rallyTapVerdict({ press, previous: prev, changedAt })
    return {
      verdict,
      sinceChangeMs: Number.isFinite(changedAt) ? Math.round(press.t - changedAt) : null,
      sincePreviousMs: prev ? Math.round(press.t - prev.t) : null,
      distancePx: pressDistance(press, prev) == null ? null : Math.round(pressDistance(press, prev))
    }
  }, [])
}
