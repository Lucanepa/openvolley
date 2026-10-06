import { describe, it, expect, vi } from 'vitest'
import {
  missingConnectionPins,
  connectionPinsSyncJob,
  fetchPendingRoster,
  clearPendingRosterJob,
  rosterGoesToRelay,
  isKnownDob
} from '../remoteRoster'

// A query builder that records the chain, like apiClient's QueryBuilder (no .not())
function fakeFrom(result) {
  const calls = []
  const builder = {
    select: (c) => { calls.push(['select', c]); return builder },
    eq: (c, v) => { calls.push(['eq', c, v]); return builder },
    maybeSingle: () => { calls.push(['maybeSingle']); return Promise.resolve(result) }
  }
  const from = vi.fn((table) => { calls.push(['from', table]); return builder })
  return { from, calls }
}

describe('missingConnectionPins', () => {
  it('generates every missing PIN, distinct from the existing ones', () => {
    let n = 0
    const seen = []
    const gen = (existing) => { seen.push([...existing]); return String(100000 + n++) }
    const out = missingConnectionPins({ refereePin: '999999', homeTeamUploadPin: '888888' }, gen)
    expect(out).toEqual({ homeTeamPin: '100000', awayTeamPin: '100001', awayTeamUploadPin: '100002' })
    expect(seen[0]).toEqual(['999999', '888888'])
    expect(seen[2]).toEqual(['999999', '888888', '100000', '100001'])
  })

  it('returns {} for a match that has all five, and all five for none', () => {
    const full = { refereePin: '1', homeTeamPin: '2', awayTeamPin: '3', homeTeamUploadPin: '4', awayTeamUploadPin: '5' }
    expect(missingConnectionPins(full)).toEqual({})
    const fresh = missingConnectionPins(null)
    expect(Object.keys(fresh).sort()).toEqual(['awayTeamPin', 'awayTeamUploadPin', 'homeTeamPin', 'homeTeamUploadPin', 'refereePin'])
    for (const v of Object.values(fresh)) expect(v).toMatch(/^\d{6}$/)
    expect(new Set(Object.values(fresh)).size).toBe(5)
  })

  it('treats blank PINs as missing', () => {
    expect(Object.keys(missingConnectionPins({ refereePin: '  ', homeTeamPin: '2', awayTeamPin: '3', homeTeamUploadPin: '4', awayTeamUploadPin: '5' }))).toEqual(['refereePin'])
  })
})

describe('connectionPinsSyncJob', () => {
  it('queues a match update carrying the upload PINs under the seed key', () => {
    const job = connectionPinsSyncJob('match_1_abc', { refereePin: '111111', homeTeamUploadPin: '222222', awayTeamUploadPin: '333333' })
    expect(job).toMatchObject({ resource: 'match', action: 'update', status: 'queued' })
    expect(job.payload).toEqual({ id: 'match_1_abc', connection_pins: { referee: '111111', upload_home: '222222', upload_away: '333333' } })
  })
})

describe('fetchPendingRoster', () => {
  it('reads connections.pending_<team>_roster of the scorer\'s own match row (no .not(), no game_n)', async () => {
    const roster = { players: [{ number: 7 }], bench: [] }
    const { from, calls } = fakeFrom({ data: { connections: { referee_enabled: true, pending_home_roster: roster } }, error: null })
    expect(await fetchPendingRoster(from, 'match_1_abc', 'home')).toEqual({ roster, error: null })
    expect(calls).toEqual([['from', 'matches'], ['select', 'connections'], ['eq', 'external_id', 'match_1_abc'], ['maybeSingle']])
  })

  it('no row, no pending roster, or an error: no roster', async () => {
    expect((await fetchPendingRoster(fakeFrom({ data: null, error: null }).from, 'm', 'away')).roster).toBeNull()
    expect((await fetchPendingRoster(fakeFrom({ data: { connections: { pending_home_roster: { players: [] } } }, error: null }).from, 'm', 'away')).roster).toBeNull()
    const err = { message: 'boom', status: 503 }
    expect(await fetchPendingRoster(fakeFrom({ data: null, error: err }).from, 'm', 'away')).toEqual({ roster: null, error: err })
    const { from } = fakeFrom({ data: null, error: null })
    expect(await fetchPendingRoster(from, null, 'home')).toEqual({ roster: null, error: null })
    expect(from).not.toHaveBeenCalled()
    await expect(fetchPendingRoster(from, 'm', 'nope')).rejects.toThrow(/unknown team/)
  })
})

describe('clearPendingRosterJob', () => {
  it('nulls only that team\'s pending roster (connections is merged on the server)', () => {
    expect(clearPendingRosterJob('m1', 'away').payload).toEqual({ id: 'm1', connections: { pending_away_roster: null } })
    expect(() => clearPendingRosterJob('m1', 'x')).toThrow()
  })
})

describe('rosterGoesToRelay', () => {
  it('the cloud upload never triggers the relay PATCH; the LAN relay still gets it', () => {
    expect(rosterGoesToRelay('supabase')).toBe(false)
    expect(rosterGoesToRelay('websocket')).toBe(true)
    expect(rosterGoesToRelay(null)).toBe(true)
  })
})

describe('isKnownDob', () => {
  it('rejects empty values and the 1900 placeholder in every format', () => {
    for (const v of [undefined, null, '', '  ', '01.01.1900', '01/01/1900', '1900-01-01']) expect(isKnownDob(v)).toBe(false)
    expect(isKnownDob('04.05.1990')).toBe(true)
  })
})
