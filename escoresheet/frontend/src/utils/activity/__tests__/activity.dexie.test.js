// The activity log on the real app database (Dexie 4 on fake-indexeddb):
// entries from the database writes, the writer, retention.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { db } from '../../../db/db'
import { withActivityContext, eventHistorySettled } from '../../../db/eventHistory'
import { startActivityLog, listActivity, SYNC } from '..'
import { emitActivity, flushActivityNow } from '../bus'
import { setActiveMatch } from '../activeMatch'
import { createActivityWriter } from '../writer'

const SEED = 'match_1759740000000_ab12cd'
const settle = async (ms = 30) => {
  await new Promise(r => setTimeout(r, ms))
  await eventHistorySettled()
  await flushActivityNow(500)
}
const kinds = async () => (await db.activity_log.orderBy('lid').toArray()).map(r => r.kind)

describe('activity log', () => {
  let log
  let matchId
  let homeTeamId
  beforeAll(async () => {
    await db.open()
    log = startActivityLog({ db })
  })
  afterAll(() => log.stop())
  beforeEach(async () => {
    await settle()
    await Promise.all(db.tables.map(t => t.clear()))
    homeTeamId = await db.teams.add({ name: 'Home' })
    const awayTeamId = await db.teams.add({ name: 'Away' })
    matchId = await db.matches.add({ status: 'live', seed_key: SEED, homeTeamId, awayTeamId, gameNumber: 7 })
    setActiveMatch(await db.matches.get(matchId))
    await settle()
    await db.activity_log.clear()
  })

  it('records an added event with the score of its snapshot, and its undo', async () => {
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 3, payload: { team: 'home' } })
    await db.events.update(id, { stateSnapshot: { pointsA: 1, pointsB: 0 } })
    await settle()
    let rows = await db.activity_log.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'event.add', matchId, matchExt: SEED, setIndex: 1, eventSeq: 3, synced: SYNC.PENDING, app: 'indoor', level: 'info' })
    expect(rows[0].data).toEqual({ type: 'point', seq: 3, set: 1, team: 'home', scoreA: 1, scoreB: 0 })
    expect(rows[0].deviceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].appVersion).toBe('0.0.0-test')

    await withActivityContext({ reason: 'undo', actionId: 'a1' }, () => db.events.delete(id))
    await settle()
    rows = await db.activity_log.orderBy('lid').toArray()
    expect(rows.map(r => r.kind)).toEqual(['event.add', 'event.undo'])
    expect(rows[1].data).toMatchObject({ type: 'point', seq: 3, reason: 'undo', actionId: 'a1' })
    expect(rows[1].eventExt).toBe(`${SEED}:e:${id}`)
  })

  it('an event that waits for its snapshot keeps the time of its add (order of play)', async () => {
    const t0 = Date.now()
    // a sub-event without a snapshot: told after SNAPSHOT_WAIT_MS, dated at its add
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', seq: 3.1, payload: { team: 'home' } })
    await new Promise(r => setTimeout(r, 50))
    const id = await db.events.add({ matchId, setIndex: 1, type: 'point', seq: 4, payload: { team: 'away' } })
    await db.events.update(id, { stateSnapshot: { pointsA: 1, pointsB: 1 } })
    await new Promise(r => setTimeout(r, 2200))
    await settle()
    const rows = await db.activity_log.orderBy('ts').toArray()
    expect(rows.map(r => r.eventSeq)).toEqual([3.1, 4])
    expect(Date.parse(rows[0].ts) - t0).toBeLessThan(1000)
  })

  it('an add still waiting for its snapshot is not lost when the app quits', async () => {
    await db.events.add({ matchId, setIndex: 2, type: 'lineup', seq: 36, payload: { team: 'away' } })
    await new Promise(r => setTimeout(r, 30)) // committed, now waiting (SNAPSHOT_WAIT_MS)
    await flushActivityNow(500) // what the quit and pagehide do
    const rows = await db.activity_log.toArray()
    expect(rows.map(r => [r.kind, r.eventSeq])).toEqual([['event.add', 36]])
  })

  it('sets, the match row and the roster of the open match', async () => {
    const setId = await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    await db.sets.update(setId, { homePoints: 25, awayPoints: 20, finished: true })
    await db.matches.update(matchId, { status: 'ended', updatedAt: Date.now() })
    await db.matches.update(matchId, { homeCoachSignature: 'data:image/png;base64,AAAA' })
    await db.matches.update(matchId, { manualChanges: [{ category: 'player', field: 'dob', before: '1.1.2000', after: '2.1.2000' }] })
    await db.players.add({ teamId: homeTeamId, number: 7, name: 'A', dob: '01.01.2000' })
    await db.players.add({ teamId: 999, number: 8, name: 'Other team' })
    await settle()
    expect(await kinds()).toEqual(['set.start', 'set.end', 'match.status', 'match.signature', 'match.manual_change', 'match.roster'])
    const rows = await db.activity_log.orderBy('lid').toArray()
    expect(rows[1].data).toEqual({ set: 1, home: 25, away: 20 })
    expect(rows[3].data).toEqual({ role: 'homeCoach', signed: true })
    expect(rows[4].data).toEqual({ category: 'player', field: 'dob', before: 'changed', after: 'changed' })
    expect(rows[5].data).toEqual({ team: 'home', number: 7, op: 'add' })
    expect(JSON.stringify(rows)).not.toMatch(/data:image|2000/)
  })

  it('a test match stays local only; a big batch is one bulk entry', async () => {
    const testMatch = await db.matches.add({ status: 'live', seed_key: 'match_2_x', test: true })
    await db.transaction('rw', db.events, async () => {
      for (let i = 1; i <= 25; i++) await db.events.add({ matchId: testMatch, setIndex: 1, type: i % 2 ? 'point' : 'rally_start', seq: i, payload: {} })
    })
    await settle()
    const rows = (await db.activity_log.toArray()).filter(r => r.matchId === testMatch)
    expect(rows.map(r => r.kind)).toEqual(['match.create', 'event.bulk_add'])
    expect(rows.every(r => r.synced === SYNC.LOCAL)).toBe(true)
    expect(rows[1].data).toEqual({ count: 25, types: ['point:13', 'rally_start:12'] })
  })

  it('code without the database reports through the bus; errors are rate limited', async () => {
    emitActivity('sync.error', { resource: 'event', action: 'insert', status: 409, code: 'OV_MATCH_CLOSED', payload: { game_pin: '1' } }, { level: 'warn' })
    for (let i = 0; i < 8; i++) emitActivity('app.error', { message: 'boom', frames: ['a.js:1'] }, { level: 'error' })
    emitActivity('not.a_kind', {})
    await settle()
    const rows = await db.activity_log.orderBy('lid').toArray()
    expect(rows[0]).toMatchObject({ kind: 'sync.error', level: 'warn', data: { resource: 'event', action: 'insert', status: 409, code: 'OV_MATCH_CLOSED' } })
    expect(rows.filter(r => r.kind === 'app.error')).toHaveLength(5)
    expect(rows.some(r => r.kind === 'not.a_kind')).toBe(false)
    expect((await listActivity(db, { matchId: null })).length).toBe(rows.length)
  })
})

describe('activity writer retention', () => {
  it('keeps unsent rows, removes old sent ones, and caps the table', async () => {
    await db.open()
    await db.activity_log.clear()
    const now = Date.parse('2027-06-01T00:00:00Z')
    const old = new Date(now - 200 * 24 * 3600_000).toISOString()
    const recent = new Date(now - 1000).toISOString()
    const row = (uid, ts, synced) => ({ uid, ts, kind: 'app.start', level: 'info', matchId: null, data: {}, synced })
    await db.activity_log.bulkAdd([row('o1', old, SYNC.UPLOADED), row('o2', old, SYNC.PENDING), row('o3', old, SYNC.LOCAL), row('r1', recent, SYNC.UPLOADED)])
    const writer = createActivityWriter({ db, now: () => now })
    expect(await writer.prune()).toBe(2)
    expect((await db.activity_log.toArray()).map(r => r.uid).sort()).toEqual(['o2', 'r1'])
  })
})
