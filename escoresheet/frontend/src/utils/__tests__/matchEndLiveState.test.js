// The match end in the cloud live state, from Match End. Stress test
// 2026-10-25: the app killed right after "Match end" was confirmed reopened on
// Match End, and the livescore kept the game as running (last set at 25:0,
// sets 1-0) for good: the scoreboard's 'match_end' push is its last step and
// nothing pushed it later.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ calls: [], respond: null }))
vi.mock('../../lib/apiClient', () => {
  function builder(table) {
    const call = { table, action: null, data: null, filters: [] }
    const b = {
      select(cols) { call.action = 'select'; call.columns = cols; return b },
      update(d) { call.action = 'update'; call.data = d; return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      neq(c, v) { call.filters.push(['neq', c, v]); return b },
      maybeSingle() { return b },
      then(resolve, reject) {
        api.calls.push(call)
        return Promise.resolve().then(() => api.respond(call)).then(resolve, reject)
      }
    }
    return b
  }
  return { apiFrom: (table) => builder(table) }
})

import { matchEndLiveStatePatch, publishMatchEndLiveState } from '../matchEndLiveState'

const CLOUD_ID = '11111111-2222-4333-8444-555555555555'
const match = { id: 1, seed_key: 'match_972748_abc', test: false, coinTossTeamA: 'away', bestOf: 3 }
const sets = [
  { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { id: 2, index: 2, homePoints: 25, awayPoints: 0, finished: true }
]

beforeEach(() => {
  api.calls = []
  api.respond = (call) => call.table === 'matches' ? { data: { id: CLOUD_ID }, error: null } : { data: null, error: null }
})

describe('matchEndLiveStatePatch', () => {
  it('the result by team A/B (the coin toss team A), the last set, no interval', () => {
    const patch = matchEndLiveStatePatch(match, sets, Date.parse('2026-10-25T19:00:00Z'))
    expect(patch).toMatchObject({
      match_status: 'ended',
      current_set: 2,
      sets_won_a: 0, // team A is the away team
      sets_won_b: 2,
      points_a: 0,
      points_b: 25,
      set_interval_active: false,
      timeout_active: false,
      last_event_type: 'match_end',
      updated_at: '2026-10-25T19:00:00.000Z'
    })
  })

  it('nothing before a set is finished', () => {
    expect(matchEndLiveStatePatch(match, [{ index: 1, homePoints: 3, awayPoints: 1, finished: false }])).toBeNull()
  })
})

describe('publishMatchEndLiveState', () => {
  it('updates the cloud live state of the match, only where it does not say ended yet', async () => {
    expect(await publishMatchEndLiveState(match, sets)).toBe(true)
    const update = api.calls.find(c => c.table === 'match_live_state')
    expect(update.action).toBe('update')
    expect(update.data).toMatchObject({ match_status: 'ended', sets_won_b: 2 })
    expect(update.filters).toEqual([['eq', 'match_id', CLOUD_ID], ['neq', 'match_status', 'ended']])
  })

  it('offline, or the match not in the cloud yet: not done (tried again later)', async () => {
    api.respond = () => ({ data: null, error: { message: 'Failed to fetch', status: 0, network: true } })
    expect(await publishMatchEndLiveState(match, sets)).toBe(false)
    api.respond = () => ({ data: null, error: null })
    expect(await publishMatchEndLiveState(match, sets)).toBe(false)
    expect(api.calls.some(c => c.table === 'match_live_state')).toBe(false)
  })

  it('refused for good (the match is closed): done; a test match: nothing', async () => {
    api.respond = (call) => call.table === 'matches'
      ? { data: { id: CLOUD_ID }, error: null }
      : { data: null, error: { message: 'closed', code: 'OV_MATCH_CLOSED', status: 409 } }
    expect(await publishMatchEndLiveState(match, sets)).toBe(true)
    api.calls = []
    expect(await publishMatchEndLiveState({ ...match, test: true }, sets)).toBe(true)
    expect(api.calls).toHaveLength(0)
  })
})
