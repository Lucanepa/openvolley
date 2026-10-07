// Event history hooks against the real app database (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { syncJobsForEvents } from '../../domain/corrections'
import { eventExtId } from '../../utils/syncIds'
import {
  maxVoidedSeq as maxVoidedSeqOf, wipeMatchEvents as wipeMatchEventsOf,
  withActivityContext, eventHistorySettled, EVENT_HISTORY_SCOPE, onEventHistory, rememberSeedKey
} from '../eventHistory'

const maxVoidedSeq = (matchId) => maxVoidedSeqOf(db, matchId)
const wipeMatchEvents = (matchId, opts) => wipeMatchEventsOf(db, matchId, opts)

const SEED = 'match_1759740000000_ab12cd'
const settle = async () => {
  await new Promise(r => setTimeout(r, 20))
  await eventHistorySettled()
}

async function seedMatch({ test = false } = {}) {
  const matchId = await db.matches.add({ status: 'live', seed_key: SEED, test })
  return matchId
}

const revisionJobs = async () => (await db.sync_queue.toArray()).filter(j => j.resource === 'event' && j.action !== 'insert')

describe('event history hooks', () => {
  let matchId
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    matchId = await seedMatch()
  })

  it('a delete leaves a void history row and a void sync job', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: { team: 'home' }, stateSnapshot: { pointsA: 1, pointsB: 0 } })
    await db.events.delete(id)
    await settle()

    const hist = await db.event_history.toArray()
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ matchId, eventId: id, op: 'void', reason: 'delete', seq: 3, type: 'point', eventExt: `${SEED}:e:${id}` })
    expect(hist[0].before).toMatchObject({ type: 'point', payload: { team: 'home' } })
    expect(hist[0].before.stateSnapshot).toBeUndefined()
    expect(hist[0].revUid).toMatch(/^[0-9a-f-]{36}$/)

    const jobs = await revisionJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ resource: 'event', action: 'void', status: 'queued' })
    expect(jobs[0].payload).toMatchObject({ external_id: `${SEED}:e:${id}`, match_id: SEED, rev_uid: hist[0].revUid, reason: 'delete', seq: 3, type: 'point', op: 'void' })
    expect(jobs[0].payload.state_snapshot).toBeUndefined()
  })

  it('takes the reason and action id of the surrounding context', async () => {
    const a = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 4, payload: {} })
    const b = await db.events.add({ matchId, setIndex: 1, type: 'lineup', seq: 4.1, payload: {} })
    await withActivityContext({ reason: 'undo', actionId: 'act-1' }, () => db.events.bulkDelete([a, b]))
    await settle()
    const hist = await db.event_history.toArray()
    expect(hist.map(h => h.reason)).toEqual(['undo', 'undo'])
    expect(hist.map(h => h.actionId)).toEqual(['act-1', 'act-1'])
  })

  it('ignores the snapshot fill of a new event, records a snapshot or payload edit', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'timeout', seq: 5, payload: { team: 'home' } })
    await db.events.update(id, { stateSnapshot: { pointsA: 3, pointsB: 2 } })
    await settle()
    expect(await db.event_history.count()).toBe(0)

    // bookkeeping only: nothing
    await db.events.update(id, { _synced: true })
    await settle()
    expect(await db.event_history.count()).toBe(0)

    // score at the time of the event corrected (existing snapshot rewritten)
    await withActivityContext({ reason: 'manual_adjustment' }, () =>
      db.events.update(id, { stateSnapshot: { pointsA: 4, pointsB: 2 }, payload: { team: 'away' } }))
    await settle()
    const hist = await db.event_history.toArray()
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ op: 'edit', reason: 'manual_adjustment', before: { payload: { team: 'home' } }, after: { payload: { team: 'away' } } })
    expect(hist[0].changed.sort()).toEqual(['payload.team', 'stateSnapshot.pointsA'])
    const [job] = await revisionJobs()
    expect(job.action).toBe('edit')
    expect(job.payload.after).toEqual({ type: 'timeout', set_index: 1, payload: { team: 'away' }, score_a: 4, score_b: 2 })
  })

  it('records a key-path edit with the full row after it', async () => {
    const id = await db.events.add({ matchId, setIndex: 2, type: 'point', seq: 9, payload: { team: 'home', x: 1 } })
    await db.events.update(id, { 'payload.team': 'away' })
    await settle()
    const [h] = await db.event_history.toArray()
    expect(h.changed).toEqual(['payload.team'])
    expect(h.after.payload).toEqual({ team: 'away', x: 1 })
  })

  it('a whole-match wipe writes no history; dropHistory removes the old rows', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 1, payload: {} })
    await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 2, payload: {} })
    await db.events.delete(id)
    await settle()
    expect(await db.event_history.count()).toBe(1)
    await wipeMatchEvents(matchId)
    await settle()
    expect(await db.event_history.count()).toBe(1)
    expect(await db.events.count()).toBe(0)
    await wipeMatchEvents(matchId, { dropHistory: true })
    expect(await db.event_history.count()).toBe(0)
  })

  it('Table.clear() (clear all data) writes no history', async () => {
    await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 1, payload: {} })
    await db.events.clear()
    await settle()
    expect(await db.event_history.count()).toBe(0)
    // and the hooks still run afterwards
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 2, payload: {} })
    await db.events.delete(id)
    await settle()
    expect(await db.event_history.count()).toBe(1)
  })

  it('keeps the history local for test matches and lightweight events', async () => {
    const testMatch = await seedMatch({ test: true })
    const e1 = await db.events.add({ matchId: testMatch, setIndex: 1, type: 'point', seq: 1, payload: {} })
    const e2 = await db.events.add({ matchId, setIndex: 1, type: 'rally_start', seq: 2, payload: {} })
    await db.events.bulkDelete([e1, e2])
    await settle()
    expect(await db.event_history.count()).toBe(2)
    expect(await revisionJobs()).toHaveLength(0)
  })

  it('maxVoidedSeq is the high-water seq of undone events', async () => {
    expect(await maxVoidedSeq(matchId)).toBe(0)
    const a = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 7, payload: {} })
    const b = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 8, payload: {} })
    await db.events.bulkDelete([a, b])
    await settle()
    expect(await maxVoidedSeq(matchId)).toBe(8)
  })

  it('writes inside an action transaction that includes the history scope', async () => {
    rememberSeedKey(matchId, SEED, false)
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} })
    let seenInside = -1
    await db.transaction('rw', ['events', ...EVENT_HISTORY_SCOPE], async (tx) => {
      await db.events.delete(id)
      seenInside = await tx.table('event_history').count()
    })
    expect(seenInside).toBe(1)
    expect(await revisionJobs()).toHaveLength(1)
  })

  it('an aborted transaction leaves no history', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} })
    await expect(db.transaction('rw', db.events, async () => {
      await db.events.delete(id)
      throw new Error('abort')
    })).rejects.toThrow('abort')
    await settle()
    expect(await db.event_history.count()).toBe(0)
    expect(await db.events.count()).toBe(1)
  })

  it('an event put back under its old id after a void is a restore', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'lineup', seq: 3.1, payload: { team: 'home' } })
    const row = await db.events.get(id)
    await db.events.delete(id)
    await settle()
    await withActivityContext({ reason: 'undo' }, () => db.events.bulkPut([row]))
    // an explicit-id add of an event with no history is nothing
    await db.events.put({ id: 999, matchId, setIndex: 1, type: 'point', seq: 4, payload: {} })
    await settle()
    const hist = await db.event_history.orderBy('id').toArray()
    expect(hist.map(h => h.op)).toEqual(['void', 'restore'])
    expect(hist[1].reason).toBe('undo')
    const jobs = await revisionJobs()
    expect(jobs.map(j => j.action)).toEqual(['void', 'restore'])
    expect(jobs[1].payload.after).toMatchObject({ type: 'lineup', payload: { team: 'home' } })
  })

  it('the void job survives the discardEvents clean-up of the insert jobs (undo before upload)', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} })
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', ts: 1, payload: { external_id: eventExtId(SEED, id), match_id: SEED } })
    // Scoreboard discardEvents: delete, then drop the queued jobs of the events
    await withActivityContext({ reason: 'undo' }, () => db.events.bulkDelete([id]))
    await settle()
    const queued = await db.sync_queue.where('status').equals('queued').toArray()
    const stale = syncJobsForEvents(queued, [id])
    await db.sync_queue.bulkDelete(stale.map(j => j.id))
    const left = await db.sync_queue.toArray()
    expect(left.map(j => j.action)).toEqual(['void'])
    expect(left[0].payload.reason).toBe('undo')
  })

  it('tells listeners about stored rows', async () => {
    const seen = []
    const off = onEventHistory(r => seen.push(r.op))
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: {} })
    await db.events.delete(id)
    await settle()
    off()
    expect(seen).toEqual(['void'])
  })
})
