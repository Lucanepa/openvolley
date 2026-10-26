import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore, createAttemptLimiter, createPinFailureBudget } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('createAttemptLimiter', () => {
  it('allows max attempts per key and window, then limits', () => {
    const l = createAttemptLimiter({ max: 2, windowMs: 60000 })
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), true)
    assert.equal(l.isLimited('b'), false)
    l.reset('a')
    assert.equal(l.isLimited('a'), false)
  })

  it('keeps the key map bounded, evicting the oldest windows first', () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 60000, maxKeys: 3 })
    for (let i = 0; i < 1000; i++) l.isLimited(`k${i}`)
    assert.equal(l.size, 3)
    // The newest keys are still counted, the oldest were evicted.
    assert.equal(l.isLimited('k999'), true)
    assert.equal(l.isLimited('k0'), false)
  })

  it('refund takes one attempt back', () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 60000 })
    assert.equal(l.isLimited('a'), false)
    l.refund('a')
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), true)
  })

  it('opens again after the window', async () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 20 })
    assert.equal(l.isLimited('k'), false)
    assert.equal(l.isLimited('k'), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(l.isLimited('k'), false)
  })
})

describe('createPinFailureBudget', () => {
  it('locks one scope of an address, for the right PIN too; other scopes and addresses go on', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 10, windowMs: 60000 })
    for (let i = 0; i < 3; i++) assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
    // the 4th attempt of that scope is refused before anything is compared
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), true)
    assert.equal(b.isLimited('hall', 'any:indoor:bench_home'), false)
    assert.equal(b.isLimited('hall', 'm:game:match-1'), false)
    assert.equal(b.isLimited('elsewhere', 'any:indoor:referee'), false)
  })

  it('a ceiling per address across scopes; refused attempts do not count toward it', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 5, windowMs: 60000 })
    for (let i = 0; i < 3; i++) b.isLimited('hall', 'a')
    // refused by the scope: not compared, not counted in the ceiling
    for (let i = 0; i < 10; i++) assert.equal(b.isLimited('hall', 'a'), true)
    assert.equal(b.isLimited('hall', 'b'), false)
    assert.equal(b.isLimited('hall', 'c'), false)
    // 5 counted: every scope of the address is refused now
    assert.equal(b.isLimited('hall', 'd'), true)
    assert.equal(b.isLimited('elsewhere', 'd'), false)
  })

  it('refund gives the attempt back to the scope and the ceiling', () => {
    const b = createPinFailureBudget({ max: 1, ipMax: 1, windowMs: 60000 })
    assert.equal(b.isLimited('hall', 'a'), false)
    b.refund('hall', 'a')
    assert.equal(b.isLimited('hall', 'b'), false)
    b.refund('hall', 'b')
    assert.equal(b.isLimited('hall', 'a'), false)
    assert.equal(b.isLimited('hall', 'a'), true)
  })

  it('the same wrong PIN again in the same scope is not a new guess', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 10, windowMs: 60000 })
    // one typo checked twice (the backend, then the relay)
    for (const pin of ['111111', '222222']) {
      assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
      assert.equal(b.repeated('hall', 'any:indoor:referee', pin), false)
      assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
      assert.equal(b.repeated('hall', 'any:indoor:referee', pin), true)
    }
    // two typos counted, not four: one more attempt, then the scope is locked
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), true)
    // the same PIN in another scope, or from another address, is a guess of its own
    assert.equal(b.isLimited('hall', 'any:indoor:bench_home'), false)
    assert.equal(b.repeated('hall', 'any:indoor:bench_home', '111111'), false)
    assert.equal(b.isLimited('other', 'any:indoor:referee'), false)
    assert.equal(b.repeated('other', 'any:indoor:referee', '111111'), false)
  })

  it('opens again after the window', async () => {
    const b = createPinFailureBudget({ max: 1, ipMax: 1, windowMs: 20 })
    assert.equal(b.isLimited('hall', 'a'), false)
    assert.equal(b.isLimited('hall', 'a'), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(b.isLimited('hall', 'a'), false)
  })
})

describe('matchRestore on Postgres', { skip: SKIP_PG }, () => {
  let tdb, db, restore, raw
  let seq = 0
  const uniq = (p = 'R') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const W = { proto: 2 }
  const count = async (table, matchId) => (await raw.query(`SELECT count(*)::int n FROM ${table} WHERE match_id = $1`, [matchId])).rows[0].n

  // One cloud match per official game (db/007): each backup its own game number by default
  let gameSeq = 70000
  function backup (ext, { sets = 2, events = 5, gameN = gameSeq++, pin = '424242', scheduledAt } = {}) {
    return {
      match: {
        external_id: ext,
        game_n: gameN,
        game_pin: pin,
        status: 'live',
        ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
        connection_pins: { referee: '111111' },
        home_team: { name: 'Home' },
        id: '00000000-0000-0000-0000-00000000dead' // ignored: keyed by external_id
      },
      sets: Array.from({ length: sets }, (_, i) => ({ id: 'ignored', external_id: `${ext}:s:${i + 1}`, index: i + 1, home_points: 25, away_points: 20 + i, sport_type: 'indoor' })),
      events: Array.from({ length: events }, (_, i) => ({ id: 123, external_id: `${ext}:e:${i + 1}`, set_index: 1, type: 'point', seq: i + 1, payload: { n: i }, sport_type: 'indoor' })),
      liveState: { points_a: 3, points_b: 2, current_set: 1, match_status: 'live', lineup_a: { I: 7 } }
    }
  }

  before(async () => {
    tdb = await createTestDatabase('restore')
    const logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    restore = createMatchRestore(db, { logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  describe('restoreMatch', () => {
    it('creates the match with its sets, events and live state in one go', async () => {
      const ext = uniq()
      const r = await restore.restoreMatch(backup(ext), W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 5, liveState: 1 })
      const id = r.body.data.id
      assert.notEqual(id, '00000000-0000-0000-0000-00000000dead')
      assert.equal(await count('sets', id), 2)
      assert.equal(await count('events', id), 5)
      assert.equal(await count('match_live_state', id), 1)
      const m = (await raw.query('SELECT external_id, game_pin, connection_pins FROM matches WHERE id = $1', [id])).rows[0]
      assert.deepEqual(m, { external_id: ext, game_pin: '424242', connection_pins: { referee: '111111' } })
      // Write-through feed: redacted rows for the realtime broadcast.
      assert.ok(r.changes.some(c => c.table === 'matches' && c.eventType === 'INSERT'))
      assert.ok(r.changes.every(c => !('game_pin' in c.row) && !('connection_pins' in c.row)))
      assert.equal(r.changes.filter(c => c.table === 'events').length, 5)
    })

    it('replaces the children of an existing match (and only of that match)', async () => {
      const ext = uniq(); const other = uniq()
      const first = await restore.restoreMatch(backup(ext, { sets: 3, events: 10 }), W)
      const keep = await restore.restoreMatch(backup(other, { sets: 1, events: 4 }), W)
      const again = await restore.restoreMatch(backup(ext, { sets: 1, events: 2 }), W)
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.equal(again.body.data.id, first.body.data.id)
      assert.deepEqual(again.body.data.counts, { sets: 1, events: 2, liveState: 1 })
      assert.equal(await count('events', first.body.data.id), 2)
      assert.equal(await count('sets', first.body.data.id), 1)
      assert.equal(await count('events', keep.body.data.id), 4)
      assert.ok(again.changes.some(c => c.table === 'matches' && c.eventType === 'UPDATE'))
    })

    it('rolls back everything when one event row is invalid', async () => {
      const ext = uniq()
      const ok = await restore.restoreMatch(backup(ext, { sets: 2, events: 3 }), W)
      const id = ok.body.data.id
      const bad = backup(ext, { sets: 1, events: 6 })
      bad.match.status = 'final'
      bad.events[4].set_index = 'not-a-number'
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '22P02')
      assert.match(r.body.error.details, /^events:/)
      assert.equal((await raw.query('SELECT status FROM matches WHERE id = $1', [id])).rows[0].status, 'live')
      assert.equal(await count('sets', id), 2)
      assert.equal(await count('events', id), 3)
      assert.equal(await count('match_live_state', id), 1)
    })

    it('rolls back when an event id is not scoped to the match', async () => {
      const ext = uniq()
      const ok = await restore.restoreMatch(backup(ext, { sets: 1, events: 2 }), W)
      const bad = backup(ext, { sets: 1, events: 3 })
      bad.events[2].external_id = '3' // a bare Dexie id
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      assert.equal(await count('events', ok.body.data.id), 2)
    })

    it('a brand-new match is not left behind when the restore fails', async () => {
      const ext = uniq()
      const bad = backup(ext)
      bad.liveState.points_a = 'x'
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.status, 400)
      assert.match(r.body.error.details, /^liveState:/)
      assert.equal((await raw.query('SELECT count(*)::int n FROM matches WHERE external_id = $1', [ext])).rows[0].n, 0)
    })

    it('needs X-OV-Proto >= 2', async () => {
      const r = await restore.restoreMatch(backup(uniq()), {})
      assert.equal(r.status, 426)
      assert.equal(r.body.error.code, 'OV_CLIENT_TOO_OLD')
    })

    it('refuses malformed payloads', async () => {
      const base = backup(uniq())
      for (const p of [null, 'x', {}, { match: {} }, { match: { external_id: '' } }, { match: { external_id: 5 } },
        { ...base, sets: 'x' }, { ...base, events: [1] }, { ...base, liveState: [] }, { ...base, events: [{ nope: 1 }] }]) {
        const r = await restore.restoreMatch(p, W)
        assert.equal(r.status, 400, JSON.stringify(p))
      }
    })

    // 2026-10-26: a hand-over on a device whose local ids were taken by its
    // older matches queued a whole-match restore to move the cloud rows to
    // its own ids; it deleted the match's voided events and the rows the
    // previous device sent after the read
    it('rekey: renames the rows named in place and deletes nothing else', async () => {
      const ext = uniq('REKEY')
      const made = await restore.restoreMatch(backup(ext, { sets: 2, events: 5 }), W)
      const id = made.body.data.id
      const row = async (key) => (await raw.query('SELECT id, external_id, voided_at, payload FROM events WHERE match_id = $1 AND external_id = $2', [id, key])).rows[0]
      const e1 = await row(`${ext}:e:1`)
      // event 3 voided after the device read the match; 6 voided before
      // (never read); 7 sent by the previous device after the read
      await raw.query('UPDATE events SET voided_at = now(), void_reason = $3 WHERE match_id = $1 AND external_id = $2', [id, `${ext}:e:3`, 'undo'])
      await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type, voided_at, void_reason)
                       VALUES ($1, $2, 1, 'point', 6, '{}', 'indoor', now(), 'undo'), ($1, $3, 1, 'point', 7, '{}', 'indoor', NULL, NULL),
                              ($1, $4, 1, 'point', 99, '{"stale":true}', 'indoor', NULL, NULL)`,
      [id, `${ext}:e:6`, `${ext}:e:7`, `${ext}:e:205`])

      // what the device read: sets 1-2, events 1-5 (and 9, gone since), moved to its own ids
      const b = backup(ext, { sets: 2, events: 5 })
      b.events.push({ external_id: `${ext}:e:9`, set_index: 1, type: 'point', seq: 9, payload: {}, sport_type: 'indoor' })
      const to = (key) => key.replace(/:(s|e):(\d+)$/, (_, k, n) => `:${k}:${Number(n) + (k === 's' ? 100 : 200)}`)
      const rekey = { sets: {}, events: {} }
      b.sets = b.sets.map((r) => { rekey.sets[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      b.events = b.events.map((r) => { rekey.events[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      b.liveState = { ...b.liveState, points_a: 0, points_b: 0 }
      const r = await restore.restoreMatch({ ...b, rekey }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 6, liveState: 0, rekeyed: 7 })

      const keys = (await raw.query('SELECT external_id, voided_at IS NOT NULL AS voided FROM events WHERE match_id = $1 ORDER BY seq', [id])).rows
      assert.deepEqual(keys, [
        { external_id: `${ext}:e:201`, voided: false },
        { external_id: `${ext}:e:202`, voided: false },
        { external_id: `${ext}:e:203`, voided: true },
        { external_id: `${ext}:e:204`, voided: false },
        { external_id: `${ext}:e:205`, voided: false },
        { external_id: `${ext}:e:6`, voided: true },
        { external_id: `${ext}:e:7`, voided: false },
        { external_id: `${ext}:e:209`, voided: false }
      ])
      // in place: the same row under its new id; the stale row under the new id is gone
      assert.equal((await row(`${ext}:e:201`)).id, e1.id)
      assert.deepEqual((await row(`${ext}:e:205`)).payload, { n: 4 })
      assert.deepEqual((await raw.query('SELECT external_id FROM sets WHERE match_id = $1 ORDER BY index', [id])).rows.map((x) => x.external_id), [`${ext}:s:101`, `${ext}:s:102`])
      // the live state is not keyed by the device's ids: left as it is
      assert.equal((await raw.query('SELECT points_a FROM match_live_state WHERE match_id = $1', [id])).rows[0].points_a, 3)
      assert.ok(r.changes.some((c) => c.table === 'events' && c.eventType === 'UPDATE' && c.row.external_id === `${ext}:e:201`))

      // a rekey naming another match's id or an unscoped new id is refused as a whole
      const bad = { ...b, rekey, events: [...b.events, { external_id: '12', set_index: 1, type: 'point', seq: 12, payload: {}, sport_type: 'indoor' }] }
      assert.equal((await restore.restoreMatch(bad, W)).body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      assert.equal(await count('events', id), 8)
    })

    it('restores a match without sets, events or live state', async () => {
      const ext = uniq()
      const r = await restore.restoreMatch({ match: { external_id: ext } }, W)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data.counts, { sets: 0, events: 0, liveState: 0 })
    })
  })

  describe('restoreMatch with real client payloads', () => {
    // Exactly what backupManager.js restoreMatchInPlace queues (match after filterMatchPayload).
    function backupManagerPayload (ext, { sportType } = {}) {
      return {
        match: {
          external_id: ext,
          game_n: 88000 + (seq++),
          game_pin: '246810',
          status: 'live',
          home_team: { name: 'Home', short_name: 'HOM', color: '#f00' },
          away_team: { name: 'Away', short_name: 'AWY', color: '#00f' },
          players_home: [{ number: 7 }],
          players_away: [],
          match_info: { hall: 'Halle', league: '2L' },
          coin_toss: { confirmed: true, first_serve: 'home' },
          ...(sportType ? { sport_type: sportType } : {})
        },
        sets: [1, 2].map(i => ({ external_id: `${ext}_set_${i}`, index: i, home_points: 25, away_points: 18, finished: i === 1, start_time: '2026-10-05T10:00:00Z', end_time: undefined })),
        events: [1, 2, 3].map(seq => ({ external_id: `${ext}_event_${seq}`, set_index: 1, type: 'point', payload: { team: 'home' }, ts: '2026-10-05T10:01:00Z', seq })),
        liveState: { current_set: 2, points_a: 25, points_b: 18, sets_won_a: 1, sets_won_b: 0, status: 'live' }
      }
    }

    it('restores the restore-in-place payload: live state `status` becomes match_status, children get sport_type', async () => {
      const ext = uniq('BM')
      const r = await restore.restoreMatch(backupManagerPayload(ext), W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 3, liveState: 1 })
      assert.deepEqual(r.body.data.dropped, {})
      const id = r.body.data.id
      const ls = (await raw.query('SELECT match_status, current_set, sets_won_a FROM match_live_state WHERE match_id = $1', [id])).rows[0]
      assert.deepEqual(ls, { match_status: 'live', current_set: 2, sets_won_a: 1 })
      const sports = (await raw.query("SELECT DISTINCT sport_type::text FROM (SELECT sport_type FROM sets WHERE match_id = $1 UNION ALL SELECT sport_type FROM events WHERE match_id = $1) x", [id])).rows
      assert.deepEqual(sports, [{ sport_type: 'indoor' }])
      // A beach match passes its own sport type down.
      const b = await restore.restoreMatch(backupManagerPayload(uniq('BB'), { sportType: 'beach' }), W)
      assert.equal((await raw.query('SELECT DISTINCT sport_type::text s FROM events WHERE match_id = $1', [b.body.data.id])).rows[0].s, 'beach')
    })

    it('drops and reports keys that are not columns instead of rolling back', async () => {
      const ext = uniq('BX')
      const p = backupManagerPayload(ext)
      p.match.coinTossConfirmed = true
      p.match.legacy_field = 1
      p.events[0].stateSnapshot = {}
      p.liveState.status = 'final'
      p.liveState.match_status = 'live' // both present: the real column wins, the legacy key is dropped
      const r = await restore.restoreMatch(p, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.dropped, { match: ['coinTossConfirmed', 'legacy_field'], events: ['stateSnapshot'], liveState: ['status'] })
      assert.equal((await raw.query('SELECT match_status FROM match_live_state WHERE match_id = $1', [r.body.data.id])).rows[0].match_status, 'live')
    })

    it('keeps stored PINs when the backup omits or nulls them and merges connection_pins', async () => {
      const ext = uniq('PK')
      const p = backupManagerPayload(ext)
      p.match.connection_pins = { referee: '111111', bench_a: '222222' }
      const first = await restore.restoreMatch(p, W)
      const id = first.body.data.id
      const pins = async () => (await raw.query('SELECT game_pin, connection_pins FROM matches WHERE id = $1', [id])).rows[0]
      p.match.game_pin = null
      p.match.connection_pins = { referee: '999999' }
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.deepEqual(await pins(), { game_pin: '246810', connection_pins: { referee: '999999', bench_a: '222222' } })
      delete p.match.game_pin
      delete p.match.connection_pins
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.deepEqual(await pins(), { game_pin: '246810', connection_pins: { referee: '999999', bench_a: '222222' } })
      p.match.game_pin = ''
      p.match.connection_pins = null
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.equal((await pins()).game_pin, '246810')
    })

    it('reports the removed children as DELETE changes (keys only) before the new INSERTs', async () => {
      const ext = uniq('CH')
      const first = await restore.restoreMatch(backup(ext, { sets: 2, events: 3 }), W)
      const old = (await raw.query('SELECT id::text FROM events WHERE match_id = $1 ORDER BY id', [first.body.data.id])).rows.map(r => r.id)
      const again = await restore.restoreMatch(backup(ext, { sets: 1, events: 1 }), W)
      const kinds = again.changes.map(c => `${c.table}:${c.eventType}`)
      const dels = again.changes.filter(c => c.eventType === 'DELETE')
      assert.deepEqual(dels.filter(c => c.table === 'events').map(c => String(c.row.id)).sort(), old.sort())
      assert.equal(dels.filter(c => c.table === 'sets').length, 2)
      assert.equal(dels.filter(c => c.table === 'match_live_state').length, 1)
      for (const d of dels) assert.deepEqual(Object.keys(d.row).sort(), d.table === 'match_live_state' ? ['id', 'match_id'] : ['external_id', 'id', 'match_id'])
      assert.ok(kinds.lastIndexOf('events:DELETE') < kinds.indexOf('events:INSERT'))
    })

    it('refuses duplicate external_ids inside one payload with a clear error', async () => {
      const p = backup(uniq('DUP'), { events: 3 })
      p.events[2].external_id = p.events[1].external_id
      const r = await restore.restoreMatch(p, W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, 'OV_INVALID_REQUEST')
      assert.match(r.body.error.details, /^events: duplicate external_id/)
    })

    it('cannot take over a set of another match through the restore', async () => {
      const a = uniq('TA'); const b = uniq('TB')
      const ra = await restore.restoreMatch(backup(a, { sets: 1, events: 0 }), W)
      // b's backup carries a set whose external_id collides with a row of match a.
      const collided = `${b}:s:1`
      await raw.query('INSERT INTO sets (external_id, match_id) VALUES ($1, $2)', [collided, ra.body.data.id])
      const r = await restore.restoreMatch(backup(b, { sets: 1, events: 0 }), W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '23505')
      assert.match(r.body.error.details, /^sets:/)
      assert.equal((await raw.query('SELECT match_id FROM sets WHERE external_id = $1', [collided])).rows[0].match_id, ra.body.data.id)
      assert.equal((await raw.query('SELECT count(*)::int n FROM matches WHERE external_id = $1', [b])).rows[0].n, 0)
    })
  })

  describe('restoreByPin', () => {
    let ext, id
    before(async () => {
      ext = uniq('PIN')
      const r = await restore.restoreMatch(backup(ext, { gameN: 31337, pin: '135790', sets: 2, events: 3 }), W)
      id = r.body.data.id
    })

    it('returns the match without secrets, plus sets, events and live state', async () => {
      const r = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-ok' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { match, sets, events, liveState } = r.body.data
      assert.equal(match.id, id)
      assert.equal(match.external_id, ext)
      assert.ok(!('game_pin' in match))
      assert.ok(!('connection_pins' in match))
      assert.deepEqual(sets.map(s => s.index), [1, 2])
      assert.deepEqual(events.map(e => e.seq), [1, 2, 3])
      assert.equal(liveState.points_a, 3)
      // String inputs from a form are accepted.
      const r2 = await restore.restoreByPin({ gameN: '31337', pin: ' 135790 ' }, { limitKey: 'ip-ok2' })
      assert.equal(r2.status, 200)
    })

    it('needs an exact game number AND PIN', async () => {
      for (const [gameN, pin] of [[31337, '135791'], [31336, '135790'], [31337, '13579'], [31337, '1357900']]) {
        const r = await restore.restoreByPin({ gameN, pin }, { limitKey: `ip-${gameN}-${pin}` })
        assert.equal(r.status, 404, `${gameN}/${pin}`)
        assert.equal(r.body.error.code, 'OV_NOT_FOUND')
      }
    })

    it('refuses wildcard and injection PINs before touching the database', async () => {
      for (const pin of ['%', '*', "' OR '1'='1", '1357%', '', null, '1'.repeat(40)]) {
        const r = await restore.restoreByPin({ gameN: 31337, pin }, { limitKey: 'ip-inj' })
        assert.equal(r.status, 400, String(pin))
      }
      for (const gameN of [undefined, 'x', -1, 1.5, '1 OR 1=1']) {
        const r = await restore.restoreByPin({ gameN, pin: '135790' }, { limitKey: 'ip-inj2' })
        assert.equal(r.status, 400, String(gameN))
      }
    })

    it('limits attempts per caller and game number', async () => {
      const key = 'ip-brute'
      for (let i = 0; i < 5; i++) {
        const r = await restore.restoreByPin({ gameN: 31337, pin: String(100000 + i) }, { limitKey: key })
        assert.equal(r.status, 404)
      }
      const blocked = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: key })
      assert.equal(blocked.status, 429)
      assert.equal(blocked.body.error.code, 'OV_TOO_MANY_ATTEMPTS')
      const otherGame = await restore.restoreByPin({ gameN: 1, pin: '135790' }, { limitKey: key })
      assert.equal(otherGame.status, 404)
    })

    it('limits attempts per caller across all game numbers', async () => {
      const r2 = createMatchRestore(db, { logger: quietLogger(), callerAttempts: { max: 3, windowMs: 60000 } })
      for (let g = 1; g <= 3; g++) {
        assert.equal((await r2.restoreByPin({ gameN: 900000 + g, pin: '135790' }, { limitKey: 'ip-spray' })).status, 404)
      }
      const blocked = await r2.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-spray' })
      assert.equal(blocked.status, 429)
      assert.equal((await r2.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-other' })).status, 200)
      // A blocked caller does not create per-game keys.
      const before = r2.pinLimiter.size
      for (let g = 0; g < 50; g++) await r2.restoreByPin({ gameN: g, pin: '1' }, { limitKey: 'ip-spray' })
      assert.equal(r2.pinLimiter.size, before)
    })

    it('successful lookups do not count against the caller', async () => {
      for (let i = 0; i < 25; i++) {
        const r = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-repeat' })
        assert.equal(r.status, 200, `attempt ${i}`)
      }
    })

    it('picks the most recently updated match when game number and PIN repeat', async () => {
      // Game numbers repeat across seasons (db/007 allows one cloud match per game and season)
      const older = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999', scheduledAt: '2024-10-05T16:00:00Z' }), W)
      const newer = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999', scheduledAt: '2025-10-05T16:00:00Z' }), W)
      // (db/006's trigger would reset updated_at: back-date it with the user triggers off)
      await raw.query('BEGIN')
      await raw.query("SET LOCAL session_replication_role = 'replica'")
      await raw.query("UPDATE matches SET updated_at = now() - interval '1 day' WHERE id = $1", [older.body.data.id])
      await raw.query('COMMIT')
      const r = await restore.restoreByPin({ gameN: 4242, pin: '999999' }, { limitKey: 'ip-dup' })
      assert.equal(r.body.data.match.id, newer.body.data.id)
    })

    it('returns every event of a long match (above the 1000-row /api/db cap)', async () => {
      const ext2 = uniq('LONG')
      const r = await restore.restoreMatch(backup(ext2, { gameN: 5150, pin: '515151', events: 1200 }), W)
      assert.equal(r.body.data.counts.events, 1200)
      const p = await restore.restoreByPin({ gameN: 5150, pin: '515151' }, { limitKey: 'ip-long' })
      assert.equal(p.body.data.events.length, 1200)
    })

    // The device continuing the match keeps the cloud ids and gives out new
    // ones above idFloor (frontend importMatchFromSupabase): a rally under the
    // id of a voided event, or of an undo that reached the server before its
    // event, would be born voided (db/015)
    // 2026-10-26: the device that continues the match becomes its scorer
    // (server.js takeOverByPin) before the match is read for it: a rally of
    // the previous device is in what it reads, or refused after the claim
    it('takeOver runs once the PIN is proved, before the sets and events are read; its answer is `scorer`', async () => {
      const ext4 = uniq('TAKE')
      const made = await restore.restoreMatch(backup(ext4, { gameN: 7170, pin: '717171', sets: 1, events: 2 }), W)
      const seen = []
      const takeOver = async (m) => {
        seen.push(m)
        // the previous device's rally that reached the server just before the claim
        await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type)
                         VALUES ($1, $2, 1, 'point', 3, '{}', 'indoor')`, [m.id, `${ext4}:e:3`])
        return { mine: true, moved: true }
      }
      const r = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take', takeOver })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(seen, [{ id: made.body.data.id, external_id: ext4 }])
      assert.deepEqual(r.body.data.events.map(e => e.seq), [1, 2, 3])
      assert.deepEqual(r.body.data.scorer, { mine: true, moved: true })

      // a wrong PIN never gets that far; a failing take-over leaves the lookup as it was
      assert.equal((await restore.restoreByPin({ gameN: 7170, pin: '000000' }, { limitKey: 'ip-take-2', takeOver })).status, 404)
      assert.equal(seen.length, 1)
      const failing = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take-3', takeOver: async () => { throw new Error('db down') } })
      assert.equal(failing.status, 200)
      assert.equal(failing.body.data.scorer, undefined)
      const none = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take-4', takeOver: async () => null })
      assert.equal(none.body.data.scorer, undefined)
    })

    it('idFloor: the highest set / event ids the match used, voided events and revisions included', async () => {
      const ext3 = uniq('FLOOR')
      const b = backup(ext3, { gameN: 6160, pin: '616161', sets: 2, events: 3 })
      b.events.push({ external_id: `${ext3}_legacy`, set_index: 1, type: 'point', seq: 9, payload: {}, sport_type: 'indoor' })
      const r = await restore.restoreMatch(b, W)
      const matchId = r.body.data.id
      const floorOf = async (key) => (await restore.restoreByPin({ gameN: 6160, pin: '616161' }, { limitKey: key })).body.data.idFloor
      assert.deepEqual(await floorOf('ip-floor-1'), { set: 2, event: 3 })

      // event 12 voided on the server: left out of the events, not of the floor
      await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type, voided_at, void_reason)
                       VALUES ($1, $2, 1, 'point', 12, '{}', 'indoor', now(), 'undo')`, [matchId, `${ext3}:e:12`])
      // event 40 undone before it was uploaded: only its revision is there
      await raw.query(`INSERT INTO event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts)
                       VALUES (gen_random_uuid(), $1, $2, 'void', 'undo', false, now())`, [matchId, `${ext3}:e:40`])
      // another match's ids do not count
      const other = await restore.restoreMatch(backup(uniq('OTHER'), { gameN: 6161, events: 2 }), W)
      await raw.query(`INSERT INTO event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts)
                       VALUES (gen_random_uuid(), $1, $2, 'void', 'undo', false, now())`, [other.body.data.id, `${ext3}:e:900`])

      const p = await restore.restoreByPin({ gameN: 6160, pin: '616161' }, { limitKey: 'ip-floor-2' })
      assert.deepEqual(p.body.data.events.map(e => e.seq).sort((x, y) => x - y), [1, 2, 3, 9])
      assert.deepEqual(p.body.data.idFloor, { set: 2, event: 40 })
    })
  })
})
