// A scorer action (useScorerActions.runAction) and the event history
// (db/eventHistory) against the real app database (Dexie 4 on fake-indexeddb,
// the db.events hooks installed): the void rows and void jobs of the events an
// action takes back are written INSIDE its transaction, so they commit with it
// or not at all, and carry the action's reason.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { useRef } from 'react'
import { renderHook } from '@testing-library/react'
import Dexie from 'dexie'
import { db } from '../../db/db'
import {
  withActivityContext, currentActivityContext, eventHistorySettled, rememberSeedKey, maxVoidedSeq,
  EVENT_HISTORY_SCOPE
} from '../../db/eventHistory'
import { planPointRemoval, syncJobsForEvents } from '../../domain/corrections'
import { eventExtId } from '../../utils/syncIds'
import { useScorerActions } from '../useScorerActions'

const SEED = 'match_1759740000000_tx01ab'

const settle = async () => {
  await new Promise(r => setTimeout(r, 20))
  await eventHistorySettled()
}

// The scoreboard's runAction over the app database (no screen: the commit
// callback runs at once)
function useActions() {
  const mutexRef = useRef(false)
  const commits = useRef({ nextGen: () => 1, afterCommit: (_gen, fn) => fn() }).current
  return useScorerActions({ db, commits, mutexRef, captureFinalSnapshot: async () => null, onError: () => {} })
}

function mountActions() {
  const { result } = renderHook(() => useActions())
  return result.current
}

// Scoreboard discardEvents: delete under the action's reason (else the given
// one), then drop the removed events' queued INSERT jobs (the void jobs the
// deletion queued stay)
async function discardEvents(rows, reason) {
  await withActivityContext({ reason: currentActivityContext()?.reason || reason }, () => db.events.bulkDelete(rows.map(e => e.id)))
  const queued = await db.sync_queue.where('status').equals('queued').toArray()
  const jobs = syncJobsForEvents(queued, rows.map(e => e.id))
  if (jobs.length > 0) await db.sync_queue.bulkDelete(jobs.map(j => j.id))
}

// Set 1 at 2:1; the away point 4 sided out (rotation 4.1, automatic libero_exit 4.2)
async function seedRally(matchId) {
  const ids = {}
  const add = async (key, row) => {
    ids[key] = await db.events.add({ matchId, setIndex: 1, payload: {}, ...row })
    if (row.type !== 'rally_start') {
      await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', ts: 1, payload: { external_id: eventExtId(SEED, ids[key]), match_id: SEED } })
    }
  }
  await add('p1', { type: 'point', seq: 1, payload: { team: 'home' } })
  await add('p2', { type: 'point', seq: 2, payload: { team: 'home' } })
  await add('rally', { type: 'rally_start', seq: 3 })
  await add('p4', { type: 'point', seq: 4, payload: { team: 'away' } })
  await add('rot', { type: 'lineup', seq: 4.1, payload: { team: 'away', lineup: { I: '4' } } })
  await add('exit', { type: 'libero_exit', seq: 4.2, payload: { team: 'away', liberoOut: 9, playerIn: 5 } })
  return ids
}

// The undo of the newest point, as the scoreboard does it inside its action
async function undoNewestPoint(matchId, { failAfterDelete = false } = {}) {
  const all = await db.events.where('matchId').equals(matchId).toArray()
  const plan = planPointRemoval(all, null, { setIndex: 1, includeRallyStart: true })
  const ids = new Set(plan.deleteEventIds)
  await discardEvents(all.filter(e => ids.has(e.id)))
  if (failAfterDelete) throw new Error('forced failure after the delete')
  return plan
}

const historyRows = () => db.event_history.orderBy('id').toArray()
const jobsOf = async (action) => (await db.sync_queue.toArray()).filter(j => j.resource === 'event' && j.action === action)

describe('runAction and the event history', () => {
  let matchId
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    matchId = await db.matches.add({ status: 'live', seed_key: SEED, test: false })
    rememberSeedKey(matchId, SEED, false)
  })

  it('the action transaction covers the event history tables (db.tables)', () => {
    const names = db.tables.map(t => t.name)
    for (const name of EVENT_HISTORY_SCOPE) expect(names).toContain(name)
    expect(names).toContain('event_history')
    expect(names).toContain('activity_log')
  })

  it('an undo inside runAction: one void row per removed event and their void jobs, written in its transaction', async () => {
    const ids = await seedRally(matchId)
    const { runAction } = mountActions()

    let insideHistory = -1
    let insideStoreNames = []
    await runAction('undo', async () => {
      await undoNewestPoint(matchId)
      // the hooks wrote synchronously into this transaction
      insideHistory = await db.event_history.count()
      insideStoreNames = [...(Dexie.currentTransaction?.storeNames || [])]
    }, { reason: 'undo' })

    expect(insideStoreNames).toEqual(expect.arrayContaining(['events', 'event_history', 'sync_queue', 'activity_log']))
    const removed = [ids.p4, ids.rot, ids.exit, ids.rally]
    expect(insideHistory).toBe(removed.length)

    // no after-commit write is needed: the rows are there as the action resolves
    const hist = await historyRows()
    expect(hist.map(h => h.eventId).sort((a, b) => a - b)).toEqual([...removed].sort((a, b) => a - b))
    expect(hist.every(h => h.op === 'void' && h.reason === 'undo')).toBe(true)
    // one action id for the whole undo
    expect(new Set(hist.map(h => h.actionId)).size).toBe(1)
    expect(hist[0].actionId).toBeTruthy()

    // void jobs for the events the server knows of (the rally_start is local only)
    const voids = await jobsOf('void')
    expect(voids.map(j => j.payload.external_id).sort()).toEqual([ids.p4, ids.rot, ids.exit].map(id => eventExtId(SEED, id)).sort())
    expect(voids.every(j => j.payload.reason === 'undo')).toBe(true)
    // the removed events' unsent inserts are gone, the others stay
    const inserts = await jobsOf('insert')
    expect(inserts.map(j => j.payload.external_id).sort()).toEqual([ids.p1, ids.p2].map(id => eventExtId(SEED, id)).sort())

    // and nothing more is written after the commit
    await settle()
    expect(await db.event_history.count()).toBe(removed.length)
    expect(await jobsOf('void')).toHaveLength(3)

    // the undone seq is never given out again (getNextSeq high-water)
    expect(await maxVoidedSeq(db, matchId)).toBe(4.2)
  })

  it('a failed undo leaves the events, the queue and the history as they were', async () => {
    const ids = await seedRally(matchId)
    const eventsBefore = await db.events.orderBy('id').toArray()
    const queueBefore = await db.sync_queue.orderBy('id').toArray()
    const { runAction } = mountActions()

    await expect(runAction('undo', () => undoNewestPoint(matchId, { failAfterDelete: true }), { reason: 'undo' }))
      .rejects.toThrow('forced failure')
    await settle()

    expect(await db.events.orderBy('id').toArray()).toEqual(eventsBefore)
    expect(await db.sync_queue.orderBy('id').toArray()).toEqual(queueBefore)
    expect(await db.event_history.count()).toBe(0)
    expect(await maxVoidedSeq(db, matchId)).toBe(0)
    expect(await db.events.get(ids.p4)).toBeTruthy()
    // the context is not left behind
    expect(currentActivityContext()).toBeNull()
  })

  it('a replay joined to a decision change keeps the decision change\'s reason and action id', async () => {
    const ids = await seedRally(matchId)
    const { runAction } = mountActions()

    await runAction('decision', async () => {
      // handleReplayRally: its own runAction joins the running one
      await runAction('decision', async () => {
        const all = await db.events.where('matchId').equals(matchId).toArray()
        const plan = planPointRemoval(all, all.find(e => e.id === ids.p4))
        const del = new Set(plan.deleteEventIds)
        await discardEvents(all.filter(e => del.has(e.id)))
      }, { reason: 'decision_change' })
    }, { reason: 'decision_change' })

    const hist = await historyRows()
    expect(hist).toHaveLength(3)
    expect(hist.every(h => h.reason === 'decision_change')).toBe(true)
    expect(new Set(hist.map(h => h.actionId)).size).toBe(1)
    const voids = await jobsOf('void')
    expect(voids).toHaveLength(3)
    // the replayed point's insert job is dropped (it was never sent); its void is kept
    expect((await jobsOf('insert')).some(j => j.payload.external_id === eventExtId(SEED, ids.p4))).toBe(false)
    expect(voids.some(j => j.payload.external_id === eventExtId(SEED, ids.p4))).toBe(true)
  })

  it('without a reason a delete in an action is a plain delete', async () => {
    const ids = await seedRally(matchId)
    const { runAction } = mountActions()
    await runAction('x', () => discardEvents([{ id: ids.p1 }]))
    const [row] = await historyRows()
    expect(row).toMatchObject({ eventId: ids.p1, op: 'void', reason: 'delete' })
  })
})
