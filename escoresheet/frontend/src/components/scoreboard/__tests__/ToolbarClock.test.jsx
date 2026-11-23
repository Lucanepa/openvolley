import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ToolbarClock, { formatToolbarClock, msToNextMinute } from '../ToolbarClock'
import { openAppWindow, currentInAppView } from '../../../utils/openAppWindow'
import { LOOK_KEYS, resetLookForTests, setLook } from '../../../utils/lookSettings'

// The text the scoring screen's clock had (Scoreboard formatTimestamp until
// 22.11.2026): the leaf must write exactly the same
const formatTimestamp = (date) => {
  const day = date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  return `${day} ${time}`
}

// The device's time zone changing while the app runs (Node follows a TZ
// change at run time, as Chrome follows the system's)
const ZONE = process.env.TZ
const setZone = (zone) => { process.env.TZ = zone }

afterEach(() => {
  currentInAppView()?.close()
  document.body.innerHTML = ''
  vi.useRealTimers()
  setZone(ZONE)
  localStorage.clear()
  resetLookForTests()
})

// The clock's text without seconds: the day as before, the time HH:MM
const minutesText = (date) => {
  const day = date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

describe('formatToolbarClock follows the device\'s time zone', () => {
  it('a zone changed while the app runs: the new zone\'s time, as toLocaleTimeString', () => {
    const d = new Date('2026-11-22T12:00:00Z')
    setZone('Europe/Zurich')
    expect(formatToolbarClock(d)).toBe(formatTimestamp(d))
    expect(formatToolbarClock(d)).toMatch(/ 13:00:00$/)
    setZone('Asia/Tokyo')
    expect(formatToolbarClock(d)).toBe(formatTimestamp(d))
    expect(formatToolbarClock(d)).toMatch(/ 21:00:00$/)
    // and the date with it: 05:00 UTC is still the day before in Pago Pago
    const early = new Date('2026-11-22T05:00:00Z')
    setZone('Europe/Zurich')
    const zurich = formatToolbarClock(early)
    setZone('Pacific/Pago_Pago')
    const pagoPago = formatToolbarClock(early)
    expect(pagoPago).toBe(formatTimestamp(early))
    expect(pagoPago).toMatch(/ 18:00:00$/)
    expect(pagoPago.split(' ')[0]).not.toBe(zurich.split(' ')[0])
    setZone('Europe/Zurich')
    expect(formatToolbarClock(d)).toMatch(/ 13:00:00$/)
  })

  it('the ticking clock shows the new zone at its next second', () => {
    setZone('Europe/Zurich')
    vi.useFakeTimers({ now: new Date('2026-11-22T12:00:00Z') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    expect(screen.getByTestId('clock').textContent).toMatch(/ 13:00:00$/)
    setZone('America/New_York')
    act(() => { vi.advanceTimersByTime(1000) })
    const shown = screen.getByTestId('clock').textContent
    expect(shown).toBe(formatTimestamp(new Date('2026-11-22T12:00:01Z')))
    expect(shown).toMatch(/ 07:00:01$/)
  })
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

// Options › Effects and speed › Seconds on the clock (utils/lookSettings
// clockSeconds): off, HH:MM and one tick a minute, on the minute
describe('ToolbarClock without seconds', () => {
  it('the default is with seconds, as before', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00:30$/)
  })

  it('shows HH:MM and ticks once a minute, on the minute', () => {
    localStorage.setItem(LOOK_KEYS.clockSeconds, 'false')
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    const clock = () => screen.getByTestId('clock').textContent
    expect(clock()).toBe(minutesText(new Date('2026-11-22T10:00:30')))
    expect(clock()).toMatch(/ 10:00$/)
    // one timer, no second-by-second interval
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersToNextTimer() })
    expect(new Date(Date.now()).toISOString()).toBe(new Date('2026-11-22T10:01:00').toISOString())
    expect(clock()).toMatch(/ 10:01$/)
    for (const minute of ['02', '03', '04']) {
      act(() => { vi.advanceTimersToNextTimer() })
      expect(new Date(Date.now()).getSeconds()).toBe(0)
      expect(new Date(Date.now()).getMilliseconds()).toBe(0)
      expect(clock()).toMatch(new RegExp(` 10:${minute}$`))
      expect(vi.getTimerCount()).toBe(1)
    }
  })

  it('59 s on, the text has not changed; at the minute it has', () => {
    localStorage.setItem(LOOK_KEYS.clockSeconds, 'false')
    vi.useFakeTimers({ now: new Date('2026-11-22T23:59:00') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    const before = screen.getByTestId('clock').textContent
    act(() => { vi.advanceTimersByTime(59999) })
    expect(screen.getByTestId('clock').textContent).toBe(before)
    act(() => { vi.advanceTimersByTime(1) })
    // midnight: the date turns with it
    expect(screen.getByTestId('clock').textContent).toBe(minutesText(new Date('2026-11-23T00:00:00')))
  })

  it('turned off and on while it shows: applies at once', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00:30$/)
    act(() => { setLook({ clockSeconds: false }) })
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00$/)
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00$/)
    act(() => { setLook({ clockSeconds: true }) })
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00:35$/)
  })

  it('stops under the Android in-app view too', () => {
    localStorage.setItem(LOOK_KEYS.clockSeconds, 'false')
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    act(() => { openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' }) })
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(120000) })
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:00$/)
    act(() => { currentInAppView().close() })
    expect(screen.getByTestId('clock').textContent).toMatch(/ 10:02$/)
  })

  it('formatToolbarClock({ seconds: false }) writes what toLocaleTimeString writes without seconds', () => {
    for (const iso of ['2026-11-08T09:51:10', '2026-03-29T03:30:00', '2026-12-31T23:59:59', '2028-02-29T00:00:00']) {
      const d = new Date(iso)
      expect(formatToolbarClock(d, { seconds: false })).toBe(minutesText(d))
      expect(formatToolbarClock(d, { seconds: false })).not.toContain(',')
    }
  })

  it('msToNextMinute', () => {
    expect(msToNextMinute(Date.UTC(2026, 10, 22, 10, 0, 30))).toBe(30000)
    expect(msToNextMinute(Date.UTC(2026, 10, 22, 10, 0, 0))).toBe(60000)
    expect(msToNextMinute(Date.UTC(2026, 10, 22, 10, 0, 59, 999))).toBe(1)
  })
})

// The time sits in a box of its own (styles.css .toolbar-clock-time: fixed
// size, strict containment), so a tick lays out that box alone; the date is
// plain text before it. A time longer than the box (fr-CA) grows it, never
// cuts it.
describe('ToolbarClock box', () => {
  /**
   * Widths jsdom cannot lay out: the time's text (a Range over the box), the
   * box itself (its inline em width at 16 px, else `widths.box`), its font
   * size. A text width of 0 is a hidden box.
   */
  function fakeLayout (widths) {
    const isBox = (el) => el?.classList?.contains('toolbar-clock-time')
    const hadRange = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
    Range.prototype.getBoundingClientRect = function () { return { width: widths.text } }
    const realRect = Element.prototype.getBoundingClientRect
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (!isBox(this)) return realRect.call(this)
      const em = parseFloat(this.style.width)
      return { width: widths.text === 0 ? 0 : (this.style.width ? em * 16 : widths.box) }
    })
    const real = window.getComputedStyle
    const gcs = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, ...rest) => (isBox(el) ? { fontSize: '16px' } : real(el, ...rest)))
    return () => {
      if (hadRange) Object.defineProperty(Range.prototype, 'getBoundingClientRect', hadRange)
      else delete Range.prototype.getBoundingClientRect
      rect.mockRestore()
      gcs.mockRestore()
    }
  }
  const box = () => document.querySelector('[data-testid="clock"] .toolbar-clock-time')

  it('the date as plain text, the time in the box, marked when it has no seconds', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    const [day, time] = formatTimestamp(new Date('2026-11-22T10:00:30')).split(' ')
    expect(box().textContent).toBe(time)
    expect(box().previousSibling.nodeType).toBe(Node.TEXT_NODE)
    expect(screen.getByTestId('clock').textContent).toBe(`${day} ${time}`)
    expect(box().hasAttribute('data-seconds')).toBe(false)
    act(() => { setLook({ clockSeconds: false }) })
    expect(box().getAttribute('data-seconds')).toBe('off')
    expect(box().textContent).toBe('10:00')
  })

  it('a tick changes only the time\'s text node; the date\'s stays', () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
    render(<span data-testid="clock"><ToolbarClock /></span>)
    const shownBox = box()
    const dayNodes = [...screen.getByTestId('clock').childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
    const dayText = dayNodes.map((n) => n.textContent).join('')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(box()).toBe(shownBox)
    expect(box().textContent).toMatch(/^10:00:31$/)
    const after = [...screen.getByTestId('clock').childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
    expect(after).toEqual(dayNodes)
    expect(after.map((n) => n.textContent).join('')).toBe(dayText)
  })

  it('the box takes the time\'s exact width, in em; a tick that keeps it writes nothing', () => {
    const widths = { text: 109.3, box: 111.5 }
    const restore = fakeLayout(widths)
    try {
      vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
      render(<span data-testid="clock"><ToolbarClock /></span>)
      // 109.3 px rounded up to a 64th of a pixel (109.3125), over 16 px
      expect(box().style.width).toMatch(/em$/)
      expect(parseFloat(box().style.width) * 16).toBeGreaterThanOrEqual(109.3)
      expect(parseFloat(box().style.width) * 16).toBeLessThan(109.33)
      const fitted = box().style.width
      const writes = vi.spyOn(box().style, 'width', 'set')
      act(() => { vi.advanceTimersByTime(3000) })
      expect(box().style.width).toBe(fitted)
      expect(writes).not.toHaveBeenCalled()
    } finally { restore() }
  })

  it('a longer time (fr-CA "23 h 58 min 48 s") widens the box; a shorter one narrows it', () => {
    const widths = { text: 198.2, box: 111.5 }
    const restore = fakeLayout(widths)
    try {
      vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
      render(<span data-testid="clock"><ToolbarClock /></span>)
      expect(parseFloat(box().style.width) * 16).toBeGreaterThanOrEqual(198.2)
      widths.text = 70.1
      act(() => { vi.advanceTimersByTime(1000) })
      expect(parseFloat(box().style.width) * 16).toBeGreaterThanOrEqual(70.1)
      expect(parseFloat(box().style.width) * 16).toBeLessThan(70.2)
    } finally { restore() }
  })

  it('hidden (the folded toolbar), it keeps its width; seconds changed while hidden: the stylesheet\'s', () => {
    const widths = { text: 109.3, box: 111.5 }
    const restore = fakeLayout(widths)
    try {
      vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
      render(<span data-testid="clock"><ToolbarClock /></span>)
      const fitted = box().style.width
      widths.text = 0
      act(() => { vi.advanceTimersByTime(2000) })
      expect(box().style.width).toBe(fitted)
      act(() => { setLook({ clockSeconds: false }) })
      expect(box().style.width).toBe('')
      // shown again: fitted at the next tick
      widths.text = 70.1
      act(() => { vi.advanceTimersToNextTimer() })
      expect(parseFloat(box().style.width) * 16).toBeGreaterThanOrEqual(70.1)
    } finally { restore() }
  })

  it('a web font that arrives later: fitted again at once', () => {
    const widths = { text: 100, box: 111.5 }
    const restore = fakeLayout(widths)
    const listeners = new Set()
    const fonts = { addEventListener: (type, fn) => { if (type === 'loadingdone') listeners.add(fn) }, removeEventListener: (type, fn) => listeners.delete(fn) }
    const had = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      vi.useFakeTimers({ now: new Date('2026-11-22T10:00:30') })
      localStorage.setItem(LOOK_KEYS.clockSeconds, 'false')
      const { unmount } = render(<span data-testid="clock"><ToolbarClock /></span>)
      expect(parseFloat(box().style.width) * 16).toBeLessThan(100.1)
      widths.text = 104.6
      act(() => { listeners.forEach((fn) => fn()) })
      expect(parseFloat(box().style.width) * 16).toBeGreaterThanOrEqual(104.6)
      unmount()
      expect(listeners.size).toBe(0)
    } finally {
      if (had) Object.defineProperty(document, 'fonts', had)
      else delete document.fonts
      restore()
    }
  })
})
