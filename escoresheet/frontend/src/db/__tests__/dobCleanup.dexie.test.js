// The device's one-time clean-up of dates of birth (db/dobCleanup, owner
// 2026-11-19), against the real app database (Dexie 4 on fake-indexeddb).
// Made-up names (VBC Musterdorf).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { DOB_CLEANUP_KEY, matchChanges, matchInProgress, runDobCleanup, withoutDate, withoutDob, draftDataWithoutDates } from '../dobCleanup'

function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)) },
    removeItem: (k) => { data.delete(k) },
    data
  }
}

async function matchWith(over = {}, players = []) {
  const homeTeamId = await db.teams.add({ name: 'VBC Musterdorf', benchOfficials: [{ role: 'Coach', lastName: 'Trainer', dob: '01.02.1970' }], createdAt: '2026-11-01T10:00:00Z' })
  const awayTeamId = await db.teams.add({ name: 'Volley Beispiel', createdAt: '2026-11-01T10:00:00Z' })
  const id = await db.matches.add({
    homeTeamId,
    awayTeamId,
    status: 'final',
    test: false,
    bench_home: [{ role: 'Coach', firstName: 'Tom', lastName: 'Trainer', dob: '01.02.1970' }, { role: 'Medic', firstName: 'Mia', lastName: 'Muster', dob: '654321' }],
    bench_away: [],
    officials: [
      { role: '1st referee', firstName: 'Rita', lastName: 'Pfiff', dob: '1979-09-02' },
      { role: 'scorer', firstName: 'Sam', lastName: 'Schreiber', dob: '01.01.1900', licence: '7654' }
    ],
    pendingAwayRoster: { players: [{ number: 3, lastName: 'Gast', dob: '14/03/2008' }], bench: [] },
    ...over
  })
  await db.players.bulkAdd(players.map(([number, dob]) => ({ teamId: homeTeamId, number, lastName: `Muster${number}`, firstName: 'Anna', dob })))
  return { id, homeTeamId, awayTeamId }
}

describe('dobCleanup helpers', () => {
  it('withoutDob drops the key, withoutDate blanks a date and keeps a licence', () => {
    expect(withoutDob({ last_name: 'Muster', dob: '2008-03-14', license_number: '123456' })).toEqual({ last_name: 'Muster', license_number: '123456' })
    const none = { last_name: 'Muster' }
    expect(withoutDob(none)).toBe(none)
    expect(withoutDate({ dob: '14.03.2008' })).toEqual({ dob: '' })
    expect(withoutDate({ dob: '01.01.1900' })).toEqual({ dob: '' })
    const licence = { dob: '123456' }
    expect(withoutDate(licence)).toBe(licence)
  })

  it('a match in progress: live, ended before its approval, or with the coin toss done', () => {
    expect(matchInProgress({ status: 'live' })).toBe(true)
    expect(matchInProgress({ status: 'ended' })).toBe(true)
    expect(matchInProgress({ status: 'setup', coinTossConfirmed: true })).toBe(true)
    expect(matchInProgress({ status: 'ended', approved: true })).toBe(false)
    expect(matchInProgress({ status: 'final', coinTossConfirmed: true })).toBe(false)
    expect(matchInProgress({ status: 'setup' })).toBe(false)
  })

  it('matchChanges leaves a Global match and a match in progress alone', () => {
    const bench_home = [{ role: 'Coach', dob: '01.02.1970' }]
    expect(matchChanges({ global: true, status: 'final', bench_home })).toBe(null)
    expect(matchChanges({ status: 'live', bench_home })).toBe(null)
    expect(matchChanges({ status: 'final', bench_home })).toEqual({ bench_home: [{ role: 'Coach', dob: '' }] })
    expect(matchChanges({ status: 'final', bench_home: [{ dob: '123456' }] })).toBe(null)
  })

  it('a setup draft loses its dates, keeps its licences', () => {
    expect(draftDataWithoutDates({ ref1Dob: '02.09.1979', scorerDob: '123456', homeRoster: [{ dob: '14.03.2008' }, { dob: '7654' }], hall: 'MSH' }))
      .toEqual({ ref1Dob: '', scorerDob: '123456', homeRoster: [{ dob: '' }, { dob: '7654' }], hall: 'MSH' })
  })
})

describe('runDobCleanup', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('strips dob from the account caches and the cached profile, once', async () => {
    await db.club_players.put({ clubId: '1', userId: 'u', players: [{ sv_number: '123456', last_name: 'Muster', dob: '2008-03-14' }], people: [{ sv_number: '123456', last_name: 'Muster', dob: '2008-03-14', lists: ['players'] }] })
    await db.saved_teams.put({ id: 't1', players: [{ id: 'p1', last_name: 'Muster', dob: '2008-03-14', license_number: '123456' }], staff: [{ id: 's1', role: 'Coach', last_name: 'Trainer', dob: '1970-02-01' }] })
    await db.game_rosters.put({ key: '123|home', gameNumber: '123', userId: 'u', players: [{ last_name: 'Muster', dob: '2008-03-14' }], staff: [] })
    const storage = memoryStorage({ cachedProfile: JSON.stringify({ first_name: 'Sam', dob: '1990-01-15', roles: [] }) })

    const r = await runDobCleanup({ db, storage })
    expect(r).toMatchObject({ done: true, rows: 3 })
    const club = await db.club_players.get('1')
    expect(club.players[0]).toEqual({ sv_number: '123456', last_name: 'Muster' })
    expect(club.people[0]).toEqual({ sv_number: '123456', last_name: 'Muster', lists: ['players'] })
    const team = await db.saved_teams.get('t1')
    expect(team.players[0]).toEqual({ id: 'p1', last_name: 'Muster', license_number: '123456' })
    expect('dob' in team.staff[0]).toBe(false)
    expect('dob' in (await db.game_rosters.get('123|home')).players[0]).toBe(false)
    expect(JSON.parse(storage.getItem('cachedProfile'))).toEqual({ first_name: 'Sam', roles: [] })
    expect(JSON.parse(storage.getItem(DOB_CLEANUP_KEY))).toMatchObject({ done: true, pending: [] })

    // a second start does nothing
    await db.saved_teams.put({ id: 't2', players: [{ id: 'p2', last_name: 'Neu', dob: '2001-01-01' }], staff: [] })
    expect(await runDobCleanup({ db, storage })).toMatchObject({ done: true, rows: 0, cleaned: 0 })
    expect((await db.saved_teams.get('t2')).players[0].dob).toBe('2001-01-01')
  })

  it('blanks the dates of a closed Swiss match, keeps its licences; Global and live matches stay', async () => {
    const closed = await matchWith({}, [[1, '14.03.2008'], [2, '123456'], [3, '']])
    const global = await matchWith({ global: true }, [[4, '14.03.2008']])
    const live = await matchWith({ status: 'live', coinTossConfirmed: true }, [[5, '14.03.2008']])
    const storage = memoryStorage()

    const r = await runDobCleanup({ db, storage })
    expect(r).toMatchObject({ done: true, cleaned: 1, pending: 1 })

    const m = await db.matches.get(closed.id)
    expect(m.bench_home.map(b => b.dob)).toEqual(['', '654321'])
    expect(m.officials.map(o => o.dob)).toEqual(['', ''])
    expect(m.officials[1].licence).toBe('7654')
    expect(m.pendingAwayRoster.players[0].dob).toBe('')
    const players = await db.players.where('teamId').equals(closed.homeTeamId).sortBy('number')
    expect(players.map(p => p.dob)).toEqual(['', '123456', ''])
    expect((await db.teams.get(closed.homeTeamId)).benchOfficials[0].dob).toBe('')

    // a Global match keeps its birthdates; a match in progress is left alone
    expect((await db.players.where('teamId').equals(global.homeTeamId).first()).dob).toBe('14.03.2008')
    expect((await db.matches.get(global.id)).bench_home[0].dob).toBe('01.02.1970')
    expect((await db.players.where('teamId').equals(live.homeTeamId).first()).dob).toBe('14.03.2008')
    expect(JSON.parse(storage.getItem(DOB_CLEANUP_KEY)).pending).toEqual([live.id])

    // closed later: cleaned at a later start
    await db.matches.update(live.id, { status: 'final' })
    expect(await runDobCleanup({ db, storage })).toMatchObject({ done: true, cleaned: 1, pending: 0 })
    expect((await db.players.where('teamId').equals(live.homeTeamId).first()).dob).toBe('')
    expect(JSON.parse(storage.getItem(DOB_CLEANUP_KEY)).pending).toEqual([])
  })

  it('blanks the unsaved setup draft of a match before its coin toss', async () => {
    const setup = await matchWith({ status: 'setup' })
    await db.match_setup.add({ matchId: setup.id, view: 'info', data: { ref1Dob: '02.09.1979', scorerDob: '123456' }, updatedAt: '2026-11-19T10:00:00Z' })
    await runDobCleanup({ db, storage: memoryStorage() })
    const [draft] = await db.match_setup.toArray()
    expect(draft.data).toEqual({ ref1Dob: '', scorerDob: '123456' })
  })

  it('never throws: no storage, or a broken database, leaves the flag unset', async () => {
    expect(await runDobCleanup({ db, storage: null })).toEqual({ done: false })
    const storage = memoryStorage()
    const broken = { matches: { toArray: () => Promise.reject(new Error('boom')) }, transaction: () => Promise.reject(new Error('boom')) }
    expect(await runDobCleanup({ db: broken, storage })).toEqual({ done: false })
    expect(storage.getItem(DOB_CLEANUP_KEY)).toBe(null)
  })
})
