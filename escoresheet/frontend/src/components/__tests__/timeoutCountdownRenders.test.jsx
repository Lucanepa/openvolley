import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import CountdownSeconds from '../scoreboard/CountdownSeconds'
import { dragPointer, useDragPointer } from '../scoreboard/dragPointer'

// The owner dragged a substitute in during a time-out on a small tablet
// (17.11.2026) and could confirm it only after the time-out: the countdown
// was the scoring screen's state and rendered all of it ten times a second,
// and every finger move of the drag did too. Now the digits tick in their own
// component and the finger is outside the screen's state.

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  dragPointer.set(null)
})

describe('CountdownSeconds', () => {
  it('ticks the seconds by itself; its parent does not render again', () => {
    vi.useFakeTimers()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let parentRenders = 0
    function Parent () {
      parentRenders++
      return <CountdownSeconds clock={{ anchor: 1000, duration: 30 }} fallback={30}>{(s) => <span data-testid="s">{s}</span>}</CountdownSeconds>
    }
    render(<Parent />)
    expect(screen.getByTestId('s')).toHaveTextContent('30')
    const rendered = parentRenders
    act(() => { now = 1000 + 2500; vi.advanceTimersByTime(2500) })
    expect(screen.getByTestId('s')).toHaveTextContent('28')
    act(() => { now = 1000 + 31000; vi.advanceTimersByTime(28500) })
    expect(screen.getByTestId('s')).toHaveTextContent('0')
    expect(parentRenders).toBe(rendered)
  })

  it('without a clock it shows the fallback', () => {
    render(<CountdownSeconds clock={null} fallback={12}>{(s) => <span data-testid="s">{s}</span>}</CountdownSeconds>)
    expect(screen.getByTestId('s')).toHaveTextContent('12')
  })
})

describe('dragPointer', () => {
  it('only its subscribers render when the finger moves', () => {
    let parentRenders = 0
    let discRenders = 0
    function Disc () {
      discRenders++
      const p = useDragPointer()
      return <span data-testid="disc">{p ? `${p.x},${p.y}` : '-'}</span>
    }
    function Parent () {
      parentRenders++
      return <Disc />
    }
    render(<Parent />)
    act(() => dragPointer.set({ x: 10, y: 20 }))
    act(() => dragPointer.set({ x: 30, y: 40 }))
    expect(screen.getByTestId('disc')).toHaveTextContent('30,40')
    expect(parentRenders).toBe(1)
    expect(discRenders).toBeGreaterThanOrEqual(3)
  })
})
