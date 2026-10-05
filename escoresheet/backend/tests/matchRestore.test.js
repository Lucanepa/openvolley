import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore, createAttemptLimiter } from '../lib/matchRestore.js'
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

  it('opens again after the window', async () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 20 })
    assert.equal(l.isLimited('k'), false)
    assert.equal(l.isLimited('k'), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(l.isLimited('k'), false)
  })
})

describe('matchRestore on Postgres', { skip: SKIP_PG }, () => {
  let tdb, db, restore, raw
  let seq = 0
  const uniq = (p = 'R') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const W = { proto: 2 }
  const count = async (table, matchId) => (await raw.query(`SELECT count(*)::int n FROM ${table} WHERE match_id = $1`, [matchId])).rows[0].n

  function backup (ext, { sets = 2, events = 5, gameN = 7, pin = '424242' } = {}) {
    return {
      match: {
        external_id: ext,
        game_n: gameN,
        game_pin: pin,
        status: 'live',
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

    it('restores a match without sets, events or live state', async () => {
      const ext = uniq()
      const r = await restore.restoreMatch({ match: { external_id: ext } }, W)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data.counts, { sets: 0, events: 0, liveState: 0 })
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

    it('picks the most recently updated match when game number and PIN repeat', async () => {
      const older = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999' }), W)
      const newer = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999' }), W)
      await raw.query("UPDATE matches SET updated_at = now() - interval '1 day' WHERE id = $1", [older.body.data.id])
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
  })
})
