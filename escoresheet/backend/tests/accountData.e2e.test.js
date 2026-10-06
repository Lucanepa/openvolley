/**
 * Account data, storage clean-up and the tablet list, end to end: server.js
 * against a real Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1; see
 * tests/server.e2e.test.js) and a temp storage root.
 *
 *   1. delete-account removes the account's personal data: profile, sessions,
 *      user_matches, match_editors, its backups (backup/<user id>/) and its
 *      scoresheet owner entries; its matches stay with created_by NULL and
 *      its scoresheet files stay as match records (README "Deleting an
 *      account")
 *   2. /api/storage/remove deletes the caller's own object and its
 *      .owners/<bucket>/<sha256>.json sidecar
 *   3. /api/server/connections (cloud): counts for anonymous callers, the
 *      tablet detail of one match only with its PIN
 *   4. a match created with all five connection PINs: the upload PIN
 *      validates and authorises the roster upload at once (Create match)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '615203'
const PINS = { referee: '402816', bench_home: '913027', bench_away: '275140', upload_home: '538261', upload_away: '760493' }

describe('account deletion, storage remove, tablet list', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`

  async function account(name) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name } } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    // an approved scorer (new accounts are pending since db/007)
    await grantRoles(sql, inn.json.data.user.id, ['scorer'])
    return { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const upload = (user, bucket, path, content, contentType = 'application/json') =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket, path, fileBase64: Buffer.from(content).toString('base64'), contentType } })
  const sidecar = (bucket, key) => join(storageRoot, '.owners', bucket, createHash('sha256').update(key).digest('hex') + '.json')

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-acct-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-acct-status-'))
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
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('Create match with all five PINs: the upload PIN validates and takes the roster at once', async () => {
    const alice = await account('creator')
    const ext = `match_${Date.now()}_up`
    const r = await dbCall(alice, 'matches', 'upsert', {
      data: { external_id: ext, game_n: 9401, game_pin: GAME_PIN, connection_pins: PINS, status: 'setup', sport_type: 'indoor', home_team: { name: 'Home' }, away_team: { name: 'Away' }, scheduled_at: new Date().toISOString() },
      onConflict: 'external_id'
    })
    assert.equal(r.status, 200, r.text)
    const { rows: [row] } = await sql.query('SELECT connection_pins FROM matches WHERE external_id = $1', [ext])
    assert.deepEqual(Object.keys(row.connection_pins).sort(), Object.keys(PINS).sort())
    for (const v of Object.values(row.connection_pins)) assert.match(v, /^h1:/, 'stored hashed')
    const check = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.upload_home, type: 'upload_home', matchExternalId: ext } })
    assert.equal(check.status, 200, check.text)
    const roster = await api(srv.base, '/api/match/upload-roster', { proto: null, body: { matchExternalId: ext, team: 'home', pin: PINS.upload_home, roster: { players: [{ number: 3 }], bench: [] } } })
    assert.equal(roster.status, 200, roster.text)
    // The scorer finds it: its own match row, connections.pending_home_roster
    const found = await dbCall(alice, 'matches', 'select', { columns: 'connections', filters: [{ type: 'eq', column: 'external_id', value: ext }], maybeSingle: true })
    assert.equal(found.status, 200, found.text)
    assert.deepEqual(found.json.data.connections.pending_home_roster.players, [{ number: 3 }])
  })

  it('/api/storage/remove deletes the caller\'s own scoresheet and its owner sidecar', async () => {
    const bob = await account('remover')
    const mallory = await account('mallory')
    const key = `2026-10-06/game9402_k${'a'.repeat(32)}_final.json`
    assert.equal((await upload(bob, 'scoresheets', key, '{"sheet":1}')).status, 200)
    assert.equal(existsSync(sidecar('scoresheets', key)), true)
    const refused = await api(srv.base, '/api/storage/remove', { token: mallory.token, body: { bucket: 'scoresheets', paths: [key] } })
    assert.equal(refused.status, 403)
    assert.equal((await api(srv.base, '/api/storage/remove', { body: { bucket: 'scoresheets', paths: [key] } })).status, 401)
    const ok = await api(srv.base, '/api/storage/remove', { token: bob.token, body: { bucket: 'scoresheets', paths: [key] } })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.json.data, [{ name: key }])
    assert.equal(existsSync(join(storageRoot, 'scoresheets', key)), false)
    assert.equal(existsSync(sidecar('scoresheets', key)), false, 'the sidecar went with the object')
  })

  it('delete-account removes the personal data and keeps the match records without an owner', async () => {
    const scorer = await account('leaver')
    const other = await account('stays')
    const ext = `match_${Date.now()}_del`
    const r = await dbCall(scorer, 'matches', 'upsert', {
      data: { external_id: ext, game_n: 9403, game_pin: GAME_PIN, status: 'final', sport_type: 'indoor', home_team: { name: 'H' }, away_team: { name: 'A' } },
      onConflict: 'external_id', returning: 'id', single: true
    })
    assert.equal(r.status, 200, r.text)
    const matchId = r.json.data.id
    const otherMatch = await dbCall(other, 'matches', 'upsert', {
      data: { external_id: `${ext}_o`, game_n: 9404, game_pin: '384615', status: 'final', sport_type: 'indoor' },
      onConflict: 'external_id', returning: 'id', single: true
    })
    // the leaver edits the other account's match (game-PIN take-over)
    const claim = await api(srv.base, '/api/match/claim', { token: scorer.token, body: { externalId: `${ext}_o`, pin: '384615' } })
    assert.equal(claim.status, 200, claim.text)
    assert.equal((await dbCall(scorer, 'user_matches', 'insert', { data: { match_external_id: ext, role: 'scorer' } })).status, 200)
    // files: two backups + a log under backup/<id>/, a scoresheet, and the other account's backup
    assert.equal((await upload(scorer, 'backup', 'backups/backup_g9403/b1.json', '{"roster":"x"}')).status, 200)
    assert.equal((await upload(scorer, 'backup', 'backups/backup_g9403/b2.json', '{"roster":"y"}')).status, 200)
    assert.equal((await upload(scorer, 'backup', 'logs/log_g9403.json', '{"log":1}')).status, 200)
    assert.equal((await upload(other, 'backup', 'backups/backup_g9404/b1.json', '{"keep":1}')).status, 200)
    const sheet = `2026-10-06/game9403_k${'b'.repeat(32)}_final.json`
    assert.equal((await upload(scorer, 'scoresheets', sheet, '{"sheet":1}')).status, 200)
    assert.equal(existsSync(join(storageRoot, 'backup', scorer.id)), true)

    const del = await api(srv.base, '/api/auth/delete-account', { body: { access_token: scorer.token } })
    assert.equal(del.status, 200, del.text)

    const count = async (q, p) => (await sql.query(q, p)).rows[0].n
    assert.equal(await count('SELECT count(*)::int AS n FROM auth.users WHERE id = $1', [scorer.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.profiles WHERE user_id = $1', [scorer.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.user_matches WHERE user_id = $1', [scorer.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.match_editors WHERE user_id = $1', [scorer.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM auth.app_sessions WHERE user_id = $1', [scorer.id]), 0)
    // matches are club records: kept, without an owner
    const { rows: [m] } = await sql.query('SELECT created_by, status FROM public.matches WHERE id = $1', [matchId])
    assert.deepEqual(m, { created_by: null, status: 'final' })
    const { rows: [o] } = await sql.query('SELECT created_by FROM public.matches WHERE id = $1', [otherMatch.json.data.id])
    assert.equal(o.created_by, other.id)
    // files: the account's backups and logs are gone, the other account's stay
    assert.equal(existsSync(join(storageRoot, 'backup', scorer.id)), false)
    assert.equal(existsSync(join(storageRoot, 'backup', other.id, 'backups/backup_g9404/b1.json')), true)
    // the scoresheet stays as the match record, but without the deleted owner
    assert.equal(existsSync(join(storageRoot, 'scoresheets', sheet)), true)
    assert.equal(existsSync(sidecar('scoresheets', sheet)), false)
    // the old session is dead
    assert.equal((await api(srv.base, '/api/auth/get-user', { body: { access_token: scorer.token } })).status, 401)
    assert.match(srv.output.join(''), /delete-account files/)
  })

  it('/api/server/connections: anonymous callers get counts; the detail of a match needs its PIN', async () => {
    const ext = `match_${Date.now()}_conn`
    const scoreboard = await openSocket(srv.wsUrl)
    const referee = await openSocket(srv.wsUrl)
    const bench = await openSocket(srv.wsUrl)
    try {
      scoreboard.send({
        type: 'sync-match-data',
        matchId: 5,
        match: { id: 5, seed_key: ext, status: 'live', gamePin: GAME_PIN, refereePin: PINS.referee, homeTeamPin: PINS.bench_home, refereeConnectionEnabled: true, homeTeamConnectionEnabled: true },
        homeTeam: { name: 'H' },
        awayTeam: { name: 'A' },
        sets: [],
        events: []
      })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')
      referee.send({ type: 'subscribe-match', matchId: ext, pin: PINS.referee, device: 'referee' })
      await referee.waitFor((m) => m.type === 'match-full-data')
      bench.send({ type: 'subscribe-match', matchId: ext, pin: PINS.bench_home, device: 'bench', team: 'home' })
      await bench.waitFor((m) => m.type === 'match-full-data')

      const get = (q = '', headers = {}) => api(srv.base, `/api/server/connections${q}`, { method: 'GET', proto: null, headers })
      const all = await get()
      assert.equal(all.status, 200)
      assert.equal(all.json.access, 'counts')
      assert.deepEqual(all.json.clients, [])
      assert.equal(all.json.matchSubscriptions, undefined, 'no list of live rooms')
      assert.ok(all.json.dashboardClients >= 2)

      const anon = await get(`?matchId=${encodeURIComponent(ext)}`)
      assert.equal(anon.json.access, 'counts')
      assert.equal(anon.json.referees, 1)
      assert.equal(anon.json.benches, 1)
      assert.deepEqual(anon.json.clients.map((c) => Object.keys(c).sort()), [['matchId', 'role', 'team'], ['matchId', 'role', 'team']])
      assert.deepEqual(anon.json.clients.map((c) => c.role).sort(), ['bench', 'referee'])

      const wrong = await get(`?matchId=${encodeURIComponent(ext)}`, { 'X-OV-Match-Pin': '000000', 'cf-connecting-ip': nextIp() })
      assert.equal(wrong.json.access, 'counts')
      const withPin = await get(`?matchId=${encodeURIComponent(ext)}`, { 'X-OV-Match-Pin': GAME_PIN })
      assert.equal(withPin.json.access, 'detail')
      assert.equal(withPin.json.clients.length, 2)
      for (const c of withPin.json.clients) {
        assert.equal(typeof c.id, 'string')
        assert.equal(c.ip, null)
        assert.equal(c.matchId, ext)
      }
      const pinCheck = await api(srv.base, '/api/match/validate-pin', { proto: null, body: { pin: PINS.referee, type: 'referee' } })
      assert.equal(typeof pinCheck.json?.token, 'string', pinCheck.text)
      const withToken = await get(`?matchId=${encodeURIComponent(ext)}`, { 'X-OV-Match-Token': pinCheck.json.token })
      assert.equal(withToken.json.access, 'detail')
      // a PIN of another match proves nothing here
      const otherMatch = await get('?matchId=match_unknown', { 'X-OV-Match-Pin': GAME_PIN })
      assert.equal(otherMatch.json.access, 'counts')
      assert.deepEqual(otherMatch.json.clients, [])
    } finally {
      for (const c of [scoreboard, referee, bench]) c.ws.close()
    }
  })

  it('never wrote a sidecar for a missing object (remove, delete-account)', () => {
    const dir = join(storageRoot, '.owners', 'scoresheets')
    const names = existsSync(dir) ? readdirSync(dir) : []
    for (const n of names) assert.match(n, /^[0-9a-f]{64}\.json$/)
    assert.equal(names.length, 0, 'every scoresheet sidecar was removed with its object or its last owner')
  })
})
