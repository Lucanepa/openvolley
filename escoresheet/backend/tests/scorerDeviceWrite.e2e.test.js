/**
 * The scoring-device check is part of the write (db/019, lib/scorerDevice.js
 * guardedWrite / lockedHolder), end to end through server.js:
 *
 *   - a write of the device a match leaves that is in flight while another
 *     device takes the match over is either in what the new device reads or
 *     refused (409 OV_SCORER_MOVED), never accepted after the take-over and
 *     missing there (/api/db, the event history);
 *   - the device a write adopts follows the rows it wrote: a filter that
 *     matches nothing, an update without columns or a child id that names
 *     another match adopts nothing;
 *   - a caller that may not write a match is never told who scores it.
 *
 * A second connection holds a table lock (SHARE ROW EXCLUSIVE: plain reads
 * and row locks pass, inserts wait) to hold a request inside its write.
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '615283'

describe('scoring-device check inside the write', { skip: SKIP }, () => {
  let db, srv, sql, locker, storageRoot, statusDir
  let ipSeq = 1
  let gameSeq = 83000
  const nextIp = () => { const n = ipSeq++; return `198.${18 + Math.floor(n / 250)}.${Math.floor(n / 250) % 250}.${1 + (n % 250)}` }

  async function account (name, roles = null) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    return u
  }
  const device = (platform) => ({ id: randomUUID(), platform })
  const dbCall = (user, table, action, params, dev) =>
    api(srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { table, action, params, ...(dev ? { device: dev } : {}) } })
  const revise = (user, matchExt, revisions, dev) =>
    api(srv.base, '/api/match/event-revisions', { token: user.token, proto: null, headers: { 'cf-connecting-ip': user.ip }, body: { match_external_id: matchExt, revisions, ...(dev ? { device: dev } : {}) } })
  const voidRev = (eventExt, seq) => ({
    rev_uid: randomUUID(), op: 'void', event_external_id: eventExt, reason: 'undo', seq, set_index: 1, type: 'point',
    client_ts: new Date().toISOString(), device_id: randomUUID(), app_version: 'test'
  })
  /** "Continue on this device": the game PIN, claim, the device; no session. */
  const takeOverByPin = (m, dev) =>
    api(srv.base, '/api/match/restore-by-pin', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { gameN: m.n, pin: GAME_PIN, claim: true, device: dev, external_id: m.ext } })
  async function newMatch (owner, dev, extra = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const r = await dbCall(owner, 'matches', 'insert', { data: { external_id: ext, game_n: n, status: 'live', game_pin: GAME_PIN, ...extra }, returning: 'id', single: true }, dev)
    assert.equal(r.status, 200, r.text)
    return { ext, n, id: r.json.data.id }
  }
  const putEvent = (user, m, local, dev) => dbCall(user, 'events', 'upsert', {
    data: { external_id: `${m.ext}:e:${local}`, match_id: m.id, set_index: 1, type: 'point', seq: local, payload: {}, score_a: local, score_b: 0 },
    onConflict: 'external_id'
  }, dev)
  const scorerOf = async (m) => (await sql.query('SELECT device_id FROM public.match_scorer_devices WHERE match_id = $1', [m.id])).rows[0]?.device_id || null
  const lockWaiters = async () => Number((await sql.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n)
  /** Holds `table` so inserts wait; plain reads and row locks pass. */
  async function hold (table) {
    await locker.query('BEGIN')
    await locker.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`)
  }
  const release = () => locker.query('COMMIT')
  /** Waits until `n` requests wait for a lock, or `done` has settled. */
  async function waitForLockOr (n, done) {
    let settled = false
    done.then(() => { settled = true }, () => { settled = true })
    await waitUntil(async () => settled || (await lockWaiters()) >= n, { timeoutMs: 8000, intervalMs: 20, what: `${n} requests waiting for a lock` })
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    locker = new pg.Client({ connectionString: db.url })
    await locker.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-scorerwrite-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-scorerwrite-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
    })
  })

  after(async () => {
    await locker?.query('ROLLBACK').catch(() => {})
    await locker?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('an event write in flight during a take-over is in what the new device reads, or refused', async () => {
    const owner = await account('nora', ['scorer'])
    const A = device('web')
    const B = device('android')
    const m = await newMatch(owner, A)
    assert.equal((await putEvent(owner, m, 1, A)).status, 200)
    assert.equal(await scorerOf(m), A.id)

    await hold('public.events')
    const aWrite = putEvent(owner, m, 2, A) // waits at its insert
    await waitForLockOr(1, aWrite)
    const bTake = takeOverByPin(m, B)
    await waitForLockOr(2, bTake) // the take-over waits for the write (fixed), or is already done
    await release()
    const [a, b] = await Promise.all([aWrite, bTake])
    assert.equal(b.status, 200, b.text)
    assert.equal(await scorerOf(m), B.id)
    const got = b.json.data.events.map((e) => e.external_id)
    assert.ok(a.status === 409 || got.includes(`${m.ext}:e:2`),
      `the old device's write was accepted (${a.status}) but is not in what the new device read (${got.join(', ')})`)
    // and from now on the old device is refused
    const late = await putEvent(owner, m, 3, A)
    assert.equal(late.status, 409, late.text)
    assert.equal(late.json.error.code, 'OV_SCORER_MOVED')
  })

  it('an undo in flight during a take-over is in what the new device reads, or refused', async () => {
    const owner = await account('olga', ['scorer'])
    const A = device('web')
    const B = device('android')
    const m = await newMatch(owner, A)
    for (const n of [1, 2, 3]) assert.equal((await putEvent(owner, m, n, A)).status, 200)

    await hold('public.event_revisions')
    const aVoid = revise(owner, m.ext, [voidRev(`${m.ext}:e:3`, 3)], A) // waits at its revision insert
    await waitForLockOr(1, aVoid)
    const bTake = takeOverByPin(m, B)
    await waitForLockOr(2, bTake)
    await release()
    const [a, b] = await Promise.all([aVoid, bTake])
    assert.equal(b.status, 200, b.text)
    // a voided event is not in the read at all (only live events are restored)
    const third = b.json.data.events.find((e) => e.external_id === `${m.ext}:e:3`)
    assert.ok(a.status === 409 || !third || third.voided_at != null,
      `the old device's undo was applied (${a.status} ${JSON.stringify(a.json?.data)}) but the new device read the point as live`)
    // a later undo of the old device is refused, and nothing it sends is applied
    const late = await revise(owner, m.ext, [voidRev(`${m.ext}:e:2`, 2)], A)
    assert.equal(late.status, 409, late.text)
    assert.equal(late.json.error.code, 'OV_SCORER_MOVED')
    assert.equal((await sql.query('SELECT voided_at FROM public.events WHERE external_id = $1', [`${m.ext}:e:2`])).rows[0].voided_at, null)
  })

  it('natural timing: no accepted write is missing on the new device, and no write fails', async () => {
    const owner = await account('pia', ['scorer'])
    const TRIALS = 25
    const QUEUE = 10
    for (let t = 0; t < TRIALS; t++) {
      const A = device('web')
      const B = device('android')
      const m = await newMatch(owner, A)
      assert.equal((await putEvent(owner, m, 1, A)).status, 200)
      const results = []
      // the app's sync queue: one job at a time, points and match updates mixed
      const queue = (async () => {
        for (let n = 2; n <= QUEUE + 1; n++) {
          const r = n % 3 === 0
            ? await dbCall(owner, 'matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'external_id', value: m.ext }] }, A)
            : await putEvent(owner, m, n, A)
          results.push({ n, event: n % 3 !== 0, status: r.status, code: r.json?.error?.code || null })
          if (r.status === 409) break // the app stops and asks who scores
        }
      })()
      await sleep(Math.random() * 25)
      const b = await takeOverByPin(m, B)
      await queue
      assert.equal(b.status, 200, b.text)
      const got = new Set(b.json.data.events.map((e) => e.external_id))
      for (const r of results) {
        assert.ok(r.status === 200 || r.status === 409, `trial ${t}: write ${r.n} answered ${r.status} ${r.code}`)
        if (r.status === 200 && r.event) assert.ok(got.has(`${m.ext}:e:${r.n}`), `trial ${t}: event ${r.n} was accepted but the new device never got it`)
      }
    }
  })

  it('a write that changed no row adopts no match: a zero-row update, an update without columns', async () => {
    const owner = await account('rita', ['scorer'])
    const outsider = await account('sven') // a fresh account, no role
    const other = await account('tom', ['scorer'])
    // an official match whose app named no device: no scorer recorded yet
    const m = await newMatch(owner, undefined)
    assert.equal(await scorerOf(m), null)
    const X = device('web')

    const zero = await dbCall(outsider, 'events', 'update', { data: { payload: {} }, filters: [{ type: 'eq', column: 'match_id', value: m.id }, { type: 'eq', column: 'type', value: 'x' }] }, X)
    assert.equal(zero.status, 200, zero.text) // nothing matched: nothing written
    assert.equal(await scorerOf(m), null, 'a write that changed no row takes no match')

    for (const who of [outsider, other]) {
      const empty = await dbCall(who, 'matches', 'update', { data: {}, filters: [{ type: 'eq', column: 'external_id', value: m.ext }] }, X)
      assert.equal(empty.status, 403, empty.text)
      assert.ok(['OV_SCORER_REQUIRED', 'OV_NOT_MATCH_OWNER'].includes(empty.json.error.code), empty.text)
    }
    assert.equal(await scorerOf(m), null, 'an update without columns of another account\'s match is refused like any update')

    // the match's own scorer writes on; its device is the first that wrote a row
    const S = device('tauri-linux')
    assert.equal((await putEvent(owner, m, 1, S)).status, 200)
    assert.equal(await scorerOf(m), S.id)
    // an empty update of its own match is still answered 200 (nothing to set)
    assert.equal((await dbCall(owner, 'matches', 'update', { data: {}, filters: [{ type: 'eq', column: 'external_id', value: m.ext }] }, S)).status, 200)
  })

  it('a child id that names another match adopts nothing there', async () => {
    const owner = await account('uma', ['scorer'])
    const outsider = await account('vito') // no role: test matches only
    const victim = await newMatch(owner, undefined)
    const own = await newMatch(outsider, undefined, { test: true, game_n: null })
    const X = device('web')
    const plant = await dbCall(outsider, 'events', 'insert', { data: { external_id: `${victim.ext}:e:99999`, match_id: own.id, set_index: 1, type: 'point', seq: 1, payload: {} } }, X)
    assert.notEqual(plant.json?.error?.code, 'OV_SCORER_MOVED', plant.text)
    assert.equal(await scorerOf(victim), null, 'the named match gets no scoring device')
    // the scorer's next write is not refused
    const S = device('android')
    assert.equal((await putEvent(owner, victim, 1, S)).status, 200)
    assert.equal(await scorerOf(victim), S.id)
    // and once it has a scorer, such a child id is not told who it is
    const again = await dbCall(outsider, 'events', 'insert', { data: { external_id: `${victim.ext}:e:99998`, match_id: own.id, set_index: 1, type: 'point', seq: 2, payload: {} } }, X)
    assert.notEqual(again.json?.error?.code, 'OV_SCORER_MOVED', again.text)
    assert.equal(again.text.includes('android'), false, again.text)
    assert.equal(await scorerOf(victim), S.id)
  })

  it('a caller that may not write a match is never told who scores it', async () => {
    const owner = await account('willa', ['scorer'])
    const other = await account('xaver', ['scorer'])
    const outsider = await account('yann')
    const S = device('tauri-linux')
    const m = await newMatch(owner, S)
    assert.equal((await putEvent(owner, m, 1, S)).status, 200)
    const X = device('android')
    const answers = [
      await dbCall(other, 'events', 'update', { data: { payload: {} }, filters: [{ type: 'eq', column: 'match_id', value: m.id }] }, X),
      await dbCall(other, 'matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'external_id', value: m.ext }] }, X),
      await dbCall(outsider, 'events', 'update', { data: { payload: {} }, filters: [{ type: 'eq', column: 'match_id', value: m.id }, { type: 'eq', column: 'type', value: 'x' }] }, X),
      await revise(other, m.ext, [voidRev(`${m.ext}:e:1`, 1)], X)
    ]
    for (const r of answers) {
      assert.notEqual(r.json?.error?.code, 'OV_SCORER_MOVED', r.text)
      assert.equal(r.text.includes('tauri-linux'), false, r.text)
    }
    assert.equal(answers[0].status, 403)
    assert.equal(answers[3].status, 403)
    assert.equal(await scorerOf(m), S.id)
    // the match's own account on another device is told
    const mine = await putEvent(owner, m, 2, X)
    assert.equal(mine.status, 409, mine.text)
    assert.equal(mine.json.error.scorer.platform, 'tauri-linux')
  })
})
