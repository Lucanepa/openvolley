// A match continued on another device (restore by game PIN, "Take back
// scoring here": importMatchFromSupabase), against the real app database
// (Dexie 4 on fake-indexeddb). Stress test 2026-10-25: the imported sets and
// events got new local ids, and every later write of the device derives its
// external_id from the local id, so the device wrote rows the cloud did not
// have (the open set froze at the score of the hand-over, the device's new
// rallies overwrote device A's events, an undo voided the wrong event).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { importMatchFromSupabase } from '../backupManager'
import { queueSetScoreSync, buildEventInsertJob } from '../eventSync'
import { withActivityContext, eventHistorySettled } from '../../db/eventHistory'
import { liveStateNow } from '../serverDataSync'

const seed = 'match_1792931096817_22rkmmhm'
// Device A had scored before (its Dexie counters at 120 events / 5 sets)
function cloudMatch({ idFloor } = {}) {
  return {
    match: {
      id: '11111111-1111-4111-8111-111111111111', external_id: seed, game_n: 939714, game_pin: '123456', status: 'live', test: false,
      sport_type: 'indoor', home_team: { name: 'Synthetic Home' }, away_team: { name: 'Synthetic Away' },
      coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' }, set_results: []
    },
    sets: [{ id: 'cloud-set-1', external_id: `${seed}:s:6`, index: 1, home_points: 12, away_points: 15, finished: false, start_time: '2026-10-25T12:25:00Z' }],
    events: Array.from({ length: 31 }, (_, i) => ({
      id: `cloud-event-${i}`,
      external_id: `${seed}:e:${121 + i}`, set_index: 1, seq: i + 1,
      type: ['coin_toss', 'set_start', 'lineup', 'lineup'][i] || 'point',
      payload: i < 4 ? {} : { team: i % 2 ? 'home' : 'away' }, ts: '2026-10-25T12:25:00Z'
    })),
    liveState: { id: 'live-1', match_id: '11111111-1111-4111-8111-111111111111', current_set: 1, points_a: 12, points_b: 15 },
    ...(idFloor ? { idFloor } : {})
  }
}

const settle = async () => {
  await new Promise(r => setTimeout(r, 20))
  await eventHistorySettled()
}

async function nextRallyJob(localMatchId, seq) {
  const match = await db.matches.get(localMatchId)
  const id = await db.events.add({ matchId: localMatchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq, ts: new Date().toISOString() })
  return buildEventInsertJob(await db.events.get(id), match).payload.external_id
}

describe('importMatchFromSupabase: the device continues the cloud rows', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('a fresh device writes the same set and event rows device A wrote', async () => {
    const localMatchId = await importMatchFromSupabase(cloudMatch())
    const sets = await db.sets.where('matchId').equals(localMatchId).toArray()
    const events = await db.events.where('matchId').equals(localMatchId).sortBy('seq')
    expect(sets.map(s => s.id)).toEqual([6])
    expect(events.map(e => e.id)).toEqual(Array.from({ length: 31 }, (_, i) => 121 + i))

    // the running score of set 1 updates A's set row
    await queueSetScoreSync(db, { matchId: localMatchId, setIndex: 1 })
    const setJob = (await db.sync_queue.where('resource').equals('set').toArray()).pop()
    expect(setJob.payload.external_id).toBe(`${seed}:s:6`)

    // the next rally gets an id none of A's events has
    expect(await nextRallyJob(localMatchId, 32)).toBe(`${seed}:e:152`)

    // the undo of A's last rally voids that rally
    await withActivityContext({ reason: 'undo' }, () => db.events.delete(151))
    await settle()
    const rev = (await db.sync_queue.where('resource').equals('event').toArray()).find(j => j.action === 'void')
    expect(rev.payload.external_id).toBe(`${seed}:e:151`)
    // nothing is re-keyed on the server
    expect((await db.sync_queue.toArray()).some(j => j.action === 'restore')).toBe(false)
  })

  it('new rows stay above the ids the match used on the server (voided events, revisions)', async () => {
    const localMatchId = await importMatchFromSupabase(cloudMatch({ idFloor: { set: 7, event: 160 } }))
    expect(await nextRallyJob(localMatchId, 32)).toBe(`${seed}:e:161`)
    const setId = await db.sets.add({ matchId: localMatchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    expect(setId).toBe(8)
    // the generator was moved without leaving a row (or a history entry) behind
    expect(await db.events.get(160)).toBeUndefined()
    expect(await db.event_history.count()).toBe(0)
  })

  it('ids held by another local match: new ids, and the cloud rows are re-keyed to them', async () => {
    const other = await db.matches.add({ seed_key: 'match_1_other', status: 'live' })
    await db.sets.add({ id: 6, matchId: other, index: 1, homePoints: 3, awayPoints: 1, finished: false })
    await db.events.add({ id: 130, matchId: other, setIndex: 1, type: 'point', seq: 1, payload: { team: 'home' } })

    const localMatchId = await importMatchFromSupabase(cloudMatch({ idFloor: { set: 6, event: 155 } }))
    // the other match's rows are untouched
    expect((await db.sets.get(6)).matchId).toBe(other)
    expect((await db.events.get(130)).matchId).toBe(other)

    const sets = await db.sets.where('matchId').equals(localMatchId).toArray()
    const events = await db.events.where('matchId').equals(localMatchId).sortBy('seq')
    expect(sets[0].id).toBeGreaterThan(6)
    expect(events[0].id).toBeGreaterThan(155)

    const restore = (await db.sync_queue.toArray()).find(j => j.action === 'restore')
    expect(restore).toMatchObject({ resource: 'match', status: 'queued' })
    expect(restore.payload.match).toEqual({ external_id: seed, status: 'live' })
    expect(restore.payload.sets.map(s => s.external_id)).toEqual(sets.map(s => `${seed}:s:${s.id}`))
    expect(restore.payload.events.map(e => e.external_id)).toEqual(events.map(e => `${seed}:e:${e.id}`))
    expect(restore.payload.sets[0]).toMatchObject({ index: 1, home_points: 12, away_points: 15, finished: false })
    expect(restore.payload.sets[0].id).toBeUndefined()
    expect(restore.payload.liveState).toEqual({ current_set: 1, points_a: 12, points_b: 15 })

    // later writes use the same ids as the re-keyed rows
    await queueSetScoreSync(db, { matchId: localMatchId, setIndex: 1 })
    const setJob = (await db.sync_queue.where('resource').equals('set').toArray()).pop()
    expect(setJob.payload.external_id).toBe(`${seed}:s:${sets[0].id}`)
  })

  // Stress test 2026-10-25: a tablet 3 min behind the laptop it took over
  // from; its live states all looked older than the laptop's last one, and the
  // referee, benches and livescore stayed on the laptop's score
  it('a device whose clock is behind stamps its live states after the last one in the cloud', async () => {
    const ahead = Date.now() + 180000
    const data = cloudMatch()
    data.liveState = { ...data.liveState, updated_at: new Date(ahead).toISOString() }
    const localMatchId = await importMatchFromSupabase(data)
    const match = await db.matches.get(localMatchId)
    expect(liveStateNow(match)).toBeGreaterThan(ahead)
    // a clock ahead of the cloud's last state already: as it is
    const behind = cloudMatch()
    behind.liveState = { ...behind.liveState, updated_at: new Date(Date.now() - 60000).toISOString() }
    const other = await db.matches.get(await importMatchFromSupabase(behind))
    expect(other.liveClockOffsetMs).toBe(0)
  })

  // 2026-10-26: restore-by-pin with claim made this device the scorer
  // already; a queued claim would wait for a sign-in for nothing (and, kept
  // unsent, hide a later move of the match from this device)
  it('a claim already made by restore-by-pin is not queued again; without one it is', async () => {
    await importMatchFromSupabase({ ...cloudMatch(), scorerClaimed: true })
    expect((await db.sync_queue.toArray()).filter(j => j.action === 'scorer')).toEqual([])
    await importMatchFromSupabase(cloudMatch())
    expect((await db.sync_queue.toArray()).filter(j => j.action === 'scorer').map(j => j.payload)).toEqual([{ id: seed }])
  })

  it('a device that had its own copy of the match replaces it and keeps the cloud ids', async () => {
    const stale = await db.matches.add({ seed_key: seed, status: 'live' })
    await db.sets.add({ id: 6, matchId: stale, index: 1, homePoints: 10, awayPoints: 12, finished: false })
    await db.events.add({ id: 121, matchId: stale, setIndex: 1, type: 'coin_toss', seq: 1, payload: {} })

    const localMatchId = await importMatchFromSupabase(cloudMatch())
    expect((await db.sets.get(6)).matchId).toBe(localMatchId)
    expect((await db.events.get(121)).matchId).toBe(localMatchId)
    expect(await db.matches.get(stale)).toBeUndefined()
    expect((await db.sync_queue.toArray()).some(j => j.action === 'restore')).toBe(false)
  })
})
