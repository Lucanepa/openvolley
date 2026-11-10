// The licence lists of the scorer's clubs (db/024), kept on the tablet for
// Match Setup's "Add from club" (players and bench officials): against the
// real app database (Dexie on fake-indexeddb). Made-up people only.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/accountApi', () => ({
  fetchClubLicences: vi.fn()
}))

import { db } from '../db'
import { fetchClubLicences } from '../../lib/accountApi'
import { clearClubPlayers, clubOfTeam, clubToRow, refreshClubPlayers, resetClubPlayersThrottle, storeClubPlayers } from '../clubPlayers'
import { accessFromRoles } from '../../lib/access'

const scorer = accessFromRoles(['scorer'])
const answer = (players = [{ sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }]) => ({
  fetched_at: '2026-11-09T10:00:00.000Z',
  clubs: [{
    club_id: 'c1',
    club_name: 'VBC Musterdorf',
    team_names: ['VBC Musterdorf H1', 'VBC Musterdorf D1'],
    team_genders: { 'VBC Musterdorf H1': 'm', 'VBC Musterdorf D1': 'f' },
    players
  }]
})

describe('the clubs\' players on the device', () => {
  beforeEach(async () => {
    await db.open()
    await db.club_players.clear()
    fetchClubLicences.mockReset()
    resetClubPlayersThrottle()
  })

  it('keeps the five fields of each player (and whether added by hand), for this account only', async () => {
    const row = clubToRow({ ...answer().clubs[0], players: [{ sv_number: 100001, last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', email: 'anna@example.ch' }] }, 'u1')
    expect(row.players).toEqual([{ sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', manual: false }])
    await storeClubPlayers(answer(), 'u1')
    const rows = await db.club_players.toArray()
    expect(rows).toHaveLength(1)
    expect(clubOfTeam(rows, ' vbc musterdorf  h1', 'u1')).toMatchObject({ clubId: 'c1', clubName: 'VBC Musterdorf', gender: 'm', players: [{ last_name: 'Beispiel' }] })
    expect(clubOfTeam(rows, 'VBC Musterdorf D1', 'u1').gender).toBe('f')
    expect(clubOfTeam(rows, 'VBC Other H1', 'u1')).toBeNull()
    expect(clubOfTeam(rows, 'VBC Musterdorf H1', 'u2')).toBeNull()
    // another account's download replaces it
    await storeClubPlayers({ clubs: [] }, 'u2')
    expect(await db.club_players.count()).toBe(0)
  })

  it('downloads while online with the scoring role; offline or without it the copy stays', async () => {
    fetchClubLicences.mockResolvedValue({ data: answer(), error: null, status: 200 })
    expect(await refreshClubPlayers({ access: scorer, userId: 'u1', online: true })).toBe('refreshed')
    expect(await db.club_players.count()).toBe(1)
    // at most once a minute unless forced
    expect(await refreshClubPlayers({ access: scorer, userId: 'u1', online: true })).toBe('skipped')
    expect(await refreshClubPlayers({ access: scorer, userId: 'u1', online: false, force: true })).toBe('offline')
    expect(await refreshClubPlayers({ access: accessFromRoles([]), userId: 'u1', online: true, force: true })).toBe('skipped')
    fetchClubLicences.mockResolvedValue({ data: null, error: { network: true }, status: 0 })
    expect(await refreshClubPlayers({ access: scorer, userId: 'u1', online: true, force: true })).toBe('offline')
    fetchClubLicences.mockResolvedValue({ data: null, error: { code: 'OV_FORBIDDEN' }, status: 403 })
    expect(await refreshClubPlayers({ access: scorer, userId: 'u1', online: true, force: true })).toBe('forbidden')
    expect(await db.club_players.count()).toBe(1)
    expect(fetchClubLicences).toHaveBeenCalledTimes(3)
  })

  it('keeps everyone of the club\'s lists once with their lists (the bench officials); an older answer: the players', async () => {
    const people = [
      { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', lists: ['players'] },
      { sv_number: 200001, last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f', lists: ['coaches', 'nonsense'], phone: '000', manual: true }
    ]
    const row = clubToRow({ ...answer().clubs[0], people }, 'u1')
    // db/026: `manual` (every row of the person added by hand) is kept for Match Setup's gray shield
    expect(row.people).toEqual([
      { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', manual: false, lists: ['players'] },
      { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f', manual: true, lists: ['coaches'] }
    ])
    // the players list stays as it was (the roster rows)
    expect(row.players.map((p) => p.sv_number)).toEqual(['100001'])
    await storeClubPlayers({ ...answer(), clubs: [{ ...answer().clubs[0], people }] }, 'u1')
    const club = clubOfTeam(await db.club_players.toArray(), 'VBC Musterdorf H1', 'u1')
    expect(club.people.map((p) => p.last_name)).toEqual(['Beispiel', 'Trainer'])
    // a server (or a row kept) before `people`: the players are the people
    expect(clubToRow(answer().clubs[0], 'u1').people).toEqual([{ sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f', manual: false, lists: ['players'] }])
    const older = clubToRow({ ...answer().clubs[0], people }, 'u1')
    delete older.people
    expect(clubOfTeam([older], 'VBC Musterdorf H1', 'u1').people.map((p) => p.lists)).toEqual([['players']])
  })

  it('is cleared on sign-out', async () => {
    await storeClubPlayers(answer(), 'u1')
    await clearClubPlayers()
    expect(await db.club_players.count()).toBe(0)
  })
})
