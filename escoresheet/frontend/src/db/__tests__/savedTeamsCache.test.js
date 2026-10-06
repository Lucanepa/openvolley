import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/accountApi', () => ({
  savedTeamsApi: { fetchBundle: vi.fn() }
}))

import { db } from '../db'
import { savedTeamsApi } from '../../lib/accountApi'
import { refreshSavedTeams, getSavedTeams, clearSavedTeams, bundleToRows, getSavedTeamsMeta } from '../savedTeams'
import { accessFromRoles } from '../../lib/access'

const scorer = accessFromRoles(['scorer'])
const bundle = (version = '1', teams = null) => ({
  version,
  fetched_at: new Date().toISOString(),
  competitions: [{ id: 'c1', name: '2. Liga', season: '2026/27', gender: 'women', category: null, vm_leagues: ['2. Liga Damen'], archived: false, updated_at: '2026-09-01T00:00:00Z' }],
  teams: teams ?? [{
    id: 't1', competition_id: 'c1', name: 'VBC Test', short_name: 'VBC', club: 'VBC', color: '#e2001a', svrz_team_name: 'VBC  Test D1',
    updated_at: '2026-09-02T00:00:00Z',
    players: [{ id: 'p1', number: 4, first_name: 'A', last_name: 'B', dob: '2000-01-02', license_number: 'X', is_libero: false, is_captain: true, active: true, sort_order: 0 }],
    staff: []
  }]
})

describe('saved teams cache', () => {
  beforeEach(async () => {
    await db.open()
    await db.saved_teams.clear()
    await db.saved_teams_meta.clear()
    savedTeamsApi.fetchBundle.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('maps the bundle to camelCase rows with the competition embedded', () => {
    const [row] = bundleToRows(bundle())
    expect(row).toMatchObject({
      id: 't1', competitionId: 'c1', shortName: 'VBC', svrzTeamName: 'VBC  Test D1', nameKey: 'vbc test', svrzKey: 'vbc test d1',
      competition: { id: 'c1', season: '2026/27', vmLeagues: ['2. Liga Damen'], archived: false }, updatedAt: '2026-09-02T00:00:00Z'
    })
    expect(row.players).toHaveLength(1)
  })

  it('refresh replaces the cache and stores the owner', async () => {
    await db.saved_teams.put({ id: 'stale', competitionId: 'x', nameKey: '', svrzKey: '' })
    savedTeamsApi.fetchBundle.mockResolvedValue({ data: bundle('7'), error: null, status: 200 })
    const res = await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    expect(res.status).toBe('refreshed')
    expect((await db.saved_teams.toArray()).map(r => r.id)).toEqual(['t1'])
    expect(await getSavedTeamsMeta()).toMatchObject({ version: '7', userId: 'u1' })
    expect((await getSavedTeams({ userId: 'u1' })).map(r => r.id)).toEqual(['t1'])
  })

  it('skips the request when the cache is under 10 minutes old, unless forced', async () => {
    savedTeamsApi.fetchBundle.mockResolvedValue({ data: bundle(), error: null, status: 200 })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    const second = await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    expect(second.status).toBe('fresh')
    expect(savedTeamsApi.fetchBundle).toHaveBeenCalledTimes(1)
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true, force: true })
    expect(savedTeamsApi.fetchBundle).toHaveBeenCalledTimes(2)
    // an old cache is refreshed
    await db.saved_teams_meta.update('bundle', { fetchedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    expect(savedTeamsApi.fetchBundle).toHaveBeenCalledTimes(3)
  })

  it('never shows another account\'s cache, and a new account refetches', async () => {
    savedTeamsApi.fetchBundle.mockResolvedValue({ data: bundle(), error: null, status: 200 })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    expect(await getSavedTeams({ userId: 'u2' })).toEqual([])
    expect(await getSavedTeams({ userId: null })).toEqual([])
    const res = await refreshSavedTeams({ access: scorer, userId: 'u2', online: true })
    expect(res.status).toBe('refreshed')
    expect(savedTeamsApi.fetchBundle).toHaveBeenCalledTimes(2)
  })

  it('a 403 clears the cache', async () => {
    savedTeamsApi.fetchBundle.mockResolvedValueOnce({ data: bundle(), error: null, status: 200 })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    savedTeamsApi.fetchBundle.mockResolvedValueOnce({ data: null, error: { code: 'OV_FORBIDDEN', status: 403 }, status: 403 })
    const res = await refreshSavedTeams({ access: scorer, userId: 'u1', online: true, force: true })
    expect(res.status).toBe('forbidden')
    expect(await db.saved_teams.count()).toBe(0)
    expect(await getSavedTeamsMeta()).toBeNull()
  })

  it('offline or on a network error it returns the cache', async () => {
    savedTeamsApi.fetchBundle.mockResolvedValueOnce({ data: bundle(), error: null, status: 200 })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    const off = await refreshSavedTeams({ access: scorer, userId: 'u1', online: false, force: true })
    expect(off.status).toBe('offline')
    expect(off.teams.map(t => t.id)).toEqual(['t1'])
    savedTeamsApi.fetchBundle.mockResolvedValueOnce({ data: null, error: { network: true, status: 0 }, status: 0 })
    const net = await refreshSavedTeams({ access: scorer, userId: 'u1', online: true, force: true })
    expect(net.status).toBe('offline')
    expect(net.teams).toHaveLength(1)
  })

  it('does not load for pending accounts or without a user', async () => {
    expect((await refreshSavedTeams({ access: accessFromRoles([]), userId: 'u1', online: true })).status).toBe('skipped')
    expect((await refreshSavedTeams({ access: scorer, userId: null, online: true })).status).toBe('skipped')
    expect(savedTeamsApi.fetchBundle).not.toHaveBeenCalled()
  })

  it('clearSavedTeams empties both tables', async () => {
    savedTeamsApi.fetchBundle.mockResolvedValue({ data: bundle(), error: null, status: 200 })
    await refreshSavedTeams({ access: scorer, userId: 'u1', online: true })
    await clearSavedTeams()
    expect(await db.saved_teams.count()).toBe(0)
    expect(await db.saved_teams_meta.count()).toBe(0)
  })
})
