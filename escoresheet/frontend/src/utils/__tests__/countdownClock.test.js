import { describe, it, expect, beforeEach } from 'vitest'
import { elapsedWhenSent, countdownAnchor, secondsLeft, monotonicNow, keepCountdown, elapsedAfterTheFact, liveStatePushedAt } from '../countdownClock'

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

  // 2026-10-27: updated_at is the live-state clock (serverDataSync
  // liveClockOffset), which runs ahead of the scorer's own clock on a match it
  // continued; the starts are on its own clock, as last_event_ts is
  it('a row\'s push time on the scorer\'s own clock: last_event_ts, else updated_at', () => {
    const pushed = Date.parse('2026-10-27T19:40:05.000Z')
    const row = {
      timeout_started_at: new Date(pushed - 5000).toISOString(),
      last_event_ts: new Date(pushed).toISOString(),
      updated_at: new Date(pushed + 3600000).toISOString()
    }
    expect(liveStatePushedAt(row)).toBe(row.last_event_ts)
    expect(elapsedWhenSent(row.timeout_started_at, liveStatePushedAt(row), 30000)).toBe(5000)
    // a row without one (an older scorer, a partial write): updated_at
    expect(liveStatePushedAt({ updated_at: row.updated_at })).toBe(row.updated_at)
    expect(liveStatePushedAt({ last_event_ts: null, updated_at: row.updated_at })).toBe(row.updated_at)
    expect(liveStatePushedAt(null)).toBeNull()
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

describe('a countdown read after the fact (a reload, a join)', () => {
  beforeEach(() => sessionStorage.clear())

  it('this tab\'s own countdown of the same start, kept before the reload, whatever this device\'s clock says', () => {
    const start = Date.parse('2026-10-26T19:40:00.000Z') // the scorer's clock
    // shown with 10 s gone, at monotonic 5000 and wall 1000000 on this device
    keepCountdown('m:timeout', start, countdownAnchor(10000, 5000), 30, { now: 1000000, mono: 5000 })
    // 3 s later after a reload: 13 s gone
    expect(elapsedAfterTheFact('m:timeout', start, 30, { now: 1003000 })).toBe(13000)
    expect(elapsedAfterTheFact('m:timeout', new Date(start + 1500).toISOString(), 30, { now: 1003000 })).toBe(13000)
    // over by now: its length, never more
    expect(elapsedAfterTheFact('m:timeout', start, 30, { now: 1100000 })).toBe(30000)
  })

  it('another countdown, or none kept: this device\'s clock against the start, within the length', () => {
    const start = Date.parse('2026-10-26T19:40:00.000Z')
    keepCountdown('m:timeout', start - 60000, countdownAnchor(0, 0), 30, { now: 1000000, mono: 0 })
    expect(elapsedAfterTheFact('m:timeout', start, 30, { now: start + 12000 })).toBe(12000)
    expect(elapsedAfterTheFact('m:interval', start, 180, { now: start + 40000 })).toBe(40000)
    expect(elapsedAfterTheFact('m:interval', start, 180, { now: start - 120000 })).toBe(0)
    expect(elapsedAfterTheFact('m:interval', start, 180, { now: start + 3600000 })).toBe(180000)
    expect(elapsedAfterTheFact('m:interval', 'not a time', 180)).toBe(0)
  })
})
