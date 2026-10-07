import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ calls: [], rows: [] }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const call = { table, columns: null, filters: [] }
    const b = {
      select(cols) { call.columns = cols; return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      gte(c, v) { call.filters.push(['gte', c, v]); return b },
      lte(c, v) { call.filters.push(['lte', c, v]); return b },
      order(c, o) { call.order = [c, o]; return b },
      limit(n) { call.limit = n; return b },
      then(resolve) {
        api.calls.push(call)
        return Promise.resolve({ data: api.rows, error: null }).then(resolve)
      }
    }
    return b
  }
}))

import { listRosterUploadMatches, isOpenForRosterUpload } from '../rosterUploadMatches'

beforeEach(() => {
  api.calls = []
  api.rows = []
})

describe('roster upload match list', () => {
  it('lists every match still in setup, whether or not the referee connection is on', async () => {
    api.rows = [
      { id: 'u1', external_id: 'match_1_a', game_n: 991454, status: 'setup', scheduled_at: '2026-10-05T18:00:00Z', home_team: { name: 'E2E Home V' }, away_team: { name: 'E2E Away V' }, test: false },
      { id: 'u2', external_id: 'match_2_b', game_n: 991455, status: 'setup', scheduled_at: null, home_team: { name: 'H' }, away_team: { name: 'A' } }
    ]
    const res = await listRosterUploadMatches()
    expect(res.success).toBe(true)
    expect(res.matches.map(m => m.gameNumber)).toEqual([991454, 991455])
    expect(res.matches[0]).toMatchObject({ id: 'match_1_a', external_id: 'match_1_a', homeTeamName: 'E2E Home V', awayTeamName: 'E2E Away V', status: 'setup' })
    expect(res.matches[1].dateTime).toBe('TBD')

    const q = api.calls[0]
    expect(q.filters).toContainEqual(['in', 'status', ['setup']])
    // never the PINs, nor the pending rosters/signatures in connections
    expect(q.columns).not.toMatch(/connection|pin/)
  })

  it('lists only a window around now (a day back, two weeks ahead), soonest first, with a limit', async () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    await listRosterUploadMatches({ now })
    const q = api.calls[0]
    expect(q.filters).toContainEqual(['gte', 'scheduled_at', '2026-10-04T12:00:00.000Z'])
    expect(q.filters).toContainEqual(['lte', 'scheduled_at', '2026-10-19T12:00:00.000Z'])
    expect(q.order).toEqual(['scheduled_at', { ascending: true }])
    expect(q.limit).toBe(200)
  })

  it('a match whose coin toss is done (live), final or a test match is closed for upload', () => {
    expect(isOpenForRosterUpload({ status: 'setup' })).toBe(true)
    expect(isOpenForRosterUpload({ status: 'live' })).toBe(false)
    expect(isOpenForRosterUpload({ status: 'final' })).toBe(false)
    expect(isOpenForRosterUpload({ status: 'setup', test: true })).toBe(false)
    expect(isOpenForRosterUpload(null)).toBe(false)
  })

  it('a beach (OpenBeach) match is not listed; older indoor rows without sport_type are', () => {
    expect(isOpenForRosterUpload({ status: 'setup', sport_type: 'beach' })).toBe(false)
    expect(isOpenForRosterUpload({ status: 'setup', sport_type: null })).toBe(true)
    expect(isOpenForRosterUpload({ status: 'setup', sport_type: 'indoor' })).toBe(true)
  })

  it('team names fall back to team1_data / team2_data, then Home / Away', async () => {
    api.rows = [
      { id: 'u1', external_id: 'm1', game_n: 1, status: 'setup', scheduled_at: null, home_team: null, away_team: null, team1_data: { name: 'T1' }, team2_data: { name: 'T2' } },
      { id: 'u2', external_id: 'm2', game_n: 2, status: 'setup', scheduled_at: null, home_team: null, away_team: null }
    ]
    const res = await listRosterUploadMatches()
    expect(res.matches.map((m) => [m.homeTeam, m.awayTeam])).toEqual([['T1', 'T2'], ['Home', 'Away']])
    expect(api.calls[0].columns).toMatch(/sport_type/)
  })
})
