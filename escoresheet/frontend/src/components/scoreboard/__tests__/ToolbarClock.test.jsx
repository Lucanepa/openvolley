import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ToolbarClock, { formatToolbarClock } from '../ToolbarClock'
import { openAppWindow, currentInAppView } from '../../../utils/openAppWindow'

// The text the scoring screen's clock had (Scoreboard formatTimestamp until
// 22.11.2026): the leaf must write exactly the same
const formatTimestamp = (date) => {
  const day = date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  return `${day} ${time}`
}

afterEach(() => {
  currentInAppView()?.close()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('formatToolbarClock', () => {
  it('writes what the scoring screen wrote, at any time of the year and of the day', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0)
    // every 7 h 13 min 7 s over two years: every hour, minute and second
    // position, midnight, the DST changes and a leap day come round
    for (let t = start; t < start + 2 * 366 * 86400e3; t += 25987e3) {
      const d = new Date(t)
      expect(formatToolbarClock(d)).toBe(formatTimestamp(d))
    }
    for (const iso of ['2026-11-08T09:51:10', '2026-03-29T02:30:00', '2026-10-25T02:59:59', '2028-02-29T23:59:59', '2026-12-31T00:00:00']) {
      const d = new Date(iso)
      expect(formatToolbarClock(d)).toBe(formatTimestamp(d))
    }
  })

  it('Intl.DateTimeFormat with these options writes what toLocaleDateString / toLocaleTimeString write, in the tablets\' languages too', () => {
    const DAY = { year: 'numeric', month: '2-digit', day: '2-digit' }
    const TIME = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    for (const locale of ['de-CH', 'fr-CH', 'it-CH', 'en-GB', 'en-US', 'de-DE']) {
      const day = new Intl.DateTimeFormat(locale, DAY)
      const time = new Intl.DateTimeFormat(locale, TIME)
      for (const iso of ['2026-11-08T09:51:10', '2026-11-08T00:00:05', '2026-11-08T23:59:59', '2026-01-01T12:00:00']) {
        const d = new Date(iso)
        expect(day.format(d)).toBe(d.toLocaleDateString(locale, DAY))
        expect(time.format(d)).toBe(d.toLocaleTimeString(locale, TIME))
      }
    }
  })

  it('has no comma between the date and the time', () => {
    const d = new Date('2026-11-08T09:51:10')
    const text = formatToolbarClock(d)
    expect(text).not.toContain(',')
    expect(text).toMatch(/ \d{2}:\d{2}:\d{2}$/)
  })
})

describe('ToolbarClock', () => {
  it('ticks by itself every second; its parent does not render again', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:00') })
    let parentRenders = 0
    function Parent () {
      parentRenders++
      return <span data-testid="clock"><ToolbarClock /></span>
    }
    render(<Parent />)
    expect(screen.getByTestId('clock').textContent).toBe(formatTimestamp(new Date('2026-11-22T10:00:00')))
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByTestId('clock').textContent).toBe(formatTimestamp(new Date('2026-11-22T10:00:03')))
    expect(parentRenders).toBe(1)
  })

  it('stops under the Android in-app view and shows the time at once when it closes', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:00') })
    let clockRenders = 0
    const spy = vi.fn((text) => { clockRenders++; return text })
    function Counting () {
      return <span data-testid="clock">{spy(ToolbarClock())}</span>
    }
    render(<Counting />)
    act(() => { openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' }) })
    const covered = clockRenders
    act(() => { vi.advanceTimersByTime(60000) })
    expect(clockRenders).toBe(covered)
    expect(screen.getByTestId('clock').textContent).toBe(formatTimestamp(new Date('2026-11-22T10:00:00')))
    act(() => { currentInAppView().close() })
    expect(screen.getByTestId('clock').textContent).toBe(formatTimestamp(new Date('2026-11-22T10:01:00')))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('clock').textContent).toBe(formatTimestamp(new Date('2026-11-22T10:01:01')))
  })
})
