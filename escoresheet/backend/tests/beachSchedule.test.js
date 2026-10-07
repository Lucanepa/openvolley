/**
 * lib/beachSchedule.js: courts x time slots for the brackets of
 * lib/beachBracket.js. Every schedule keeps: one match per court at a time,
 * every match after the matches it waits for plus the rest time, inside the
 * day hours (Europe/Zurich, also across a DST change), fixed matches stay.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { doubleElimination } from '../lib/beachBracket.js'
import { scheduleMatches, zurichToIso, zurichDayMinutes, minutesOf, daysBetween } from '../lib/beachSchedule.js'

const matchesOf = (drawId, n, gameStart = 1) => doubleElimination(n).matches.map((m) => ({
  id: `${drawId}-${m.code}`, draw_id: drawId, code: m.code, game_n: gameStart + m.n - 1, wave: m.wave, source1: m.source1, source2: m.source2
}))
const courts = (k) => Array.from({ length: k }, (_, i) => ({ id: `c${i + 1}`, number: i + 1 }))

/** Checks the rules of a schedule; returns the slots by match id. */
function check ({ matches, draws, slots, dayStart = '09:00', dayEnd = '19:00' }) {
  const byId = new Map(slots.map((s) => [s.id, s]))
  const t = (s) => new Date(s.scheduled_at).getTime()
  // one match per court at a time
  const perCourt = new Map()
  for (const s of slots) perCourt.set(s.court_id, [...(perCourt.get(s.court_id) || []), s])
  for (const list of perCourt.values()) {
    list.sort((a, b) => t(a) - t(b))
    for (let i = 1; i < list.length; i++) {
      assert.ok(t(list[i]) >= t(list[i - 1]) + list[i - 1].duration_min * 60000, `overlap on ${list[i].court_id}`)
    }
  }
  // inside the day hours
  for (const s of slots) {
    const z = zurichDayMinutes(s.scheduled_at)
    assert.ok(z.minutes >= minutesOf(dayStart) && z.minutes + s.duration_min <= minutesOf(dayEnd), `${s.id} at ${s.scheduled_at}`)
  }
  // after the matches it waits for, plus the rest
  for (const m of matches) {
    const s = byId.get(m.id)
    if (!s) continue
    const rest = draws.find((d) => d.id === m.draw_id).rest_minutes
    for (const src of [m.source1, m.source2]) {
      const code = /^(?:winner|loser):(.+)$/.exec(src)?.[1]
      if (!code) continue
      const dep = byId.get(`${m.draw_id}-${code}`)
      assert.ok(dep, `${m.id} waits for ${code}`)
      assert.ok(t(s) >= t(dep) + (dep.duration_min + rest) * 60000, `${m.id} after ${code} + rest`)
    }
  }
  return byId
}

describe('beachSchedule', () => {
  it('Zurich wall clock to UTC, also on the DST days', () => {
    assert.equal(zurichToIso('2026-07-11', 9 * 60), '2026-07-11T07:00:00.000Z')
    assert.equal(zurichToIso('2026-01-10', 9 * 60), '2026-01-10T08:00:00.000Z')
    assert.equal(zurichToIso('2026-03-29', 9 * 60), '2026-03-29T07:00:00.000Z')
    assert.equal(zurichToIso('2026-10-25', 9 * 60), '2026-10-25T08:00:00.000Z')
    assert.deepEqual(zurichDayMinutes('2026-07-11T07:50:00Z'), { day: '2026-07-11', minutes: 9 * 60 + 50 })
    assert.equal(minutesOf('19:00'), 1140)
    assert.equal(minutesOf('19:00:00'), 1140)
    assert.equal(minutesOf('25:00'), null)
    assert.deepEqual(daysBetween('2026-07-11', '2026-07-13'), ['2026-07-11', '2026-07-12', '2026-07-13'])
    assert.throws(() => scheduleMatches({ matches: [], draws: [], courts: [], days: ['2026-07-11'], dayStart: '19:00', dayEnd: '09:00' }), RangeError)
  })

  it('16 teams on 2 courts, 50-minute slots, 20 minutes rest: all 30 matches, the rules kept', () => {
    const matches = matchesOf('d1', 16)
    const draws = [{ id: 'd1', slot_minutes: 50, rest_minutes: 20 }]
    const r = scheduleMatches({ matches, draws, courts: courts(2), days: ['2026-07-11', '2026-07-12'] })
    assert.equal(r.unplaced.length, 0)
    assert.equal(r.slots.length, 30)
    const by = check({ matches, draws, slots: r.slots })
    // the first round opens both courts at 09:00
    assert.equal(by.get('d1-W1').scheduled_at, '2026-07-11T07:00:00.000Z')
    assert.equal(by.get('d1-W2').scheduled_at, '2026-07-11T07:00:00.000Z')
    assert.notEqual(by.get('d1-W1').court_id, by.get('d1-W2').court_id)
    // the final is the last match
    const last = [...r.slots].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).pop()
    assert.equal(last.id, 'd1-F')
  })

  it('two draws share the courts; one day only: what does not fit is unplaced, its dependents too', () => {
    const matches = [...matchesOf('men', 12), ...matchesOf('women', 8, 23)]
    const draws = [{ id: 'men', slot_minutes: 50, rest_minutes: 0 }, { id: 'women', slot_minutes: 40, rest_minutes: 10 }]
    const r = scheduleMatches({ matches, draws, courts: courts(3), days: ['2026-07-11'], dayStart: '09:00', dayEnd: '18:00' })
    check({ matches, draws, slots: r.slots, dayEnd: '18:00' })
    assert.equal(r.slots.length + r.unplaced.length, matches.length)
    // the first draw's first round takes the three courts at 09:00, the second draw follows at 09:50
    const first = (d) => r.slots.filter((s) => s.id.startsWith(`${d}-`)).map((s) => s.scheduled_at).sort()[0]
    assert.equal(first('men'), '2026-07-11T07:00:00.000Z')
    assert.equal(first('women'), '2026-07-11T07:50:00.000Z')
    const tight = scheduleMatches({ matches, draws, courts: courts(1), days: ['2026-07-11'], dayStart: '09:00', dayEnd: '13:00' })
    assert.ok(tight.unplaced.includes('men-F') && tight.unplaced.includes('women-F'))
    check({ matches, draws, slots: tight.slots, dayEnd: '13:00' })
  })

  it('fixed matches keep their slot and block the court; their dependents wait for them', () => {
    const matches = matchesOf('d', 8)
    matches[0].fixed = { court_id: 'c1', scheduled_at: '2026-07-11T07:00:00Z', duration_min: 90 } // W1 ran long
    matches[1].fixed = { court_id: null, scheduled_at: null } // W2: a walkover without a slot
    const draws = [{ id: 'd', slot_minutes: 45, rest_minutes: 0 }]
    const r = scheduleMatches({ matches, draws, courts: courts(1), days: ['2026-07-11'] })
    const by = new Map(r.slots.map((s) => [s.id, s]))
    assert.equal(by.has('d-W1'), false)
    // the court is busy until 10:30 local
    assert.equal(by.get('d-W3').scheduled_at, '2026-07-11T08:30:00.000Z')
    assert.ok(new Date(by.get('d-W5').scheduled_at) >= new Date('2026-07-11T08:30:00Z'))
  })

  it('more than 18 matches on a court in a day is a warning', () => {
    const matches = matchesOf('d', 16)
    const r = scheduleMatches({ matches, draws: [{ id: 'd', slot_minutes: 20, rest_minutes: 0 }], courts: courts(1), days: ['2026-07-11'], dayStart: '08:00', dayEnd: '20:00' })
    assert.equal(r.unplaced.length, 0)
    assert.deepEqual(r.warnings, [{ code: 'court_day_limit', court: 1, day: '2026-07-11', matches: 30 }])
  })
})
