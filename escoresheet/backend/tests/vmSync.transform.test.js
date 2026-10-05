import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  transformGame, prepareRows, isExcludedLeague, resolveWindow, zonedTimeToUtc, zonedYmd,
  parseVmDateTime, formatZurichDateTime, normalizeDob, addDaysYmd, isYmd, nextRunAt, buildSearchBody,
  windowFromEnv, MAX_WINDOW_DAYS
} from '../lib/vmSync.js'
import { makeGame } from './helpers/fakeVolleyManager.js'

const SYNCED = new Date('2026-10-05T04:00:00Z')
const t = (item) => transformGame(item, { syncedAt: SYNCED })

describe('transformGame: kick-off in Europe/Zurich', () => {
  it('formats a summer game (CEST, +2 h)', () => {
    const r = t(makeGame(1, { startingDateTime: '2026-10-10T16:00:00.000Z' }))
    assert.equal(r.date, '10/10/2026')
    assert.equal(r.time, '18:00')
    assert.equal(r.datetime, '2026-10-10T16:00:00.000Z', 'raw datetime is kept for the frontend')
  })

  it('formats a winter game (CET, +1 h)', () => {
    const r = t(makeGame(2, { startingDateTime: '2026-01-17T19:30:00.000Z' }))
    assert.equal(r.date, '17/01/2026')
    assert.equal(r.time, '20:30')
  })

  it('DST start 2026-03-29: 18:00Z is 20:00 CEST', () => {
    const r = t(makeGame(3, { startingDateTime: '2026-03-29T18:00:00Z' }))
    assert.equal(r.date, '29/03/2026')
    assert.equal(r.time, '20:00')
  })

  it('DST end 2026-10-25: 18:00Z is 19:00 CET', () => {
    const r = t(makeGame(4, { startingDateTime: '2026-10-25T18:00:00Z' }))
    assert.equal(r.date, '25/10/2026')
    assert.equal(r.time, '19:00')
  })

  it('both sides of the switch nights', () => {
    // 00:59Z before the March switch = 01:59 CET; 01:00Z = 03:00 CEST
    assert.equal(t(makeGame(5, { startingDateTime: '2026-03-29T00:59:00Z' })).time, '01:59')
    assert.equal(t(makeGame(6, { startingDateTime: '2026-03-29T01:00:00Z' })).time, '03:00')
    // 00:30Z on 25 Oct = 02:30 CEST; 01:30Z = 02:30 CET (the repeated hour)
    assert.equal(t(makeGame(7, { startingDateTime: '2026-10-25T00:30:00Z' })).time, '02:30')
    assert.equal(t(makeGame(8, { startingDateTime: '2026-10-25T01:30:00Z' })).time, '02:30')
  })

  it('a late game moves to the next Zurich day (UTC formatting kept the previous day)', () => {
    const r = t(makeGame(9, { startingDateTime: '2026-06-30T22:15:00Z' }))
    assert.equal(r.date, '01/07/2026')
    assert.equal(r.time, '00:15')
  })

  it('accepts an explicit offset and reads an offset-less string as UTC', () => {
    assert.equal(t(makeGame(10, { startingDateTime: '2026-10-10T18:00:00+02:00' })).time, '18:00')
    assert.equal(t(makeGame(11, { startingDateTime: '2026-10-10T16:00:00' })).time, '18:00')
  })

  it('leaves date/time empty for a missing or unparsable datetime (no NaN)', () => {
    for (const startingDateTime of ['', 'not a date', null]) {
      const r = t(makeGame(12, { startingDateTime }))
      assert.equal(r.date, '')
      assert.equal(r.time, '')
    }
  })
})

describe('transformGame: other fields', () => {
  it('maps the row like the Edge Function did', () => {
    const r = t(makeGame(123456))
    assert.equal(r.game_number, '123456')
    assert.equal(r.league, '3L B')
    assert.equal(r.gender, 'women')
    assert.equal(r.match_level, 'senior')
    assert.equal(r.match_type, 'championship')
    assert.equal(r.championship_type, 'regional')
    assert.equal(r.match_format, 5)
    assert.equal(r.team_home, 'Home 123456')
    assert.equal(r.city, 'Zürich')
    assert.equal(r.hall, 'Halle Wiedikon')
    assert.equal(r.hall_postal_code, '8003')
    assert.equal(r.referee_1, 'Muster Anna')
    assert.equal(r.referee_1_first_name, 'Anna')
    assert.equal(r.referee_1_last_name, 'Muster')
    assert.equal(r.referee_1_dob, '1990-02-24')
    assert.equal(r.referee_2, 'Beispiel Ben', 'falls back to activeSecondHeadRefereeName')
    assert.equal(r.referee_2_dob, null)
    assert.equal(r.linesman_1, 'Linie Lea')
    assert.equal(r.linesman_2, '')
    assert.equal(r.is_supervised, true)
    assert.equal(r.has_supervised_referee, false)
    assert.deepEqual(r.convocations, ['Muster Anna'])
    assert.equal(r.synced_at, SYNCED.toISOString())
  })

  it('classifies 1L senior as national, junior and cup leagues', () => {
    assert.equal(t(makeGame(1, { leagueName: '1. Liga', shortName: '1L' })).championship_type, 'national')
    const u = t(makeGame(2, { leagueName: 'U18 Juniorinnen', shortName: 'U18' }))
    assert.equal(u.match_level, 'junior')
    assert.equal(u.championship_type, 'regional')
    assert.equal(t(makeGame(3, { leagueName: 'Züri Cup', shortName: 'ZC' })).match_type, 'cup')
    assert.equal(t(makeGame(4, { groupDisplay: '#27051 | D', shortName: '1L' })).league, '1L D')
    assert.equal(t(makeGame(5, { gender: 'm' })).gender, 'men')
  })

  it('normalises birthdays for the date column', () => {
    assert.equal(normalizeDob('1990-02-24'), '1990-02-24')
    assert.equal(normalizeDob('1990-02-24T00:00:00+01:00'), '1990-02-24')
    assert.equal(normalizeDob('05.03.1990'), '1990-03-05', 'dd.mm.yyyy is day first')
    assert.equal(normalizeDob('1990-02-30'), null)
    assert.equal(normalizeDob(''), null)
    assert.equal(normalizeDob(null), null)
    assert.equal(t(makeGame(1, { dob1: '31.12.1985' })).referee_1_dob, '1985-12-31')
  })

  it('survives a malformed item', () => {
    assert.equal(transformGame(null).game_number, '')
    assert.equal(transformGame({ game: { number: 7 } }).game_number, '7')
  })
})

describe('NL exclusion and row preparation', () => {
  it('excludes NL leagues (substring, like the Edge Function)', () => {
    for (const l of ['NLA', 'NLB', 'nl', 'Nationalliga A', 'NLA Damen']) assert.equal(isExcludedLeague(l), true, l)
    for (const l of ['1L D', '3L B', 'U18', 'ZC', '']) assert.equal(isExcludedLeague(l), false, l)
  })

  it('drops NL games and games without a number, merges duplicate numbers', () => {
    const items = [
      makeGame(1),
      makeGame(2, { shortName: 'NLA', groupDisplay: '' }),
      makeGame(3, { shortName: 'NLB' }),
      { game: { startingDateTime: '2026-10-10T16:00:00Z' } }, // no number
      makeGame(1, { home: 'Later wins' })
    ]
    const { rows, transformed, excluded, duplicates } = prepareRows(items, { syncedAt: SYNCED })
    assert.equal(transformed, 4)
    assert.equal(excluded, 2)
    assert.equal(duplicates, 1)
    assert.deepEqual(rows.map((r) => r.game_number), ['1'])
    assert.equal(rows[0].team_home, 'Later wins')
  })
})

describe('Zurich calendar window', () => {
  it('"today" is the Zurich day, not the UTC day', () => {
    // 23:30Z on 5 Oct is already 6 Oct in Zurich
    const w = resolveWindow({ daysBack: 0, daysAhead: 0 }, { now: new Date('2026-10-05T23:30:00Z') })
    assert.equal(w.fromDay, '2026-10-06')
    assert.equal(w.dateFrom, '2026-10-05T22:00:00.000Z')
    assert.equal(w.dateTo, '2026-10-06T21:59:59.000Z')
  })

  it('defaults to today -1 .. today +14', () => {
    const w = resolveWindow(undefined, { now: new Date('2026-10-05T10:00:00Z') })
    assert.equal(w.fromDay, '2026-10-04')
    assert.equal(w.toDay, '2026-10-19')
    assert.equal(w.days, 16)
  })

  it('a window across DST end starts at CEST midnight and ends at CET midnight', () => {
    const w = resolveWindow({ from: '2026-10-24', to: '2026-10-25' })
    assert.equal(w.dateFrom, '2026-10-23T22:00:00.000Z')
    assert.equal(w.dateTo, '2026-10-25T22:59:59.000Z')
  })

  it('a single --date across DST start', () => {
    const w = resolveWindow({ date: '2026-03-29' })
    assert.equal(w.dateFrom, '2026-03-28T23:00:00.000Z')
    assert.equal(w.dateTo, '2026-03-29T21:59:59.000Z')
  })

  it('rejects bad windows', () => {
    assert.throws(() => resolveWindow({ from: '2026-10-10', to: '2026-10-01' }), /after/)
    assert.throws(() => resolveWindow({ from: '2026-10-10' }), /both/)
    assert.throws(() => resolveWindow({ date: '2026-02-30' }), /YYYY-MM-DD/)
    assert.throws(() => resolveWindow({ daysBack: -1 }), /non-negative/)
    assert.throws(() => resolveWindow({ daysAhead: MAX_WINDOW_DAYS }), /max/)
  })

  it('date helpers', () => {
    assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01')
    assert.equal(addDaysYmd('2028-03-01', -1), '2028-02-29')
    assert.equal(isYmd('2026-02-29'), false)
    assert.equal(zonedYmd(new Date('2026-12-31T23:00:00Z')), '2027-01-01')
    assert.equal(zonedTimeToUtc('2026-03-29', 2, 30).toISOString(), '2026-03-29T01:30:00.000Z', 'skipped hour maps one hour later')
    assert.equal(zonedTimeToUtc('2026-10-25', 2, 30).toISOString(), '2026-10-25T00:30:00.000Z', 'repeated hour maps to the first one')
    assert.equal(parseVmDateTime('garbage'), null)
    assert.deepEqual(formatZurichDateTime(new Date('2026-07-01T05:05:00Z')), { date: '01/07/2026', time: '07:05' })
  })

  it('window from env', () => {
    assert.deepEqual(windowFromEnv({ VM_SYNC_DAYS_BACK: '2', VM_SYNC_DAYS_AHEAD: '30' }), { daysBack: 2, daysAhead: 30 })
    assert.deepEqual(windowFromEnv({}), {})
    assert.throws(() => windowFromEnv({ VM_SYNC_DAYS_AHEAD: '-3' }), /non-negative/)
  })

  it('search body carries the Zurich-aligned range and the CSRF token', () => {
    const w = resolveWindow({ date: '2026-10-10' })
    const p = new URLSearchParams(buildSearchBody('tok', 200, 200, w.dateFrom, w.dateTo))
    assert.equal(p.get('searchConfiguration[propertyFilters][0][dateRange][from]'), '2026-10-09T22:00:00.000Z')
    assert.equal(p.get('searchConfiguration[propertyFilters][0][dateRange][to]'), '2026-10-10T21:59:59.000Z')
    assert.equal(p.get('searchConfiguration[offset]'), '200')
    assert.equal(p.get('__csrfToken'), 'tok')
  })
})

describe('nextRunAt (06:00 Europe/Zurich)', () => {
  it('later today or tomorrow, in local time across DST', () => {
    assert.equal(nextRunAt(new Date('2026-10-05T03:00:00Z')).toISOString(), '2026-10-05T04:00:00.000Z')
    assert.equal(nextRunAt(new Date('2026-10-05T04:00:00Z')).toISOString(), '2026-10-06T04:00:00.000Z')
    assert.equal(nextRunAt(new Date('2026-10-24T12:00:00Z')).toISOString(), '2026-10-25T05:00:00.000Z', 'CET after the switch')
    assert.equal(nextRunAt(new Date('2026-03-28T12:00:00Z')).toISOString(), '2026-03-29T04:00:00.000Z', 'CEST after the switch')
  })
})
