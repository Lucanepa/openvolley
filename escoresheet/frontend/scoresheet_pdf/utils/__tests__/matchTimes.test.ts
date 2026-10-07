import { describe, it, expect } from 'vitest'
import { matchTimes, setDurationMinutes, setEndMs, setStartMs } from '../matchTimes'

const iso = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 9, 7, h, m, s)).toISOString()
const min = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m)

// The owner's report: scheduled 14:30, set 1 really started 16:05; the dialog kept 14:30
const set1 = { index: 1, startTime: iso(14, 30), endTime: iso(16, 14), finished: true }
const set2 = { index: 2, startTime: iso(16, 17), endTime: iso(16, 26), finished: true }
const events = [
  { type: 'set_start', setIndex: 1, seq: 1, ts: iso(14, 30) },
  { type: 'rally_start', setIndex: 1, seq: 2, ts: iso(16, 5, 41) },
  { type: 'point', setIndex: 1, seq: 3, ts: iso(16, 6, 10) },
  { type: 'rally_start', setIndex: 1, seq: 4, ts: iso(16, 6, 30) },
  { type: 'rally_start', setIndex: 2, seq: 9, ts: iso(16, 17, 2) },
  { type: 'point', setIndex: 2, seq: 10, ts: iso(16, 17, 40) },
]

describe('actual set and match times (owner 2026-10-07)', () => {
  it('a set starts at its first rally, not at the confirmed (scheduled) time', () => {
    expect(setStartMs(set1, events)).toBe(min(16, 5))
    expect(setDurationMinutes(set1, events)).toBe(9)
    expect(setDurationMinutes(set2, events)).toBe(9)
  })

  it('a start corrected after the dialog (edit modal) wins over the first rally', () => {
    const edited = { ...set1, startTime: iso(16, 3) }
    const withDialog = [{ type: 'set_start', setIndex: 1, seq: 1, ts: iso(14, 30), payload: { startTime: iso(14, 30) } }, ...events.slice(1)]
    expect(setStartMs(edited, withDialog)).toBe(min(16, 3))
    expect(setDurationMinutes(edited, withDialog)).toBe(11)
    // unedited: the dialog value equals the set's start time, the first rally decides
    expect(setStartMs(set1, withDialog)).toBe(min(16, 5))
  })

  it('falls back to the confirmed start, then to the first point', () => {
    expect(setStartMs(set1, [])).toBe(min(14, 30))
    expect(setStartMs({ index: 3 }, [{ type: 'point', setIndex: 3, ts: iso(17, 1, 59) }])).toBe(min(17, 1))
    expect(setStartMs({ index: 4 }, [])).toBeNull()
  })

  it('a set ends at its recorded end, else its last point; unfinished sets have no duration', () => {
    expect(setEndMs(set1, events)).toBe(min(16, 14))
    expect(setEndMs({ index: 3, finished: true }, [{ type: 'point', setIndex: 3, ts: iso(17, 20, 30) }])).toBe(min(17, 20))
    expect(setDurationMinutes({ index: 3, startTime: iso(17, 0) }, [])).toBeNull()
  })

  it('match start = set 1 actual start, end = last set end, duration = end - start', () => {
    expect(matchTimes([set1, set2], events)).toEqual({ startMs: min(16, 5), endMs: min(16, 26), durationMinutes: 21 })
    // not started yet: nothing
    expect(matchTimes([{ index: 1 }], [])).toEqual({ startMs: null, endMs: null, durationMinutes: null })
  })
})
