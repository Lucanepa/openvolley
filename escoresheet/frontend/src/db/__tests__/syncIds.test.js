import { describe, it, expect } from 'vitest'
import {
  setExtId,
  eventExtId,
  parseExtId,
  isBareLocalId,
  jobMatchKey,
  resolveJobExternalId,
  rewriteQueuedSyncJobs
} from '../../utils/syncIds'
import { buildConnectionPins } from '../../utils/connectionPins'

// Minimal in-memory stand-in for the Dexie tables the v17 upgrade touches.
function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  return {
    map,
    get: async (id) => map.get(id),
    update: async (id, changes) => {
      const row = map.get(id)
      if (!row) return 0
      map.set(id, { ...row, ...changes })
      return 1
    },
    where: (field) => ({
      anyOf: (...values) => ({
        toArray: async () => [...map.values()].filter(r => values.flat().includes(r[field]))
      })
    })
  }
}

describe('namespaced set/event ids', () => {
  it('builds and parses ids', () => {
    expect(setExtId('match_1_abc', 12)).toBe('match_1_abc:s:12')
    expect(eventExtId('match_1_abc', 40)).toBe('match_1_abc:e:40')
    expect(parseExtId('match_1_abc:s:12')).toEqual({ seedKey: 'match_1_abc', kind: 'set', localId: 12 })
    expect(parseExtId('match_1_abc:e:40')).toEqual({ seedKey: 'match_1_abc', kind: 'event', localId: 40 })
    expect(parseExtId('12')).toBeNull()
  })

  it('two matches with the same Dexie set id produce different external ids', () => {
    expect(setExtId('match_1_aaa', 3)).not.toBe(setExtId('match_2_bbb', 3))
    expect(eventExtId('match_1_aaa', 42)).not.toBe(eventExtId('match_2_bbb', 42))
  })

  it('recognises the legacy bare form', () => {
    expect(isBareLocalId('42')).toBe(true)
    expect(isBareLocalId(42)).toBe(true)
    expect(isBareLocalId('match_1:s:42')).toBe(false)
    expect(isBareLocalId('match_1_set_2')).toBe(false)
    expect(isBareLocalId(undefined)).toBe(false)
  })
})

describe('Dexie v17 upgrade: rewriteQueuedSyncJobs', () => {
  const matches = () => fakeTable([
    { id: 1, seed_key: 'match_100_aaa' },
    { id: 2, seed_key: 'match_200_bbb' }
  ])
  const sets = () => fakeTable([
    { id: 5, matchId: 1, index: 1 },
    { id: 6, matchId: 2, index: 1 }
  ])

  it('rewrites queued set insert, set update and event jobs, and drops orphans', async () => {
    const queue = fakeTable([
      // set insert: seed from payload.match_id
      { id: 1, resource: 'set', action: 'insert', status: 'queued', payload: { external_id: '5', match_id: 'match_100_aaa', index: 1 } },
      // set update (no match_id): seed from the local set's match
      { id: 2, resource: 'set', action: 'update', status: 'error', payload: { external_id: '6', finished: true } },
      // event insert
      { id: 3, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: '40', match_id: 'match_200_bbb', type: 'point' } },
      // orphan event: no seed anywhere
      { id: 4, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: '41' } },
      // orphan set update: local set is gone
      { id: 5, resource: 'set', action: 'update', status: 'queued', payload: { external_id: '99', finished: true } },
      // already namespaced: untouched
      { id: 6, resource: 'set', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:s:7', match_id: 'match_100_aaa' } },
      // already sent: untouched
      { id: 7, resource: 'event', action: 'insert', status: 'sent', payload: { external_id: '12', match_id: 'match_100_aaa' } },
      // match job: untouched
      { id: 8, resource: 'match', action: 'update', status: 'queued', payload: { id: 'match_100_aaa', status: 'live' } }
    ])

    const result = await rewriteQueuedSyncJobs({ queue, sets: sets(), matches: matches() })
    expect(result).toEqual({ rewritten: 3, dropped: 2 })

    expect(queue.map.get(1).payload.external_id).toBe('match_100_aaa:s:5')
    expect(queue.map.get(1).payload.index).toBe(1)
    expect(queue.map.get(1).status).toBe('queued')
    expect(queue.map.get(2).payload.external_id).toBe('match_200_bbb:s:6')
    expect(queue.map.get(2).payload.finished).toBe(true)
    expect(queue.map.get(3).payload.external_id).toBe('match_200_bbb:e:40')
    expect(queue.map.get(4).status).toBe('dropped')
    expect(queue.map.get(5).status).toBe('dropped')
    expect(queue.map.get(6).payload.external_id).toBe('match_100_aaa:s:7')
    expect(queue.map.get(7).payload.external_id).toBe('12')
    expect(queue.map.get(8).payload).toEqual({ id: 'match_100_aaa', status: 'live' })
  })

  it('does not take a resolved cloud UUID as the seed', async () => {
    const job = {
      resource: 'set',
      action: 'insert',
      payload: { external_id: '5', match_id: '0b7c6c1e-2f7e-4a8e-9d3c-1a2b3c4d5e6f' }
    }
    // Falls back to the local set's match instead
    expect(await resolveJobExternalId(job, { sets: sets(), matches: matches() })).toEqual({ external_id: 'match_100_aaa:s:5' })
  })

  it('leaves non set/event jobs alone', async () => {
    expect(await resolveJobExternalId({ resource: 'match', payload: { id: 'x' } }, { sets: sets(), matches: matches() })).toBeNull()
  })
})

describe('jobMatchKey', () => {
  it('finds the match of every job kind', () => {
    expect(jobMatchKey({ resource: 'match', action: 'insert', payload: { external_id: 'm1' } })).toBe('m1')
    expect(jobMatchKey({ resource: 'match', action: 'update', payload: { id: 'm1' } })).toBe('m1')
    expect(jobMatchKey({ resource: 'match', action: 'restore', payload: { match: { external_id: 'm1' } } })).toBe('m1')
    expect(jobMatchKey({ resource: 'set', action: 'insert', payload: { match_id: 'm1', external_id: 'm1:s:3' } })).toBe('m1')
    expect(jobMatchKey({ resource: 'set', action: 'update', payload: { external_id: 'm1:s:3' } })).toBe('m1')
    expect(jobMatchKey({ resource: 'event', action: 'insert', payload: { external_id: '7' } })).toBeNull()
  })
})

describe('buildConnectionPins', () => {
  it('builds every role from the local match and skips empty PINs', () => {
    expect(buildConnectionPins({
      refereePin: '111111',
      homeTeamPin: 222222,
      awayTeamPin: '',
      homeTeamUploadPin: null,
      awayTeamUploadPin: ' 555555 '
    })).toEqual({ referee: '111111', bench_home: '222222', upload_away: '555555' })
    expect(buildConnectionPins(null)).toEqual({})
  })
})
