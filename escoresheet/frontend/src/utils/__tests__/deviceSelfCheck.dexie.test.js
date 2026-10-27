// The self-check on open (utils/deviceSelfCheck), against the real app
// database (Dexie 4 on fake-indexeddb). 2026-10-27: the owner's desktop app
// opened on the scoring screen of match 406970, a copy that had only reached
// the coin toss on that PC on 20.10 before the match was continued and closed
// on a phone the same day. Nothing told the PC: the copy made no write, so
// no refusal came, and it looked live for a week.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../../db/db'
import {
  STALE_LIVE_MS,
  checkCopiesOnServer,
  hasOtherLocalCopy,
  lastActivityAt,
  onBackAfterHidden,
  pickResumeMatch,
  runDeviceSelfCheck,
  settleDuplicateCopies,
  withinTimeout
} from '../deviceSelfCheck'

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

describe('settleDuplicateCopies: two copies of one official match', () => {
  it('keeps the copy furthest on and removes an empty one with its own rows', async () => {
    const kept = await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0, status: 'scheduled', at: ago(2 * DAY) })
    const { homeTeamId, awayTeamId } = await db.matches.get(empty)
    await db.sets.add({ matchId: empty, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    const r = await settleDuplicateCopies(db)

    expect(r.removed).toEqual([{ id: empty, key: SEED, gameN: '406970', keptId: kept }])
    expect(r.flagged).toEqual([])
    expect(await db.matches.get(empty)).toBeUndefined()
    expect(await db.sets.where('matchId').equals(empty).count()).toBe(0)
    expect(await db.teams.bulkGet([homeTeamId, awayTeamId])).toEqual([undefined, undefined])
    expect(await db.players.where('teamId').anyOf([homeTeamId, awayTeamId]).count()).toBe(0)
    // the kept copy is untouched
    const k = await db.matches.get(kept)
    expect(await db.events.where('matchId').equals(kept).count()).toBe(5)
    expect(await db.teams.get(k.homeTeamId)).toBeTruthy()
    expect(await db.players.where('teamId').equals(k.homeTeamId).count()).toBe(1)
  })

  it('removes a copy whose events the kept one all has', async () => {
    const kept = await addMatch({ events: 5 })
    const older = await addMatch({ events: 3 })
    const r = await settleDuplicateCopies(db)
    expect(r.removed.map(c => c.id)).toEqual([older])
    expect(await db.matches.get(kept)).toBeTruthy()
    expect(await db.events.where('matchId').equals(older).count()).toBe(0)
  })

  it('two copies each holding something: both stay, the one less far on is flagged', async () => {
    const kept = await addMatch({ events: 5 })
    const other = await addMatch({ events: 2 })
    await db.events.add({ matchId: other, setIndex: 1, type: 'timeout', seq: 9, ts: ago(HOUR), payload: {} })
    const r = await settleDuplicateCopies(db)
    expect(r.removed).toEqual([])
    expect(r.flagged).toEqual([{ id: other, key: SEED, gameN: '406970', keptId: kept }])
    expect(await db.matches.count()).toBe(2)
    expect(await db.events.where('matchId').equals(other).count()).toBe(3)
  })

  it.each([
    ['a signature', { awayCaptainSignature: 'data:image/png;base64,AAA' }],
    ['an approval', { approved: true }],
    ['remarks', { remarks: 'Net height checked' }],
    ['officials', { officials: [{ role: '1st referee', firstName: 'Anna', lastName: 'Muster' }] }],
    ['a later status', { status: 'ended' }]
  ])('%s the kept copy lacks keeps the copy', async (_, fields) => {
    await addMatch({ events: 5 })
    const other = await addMatch({ events: 0, ...fields })
    const r = await settleDuplicateCopies(db)
    expect(r.removed).toEqual([])
    expect(r.flagged.map(c => c.id)).toEqual([other])
    expect(await db.matches.get(other)).toBeTruthy()
  })

  it('a roster the kept copy lacks keeps the copy', async () => {
    await addMatch({ events: 5, teams: false })
    const other = await addMatch({ events: 0 })
    const r = await settleDuplicateCopies(db)
    expect(r.flagged.map(c => c.id)).toEqual([other])
  })

  it('event history (an undo, an edit) of a copy keeps it', async () => {
    await addMatch({ events: 5 })
    const other = await addMatch({ events: 1 })
    await db.event_history.add({ matchId: other, seq: 2, eventId: 77, revUid: 'rev-1', op: 'undo', ts: ago(HOUR) })
    const r = await settleDuplicateCopies(db)
    expect(r.flagged.map(c => c.id)).toEqual([other])
  })

  it.each(['queued', 'sending', 'error', 'failed'])('an unsent write of the match (%s) keeps every copy', async (status) => {
    await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:3`, match_id: SEED }, ts: ago(MIN), status })
    const r = await settleDuplicateCopies(db)
    expect(r.removed).toEqual([])
    expect(r.flagged.map(c => c.id)).toEqual([empty])
    expect(await db.sync_queue.count()).toBe(1)
  })

  it('sent writes of the match do not keep an empty copy, and stay', async () => {
    await addMatch({ events: 5 })
    const empty = await addMatch({ events: 0 })
    await db.sync_queue.add({ resource: 'match', action: 'insert', payload: { external_id: SEED }, ts: ago(HOUR), status: 'sent' })
    const r = await settleDuplicateCopies(db)
    expect(r.removed.map(c => c.id)).toEqual([empty])
    expect(await db.sync_queue.count()).toBe(1)
  })

  it('the match open on the screen is never removed', async () => {
    await addMatch({ events: 5 })
    const open = await addMatch({ events: 0 })
    const r = await settleDuplicateCopies(db, { openMatchId: open })
    expect(r.removed).toEqual([])
    expect(r.flagged.map(c => c.id)).toEqual([open])
  })

  it('a team row another match still uses stays (round 1, 92a288da)', async () => {
    const kept = await addMatch({ events: 5 })
    const { homeTeamId } = await db.matches.get(kept)
    const ownAway = await db.teams.add({ name: 'Away' })
    const empty = await addMatch({ events: 0, teams: false, homeTeamId, awayTeamId: ownAway })
    const r = await settleDuplicateCopies(db)
    expect(r.removed.map(c => c.id)).toEqual([empty])
    expect(await db.teams.get(homeTeamId)).toBeTruthy()
    expect(await db.players.where('teamId').equals(homeTeamId).count()).toBe(1)
    expect(await db.teams.get(ownAway)).toBeUndefined()
  })

  it('with as many events, the copy with the latest activity is kept', async () => {
    const older = await addMatch({ events: 2, at: ago(3 * HOUR) })
    const newer = await addMatch({ events: 2, at: ago(10 * MIN) })
    const r = await settleDuplicateCopies(db)
    expect(r.removed).toEqual([{ id: older, key: SEED, gameN: '406970', keptId: newer }])
  })

  it('leaves test matches, final copies and other matches alone', async () => {
    await addMatch({ events: 3, test: true, seed_key: 'test-match-1' })
    await addMatch({ events: 0, test: true, seed_key: 'test-match-1' })
    await addMatch({ events: 3, seed_key: 'match_1_a' })
    await addMatch({ events: 0, seed_key: 'match_2_b' })
    await addMatch({ events: 0, seed_key: 'match_1_a', status: 'final' })
    const r = await settleDuplicateCopies(db)
    expect(r).toEqual({ removed: [], flagged: [] })
    expect(await db.matches.count()).toBe(5)
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

describe('pickResumeMatch', () => {
  it('two live matches: the one with the most recent activity', async () => {
    const recent = await addMatch({ events: 3, seed_key: 'match_1_a', at: ago(5 * MIN) })
    await addMatch({ events: 3, seed_key: 'match_2_b', at: ago(2 * HOUR) })
    const pick = await pickResumeMatch(db)
    expect(pick).toMatchObject({ id: recent, stale: false })
  })

  it('a live match last active over 12 hours ago is stale; one a scorer restarts mid-match is not', async () => {
    const id = await addMatch({ events: 1, at: ago(7 * DAY) })
    expect(await pickResumeMatch(db)).toMatchObject({ id, stale: true })
    await db.events.where('matchId').equals(id).modify({ ts: ago(20 * MIN) })
    expect(await pickResumeMatch(db)).toMatchObject({ id, stale: false })
    await db.events.where('matchId').equals(id).modify({ ts: ago(STALE_LIVE_MS + MIN) })
    expect((await pickResumeMatch(db)).stale).toBe(true)
    await db.events.where('matchId').equals(id).modify({ ts: ago(STALE_LIVE_MS - HOUR) })
    expect((await pickResumeMatch(db)).stale).toBe(false)
  })

  it('never a copy the server has closed, nor a match that is not live', async () => {
    await addMatch({ events: 3, at: ago(MIN), cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } })
    await addMatch({ events: 3, seed_key: 'match_1_a', at: ago(MIN), status: 'ended' })
    expect(await pickResumeMatch(db)).toBeNull()
  })
})

// The server side, injected: readRows (one /api/db read), noteClosed (the
// sync queue's own marking), scorerMoved (checkScorerMoved)
function fakeServer(rows, { error = null } = {}) {
  return {
    readRows: vi.fn(async () => (error ? { data: null, error } : { data: rows, error: null })),
    noteClosed: vi.fn(async (id) => {
      await db.matches.update(id, { cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: Date.now() } })
      return true
    }),
    scorerMoved: vi.fn(async () => false)
  }
}
const closedRow = { id: 'a6f3', external_id: SEED, status: 'final', closed_at: '2026-10-20T18:40:00.000Z' }
const openRow = { id: 'a6f3', external_id: SEED, status: 'live', closed_at: null }

describe('runDeviceSelfCheck at start-up', () => {
  it('offline: a live match last active 20 minutes ago is resumed', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, resume: true })
    expect(r.resumeId).toBe(id)
  })

  it('offline: one last active 7 days ago is not (the stale rule)', async () => {
    const id = await addMatch({ events: 1, at: ago(7 * DAY) })
    const r = await runDeviceSelfCheck({ database: db, resume: true })
    expect(r.resumeId).toBeNull()
    expect(r.stale).toMatchObject({ id, gameN: '406970' })
  })

  it('the owner\'s case: closed on the server, the copy is marked and not resumed', async () => {
    const id = await addMatch({ events: 1, at: ago(HOUR) })
    const server = fakeServer([closedRow])
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(server.readRows).toHaveBeenCalledWith([SEED])
    expect(server.noteClosed).toHaveBeenCalledWith(id)
    expect(server.scorerMoved).not.toHaveBeenCalled()
    expect(r.resumeId).toBeNull()
    expect(r.closed).toEqual([{ id, key: SEED, gameN: '406970' }])
  })

  it('open on the server: resumed, and its scoring device is asked', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([openRow])
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBe(id)
    expect(server.scorerMoved).toHaveBeenCalledWith(SEED)
    expect(server.noteClosed).not.toHaveBeenCalled()
  })

  it('not on the server: resumed, and no device scores it there to ask about', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([])
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBe(id)
    expect(server.scorerMoved).not.toHaveBeenCalled()
  })

  it.each([
    ['approved, without the closed_at column (another account\'s match)', { external_id: SEED, status: 'approved' }, true],
    ['final, without the closed_at column', { external_id: SEED, status: 'final' }, true],
    ['reopened by an admin (ended, closed_at cleared)', { external_id: SEED, status: 'ended', closed_at: null }, false],
    ['ended, without the closed_at column', { external_id: SEED, status: 'ended' }, false]
  ])('a server row %s', async (_, row, closed) => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, resume: true, server: fakeServer([row]) })
    expect(r.resumeId).toBe(closed ? null : id)
  })

  it('the read fails: Part 1 decides', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer(null, { error: { message: 'Network unavailable', status: 0, network: true } })
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBe(id)
    expect(server.scorerMoved).not.toHaveBeenCalled()
  })

  it('the read throws: Part 1 decides', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([])
    server.readRows.mockRejectedValue(new Error('boom'))
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBe(id)
  })

  it('no answer within the timeout: resumed; a later "closed" is still applied', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN) })
    const server = fakeServer([])
    let answer
    server.readRows.mockReturnValue(new Promise(resolve => { answer = resolve }))
    const r = await runDeviceSelfCheck({ database: db, resume: true, server, timeoutMs: 50 })
    expect(r.resumeId).toBe(id)
    expect(r.late).toBeTruthy()
    answer({ data: [closedRow], error: null })
    expect(await r.late).toMatchObject({ closed: [{ id, key: SEED, gameN: '406970' }] })
    expect((await db.matches.get(id)).cloudBlock.code).toBe('OV_MATCH_CLOSED')
  })

  it('a test match: no server read', async () => {
    const id = await addMatch({ events: 3, at: ago(20 * MIN), test: true, seed_key: 'test-match-1' })
    const server = fakeServer([])
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBe(id)
    expect(server.readRows).not.toHaveBeenCalled()
    expect(server.scorerMoved).not.toHaveBeenCalled()
  })

  it('one read for every open official copy; final, test and known-closed copies are not asked about', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a', at: ago(20 * MIN) })
    await addMatch({ events: 3, seed_key: 'match_2_b', status: 'scheduled' })
    await addMatch({ events: 3, seed_key: 'match_3_c', status: 'final' })
    await addMatch({ events: 3, seed_key: 'match_4_d', cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } })
    await addMatch({ events: 3, seed_key: 'test-match-1', test: true })
    const server = fakeServer([])
    await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(server.readRows).toHaveBeenCalledTimes(1)
    expect(server.readRows.mock.calls[0][0].sort()).toEqual(['match_1_a', 'match_2_b'])
  })

  it('a stale live match is not resumed, so its scoring device is not asked', async () => {
    await addMatch({ events: 1, at: ago(7 * DAY) })
    const server = fakeServer([openRow])
    const r = await runDeviceSelfCheck({ database: db, resume: true, server })
    expect(r.resumeId).toBeNull()
    expect(server.scorerMoved).not.toHaveBeenCalled()
  })

  it('duplicates are settled before the resume is picked', async () => {
    const kept = await addMatch({ events: 3, at: ago(30 * MIN) })
    const empty = await addMatch({ events: 0, at: ago(5 * MIN) })
    const r = await runDeviceSelfCheck({ database: db, resume: true })
    expect(r.removed.map(c => c.id)).toEqual([empty])
    expect(r.resumeId).toBe(kept)
  })
})

describe('runDeviceSelfCheck back from the background', () => {
  it('resumes nothing; the open match is checked on the server and never removed', async () => {
    await addMatch({ events: 5, at: ago(2 * HOUR) })
    const open = await addMatch({ events: 0, at: ago(2 * HOUR) })
    const server = fakeServer([openRow])
    const r = await runDeviceSelfCheck({ database: db, server, openMatchId: open })
    expect(r.resumeId).toBeNull()
    expect(r.flagged.map(c => c.id)).toEqual([open])
    expect(server.scorerMoved).toHaveBeenCalledWith(SEED)
  })
})

describe('checkCopiesOnServer: one copy (Continue)', () => {
  it('asks about that copy only', async () => {
    await addMatch({ events: 3, seed_key: 'match_1_a' })
    const id = await addMatch({ events: 3 })
    const server = fakeServer([closedRow])
    const r = await checkCopiesOnServer(db, server, { onlyIds: [id], scorerCheckId: id })
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

describe('onBackAfterHidden', () => {
  function fakeDoc() {
    const listeners = new Set()
    return {
      visibilityState: 'visible',
      addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.add(fn) },
      removeEventListener: (type, fn) => listeners.delete(fn),
      set(state) { this.visibilityState = state; for (const fn of listeners) fn() },
      listeners
    }
  }

  it('calls back when the app comes back after being hidden for long enough', () => {
    const doc = fakeDoc()
    let now = 0
    const back = vi.fn()
    const stop = onBackAfterHidden(back, { minHiddenMs: HOUR, doc, now: () => now })
    doc.set('hidden')
    now = 20 * MIN
    doc.set('visible')
    expect(back).not.toHaveBeenCalled()
    doc.set('hidden')
    now += 2 * HOUR
    doc.set('visible')
    expect(back).toHaveBeenCalledTimes(1)
    stop()
    expect(doc.listeners.size).toBe(0)
  })
})
