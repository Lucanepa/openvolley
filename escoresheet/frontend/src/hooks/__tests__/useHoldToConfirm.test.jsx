// Hold to confirm (continuous play's Point A | Point B, owner 22.11.2026): a
// point only after a hold of about 2 s, once per press, never on a click; let
// go, moved, cancelled or covered by a dialog, nothing. Drawn without React
// state: data-holding on the button and a CSS transform on its fill (stepped
// with the animations off). Fake timers; pointers and keys as the browser
// sends them (jsdom has PointerEvent, no pointer capture).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useState } from 'react'
import HoldToConfirmButton from '../../components/scoreboard/HoldToConfirmButton.jsx'
import { POINT_HOLD_MS, HOLD_SLOP_PX, HOLD_STEPS, HOLD_VIBRATE_MS, cancelActiveHold, resetHoldsForTests } from '../useHoldToConfirm'
import { notePress, noteRelease, resetPresses } from '../../utils/pointerPresses'

let renders = 0
function Harness({ onConfirm, onShortPress, disabled = false, apiRef = null, label = 'Point A' }) {
  renders++
  return (
    <HoldToConfirmButton
      label={label}
      caption="Hold"
      ariaLabel={`${label}, hold for 2 seconds`}
      onConfirm={onConfirm}
      onShortPress={onShortPress}
      disabled={disabled}
      apiRef={apiRef}
      data-testid={label}
    />
  )
}

const down = (el, opts = {}) => fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, ...opts })
const up = (el, opts = {}) => fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, ...opts })
const fill = (el) => el.querySelector('[data-hold-fill]')

beforeEach(() => {
  vi.useFakeTimers()
  resetHoldsForTests()
  resetPresses()
  renders = 0
  document.documentElement.removeAttribute('data-no-motion')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-no-motion')
  document.body.innerHTML = ''
})

describe('useHoldToConfirm: a whole hold gives the action once', () => {
  it(`fires at ${POINT_HOLD_MS} ms, not before, once per press, and buzzes`, () => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} />)
    const btn = getByTestId('Point A')
    down(btn)
    expect(btn.hasAttribute('data-holding')).toBe(true)
    vi.advanceTimersByTime(POINT_HOLD_MS - 1)
    expect(onConfirm).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].source).toBe('pointer')
    expect(vibrate).toHaveBeenCalledWith(HOLD_VIBRATE_MS)
    // the fill is gone at once, the finger still down gives nothing more
    expect(btn.hasAttribute('data-holding')).toBe(false)
    vi.advanceTimersByTime(POINT_HOLD_MS * 3)
    up(btn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onShortPress).not.toHaveBeenCalled()
    delete navigator.vibrate
  })

  it('a click gives nothing (no onClick: the action comes at the end of the hold)', () => {
    const onConfirm = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} />)
    fireEvent.click(getByTestId('Point A'))
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('let go before the end: nothing, and onShortPress (the "Hold to give the point" notice)', () => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} />)
    const btn = getByTestId('Point A')
    down(btn)
    vi.advanceTimersByTime(POINT_HOLD_MS - 100)
    up(btn)
    expect(btn.hasAttribute('data-holding')).toBe(false)
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onShortPress).toHaveBeenCalledTimes(1)
  })

  it('draws without re-rendering: data-holding and the fill only', () => {
    const { getByTestId } = render(<Harness onConfirm={() => {}} />)
    const btn = getByTestId('Point A')
    const before = renders
    down(btn)
    vi.advanceTimersByTime(POINT_HOLD_MS / 2)
    expect(renders).toBe(before)
    // the fill's transform comes from the stylesheet (.hold-button[data-holding] > .hold-fill)
    expect(fill(btn).style.transform).toBe('')
    expect(btn.style.getPropertyValue('--hold-ms')).toBe(`${POINT_HOLD_MS}ms`)
    up(btn)
  })
})

describe('useHoldToConfirm: a hold that is not a hold gives nothing', () => {
  const holdThen = (act) => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} />)
    const btn = getByTestId('Point A')
    down(btn)
    vi.advanceTimersByTime(500)
    act(btn)
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    return { onConfirm, onShortPress, btn }
  }

  it(`a finger moved farther than ${HOLD_SLOP_PX} px (a slide, not a hold)`, () => {
    const { onConfirm, onShortPress, btn } = holdThen((b) => fireEvent.pointerMove(b, { pointerId: 1, pointerType: 'touch', clientX: 100 + HOLD_SLOP_PX + 1, clientY: 100 }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onShortPress).not.toHaveBeenCalled()
    expect(btn.hasAttribute('data-holding')).toBe(false)
  })

  it('a small wobble of the finger keeps the hold', () => {
    const onConfirm = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} />)
    const btn = getByTestId('Point A')
    down(btn)
    fireEvent.pointerMove(btn, { pointerId: 1, pointerType: 'touch', clientX: 100 + HOLD_SLOP_PX - 2, clientY: 104 })
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('pointercancel (the Android WebView taking the touch) and lostpointercapture', () => {
    expect(holdThen((b) => fireEvent.pointerCancel(b, { pointerId: 1, pointerType: 'touch' })).onConfirm).not.toHaveBeenCalled()
    cleanup()
    expect(holdThen((b) => fireEvent.lostPointerCapture(b, { pointerId: 1, pointerType: 'touch' })).onConfirm).not.toHaveBeenCalled()
  })

  it('the window loses focus, or the page is hidden', () => {
    expect(holdThen(() => fireEvent.blur(window)).onConfirm).not.toHaveBeenCalled()
    cleanup()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(holdThen(() => fireEvent(document, new Event('visibilitychange'))).onConfirm).not.toHaveBeenCalled()
    visibility.mockRestore()
  })

  it('a dialog over the button when the time is up', () => {
    const { onConfirm } = holdThen(() => {
      const dialog = document.createElement('div')
      dialog.setAttribute('aria-modal', 'true')
      document.body.appendChild(dialog)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disabled while held (the set won, a time-out)', () => {
    const onConfirm = vi.fn()
    const { getByTestId, rerender } = render(<Harness onConfirm={onConfirm} />)
    down(getByTestId('Point A'))
    vi.advanceTimersByTime(500)
    rerender(<Harness onConfirm={onConfirm} disabled />)
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('a second finger, on the same button or the other one, stops both', () => {
    const a = vi.fn()
    const b = vi.fn()
    const { getByTestId } = render(<><Harness onConfirm={a} label="Point A" /><Harness onConfirm={b} label="Point B" /></>)
    down(getByTestId('Point A'))
    vi.advanceTimersByTime(300)
    down(getByTestId('Point B'), { pointerId: 2, clientX: 300 })
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    // and on the same button
    down(getByTestId('Point A'))
    down(getByTestId('Point A'), { pointerId: 2, clientX: 140 })
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(a).not.toHaveBeenCalled()
  })

  it('a right mouse button is no hold', () => {
    const onConfirm = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} />)
    down(getByTestId('Point A'), { pointerType: 'mouse', button: 2 })
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('useHoldToConfirm: Android WebView and WebKitGTK', () => {
  it('claims the touch (non-passive touchstart, preventDefault) and blocks the long-press menu', () => {
    const { getByTestId } = render(<Harness onConfirm={() => {}} />)
    const btn = getByTestId('Point A')
    const touch = new Event('touchstart', { bubbles: true, cancelable: true })
    btn.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(true)
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    btn.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
  })

  it("WebKitGTK's mouse echo at the release of a touch starts no second hold", () => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} />)
    const btn = getByTestId('Point A')
    // the touch press and release as the window's listeners record them
    // (utils/pointerPresses: capture phase, before the button's handlers)
    const t0 = performance.now()
    notePress({ pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, timeStamp: t0, target: btn })
    down(btn)
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    noteRelease({ pointerType: 'touch', pointerId: 1, timeStamp: performance.now() })
    up(btn)
    // then the compatibility mouse press at the same place
    down(btn, { pointerType: 'mouse', pointerId: 7, timeStamp: performance.now() })
    expect(btn.hasAttribute('data-holding')).toBe(false)
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('useHoldToConfirm: keys hold too', () => {
  it('Enter / Space on the focused button: keydown starts, keyup lets go, repeats are ignored', () => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} />)
    const btn = getByTestId('Point A')
    const start = fireEvent.keyDown(btn, { key: 'Enter' })
    expect(start).toBe(false) // preventDefault: no click from the key
    vi.advanceTimersByTime(500)
    fireEvent.keyDown(btn, { key: 'Enter', repeat: true })
    vi.advanceTimersByTime(500)
    fireEvent.keyUp(btn, { key: 'Enter' })
    expect(onShortPress).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(btn, { key: ' ' })
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].source).toBe('key')
  })

  it('Escape stops a hold, on the button and on the page (cancelActiveHold)', () => {
    const onConfirm = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} />)
    const btn = getByTestId('Point A')
    fireEvent.keyDown(btn, { key: 'Enter' })
    fireEvent.keyDown(btn, { key: 'Escape' })
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
    down(btn)
    expect(cancelActiveHold()).toBe(true)
    expect(cancelActiveHold()).toBe(false)
    vi.advanceTimersByTime(POINT_HOLD_MS * 2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("the scoring keys hold through the api (the Scoreboard's A / L)", () => {
    const onConfirm = vi.fn()
    const onShortPress = vi.fn()
    const apiRef = { current: null }
    const { getByTestId } = render(<Harness onConfirm={onConfirm} onShortPress={onShortPress} apiRef={apiRef} />)
    expect(apiRef.current).toBeTruthy()
    apiRef.current.start('a')
    expect(getByTestId('Point A').hasAttribute('data-holding')).toBe(true)
    vi.advanceTimersByTime(300)
    apiRef.current.release('l') // another key: not this hold's
    apiRef.current.release('a')
    expect(onShortPress).toHaveBeenCalledTimes(1)
    apiRef.current.start('a')
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // a finger's hold is not let go by the key
    down(getByTestId('Point A'))
    apiRef.current.release('a')
    vi.advanceTimersByTime(POINT_HOLD_MS)
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })
})

describe('useHoldToConfirm: animations off', () => {
  it(`the fill steps (a ${HOLD_STEPS}th at a time), full only when it is given, still after the whole hold`, () => {
    document.documentElement.setAttribute('data-no-motion', '')
    const onConfirm = vi.fn()
    const { getByTestId } = render(<Harness onConfirm={onConfirm} />)
    const btn = getByTestId('Point A')
    down(btn)
    expect(fill(btn).style.transform).toBe('scaleX(0)')
    vi.advanceTimersByTime(POINT_HOLD_MS / HOLD_STEPS)
    expect(fill(btn).style.transform).toBe(`scaleX(${1 / HOLD_STEPS})`)
    vi.advanceTimersByTime(POINT_HOLD_MS / HOLD_STEPS)
    expect(fill(btn).style.transform).toBe(`scaleX(${2 / HOLD_STEPS})`)
    vi.advanceTimersByTime(POINT_HOLD_MS / HOLD_STEPS)
    expect(fill(btn).style.transform).toBe(`scaleX(${3 / HOLD_STEPS})`)
    expect(onConfirm).not.toHaveBeenCalled()
    vi.advanceTimersByTime(POINT_HOLD_MS / HOLD_STEPS)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(fill(btn).style.transform).toBe('')
  })
})

describe('HoldToConfirmButton', () => {
  it('names the hold for screen readers and shows its "Hold" caption', () => {
    function Counter() {
      const [n, setN] = useState(0)
      return <><HoldToConfirmButton label="Point B" caption="Hold" ariaLabel="Point B, hold for 2 seconds" onConfirm={() => setN(n + 1)} data-testid="b" /><output data-testid="n">{n}</output></>
    }
    const { getByTestId, getByRole } = render(<Counter />)
    expect(getByRole('button', { name: 'Point B, hold for 2 seconds' })).toBe(getByTestId('b'))
    expect(getByTestId('b').textContent).toBe('Point BHold')
    expect(getByTestId('b').className).toContain('hold-button')
  })
})
