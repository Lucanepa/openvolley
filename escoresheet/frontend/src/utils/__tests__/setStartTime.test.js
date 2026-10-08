import { describe, it, expect } from 'vitest'
import { defaultSetStartTime, scheduledStartOnDay, actualStartRemark, startsFromSchedule, startScheduleOf } from '../setStartTime'
import { setActualStartRemark } from '../../domain/remarks'
import { setDurationMinutes, matchTimes } from '../../../scoresheet_pdf/utils/matchTimes'

const at = (iso) => new Date(iso)

describe('defaultSetStartTime', () => {
  it('set 1 without a scheduled time (test / quick match) starts now', () => {
    // scheduled 18:00, first rally at 18:06:40
    expect(defaultSetStartTime({ setIndex: 1, sets: [{ index: 1 }], now: at('2026-10-05T18:06:40Z') }))
      .toBe('2026-10-05T18:06:00.000Z')
  })

  it('a later set starts now even when the interval was ended early (never after its own end)', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:06:00Z' }, { index: 2 }]
    // interval ended after 1 minute: previous end + 3 min would be 18:09, after the set 2 rallies
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:07:10Z') }))
      .toBe('2026-10-05T18:07:00.000Z')
  })

  it('is never before the end of the last set played (device clock behind)', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:20:00Z' }, { index: 2, endTime: '2026-10-05T18:45:30Z' }, { index: 5 }]
    // best-of-3 deciding set (internal index 5) follows set 2, not a missing set 4
    expect(defaultSetStartTime({ setIndex: 5, sets, now: at('2026-10-05T18:44:00Z') }))
      .toBe('2026-10-05T18:45:00.000Z')
    expect(defaultSetStartTime({ setIndex: 5, sets, now: at('2026-10-05T18:49:59Z') }))
      .toBe('2026-10-05T18:49:00.000Z')
  })

  it('ignores later sets and unparseable end times', () => {
    const sets = [{ index: 1, endTime: 'garbage' }, { index: 3, endTime: '2026-10-05T23:00:00Z' }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:30:00Z') }))
      .toBe('2026-10-05T18:30:00.000Z')
  })
})

// Local wall-clock times (the dialog shows and the scheduled time is local)
const local = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s)
const iso = (...a) => local(...a).toISOString()

describe('set 1 start from the schedule (owner 2026-10-08)', () => {
  // the video: scheduled 12.03.2025 12:30, played today
  const scheduledAt = iso(2025, 3, 12, 12, 30)
  const today = local(2026, 10, 8, 12, 41, 37)

  it('proposes the scheduled HH:MM on the day played', () => {
    const proposed = new Date(defaultSetStartTime({ setIndex: 1, sets: [{ index: 1 }], now: today, scheduledAt }))
    expect([proposed.getFullYear(), proposed.getMonth() + 1, proposed.getDate()]).toEqual([2026, 10, 8])
    expect([proposed.getHours(), proposed.getMinutes(), proposed.getSeconds()]).toEqual([12, 30, 0])
  })

  it('never carries the scheduled date (a past schedule does not leak into the start)', () => {
    const proposed = defaultSetStartTime({ setIndex: 1, now: today, scheduledAt })
    expect(proposed.startsWith('2025')).toBe(false)
    expect(Math.abs(Date.parse(proposed) - today.getTime())).toBeLessThan(12 * 3600 * 1000)
    // a match scheduled tomorrow and played today: today as well
    expect(scheduledStartOnDay(iso(2026, 10, 9, 18, 0), local(2026, 10, 8, 17, 50))).toBe(iso(2026, 10, 8, 18, 0))
  })

  it('a late match confirmed after midnight keeps the evening before', () => {
    expect(scheduledStartOnDay(iso(2026, 10, 1, 23, 30), local(2026, 10, 9, 0, 10))).toBe(iso(2026, 10, 8, 23, 30))
  })

  it('proposes now without a scheduled time (or an unparseable one)', () => {
    expect(defaultSetStartTime({ setIndex: 1, now: today, scheduledAt: null })).toBe(iso(2026, 10, 8, 12, 41))
    expect(defaultSetStartTime({ setIndex: 1, now: today, scheduledAt: 'garbage' })).toBe(iso(2026, 10, 8, 12, 41))
    expect(startsFromSchedule({ setIndex: 1, scheduledAt: null })).toBe(false)
    expect(startsFromSchedule({ setIndex: 1, scheduledAt })).toBe(true)
  })

  it('a date without a time (bare date, or the local 00:00 MatchSetup stores) is no scheduled time: now, no remark', () => {
    for (const dateOnly of ['2025-03-12', iso(2025, 3, 12, 0, 0)]) {
      expect(defaultSetStartTime({ setIndex: 1, now: today, scheduledAt: dateOnly })).toBe(iso(2026, 10, 8, 12, 41))
      expect(startsFromSchedule({ setIndex: 1, scheduledAt: dateOnly })).toBe(false)
      expect(actualStartRemark({ setIndex: 1, scheduledAt: dateOnly, startTime: iso(2026, 10, 8, 12, 41) })).toBeNull()
    }
  })

  it('a test match (made-up 20:00 kickoff) has no schedule: set 1 now, no remark', () => {
    const testMatch = { test: true, scheduledAt: iso(2026, 10, 8, 20, 0) }
    expect(startScheduleOf(testMatch)).toBeNull()
    expect(defaultSetStartTime({ setIndex: 1, now: today, scheduledAt: startScheduleOf(testMatch) })).toBe(iso(2026, 10, 8, 12, 41))
    expect(startsFromSchedule({ setIndex: 1, scheduledAt: startScheduleOf(testMatch) })).toBe(false)
    expect(actualStartRemark({ setIndex: 1, scheduledAt: startScheduleOf(testMatch), startTime: iso(2026, 10, 8, 12, 41) })).toBeNull()
    expect(startScheduleOf({ scheduledAt })).toBe(scheduledAt)
    expect(startScheduleOf({ test: false, scheduledAt })).toBe(scheduledAt)
    expect(startScheduleOf(null)).toBeNull()
  })

  it('later sets keep "now, never before the previous end", without a remark', () => {
    const sets = [{ index: 1, endTime: iso(2026, 10, 8, 13, 5) }, { index: 2 }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: local(2026, 10, 8, 13, 8, 20), scheduledAt })).toBe(iso(2026, 10, 8, 13, 8))
    expect(startsFromSchedule({ setIndex: 2, scheduledAt })).toBe(false)
    expect(actualStartRemark({ setIndex: 2, scheduledAt, startTime: iso(2026, 10, 8, 13, 20) })).toBeNull()
    expect(actualStartRemark({ setIndex: 5, scheduledAt, startTime: iso(2026, 10, 8, 14, 0) })).toBeNull()
  })

  it('the scheduled time kept: no remark; another time: "Actual start time: HH:MM"', () => {
    expect(actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 30) })).toBeNull()
    expect(actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 45) })).toBe('Actual start time: 12:45')
    expect(actualStartRemark({ setIndex: 1, scheduledAt: null, startTime: iso(2026, 10, 8, 12, 45) })).toBeNull()
  })

  it('a different time adds exactly one remark line; editing replaces it; back to scheduled removes it', () => {
    const before = 'Ball pressure checked'
    const first = setActualStartRemark(before, actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 45) }))
    expect(first).toBe('Ball pressure checked\nActual start time: 12:45')
    // confirmed again with the same time: unchanged, not duplicated
    expect(setActualStartRemark(first, 'Actual start time: 12:45')).toBe(first)
    const edited = setActualStartRemark(first + '\nSet 1, 12:50, A 3:2, #4 injured (bench)', actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 50) }))
    expect(edited).toBe('Ball pressure checked\nSet 1, 12:50, A 3:2, #4 injured (bench)\nActual start time: 12:50')
    expect(edited.match(/Actual start time/g)).toHaveLength(1)
    const back = setActualStartRemark(edited, actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 30) }))
    expect(back).toBe('Ball pressure checked\nSet 1, 12:50, A 3:2, #4 injured (bench)')
    expect(setActualStartRemark('Actual start time: 12:45', null)).toBe('')
  })

  it('durations on the scoresheet are sane', () => {
    const start = defaultSetStartTime({ setIndex: 1, now: local(2026, 10, 8, 12, 31), scheduledAt })
    const set1 = { index: 1, startTime: start, endTime: iso(2026, 10, 8, 12, 55), finished: true }
    const events = [
      { type: 'set_start', setIndex: 1, seq: 1, ts: start, payload: { startTime: start } },
      { type: 'rally_start', setIndex: 1, seq: 2, ts: iso(2026, 10, 8, 12, 31, 10) }
    ]
    expect(setDurationMinutes(set1, events)).toBe(24)
    const m = matchTimes([set1], events)
    expect(m.durationMinutes).toBe(24)
    // a set start without a rally (older record) still gives a duration of minutes, not years
    expect(setDurationMinutes(set1, [])).toBe(25)
  })
})
