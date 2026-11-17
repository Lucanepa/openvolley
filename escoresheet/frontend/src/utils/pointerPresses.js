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
 * One physical tap is one press. WebKitGTK (the desktop app on Linux, the
 * Point Hub board) sends a touch tap as pointerdown/up of type 'touch' and
 * then, at the release, its compatibility mouse events WITH their own
 * pointer events: pointerdown/up of type 'mouse' (another pointerId), then
 * the one click (measured on the board, 17.11.2026: touch pointerdown,
 * ~80 ms later touch pointerup, mouse pointerdown + click 0-2 ms around it).
 * Recorded as two presses, that mouse press looked like the second tap of a
 * double tap at the same place 80 ms later, and the rally guard dropped
 * every tap ("Not counted: taken as a double tap" on Start set). A 'mouse'
 * pointerdown at the place of the touch (or pen) press just before it, while
 * that is still down or right after its release, is that echo: not a press.
 * Browsers that follow the Pointer Events spec (Chromium, Android WebView,
 * Safari) fire no pointer events for compatibility mouse events, so nothing
 * changes there; a desktop mouse alone never follows a touch.
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

// A 'mouse' pointerdown at most this long after the release of the touch/pen
// press at its place is that tap's compatibility echo (WebKitGTK: 0-2 ms)
export const TOUCH_ECHO_MS = 800

let presses = []
let trackedWindow = null
// The last touch or pen press: { t, x, y, pointerId, upT } (upT: its release)
let lastTouch = null

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

const isTouchLike = (type) => type === 'touch' || type === 'pen'

/**
 * Is this pointerdown the compatibility mouse echo of the touch/pen tap just
 * before it (WebKitGTK), not a press of its own?
 */
export function isTouchEcho(event, t = eventTime(event)) {
  if (event?.pointerType !== 'mouse' || !lastTouch) return false
  if (t < lastTouch.t || t - lastTouch.t > PRESS_MAX_AGE_MS) return false
  // still down, or released at most TOUCH_ECHO_MS before (the echo can be
  // stamped a ms or two before the touch's own pointerup)
  if (lastTouch.upT != null && t - lastTouch.upT > TOUCH_ECHO_MS) return false
  return samePlace(point(event), lastTouch)
}

/** Record a pointer press (the window listener; tests call it directly). */
export function notePress(event) {
  const t = eventTime(event)
  if (isTouchEcho(event, t)) return
  const where = point(event)
  if (isTouchLike(event?.pointerType)) {
    lastTouch = { t, ...where, pointerId: event.pointerId ?? null, upT: null }
  }
  presses.push({ t, ...where, target: event?.target ?? null })
  if (presses.length > KEEP) presses.shift()
}

/** Record a pointer release: the end of the last touch/pen press (the window listener; tests call it directly). */
export function noteRelease(event) {
  if (!lastTouch || !isTouchLike(event?.pointerType)) return
  if (event.pointerId != null && lastTouch.pointerId != null && event.pointerId !== lastTouch.pointerId) return
  lastTouch.upT = eventTime(event)
}

/** Start recording the presses on `win` (once per window; never removed: passive listeners). */
export function trackPresses(win = typeof window !== 'undefined' ? window : null) {
  if (!win || trackedWindow === win) return
  win.addEventListener('pointerdown', notePress, { capture: true, passive: true })
  win.addEventListener('pointerup', noteRelease, { capture: true, passive: true })
  win.addEventListener('pointercancel', noteRelease, { capture: true, passive: true })
  trackedWindow = win
}

/** Tests only: forget the presses. */
export function resetPresses() {
  presses = []
  lastTouch = null
  ownTapClick = null
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

// ---------------------------------------------------------------------------
// The browser's click after a tap the app clicked itself.
//
// A short tap on a court or bench player is clicked by the scoring screen
// itself at touchend (Scoreboard handleTouchEnd: target.click(), detail 0):
// its touchstart was claimed (preventDefault) for the hold-to-drag, and that
// drops the browser's own click in Chromium, the Android WebView and Safari.
// WebKitGTK (the desktop app on Linux, the Point Hub board) still sends its
// compatibility mouse events and the click (detail 1) at the place of the
// touch, right after the touchend (owner's video, 17.11.2026): a second
// click that closed the menu the first one had just opened (on the player
// it toggles the menu; on the menu's full-screen backdrop it dismisses it),
// so the menu flickered open, shut, open. That click is the echo of a tap
// already clicked: swallowed before any handler sees it.
//
// Its timeStamp says nothing: WebKitGTK stamps the touch events when it
// dispatches them but the compatibility mouse events with the earlier
// hardware time, so on a busy main thread the echo click is stamped BEFORE
// the touchend (bench, 17.11.2026: 79 ms before with the thread blocked
// 100 ms, ~330 ms before at 400 ms). The echo is told apart by when it
// ARRIVES (performance.now() in the listener): the first pointer click
// (detail > 0) at the place of the tap within OWN_TAP_ECHO_MS after the
// app's own click. The next touch (touchstart, or a touch/pen pointerdown)
// ends the wait: a deliberate second tap is never dropped.
//
//   noteOwnTapClick(touchEndEvent)   right before target.click()
//   isOwnTapClickEcho(clickEvent)    the browser's click of that same tap?
//   isOwnTapMouseEcho(event)         a compatibility press/release of it?
//   trackOwnTapClicks()              once: drops those clicks (window, capture)

// How long after the app's own click the browser's echo click may still
// arrive (arrival time, not timeStamp; a blocked main thread delays it)
export const OWN_TAP_ECHO_MS = 1000

let ownTapClick = null // { at, x, y, touchT }: the last tap the app clicked itself
let trackedClickWindow = null

/**
 * The app clicks this tap itself (its touchend): the browser's own click of
 * it is an echo. `now`: the moment of the app's click (performance.now()).
 */
export function noteOwnTapClick(touchEnd, now = perfNow()) {
  const lifted = touchEnd?.changedTouches?.[0]
  const where = lifted ? point(lifted) : point(touchEnd)
  ownTapClick = { at: now, ...where, touchT: lastTouch ? lastTouch.t : null }
}

/** A new touch begins: the last own tap click has no echo left to come. */
export function forgetOwnTapClick() {
  ownTapClick = null
}

// The record, while its echo can still arrive (else forgotten)
function pendingOwnTap(now) {
  if (!ownTapClick) return null
  if (now < ownTapClick.at - 1 || now - ownTapClick.at > OWN_TAP_ECHO_MS) {
    ownTapClick = null
    return null
  }
  return ownTapClick
}

// A mouse-like event: a mouse pointer event, or a mouse/click event without a
// pointer type (WebKitGTK's click and jsdom's MouseEvent carry none)
const isMouseLike = (event) => {
  const type = event?.pointerType
  return type == null || type === '' || type === 'mouse'
}

/**
 * Is this click the browser's own click of the tap the app clicked itself
 * (WebKitGTK's compatibility click)? A pointer's click (detail > 0; the
 * app's own click has detail 0) of the mouse kind, at the place of that tap,
 * ARRIVING at most OWN_TAP_ECHO_MS after the app's click, whatever its
 * timeStamp. One echo per tap. `now`: its arrival (performance.now()).
 */
export function isOwnTapClickEcho(click, now = perfNow()) {
  if (!click || !(click.detail > 0) || !isMouseLike(click)) return false
  const tap = pendingOwnTap(now)
  if (!tap) return false
  return samePlace(point(click), tap)
}

/**
 * Is this mouse press/release (pointerdown/up of type mouse, mousedown/up)
 * part of the compatibility sequence of the tap the app clicked itself? It
 * arrives before the echo click; an overlay's backdrop (backdropDismiss)
 * must not take it as a press of its own.
 */
export function isOwnTapMouseEcho(event, now = perfNow()) {
  if (!event || !isMouseLike(event)) return false
  const tap = pendingOwnTap(now)
  if (!tap) return false
  return samePlace(point(event), tap)
}

function dropOwnTapClickEcho(e) {
  if (!isOwnTapClickEcho(e)) return
  ownTapClick = null
  e.preventDefault()
  e.stopImmediatePropagation()
}

function forgetOnTouchPointer(e) {
  if (isTouchLike(e?.pointerType)) ownTapClick = null
}

/** Drop the echo clicks on `win` (once per window, capture: before React and any other handler). */
export function trackOwnTapClicks(win = typeof window !== 'undefined' ? window : null) {
  if (!win || trackedClickWindow === win) return
  win.addEventListener('click', dropOwnTapClickEcho, { capture: true })
  win.addEventListener('touchstart', forgetOwnTapClick, { capture: true, passive: true })
  win.addEventListener('pointerdown', forgetOnTouchPointer, { capture: true, passive: true })
  trackedClickWindow = win
}
