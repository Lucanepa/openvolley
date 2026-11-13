// The rosters teams sent ahead (db/023), kept on the tablet for Match Setup:
// against the real app database (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/accountApi', () => ({
  fetchGameRosters: vi.fn(),
  markGameRosterUsed: vi.fn()
}))

import { db } from '../db'
import { fetchGameRosters, markGameRosterUsed } from '../../lib/accountApi'
import { clearGameRosters, flushUsedGameRosters, getGameRoster, markGameRosterAccepted, offeredSentRosters, pruneGameRosters, refreshGameRosters, rowToPendingRoster, storeGameRosters } from '../gameRosters'
import { accessFromRoles } from '../../lib/access'

const scorer = accessFromRoles(['scorer'])
const roster = (n, side, over = {}) => ({
  game_number: n, season: 2026, side, team_name: side === 'home' ? 'VBC Musterdorf H1' : 'VBC Other H1', kickoff: '2026-11-10T18:00:00',
  players: [{ number: 4, first_name: 'Anna', last_name: 'Muster', dob: '2001-02-03', is_captain: true, is_libero: false }, { number: 7, first_name: 'Bea', last_name: 'Libero', dob: '2002-03-04', is_libero: true }],
  staff: [{ role: 'Coach', first_name: 'Chris', last_name: 'Coach', dob: '1980-01-01' }],
  updated_at: '2026-11-08T19:30:00.000Z', updated_by_name: 'Coach Test', ...over
})

describe('sent game rosters on the device', () => {
  beforeEach(async () => {
    await db.open()
    await db.game_rosters.clear()
    fetchGameRosters.mockReset()
    markGameRosterUsed.mockReset()
  })

  it('keeps an answer for this account only, and Match Setup reads it without the network', async () => {
    await storeGameRosters({ games: [{ game_number: '940001' }], rosters: [roster('940001', 'home')] }, 'u1')
    const row = await getGameRoster('940001', 'home', { userId: 'u1' })
    expect(row).toMatchObject({ key: '940001|home', teamName: 'VBC Musterdorf H1', updatedByName: 'Coach Test' })
    expect(await getGameRoster('940001', 'home', { userId: 'u2' })).toBeNull()
    expect(await getGameRoster('940001', 'away', { userId: 'u1' })).toBeNull()
    expect(fetchGameRosters).not.toHaveBeenCalled()
  })

  it('a covered game drops a side the team deleted; other games stay', async () => {
    await storeGameRosters({ games: [{ game_number: '1' }, { game_number: '2' }], rosters: [roster('1', 'home'), roster('1', 'away'), roster('2', 'away')] }, 'u1')
    await storeGameRosters({ games: [{ game_number: '1' }], rosters: [roster('1', 'away')] }, 'u1')
    expect((await db.game_rosters.toArray()).map(r => r.key).sort()).toEqual(['1|away', '2|away'])
  })

  it('another account\'s rows go when this one stores', async () => {
    await storeGameRosters({ games: [], rosters: [roster('1', 'home')] }, 'u1')
    await storeGameRosters({ games: [], rosters: [roster('2', 'home')] }, 'u2')
    expect((await db.game_rosters.toArray()).map(r => [r.key, r.userId])).toEqual([['2|home', 'u2']])
  })

  it('refresh: offline or without a scoring role it leaves the cache; online it fills it', async () => {
    expect(await refreshGameRosters({ access: scorer, userId: 'u1', online: false })).toBe('offline')
    expect(await refreshGameRosters({ access: accessFromRoles([]), userId: 'u1', online: true })).toBe('skipped')
    expect(fetchGameRosters).not.toHaveBeenCalled()
    fetchGameRosters.mockResolvedValue({ data: { games: [{ game_number: '940001' }], rosters: [roster('940001', 'away')] }, error: null, status: 200 })
    expect(await refreshGameRosters({ access: scorer, userId: 'u1', online: true, games: ['940001'] })).toBe('refreshed')
    expect(fetchGameRosters).toHaveBeenCalledWith({ games: ['940001'], timeoutMs: 8000 })
    expect(await getGameRoster('940001', 'away', { userId: 'u1' })).not.toBeNull()
    // a failed request keeps what is there
    fetchGameRosters.mockResolvedValue({ data: null, error: { network: true }, status: 0 })
    expect(await refreshGameRosters({ access: scorer, userId: 'u1', online: true, games: ['940001'] })).toBe('offline')
    expect(await getGameRoster('940001', 'away', { userId: 'u1' })).not.toBeNull()
  })

  it('prunes games more than a day and a half ago, and clears on sign-out', async () => {
    await storeGameRosters({ games: [], rosters: [roster('1', 'home', { kickoff: '2026-11-01T18:00:00' }), roster('2', 'home', { kickoff: '2026-11-10T18:00:00' })] }, 'u1')
    await pruneGameRosters(new Date('2026-11-08T12:00:00Z'))
    expect((await db.game_rosters.toArray()).map(r => r.key)).toEqual(['2|home'])
    await clearGameRosters()
    expect(await db.game_rosters.count()).toBe(0)
  })

  it('clearGameRosters({ keepUserId }) keeps that account\'s rows only', async () => {
    await storeGameRosters({ games: [], rosters: [roster('1', 'home')] }, 'u1')
    await db.game_rosters.put({ ...(await db.game_rosters.get('1|home')), key: '2|home', gameNumber: '2', userId: 'u2' })
    await clearGameRosters({ keepUserId: 'u1' })
    expect((await db.game_rosters.toArray()).map((r) => r.userId)).toEqual(['u1'])
    await clearGameRosters({ keepUserId: null })
    expect(await db.game_rosters.count()).toBe(0)
  })

  it('Match Setup offers a sent roster until the match starts, once per version', () => {
    const home = { key: '1|home', side: 'home', userId: 'u1', updatedAt: 'v1' }
    const away = { key: '1|away', side: 'away', userId: 'u1', updatedAt: 'v1' }
    // a new match is 'scheduled' (the case the first build missed)
    expect(offeredSentRosters([home, away], { status: 'scheduled' }, 'u1')).toEqual({ home, away })
    expect(offeredSentRosters([home], { status: 'setup' }, 'u1').home).toBe(home)
    expect(offeredSentRosters([home], {}, 'u1').home).toBe(home)
    for (const status of ['live', 'ended', 'approved', 'final']) expect(offeredSentRosters([home], { status }, 'u1').home).toBeNull()
    expect(offeredSentRosters([home], { status: 'scheduled', test: true }, 'u1').home).toBeNull()
    expect(offeredSentRosters([home], { status: 'scheduled' }, 'u2').home).toBeNull()
    expect(offeredSentRosters([home, away], { status: 'scheduled', sentRosterUsed: { home: 'v1' }, sentRosterDismissed: { away: 'v1' } }, 'u1')).toEqual({ home: null, away: null })
    // a newer version is offered again
    expect(offeredSentRosters([{ ...home, updatedAt: 'v2' }], { sentRosterDismissed: { home: 'v1' } }, 'u1').home).not.toBeNull()
  })

  it('accepted: never offered again, the server is told now or once online, then the copy goes', async () => {
    const sig = 'data:image/png;base64,AAAA'
    await storeGameRosters({ games: [{ game_number: '1' }], rosters: [roster('1', 'home', { coach_signature: sig, captain_signature: sig })] }, 'u1')
    const row = await getGameRoster('1', 'home', { userId: 'u1' })
    expect(rowToPendingRoster(row)).toMatchObject({ coachSignature: sig, captainSignature: sig })
    // offline: marked at once, the server not reached
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    try {
      await markGameRosterAccepted(row)
    } finally {
      delete navigator.onLine
      if (online) Object.defineProperty(Navigator.prototype, 'onLine', online)
    }
    expect(markGameRosterUsed).not.toHaveBeenCalled()
    const marked = await db.game_rosters.get('1|home')
    expect(marked.usedPending).toBe(true)
    expect(offeredSentRosters([marked], { status: 'scheduled' }, 'u1').home).toBeNull()
    // a download of the same version does not bring it back
    await storeGameRosters({ games: [{ game_number: '1' }], rosters: [roster('1', 'home')] }, 'u1')
    expect((await db.game_rosters.get('1|home')).usedPending).toBe(true)
    // a failed request keeps it for next time
    markGameRosterUsed.mockResolvedValueOnce({ data: null, error: { network: true }, status: 0 })
    expect(await flushUsedGameRosters({ online: true })).toBe(0)
    expect(await db.game_rosters.get('1|home')).toBeTruthy()
    // back online: told, then the copy goes
    markGameRosterUsed.mockResolvedValueOnce({ data: { used: true }, error: null, status: 200 })
    expect(await flushUsedGameRosters({ online: true })).toBe(1)
    expect(markGameRosterUsed).toHaveBeenLastCalledWith({ game_number: '1', side: 'home', season: 2026, updated_at: '2026-11-08T19:30:00.000Z' })
    expect(await db.game_rosters.get('1|home')).toBeUndefined()
  })

  it('a newer version replaces an accepted one waiting to be told', async () => {
    await storeGameRosters({ games: [], rosters: [roster('1', 'home')] }, 'u1')
    await db.game_rosters.update('1|home', { usedPending: true })
    await storeGameRosters({ games: [{ game_number: '1' }], rosters: [roster('1', 'home', { updated_at: '2026-11-09T08:00:00.000Z' })] }, 'u1')
    const row = await db.game_rosters.get('1|home')
    expect(row.usedPending).toBeUndefined()
    expect(row.updatedAt).toBe('2026-11-09T08:00:00.000Z')
  })

  it('refresh tells the server about accepted rosters before it downloads', async () => {
    await storeGameRosters({ games: [], rosters: [roster('1', 'home')] }, 'u1')
    await db.game_rosters.update('1|home', { usedPending: true })
    markGameRosterUsed.mockResolvedValue({ data: { used: true }, error: null, status: 200 })
    fetchGameRosters.mockResolvedValue({ data: { games: [{ game_number: '1' }], rosters: [] }, error: null, status: 200 })
    expect(await refreshGameRosters({ access: scorer, userId: 'u1', online: true, force: true })).toBe('refreshed')
    expect(markGameRosterUsed.mock.invocationCallOrder[0]).toBeLessThan(fetchGameRosters.mock.invocationCallOrder[0])
    expect(await db.game_rosters.count()).toBe(0)
  })

  it('back online, the server is told even when the download waits for its minute', async () => {
    fetchGameRosters.mockResolvedValue({ data: { games: [], rosters: [] }, error: null, status: 200 })
    await refreshGameRosters({ access: scorer, userId: 'u1', online: true, force: true })
    await storeGameRosters({ games: [], rosters: [roster('2', 'home')] }, 'u1')
    await db.game_rosters.update('2|home', { usedPending: true })
    markGameRosterUsed.mockResolvedValue({ data: { used: true }, error: null, status: 200 })
    fetchGameRosters.mockClear()
    expect(await refreshGameRosters({ access: scorer, userId: 'u1', online: true })).toBe('skipped')
    expect(fetchGameRosters).not.toHaveBeenCalled()
    expect(markGameRosterUsed).toHaveBeenCalled()
    expect(await db.game_rosters.count()).toBe(0)
  })

  it('becomes Match Setup\'s pending-roster shape', () => {
    const p = rowToPendingRoster({ teamName: 'T', updatedAt: 'x', updatedByName: 'N', players: roster('1', 'home').players, staff: roster('1', 'home').staff })
    expect(p.players).toEqual([
      { number: 4, firstName: 'Anna', lastName: 'Muster', dob: '03.02.2001', libero: '', isCaptain: true, isLfp: false },
      { number: 7, firstName: 'Bea', lastName: 'Libero', dob: '04.03.2002', libero: 'libero1', isCaptain: false, isLfp: false }
    ])
    expect(p.bench).toEqual([{ role: 'Coach', firstName: 'Chris', lastName: 'Coach', dob: '01.01.1980' }])
    expect(p).toMatchObject({ source: 'team', teamName: 'T', sentAt: 'x', sentBy: 'N' })
  })
})
