// Audit 2026-11, SEC-06: a referee or bench PIN check that names no match is
// a lookup among every live match on the backend (one guess tested against
// all of them). The OpenVolley apps name their match whenever they know it:
// the picked row's key, else the one match the picker listed under the game
// number picked (two listed rows share the number, a numeric LAN id).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validatePinSupabase,
  validatePin,
  listAvailableMatches,
  listAvailableMatchesSupabase,
  listAvailableMatchesForBenchSupabase,
  listedMatchKey,
  forgetListedMatches,
  forgetMatchAccess
} from '../serverDataSync'

const SEED = 'match_1791215210058_yxkc82'
const OTHER = 'match_1791215210099_other1'

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } })

/** A cloud picker row of the referee and bench lists. */
const cloudRow = (externalId, gameN, now = Date.now()) => ({
  id: '11111111-2222-4333-8444-' + String(gameN).padStart(12, '0'),
  external_id: externalId,
  game_n: gameN,
  status: 'live',
  test: false,
  sport_type: 'indoor',
  scheduled_at: new Date(now).toISOString(),
  updated_at: new Date(now).toISOString(),
  coin_toss: null,
  home_team: { name: 'Home VC' },
  away_team: { name: 'Away VC' },
  connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true }
})

describe('the PIN checks name the match picked', () => {
  let realFetch
  let bodies
  let cloudRows
  let relayRows
  beforeEach(() => {
    realFetch = globalThis.fetch
    bodies = []
    cloudRows = []
    relayRows = []
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('/api/match/validate-connection-pin')) {
        bodies.push({ cloud: JSON.parse(init.body) })
        return json({ success: false, error: 'Invalid PIN code' }, 404)
      }
      if (u.includes('/api/match/validate-pin')) {
        bodies.push({ relay: JSON.parse(init.body) })
        return json({ success: false, error: 'No match found with this PIN.' }, 404)
      }
      if (u.includes('/api/match/list')) return json({ success: true, matches: relayRows })
      if (u.endsWith('/api/db')) return json({ data: cloudRows, error: null })
      return json({ data: null, error: null })
    })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    forgetListedMatches()
    forgetMatchAccess()
    vi.useRealTimers()
  })

  it('a cloud check with only a game number names the one cloud match the picker listed under it', async () => {
    cloudRows = [cloudRow(SEED, 12), cloudRow(OTHER, 13)]
    expect((await listAvailableMatchesSupabase()).matches.map((m) => m.external_id)).toEqual([SEED, OTHER])
    expect(listedMatchKey('cloud', 12)).toBe(SEED)
    await validatePinSupabase('314159', 'referee', { gameNumber: '12' })
    // a key the caller names wins; no game number, or one nobody listed: no match named, as before
    await validatePinSupabase('314159', 'referee', { matchExternalId: OTHER, gameNumber: '12' })
    await validatePinSupabase('314159', 'referee')
    await validatePinSupabase('314159', 'referee', { gameNumber: '99' })
    expect(bodies).toEqual([
      { cloud: { pin: '314159', type: 'referee', matchExternalId: SEED } },
      { cloud: { pin: '314159', type: 'referee', matchExternalId: OTHER } },
      { cloud: { pin: '314159', type: 'referee' } },
      { cloud: { pin: '314159', type: 'referee' } }
    ])
  })

  it('the bench list too; a game number two listed matches share names none', async () => {
    cloudRows = [cloudRow(SEED, 12), cloudRow(OTHER, 12)]
    await listAvailableMatchesForBenchSupabase()
    expect(listedMatchKey('cloud', 12)).toBeNull()
    await validatePinSupabase('314159', 'bench_home', { gameNumber: 12 })
    cloudRows = [cloudRow(SEED, 12)]
    await listAvailableMatchesForBenchSupabase()
    await validatePinSupabase('314159', 'bench_home', { gameNumber: 12 })
    expect(bodies).toEqual([
      { cloud: { pin: '314159', type: 'bench_home' } },
      { cloud: { pin: '314159', type: 'bench_home', matchExternalId: SEED } }
    ])
  })

  it('the relay check with only a game number names the one room the relay listed under it', async () => {
    relayRows = [
      { id: SEED, gameNumber: 12, sportType: 'indoor' },
      // a LAN relay's own numeric id names nothing; a beach room is not this app's
      { id: '7', gameNumber: 14, sportType: 'indoor' },
      { id: OTHER, gameNumber: 15, sportType: 'beach' }
    ]
    await listAvailableMatches()
    for (const gameNumber of [12, 14, 15]) await validatePin('314159', 'homeTeam', { gameNumber }).catch(() => {})
    await validatePin('314159', 'referee', { matchId: OTHER, gameNumber: 12 }).catch(() => {})
    expect(bodies).toEqual([
      { relay: { pin: '314159', type: 'homeTeam', matchId: SEED } },
      { relay: { pin: '314159', type: 'homeTeam', gameNumber: '14' } },
      { relay: { pin: '314159', type: 'homeTeam', gameNumber: '15' } },
      { relay: { pin: '314159', type: 'referee', matchId: OTHER } }
    ])
  })

  it('a list read long ago names nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'))
    cloudRows = [cloudRow(SEED, 12)]
    await listAvailableMatchesSupabase()
    vi.setSystemTime(new Date('2026-11-23T10:14:00Z'))
    expect(listedMatchKey('cloud', 12)).toBe(SEED)
    vi.setSystemTime(new Date('2026-11-23T10:16:00Z'))
    expect(listedMatchKey('cloud', 12)).toBeNull()
    await validatePinSupabase('314159', 'referee', { gameNumber: 12 })
    expect(bodies).toEqual([{ cloud: { pin: '314159', type: 'referee' } }])
  })
})
