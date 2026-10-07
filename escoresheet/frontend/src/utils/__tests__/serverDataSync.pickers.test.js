import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ calls: [], rows: [], error: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: (table) => {
    const call = { table, columns: null, filters: [] }
    const b = {
      select(cols) { call.columns = cols; return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      gte(c, v) { call.filters.push(['gte', c, v]); return b },
      order(c, o) { call.order = [c, o]; return b },
      then(resolve) {
        api.calls.push(call)
        return Promise.resolve({ data: api.error ? null : api.rows, error: api.error }).then(resolve)
      }
    }
    return b
  }
}))

import { listAvailableMatchesSupabase, listAvailableMatchesForBenchSupabase } from '../serverDataSync'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const H = 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()
const ALL_ON = { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: false }

const row = (over) => ({
  id: `uuid-${over.external_id}`,
  game_n: 100,
  status: 'live',
  test: false,
  sport_type: 'indoor',
  scheduled_at: iso(NOW - H),
  updated_at: iso(NOW - 10 * 60 * 1000),
  home_team: { name: `${over.external_id} home` },
  away_team: { name: `${over.external_id} away` },
  connections: ALL_ON,
  ...over
})

const ROWS = [
  row({ external_id: 'ok' }),
  row({ external_id: 'legacy-indoor', sport_type: null }),
  // The February OpenBeach test match nobody finished
  row({ external_id: 'feb-beach', sport_type: 'beach', test: true, home_team: null, away_team: null, scheduled_at: '2026-06-15T14:00:00', updated_at: '2026-02-20T10:00:00+00:00' }),
  row({ external_id: 'beach-today', sport_type: 'beach' }),
  row({ external_id: 'rehearsal', test: true }),
  row({ external_id: 'idle-live', updated_at: iso(NOW - 7 * H) }),
  row({ external_id: 'old-setup', status: 'setup', scheduled_at: iso(NOW - 13 * H) }),
  row({ external_id: 'beach-names', sport_type: null, home_team: null, away_team: {}, team1_data: { name: 'T1' }, team2_data: { name: 'T2' } }),
  row({ external_id: 'no-names', home_team: null, away_team: null }),
  row({ external_id: 'ref-off', connections: { referee_enabled: false, home_bench_enabled: false, away_bench_enabled: false } })
]

beforeEach(() => {
  api.calls = []
  api.rows = ROWS
  api.error = null
})

describe('cloud match pickers (referee / bench)', () => {
  it('referee: indoor, not test, not stale, referee connection on; names fall back to team1/team2 then Home/Away', async () => {
    const res = await listAvailableMatchesSupabase({ now: NOW })
    expect(res.success).toBe(true)
    expect(res.matches.map((m) => m.id)).toEqual(['ok', 'legacy-indoor', 'beach-names', 'no-names'])
    expect(res.matches.find((m) => m.id === 'beach-names')).toMatchObject({ homeTeam: 'T1', awayTeam: 'T2' })
    expect(res.matches.find((m) => m.id === 'no-names')).toMatchObject({ homeTeam: 'Home', awayTeam: 'Away' })
    expect(res.matches[0]).toMatchObject({ external_id: 'ok', gameNumber: 100, homeTeam: 'ok home', refereeConnectionEnabled: true, status: 'live' })
  })

  it('bench: same rule, a bench connection on', async () => {
    api.rows = [...ROWS, row({ external_id: 'away-only', connections: { away_bench_enabled: true } })]
    const res = await listAvailableMatchesForBenchSupabase({ now: NOW })
    expect(res.matches.map((m) => m.id)).toEqual(['ok', 'legacy-indoor', 'beach-names', 'no-names', 'away-only'])
    expect(res.matches.find((m) => m.id === 'away-only')).toMatchObject({ homeBenchEnabled: undefined, awayBenchEnabled: true })
  })

  it('asks for setup / live rows written in the last 30 days with the columns the rule needs, never the PINs', async () => {
    await listAvailableMatchesSupabase({ now: NOW })
    await listAvailableMatchesForBenchSupabase({ now: NOW })
    for (const q of api.calls) {
      expect(q.table).toBe('matches')
      expect(q.filters).toContainEqual(['in', 'status', ['setup', 'live']])
      expect(q.filters).toContainEqual(['gte', 'updated_at', '2026-09-07T12:00:00.000Z'])
      expect(q.order).toEqual(['scheduled_at', { ascending: true }])
      for (const col of ['sport_type', 'test', 'updated_at', 'coin_toss', 'team1_data', 'team2_data', 'connections']) {
        expect(q.columns).toContain(col)
      }
      expect(q.columns).not.toMatch(/pin/)
    }
  })

  it('an error answer is a failure, not a list', async () => {
    api.error = { status: 404, message: 'not found' }
    const res = await listAvailableMatchesSupabase({ now: NOW })
    expect(res).toMatchObject({ success: false, matches: [] })
  })
})
