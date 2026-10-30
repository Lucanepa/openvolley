// The rally buttons' tap guard (Start rally and Point A | Point B take turns
// in the same place). Times in ms on one clock; the buttons changed at 1000
// (drawn after the press that changed them, at 1000 - DRAW).
//
// The cases come from the browser checks of 2026-10-29 (production build,
// Chromium, real mouse events at a human pace, 1280 and 1920 px wide, CPU
// 1x / 4x / 6x): Point A | Point B are drawn 110-130 ms after Start rally's
// press on a desktop, 160-570 ms (up to 1.2 s) with the CPU 4x slower; a
// quick scorer's Point press came 118-280 ms after the buttons were drawn,
// and the old guard (450 ms after the change, timed at the click handler)
// dropped it. And from the stress test of 2026-10-25: taps 40-250 ms apart
// at the same place (double tap on Start rally, triple tap on Point B).
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { rallyTapVerdict, useRallyTapGuard, RALLY_TAP_REACTION_MS } from '../useRallyTapGuard'
import { GHOST_CLICK_MS } from '../useConfirmAction'
import { notePress, resetPresses, TAP_SLOP_PX } from '../../utils/pointerPresses'

const CHANGED = 1000
const DRAW = 120
const START = { x: 640, y: 650 } // Start rally's label (1280 x 800)
const POINT_B = { x: 708, y: 640 } // Point B's label, drawn over Start rally's right half
const press = (t, where = START, onRally = true) => ({ t, ...where, onRally })
const verdict = (p, previous, changedAt = CHANGED) => rallyTapVerdict({ press: p, previous, changedAt })

describe('rallyTapVerdict: a tap aimed at the new button counts', () => {
  it("a quick scorer's Point right after Start rally (owner, 29.10.2026)", () => {
    const start = press(CHANGED - DRAW)
    // desktop: 182 ms after Point B was drawn (300 ms after Start's press)
    expect(verdict(press(CHANGED + 182, POINT_B), start)).toBe(null)
    // CPU 4x: 278 ms after it was drawn (573 ms after Start's press), and
    // a rhythm click 118 ms after it (300 ms after Start's press)
    expect(verdict(press(CHANGED + 278, POINT_B), { ...start, t: CHANGED - 295 })).toBe(null)
    expect(verdict(press(CHANGED + 118, POINT_B), { ...start, t: CHANGED - 181 })).toBe(null)
    // as soon as anyone can react to it
    expect(verdict(press(CHANGED + RALLY_TAP_REACTION_MS, POINT_B), start)).toBe(null)
  })

  it('but not one pressed before the new buttons were drawn, or quicker than anyone reacts', () => {
    const start = press(CHANGED - DRAW)
    expect(verdict(press(CHANGED - 30, POINT_B), start)).toBe('too_soon')
    expect(verdict(press(CHANGED + RALLY_TAP_REACTION_MS - 1, POINT_B), start)).toBe('too_soon')
  })

  it('aimed = farther than TAP_SLOP_PX from the press before', () => {
    const start = press(CHANGED - DRAW)
    const near = { x: START.x + TAP_SLOP_PX, y: START.y }
    const far = { x: START.x + TAP_SLOP_PX + 1, y: START.y }
    expect(verdict(press(CHANGED + 200, near), start)).toBe('double_tap')
    expect(verdict(press(CHANGED + 200, far), start)).toBe(null)
  })
})

describe('rallyTapVerdict: the stress-test double and triple taps stay one tap', () => {
  // the buttons are drawn 25 ms after the press that changed them (a fast desktop)
  for (const gap of [40, 80, 120, 180, 250]) {
    it(`taps ${gap} ms apart at the same place`, () => {
      const first = press(CHANGED - 25)
      // double tap on Start rally: the 2nd tap lands on Point B
      expect(verdict(press(CHANGED - 25 + gap), first)).toBe('double_tap')
      // triple tap on Point B: the 2nd on Start rally, the 3rd on whatever is there
      const second = press(CHANGED - 25 + gap)
      expect(verdict(second, first)).toBe('double_tap')
      expect(verdict(press(CHANGED - 25 + 2 * gap), second)).toBe('double_tap')
    })
  }

  it('a finger off by a few px is the same place', () => {
    const first = press(CHANGED - 25)
    expect(verdict(press(CHANGED + 200, { x: START.x + 12, y: START.y - 9 }), first)).toBe('double_tap')
  })

  it('a slow screen: a re-tap at the same place before or just after the buttons were drawn', () => {
    // Start rally pressed at 300, drawn only at 1000 (CPU 4x), the scorer taps it again
    const first = press(300)
    expect(verdict(press(950), first)).toBe('double_tap')
    expect(verdict(press(CHANGED + 300), first)).toBe('double_tap')
    expect(verdict(press(CHANGED + GHOST_CLICK_MS), first)).toBe(null)
  })

  it('same place, a moment later: the next tap', () => {
    const first = press(CHANGED - 25)
    expect(verdict(press(CHANGED + GHOST_CLICK_MS), first)).toBe(null)
  })

  it('the press before on something else (a dialog button there) does not hold the rally buttons', () => {
    const okOfANotice = press(5000, START, false)
    expect(verdict(press(5200), okOfANotice)).toBe(null)
    // but the buttons' own change does
    expect(verdict(press(5200), okOfANotice, 5000)).toBe('double_tap')
  })
})

describe('rallyTapVerdict: unknown place (a key on a focused button, a synthetic click)', () => {
  it('is judged as the same place: GHOST_CLICK_MS after the change (as before)', () => {
    const unknown = { t: CHANGED + 200, x: null, y: null }
    expect(verdict(unknown, press(CHANGED - DRAW))).toBe('double_tap')
    expect(verdict(unknown, null)).toBe('double_tap')
    expect(verdict({ ...unknown, t: CHANGED + GHOST_CLICK_MS }, null)).toBe(null)
  })

  it('nothing changed since the screen opened: every tap counts', () => {
    expect(verdict({ t: 50, x: null, y: null }, null, -Infinity)).toBe(null)
    expect(verdict(press(50), press(10), -Infinity)).toBe('double_tap')
  })
})

describe('useRallyTapGuard', () => {
  beforeEach(() => resetPresses())

  function click(target, x, y) {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }))
    const e = new MouseEvent('click', { bubbles: true, detail: 1, clientX: x, clientY: y })
    target.dispatchEvent(e)
    return e
  }

  it('times the change in a layout effect, not when the screen first shows the buttons', async () => {
    const { result, rerender } = renderHook(({ status }) => useRallyTapGuard(status), { initialProps: { status: 'idle' } })
    const start = document.createElement('button')
    start.setAttribute('data-help-id', 'scoreboard-start-rally')
    document.body.appendChild(start)
    try {
      // first shown: no hold
      expect(result.current(click(start, 640, 650)).verdict).toBe(null)
      rerender({ status: 'in_play' })
      // right after the change, at the same place: the end of the tap before
      const check = result.current(click(start, 642, 652))
      expect(check.verdict).toBe('double_tap')
      expect(check.distancePx).toBe(3)
      expect(check.sinceChangeMs).toBeLessThan(GHOST_CLICK_MS)
      // a re-render with the same status changes nothing; GHOST_CLICK_MS later it counts
      rerender({ status: 'in_play' })
      await new Promise(r => setTimeout(r, GHOST_CLICK_MS + 20))
      expect(result.current(click(start, 642, 652)).verdict).toBe(null)
    } finally {
      start.remove()
    }
  })

  it('takes a click without its press (a key, a synthetic click) as the same place', () => {
    const { result, rerender } = renderHook(({ status }) => useRallyTapGuard(status), { initialProps: { status: 'idle' } })
    rerender({ status: 'in_play' })
    expect(result.current(undefined).verdict).toBe('double_tap')
    expect(result.current(new MouseEvent('click', { detail: 0 })).verdict).toBe('double_tap')
  })

  it('a press recorded by the window listener: the one before is on the rally buttons or not', () => {
    const { result, rerender } = renderHook(({ status }) => useRallyTapGuard(status), { initialProps: { status: 'idle' } })
    rerender({ status: 'in_play' })
    notePress({ timeStamp: 0, clientX: 100, clientY: 100, target: document.body })
    const elsewhere = new MouseEvent('click', { detail: 1 })
    notePress({ timeStamp: 0, clientX: 300, clientY: 100, target: document.body })
    // aimed (200 px from the press before) but right at the change: too soon
    expect(result.current(elsewhere).verdict).toBe('too_soon')
  })
})
