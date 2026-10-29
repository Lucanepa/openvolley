// The pointer presses the tap guards judge a tap by (useRallyTapGuard,
// useConfirmAction): the press of a click, the press before it, and whether
// two presses are at the same place.
import { describe, it, expect, beforeEach } from 'vitest'
import { TAP_SLOP_PX, eventTime, notePress, pressOfClick, pressDistance, resetPresses, samePlace, trackPresses } from '../pointerPresses'

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
