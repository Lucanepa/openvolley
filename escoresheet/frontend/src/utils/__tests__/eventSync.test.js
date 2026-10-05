import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildEventInsertJob,
  queueEventSync,
  queueSetScoreSync,
  isScoreOnlySetUpdate,
  buildSetEndMatchPayload,
  setLiveStateDirty,
  isLiveStateDirty,
  isLiveStateErrorWorthAlert
} from '../eventSync'

// In-memory stand-in for the Dexie tables used here
function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  let nextId = Math.max(0, ...rows.map(r => r.id)) + 1
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0],
    and: (fn) => collection(r => pred(r) && fn(r))
  })
  return {
    map,
    get: async (id) => map.get(id),
    add: async (row) => { const id = nextId++; map.set(id, { ...row, id }); return id },
    bulkDelete: async (ids) => { for (const id of ids) map.delete(id) },
    where: (field) => ({ equals: (v) => collection(r => r[field] === v) })
  }
}

let db
beforeEach(() => {
  db = {
    matches: fakeTable([
      { id: 1, seed_key: 'match_100_aaa' },
      { id: 2, seed_key: 'match_200_bbb', test: true }
    ]),
    sets: fakeTable([
      { id: 5, matchId: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { id: 6, matchId: 1, index: 2, homePoints: 3, awayPoints: 2, finished: false },
      { id: 7, matchId: 2, index: 1, homePoints: 1, awayPoints: 0 }
    ]),
    events: fakeTable([
      { id: 40, matchId: 1, setIndex: 2, type: 'set_start', payload: { setIndex: 2, startTime: '2026-10-05T18:00:00.000Z' }, seq: 61, ts: '2026-10-05T18:00:00.000Z' },
      { id: 41, matchId: 1, setIndex: 2, type: 'lineup', payload: { team: 'home', lineup: { I: 1 }, isInitial: true }, seq: 60 },
      { id: 42, matchId: 2, setIndex: 1, type: 'lineup', payload: {}, seq: 1 }
    ]),
    sync_queue: fakeTable([])
  }
})

describe('queueEventSync', () => {
  it('queues set_start and lineup events with a match-scoped external id', async () => {
    expect(await queueEventSync(db, 40)).toBe(true)
    expect(await queueEventSync(db, 41)).toBe(true)
    const jobs = [...db.sync_queue.map.values()]
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({
      resource: 'event',
      action: 'insert',
      status: 'queued',
      payload: { external_id: 'match_100_aaa:e:40', match_id: 'match_100_aaa', set_index: 2, type: 'set_start', seq: 61, test: false }
    })
    expect(jobs[1].payload).toMatchObject({ external_id: 'match_100_aaa:e:41', type: 'lineup', payload: { isInitial: true } })
  })

  it('never queues test matches or unknown events, and never throws', async () => {
    expect(await queueEventSync(db, 42)).toBe(false)
    expect(await queueEventSync(db, 999)).toBe(false)
    expect(await queueEventSync(db, null)).toBe(false)
    expect(await queueEventSync({ events: { get: async () => { throw new Error('IDB') } } }, 40)).toBe(false)
    expect(db.sync_queue.map.size).toBe(0)
  })

  it('builds the job from the event row', () => {
    const job = buildEventInsertJob({ id: 3, setIndex: 1, type: 'lineup', payload: { a: 1 }, seq: 2, ts: 'T' }, { seed_key: 'm' })
    expect(job.payload).toEqual({ external_id: 'm:e:3', match_id: 'm', set_index: 1, type: 'lineup', payload: { a: 1 }, seq: 2, test: false, created_at: 'T' })
  })
})

describe('queueSetScoreSync', () => {
  it('queues the open set score and keeps only the newest queued one', async () => {
    await queueSetScoreSync(db, { matchId: 1, setIndex: 2 })
    db.sets.map.get(6).homePoints = 4
    await queueSetScoreSync(db, { matchId: 1, setIndex: 2 })
    const jobs = [...db.sync_queue.map.values()]
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      resource: 'set',
      action: 'update',
      status: 'queued',
      payload: { external_id: 'match_100_aaa:s:6', home_points: 4, away_points: 2 }
    })
  })

  it('leaves other set jobs alone (set end, other sets, already sent)', async () => {
    db.sync_queue.map.set(100, { id: 100, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:6', finished: true, home_points: 3, away_points: 2 } })
    db.sync_queue.map.set(101, { id: 101, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', home_points: 25, away_points: 20 } })
    db.sync_queue.map.set(102, { id: 102, resource: 'set', action: 'update', status: 'sending', payload: { external_id: 'match_100_aaa:s:6', home_points: 2, away_points: 2 } })
    await queueSetScoreSync(db, { matchId: 1, setIndex: 2 })
    expect(db.sync_queue.map.has(100)).toBe(true)
    expect(db.sync_queue.map.has(101)).toBe(true)
    expect(db.sync_queue.map.has(102)).toBe(true)
    expect(db.sync_queue.map.size).toBe(4)
  })

  it('skips test matches', async () => {
    expect(await queueSetScoreSync(db, { matchId: 2, setIndex: 1 })).toBe(false)
    expect(db.sync_queue.map.size).toBe(0)
  })

  it('recognises score-only updates', () => {
    const job = (payload, status = 'queued') => ({ resource: 'set', action: 'update', status, payload })
    expect(isScoreOnlySetUpdate(job({ external_id: 'x', home_points: 1, away_points: 0 }), 'x')).toBe(true)
    expect(isScoreOnlySetUpdate(job({ external_id: 'x', home_points: 1, finished: true }), 'x')).toBe(false)
    expect(isScoreOnlySetUpdate(job({ external_id: 'y', home_points: 1 }), 'x')).toBe(false)
    expect(isScoreOnlySetUpdate(job({ external_id: 'x', home_points: 1 }, 'sent'), 'x')).toBe(false)
  })
})

describe('buildSetEndMatchPayload', () => {
  const finishedSets = [
    { index: 2, homePoints: 20, awayPoints: 25 },
    { index: 1, homePoints: 25, awayPoints: 18 }
  ]

  it('a set end moves current_set on and publishes the finished sets', () => {
    expect(buildSetEndMatchPayload({ seedKey: 'm', finishedSets, isMatchEnd: false, nextSetIndex: 3, homeSetsWon: 1, awaySetsWon: 1 }))
      .toEqual({ id: 'm', current_set: 3, set_results: [{ set: 1, home: 25, away: 18 }, { set: 2, home: 20, away: 25 }] })
  })

  it('the match end carries the result', () => {
    const p = buildSetEndMatchPayload({ seedKey: 'm', finishedSets, isMatchEnd: true, homeSetsWon: 3, awaySetsWon: 1, sanctions: { a: 1 } })
    expect(p).toMatchObject({ id: 'm', status: 'ended', winner: 'home', final_score: '3-1', sanctions: { a: 1 } })
    expect(p.set_results).toHaveLength(2)
    expect('current_set' in p).toBe(false)
  })

  it('does not reorder the caller\'s array', () => {
    const sets = [...finishedSets]
    buildSetEndMatchPayload({ seedKey: 'm', finishedSets: sets, isMatchEnd: false, nextSetIndex: 3 })
    expect(sets[0].index).toBe(2)
  })
})

describe('live state catch-up flag', () => {
  it('is kept per match until a push succeeds', () => {
    expect(isLiveStateDirty(7)).toBe(false)
    setLiveStateDirty(7, true)
    expect(isLiveStateDirty(7)).toBe(true)
    expect(isLiveStateDirty(8)).toBe(false)
    setLiveStateDirty(7, false)
    expect(isLiveStateDirty(7)).toBe(false)
  })

  it('offline, signed out and server hiccups are caught up silently', () => {
    expect(isLiveStateErrorWorthAlert({ network: true, status: 0 })).toBe(false)
    expect(isLiveStateErrorWorthAlert({ status: 401 })).toBe(false)
    expect(isLiveStateErrorWorthAlert({ status: 429 })).toBe(false)
    expect(isLiveStateErrorWorthAlert({ status: 503 })).toBe(false)
    expect(isLiveStateErrorWorthAlert({ status: 400, code: 'OV_INVALID_DATA' })).toBe(true)
  })
})
