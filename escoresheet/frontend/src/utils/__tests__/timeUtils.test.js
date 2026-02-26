import { describe, it, expect } from 'vitest'
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
