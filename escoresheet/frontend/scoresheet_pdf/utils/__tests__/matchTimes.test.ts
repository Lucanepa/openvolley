import { describe, it, expect } from 'vitest'
import { matchTimes, setDurationMinutes, setEndMs, setStartMs } from '../matchTimes'

const iso = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 9, 7, h, m, s)).toISOString()
const min = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m)

// Owner 2026-11-15: the dialog proposes the actual start (set 1) or the last
// set's end + 3 min (later sets); the time the scorer confirms is the set's
// start on the sheet, whatever the clock of the first rally said.
// Set 1: confirmed 16:06, first rally 16:05:41 (the scorer pressed early)
const set1 = { index: 1, startTime: iso(16, 6), endTime: iso(16, 14), finished: true }
// Set 2: end 16:14 + 3 min proposed and confirmed, first rally 16:17:02
const set2 = { index: 2, startTime: iso(16, 17), endTime: iso(16, 26), finished: true }
const events = [
  { type: 'set_start', setIndex: 1, seq: 1, ts: iso(16, 6), payload: { startTime: iso(16, 6), firstRallyAt: iso(16, 5, 41) } },
  { type: 'rally_start', setIndex: 1, seq: 2, ts: iso(16, 5, 41) },
  { type: 'point', setIndex: 1, seq: 3, ts: iso(16, 6, 10) },
  { type: 'set_start', setIndex: 2, seq: 8, ts: iso(16, 17), payload: { startTime: iso(16, 17), firstRallyAt: iso(16, 17, 2) } },
  { type: 'rally_start', setIndex: 2, seq: 9, ts: iso(16, 17, 2) },
  { type: 'point', setIndex: 2, seq: 10, ts: iso(16, 17, 40) },
]

describe('set and match times (owner 2026-11-15)', () => {
  it('a set starts at the confirmed time, not at its first rally', () => {
    expect(setStartMs(set1, events)).toBe(min(16, 6))
    expect(setDurationMinutes(set1, events)).toBe(8)
    expect(setStartMs(set2, events)).toBe(min(16, 17))
    expect(setDurationMinutes(set2, events)).toBe(9)
  })

  it('a start corrected after the dialog (edit modal) wins over the confirmed one', () => {
    const edited = { ...set1, startTime: iso(16, 3) }
    expect(setStartMs(edited, events)).toBe(min(16, 3))
    expect(setDurationMinutes(edited, events)).toBe(11)
  })

  it('a copy restored from the server (no rally_start) prints the same times', () => {
    const restored = events.filter(e => e.type !== 'rally_start')
    expect(setStartMs(set1, restored)).toBe(min(16, 6))
    expect(setStartMs(set1, restored)).toBe(setStartMs(set1, events))
    expect(matchTimes([set1, set2], restored).startMs).toBe(matchTimes([set1, set2], events).startMs)
    expect(setStartMs({ ...set1, startTime: iso(16, 3) }, restored)).toBe(min(16, 3))
  })

  it('rally starts only tell the start of a record without a confirmed time (older records)', () => {
    const old = events.filter(e => e.type !== 'set_start')
    expect(setStartMs({ index: 1, endTime: iso(16, 14), finished: true }, old)).toBe(min(16, 5))
  })

  it('falls back to the confirmed start, then to the first point', () => {
    expect(setStartMs(set1, [])).toBe(min(16, 6))
    expect(setStartMs({ index: 3 }, [{ type: 'point', setIndex: 3, ts: iso(17, 1, 59) }])).toBe(min(17, 1))
    expect(setStartMs({ index: 4 }, [])).toBeNull()
  })

  it('a set ends at its recorded end, else its last point; unfinished sets have no duration', () => {
    expect(setEndMs(set1, events)).toBe(min(16, 14))
    expect(setEndMs({ index: 3, finished: true }, [{ type: 'point', setIndex: 3, ts: iso(17, 20, 30) }])).toBe(min(17, 20))
    expect(setDurationMinutes({ index: 3, startTime: iso(17, 0) }, [])).toBeNull()
  })

  it('match start = set 1 actual start, end = last set end, duration = end - start', () => {
    expect(matchTimes([set1, set2], events)).toEqual({ startMs: min(16, 6), endMs: min(16, 26), durationMinutes: 20 })
    // not started yet: nothing
    expect(matchTimes([{ index: 1 }], [])).toEqual({ startMs: null, endMs: null, durationMinutes: null })
  })
})
