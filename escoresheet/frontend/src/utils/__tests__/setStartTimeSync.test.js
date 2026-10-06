import { describe, it, expect, beforeEach } from 'vitest'
import { queueSetStartTimeSync } from '../setStartTimeSync'
import { isScoreOnlySetUpdate } from '../eventSync'
import { setExtId } from '../syncIds'

function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  let nextId = Math.max(0, ...rows.map(r => r.id)) + 1
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    and: (fn) => collection(r => pred(r) && fn(r))
  })
  return {
    map,
    get: async (id) => map.get(id),
    add: async (row) => { const id = nextId++; map.set(id, { ...row, id }); return id },
    bulkDelete: async (ids) => { for (const id of ids) map.delete(id) },
    update: async (id, changes) => { map.set(id, { ...map.get(id), ...changes }) },
    where: (field) => ({ equals: (v) => collection(r => r[field] === v) })
  }
}

let db
beforeEach(() => {
  db = {
    matches: fakeTable([
      { id: 1, seed_key: 'match_100_aaa' },
      { id: 2, seed_key: 'match_200_bbb', test: true },
      { id: 3 }
    ]),
    sync_queue: fakeTable([])
  }
})

const jobs = () => [...db.sync_queue.map.values()]

describe('queueSetStartTimeSync', () => {
  it('also writes the confirmed time into the set insert job not sent yet', async () => {
    const external = setExtId('match_100_aaa', 6)
    db.sync_queue = fakeTable([
      { id: 1, resource: 'set', action: 'insert', status: 'error', payload: { external_id: external, index: 2, start_time: '2026-10-06T08:00:00.000Z' } },
      { id: 2, resource: 'set', action: 'insert', status: 'sent', payload: { external_id: external, start_time: '2026-10-06T08:00:00.000Z' } }
    ])
    await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })
    expect(db.sync_queue.map.get(1).payload).toEqual({ external_id: external, index: 2, start_time: '2026-10-06T08:22:00.000Z' })
    // A sent insert is left alone (the update job covers it)
    expect(db.sync_queue.map.get(2).payload.start_time).toBe('2026-10-06T08:00:00.000Z')
  })

  it('queues a set update with the confirmed start time, scoped to the match', async () => {
    expect(await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })).toBe(true)
    expect(jobs()).toEqual([expect.objectContaining({
      resource: 'set',
      action: 'update',
      status: 'queued',
      payload: { external_id: 'match_100_aaa:s:6', start_time: '2026-10-06T08:22:00.000Z' }
    })])
  })

  it('a re-confirm replaces the still queued one, and other set updates stay', async () => {
    db.sync_queue.map.set(50, { id: 50, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:6', home_points: 3, away_points: 2 } })
    await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })
    await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:23:00.000Z' })
    const startJobs = jobs().filter(j => 'start_time' in j.payload)
    expect(startJobs).toHaveLength(1)
    expect(startJobs[0].payload.start_time).toBe('2026-10-06T08:23:00.000Z')
    expect(db.sync_queue.map.has(50)).toBe(true)
  })

  it('is not mistaken for a score-only update (the running-score dedupe keeps it)', async () => {
    await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })
    expect(isScoreOnlySetUpdate(jobs()[0], 'match_100_aaa:s:6')).toBe(false)
  })

  it('queues nothing for test matches, matches without a seed key or without a time', async () => {
    expect(await queueSetStartTimeSync(db, { matchId: 2, setId: 7, startTime: '2026-10-06T08:22:00.000Z' })).toBe(false)
    expect(await queueSetStartTimeSync(db, { matchId: 3, setId: 8, startTime: '2026-10-06T08:22:00.000Z' })).toBe(false)
    expect(await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: null })).toBe(false)
    expect(await queueSetStartTimeSync(db, { matchId: 99, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })).toBe(false)
    expect(jobs()).toHaveLength(0)
  })

  it('never throws into the scoring flow', async () => {
    db.matches.get = async () => { throw new Error('IndexedDB closed') }
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await queueSetStartTimeSync(db, { matchId: 1, setId: 6, startTime: '2026-10-06T08:22:00.000Z' })).toBe(false)
    } finally {
      console.warn = warn
    }
  })
})
