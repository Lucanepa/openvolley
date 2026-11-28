// The panel of an (i) (ui/InfoDot, ui/InfoHint): where it goes and when it
// closes. One behaviour for every (i) of every app built from this frontend.
//
// Where (owner 28.11.2026, a Xiaomi 17 at 393 px: the Device check (i) in
// Options cut off "The app measures…" at the left edge): the panel is drawn
// `position: fixed`, under its (i) and centred on it, then moved back inside
// the part of the screen that is visible, VIEWPORT_MARGIN from every edge (the
// margin of the scoring screen's menus, ui/keepInViewport). Not enough room
// under the (i): above it; neither: on the side with more room, as tall as
// that room, scrolling. Fixed, it is not cut off by a scrolling dialog body
// (an absolute panel was, and stretched the dialog's scroll area). A
// transformed or filtered ancestor (an opening dialog, the dark theme's
// filter) moves the point fixed boxes start from: the panel is first put at
// 0, 0 and measured, so that offset (and a scale) is taken out.
//
// When it closes: a tap or click anywhere outside the (i) and its panel, Escape
// (focus back on the (i)), a scroll of the page or of the dialog around it,
// another (i) opening, focus moving away (Tab), the (i) going away. A resize or
// rotation places it again.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { VIEWPORT_MARGIN } from './keepInViewport.js'

export { VIEWPORT_MARGIN }
/** Between the (i) and its panel, CSS px. */
export const INFO_GAP = 6
/** Less room than this above and below (the (i) at the very edge): the panel takes the whole height. */
export const INFO_MIN_ROOM = 64

/** The part of the page on screen, in getBoundingClientRect's coordinates (a zoomed-in phone: the visual viewport). */
export function visibleViewport(win = typeof window !== 'undefined' ? window : undefined) {
  const vv = win?.visualViewport
  if (vv && vv.width > 0 && vv.height > 0) {
    return { left: vv.offsetLeft || 0, top: vv.offsetTop || 0, width: vv.width, height: vv.height }
  }
  const de = win?.document?.documentElement
  return { left: 0, top: 0, width: win?.innerWidth || de?.clientWidth || 0, height: win?.innerHeight || de?.clientHeight || 0 }
}

/**
 * Where a panel of `size` goes for an (i) at `anchor` (a DOMRect) inside
 * `view` ({ left, top, width, height }): { left, top, maxHeight, side }.
 * maxHeight null: it fits; side 'below' | 'above' | 'over' (no room on
 * either side: the whole height).
 */
export function placeInfoPanel(anchor, size, view, { margin = VIEWPORT_MARGIN, gap = INFO_GAP, minRoom = INFO_MIN_ROOM } = {}) {
  const minLeft = view.left + margin
  const maxRight = view.left + view.width - margin
  const width = Math.min(size.width, Math.max(0, maxRight - minLeft))
  const centred = anchor.left + anchor.width / 2 - width / 2
  const left = Math.max(minLeft, Math.min(centred, maxRight - width))

  const viewTop = view.top + margin
  const viewBottom = view.top + view.height - margin
  const below = anchor.bottom + gap
  const roomBelow = viewBottom - below
  const roomAbove = anchor.top - gap - viewTop
  const h = size.height
  if (h <= roomBelow) return { left, top: below, maxHeight: null, side: 'below' }
  if (h <= roomAbove) return { left, top: anchor.top - gap - h, maxHeight: null, side: 'above' }
  if (Math.max(roomBelow, roomAbove) < minRoom) {
    const room = Math.max(0, viewBottom - viewTop)
    return { left, top: viewTop + Math.max(0, (room - h) / 2), maxHeight: h > room ? room : null, side: 'over' }
  }
  if (roomBelow >= roomAbove) return { left, top: below, maxHeight: roomBelow, side: 'below' }
  return { left, top: viewTop, maxHeight: roomAbove, side: 'above' }
}

/**
 * Puts `panel` (position: fixed) next to `trigger`, inside the visible part of
 * the screen. `maxWidth`: the panel's widest, CSS px (narrower on a phone).
 * Returns the placement (tests), or null without the elements.
 */
export function positionInfoPanel(panel, trigger, { maxWidth = 320, win = typeof window !== 'undefined' ? window : undefined, margin = VIEWPORT_MARGIN } = {}) {
  if (!panel || !trigger) return null
  const view = visibleViewport(win)
  const s = panel.style
  s.left = '0px'
  s.top = '0px'
  s.maxHeight = ''
  s.overflowY = ''
  s.maxWidth = `${Math.max(0, Math.min(maxWidth, view.width - 2 * margin))}px`
  // Where 0, 0 is (a transformed ancestor moves and may scale it), and the size
  const origin = panel.getBoundingClientRect()
  const scale = panel.offsetWidth > 0 && origin.width > 0 ? origin.width / panel.offsetWidth : 1
  const at = placeInfoPanel(trigger.getBoundingClientRect(), { width: origin.width, height: origin.height }, view, { margin })
  s.left = `${Math.round((at.left - origin.left) / scale)}px`
  s.top = `${Math.round((at.top - origin.top) / scale)}px`
  if (at.maxHeight != null) {
    s.maxHeight = `${Math.max(0, Math.floor(at.maxHeight / scale))}px`
    s.overflowY = 'auto'
  }
  s.visibility = ''
  panel.dataset.side = at.side
  return at
}

// The (i) open now: opening another one closes it
let closeOpenOne = null

/** Tests: forget the (i) open now. */
export function resetInfoPopoversForTests() {
  closeOpenOne = null
}

/**
 * State and wiring of one (i): { open, toggle, close, panelId, wrapRef,
 * triggerRef, panelRef, triggerProps, panelProps }. wrapRef: the element
 * around the (i) and its panel (taps inside it do not close it).
 */
export function useInfoPopover({ maxWidth = 320, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const panelId = useId()

  const close = useCallback((focusTrigger = false) => {
    setOpen(false)
    if (focusTrigger) {
      try { triggerRef.current?.focus({ preventScroll: true }) } catch { /* gone */ }
    }
  }, [])
  const toggle = useCallback(() => setOpen((v) => !v), [])

  // One open at a time
  useEffect(() => {
    if (!open) return undefined
    const mine = () => setOpen(false)
    if (closeOpenOne && closeOpenOne !== mine) closeOpenOne()
    closeOpenOne = mine
    return () => {
      if (closeOpenOne === mine) closeOpenOne = null
    }
  }, [open])

  // Placed before it is painted, and again on a resize, a rotation or a new size of its text
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => positionInfoPanel(panelRef.current, triggerRef.current, { maxWidth, win })
    place()
    const ro = typeof ResizeObserver === 'function' && panelRef.current ? new ResizeObserver(() => place()) : null
    if (ro) ro.observe(panelRef.current)
    const vv = win?.visualViewport
    win?.addEventListener?.('resize', place)
    win?.addEventListener?.('orientationchange', place)
    vv?.addEventListener?.('resize', place)
    return () => {
      if (ro) ro.disconnect()
      win?.removeEventListener?.('resize', place)
      win?.removeEventListener?.('orientationchange', place)
      vv?.removeEventListener?.('resize', place)
    }
  }, [open, maxWidth, win])

  // Closes on a tap outside, Escape, a scroll around it, focus moving away
  useEffect(() => {
    if (!open) return undefined
    const doc = win?.document
    if (!doc) return undefined
    const inside = (node) => !!node && !!wrapRef.current && wrapRef.current.contains(node)
    const onDown = (e) => { if (!inside(e.target)) setOpen(false) }
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return
      // the (i) first: the dialog around it stays open
      e.stopPropagation()
      e.preventDefault()
      close(inside(doc.activeElement) || doc.activeElement === doc.body)
    }
    // its own text scrolling (a tall panel) does not close it
    const onScroll = (e) => { if (!panelRef.current || !panelRef.current.contains(e.target)) setOpen(false) }
    const onFocusIn = (e) => { if (!inside(e.target)) setOpen(false) }
    // Capture: the dialogs below stop propagation of their taps (Modal's
    // backdrop, the scoring screen), and a popover that only closes when you
    // tap nothing in particular is a trap.
    doc.addEventListener('pointerdown', onDown, true)
    doc.addEventListener('mousedown', onDown, true)
    doc.addEventListener('touchstart', onDown, true)
    doc.addEventListener('keydown', onKey, true)
    doc.addEventListener('scroll', onScroll, true)
    doc.addEventListener('focusin', onFocusIn, true)
    return () => {
      doc.removeEventListener('pointerdown', onDown, true)
      doc.removeEventListener('mousedown', onDown, true)
      doc.removeEventListener('touchstart', onDown, true)
      doc.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('scroll', onScroll, true)
      doc.removeEventListener('focusin', onFocusIn, true)
    }
  }, [open, close, win])

  const triggerProps = {
    ref: triggerRef,
    type: 'button',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    onClick: (e) => {
      // in a <label> or a row with its own onClick: the (i) only
      e.preventDefault()
      e.stopPropagation()
      toggle()
    }
  }
  const panelProps = {
    ref: panelRef,
    id: panelId,
    'data-info-panel': '',
    // fixed and hidden until placed (positionInfoPanel), before it is painted
    style: { position: 'fixed', left: 0, top: 0, visibility: 'hidden' },
    // a tap on the text: not the row's, and not the <label>'s (it would
    // click the label's first button: the (i), closing it again); a link or a
    // button in the panel still works
    onClick: (e) => {
      e.stopPropagation()
      const control = e.target?.closest?.('a, button, input, select, textarea, summary, label')
      if (!control || !e.currentTarget.contains(control)) e.preventDefault()
    }
  }
  return { open, toggle, close, panelId, wrapRef, triggerRef, panelRef, triggerProps, panelProps }
}
