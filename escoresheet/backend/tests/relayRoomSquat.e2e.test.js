/**
 * Audit 2611 PERM-01: any signed-up account (even role-less) filed a matches
 * row under the public key of a relay room that has no database row (a
 * guest, Global or test match, or an official match whose first insert was
 * still pending), with its own game PIN. The relay then took that row as
 * proof (server.js verifyRelayClaim): the room's real scorer was refused
 * ('not-match-owner') and evicted, the filer fed the referee, benches and
 * livescore a forged match, and an official match never reached the cloud
 * (its scorer's upsert was 403 OV_NOT_MATCH_OWNER).
 * Now a new row under the key of a room the relay knows needs the key's first
 * game PIN or its first device (409 OV_MATCH_KEY_IN_USE), and a test row, a
 * row newer than a local-only room, or a row under another key (named by
 * uuid in the sync) never proves a claim.
 * Review fix-ups: MW-R1 (the uuid-named row), MW-R2 (a take-over past the
 * grace does not change the PIN a new row needs), MW-R3 (an older app's
 * Create match without the PIN, from the room's own device).
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
import { SKIP, bootServer, api, openSocket, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const hex = () => randomBytes(4).toString('hex')
// lib/displayCodes.js CODE_ALPHABET
const displayCode = () => [...randomBytes(8)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('')
const REAL = { gamePin: '246813', refereePin: '135792', homeTeamPin: '864201', awayTeamPin: '975310' }
const ATTACKER = { gamePin: '424242', refereePin: '101010', homeTeamPin: '202020', awayTeamPin: '303030' }
// an installation as the apps name it (db/019: request.device / sync device)
const newDevice = (platform = 'android') => ({ id: randomUUID(), platform })

/** One backend on its own database, and the helpers the tests drive it with. */
function harness ({ ipBase, env = {} }) {
  const h = { users: {}, sockets: [], srv: null, sql: null, db: null, storageRoot: null }
  let ipN = ipBase
  h.nextIp = () => `203.0.113.${ipN++}`

  h.account = async (name, roles = null) => {
    const ip = h.nextIp()
    const email = `${name}-${hex()}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(h.srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })).status, 200)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(h.srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, ip }
    if (roles) await grantRoles(h.sql, u.id, roles)
    return u
  }
  // `extra`: more of the request body (the app's `device`)
  h.dbCall = (user, table, action, params, extra = {}) =>
    api(h.srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { table, action, params, ...extra } })
  h.restore = (user, match, extra = {}) =>
    api(h.srv.base, '/api/match/restore', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { match, sets: [], events: [], ...extra } })
  h.query = (text, values) => h.sql.query(text, values)
  h.rowOf = async (ext) => (await h.sql.query('SELECT id, external_id, test, created_by FROM matches WHERE external_id = $1', [ext])).rows[0] || null

  h.open = async (ip) => {
    const c = await openSocket(h.srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    h.sockets.push(c)
    return c
  }
  // `extra`: more of the message (the app's `device`)
  h.sync = (key, pins, flags = {}, home = 'Real Home', extra = {}) => ({
    type: 'sync-match-data',
    matchId: key,
    match: { seed_key: key, ...pins, status: 'live', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true, ...flags },
    homeTeam: { id: 1, name: home },
    awayTeam: { id: 2, name: 'Real Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: [],
    ...extra
  })
  h.errorsOf = (c, key) => c.messages.filter((m) => m.type === 'error' && (!key || m.matchId === key)).map((m) => m.code)
  // the relay answers a granted claim with nothing; a refused one with an error
  h.settle = async (c) => {
    c.send({ type: 'ping' })
    await c.waitFor((m) => m.type === 'pong', 5000, 'pong')
    await sleep(150)
  }
  h.owns = async (c, key) => {
    const before = c.messages.length
    c.send({ type: 'display-code-set', matchId: key, code: displayCode(), issuedAt: Date.now() })
    const m = await c.waitFor((x, i) => x.type === 'display-code-state' && i >= before, 3000, 'display-code-state').catch(() => null)
    return m?.active === true
  }
  h.roomHome = async (key) => (await api(h.srv.base, `/api/match/${key}`, { method: 'GET', proto: null, headers: { 'cf-connecting-ip': h.nextIp() } })).json?.homeTeam?.name

  h.start = async () => {
    h.db = await provisionDatabase()
    h.sql = new pg.Client({ connectionString: h.db.url })
    await h.sql.connect()
    h.storageRoot = mkdtempSync(join(tmpdir(), 'ov-squat-storage-'))
    writeFileSync(join(h.storageRoot, '.ovdata'), '')
    h.srv = await bootServer({ DATABASE_URL: h.db.appUrl(), STORAGE_ROOT: h.storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', ...env })
    h.users.pending = await h.account('pending') // signed up, no role: test matches only
    h.users.scorer = await h.account('scorer', ['scorer'])
    h.users.other = await h.account('other', ['scorer']) // an approved scorer of somewhere else
  }
  h.stop = async () => {
    for (const c of h.sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await h.sql?.end().catch(() => {})
    await h.srv?.stop()
    await h.db?.drop()
    if (h.storageRoot) rmSync(h.storageRoot, { recursive: true, force: true })
  }
  return h
}

describe('relay room keys and the rows filed under them (PERM-01)', { skip: SKIP }, () => {
  const h = harness({ ipBase: 20 })
  const { users, dbCall, restore, rowOf, open, sync, errorsOf, settle, owns, roomHome, nextIp } = h

  before(() => h.start())
  after(() => h.stop())

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
    await h.query('INSERT INTO matches (external_id, test, status, game_pin, created_by) VALUES ($1, false, $2, $3, $4)', [key, 'setup', ATTACKER.gamePin, users.other.id])
    const attacker = await open(nextIp())
    attacker.send(sync(key, ATTACKER, {}, 'HIJACKED HOME'))
    await settle(attacker)
    assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'])
    assert.equal(await owns(scorer, key), true)
  })

  // MW-R1: verifyRelayClaim also looks up the row the sync names by uuid
  // (match.externalId), which may be stored under any key
  for (const [kind, flags, gameN, ownGameN] of [['guest', { guest: true }, null, 900121], ['pending official', { gameNumber: 900122 }, 900122, 900123]]) {
    it(`a ${kind} room: the claimant's own row under another key, named by uuid in the sync, proves nothing (MW-R1)`, async () => {
      const own = `match_${Date.now()}_${hex()}`
      const ins = await dbCall(users.other, 'matches', 'insert', { data: { external_id: own, test: false, status: 'setup', game_n: ownGameN, game_pin: ATTACKER.gamePin } })
      assert.equal(ins.status, 200, ins.text)
      const uuid = (await rowOf(own)).id
      await sleep(30) // the row is older than the room
      const key = `match_${Date.now()}_${hex()}`
      const scorerIp = nextIp()
      const scorer = await open(scorerIp)
      scorer.send(sync(key, REAL, flags))
      await settle(scorer)
      assert.deepEqual(errorsOf(scorer), [])

      const attacker = await open(nextIp())
      const claim = sync(key, ATTACKER, {}, 'HIJACKED HOME')
      claim.match.externalId = uuid
      attacker.send(claim)
      await settle(attacker)
      assert.deepEqual(errorsOf(attacker, key), ['not-match-owner'])
      assert.equal(await owns(attacker, key), false)
      assert.equal(await owns(scorer, key), true, 'the scorer is not evicted')
      assert.equal(await roomHome(key), 'Real Home')
      if (gameN === null) return

      // the scorer's pending insert still goes through with its own PIN ...
      const up = await dbCall(users.scorer, 'matches', 'upsert', { data: { external_id: key, game_n: gameN, status: 'setup', test: false, sport_type: 'indoor', game_pin: REAL.gamePin }, onConflict: 'external_id' })
      assert.equal(up.status, 200, up.text)
      assert.equal((await rowOf(key)).created_by, users.scorer.id)
      // ... and its own row, named by uuid too, proves its reconnect
      scorer.ws.terminate()
      const back = await open(scorerIp)
      const again = sync(key, REAL, flags)
      again.match.externalId = (await rowOf(key)).id
      back.send(again)
      await settle(back)
      assert.deepEqual(errorsOf(back), [])
      assert.equal(await owns(back, key), true)
    })
  }

  it('a room keyed by a number: a row filed under it as a number needs its PIN too', async () => {
    const n = 700000000 + Math.floor(Math.random() * 99999999)
    const scorer = await open(nextIp())
    const m = sync(String(n), REAL, { guest: true })
    delete m.match.seed_key // an app without a seed key: the room is keyed by the id it sends
    m.matchId = n
    scorer.send(m)
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    for (const action of ['insert', 'upsert']) {
      const r = await dbCall(users.other, 'matches', action, { data: { external_id: n, test: true, status: 'setup', game_pin: ATTACKER.gamePin }, ...(action === 'upsert' ? { onConflict: 'external_id' } : {}) })
      assert.equal(r.status, 409, r.text)
      assert.equal(r.json.error.code, 'OV_MATCH_KEY_IN_USE')
    }
    const rs = await restore(users.other, { external_id: n, test: true, status: 'live', game_pin: ATTACKER.gamePin })
    assert.equal(rs.status, 409, rs.text)
    assert.equal(await rowOf(String(n)), null)
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

  // MW-R3: OV 3.2.0-3.2.9 queued Create match with game_pin null when Save
  // had not made the PIN yet (the Scoreboard then synced it); OpenBeach's
  // Create match sends the PIN of its React state, which its relay
  // publisher may have just made; a restore leaves a PIN it made up out
  it('the key\'s own device files its row without the PIN; no other device or account does (MW-R3)', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const device = newDevice()
    const scorer = await open(nextIp())
    scorer.send(sync(key, REAL, { gameNumber: 900131 }, 'Real Home', { device }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])

    const row = { external_id: key, game_n: 900131, status: 'setup', test: false, sport_type: 'indoor', game_pin: null }
    for (const extra of [{}, { device: newDevice('web') }]) {
      const other = await dbCall(users.other, 'matches', 'upsert', { data: row, onConflict: 'external_id' }, extra)
      assert.equal(other.status, 409, other.text)
      assert.equal(other.json.error.code, 'OV_MATCH_KEY_IN_USE')
    }
    // the same account from another device: the PIN-less row is refused too
    const elsewhere = await dbCall(users.scorer, 'matches', 'upsert', { data: row, onConflict: 'external_id' }, { device: newDevice('web') })
    assert.equal(elsewhere.status, 409, elsewhere.text)
    // the device is no proof of a PIN: with another PIN its row is refused
    const wrongPin = await dbCall(users.other, 'matches', 'upsert', { data: { ...row, game_pin: ATTACKER.gamePin }, onConflict: 'external_id' }, { device })
    assert.equal(wrongPin.status, 409, wrongPin.text)
    assert.equal(await rowOf(key), null)

    // the room's own installation: as an older app sends it
    const own = await dbCall(users.scorer, 'matches', 'upsert', { data: row, onConflict: 'external_id' }, { device })
    assert.equal(own.status, 200, own.text)
    assert.equal((await rowOf(key)).created_by, users.scorer.id)
  })

  it('a restore without the game PIN from the key\'s own device creates the match; from another device it is refused (MW-R3)', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const device = newDevice('tauri-linux')
    const scorer = await open(nextIp())
    scorer.send(sync(key, { ...REAL, gamePin: '777111' }, { gameNumber: 900132 }, 'Real Home', { device }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    const match = { external_id: key, game_n: 900132, status: 'live' }

    const other = await restore(users.other, match, { device: newDevice() })
    assert.equal(other.status, 409, other.text)
    assert.equal(other.json.error.code, 'OV_MATCH_KEY_IN_USE')
    assert.equal(await rowOf(key), null)

    const own = await restore(users.scorer, match, { device })
    assert.equal(own.status, 200, own.text)
    await waitUntil(async () => (await rowOf(key)) !== null, { what: 'the restored row' })
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

// MW-R2: a finished match's claim goes 60 s after its scorer did (shortened
// here, OV_ORPHAN_TAKEOVER_TEST_MS); any socket then owns the key with a PIN
// of its own. A new row under the key still needs the key's first PIN.
const GRACE_MS = 1500
describe('a key taken over past the grace keeps its first game PIN for new rows (PERM-01, MW-R2)', { skip: SKIP }, () => {
  const h = harness({ ipBase: 120, env: { OV_ORPHAN_TAKEOVER_TEST_MS: String(GRACE_MS) } })
  const { users, dbCall, restore, rowOf, open, sync, errorsOf, settle, owns, roomHome, nextIp } = h

  before(() => h.start())
  after(() => h.stop())

  it('a finished official match whose first insert is pending: the taker cannot file the row, the scorer still can and gets its room back', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const scorerIp = nextIp()
    const device = newDevice()
    const flags = { gameNumber: 900141, status: 'final' }
    const scorer = await open(scorerIp)
    scorer.send(sync(key, REAL, flags, 'Real Home', { device }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    scorer.ws.terminate() // the tablet sleeps
    await sleep(GRACE_MS + 500)

    // an anonymous socket owns the key now, with a PIN of its own (as before)
    const taker = await open(nextIp())
    taker.send(sync(key, ATTACKER, { status: 'final' }, 'HIJACKED HOME'))
    await settle(taker)
    assert.deepEqual(errorsOf(taker, key), [])
    assert.equal(await owns(taker, key), true)

    // the taker's PIN files no row, through either path
    const squat = await dbCall(users.other, 'matches', 'upsert', { data: { external_id: key, game_n: 900141, status: 'final', test: false, sport_type: 'indoor', game_pin: ATTACKER.gamePin }, onConflict: 'external_id' })
    assert.equal(squat.status, 409, squat.text)
    assert.equal(squat.json.error.code, 'OV_MATCH_KEY_IN_USE')
    const squat2 = await restore(users.other, { external_id: key, game_n: 900141, status: 'final', game_pin: ATTACKER.gamePin })
    assert.equal(squat2.status, 409, squat2.text)
    assert.equal(await rowOf(key), null)

    // the scorer's queued insert, with the PIN it synced first
    const own = await dbCall(users.scorer, 'matches', 'upsert', { data: { external_id: key, game_n: 900141, status: 'final', test: false, sport_type: 'indoor', game_pin: REAL.gamePin }, onConflict: 'external_id' }, { device })
    assert.equal(own.status, 200, own.text)
    assert.equal((await rowOf(key)).created_by, users.scorer.id)

    // its reconnect is proved by the row: the taker goes
    const back = await open(scorerIp)
    back.send(sync(key, REAL, flags, 'Real Home', { device }))
    await settle(back)
    assert.deepEqual(errorsOf(back, key), [])
    assert.equal(await owns(back, key), true)
    assert.equal(await owns(taker, key), false)
    assert.equal(await roomHome(key), 'Real Home')
  })

  it('a finished match whose claim simply ended: an account files no row under its key without its first PIN', async () => {
    const key = `match_${Date.now()}_${hex()}`
    const scorer = await open(nextIp())
    scorer.send(sync(key, REAL, { gameNumber: 900142, status: 'final' }))
    await settle(scorer)
    scorer.ws.terminate()
    await sleep(GRACE_MS + 500)
    // no room holds the key any more, nobody took it
    const squat = await dbCall(users.other, 'matches', 'insert', { data: { external_id: key, game_n: 900142, status: 'final', test: false, game_pin: ATTACKER.gamePin } })
    assert.equal(squat.status, 409, squat.text)
    const own = await dbCall(users.scorer, 'matches', 'insert', { data: { external_id: key, game_n: 900142, status: 'final', test: false, game_pin: REAL.gamePin } })
    assert.equal(own.status, 200, own.text)
  })
})
