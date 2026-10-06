/**
 * Phase 7 security release, end to end: server.js against a real Postgres
 * (PG_TEST_URL, or OV_E2E_DOCKER=1 for a throwaway container; see
 * tests/server.e2e.test.js) with OV_PIN_SECRET set.
 *
 *   1. match ownership: creator / editor (game-PIN take-over) / admin /
 *      stranger / anonymous over /api/db, /api/match/restore, /api/match/claim
 *      and restore-by-pin; legacy rows without an owner are read-only
 *   2. PIN-gated match data: GET /api/match/:id and the relay hand out the
 *      summary before the PIN step, the bundle with a PIN or match token;
 *      anonymous /api/db rosters need the token
 *   3. backup/ objects are per account
 *   4. PINs are stored hashed and never returned or logged
 *   5. sign-up cannot set roles, and profiles.roles cannot be written
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, subscribe, sleep } from './helpers/e2eServer.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '824613'
const PINS = { referee: '461302', bench_home: '730214', bench_away: '519027', upload_home: '362951', upload_away: '208473' }
const ALL_PINS = [GAME_PIN, ...Object.values(PINS)]
const containsPin = (text) => ALL_PINS.some((p) => String(text).includes(p))

describe('Phase 7: ownership, PIN-gated data, backups, PINs at rest', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  let matchUuid

  async function account(name, { admin = false } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, roles: ['admin', 'super_admin'] } } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (admin) await sql.query("UPDATE public.profiles SET roles = ARRAY['scorer','admin'] WHERE user_id = $1", [u.id])
    return u
  }

  const dbCall = (user, table, action, params, extra = {}) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params }, ...extra })
  const expectNotOwner = (r) => {
    assert.equal(r.status, 403, r.text)
    assert.equal(r.json.error.code, 'OV_NOT_MATCH_OWNER')
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-sec-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-sec-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      OV_PIN_SECRET: PIN_SECRET
    })
    users.alice = await account('alice') // scores the match
    users.bob = await account('bob') // another account
    users.carol = await account('carol', { admin: true })
    users.dave = await account('dave') // a new scoring device, restores by PIN
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the creator is recorded server-side; PINs are stored hashed and never returned', async () => {
    const r = await dbCall(users.alice, 'matches', 'upsert', {
      data: {
        external_id: ext,
        game_n: 9301,
        game_pin: GAME_PIN,
        connection_pins: PINS,
        created_by: users.bob.id, // ignored
        connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: false },
        status: 'setup',
        sport_type: 'indoor',
        home_team: { name: 'Home VC' },
        away_team: { name: 'Away VC' },
        players_home: [{ number: 4, last_name: 'Muster', dob: '2002-03-04' }],
        scheduled_at: new Date().toISOString()
      },
      onConflict: 'external_id',
      returning: '*',
      single: true
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(containsPin(r.text), false)
    matchUuid = r.json.data.id
    const { rows: [row] } = await sql.query('SELECT created_by, game_pin, connection_pins FROM matches WHERE id = $1', [matchUuid])
    assert.equal(row.created_by, users.alice.id)
    assert.match(row.game_pin, /^h1:/)
    for (const v of Object.values(row.connection_pins)) assert.match(v, /^h1:/)
    assert.equal(containsPin(JSON.stringify(row)), false, 'a plaintext PIN is stored')
    // A later partial PIN update merges and is hashed too
    const upd = await dbCall(users.alice, 'matches', 'update', { data: { connection_pins: { referee: PINS.referee } }, filters: [{ type: 'eq', column: 'id', value: matchUuid }] })
    assert.equal(upd.status, 200, upd.text)
    const { rows: [again] } = await sql.query('SELECT connection_pins FROM matches WHERE id = $1', [matchUuid])
    assert.equal(Object.keys(again.connection_pins).length, 5)
    assert.equal(containsPin(JSON.stringify(again)), false)
  })

  it('the PIN checks work against hashed PINs and answer a match token', async () => {
    const ok = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.referee, type: 'referee' } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.match.id, ext)
    assert.match(ok.json.token, /^v1\./)
    assert.equal(containsPin(ok.text), false)
    const wrong = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { pin: '000000', type: 'referee' } })
    assert.equal(wrong.status, 404)
    const rbp = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: 9301, pin: GAME_PIN } })
    assert.equal(rbp.status, 200, rbp.text)
    assert.equal(rbp.json.data.match.id, matchUuid)
    assert.equal('created_by' in rbp.json.data.match, false)
    assert.equal(rbp.json.data.access, undefined, 'anonymous: a lookup, no access')
  })

  it('a stranger (and anonymous) cannot write the match, its children or restore it', async () => {
    const filters = [{ type: 'eq', column: 'external_id', value: ext }]
    expectNotOwner(await dbCall(users.bob, 'matches', 'update', { data: { status: 'final' }, filters }))
    expectNotOwner(await dbCall(users.bob, 'matches', 'upsert', { data: { external_id: ext, status: 'final' }, onConflict: 'external_id' }))
    expectNotOwner(await dbCall(users.bob, 'matches', 'delete', { filters }))
    expectNotOwner(await dbCall(users.bob, 'sets', 'insert', { data: { external_id: `${ext}:s:1`, match_id: matchUuid, index: 1 } }))
    expectNotOwner(await dbCall(users.bob, 'events', 'upsert', { data: { external_id: `${ext}:e:1`, match_id: matchUuid, type: 'point' }, onConflict: 'external_id' }))
    expectNotOwner(await dbCall(users.bob, 'match_live_state', 'upsert', { data: { match_id: matchUuid, points_a: 25 }, onConflict: 'match_id' }))
    const restore = await api(srv.base, '/api/match/restore', { token: users.bob.token, body: { match: { external_id: ext, status: 'final' }, sets: [], events: [] } })
    expectNotOwner(restore)
    assert.equal((await dbCall(null, 'matches', 'update', { data: { status: 'final' }, filters })).status, 401)
    const { rows: [row] } = await sql.query('SELECT status FROM matches WHERE id = $1', [matchUuid])
    assert.equal(row.status, 'setup')
    // The creator still writes everything
    assert.equal((await dbCall(users.alice, 'sets', 'insert', { data: { external_id: `${ext}:s:1`, match_id: matchUuid, index: 1, home_points: 1 } })).status, 200)
    assert.equal((await dbCall(users.alice, 'match_live_state', 'upsert', { data: { match_id: matchUuid, points_a: 1 }, onConflict: 'match_id' })).status, 200)
    const own = await api(srv.base, '/api/match/restore', { token: users.alice.token, body: { match: { external_id: ext, status: 'setup', game_pin: GAME_PIN, created_by: users.bob.id }, sets: [{ external_id: `${ext}:s:1`, index: 1 }], events: [] } })
    assert.equal(own.status, 200, own.text)
    const { rows: [restored] } = await sql.query('SELECT game_pin, created_by FROM matches WHERE id = $1', [matchUuid])
    assert.match(restored.game_pin, /^h1:/, 'a restore stores the PIN hashed')
    assert.equal(restored.created_by, users.alice.id, 'a backup cannot change the creator')
    // A stranger's own new match is theirs
    const mine = await dbCall(users.bob, 'matches', 'insert', { data: { external_id: `${ext}-bob`, status: 'setup' }, returning: 'created_by', single: true })
    assert.equal(mine.json.data.created_by, users.bob.id)
  })

  it('take-over: a signed-in account that proves the game PIN becomes an editor', async () => {
    const claimAnon = await api(srv.base, '/api/match/claim', { body: { externalId: ext, pin: GAME_PIN } })
    assert.equal(claimAnon.status, 401)
    const wrong = await api(srv.base, '/api/match/claim', { token: users.bob.token, headers: { 'cf-connecting-ip': nextIp() }, body: { externalId: ext, pin: PINS.referee } })
    assert.equal(wrong.status, 404, 'a connection PIN is not the game PIN')
    const ok = await api(srv.base, '/api/match/claim', { token: users.bob.token, body: { externalId: ext, pin: GAME_PIN } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.data.role, 'editor')
    const upd = await dbCall(users.bob, 'matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'external_id', value: ext }] })
    assert.equal(upd.status, 200, upd.text)
    const { rows: [row] } = await sql.query('SELECT created_by FROM matches WHERE id = $1', [matchUuid])
    assert.equal(row.created_by, users.alice.id, 'the creator stays')
    const creator = await api(srv.base, '/api/match/claim', { token: users.alice.token, body: { externalId: ext, pin: GAME_PIN } })
    assert.equal(creator.json.data.role, 'creator')

    // restore-by-pin with a session is the take-over of a new scoring device
    const rbp = await api(srv.base, '/api/match/restore-by-pin', { token: users.dave.token, proto: null, body: { gameN: 9301, pin: GAME_PIN } })
    assert.equal(rbp.status, 200, rbp.text)
    assert.equal(rbp.json.data.access, 'editor')
    assert.equal((await dbCall(users.dave, 'sets', 'upsert', { data: { external_id: `${ext}:s:1`, match_id: matchUuid, index: 1, home_points: 5 }, onConflict: 'external_id' })).status, 200)
  })

  it('a legacy match without an owner is read-only, except for an admin', async () => {
    const legacy = `legacy_${randomBytes(3).toString('hex')}`
    const { rows: [{ id }] } = await sql.query("INSERT INTO matches (external_id, status, sport_type) VALUES ($1, 'live', 'indoor') RETURNING id", [legacy])
    for (const u of [users.alice, users.bob]) {
      expectNotOwner(await dbCall(u, 'matches', 'update', { data: { status: 'final' }, filters: [{ type: 'eq', column: 'id', value: id }] }))
    }
    const read = await dbCall(users.bob, 'matches', 'select', { columns: 'id, status', filters: [{ type: 'eq', column: 'id', value: id }] })
    assert.deepEqual(read.json.data, [{ id, status: 'live' }])
    const admin = await dbCall(users.carol, 'matches', 'update', { data: { status: 'final' }, filters: [{ type: 'eq', column: 'id', value: id }] })
    assert.equal(admin.status, 200, admin.text)
    // the admin role is read from the database, never from a request
    const forged = await dbCall(users.bob, 'profiles', 'update', { data: { roles: ['admin'], first_name: 'Bobby' }, filters: [] })
    assert.equal(forged.status, 200, forged.text)
    const { rows: [p] } = await sql.query('SELECT roles, first_name FROM profiles WHERE user_id = $1', [users.bob.id])
    assert.deepEqual(p, { roles: ['scorer'], first_name: 'Bobby' })
    expectNotOwner(await dbCall(users.bob, 'matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'id', value: id }] }))
    // sign-up dropped the roles the client sent
    const { rows: [a] } = await sql.query('SELECT roles FROM profiles WHERE user_id = $1', [users.alice.id])
    assert.deepEqual(a.roles, ['scorer'])
  })

  it('anonymous /api/db: rosters and event payloads only with the match token of the PIN check', async () => {
    const select = (headers = {}) => api(srv.base, '/api/db', { proto: null, headers, body: { table: 'matches', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: ext }], maybeSingle: true } } })
    const anon = await select()
    assert.equal('players_home' in anon.json.data, false)
    assert.equal(anon.json.data.home_team.name, 'Home VC')
    const pin = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.bench_home, type: 'bench_home' } })
    const granted = await select({ 'X-OV-Match-Token': pin.json.token })
    assert.deepEqual(granted.json.data.players_home, [{ number: 4, last_name: 'Muster' }])
    const forged = await select({ 'X-OV-Match-Token': pin.json.token.slice(0, -2) + 'AA' })
    assert.equal('players_home' in forged.json.data, false)
    await dbCall(users.alice, 'events', 'insert', { data: { external_id: `${ext}:e:9`, match_id: matchUuid, type: 'sanction', payload: { player: 'Muster' } } })
    const ev = await api(srv.base, '/api/db', { proto: null, body: { table: 'events', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'match_id', value: matchUuid }] } } })
    assert.equal(ev.status, 200, ev.text)
    assert.ok(ev.json.data.length >= 1)
    assert.equal(ev.text.includes('Muster'), false, 'an event payload reached an anonymous reader')
  })

  it('relay and GET /api/match/:id: the summary before the PIN step, the bundle after it', async () => {
    const scoreboard = await openSocket(srv.wsUrl)
    const viewer = await openSocket(srv.wsUrl)
    const referee = await openSocket(srv.wsUrl)
    const tokenRef = await openSocket(srv.wsUrl)
    try {
      scoreboard.send({
        type: 'sync-match-data',
        matchId: 3,
        match: { id: 3, seed_key: ext, status: 'live', gamePin: GAME_PIN, refereePin: PINS.referee, homeTeamPin: PINS.bench_home, refereeConnectionEnabled: true, homeTeamConnectionEnabled: true },
        homeTeam: { name: 'Home VC' },
        awayTeam: { name: 'Away VC' },
        homePlayers: [{ number: 4, lastName: 'Muster', dob: '2002-03-04' }],
        sets: [{ index: 1, homePoints: 3, awayPoints: 1 }],
        events: [{ id: 1, type: 'point' }]
      })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')

      viewer.send({ type: 'subscribe-match', matchId: ext })
      const summary = await viewer.waitFor((m) => m.type === 'match-full-data')
      assert.equal(summary.access, 'summary')
      assert.deepEqual(summary.homePlayers, [])
      assert.deepEqual(summary.events, [])
      assert.equal(summary.match.status, 'live')

      referee.send({ type: 'subscribe-match', matchId: ext, pin: PINS.referee, device: 'referee' })
      const full = await referee.waitFor((m) => m.type === 'match-full-data')
      assert.equal(full.access, 'full')
      assert.equal(full.homePlayers[0].lastName, 'Muster')
      assert.equal(full.homePlayers[0].dob, undefined)

      const pinCheck = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.referee, type: 'referee' } })
      tokenRef.send({ type: 'subscribe-match', matchId: ext, token: pinCheck.json.token })
      assert.equal((await tokenRef.waitFor((m) => m.type === 'match-full-data')).access, 'full')

      const wrong = await openSocket(srv.wsUrl)
      wrong.send({ type: 'subscribe-match', matchId: ext, pin: '000000' })
      assert.equal((await wrong.waitFor((m) => m.type === 'error')).code, 'pin-invalid')
      wrong.ws.close()

      scoreboard.send({ type: 'match-action', matchId: 3, action: 'timeout', data: { team: 'home' } })
      await referee.waitFor((m) => m.type === 'match-action')
      scoreboard.send({ type: 'sync-match-data', matchId: 3, match: { id: 3, seed_key: ext, status: 'live', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true }, homePlayers: [{ number: 4 }], sets: [], events: [] })
      assert.equal((await viewer.waitFor((m) => m.type === 'match-data-update')).access, 'summary')
      assert.equal(viewer.messages.some((m) => m.type === 'match-action'), false, 'an action reached a socket without a PIN')
      for (const c of [viewer, referee, tokenRef]) assert.equal(containsPin(c.raw.join('')), false)

      const get = (headers = {}) => api(srv.base, `/api/match/${encodeURIComponent(ext)}`, { method: 'GET', proto: null, headers })
      const anon = await get()
      assert.equal(anon.json.access, 'summary')
      assert.deepEqual(anon.json.homePlayers, [])
      const byToken = await get({ 'X-OV-Match-Token': pinCheck.json.token })
      assert.equal(byToken.json.access, 'full')
      assert.equal(byToken.json.homePlayers[0].number, 4)
      assert.equal((await get({ 'X-OV-Match-Pin': PINS.bench_home })).json.access, 'full')
      assert.equal((await get({ 'X-OV-Match-Pin': '000000', 'cf-connecting-ip': nextIp() })).json.access, 'summary')
      assert.match((await fetch(`${srv.base}/api/match/x`, { method: 'OPTIONS' })).headers.get('access-control-allow-headers'), /X-OV-Match-Token, X-OV-Match-Pin/)
    } finally {
      for (const c of [scoreboard, viewer, referee, tokenRef]) c.ws.close()
    }
  })

  it('upload-roster: the team upload PIN of that match writes the pending roster only', async () => {
    const body = { matchExternalId: ext, team: 'home', pin: PINS.upload_home, roster: { players: [{ number: 12, lastName: 'Neu' }], bench: [] }, coachSignature: 'data:image/png;base64,COACH' }
    // The match must be in setup
    await sql.query("UPDATE matches SET status = 'setup' WHERE id = $1", [matchUuid])
    const wrong = await api(srv.base, '/api/match/upload-roster', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { ...body, pin: PINS.upload_away } })
    assert.equal(wrong.status, 403)
    const other = await api(srv.base, '/api/match/upload-roster', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { ...body, matchExternalId: `${ext}-bob` } })
    assert.equal(other.status, 403)
    const ok = await api(srv.base, '/api/match/upload-roster', { proto: null, body })
    assert.equal(ok.status, 200, ok.text)
    const { rows: [row] } = await sql.query('SELECT connections, signatures, status FROM matches WHERE id = $1', [matchUuid])
    assert.deepEqual(row.connections.pending_home_roster.players, [{ number: 12, lastName: 'Neu' }])
    assert.equal(row.connections.referee_enabled, true, 'the other connection keys stay')
    assert.equal(row.signatures.home_coach, 'data:image/png;base64,COACH')
    await sql.query("UPDATE matches SET status = 'live' WHERE id = $1", [matchUuid])
    const locked = await api(srv.base, '/api/match/upload-roster', { proto: null, body })
    assert.equal(locked.status, 409)
  })

  it('backup/ is per account: only the uploader lists and restores its backups', async () => {
    const path = `backups/backup_g9301/backup_${Date.now()}.json`
    const content = Buffer.from(JSON.stringify({ match: { external_id: ext } })).toString('base64')
    const up = await api(srv.base, '/api/storage/upload', { token: users.alice.token, body: { bucket: 'backup', path, fileBase64: content, contentType: 'application/json' } })
    assert.equal(up.status, 200, up.text)
    const listA = await api(srv.base, '/api/storage/list', { token: users.alice.token, body: { bucket: 'backup', path: 'backups/backup_g9301' } })
    assert.equal(listA.json.data.length, 1)
    const listB = await api(srv.base, '/api/storage/list', { token: users.bob.token, body: { bucket: 'backup', path: 'backups/backup_g9301' } })
    assert.deepEqual(listB.json.data, [])
    const getB = await api(srv.base, '/api/storage/download', { token: users.bob.token, body: { bucket: 'backup', path } })
    assert.equal(getB.json.data, null)
    const getA = await api(srv.base, '/api/storage/download', { token: users.alice.token, body: { bucket: 'backup', path } })
    assert.equal(Buffer.from(getA.json.data, 'base64').toString(), JSON.stringify({ match: { external_id: ext } }))
    assert.equal((await api(srv.base, '/api/storage/list', { body: { bucket: 'backup', path: '' } })).status, 401)
  })

  it('sign-up is rate limited per email address', async () => {
    const email = `limit-${randomBytes(3).toString('hex')}@example.ch`
    const statuses = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password: 'correct-horse-battery' } })).status)
    }
    assert.deepEqual(statuses, [200, 422, 422, 429])
  })

  it('relay: a referee/bench role on join_match proves nothing; wrong PINs share the /64 budget with the HTTP checks', async () => {
    const room = `relay_guess_${randomBytes(3).toString('hex')}`
    const scoreboard = await openSocket(srv.wsUrl)
    const sockets = []
    const from = async (ip) => {
      const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
      sockets.push(c)
      return c
    }
    try {
      scoreboard.send({
        type: 'sync-match-data',
        matchId: 11,
        match: { id: 11, seed_key: room, status: 'live', gamePin: '913524', refereePin: '642097', homeTeamPin: '305718', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true },
        homePlayers: [{ number: 9, lastName: 'Geheim' }],
        sets: [],
        events: []
      })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')

      // The old role check is gone: a role alone joins with the summary only
      const labelled = await from('2001:db8:77::1')
      labelled.send({ type: 'join_match', matchId: room, role: 'referee' })
      assert.equal((await labelled.waitFor((m) => m.type === 'match-full-data')).access, 'summary')

      // Wrong PINs through join_match / subscribe-match with a role: counted
      // per socket (5) ...
      const guesser = await from('2001:db8:77::2')
      for (let i = 0; i < 5; i++) {
        guesser.send({ type: i % 2 ? 'subscribe-match' : 'join_match', matchId: room, role: i % 2 ? undefined : 'referee', team: 'home', pin: String(100000 + i) })
      }
      for (let i = 0; i < 5; i++) await guesser.waitFor((m) => m.type === 'error' && m.code === 'pin-invalid' && guesser.messages.filter((x) => x.code === 'pin-invalid').length > i)
      guesser.send({ type: 'join_match', matchId: room, role: 'referee', pin: '642097' })
      await guesser.waitFor((m) => m.type === 'error' && m.code === 'rate-limited')
      assert.equal(guesser.messages.some((m) => m.access === 'full'), false, 'over the limit the right PIN must not be compared')
      // ... and per IPv6 /64 across sockets, in the budget the HTTP PIN checks use
      for (let s = 3; s <= 5; s++) {
        const c = await from(`2001:db8:77::${s}`)
        for (let i = 0; i < 5; i++) c.send({ type: 'join_match', matchId: room, role: 'bench', team: 'home', pin: String(200000 + s * 10 + i) })
        await c.waitFor(() => c.messages.filter((x) => x.type === 'error').length >= 5)
      }
      const late = await from('2001:db8:77::99')
      late.send({ type: 'join_match', matchId: room, role: 'referee', pin: '642097' })
      assert.equal((await late.waitFor((m) => m.type === 'error')).code, 'rate-limited')
      assert.equal(late.messages.some((m) => m.access === 'full'), false)
      const http = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '2001:db8:77::abcd' }, body: { pin: PINS.referee, type: 'referee' } })
      assert.equal(http.status, 429, 'the relay guesses used up the HTTP budget of the /64')
      const validate = await api(srv.base, '/api/match/validate-pin', { proto: null, headers: { 'cf-connecting-ip': '2001:db8:77::abce' }, body: { pin: '642097', type: 'referee' } })
      assert.equal(validate.status, 429)
      // Another network is not affected; the right PIN joins with the bundle
      const ref = await from('203.0.113.77')
      ref.send({ type: 'join_match', matchId: room, role: 'referee', pin: '642097' })
      const full = await ref.waitFor((m) => m.type === 'match-full-data' && m.access === 'full')
      assert.equal(full.homePlayers[0].lastName, 'Geheim')
    } finally {
      for (const c of [scoreboard, ...sockets]) c.ws.close()
    }
  })

  it('relay: no socket speaks for a database match without its game PIN (claims, squatting, live state)', async () => {
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    const attacker = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': '198.18.0.66' } })
    const scorer = await openSocket(srv.wsUrl)
    try {
      await subscribe(live, 'ls', [{ table: 'match_live_state', event: '*', column: 'match_id', value: matchUuid }])
      // Its own room, pointing at the victim's row by the public uuid: refused
      attacker.send({ type: 'sync-match-data', matchId: 'x1', match: { id: 'x1', seed_key: `squat_${randomBytes(3).toString('hex')}`, externalId: matchUuid, gamePin: '111111', status: 'live' }, sets: [], events: [] })
      assert.equal((await attacker.waitFor((m) => m.type === 'error')).code, 'not-match-owner')
      // Squatting the victim's room key before the scorer syncs: refused
      attacker.send({ type: 'sync-match-data', matchId: 'x2', match: { id: 'x2', seed_key: ext, gamePin: '222222', status: 'live' }, sets: [], events: [] })
      await attacker.waitFor(() => attacker.messages.filter((m) => m.code === 'not-match-owner').length >= 2)
      // A room of its own (not in the database) is fine; re-pointing it at the
      // victim afterwards publishes nothing
      const own = `own_${randomBytes(3).toString('hex')}`
      attacker.send({ type: 'sync-match-data', matchId: 'x3', match: { id: 'x3', seed_key: own, gamePin: '333333', status: 'live' }, sets: [], events: [] })
      attacker.send({ type: 'sync-match-data', matchId: 'x3', match: { id: 'x3', seed_key: own, externalId: matchUuid, status: 'live' }, sets: [], events: [] })
      attacker.send({ type: 'live-state-update', matchId: 'x3', liveState: { points_a: 99, points_b: 0 } })
      attacker.send({ type: 'ping' })
      await attacker.waitFor((m) => m.type === 'pong')
      // The real scorer: its room, its PIN, published
      scorer.send({ type: 'sync-match-data', matchId: 5, match: { id: 5, seed_key: ext, gamePin: GAME_PIN, status: 'live' }, sets: [], events: [] })
      scorer.send({ type: 'live-state-update', matchId: 5, liveState: { points_a: 12, points_b: 10 } })
      await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.points_a === 12, 5000, 'scorer live state')
      await sleep(200)
      assert.equal(live.messages.some((m) => m.type === 'db-change' && m.new?.points_a === 99), false, 'a forged live state was published')
      assert.equal(scorer.messages.some((m) => m.type === 'error'), false, JSON.stringify(scorer.messages))
    } finally {
      for (const c of [live, attacker, scorer]) c.ws.close()
    }
  })

  it('signed-in non-owners read other people\'s matches like anonymous readers', async () => {
    const erin = await account('erin')
    const sel = (u, params) => dbCall(u, 'matches', 'select', { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: ext }], ...params })
    const owner = await sel(users.alice)
    assert.equal(owner.json.data[0].players_home[0].dob, '2002-03-04')
    assert.equal(owner.json.data[0].signatures.home_coach, 'data:image/png;base64,COACH')
    const other = await sel(erin)
    assert.equal(other.status, 200, other.text)
    const row = other.json.data[0]
    assert.equal(row.home_team.name, 'Home VC')
    for (const k of ['players_home', 'signatures', 'officials', 'created_by', 'manual_changes', 'approval', '__owned']) assert.equal(k in row, false, k)
    assert.deepEqual(Object.keys(row.connections).sort(), ['away_bench_enabled', 'home_bench_enabled', 'referee_enabled'])
    // Admins read everything
    assert.equal((await sel(users.carol)).json.data[0].signatures.home_coach, 'data:image/png;base64,COACH')
    // A filter on a hidden column only matches the reader's own rows (no probing)
    const probe = (u) => sel(u, { filters: [{ type: 'eq', column: 'external_id', value: ext }, { type: 'eq', column: 'signatures->>home_coach', value: 'data:image/png;base64,COACH' }] })
    assert.deepEqual((await probe(erin)).json.data, [])
    assert.equal((await probe(users.alice)).json.data.length, 1)
    // Event payloads likewise
    const ev = await dbCall(erin, 'events', 'select', { columns: '*', filters: [{ type: 'eq', column: 'match_id', value: matchUuid }] })
    assert.ok(ev.json.data.length >= 1)
    assert.equal(ev.text.includes('Muster'), false, 'an event payload reached a non-owner')
    const evOwn = await dbCall(users.alice, 'events', 'select', { columns: '*', filters: [{ type: 'eq', column: 'match_id', value: matchUuid }] })
    assert.equal(evOwn.text.includes('Muster'), true)
  })

  it('reference tables: read-only for accounts; the referee directory takes new referees and sports', async () => {
    const { rows: [game] } = await sql.query("INSERT INTO svrz_games (game_number, team_home) VALUES ('77001', 'A') RETURNING id")
    const svrz = (u, action, params) => dbCall(u, 'svrz_games', action, params)
    for (const [action, params] of [
      ['update', { data: { team_home: 'X' }, filters: [{ type: 'neq', column: 'id', value: -1 }] }],
      ['delete', { filters: [{ type: 'neq', column: 'id', value: -1 }] }],
      ['insert', { data: { game_number: '1' } }]
    ]) {
      const r = await svrz(users.bob, action, params)
      assert.equal(r.status, 403, `${action}: ${r.text}`)
      assert.equal(r.json.error.code, 'OV_READ_ONLY_TABLE')
    }
    assert.equal((await svrz(users.carol, 'update', { data: { team_home: 'B' }, filters: [{ type: 'eq', column: 'id', value: game.id }] })).status, 200)
    const { rows: [after] } = await sql.query('SELECT team_home FROM svrz_games WHERE id = $1', [game.id])
    assert.equal(after.team_home, 'B')

    const ins = await dbCall(users.bob, 'referee_database', 'insert', { data: { first_name: 'Rita', last_name: 'Ref', sport_type: ['indoor'] }, returning: 'id', single: true })
    assert.equal(ins.status, 200, ins.text)
    const id = ins.json.data.id
    assert.equal((await dbCall(users.bob, 'referee_database', 'update', { data: { sport_type: ['indoor', 'beach'] }, filters: [{ type: 'eq', column: 'id', value: id }] })).status, 200)
    for (const [action, params] of [
      ['update', { data: { last_name: 'X' }, filters: [{ type: 'eq', column: 'id', value: id }] }],
      ['update', { data: { sport_type: [] }, filters: [{ type: 'neq', column: 'id', value: id }] }],
      ['delete', { filters: [{ type: 'eq', column: 'id', value: id }] }],
      ['upsert', { data: { id, first_name: 'X' } }]
    ]) {
      const r = await dbCall(users.bob, 'referee_database', action, params)
      assert.equal(r.status, 403, `${action}: ${r.text}`)
    }
    assert.equal((await dbCall(users.carol, 'referee_database', 'delete', { filters: [{ type: 'eq', column: 'id', value: id }] })).status, 200)
    // beach_competition_matches is not reachable through /api/db at all
    const beach = await api(srv.base, '/api/db', { proto: null, body: { table: 'beach_competition_matches', action: 'select', params: { columns: '*' } } })
    assert.equal(beach.status, 400)
  })

  it('a legacy match is taken over inline by a scorer upsert carrying its game PIN', async () => {
    const legacy = `legacy_pin_${randomBytes(3).toString('hex')}`
    await sql.query("INSERT INTO matches (external_id, status, sport_type, game_pin) VALUES ($1, 'live', 'indoor', '579135')", [legacy])
    const upsert = (u, pin, headers = {}) => dbCall(u, 'matches', 'upsert', { data: { external_id: legacy, game_pin: pin, status: 'live', current_set: 2 }, onConflict: 'external_id' }, { headers })
    expectNotOwner(await upsert(users.bob, '000001', { 'cf-connecting-ip': nextIp() }))
    const ok = await upsert(users.dave, '579135')
    assert.equal(ok.status, 200, ok.text)
    const { rows } = await sql.query('SELECT e.user_id, m.current_set, m.created_by, m.game_pin FROM match_editors e JOIN matches m ON m.id = e.match_id WHERE m.external_id = $1', [legacy])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].user_id, users.dave.id)
    assert.equal(rows[0].current_set, 2)
    assert.equal(rows[0].created_by, null, 'the legacy row keeps no creator')
    assert.match(rows[0].game_pin, /^h1:/)
    // An update without the PIN stays refused for others
    expectNotOwner(await dbCall(users.bob, 'matches', 'update', { data: { status: 'final' }, filters: [{ type: 'eq', column: 'external_id', value: legacy }] }))
  })

  it('never logged a PIN', () => {
    assert.equal(containsPin(srv.output.join('')), false, 'a PIN reached the server log')
  })
})

describe('LAN relay mode (no database, no accounts): the PIN step works with zero setup', () => {
  let srv
  before(async () => {
    srv = await bootServer({}, ['--local'])
  })
  after(async () => {
    await srv?.stop()
  })

  it('subscribe without a PIN: summary; with the referee PIN or the validate-pin token: bundle', async () => {
    const scoreboard = await openSocket(srv.wsUrl)
    const viewer = await openSocket(srv.wsUrl)
    const referee = await openSocket(srv.wsUrl)
    try {
      scoreboard.send({
        type: 'sync-match-data',
        matchId: 1,
        match: { id: 1, seed_key: 'match_lan_1', status: 'live', gamePin: GAME_PIN, refereePin: PINS.referee, refereeConnectionEnabled: true },
        homeTeam: { name: 'Home VC' },
        awayTeam: { name: 'Away VC' },
        homePlayers: [{ number: 4, lastName: 'Muster' }],
        sets: [],
        events: [{ id: 1 }]
      })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')
      viewer.send({ type: 'subscribe-match', matchId: 'match_lan_1' })
      const summary = await viewer.waitFor((m) => m.type === 'match-full-data')
      assert.equal(summary.access, 'summary')
      assert.deepEqual(summary.homePlayers, [])
      referee.send({ type: 'subscribe-match', matchId: 'match_lan_1', pin: PINS.referee })
      const full = await referee.waitFor((m) => m.type === 'match-full-data')
      assert.equal(full.access, 'full')
      assert.equal(full.homePlayers[0].lastName, 'Muster')

      const v = await api(srv.base, '/api/match/validate-pin', { proto: null, body: { pin: PINS.referee, type: 'referee' } })
      assert.equal(v.status, 200, v.text)
      assert.match(v.json.token, /^v1\./)
      assert.equal(containsPin(v.text), false)
      const get = (headers = {}) => api(srv.base, '/api/match/match_lan_1', { method: 'GET', proto: null, headers })
      assert.equal((await get()).json.access, 'summary')
      assert.equal((await get({ 'X-OV-Match-Token': v.json.token })).json.access, 'full')
      assert.equal((await get({ 'X-OV-Match-Pin': GAME_PIN })).json.access, 'full')
      for (const c of [viewer, referee]) assert.equal(containsPin(c.raw.join('')), false)
    } finally {
      for (const c of [scoreboard, viewer, referee]) c.ws.close()
    }
  })
})
