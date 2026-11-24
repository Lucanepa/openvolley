import { describe, it, expect, afterEach } from 'vitest'
import { zonedParts, zurichWallTimeMs } from '../format'

// The device's time zone: Node reads process.env.TZ at every Date call
const deviceTz = process.env.TZ
afterEach(() => {
  if (deviceTz === undefined) delete process.env.TZ
  else process.env.TZ = deviceTz
})

const iso = (...wall) => new Date(zurichWallTimeMs(...wall)).toISOString()

describe('zurichWallTimeMs', () => {
  it('is the instant of a Zürich wall-clock time, whatever zone the device is in', () => {
    // stress test 2026-10-25: a device on a fixed GMT+2 (summer time kept),
    // UTC, or abroad
    for (const tz of ['Europe/Zurich', 'Etc/GMT-2', 'UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz
      expect(iso(2026, 10, 26, 10, 20), tz).toBe('2026-10-26T09:20:00.000Z')
      expect(iso(2026, 7, 1, 20, 45), tz).toBe('2026-07-01T18:45:00.000Z')
      expect(iso(2026, 10, 27, 0, 0), tz).toBe('2026-10-26T23:00:00.000Z')
    }
  })

  it('is the inverse of zonedParts; the day overflows as in Date.UTC', () => {
    process.env.TZ = 'Etc/GMT-2'
    const p = zonedParts(zurichWallTimeMs(2026, 10, 26, 23, 59))
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 10, 26, 23, 59])
    expect(iso(2026, 11, 0, 23, 30)).toBe('2026-10-31T22:30:00.000Z')
    expect(iso(2026, 10, 25 + 2, 10, 20)).toBe('2026-10-27T09:20:00.000Z')
  })

  it('on the summer-time changes: the skipped hour is the hour after, the repeated one the second', () => {
    process.env.TZ = 'UTC'
    // 29.03.2026 02:30 does not exist in Zürich: 03:30 summer time
    expect(iso(2026, 3, 29, 2, 30)).toBe('2026-03-29T01:30:00.000Z')
    // 25.10.2026 02:30 happens twice: the second one, winter time
    expect(iso(2026, 10, 25, 2, 30)).toBe('2026-10-25T01:30:00.000Z')
  })

  it('NaN for no number', () => {
    expect(zurichWallTimeMs(NaN, 1, 1)).toBeNaN()
    expect(zurichWallTimeMs(2026, 'x', 1)).toBeNaN()
  })
})
