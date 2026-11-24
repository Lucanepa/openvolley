import { describe, it, expect, vi } from 'vitest'
import {
  missingConnectionPins,
  connectionPinsSyncJob,
  fetchPendingRoster,
  clearPendingRosterJob,
  pendingClearDecision,
  rosterGoesToRelay,
  isKnownDob,
  scorerIdentified,
  cleanLicence
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
    expect(clearPendingRosterJob('m1', 'away').onlyIfPending).toBeUndefined()
    expect(() => clearPendingRosterJob('m1', 'x')).toThrow()
  })

  // 21.11.2026: a team that uploads again before the clear is sent keeps its new roster
  it('with the upload accepted or rejected: names it, outside the payload the server gets', () => {
    const job = clearPendingRosterJob('m1', 'home', { players: [], bench: [], timestamp: '2026-11-21T10:00:00.000Z' })
    expect(job.payload).toEqual({ id: 'm1', connections: { pending_home_roster: null } })
    expect(job.onlyIfPending).toMatchObject({ key: 'pending_home_roster', version: '2026-11-21T10:00:00.000Z' })
    expect(typeof job.onlyIfPending.fp).toBe('string')
  })
})

describe('pendingClearDecision', () => {
  const roster = (timestamp, lastName = 'Example') => ({ players: [{ number: 4, firstName: 'A', lastName }], bench: [], timestamp })
  const job = clearPendingRosterJob('m1', 'home', roster('t1'))

  it('kept while the server has that upload; left out for a newer one, none, or a row that could not be read', () => {
    expect(pendingClearDecision(job, { connections: { pending_home_roster: roster('t1') } })).toEqual({ keep: true, key: 'pending_home_roster', only: true })
    expect(pendingClearDecision(job, { connections: { pending_home_roster: roster('t2', 'Newer') } }).keep).toBe(false)
    expect(pendingClearDecision(job, { connections: { pending_home_roster: null } }).keep).toBe(false)
    expect(pendingClearDecision(job, { connections: {} }).keep).toBe(false)
    expect(pendingClearDecision(job, null).keep).toBe(false)
    expect(pendingClearDecision(job, undefined).keep).toBe(false)
  })

  it('other jobs are not touched; a job with more to send is not only the clear', () => {
    expect(pendingClearDecision(clearPendingRosterJob('m1', 'home'), undefined)).toEqual({ keep: true, key: null, only: false })
    expect(pendingClearDecision({ resource: 'match', action: 'update', payload: { id: 'm1', status: 'live' } }, null).key).toBeNull()
    const more = { ...job, payload: { ...job.payload, connections: { pending_home_roster: null, referee_enabled: true } } }
    expect(pendingClearDecision(more, undefined)).toEqual({ keep: false, key: 'pending_home_roster', only: false })
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

describe('scorerIdentified', () => {
  it('a real date of birth or a licence number (owner 2026-11-15)', () => {
    expect(scorerIdentified('01.01.1900', '')).toBe(false)
    expect(scorerIdentified('', '   ')).toBe(false)
    expect(scorerIdentified(null, null)).toBe(false)
    expect(scorerIdentified('04.05.1990', '')).toBe(true)
    expect(scorerIdentified('01.01.1900', 'SV 12345')).toBe(true)
  })
  it('cleanLicence trims and caps at 30 characters', () => {
    expect(cleanLicence('  12 34 ')).toBe('12 34')
    expect(cleanLicence('')).toBeNull()
    expect(cleanLicence('x'.repeat(40))).toHaveLength(30)
  })
})
