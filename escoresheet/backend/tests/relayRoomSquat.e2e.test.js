/**
 * Audit 2611 PERM-01: any signed-up account (even role-less) filed a matches
 * row under the public key of a relay room that has no database row (a
 * guest, Global or test match, or an official match whose first insert was
 * still pending), with its own game PIN. The relay then took that row as
 * proof (server.js verifyRelayClaim): the room's real scorer was refused
 * ('not-match-owner') and evicted, the filer fed the referee, benches and
 * livescore a forged match, and an official match never reached the cloud
 * (its scorer's upsert was 403 OV_NOT_MATCH_OWNER).
 * Now a new row under the key of a room the relay holds needs that room's
 * game PIN (409 OV_MATCH_KEY_IN_USE), and a test row, or a row newer than a
 * local-only room, never proves a claim.
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const hex = () => randomBytes(4).toString('hex')
// lib/displayCodes.js CODE_ALPHABET
const displayCode = () => [...randomBytes(8)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('')
const REAL = { gamePin: '246813', refereePin: '135792', homeTeamPin: '864201', awayTeamPin: '975310' }
const ATTACKER = { gamePin: '424242', refereePin: '101010', homeTeamPin: '202020', awayTeamPin: '303030' }

describe('relay room keys and the rows filed under them (PERM-01)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot
  const sockets = []
  let ipN = 20
  const nextIp = () => `203.0.113.${ipN++}`
  const users = {}

  async function account (name, roles = null) {
    const ip = nextIp()
    const email = `${name}-${hex()}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })).status, 200)
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
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { table, action, params } })
  const restore = (user, match) =>
    api(srv.base, '/api/match/restore', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { match, sets: [], events: [] } })
  const rowOf = async (ext) => (await sql.query('SELECT external_id, test, created_by FROM matches WHERE external_id = $1', [ext])).rows[0] || null

  async function open (ip) {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  const sync = (key, pins, flags = {}, home = 'Real Home') => ({
    type: 'sync-match-data',
    matchId: key,
    match: { seed_key: key, ...pins, status: 'live', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true, ...flags },
    homeTeam: { id: 1, name: home },
    awayTeam: { id: 2, name: 'Real Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: []
  })
  const errorsOf = (c, key) => c.messages.filter((m) => m.type === 'error' && (!key || m.matchId === key)).map((m) => m.code)
  // the relay answers a granted claim with nothing; a refused one with an error
  async function settle (c) {
    c.send({ type: 'ping' })
    await c.waitFor((m) => m.type === 'pong', 5000, 'pong')
    await sleep(150)
  }
  async function owns (c, key) {
    const before = c.messages.length
    c.send({ type: 'display-code-set', matchId: key, code: displayCode(), issuedAt: Date.now() })
    const m = await c.waitFor((x, i) => x.type === 'display-code-state' && i >= before, 3000, 'display-code-state').catch(() => null)
    return m?.active === true
  }
  const roomHome = async (key) => (await api(srv.base, `/api/match/${key}`, { method: 'GET', proto: null, headers: { 'cf-connecting-ip': nextIp() } })).json?.homeTeam?.name

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-squat-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    srv = await bootServer({ DATABASE_URL: db.appUrl(), STORAGE_ROOT: storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    users.pending = await account('pending') // signed up, no role: test matches only
    users.scorer = await account('scorer', ['scorer'])
    users.other = await account('other', ['scorer']) // an approved scorer of somewhere else
  })

  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
  })

  for (const [kind, flags] of [['guest', { guest: true }], ['Global', { global: true }], ['test', { test: true }]]) {
    it(`a ${kind} room: no account files a row under its key without its game PIN; the scorer keeps the room`, async () => {
      const key = `match_${Date.now()}_${hex()}`
      const scorerIp = nextIp()
      const scorer = await open(scorerIp)
      scorer.send(sync(key, REAL, flags))
      await settle(scorer)
      assert.deepEqual(errorsOf(scorer), [])

      for (const u of [users.pending, users.other]) {
        const ins = await dbCall(u, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: ATTACKER.gamePin } })
        assert.equal(ins.status, 409, ins.text)
        assert.equal(ins.json.error.code, 'OV_MATCH_KEY_IN_USE')
        const up = await dbCall(u, 'matches', 'upsert', { data: { external_id: key, test: true, status: 'setup', game_pin: ATTACKER.gamePin }, onConflict: 'external_id' })
        assert.equal(up.status, 409, up.text)
        // without any PIN too
        const bare = await dbCall(u, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup' } })
        assert.equal(bare.status, 409, bare.text)
        const rs = await restore(u, { external_id: key, test: true, status: 'live', game_pin: ATTACKER.gamePin })
        assert.equal(rs.status, 409, rs.text)
        assert.equal(rs.json.error.code, 'OV_MATCH_KEY_IN_USE')
      }
      assert.equal(await rowOf(key), null)

      const attacker = await open(nextIp())
      attacker.send(sync(key, ATTACKER, flags, 'HIJACKED HOME'))
      await settle(attacker)
      assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'])
      assert.equal(await owns(scorer, key), true, 'the connected scorer still owns the room')
      assert.equal(await roomHome(key), 'Real Home')

      // the scorer's reconnect (sleep, Wi-Fi) is granted with its own PIN
      scorer.ws.terminate()
      const back = await open(scorerIp)
      back.send(sync(key, REAL, flags))
      await settle(back)
      assert.deepEqual(errorsOf(back), [])
      assert.equal(await owns(back, key), true)
    })

    it(`a ${kind} room: a test row filed under its key before (or around) the fix proves nothing`, async () => {
      const key = `match_${Date.now()}_${hex()}`
      // filed while the relay did not hold the key (as before this fix)
      const ins = await dbCall(users.pending, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: ATTACKER.gamePin } })
      assert.equal(ins.status, 200, ins.text)
      assert.equal((await rowOf(key)).test, true)

      const scorerIp = nextIp()
      const scorer = await open(scorerIp)
      scorer.send(sync(key, REAL, flags))
      await settle(scorer)
      assert.deepEqual(errorsOf(scorer), [], 'the room\'s scorer is not asked for the filer\'s PIN')

      // the filer's claim, as the local match and as an official one
      for (const asIf of [flags, {}]) {
        const attacker = await open(nextIp())
        attacker.send(sync(key, ATTACKER, asIf, 'HIJACKED HOME'))
        await settle(attacker)
        assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'], JSON.stringify(asIf))
      }
      assert.equal(await owns(scorer, key), true, 'not evicted by a database "proof"')
      assert.equal(await roomHome(key), 'Real Home')

      scorer.ws.terminate()
      const back = await open(scorerIp)
      back.send(sync(key, REAL, flags))
      await settle(back)
      assert.deepEqual(errorsOf(back), [])
    })
  }

  it('a guest room: a non-test row newer than the room (it slipped in) proves nothing either', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const scorerIp = nextIp()
    const scorer = await open(scorerIp)
    scorer.send(sync(key, REAL, { guest: true }))
    await settle(scorer)
    await sleep(20)
    // straight into the table: what the insert check would refuse now
    await sql.query('INSERT INTO matches (external_id, test, status, game_pin, created_by) VALUES ($1, false, $2, $3, $4)', [key, 'setup', ATTACKER.gamePin, users.other.id])
    const attacker = await open(nextIp())
    attacker.send(sync(key, ATTACKER, {}, 'HIJACKED HOME'))
    await settle(attacker)
    assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'])
    assert.equal(await owns(scorer, key), true)
  })

  it('an official match whose first insert is pending: the squat is refused, the scorer\'s own insert goes through and proves its reconnect', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const scorerIp = nextIp()
    const scorer = await open(scorerIp)
    scorer.send(sync(key, REAL, { gameNumber: 900106 }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])

    const squat = await dbCall(users.pending, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: '000000' } })
    assert.equal(squat.status, 409, squat.text)
    const squat2 = await dbCall(users.other, 'matches', 'upsert', { data: { external_id: key, test: false, status: 'setup', game_pin: '000000' }, onConflict: 'external_id' })
    assert.equal(squat2.status, 409, squat2.text)
    assert.equal(await rowOf(key), null)

    // the scorer's sync queue: its upsert carries the PIN it syncs (the app's own first insert)
    const own = await dbCall(users.scorer, 'matches', 'upsert', { data: { external_id: key, game_n: 900106, status: 'setup', test: false, sport_type: 'indoor', game_pin: REAL.gamePin }, onConflict: 'external_id' })
    assert.equal(own.status, 200, own.text)
    assert.equal((await rowOf(key)).created_by, users.scorer.id)

    // stored now: the squatters meet the unique index / the ownership guard as before
    const late = await dbCall(users.pending, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: '000000' } })
    assert.notEqual(late.status, 200, late.text)
    assert.equal((await rowOf(key)).created_by, users.scorer.id)

    // the reconnect is proved by the database
    scorer.ws.terminate()
    const back = await open(scorerIp)
    back.send(sync(key, REAL, { gameNumber: 900106 }))
    await settle(back)
    assert.deepEqual(errorsOf(back), [])
    assert.equal(await owns(back, key), true)
    const attacker = await open(nextIp())
    attacker.send(sync(key, ATTACKER, {}, 'HIJACKED HOME'))
    await settle(attacker)
    assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'])
  })

  it('a wrong PIN under a held key is a counted guess: past the scope\'s limit the right one waits too (no oracle)', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const scorer = await open(nextIp())
    scorer.send(sync(key, REAL, { guest: true }))
    await settle(scorer)
    const guesser = { ...users.other, ip: nextIp() }
    let limited = null
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await dbCall(guesser, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: String(100000 + i) } })
      if (r.status === 429) limited = r
      else assert.equal(r.status, 409, r.text)
    }
    assert.ok(limited, 'the guesses are limited')
    assert.equal(limited.json.error.code, 'OV_TOO_MANY_ATTEMPTS')
    const right = await dbCall(guesser, 'matches', 'insert', { data: { external_id: key, test: true, status: 'setup', game_pin: REAL.gamePin } })
    assert.equal(right.status, 429, 'refused before the PIN is compared')
  })

  it('a key no relay room holds is written as before; the room\'s own PIN creates the row', async () => {
    const free = `match_${Date.now()}_${hex()}`
    const ins = await dbCall(users.scorer, 'matches', 'insert', { data: { external_id: free, game_n: 900107, status: 'setup', game_pin: '615283' } })
    assert.equal(ins.status, 200, ins.text)

    const key = `match_${Date.now()}_${hex()}`
    const scorer = await open(nextIp())
    scorer.send(sync(key, REAL))
    await settle(scorer)
    const rs = await restore(users.scorer, { external_id: key, game_n: 900108, status: 'live', game_pin: REAL.gamePin })
    assert.equal(rs.status, 200, rs.text)
    await waitUntil(async () => (await rowOf(key)) !== null, { what: 'the restored row' })
  })
})
