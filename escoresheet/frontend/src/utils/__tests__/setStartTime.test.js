import { describe, it, expect, afterEach } from 'vitest'
import { defaultSetStartTime, scheduledStartOnDay, actualStartRemark, startsFromSchedule, startScheduleOf, typedStartNear } from '../setStartTime'
import { setActualStartRemark, actualStartReason, actualStartLines, remarkClock } from '../../domain/remarks'
import { getNextTestMatchStartTime } from '../../constants/testSeeds'
import { setDurationMinutes, matchTimes } from '../../../scoresheet_pdf/utils/matchTimes'

const at = (iso) => new Date(iso)

describe('defaultSetStartTime (owner 2026-11-15)', () => {
  it('set 1 without a scheduled time (test / quick match) starts now', () => {
    expect(defaultSetStartTime({ setIndex: 1, sets: [{ index: 1 }], now: at('2026-10-05T18:06:40Z') }))
      .toBe('2026-10-05T18:06:00.000Z')
  })

  it('set 2 is the end of set 1 + 3 minutes, whatever the clock says now', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:34:50Z' }, { index: 2 }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:36:00Z') })).toBe('2026-10-05T18:37:00.000Z')
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:41:30Z') })).toBe('2026-10-05T18:37:00.000Z')
  })

  it('the deciding set (index 5) follows the last set played + 3', () => {
    const sets = [{ index: 1, endTime: '2026-10-05T18:20:00Z' }, { index: 2, endTime: '2026-10-05T18:45:30Z' }, { index: 5 }]
    expect(defaultSetStartTime({ setIndex: 5, sets, now: at('2026-10-05T18:44:00Z') })).toBe('2026-10-05T18:48:00.000Z')
  })

  it('ignores later sets and unparseable end times (falls back to now)', () => {
    const sets = [{ index: 1, endTime: 'garbage' }, { index: 3, endTime: '2026-10-05T23:00:00Z' }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: at('2026-10-05T18:30:00Z') })).toBe('2026-10-05T18:30:00.000Z')
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

  it('a test match proposes its scheduled time too, however far from now (owner 2026-11-17)', () => {
    const testMatch = { test: true, scheduledAt: iso(2026, 10, 8, 20, 0) }
    expect(startScheduleOf(testMatch)).toBe(testMatch.scheduledAt)
    expect(defaultSetStartTime({ setIndex: 1, now: today, scheduledAt: startScheduleOf(testMatch) })).toBe(iso(2026, 10, 8, 20, 0))
    expect(startsFromSchedule({ setIndex: 1, scheduledAt: startScheduleOf(testMatch) })).toBe(true)
    expect(actualStartRemark({ setIndex: 1, scheduledAt: startScheduleOf(testMatch), startTime: iso(2026, 10, 8, 12, 41), reason: 'Rehearsal' }))
      .toBe('Actual game start: 12:41 (Rehearsal)')
    // near now as well (owner 2026-11-15: 14:00 scheduled, first rally 14:06: 14:00)
    const near = { test: true, scheduledAt: iso(2026, 11, 15, 14, 0) }
    expect(defaultSetStartTime({ setIndex: 1, now: local(2026, 11, 15, 14, 6, 30), scheduledAt: startScheduleOf(near) })).toBe(iso(2026, 11, 15, 14, 0))
    expect(startScheduleOf({ scheduledAt })).toBe(scheduledAt)
    expect(startScheduleOf({ test: false, scheduledAt })).toBe(scheduledAt)
    expect(startScheduleOf(null)).toBeNull()
    expect(startScheduleOf({ test: true, scheduledAt: null })).toBeNull()
  })

  it('an Easy match has no schedule (its scheduledAt is its creation time): set 1 now', () => {
    const now = local(2026, 11, 15, 13, 50, 10)
    const easy = { test: true, easy: true, scheduledAt: local(2026, 11, 15, 13, 41, 23).toISOString() }
    expect(startScheduleOf(easy)).toBeNull()
    expect(defaultSetStartTime({ setIndex: 1, now, scheduledAt: startScheduleOf(easy) })).toBe(iso(2026, 11, 15, 13, 50))
  })

  it('later sets are proposed as previous end + 3 min, without a remark', () => {
    const sets = [{ index: 1, endTime: iso(2026, 10, 8, 13, 5) }, { index: 2 }]
    expect(defaultSetStartTime({ setIndex: 2, sets, now: local(2026, 10, 8, 13, 9, 20), scheduledAt })).toBe(iso(2026, 10, 8, 13, 8))
    expect(startsFromSchedule({ setIndex: 2, scheduledAt })).toBe(false)
    expect(actualStartRemark({ setIndex: 2, scheduledAt, startTime: iso(2026, 10, 8, 13, 20) })).toBeNull()
    expect(actualStartRemark({ setIndex: 5, scheduledAt, startTime: iso(2026, 10, 8, 14, 0) })).toBeNull()
  })

  it('the scheduled time kept: no remark; another time: "Actual game start: HH:MM"', () => {
    expect(actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 30) })).toBeNull()
    expect(actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 45) })).toBe('Actual game start: 12:45')
    expect(actualStartRemark({ setIndex: 1, scheduledAt: null, startTime: iso(2026, 10, 8, 12, 45) })).toBeNull()
  })

  it('a different time adds exactly one remark line; editing replaces it; back to scheduled removes it', () => {
    const before = 'Ball pressure checked'
    const first = setActualStartRemark(before, actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 45) }))
    expect(first).toBe('Ball pressure checked\nActual game start: 12:45')
    // confirmed again with the same time: unchanged, not duplicated
    expect(setActualStartRemark(first, 'Actual game start: 12:45')).toBe(first)
    const edited = setActualStartRemark(first + '\nSet 1, 12:50, A 3:2, #4 injured (bench)', actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 50) }))
    expect(edited).toBe('Ball pressure checked\nSet 1, 12:50, A 3:2, #4 injured (bench)\nActual game start: 12:50')
    expect(edited.match(/Actual game start/g)).toHaveLength(1)
    const back = setActualStartRemark(edited, actualStartRemark({ setIndex: 1, scheduledAt, startTime: iso(2026, 10, 8, 12, 30) }))
    expect(back).toBe('Ball pressure checked\nSet 1, 12:50, A 3:2, #4 injured (bench)')
    expect(setActualStartRemark('Actual game start: 12:45', null)).toBe('')
  })

  it('durations on the scoresheet are sane', () => {
    const start = defaultSetStartTime({ setIndex: 1, now: local(2026, 10, 8, 12, 31), scheduledAt })
    const set1 = { index: 1, startTime: start, endTime: iso(2026, 10, 8, 12, 55), finished: true }
    const events = [
      { type: 'set_start', setIndex: 1, seq: 1, ts: start, payload: { startTime: start } },
      { type: 'rally_start', setIndex: 1, seq: 2, ts: iso(2026, 10, 8, 12, 31, 10) }
    ]
    expect(setDurationMinutes(set1, events)).toBe(25)
    const m = matchTimes([set1], events)
    expect(m.durationMinutes).toBe(25)
    // a set start without a rally (older record) still gives a duration of minutes, not years
    expect(setDurationMinutes(set1, [])).toBe(25)
  })
})

describe('the confirmed start wins on the sheet (owner 2026-11-15)', () => {
  it('dialog time 15:15 with a first rally at 15:14 prints 15:15 and the duration from it', () => {
    const confirmed = '2026-11-15T14:15:00.000Z'
    const set1 = { index: 1, startTime: confirmed, endTime: '2026-11-15T14:34:00.000Z', finished: true }
    const events = [
      { type: 'set_start', setIndex: 1, seq: 1, ts: confirmed, payload: { startTime: confirmed, firstRallyAt: '2026-11-15T14:14:40.000Z' } },
      { type: 'rally_start', setIndex: 1, seq: 2, ts: '2026-11-15T14:14:40.000Z' }
    ]
    expect(setDurationMinutes(set1, events)).toBe(19)
    expect(matchTimes([set1], events).startMs).toBe(Date.parse(confirmed))
  })
})

describe('the old remark wording is still replaced', () => {
  it('"Actual start time: 12:45" is swapped for "Actual game start: 12:45" lines', () => {
    expect(setActualStartRemark('Actual start time: 12:45', 'Actual game start: 12:50')).toBe('Actual game start: 12:50')
  })
})

describe('the typed start time is on the day nearest to the proposal (typedStartNear)', () => {
  it('a 23:30 match confirmed at 00:10: kept 23:30 is the evening before, a typed 00:12 is today', () => {
    const proposed = defaultSetStartTime({ setIndex: 1, now: local(2026, 10, 9, 0, 10), scheduledAt: iso(2026, 10, 1, 23, 30) })
    expect(proposed).toBe(iso(2026, 10, 8, 23, 30))
    expect(typedStartNear(proposed, '23:30')).toBe(iso(2026, 10, 8, 23, 30))
    // the proposal's date would give 08.10 00:12, a set 1 of over 24 hours
    expect(typedStartNear(proposed, '00:12')).toBe(iso(2026, 10, 9, 0, 12))
  })

  it('a 20:00 match played the next morning: a typed 07:05 is the morning, not the day before', () => {
    const proposed = defaultSetStartTime({ setIndex: 1, now: local(2026, 10, 9, 7, 3), scheduledAt: iso(2026, 10, 8, 20, 0) })
    expect(typedStartNear(proposed, '07:05')).toBe(iso(2026, 10, 9, 7, 5))
  })

  it('the same day otherwise; invalid input is null', () => {
    const proposed = iso(2026, 10, 8, 12, 30)
    expect(typedStartNear(proposed, '12:45')).toBe(iso(2026, 10, 8, 12, 45))
    expect(typedStartNear(proposed, '9:05')).toBe(iso(2026, 10, 8, 9, 5))
    expect(typedStartNear(proposed, '')).toBeNull()
    expect(typedStartNear(proposed, '25:00')).toBeNull()
  })
})

// Stress test 2026-10-25 (device-timezone-shifts-official-times): the proposal
// and the typed start are Zürich clock times, whatever zone the device is in
describe('set 1 start on a device outside Europe/Zurich', () => {
  const deviceTz = process.env.TZ
  afterEach(() => {
    if (deviceTz === undefined) delete process.env.TZ
    else process.env.TZ = deviceTz
  })

  it('the scheduled kick-off on the day played is its Zürich time of day', () => {
    process.env.TZ = 'UTC'
    // scheduled 10:20 summer time a week ago, played today in winter time
    expect(scheduledStartOnDay('2026-10-19T08:20:00.000Z', new Date('2026-10-26T09:05:00.000Z'))).toBe('2026-10-26T09:20:00.000Z')
    // a date entered without a time is Zürich midnight: no scheduled time
    process.env.TZ = 'Etc/GMT-2'
    expect(scheduledStartOnDay('2026-10-25T23:00:00.000Z', new Date('2026-10-26T09:05:00.000Z'))).toBe(null)
    // 23:30 Zürich confirmed at 00:10 Zürich: the day before
    expect(scheduledStartOnDay('2026-10-19T21:30:00.000Z', new Date('2026-10-26T23:10:00.000Z'))).toBe('2026-10-26T22:30:00.000Z')
  })

  it('a typed start is a Zürich time on the day nearest to the proposal', () => {
    process.env.TZ = 'Etc/GMT-2'
    expect(typedStartNear('2026-10-26T09:20:00.000Z', '10:23')).toBe('2026-10-26T09:23:00.000Z')
    // proposed 23:50, typed 00:05: the next day
    expect(typedStartNear('2026-10-26T22:50:00.000Z', '00:05')).toBe('2026-10-26T23:05:00.000Z')
    process.env.TZ = 'America/New_York'
    expect(typedStartNear('2026-10-26T09:20:00.000Z', '10:23')).toBe('2026-10-26T09:23:00.000Z')
  })

  it('the "Actual game start" remark is a Zürich time', () => {
    process.env.TZ = 'UTC'
    expect(actualStartRemark({ setIndex: 1, scheduledAt: '2026-10-26T09:20:00.000Z', startTime: '2026-10-26T09:33:00.000Z' }))
      .toBe('Actual game start: 10:33')
  })
})

// Owner 2026-11-17 ("super important"): a test match scheduled 21:00 was
// started at 16:21 on a board whose system zone was Europe/London (header
// clock 15:21); the dialog proposed 16:21. Set 1 must ALWAYS be proposed at
// the scheduled time, on the hall's clock, whatever the device zone.
describe('set 1 is always proposed at the scheduled time (owner 2026-11-17)', () => {
  const deviceTz = process.env.TZ
  afterEach(() => {
    if (deviceTz === undefined) delete process.env.TZ
    else process.env.TZ = deviceTz
  })
  // 17.11.2026 is winter time: Zürich = UTC+1
  const scheduled21 = '2026-11-17T20:00:00.000Z' // 21:00 Zürich
  const now1621 = new Date('2026-11-17T15:21:00.000Z') // 16:21 Zürich, 15:21 London
  const zurichClock = (isoString) => remarkClock(new Date(isoString))

  it.each(['Europe/London', 'Europe/Zurich', 'UTC', 'America/New_York'])('scheduled 21:00, now 16:21, device zone %s: 21:00', (tz) => {
    process.env.TZ = tz
    for (const match of [{ test: true, scheduledAt: scheduled21 }, { scheduledAt: scheduled21 }]) {
      const scheduledAt = startScheduleOf(match)
      const proposed = defaultSetStartTime({ setIndex: 1, sets: [{ index: 1 }], now: now1621, scheduledAt })
      expect(proposed).toBe(scheduled21)
      expect(zurichClock(proposed)).toBe('21:00')
      expect(startsFromSchedule({ setIndex: 1, scheduledAt })).toBe(true)
      // kept: no remark
      expect(actualStartRemark({ setIndex: 1, scheduledAt, startTime: proposed })).toBeNull()
    }
  })

  it('scheduled earlier than now: the scheduled time, not now', () => {
    const scheduledAt = '2026-11-17T13:00:00.000Z' // 14:00 Zürich
    expect(defaultSetStartTime({ setIndex: 1, now: now1621, scheduledAt })).toBe(scheduledAt)
  })

  it('scheduled tomorrow or yesterday: the scheduled time of day, today', () => {
    expect(defaultSetStartTime({ setIndex: 1, now: now1621, scheduledAt: '2026-11-18T20:00:00.000Z' })).toBe(scheduled21)
    expect(defaultSetStartTime({ setIndex: 1, now: now1621, scheduledAt: '2026-11-16T20:00:00.000Z' })).toBe(scheduled21)
    // a past season's date: the time of day, never the date
    expect(defaultSetStartTime({ setIndex: 1, now: now1621, scheduledAt: '2025-03-12T20:00:00.000Z' })).toBe(scheduled21)
  })

  it('a 23:30 match started after midnight: 23:30 of the evening before', () => {
    const proposed = defaultSetStartTime({ setIndex: 1, now: new Date('2026-11-17T23:05:00.000Z'), scheduledAt: '2026-11-17T22:30:00.000Z' })
    expect(proposed).toBe('2026-11-17T22:30:00.000Z')
    expect(zurichClock(proposed)).toBe('23:30')
  })

  it('no scheduled time at all: now (the dialog says so)', () => {
    process.env.TZ = 'Europe/London'
    for (const scheduledAt of [null, undefined, '', 'garbage', '2026-11-17']) {
      expect(defaultSetStartTime({ setIndex: 1, now: now1621, scheduledAt })).toBe('2026-11-17T15:21:00.000Z')
      expect(startsFromSchedule({ setIndex: 1, scheduledAt })).toBe(false)
    }
    // an Easy match has none either
    expect(startScheduleOf({ easy: true, scheduledAt: scheduled21 })).toBeNull()
  })

  it('a changed time writes "Actual game start: HH:MM (reason)", in Zürich time', () => {
    process.env.TZ = 'Europe/London'
    const started = typedStartNear(scheduled21, '16:21')
    expect(started).toBe('2026-11-17T15:21:00.000Z')
    const line = actualStartRemark({ setIndex: 1, scheduledAt: scheduled21, startTime: started, reason: '  Test match,\nstarted early ' })
    expect(line).toBe('Actual game start: 16:21 (Test match, started early)')
    const remarks = setActualStartRemark('Ball pressure checked', line)
    expect(remarks).toBe('Ball pressure checked\nActual game start: 16:21 (Test match, started early)')
    // confirmed again with another time and reason: one line, replaced
    const again = setActualStartRemark(remarks, actualStartRemark({ setIndex: 1, scheduledAt: scheduled21, startTime: '2026-11-17T15:30:00.000Z', reason: 'Bus late' }))
    expect(again).toBe('Ball pressure checked\nActual game start: 16:30 (Bus late)')
    // back to the scheduled time: removed
    expect(setActualStartRemark(again, actualStartRemark({ setIndex: 1, scheduledAt: scheduled21, startTime: scheduled21 }))).toBe('Ball pressure checked')
    expect(actualStartReason('Actual game start: 16:30 (Bus late (again))')).toBe('Bus late (again)')
    expect(actualStartReason('Actual game start: 16:30')).toBe('')
    // older lines are still found
    expect(actualStartLines('Actual start time: 16:20\nActual game start: 16:25\nOther')).toHaveLength(2)
  })

  it('sets 2-5: the previous set\'s end + 3 minutes, also across midnight', () => {
    const sets = [
      { index: 1, endTime: '2026-11-17T20:31:20.000Z' },
      { index: 2, endTime: '2026-11-17T21:00:00.000Z' },
      { index: 3, endTime: '2026-11-17T22:58:10.000Z' }, // 23:58 Zürich
      { index: 4, endTime: null }
    ]
    process.env.TZ = 'Europe/London'
    expect(defaultSetStartTime({ setIndex: 2, sets: sets.slice(0, 1), now: new Date('2026-11-17T20:40:00.000Z'), scheduledAt: scheduled21 })).toBe('2026-11-17T20:34:00.000Z')
    expect(defaultSetStartTime({ setIndex: 3, sets: sets.slice(0, 2), now: new Date('2026-11-17T21:01:00.000Z'), scheduledAt: scheduled21 })).toBe('2026-11-17T21:03:00.000Z')
    const set4 = defaultSetStartTime({ setIndex: 4, sets, now: new Date('2026-11-17T23:05:00.000Z'), scheduledAt: scheduled21 })
    expect(set4).toBe('2026-11-17T23:01:00.000Z')
    expect(zurichClock(set4)).toBe('00:01') // the next day on the hall's clock
    expect(startsFromSchedule({ setIndex: 4, scheduledAt: scheduled21 })).toBe(false)
    expect(actualStartRemark({ setIndex: 4, scheduledAt: scheduled21, startTime: set4, reason: 'x' })).toBeNull()
    // a typed 00:02 under the 00:01 proposal stays after midnight
    expect(typedStartNear(set4, '00:02')).toBe('2026-11-17T23:02:00.000Z')
    expect(typedStartNear(set4, '23:59')).toBe('2026-11-17T22:59:00.000Z')
  })

  it('the confirmed start is what the sheet prints', () => {
    const confirmed = '2026-11-17T15:21:00.000Z'
    const set1 = { index: 1, startTime: confirmed, endTime: '2026-11-17T15:45:00.000Z', finished: true }
    const events = [
      { type: 'set_start', setIndex: 1, seq: 1, ts: confirmed, payload: { startTime: confirmed, firstRallyAt: '2026-11-17T15:21:40.000Z' } },
      { type: 'rally_start', setIndex: 1, seq: 2, ts: '2026-11-17T15:21:40.000Z' }
    ]
    expect(matchTimes([set1], events).startMs).toBe(Date.parse(confirmed))
    expect(setDurationMinutes(set1, events)).toBe(24)
  })
})

describe('a test match is seeded at 20:00 on the hall\'s clock (owner 2026-11-17)', () => {
  const deviceTz = process.env.TZ
  afterEach(() => {
    if (deviceTz === undefined) delete process.env.TZ
    else process.env.TZ = deviceTz
  })
  it.each(['Europe/London', 'Europe/Zurich', 'America/New_York'])('device zone %s', (tz) => {
    process.env.TZ = tz
    expect(getNextTestMatchStartTime(new Date('2026-11-17T15:21:00.000Z'))).toBe('2026-11-17T19:00:00.000Z')
    // after 20:00 Zürich: tomorrow 20:00
    expect(getNextTestMatchStartTime(new Date('2026-11-17T19:30:00.000Z'))).toBe('2026-11-18T19:00:00.000Z')
  })
})
