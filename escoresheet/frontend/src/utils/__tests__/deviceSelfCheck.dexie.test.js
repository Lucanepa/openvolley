// The self-check and the open / reload / background rules
// (utils/deviceSelfCheck), against the real app database (Dexie 4 on
// fake-indexeddb). 2026-10-27: the owner's desktop app opened on the scoring
// screen of match 406970, a copy that had only reached the coin toss on that
// PC on 20.10 before the match was continued and closed on a phone the same
// day. Nothing told the PC: the copy made no write, so no refusal came, and
// it looked live for a week. The owner's rules since: the app opens on Home,
// a reload goes back into the match, 15 minutes hidden goes to Home, and a
// check removes nothing by itself.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../../db/db'
import {
  BACKGROUND_HOME_MS,
  HIDDEN_AT_KEY,
  OPEN_MATCH_KEY,
  checkCopiesOnServer,
  cleanUpDuplicateCopies,
  clearOpenMatch,
  copyState,
  findDuplicateCopies,
  hasOtherLocalCopy,
  lastActivityAt,
  lastScoredLiveMatch,
  matchToReopen,
  noteOpenMatch,
  readOpenMatch,
  runDeviceSelfCheck,
  trackBackground,
  unsentOfMatch,
  withinTimeout
} from '../deviceSelfCheck'
import { OPEN_MATCH_KEY as FIXTURE_KEY } from '../../__tests__/selfCheckFixtures'

const SEED = 'match_1792518507614_u2sbmb'
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms) => new Date(Date.now() - ms).toISOString()

beforeEach(async () => {
  await Promise.all(db.tables.map(table => table.clear()))
})

// An official match with its own teams (one player each) and `events`
// events (seq 1..n) at `at`
async function addMatch({ events = 0, at = ago(HOUR), teams = true, ...fields } = {}) {
  const home = teams ? await db.teams.add({ name: 'Home' }) : null
  const away = teams ? await db.teams.add({ name: 'Away' }) : null
  if (teams) await db.players.bulkAdd([{ teamId: home, number: 1 }, { teamId: away, number: 1 }])
  const id = await db.matches.add({
    status: 'live', seed_key: SEED, gameN: 406970, createdAt: at, matchInfoConfirmedAt: at,
    homeTeamId: home, awayTeamId: away, ...fields
  })
  for (let seq = 1; seq <= events; seq++) {
    await db.events.add({ matchId: id, setIndex: 1, type: seq === 1 ? 'coin_toss' : 'point', seq, ts: at, payload: {} })
  }
  return id
}

describe('findDuplicateCopies: two copies of one official match are flagged, never removed', () => {
  it('an empty second copy is flagged as removable and stays', async () => {
    const kept = await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0, status: 'scheduled', at: ago(2 * DAY) })
    await db.sets.add({ matchId: empty, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    const r = await findDuplicateCopies(db)

    expect(r.flagged).toEqual([{ id: empty, key: SEED, gameN: '406970', keptId: kept, removable: true }])
    expect(await db.matches.get(empty)).toBeTruthy()
    expect(await db.sets.where('matchId').equals(empty).count()).toBe(1)
  })

  it('a copy whose events the kept one all has is removable', async () => {
    const kept = await addMatch({ events: 5 })
    const older = await addMatch({ events: 3 })
    const r = await findDuplicateCopies(db)
    expect(r.flagged).toEqual([{ id: older, key: SEED, gameN: '406970', keptId: kept, removable: true }])
  })

  it('two copies each holding something: the one less far on is flagged, not removable', async () => {
    const kept = await addMatch({ events: 5 })
    const other = await addMatch({ events: 2 })
    await db.events.add({ matchId: other, setIndex: 1, type: 'timeout', seq: 9, ts: ago(HOUR), payload: {} })
    const r = await findDuplicateCopies(db)
    expect(r.flagged).toEqual([{ id: other, key: SEED, gameN: '406970', keptId: kept, removable: false }])
  })

  it.each([
    ['a signature', { awayCaptainSignature: 'data:image/png;base64,AAA' }],
    ['an approval', { approved: true }],
    ['remarks', { remarks: 'Net height checked' }],
    ['officials', { officials: [{ role: '1st referee', firstName: 'Anna', lastName: 'Muster' }] }],
    ['a later status', { status: 'ended' }]
  ])('%s the kept copy lacks: not removable', async (_, fields) => {
    await addMatch({ events: 5 })
    const other = await addMatch({ events: 0, ...fields })
    const r = await findDuplicateCopies(db)
    expect(r.flagged.map(c => [c.id, c.removable])).toEqual([[other, false]])
  })

  it('a roster the kept copy lacks: not removable', async () => {
    await addMatch({ events: 5, teams: false })
    const other = await addMatch({ events: 0 })
    expect((await findDuplicateCopies(db)).flagged.map(c => [c.id, c.removable])).toEqual([[other, false]])
  })

  it('event history (an undo, an edit) of a copy: not removable', async () => {
    await addMatch({ events: 5 })
    const other = await addMatch({ events: 1 })
    await db.event_history.add({ matchId: other, seq: 2, eventId: 77, revUid: 'rev-1', op: 'undo', ts: ago(HOUR) })
    expect((await findDuplicateCopies(db)).flagged.map(c => [c.id, c.removable])).toEqual([[other, false]])
  })

  it.each(['queued', 'sending', 'error', 'failed'])('an unsent write of the match (%s): no copy removable', async (status) => {
    await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:3`, match_id: SEED }, ts: ago(MIN), status })
    expect((await findDuplicateCopies(db)).flagged.map(c => [c.id, c.removable])).toEqual([[empty, false]])
  })

  it('the match open on the screen is never removable', async () => {
    await addMatch({ events: 5 })
    const open = await addMatch({ events: 0 })
    expect((await findDuplicateCopies(db, { openMatchId: open })).flagged.map(c => [c.id, c.removable])).toEqual([[open, false]])
  })

  it('with as many events, the copy with the latest activity is kept', async () => {
    const older = await addMatch({ events: 2, at: ago(3 * HOUR) })
    const newer = await addMatch({ events: 2, at: ago(10 * MIN) })
    expect((await findDuplicateCopies(db)).flagged).toEqual([{ id: older, key: SEED, gameN: '406970', keptId: newer, removable: true }])
  })

  it('leaves test matches, final copies and other matches alone', async () => {
    await addMatch({ events: 3, test: true, seed_key: 'test-match-1' })
    await addMatch({ events: 0, test: true, seed_key: 'test-match-1' })
    await addMatch({ events: 3, seed_key: 'match_1_a' })
    await addMatch({ events: 0, seed_key: 'match_2_b' })
    await addMatch({ events: 0, seed_key: 'match_1_a', status: 'final' })
    expect(await findDuplicateCopies(db)).toEqual({ flagged: [] })
    expect(await db.matches.count()).toBe(5)
  })
})

describe('cleanUpDuplicateCopies: Home\'s Clean up, after its question', () => {
  it('removes the copies that hold nothing of their own, with their own rows; the kept copy is untouched', async () => {
    const kept = await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0, status: 'scheduled', at: ago(2 * DAY) })
    const { homeTeamId, awayTeamId } = await db.matches.get(empty)
    await db.sets.add({ matchId: empty, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    await db.sync_queue.add({ resource: 'match', action: 'insert', payload: { external_id: SEED }, ts: ago(HOUR), status: 'sent' })

    const r = await cleanUpDuplicateCopies(db, { keys: [SEED] })

    expect(r.removed).toEqual([{ id: empty, key: SEED, gameN: '406970', keptId: kept, removable: true }])
    expect(await db.matches.get(empty)).toBeUndefined()
    expect(await db.sets.where('matchId').equals(empty).count()).toBe(0)
    expect(await db.teams.bulkGet([homeTeamId, awayTeamId])).toEqual([undefined, undefined])
    expect(await db.players.where('teamId').anyOf([homeTeamId, awayTeamId]).count()).toBe(0)
    // the match's jobs are the kept copy's too
    expect(await db.sync_queue.count()).toBe(1)
    const k = await db.matches.get(kept)
    expect(await db.events.where('matchId').equals(kept).count()).toBe(5)
    expect(await db.players.where('teamId').equals(k.homeTeamId).count()).toBe(1)
  })

  it('decides again at the click: a copy that holds something by then stays', async () => {
    await addMatch({ events: 5 })
    const other = await addMatch({ events: 0 })
    expect((await findDuplicateCopies(db)).flagged[0].removable).toBe(true)
    await db.events.add({ matchId: other, setIndex: 1, type: 'timeout', seq: 9, ts: ago(MIN), payload: {} })
    expect((await cleanUpDuplicateCopies(db)).removed).toEqual([])
    expect(await db.matches.get(other)).toBeTruthy()
  })

  it('a team row another match still uses stays (round 1, 92a288da)', async () => {
    const kept = await addMatch({ events: 5 })
    const { homeTeamId } = await db.matches.get(kept)
    const ownAway = await db.teams.add({ name: 'Away' })
    const empty = await addMatch({ events: 0, teams: false, homeTeamId, awayTeamId: ownAway })
    const r = await cleanUpDuplicateCopies(db)
    expect(r.removed.map(c => c.id)).toEqual([empty])
    expect(await db.teams.get(homeTeamId)).toBeTruthy()
    expect(await db.players.where('teamId').equals(homeTeamId).count()).toBe(1)
    expect(await db.teams.get(ownAway)).toBeUndefined()
  })

  it('only the matches named', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a' })
    const a2 = await addMatch({ events: 0, seed_key: 'match_1_a' })
    await addMatch({ events: 3, seed_key: 'match_2_b' })
    const b2 = await addMatch({ events: 0, seed_key: 'match_2_b' })
    expect((await cleanUpDuplicateCopies(db, { keys: ['match_2_b'] })).removed.map(c => c.id)).toEqual([b2])
    expect(await db.matches.get(a2)).toBeTruthy()
  })
})

describe('hasOtherLocalCopy', () => {
  it('another local row of the same official match', async () => {
    const a = await addMatch({ events: 1 })
    expect(await hasOtherLocalCopy(db, await db.matches.get(a))).toBe(false)
    const b = await addMatch({ events: 0 })
    expect(await hasOtherLocalCopy(db, await db.matches.get(a))).toBe(true)
    expect(await hasOtherLocalCopy(db, await db.matches.get(b))).toBe(true)
  })

  it('never for a test match or a match without a key', async () => {
    const t1 = await addMatch({ test: true, seed_key: 'test-match-1' })
    await addMatch({ test: true, seed_key: 'test-match-1' })
    expect(await hasOtherLocalCopy(db, await db.matches.get(t1))).toBe(false)
    expect(await hasOtherLocalCopy(db, { id: 99 })).toBe(false)
  })
})

describe('lastActivityAt', () => {
  it('is the newest event, else the update, else the creation time', () => {
    const match = { createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z' }
    expect(lastActivityAt(match, { ts: '2026-10-20T12:00:00.000Z' })).toBe(Date.parse('2026-10-20T12:00:00.000Z'))
    expect(lastActivityAt(match, { ts: Date.parse('2026-10-20T12:30:00.000Z') })).toBe(Date.parse('2026-10-20T12:30:00.000Z'))
    expect(lastActivityAt(match, null)).toBe(Date.parse('2026-10-20T11:00:00.000Z'))
    expect(lastActivityAt({ createdAt: '2026-10-20T10:00:00.000Z' }, { ts: 'not a time' })).toBe(Date.parse('2026-10-20T10:00:00.000Z'))
    expect(lastActivityAt({}, null)).toBeNull()
  })
})

describe('copyState: what Home says about a copy', () => {
  it('closed, moved, scoring here, not checked; nothing for a test match', () => {
    expect(copyState({ status: 'live', seed_key: SEED, cloudBlock: { code: 'OV_MATCH_CLOSED' } })).toBe('closed')
    expect(copyState({ status: 'live', seed_key: SEED, closed_at: '2026-10-20T18:40:00.000Z' })).toBe('closed')
    expect(copyState({ status: 'approved', seed_key: SEED })).toBe('closed')
    // moved, then closed on the other device: closed
    expect(copyState({ status: 'final', seed_key: SEED, cloudBlock: { code: 'OV_SCORER_MOVED', closed: true } })).toBe('closed')
    expect(copyState({ status: 'live', seed_key: SEED, cloudBlock: { code: 'OV_SCORER_MOVED' } })).toBe('moved')
    expect(copyState({ status: 'live', seed_key: SEED }, { checkedHere: true })).toBe('here')
    expect(copyState({ status: 'live', seed_key: SEED })).toBe('unchecked')
    expect(copyState({ status: 'live', test: true })).toBeNull()
  })
})

describe('unsentOfMatch: what removing a copy would lose', () => {
  it('its unsent writes and those set aside as closed or moved; not sent ones, not other matches', () => {
    const jobs = [
      { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:2`, match_id: SEED }, status: 'queued' },
      { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:3`, match_id: SEED }, status: 'superseded', superseded_by: 'server-closed' },
      { resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:1`, match_id: SEED }, status: 'superseded', superseded_by: 'scorer-moved' },
      { resource: 'match', action: 'update', payload: { id: SEED }, status: 'error' },
      { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:1`, match_id: SEED }, status: 'sent' },
      // superseded by a newer write of its own: that one carries the data
      { resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:2`, match_id: SEED }, status: 'superseded', superseded_by: 'newer' },
      { resource: 'event', action: 'insert', payload: { external_id: 'match_2_b:e:1', match_id: 'match_2_b' }, status: 'queued' }
    ]
    expect(unsentOfMatch(jobs, SEED)).toEqual({ changes: 4, events: 2 })
    expect(unsentOfMatch(jobs, null)).toEqual({ changes: 0, events: 0 })
  })
})

// The server side, injected: readRows (one /api/db read), noteClosed (the
// sync queue's own marking), scoringDevice (askScoringDevice)
function fakeServer(rows, { error = null, scorer = 'here' } = {}) {
  return {
    readRows: vi.fn(async () => (error ? { data: null, error } : { data: rows, error: null })),
    noteClosed: vi.fn(async (id) => {
      await db.matches.update(id, { cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: Date.now() } })
      return true
    }),
    scoringDevice: vi.fn(async () => scorer)
  }
}
const closedRow = { id: 'a6f3', external_id: SEED, status: 'final', closed_at: '2026-10-20T18:40:00.000Z' }
const openRow = { id: 'a6f3', external_id: SEED, status: 'live', closed_at: null }

describe('runDeviceSelfCheck', () => {
  it('offline: copies flagged, the server not asked, nothing removed', async () => {
    await addMatch({ events: 3, at: ago(30 * MIN) })
    const empty = await addMatch({ events: 0, at: ago(5 * MIN) })
    const r = await runDeviceSelfCheck({ database: db })
    expect(r).toMatchObject({ flagged: [{ id: empty, removable: true }], closed: [], here: [], asked: false })
    expect(await db.matches.get(empty)).toBeTruthy()
  })

  it('the owner\'s case: closed on the server, the copy is marked, its scoring device not asked', async () => {
    const id = await addMatch({ events: 1, at: ago(HOUR) })
    const server = fakeServer([closedRow])
    const r = await runDeviceSelfCheck({ database: db, server })
    expect(server.readRows).toHaveBeenCalledWith([SEED])
    expect(server.noteClosed).toHaveBeenCalledWith(id)
    expect(server.scoringDevice).not.toHaveBeenCalled()
    expect(r).toMatchObject({ closed: [{ id, key: SEED, gameN: '406970' }], here: [], asked: true })
  })

  it('open on the server and scored here: "here"', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([openRow])
    const r = await runDeviceSelfCheck({ database: db, server })
    expect(server.scoringDevice).toHaveBeenCalledWith(SEED)
    expect(server.noteClosed).not.toHaveBeenCalled()
    expect(r).toMatchObject({ here: [id], moved: [], asked: true })
  })

  it('open on the server and scored on another device: "moved"', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, server: fakeServer([openRow], { scorer: 'moved' }) })
    expect(r).toMatchObject({ here: [], moved: [{ id, key: SEED }] })
  })

  it('the scoring device unknown (no answer): neither', async () => {
    await addMatch({ events: 3, at: ago(20 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, server: fakeServer([openRow], { scorer: null }) })
    expect(r).toMatchObject({ here: [], moved: [], asked: true })
  })

  it('not on the server: scored nowhere else, "here", the scoring device not asked', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([])
    const r = await runDeviceSelfCheck({ database: db, server })
    expect(r.here).toEqual([id])
    expect(server.scoringDevice).not.toHaveBeenCalled()
  })

  it.each([
    ['approved, without the closed_at column (another account\'s match)', { external_id: SEED, status: 'approved' }, true],
    ['final, without the closed_at column', { external_id: SEED, status: 'final' }, true],
    ['reopened by an admin (ended, closed_at cleared)', { external_id: SEED, status: 'ended', closed_at: null }, false],
    ['ended, without the closed_at column', { external_id: SEED, status: 'ended' }, false]
  ])('a server row %s', async (_, row, closed) => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, server: fakeServer([row]) })
    expect(r.closed.map(c => c.id)).toEqual(closed ? [id] : [])
    expect(r.here).toEqual(closed ? [] : [id])
  })

  it('the read fails or throws: not asked, nothing marked', async () => {
    await addMatch({ events: 3, at: ago(20 * MIN) })
    const failing = fakeServer(null, { error: { message: 'Network unavailable', status: 0, network: true } })
    expect(await runDeviceSelfCheck({ database: db, server: failing })).toMatchObject({ asked: false, here: [], closed: [] })
    expect(failing.scoringDevice).not.toHaveBeenCalled()
    const throwing = fakeServer([])
    throwing.readRows.mockRejectedValue(new Error('boom'))
    expect(await runDeviceSelfCheck({ database: db, server: throwing })).toMatchObject({ asked: false, here: [] })
  })

  it('a test match: no server read', async () => {
    await addMatch({ events: 3, at: ago(20 * MIN), test: true, seed_key: 'test-match-1' })
    const server = fakeServer([])
    await runDeviceSelfCheck({ database: db, server })
    expect(server.readRows).not.toHaveBeenCalled()
    expect(server.scoringDevice).not.toHaveBeenCalled()
  })

  it('one read for every open official copy; final, test and known-closed copies are not asked about', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a', at: ago(20 * MIN) })
    await addMatch({ events: 3, seed_key: 'match_2_b', status: 'scheduled' })
    await addMatch({ events: 3, seed_key: 'match_3_c', status: 'final' })
    await addMatch({ events: 3, seed_key: 'match_4_d', cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } })
    await addMatch({ events: 3, seed_key: 'test-match-1', test: true })
    const server = fakeServer([])
    await runDeviceSelfCheck({ database: db, server })
    expect(server.readRows).toHaveBeenCalledTimes(1)
    expect(server.readRows.mock.calls[0][0].sort()).toEqual(['match_1_a', 'match_2_b'])
  })

  it('two copies of one match: their scoring device asked once', async () => {
    const a = await addMatch({ events: 3 })
    const b = await addMatch({ events: 0 })
    const server = fakeServer([openRow])
    const r = await runDeviceSelfCheck({ database: db, server })
    expect(server.scoringDevice).toHaveBeenCalledTimes(1)
    expect(r.here.sort()).toEqual([a, b].sort())
  })
})

describe('checkCopiesOnServer: one copy (Continue)', () => {
  it('asks about that copy only', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a' })
    const id = await addMatch({ events: 3 })
    const server = fakeServer([closedRow])
    const r = await checkCopiesOnServer(db, server, { onlyIds: [id] })
    expect(server.readRows).toHaveBeenCalledWith([SEED])
    expect(r.closed.map(c => c.id)).toEqual([id])
  })
})

describe('withinTimeout', () => {
  it('says whether the work answered in time', async () => {
    expect(await withinTimeout(Promise.resolve(3), 50)).toEqual({ done: true, value: 3 })
    expect(await withinTimeout(new Promise(() => {}), 10)).toEqual({ done: false })
    expect(await withinTimeout(Promise.reject(new Error('x')), 50)).toEqual({ done: true, error: expect.any(Error) })
  })
})

// A sessionStorage of its own, and a document that is visible or hidden
function memoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    store
  }
}
function fakeDoc({ visibilityState = 'visible', wasDiscarded } = {}) {
  const listeners = new Map()
  return {
    visibilityState,
    wasDiscarded,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)),
    fire(type) { for (const fn of listeners.get(type) || []) fn() },
    set(state) { this.visibilityState = state; this.fire('visibilitychange') },
    count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0)
  }
}

describe('the reload marker (rule 2)', () => {
  it('notes the match screen on show, reads it back, clears it', () => {
    const storage = memoryStorage()
    expect(OPEN_MATCH_KEY).toBe(FIXTURE_KEY)
    noteOpenMatch({ id: 7, view: 'coinToss' }, storage)
    expect(readOpenMatch(storage)).toEqual({ id: 7, view: 'coinToss' })
    noteOpenMatch({ id: 7, view: 'home' }, storage)
    expect(readOpenMatch(storage)).toEqual({ id: 7, view: 'scoreboard' })
    clearOpenMatch(storage)
    expect(readOpenMatch(storage)).toBeNull()
    storage.setItem(OPEN_MATCH_KEY, 'not json')
    expect(readOpenMatch(storage)).toBeNull()
  })
})

describe('matchToReopen: an opening lands on Home, a reload goes back', () => {
  it('no marker (the app started, a new tab, after a crash or a kill): Home, whatever is live', async () => {
    await addMatch({ events: 3, at: ago(MIN) })
    expect(await matchToReopen(db, { storage: memoryStorage(), doc: fakeDoc() })).toBeNull()
  })

  it('the marker names a match on the device: that match, on its screen', async () => {
    const id = await addMatch({ events: 3, status: 'scheduled' })
    const storage = memoryStorage()
    noteOpenMatch({ id, view: 'matchSetup' }, storage)
    expect(await matchToReopen(db, { storage, doc: fakeDoc() })).toEqual({ id, view: 'matchSetup' })
  })

  it('a marker naming a match no longer on the device: Home', async () => {
    const storage = memoryStorage()
    noteOpenMatch({ id: 4242 }, storage)
    expect(await matchToReopen(db, { storage, doc: fakeDoc() })).toBeNull()
  })

  it('a discarded tab without a marker: the live match last scored here, never a closed or moved copy', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a', at: ago(2 * HOUR) })
    const recent = await addMatch({ events: 3, seed_key: 'match_2_b', at: ago(5 * MIN) })
    await addMatch({ events: 3, seed_key: 'match_3_c', at: ago(MIN), cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } })
    await addMatch({ events: 3, seed_key: 'match_4_d', at: ago(MIN), cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, at: 1 } })
    expect(await lastScoredLiveMatch(db)).toMatchObject({ id: recent })
    expect(await matchToReopen(db, { storage: memoryStorage(), doc: fakeDoc({ wasDiscarded: true }) })).toEqual({ id: recent, view: 'scoreboard' })
  })

  it('hidden 15 minutes or more before the page went (discarded in the background): Home', async () => {
    const id = await addMatch({ events: 3 })
    const storage = memoryStorage()
    noteOpenMatch({ id }, storage)
    const now = Date.now()
    storage.setItem(HIDDEN_AT_KEY, String(now - BACKGROUND_HOME_MS))
    expect(await matchToReopen(db, { storage, doc: fakeDoc({ wasDiscarded: true }), now })).toBeNull()
    // a reload a moment after its pagehide: back into the match
    storage.setItem(HIDDEN_AT_KEY, String(now - 200))
    expect(await matchToReopen(db, { storage, doc: fakeDoc(), now })).toEqual({ id, view: 'scoreboard' })
    // the page is up: the hidden-since time is consumed
    expect(storage.getItem(HIDDEN_AT_KEY)).toBeNull()
  })
})

describe('trackBackground: only hidden time counts (rule 3)', () => {
  function track(doc, win, storage, start = 0) {
    let now = start
    const back = vi.fn()
    const stop = trackBackground(back, { minHiddenMs: 15 * MIN, doc, win, storage, now: () => now })
    return { back, stop, advance: (ms) => { now += ms } }
  }

  it('hidden 16 minutes: called back; 5 minutes: not; visible however long: never', () => {
    const doc = fakeDoc()
    const storage = memoryStorage()
    const t = track(doc, null, storage)
    t.advance(60 * MIN) // visible and idle
    doc.set('visible')
    expect(t.back).not.toHaveBeenCalled()
    doc.set('hidden')
    expect(storage.getItem(HIDDEN_AT_KEY)).not.toBeNull()
    t.advance(5 * MIN)
    doc.set('visible')
    expect(t.back).not.toHaveBeenCalled()
    expect(storage.getItem(HIDDEN_AT_KEY)).toBeNull()
    doc.set('hidden')
    t.advance(16 * MIN)
    doc.set('visible')
    expect(t.back).toHaveBeenCalledTimes(1)
    expect(t.back).toHaveBeenCalledWith(16 * MIN)
    t.stop()
    expect(doc.count()).toBe(0)
  })

  it('a page kept in the back-forward cache (pagehide / pageshow), and Cordova\'s pause / resume', () => {
    const doc = fakeDoc()
    const win = fakeDoc()
    const t = track(doc, win, memoryStorage())
    win.fire('pagehide')
    t.advance(20 * MIN)
    win.fire('pageshow')
    expect(t.back).toHaveBeenCalledTimes(1)
    doc.fire('pause')
    t.advance(16 * MIN)
    doc.fire('resume')
    expect(t.back).toHaveBeenCalledTimes(2)
    t.stop()
  })

  it('a resume while the page is still hidden waits for it to show', () => {
    const doc = fakeDoc()
    const t = track(doc, null, memoryStorage())
    doc.set('hidden')
    t.advance(20 * MIN)
    doc.fire('resume')
    expect(t.back).not.toHaveBeenCalled()
    doc.set('visible')
    expect(t.back).toHaveBeenCalledTimes(1)
  })

  it('the Capacitor App plugin\'s appStateChange, where the app has it', async () => {
    const doc = fakeDoc()
    let onState = null
    const remove = vi.fn()
    const win = { ...fakeDoc(), Capacitor: { Plugins: { App: { addListener: vi.fn((type, fn) => { onState = fn; return Promise.resolve({ remove }) }) } } } }
    const t = track(doc, win, memoryStorage())
    expect(win.Capacitor.Plugins.App.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function))
    onState({ isActive: false })
    t.advance(15 * MIN)
    onState({ isActive: true })
    expect(t.back).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    t.stop()
    await Promise.resolve()
    expect(remove).toHaveBeenCalled()
  })

  it('a page that starts hidden counts from the time kept before the reload', () => {
    const doc = fakeDoc({ visibilityState: 'hidden' })
    const storage = memoryStorage()
    storage.setItem(HIDDEN_AT_KEY, String(50 * MIN))
    const t = track(doc, null, storage, 60 * MIN)
    t.advance(6 * MIN)
    doc.set('visible')
    expect(t.back).toHaveBeenCalledWith(16 * MIN)
  })
})
