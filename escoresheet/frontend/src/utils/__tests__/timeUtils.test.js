import { describe, it, expect, afterEach } from 'vitest'
import {
  formatTimeLocal,
  formatDateTimeLocal,
  parseLocalToISO,
  parseLocalDateTimeToISO,
  splitLocalDateTime,
  roundToMinute
} from '../timeUtils'

describe('formatTimeLocal', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(formatTimeLocal(null)).toBe('')
    expect(formatTimeLocal(undefined)).toBe('')
    expect(formatTimeLocal('')).toBe('')
  })

  it('returns empty string for invalid date', () => {
    expect(formatTimeLocal('not-a-date')).toBe('')
    expect(formatTimeLocal('2024-13-45T99:99:99Z')).toBe('')
  })

  it('returns HH:MM format for valid ISO string', () => {
    // Use a known UTC time and check the format matches HH:MM
    const result = formatTimeLocal('2024-06-15T12:30:00Z')
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })

  it('pads single-digit hours and minutes', () => {
    // Midnight UTC — local result depends on timezone but format should be correct
    const result = formatTimeLocal('2024-01-01T00:05:00Z')
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('formatDateTimeLocal', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(formatDateTimeLocal(null)).toBe('')
    expect(formatDateTimeLocal(undefined)).toBe('')
    expect(formatDateTimeLocal('')).toBe('')
  })

  it('returns empty string for invalid date', () => {
    expect(formatDateTimeLocal('not-a-date')).toBe('')
  })

  it('returns YYYY-MM-DDTHH:MM format for valid ISO string', () => {
    const result = formatDateTimeLocal('2024-06-15T12:30:00Z')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})

describe('parseLocalToISO', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseLocalToISO(null)).toBeNull()
    expect(parseLocalToISO(undefined)).toBeNull()
    expect(parseLocalToISO('')).toBeNull()
  })

  it('returns null for invalid date string', () => {
    expect(parseLocalToISO('not-a-date')).toBeNull()
  })

  it('returns ISO string with Z suffix for valid input', () => {
    const result = parseLocalToISO('2024-06-15T12:30')
    expect(result).toBeTruthy()
    expect(result).toMatch(/Z$/)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('round-trips with formatDateTimeLocal', () => {
    const original = '2024-06-15T12:30:00Z'
    const localStr = formatDateTimeLocal(original)
    const roundTripped = parseLocalToISO(localStr)
    // The round-tripped value should be within 1 minute of original (seconds zeroed)
    const origDate = new Date(original)
    const rtDate = new Date(roundTripped)
    expect(Math.abs(origDate.getTime() - rtDate.getTime())).toBeLessThanOrEqual(60000)
  })
})

describe('parseLocalDateTimeToISO', () => {
  it('returns null for null/empty date', () => {
    expect(parseLocalDateTimeToISO(null)).toBeNull()
    expect(parseLocalDateTimeToISO('')).toBeNull()
  })

  it('returns ISO string for valid date and time', () => {
    const result = parseLocalDateTimeToISO('2024-06-15', '14:30')
    expect(result).toBeTruthy()
    expect(result).toMatch(/Z$/)
  })

  it('uses 00:00 as default time', () => {
    const result = parseLocalDateTimeToISO('2024-06-15')
    expect(result).toBeTruthy()
    expect(result).toMatch(/Z$/)
  })
})

describe('splitLocalDateTime', () => {
  it('returns empty strings for null/undefined/empty', () => {
    expect(splitLocalDateTime(null)).toEqual({ date: '', time: '' })
    expect(splitLocalDateTime(undefined)).toEqual({ date: '', time: '' })
    expect(splitLocalDateTime('')).toEqual({ date: '', time: '' })
  })

  it('returns empty strings for invalid date', () => {
    expect(splitLocalDateTime('not-a-date')).toEqual({ date: '', time: '' })
  })

  it('returns date and time components for valid ISO string', () => {
    const result = splitLocalDateTime('2024-06-15T12:30:00Z')
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.time).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('roundToMinute', () => {
  it('returns null for null/undefined/empty', () => {
    expect(roundToMinute(null)).toBeNull()
    expect(roundToMinute(undefined)).toBeNull()
    expect(roundToMinute('')).toBeNull()
  })

  it('returns null for invalid date', () => {
    expect(roundToMinute('not-a-date')).toBeNull()
  })

  it('zeroes seconds and milliseconds', () => {
    const result = roundToMinute('2024-06-15T12:30:45.123Z')
    expect(result).toBe('2024-06-15T12:30:00.000Z')
  })

  it('keeps already-rounded times unchanged', () => {
    const result = roundToMinute('2024-06-15T12:30:00.000Z')
    expect(result).toBe('2024-06-15T12:30:00.000Z')
  })
})

// Stress test 2026-10-25 (device-timezone-shifts-official-times): a scorer
// laptop on a fixed GMT+2 zone (summer time kept after 25.10) stored the
// official kick-off 10:20 as 08:20Z, on the server too, and printed set 1 at
// 11:20 on the official sheet; on a UTC device 09:17 for 10:17. Every clock is
// a Zürich clock (ui/format.js): the gym's, whatever zone the device is in.
describe('the Zürich clock on a device in any zone', () => {
  const deviceTz = process.env.TZ
  afterEach(() => {
    if (deviceTz === undefined) delete process.env.TZ
    else process.env.TZ = deviceTz
  })

  for (const tz of ['Etc/GMT-2', 'UTC', 'America/New_York', 'Europe/Zurich']) {
    it(`${tz}: a kick-off or a typed time of 10:20 is 10:20 in Zürich`, () => {
      process.env.TZ = tz
      expect(parseLocalDateTimeToISO('2026-10-26', '10:20')).toBe('2026-10-26T09:20:00.000Z')
      expect(parseLocalDateTimeToISO('2026-07-01', '20:45')).toBe('2026-07-01T18:45:00.000Z')
      expect(splitLocalDateTime('2026-10-26T09:20:00.000Z')).toEqual({ date: '2026-10-26', time: '10:20' })
      expect(formatTimeLocal('2026-10-26T09:20:00.000Z')).toBe('10:20')
      // the schedule's zone-less datetime is Zürich wall time (backend vmSync)
      expect(formatTimeLocal('2026-10-26T10:20:00')).toBe('10:20')
      expect(splitLocalDateTime('2026-10-26T10:20:00')).toEqual({ date: '2026-10-26', time: '10:20' })
      // 23:30Z is already the next day in Zürich
      expect(splitLocalDateTime('2026-10-26T23:30:00.000Z')).toEqual({ date: '2026-10-27', time: '00:30' })
      expect(formatDateTimeLocal('2026-10-26T23:30:00.000Z')).toBe('2026-10-27T00:30')
      expect(parseLocalToISO('2026-10-27T00:30')).toBe('2026-10-26T23:30:00.000Z')
    })
  }

  it('an impossible date or time is no time', () => {
    expect(parseLocalDateTimeToISO('2026-02-30', '10:00')).toBeNull()
    expect(parseLocalDateTimeToISO('2026-10-26', '24:00')).toBeNull()
    expect(parseLocalDateTimeToISO('2026-10-26', '10:60')).toBeNull()
    expect(parseLocalDateTimeToISO('26.10.2026', '10:00')).toBeNull()
    expect(parseLocalToISO('2026-10-26T25:00')).toBeNull()
  })
})
