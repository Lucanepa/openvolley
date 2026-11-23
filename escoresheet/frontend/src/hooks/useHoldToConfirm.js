import { useEffect, useRef } from 'react'
import { isTouchEcho, trackPresses } from '../utils/pointerPresses'
import { NO_MOTION_ATTR } from '../utils/lookSettings'

/**
 * Hold to confirm: an action that a button gives only after it has been held
 * for `holdMs` (continuous play's Point A | Point B, owner 22.11.2026: about
 * 2 s, so that a misclick gives no point). One press gives the action once,
 * at the end of the hold; there is no click. Released earlier, nothing
 * happens but onShortPress (the screen says "Hold to give the point").
 *
 * Cheap to draw: no React state at all. The hold sets data-holding on the
 * button, and the fill (a child with data-hold-fill) grows by a CSS
 * transform transition over --hold-ms (styles.css .hold-button). With the
 * animations off (html[data-no-motion], Options › Effects and speed) or a
 * reduced-motion system, the fill steps a quarter at a time instead, still
 * over the whole hold, and never glides.
 *
 * A hold stops without the action when the pointer is released, moves more
 * than HOLD_SLOP_PX, is cancelled (pointercancel, lostpointercapture), the
 * window loses focus or the page is hidden, a dialog is over the button when
 * the time is up, or a second hold begins anywhere (a second finger, a key):
 * both stop. Only one hold runs on the page at a time.
 *
 * The Android WebView takes a touch held about 500 ms as a long press: it
 * opens the context menu and cancels the touch (pointercancel), as it did to
 * the drag of a player (Scoreboard handleTouchDragStart, 16.11.2026). The
 * button claims its touches as that drag does: a native touchstart listener
 * that is not passive calls preventDefault, the context menu is blocked, and
 * the CSS has touch-action: none and no callout or selection; the pointer is
 * captured. WebKitGTK (the desktop app on Linux, the Point Hub board) sends a
 * compatibility mouse press at the release of a touch: not a press of its
 * own (utils/pointerPresses isTouchEcho).
 *
 * Keys: Enter or Space on the focused button holds it as a finger does
 * (keydown starts, keyup releases, Escape stops, a repeated keydown is
 * ignored). The scoring keys of the Scoreboard (A / L) hold it through the
 * returned api: api.start(key), api.release(key), api.cancel().
 *
 *   const hold = useHoldToConfirm({ onConfirm, onShortPress, disabled })
 *   <button ref={hold.ref} {...hold.handlers}><span data-hold-fill />…</button>
 */

// The hold of continuous play's point buttons (owner 22.11.2026: "about 2 s")
export const POINT_HOLD_MS = 2000
// A finger that moves farther than this while held is not holding the button
export const HOLD_SLOP_PX = 20
// The fill's steps with the animations off
export const HOLD_STEPS = 4
// The buzz at the end of a hold (as the player drag's, Scoreboard)
export const HOLD_VIBRATE_MS = 30
export const HOLDING_ATTR = 'data-holding'

// The one hold that runs on the page: { owner, cancel }
let activeHold = null

/** Stop the hold that runs on the page, if any (Escape). True when there was one. */
export function cancelActiveHold() {
  if (!activeHold) return false
  activeHold.cancel()
  return true
}

/** Tests: forget a hold left running. */
export function resetHoldsForTests() {
  activeHold = null
}

function motionOff(doc) {
  try {
    if (doc?.documentElement?.hasAttribute(NO_MOTION_ATTR)) return true
    return !!doc?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  } catch {
    return false
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// One engine per button, made once: its handlers read the latest props
function createHoldEngine(elRef, latest) {
  let hold = null
  const engine = {}

  const fillOf = (el) => el?.querySelector?.('[data-hold-fill]') || null

  // End the hold (no action), put the button back; returns the hold
  const stop = () => {
    const h = hold
    if (!h) return null
    hold = null
    clearTimeout(h.timer)
    for (const timer of h.steps) clearTimeout(timer)
    h.detach()
    if (activeHold?.owner === engine) activeHold = null
    const el = elRef.current
    if (el) {
      el.removeAttribute(HOLDING_ATTR)
      const fill = fillOf(el)
      if (fill) fill.style.transform = ''
      if (h.pointerId != null) {
        try {
          if (el.hasPointerCapture?.(h.pointerId)) el.releasePointerCapture(h.pointerId)
        } catch {
          // already released
        }
      }
    }
    return h
  }

  const fire = () => {
    const el = elRef.current
    const h = stop()
    if (!h) return
    // a dialog came up over the button while it was held: not under it
    if (el?.ownerDocument?.querySelector?.('[aria-modal="true"]')) return
    try {
      globalThis.navigator?.vibrate?.(HOLD_VIBRATE_MS)
    } catch {
      // not allowed
    }
    latest.current.onConfirm?.({ source: h.source, heldMs: Math.round(now() - h.startedAt) })
  }

  const begin = (source, extra = {}) => {
    const { disabled, holdMs } = latest.current
    const el = elRef.current
    if (disabled || !el || hold) return false
    // a second finger (or a key) while another hold runs: neither gives anything
    if (activeHold) {
      activeHold.cancel()
      return false
    }
    const doc = el.ownerDocument
    const win = doc?.defaultView
    const onBlur = () => stop()
    const onVisibility = () => {
      if (doc.visibilityState !== 'visible') stop()
    }
    win?.addEventListener('blur', onBlur)
    doc?.addEventListener('visibilitychange', onVisibility)
    const ms = Math.max(1, Number(holdMs) || POINT_HOLD_MS)
    hold = {
      source,
      ...extra,
      startedAt: now(),
      steps: [],
      timer: setTimeout(fire, ms),
      detach: () => {
        win?.removeEventListener('blur', onBlur)
        doc?.removeEventListener('visibilitychange', onVisibility)
      }
    }
    activeHold = { owner: engine, cancel: stop }
    const fill = fillOf(el)
    if (fill && motionOff(doc)) {
      // Animations off: a quarter every holdMs / 4; full only when it is given
      fill.style.transform = 'scaleX(0)'
      for (let k = 1; k < HOLD_STEPS; k++) {
        hold.steps.push(setTimeout(() => { fill.style.transform = `scaleX(${k / HOLD_STEPS})` }, (ms * k) / HOLD_STEPS))
      }
    }
    el.setAttribute(HOLDING_ATTR, '')
    return true
  }

  // Let go before the time: nothing given, onShortPress
  const release = () => {
    if (!stop()) return
    latest.current.onShortPress?.()
  }

  const samePointer = (e) => hold && hold.source === 'pointer' && hold.pointerId === e.pointerId

  engine.isHolding = () => !!hold
  engine.cancel = () => { stop() }
  engine.api = Object.freeze({
    start: (key) => begin('key', { key: key ?? null }),
    release: (key) => {
      if (hold && hold.source === 'key' && (key == null || hold.key === key)) release()
    },
    cancel: () => { stop() },
    isHolding: () => !!hold
  })
  engine.handlers = Object.freeze({
    onPointerDown: (e) => {
      const native = e.nativeEvent || e
      if (native.pointerType === 'mouse' && native.button !== 0) return
      // WebKitGTK's mouse echo of a touch just released: no press of its own
      if (isTouchEcho(native)) return
      if (hold) {
        // a second finger on the same button
        stop()
        return
      }
      if (!begin('pointer', { pointerId: native.pointerId ?? null, x: native.clientX ?? null, y: native.clientY ?? null })) return
      try {
        e.currentTarget?.setPointerCapture?.(native.pointerId)
      } catch {
        // no capture (an old WebView): the release still comes to the button
      }
    },
    onPointerMove: (e) => {
      if (!samePointer(e) || hold.x == null || typeof e.clientX !== 'number') return
      if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP_PX) stop()
    },
    onPointerUp: (e) => {
      if (samePointer(e)) release()
    },
    onPointerCancel: (e) => {
      if (samePointer(e)) stop()
    },
    onLostPointerCapture: (e) => {
      if (samePointer(e)) stop()
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        if (hold) {
          e.preventDefault()
          stop()
        }
        return
      }
      if (e.key !== 'Enter' && e.key !== ' ') return
      // no click: the button gives its action at the end of the hold only
      e.preventDefault()
      if (e.repeat || hold) return
      begin('key', { key: e.key })
    },
    onKeyUp: (e) => {
      if (hold && hold.source === 'key' && hold.key === e.key) {
        e.preventDefault()
        release()
      }
    },
    onBlur: () => {
      if (hold) stop()
    },
    onContextMenu: (e) => {
      e.preventDefault()
    }
  })
  return engine
}

/**
 * @param {{ onConfirm?: (info: { source: 'pointer'|'key', heldMs: number }) => void,
 *   onShortPress?: () => void, disabled?: boolean, holdMs?: number }} options
 * @returns {{ ref: import('react').MutableRefObject<HTMLElement|null>, handlers: object,
 *   api: { start: (key?: string) => boolean, release: (key?: string) => void, cancel: () => void, isHolding: () => boolean } }}
 */
export function useHoldToConfirm({ onConfirm, onShortPress, disabled = false, holdMs = POINT_HOLD_MS } = {}) {
  const ref = useRef(null)
  const latest = useRef(null)
  latest.current = { onConfirm, onShortPress, disabled, holdMs }
  const engineRef = useRef(null)
  if (!engineRef.current) engineRef.current = createHoldEngine(ref, latest)
  const engine = engineRef.current

  // isTouchEcho needs the page's presses
  useEffect(() => { trackPresses() }, [])

  // Disabled while held (the set was won, a time-out began): no point
  useEffect(() => {
    if (disabled) engine.cancel()
  }, [disabled, engine])

  // The touch belongs to the hold (see above), and so does its long press
  useEffect(() => {
    const el = ref.current
    if (!el?.addEventListener) return undefined
    const claim = (e) => {
      if (e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchstart', claim, { passive: false })
    return () => el.removeEventListener('touchstart', claim, { passive: false })
  }, [])

  useEffect(() => () => engine.cancel(), [engine])

  return { ref, handlers: engine.handlers, api: engine.api }
}
