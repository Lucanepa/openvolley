import { describe, it, expect } from 'vitest'
import { elapsedWhenSent, countdownAnchor, secondsLeft, monotonicNow } from '../countdownClock'

describe('countdowns on the device\'s own clock', () => {
  it('how long it had run when sent: from the sender\'s two readings, whatever the receiver\'s clock', () => {
    const start = Date.parse('2026-10-26T19:40:00.000Z')
    expect(elapsedWhenSent(start, start + 150, 30000)).toBe(150)
    expect(elapsedWhenSent(new Date(start).toISOString(), new Date(start + 12000).toISOString(), 30000)).toBe(12000)
    // never below 0 (the sender's clock set back since the start), never past the end
    expect(elapsedWhenSent(start, start - 3600000, 30000)).toBe(0)
    expect(elapsedWhenSent(start, start + 3600000, 30000)).toBe(30000)
    // without one of the readings: as sent at the start
    expect(elapsedWhenSent(start, undefined, 30000)).toBe(0)
    expect(elapsedWhenSent(null, start, 30000)).toBe(0)
    expect(elapsedWhenSent('not a time', start, 30000)).toBe(0)
  })

  it('counts down from its length to 0 on the monotonic clock, never outside', () => {
    const anchor = countdownAnchor(2000, 10000)
    expect(anchor).toBe(8000)
    expect(secondsLeft(anchor, 30, 10000)).toBe(28)
    expect(secondsLeft(anchor, 30, 8000 + 29999)).toBe(1)
    expect(secondsLeft(anchor, 30, 8000 + 30000)).toBe(0)
    expect(secondsLeft(anchor, 30, 8000 + 3600000)).toBe(0)
    // a reading before the anchor shows the full length, not more
    expect(secondsLeft(anchor, 30, 0)).toBe(30)
    expect(countdownAnchor(-5, 100)).toBe(100)
  })

  it('the monotonic clock is a number that does not go back', () => {
    const a = monotonicNow()
    const b = monotonicNow()
    expect(Number.isFinite(a)).toBe(true)
    expect(b).toBeGreaterThanOrEqual(a)
  })
})
