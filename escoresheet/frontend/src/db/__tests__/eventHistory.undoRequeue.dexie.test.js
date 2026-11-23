// Audit LOG-18 (round 3), against the real app database (Dexie 4 on
// fake-indexeddb). A decision change removes the point's sub-rows (the
// side-out rotation line-up, the automatic libero exit) through
// Scoreboard discardEvents, which also deletes their inserts still queued.
// Its undo puts them back under their old ids (db.events.bulkPut): only a
// 'restore' revision was queued, never the insert again. Offline (or before
// the queue reached them) the server never got those rows: a void and a
// restore were stored for an event it did not have. Now the restore brings
// the event's insert back, before the restore; never a second one where the
// device still holds an insert of it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { queueEventSync } from '../../utils/eventSync'
import { withActivityContext, eventHistorySettled, rememberSeedKey } from '../eventHistory'
import { syncJobsForEvents } from '../../domain/corrections'

const seed = 'match_1792931096817_auditdcu'

const settle = async () => {
  await new Promise(r => setTimeout(r, 30))
  await eventHistorySettled()
  await new Promise(r => setTimeout(r, 30))
}

let matchId
beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  matchId = await db.matches.add({ seed_key: seed, status: 'live', test: false })
  rememberSeedKey(matchId, seed, false)
})

// A side-out point and the sub-rows the scoreboard writes with it
// (addSyncedSubEvent: added and queued in the point's action)
async function sideOutPoint() {
  const pointId = await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team: 'away' }, seq: 10, ts: new Date().toISOString() })
  await queueEventSync(db, pointId)
  const ids = {}
  await db.transaction('rw', db.tables, async () => {
    ids.lineup = await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: 7, II: 1, III: 2, IV: 3, V: 4, VI: 5 } }, seq: 10.1, ts: new Date().toISOString() })
    await queueEventSync(db, ids.lineup)
    ids.exit = await db.events.add({ matchId, setIndex: 1, type: 'libero_exit', payload: { team: 'away', position: 'IV', liberoOut: 10, playerIn: '3', reason: 'rotation_to_front_row' }, seq: 10.2, ts: new Date().toISOString() })
    await queueEventSync(db, ids.exit)
  })
  return ids
}

// The decision change (one action over db.tables, as runAction): discardEvents
async function decisionChange(subIds) {
  const subs = await db.events.bulkGet(subIds)
  await db.transaction('rw', db.tables, async () => {
    await withActivityContext({ reason: 'decision_change' }, () => db.events.bulkDelete(subIds))
    const queued = await db.sync_queue.where('status').equals('queued').toArray()
    const jobs = syncJobsForEvents(queued, subIds, seed)
    if (jobs.length > 0) await db.sync_queue.bulkDelete(jobs.map(j => j.id))
  })
  await settle()
  return subs
}

// Its undo: the removed sub-rows back with bulkPut (same ids)
async function undo(subs) {
  await db.transaction('rw', db.tables, async () => {
    await withActivityContext({ reason: 'undo' }, () => db.events.bulkPut(subs))
  })
  await settle()
}

const jobsOf = async (id) => (await db.sync_queue.orderBy('id').toArray())
  .filter(j => j.payload?.external_id === `${seed}:e:${id}`)
  .map(j => `${j.action}/${j.status}`)

describe('undo of a decision change made offline', () => {
  it('the restored line-up and libero exit get their inserts again, each before its restore', async () => {
    const ids = await sideOutPoint()
    const subs = await decisionChange([ids.lineup, ids.exit])
    // the change left a void and no insert for each
    expect(await jobsOf(ids.lineup)).toEqual(['void/queued'])
    expect(await jobsOf(ids.exit)).toEqual(['void/queued'])

    await undo(subs)

    expect(await db.events.get(ids.lineup)).toBeTruthy()
    expect(await jobsOf(ids.lineup)).toEqual(['void/queued', 'insert/queued', 'restore/queued'])
    expect(await jobsOf(ids.exit)).toEqual(['void/queued', 'insert/queued', 'restore/queued'])
    // the insert carries the row as the scoreboard sent it first (eventSync buildEventInsertJob)
    const insert = (await db.sync_queue.toArray()).find(j => j.action === 'insert' && j.payload.external_id === `${seed}:e:${ids.exit}`)
    expect(insert.payload).toMatchObject({
      match_id: seed, set_index: 1, type: 'libero_exit', seq: 10.2, test: false,
      payload: { team: 'away', position: 'IV', liberoOut: 10, playerIn: '3', reason: 'rotation_to_front_row' }
    })
  })

  it('an insert the device still holds (sent, or parked) is not queued twice', async () => {
    const ids = await sideOutPoint()
    // the line-up row's insert went out before the change; the exit's was refused and parked
    const jobs = await db.sync_queue.toArray()
    const lineupInsert = jobs.find(j => j.action === 'insert' && j.payload.external_id === `${seed}:e:${ids.lineup}`)
    const exitInsert = jobs.find(j => j.action === 'insert' && j.payload.external_id === `${seed}:e:${ids.exit}`)
    await db.sync_queue.update(lineupInsert.id, { status: 'sent' })
    await db.sync_queue.update(exitInsert.id, { status: 'failed' })
    const subs = await decisionChange([ids.lineup, ids.exit])
    await undo(subs)
    expect(await jobsOf(ids.lineup)).toEqual(['insert/sent', 'void/queued', 'restore/queued'])
    expect(await jobsOf(ids.exit)).toEqual(['insert/failed', 'void/queued', 'restore/queued'])
  })

  it('a test match: nothing for the server', async () => {
    await db.matches.update(matchId, { test: true })
    rememberSeedKey(matchId, seed, true)
    const ids = await sideOutPoint()
    const subs = await decisionChange([ids.lineup, ids.exit])
    await undo(subs)
    expect(await db.sync_queue.count()).toBe(0)
  })
})
