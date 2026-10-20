/**
 * The scoring-device handover end to end through server.js (db/019,
 * lib/scorerDevice.js): the first device that writes a match scores it, a
 * device that joins takes it over (POST /api/match/scorer, a backup restore),
 * the previous one is told over the relay and refused with 409
 * OV_SCORER_MOVED, "Take back scoring here" turns it round again, and apps
 * that name no device keep working as before.
 *
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
import { SKIP, bootServer, api, provisionDatabase, sleep, openSocket } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '583920'
const PC = { id: randomUUID(), platform: 'tauri-linux' }
const PHONE = { id: randomUUID(), platform: 'android' }

describe('scoring-device handover end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  let gameSeq = 81000

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = `203.0.113.${ipSeq++}`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  // device: undefined = an app from before the handover (names none)
  const dbCall = (user, table, action, params, device) =>
    api(srv.base, '/api/db', { token: user.token, proto: action === 'select' ? null : '2', body: { table, action, params, ...(device ? { device } : {}) } })
  const scorer = (user, body) => api(srv.base, '/api/match/scorer', { token: user.token, proto: null, body })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const eq = (column, value) => ({ type: 'eq', column, value })

  async function newMatch (user, device, extra = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const r = await dbCall(user, 'matches', 'upsert', { data: { external_id: ext, game_n: gameSeq++, status: 'live', game_pin: GAME_PIN, ...extra }, onConflict: 'external_id', returning: 'id', single: true }, device)
    assert.equal(r.status, 200, r.text)
    return { ext, id: r.json.data.id }
  }
  const event = (m, n, device, user = users.anna) =>
    dbCall(user, 'events', 'upsert', { data: { external_id: `${m.ext}:e:${n}`, match_id: m.id, set_index: 1, type: 'point', seq: n, payload: {} }, onConflict: 'external_id' }, device)
  const holder = async (m) => (await sql.query('SELECT device_id, platform FROM public.match_scorer_devices WHERE match_id = $1', [m.id])).rows[0] || null

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-scorerdev-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-scorerdev-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
    })
    await account('anna', ['scorer'])
    await account('carl', ['scorer'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the first device that writes a match scores it; a second device is refused until it takes over', async () => {
    const m = await newMatch(users.anna, PC)
    assert.deepEqual(await holder(m), { device_id: PC.id, platform: 'tauri-linux' })
    assert.equal((await event(m, 1, PC)).status, 200)

    // The phone writes without joining first: refused, with the scorer's platform only
    const refused = await event(m, 2, PHONE)
    expectCode(refused, 409, 'OV_SCORER_MOVED')
    assert.equal(refused.json.error.scorer.platform, 'tauri-linux')
    assert.equal(typeof refused.json.error.scorer.at, 'string')
    assert.equal(refused.text.includes(PC.id), false, 'never the other device id')
    expectCode(await dbCall(users.anna, 'matches', 'update', { data: { status: 'live' }, filters: [eq('external_id', m.ext)] }, PHONE), 409, 'OV_SCORER_MOVED')
    expectCode(await dbCall(users.anna, 'match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1, points_b: 0 }, onConflict: 'match_id' }, PHONE), 409, 'OV_SCORER_MOVED')

    // Status without claiming
    const st = await scorer(users.anna, { external_id: m.ext, device: PHONE, claim: false })
    assert.equal(st.status, 200, st.text)
    assert.equal(st.json.data.mine, false)
    assert.equal(st.json.data.scorer.platform, 'tauri-linux')

    // The phone joins: it scores from now on, the PC is refused
    const join = await scorer(users.anna, { external_id: m.ext, device: PHONE })
    assert.equal(join.status, 200, join.text)
    assert.equal(join.json.data.mine, true)
    assert.equal(join.json.data.moved, true)
    assert.equal(join.json.data.previous.platform, 'tauri-linux')
    assert.equal((await event(m, 2, PHONE)).status, 200)
    expectCode(await event(m, 3, PC), 409, 'OV_SCORER_MOVED')
    const audit = (await sql.query("SELECT details FROM public.audit_log WHERE action = 'match.scorer_device' AND match_id = $1", [m.id])).rows
    assert.equal(audit.length, 1)
    assert.equal(audit[0].details.previous_platform, 'tauri-linux')

    // "Take back scoring here" on the PC: the phone is the one refused now
    assert.equal((await scorer(users.anna, { external_id: m.ext, device: PC })).json.data.moved, true)
    assert.equal((await event(m, 3, PC)).status, 200)
    expectCode(await event(m, 4, PHONE), 409, 'OV_SCORER_MOVED')
    // Claiming again on the scorer itself is a no-op
    assert.equal((await scorer(users.anna, { external_id: m.ext, device: PC })).json.data.moved, false)
  })

  it('apps that name no device are neither checked nor recorded', async () => {
    const legacy = await newMatch(users.anna, undefined)
    assert.equal(await holder(legacy), null)
    assert.equal((await event(legacy, 1, undefined)).status, 200)
    // ... and an old app on a match a new device scores still writes
    const m = await newMatch(users.anna, PC)
    assert.equal((await event(m, 1, undefined)).status, 200)
    assert.deepEqual(await holder(m), { device_id: PC.id, platform: 'tauri-linux' })
  })

  it('the event history is checked by the revisions own device_id', async () => {
    const m = await newMatch(users.anna, PC)
    assert.equal((await event(m, 1, PC)).status, 200)
    const rev = (device) => ({
      match_external_id: m.ext,
      revisions: [{ rev_uid: randomUUID(), event_external_id: `${m.ext}:e:1`, op: 'void', reason: 'undo', seq: 1, set_index: 1, type: 'point', client_ts: new Date().toISOString(), device_id: device, app_version: 'test' }]
    })
    const post = (body) => api(srv.base, '/api/match/event-revisions', { token: users.anna.token, proto: null, body })
    expectCode(await post(rev(PHONE.id)), 409, 'OV_SCORER_MOVED')
    const ok = await post(rev(PC.id))
    assert.equal(ok.status, 200, ok.text)
  })

  it('a backup restored on a device takes the match over', async () => {
    const m = await newMatch(users.anna, PC)
    const r = await api(srv.base, '/api/match/restore', {
      token: users.anna.token,
      body: { match: { external_id: m.ext, game_n: 1234, status: 'live' }, sets: [], events: [], liveState: null, device: PHONE }
    })
    assert.equal(r.status, 200, r.text)
    assert.equal((await holder(m)).device_id, PHONE.id)
    expectCode(await event(m, 1, PC), 409, 'OV_SCORER_MOVED')
  })

  it('test and closed matches are not checked; a closed match cannot be claimed', async () => {
    const t = await newMatch(users.anna, PC, { test: true })
    assert.equal(await holder(t), null)
    assert.equal((await event(t, 1, PHONE)).status, 200)

    const m = await newMatch(users.anna, PC)
    assert.equal((await dbCall(users.anna, 'matches', 'update', { data: { status: 'approved' }, filters: [eq('external_id', m.ext)] }, PC)).status, 200)
    // The other device gets the closed answer, not "moved"
    expectCode(await dbCall(users.anna, 'matches', 'update', { data: { status: 'ended' }, filters: [eq('external_id', m.ext)] }, PHONE), 409, 'OV_MATCH_CLOSED')
    expectCode(await scorer(users.anna, { external_id: m.ext, device: PHONE }), 409, 'OV_MATCH_CLOSED')
  })

  it('only the creator, an editor or an admin claims; a device id is required', async () => {
    const m = await newMatch(users.anna, PC)
    expectCode(await scorer(users.carl, { external_id: m.ext, device: PHONE }), 403, 'OV_NOT_MATCH_OWNER')
    expectCode(await scorer(users.anna, { external_id: m.ext, device: { id: 'nope' } }), 400, 'OV_INVALID_REQUEST')
    expectCode(await scorer(users.anna, { external_id: 'match_unknown_x', device: PHONE }), 404, 'OV_MATCH_NOT_FOUND')
    const anon = await api(srv.base, '/api/match/scorer', { proto: null, body: { external_id: m.ext, device: PHONE } })
    assert.equal(anon.status, 401)
  })

  it('the previous scoreboard is told over the relay when the match moves', async () => {
    const m = await newMatch(users.anna, PC)
    const board = await openSocket(srv.wsUrl)
    try {
      board.send({ type: 'sync-match-data', matchId: 1, match: { id: 1, seed_key: m.ext, status: 'live', gamePin: GAME_PIN }, sets: [], events: [] })
      board.send({ type: 'ping' })
      await board.waitFor((msg) => msg.type === 'pong')
      // let the relay's database check of the room claim finish
      await sleep(300)
      assert.equal((await scorer(users.anna, { external_id: m.ext, device: PHONE })).status, 200)
      const told = await board.waitFor((msg) => msg.type === 'scorer-moved', 5000, 'scorer-moved')
      assert.equal(told.matchId, m.ext)
      assert.equal(JSON.stringify(told).includes(PHONE.id), false)
    } finally {
      board.ws.close()
    }
  })
})
