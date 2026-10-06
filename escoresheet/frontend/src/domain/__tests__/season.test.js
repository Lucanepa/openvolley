import { describe, it, expect } from 'vitest'
import { seasonOf, seasonLabel, parseSeasonLabel, seasonOptions } from '../season'

describe('seasonOf (Europe/Zurich, 1 July cut-off)', () => {
  it('turns on 1 July 00:00 Zurich (summer time, UTC+2)', () => {
    expect(seasonOf('2026-06-30T21:59:59Z')).toBe(2025) // 23:59:59 Zurich
    expect(seasonOf('2026-06-30T22:00:00Z')).toBe(2026) // 00:00 Zurich on 1 July
  })
  it('uses the Zurich year at New Year (winter time, UTC+1)', () => {
    expect(seasonOf('2026-12-31T22:59:59Z')).toBe(2026)
    expect(seasonOf('2026-12-31T23:00:00Z')).toBe(2026) // 1 Jan 2027 in Zurich, still season 2026
    expect(seasonOf('2027-06-15T12:00:00Z')).toBe(2026)
  })
  it('handles the DST change days', () => {
    expect(seasonOf('2026-03-29T01:30:00Z')).toBe(2025)
    expect(seasonOf('2026-10-25T00:30:00Z')).toBe(2026)
  })
  it('accepts Date objects and numbers; rejects junk', () => {
    expect(seasonOf(new Date('2026-09-01T10:00:00Z'))).toBe(2026)
    expect(seasonOf(Date.parse('2026-02-01T10:00:00Z'))).toBe(2025)
    expect(seasonOf(null)).toBeNull()
    expect(seasonOf('')).toBeNull()
    expect(seasonOf('not a date')).toBeNull()
  })
})

describe('seasonLabel', () => {
  it('formats the competitions.season text', () => {
    expect(seasonLabel(2026)).toBe('2026/27')
    expect(seasonLabel(1999)).toBe('1999/00')
    expect(seasonLabel('x')).toBe('')
    expect(parseSeasonLabel('2026/27')).toBe(2026)
    expect(parseSeasonLabel('2026')).toBeNull()
  })
  it('lists the season around a date', () => {
    expect(seasonOptions(new Date('2026-10-06T12:00:00Z'))).toEqual(['2025/26', '2026/27', '2027/28'])
  })
})
