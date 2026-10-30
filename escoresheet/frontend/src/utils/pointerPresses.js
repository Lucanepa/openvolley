/**
 * Where and when the last pointer presses on the page happened (pointerdown
 * on the window, capture phase: seen before any handler can stop it).
 *
 * The second tap of a double tap (a finger bouncing, a tablet registering one
 * tap twice, a nervous tap-tap) is a press at the SAME place a few hundred ms
 * after the first one. A deliberate next tap is aimed: at another place, or
 * later. The tap guards (the rally buttons: useRallyTapGuard; the ghost-click
 * guard after a confirm: useConfirmAction) tell the two apart from these
 * presses, on the input's own clock (event.timeStamp), not from the time
 * their handler happens to run: a click event comes only at the release, and
 * on a slow device its handler runs long after the press (a render in
 * between).
 *
 *   trackPresses()                       once (idempotent)
 *   const { press, previous } = pressOfClick(clickEvent)
 *   samePlace(press, previous)
 */

// Two presses at most this far apart (CSS px) are at the same place: a finger
// lands within a few px of its last tap, a mouse double click on the same
// pixel. Aiming at the next button (Start rally's label to Point B's: 68 px at
// 1280 px wide, 79 px at 1920) is farther.
export const TAP_SLOP_PX = 40

// A click's press is the last pointerdown when that came at most this long
// before it (a long press is still one tap; a press older than this belongs
// to something else)
const PRESS_MAX_AGE_MS = 5000
const KEEP = 3

let presses = []
let trackedWindow = null

const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * An event's time on the performance.now() clock: its timeStamp (the input's
 * own time in browsers), else now (jsdom stamps events with Date.now()).
 */
export function eventTime(event, now = perfNow) {
  const n = now()
  const ts = event?.timeStamp
  return typeof ts === 'number' && ts > 0 && ts <= n + 50 ? ts : n
}

function point(event) {
  const x = event?.clientX
  const y = event?.clientY
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : { x: null, y: null }
}

/** Record a pointer press (the window listener; tests call it directly). */
export function notePress(event) {
  presses.push({ t: eventTime(event), ...point(event), target: event?.target ?? null })
  if (presses.length > KEEP) presses.shift()
}

/** Start recording the presses on `win` (once per window; never removed: one passive listener). */
export function trackPresses(win = typeof window !== 'undefined' ? window : null) {
  if (!win || trackedWindow === win) return
  win.addEventListener('pointerdown', notePress, { capture: true, passive: true })
  trackedWindow = win
}

/** Tests only: forget the presses. */
export function resetPresses() {
  presses = []
}

/**
 * The press of the tap a click ends, and the press before it.
 * A click from a pointer (detail > 0) whose pointerdown was recorded: that
 * press (its time and place). Otherwise (a key on a focused button, a
 * synthetic click, no event): the click's own time, place unknown; the
 * previous press is then the last one recorded.
 * @param {Event|null|undefined} click the native click event
 * @returns {{ press: { t: number, x: number|null, y: number|null, target: any }, previous: { t: number, x: number|null, y: number|null, target: any } | null }}
 */
export function pressOfClick(click, now = perfNow) {
  const last = presses[presses.length - 1] || null
  const at = click ? eventTime(click, now) : now()
  if (click && click.detail > 0 && last && last.t <= at + 1 && at - last.t <= PRESS_MAX_AGE_MS) {
    return { press: last, previous: presses[presses.length - 2] || null }
  }
  return { press: { t: at, x: null, y: null, target: click?.target ?? null }, previous: last }
}

/** Same place: both positions known and at most `slop` apart. Unknown counts as the same place. */
export function samePlace(a, b, slop = TAP_SLOP_PX) {
  if (!a || !b || a.x == null || b.x == null) return true
  return Math.hypot(a.x - b.x, a.y - b.y) <= slop
}

/** The distance of two presses in px (null when a position is unknown). */
export function pressDistance(a, b) {
  if (!a || !b || a.x == null || b.x == null) return null
  return Math.hypot(a.x - b.x, a.y - b.y)
}
