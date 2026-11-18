// The pointer presses the tap guards judge a tap by (useRallyTapGuard,
// useConfirmAction): the press of a click, the press before it, and whether
// two presses are at the same place.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OWN_TAP_ECHO_MS, TAP_SLOP_PX, TOUCH_ECHO_MS, eventTime, forgetOwnTapClick, isOwnTapClickEcho, isOwnTapMouseEcho, trackOwnTapClicks, isTouchEcho, noteOwnTapClick, notePress, noteRelease, pressOfClick, pressDistance, resetPresses, samePlace, trackPresses } from '../pointerPresses'

beforeEach(() => resetPresses())

const at = (t) => () => t

describe('eventTime', () => {
  it('takes the event timeStamp on the performance clock', () => {
    expect(eventTime({ timeStamp: 1234.5 }, at(2000))).toBe(1234.5)
  })

  it('takes now for a timeStamp on another clock (jsdom: Date.now()) or none', () => {
    expect(eventTime({ timeStamp: Date.now() }, at(2000))).toBe(2000)
    expect(eventTime({}, at(2000))).toBe(2000)
    expect(eventTime(null, at(2000))).toBe(2000)
  })
})

describe('pressOfClick', () => {
  it("a pointer's click: its own press, and the press before it", () => {
    notePress({ timeStamp: 100, clientX: 640, clientY: 650, target: 'start' })
    notePress({ timeStamp: 400, clientX: 708, clientY: 640, target: 'pointB' })
    const { press, previous } = pressOfClick({ type: 'click', detail: 1, timeStamp: 490 }, at(500))
    expect(press).toMatchObject({ t: 400, x: 708, y: 640, target: 'pointB' })
    expect(previous).toMatchObject({ t: 100, x: 640, y: 650, target: 'start' })
  })

  it('a click from a key (detail 0): the click time, place unknown; the last press is the one before', () => {
    notePress({ timeStamp: 100, clientX: 640, clientY: 650 })
    const { press, previous } = pressOfClick({ type: 'click', detail: 0, timeStamp: 900 }, at(950))
    expect(press).toMatchObject({ t: 900, x: null, y: null })
    expect(previous).toMatchObject({ t: 100, x: 640 })
  })

  it('no event, or a press too old to be this click: unknown place', () => {
    notePress({ timeStamp: 100, clientX: 640, clientY: 650 })
    expect(pressOfClick(null, at(300)).press).toMatchObject({ t: 300, x: null })
    expect(pressOfClick({ type: 'click', detail: 1, timeStamp: 9000 }, at(9000)).press).toMatchObject({ t: 9000, x: null })
  })

  it('keeps the last presses only', () => {
    for (let i = 0; i < 10; i++) notePress({ timeStamp: i * 10, clientX: i, clientY: 0 })
    const { press, previous } = pressOfClick({ type: 'click', detail: 1, timeStamp: 95 }, at(100))
    expect(press.x).toBe(9)
    expect(previous.x).toBe(8)
  })

  it('records the presses of the window it tracks (capture phase, before any handler)', () => {
    trackPresses(window)
    trackPresses(window) // once
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.addEventListener('pointerdown', (e) => e.stopPropagation())
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40 }))
    const { press } = pressOfClick({ type: 'click', detail: 1, timeStamp: performance.now() })
    expect(press).toMatchObject({ x: 30, y: 40, target: button })
    button.remove()
  })
})

// One touch tap in WebKitGTK (Point Hub board, 17.11.2026, event.timeStamp):
// pointerdown touch id 3 at 1136941, pointerup touch at 1137031, then
// pointerdown mouse id 1 at 1137029 and the click (pointerType mouse) at 1137029
const touchDown = (t, x = 640, y = 657, target = 'start') => ({ type: 'pointerdown', pointerType: 'touch', pointerId: 3, timeStamp: t, clientX: x, clientY: y, target })
const touchUp = (t, x = 640, y = 657) => ({ type: 'pointerup', pointerType: 'touch', pointerId: 3, timeStamp: t, clientX: x, clientY: y })
const mouseDown = (t, x = 640, y = 657, target = 'start') => ({ type: 'pointerdown', pointerType: 'mouse', pointerId: 1, timeStamp: t, clientX: x, clientY: y, target })
const webkitTap = (t0, x, y, target) => {
  notePress(touchDown(t0, x, y, target))
  noteRelease(touchUp(t0 + 90, x, y))
  notePress(mouseDown(t0 + 88, x, y, target))
}

describe('one touch tap is one press (WebKitGTK compatibility mouse pointer events)', () => {
  // the stamps below are on the performance clock: keep "now" after them
  let clock
  beforeEach(() => {
    const real = performance.now.bind(performance)
    clock = vi.spyOn(performance, 'now').mockImplementation(() => 1e7 + real())
  })
  afterEach(() => clock.mockRestore())

  it("the 'mouse' pointerdown at the touch's place is not a second press", () => {
    notePress({ timeStamp: 500, clientX: 100, clientY: 100, target: 'elsewhere', pointerType: 'touch', pointerId: 2 })
    noteRelease({ timeStamp: 580, pointerType: 'touch', pointerId: 2 })
    webkitTap(941, 640, 657, 'start')
    const { press, previous } = pressOfClick({ type: 'click', pointerType: 'mouse', detail: 1, timeStamp: 1029 }, at(1100))
    expect(press).toMatchObject({ t: 941, x: 640, y: 657, target: 'start' })
    expect(previous).toMatchObject({ t: 500, x: 100, target: 'elsewhere' })
  })

  it('also when the echo is stamped before the touch release, or the touch was held', () => {
    notePress(touchDown(100))
    expect(isTouchEcho(mouseDown(150))).toBe(true) // still down
    noteRelease(touchUp(2100)) // a long press
    expect(isTouchEcho(mouseDown(2099))).toBe(true)
    expect(isTouchEcho(mouseDown(2100 + TOUCH_ECHO_MS))).toBe(true)
  })

  it('a real second tap still counts as a second press (a double tap stays a double tap)', () => {
    webkitTap(100)
    webkitTap(220)
    const { press, previous } = pressOfClick({ type: 'click', pointerType: 'mouse', detail: 1, timeStamp: 308 }, at(320))
    expect(press.t).toBe(220)
    expect(previous.t).toBe(100)
  })

  it('a mouse press elsewhere, later, or with no touch before is a press', () => {
    expect(isTouchEcho(mouseDown(100))).toBe(false) // a desktop mouse alone
    notePress(touchDown(100))
    noteRelease(touchUp(180))
    expect(isTouchEcho(mouseDown(181, 640 + TAP_SLOP_PX + 1, 657))).toBe(false)
    expect(isTouchEcho(mouseDown(181 + TOUCH_ECHO_MS))).toBe(false)
    expect(isTouchEcho({ ...mouseDown(181), pointerType: 'touch' })).toBe(false)
    notePress(mouseDown(2000))
    const { press } = pressOfClick({ type: 'click', detail: 1, timeStamp: 2050 }, at(2060))
    expect(press.t).toBe(2000)
  })

  it('a mouse double click still records two presses', () => {
    notePress(mouseDown(100))
    notePress(mouseDown(220))
    const { press, previous } = pressOfClick({ type: 'click', detail: 2, timeStamp: 260 }, at(270))
    expect(press.t).toBe(220)
    expect(previous.t).toBe(100)
  })

  it('the window listener drops the echo too', () => {
    trackPresses(window)
    const button = document.createElement('button')
    document.body.appendChild(button)
    const t = performance.now()
    const opts = (pointerType, pointerId) => ({ bubbles: true, clientX: 30, clientY: 40, pointerType, pointerId })
    button.dispatchEvent(new PointerEvent('pointerdown', opts('touch', 3)))
    button.dispatchEvent(new PointerEvent('pointerup', opts('touch', 3)))
    button.dispatchEvent(new PointerEvent('pointerdown', opts('mouse', 1)))
    const { press, previous } = pressOfClick({ type: 'click', detail: 1, timeStamp: performance.now() })
    expect(press).toMatchObject({ x: 30, y: 40, target: button })
    expect(press.t).toBeGreaterThanOrEqual(t - 1)
    // the press before is not this tap's echo
    expect(previous === null || previous.target !== button || previous.t < t - 1).toBe(true)
    button.remove()
  })
})

describe('samePlace / pressDistance', () => {
  it('within TAP_SLOP_PX is the same place', () => {
    expect(samePlace({ x: 0, y: 0 }, { x: TAP_SLOP_PX, y: 0 })).toBe(true)
    expect(samePlace({ x: 0, y: 0 }, { x: 30, y: 30 })).toBe(false)
    expect(pressDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('an unknown place counts as the same place (the safe side for a guard)', () => {
    expect(samePlace({ x: null, y: null }, { x: 500, y: 500 })).toBe(true)
    expect(samePlace(null, { x: 1, y: 1 })).toBe(true)
    expect(pressDistance({ x: null, y: null }, { x: 1, y: 1 })).toBe(null)
  })
})

describe('isOwnTapClickEcho (the browser click after a tap the app clicked itself)', () => {
  const touchEnd = (t, x = 640, y = 650) => ({ type: 'touchend', timeStamp: t, changedTouches: [{ clientX: x, clientY: y }] })
  const click = (t, detail = 1, x = 641, y = 652, extra = {}) => ({ type: 'click', timeStamp: t, detail, clientX: x, clientY: y, ...extra })

  it("WebKitGTK's compatibility click arriving right after the app's click is the echo", () => {
    noteOwnTapClick(touchEnd(1000), 1000)
    expect(isOwnTapClickEcho(click(1001), 1001)).toBe(true)
    noteOwnTapClick(touchEnd(1000), 1000)
    expect(isOwnTapClickEcho(click(1000, 1, 641, 652, { pointerType: 'mouse' }), 1000 + OWN_TAP_ECHO_MS)).toBe(true)
  })

  it('the timeStamp does not matter: stamped 80 ms or 330 ms BEFORE the touchend (busy main thread, bench 17.11.2026)', () => {
    // pointerdown(touch) 92966, touchstart 93115, touchend 93123, own click
    // 93124, compatibility click stamped 93044 and arriving after the own click
    noteOwnTapClick(touchEnd(93123), 93124)
    expect(isOwnTapClickEcho(click(93044), 93140)).toBe(true)
    noteOwnTapClick(touchEnd(93123), 93124)
    expect(isOwnTapClickEcho(click(93123 - 330), 93124 + 420)).toBe(true)
    // its compatibility press and release too
    noteOwnTapClick(touchEnd(93123), 93124)
    expect(isOwnTapMouseEcho({ type: 'pointerdown', pointerType: 'mouse', timeStamp: 92800, clientX: 641, clientY: 652 }, 93130)).toBe(true)
    expect(isOwnTapMouseEcho({ type: 'mouseup', timeStamp: 92800, clientX: 641, clientY: 652 }, 93131)).toBe(true)
    expect(isOwnTapMouseEcho({ type: 'pointerdown', pointerType: 'touch', clientX: 641, clientY: 652 }, 93131)).toBe(false)
    expect(isOwnTapMouseEcho({ type: 'mousedown', clientX: 900, clientY: 652 }, 93131)).toBe(false)
  })

  it("the app's own click (detail 0), a touch/pen click, a click elsewhere, a late arrival and no tap are not", () => {
    expect(isOwnTapClickEcho(click(1001), 1001)).toBe(false) // no tap clicked by the app
    noteOwnTapClick(touchEnd(1000), 1000)
    expect(isOwnTapClickEcho(click(1001, 0), 1001)).toBe(false)
    expect(isOwnTapClickEcho(click(1001, 1, 641, 652, { pointerType: 'touch' }), 1001)).toBe(false)
    expect(isOwnTapClickEcho(click(1001, 1, 640 + TAP_SLOP_PX + 5, 650), 1001)).toBe(false)
    expect(isOwnTapClickEcho(click(1001), 1001 + OWN_TAP_ECHO_MS)).toBe(false) // arrived too late
    expect(isOwnTapClickEcho(click(1001), 1002)).toBe(false) // forgotten at the deadline
    expect(isOwnTapMouseEcho({ type: 'mousedown', clientX: 641, clientY: 652 }, 1002)).toBe(false)
  })

  it('a new touch forgets the tap (its own click comes from its own touchend)', () => {
    noteOwnTapClick(touchEnd(1000), 1000)
    forgetOwnTapClick()
    expect(isOwnTapClickEcho(click(1001), 1001)).toBe(false)
  })

  it('on the window: the echo is dropped once; a touchstart or a touch pointerdown ends the wait', () => {
    const win = new EventTarget()
    trackOwnTapClicks(win)
    const fire = (type, init = {}) => {
      const e = new Event(type, { cancelable: true })
      Object.assign(e, init)
      let reached = false
      const l = () => { reached = true }
      win.addEventListener(type, l)
      win.dispatchEvent(e)
      win.removeEventListener(type, l)
      return reached
    }
    const at = { clientX: 641, clientY: 652 }
    noteOwnTapClick(touchEnd(1000))
    expect(fire('click', { detail: 1, ...at })).toBe(false) // dropped
    expect(fire('click', { detail: 1, ...at })).toBe(true) // one echo per tap
    noteOwnTapClick(touchEnd(1000))
    fire('touchstart')
    expect(fire('click', { detail: 1, ...at })).toBe(true)
    noteOwnTapClick(touchEnd(1000))
    fire('pointerdown', { pointerType: 'pen', ...at })
    expect(fire('click', { detail: 1, ...at })).toBe(true)
    noteOwnTapClick(touchEnd(1000))
    fire('pointerdown', { pointerType: 'mouse', ...at }) // the compatibility press keeps it
    expect(fire('click', { detail: 1, ...at })).toBe(false)
  })

  it('resetPresses forgets it too', () => {
    noteOwnTapClick(touchEnd(1000), 1000)
    resetPresses()
    expect(isOwnTapClickEcho(click(1001), 1001)).toBe(false)
  })
})
