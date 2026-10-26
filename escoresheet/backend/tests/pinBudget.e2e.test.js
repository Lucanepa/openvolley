/**
 * The PIN failure budget at a venue, end to end: server.js against a real
 * Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1; see tests/server.e2e.test.js)
 * behind TRUST_PROXY=cloudflare, where cf-connecting-ip is the client's
 * address. Every tablet of a hall reaches the backend from one NAT address.
 *
 *   1. one tablet's typos (each typed PIN checked twice by the apps: the
 *      backend, then the relay) lock neither the other devices of the hall
 *      nor the other PIN types: the bench with its PIN, a reloading referee
 *      re-checking its stored PIN for its match, a fresh referee, and the
 *      scoreboard re-proving its own match on the relay; 20 typos lock only
 *      the referee PIN search of the hall
 *   2. wrong roster-upload PINs do not lock the referee connect
 *   3. brute force still stops: 20 wrong PINs in one scope lock that scope
 *      (the right PIN too, Retry-After 600), 60 across scopes lock the
 *      address; another address is not affected
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '582046'
const PINS = { referee: '316490', bench_home: '470215', bench_away: '608371', upload_home: '729104', upload_away: '853062' }

describe('PIN failure budget: a hall behind one address', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  let wrongSeq = 100000
  // a wrong PIN no match uses (the fixed PINs above are not in this range)
  const nextWrong = () => String(wrongSeq++)

  const connectionPin = (ip, pin, type, extra = {}) => api(srv.base, '/api/match/validate-connection-pin', {
    proto: null, headers: { 'cf-connecting-ip': ip }, body: { pin, type, ...extra }
  })
  const relayPin = (ip, pin, type) => api(srv.base, '/api/match/validate-pin', {
    proto: null, headers: { 'cf-connecting-ip': ip }, body: { pin, type }
  })
  /** A PIN typed on a referee/bench tablet: the backend's check, then the relay's (RefereeApp validateRefereePin). */
  async function typed(ip, pin, type, relayType) {
    const cloud = await connectionPin(ip, pin, type)
    if (cloud.status === 200) return cloud.status
    await relayPin(ip, pin, relayType)
    return cloud.status
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-pinb-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-pinb-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    const email = `pinb-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const headers = { 'cf-connecting-ip': '192.0.2.200' }
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password, metadata: { first_name: 'Scorer' } } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    await grantRoles(sql, inn.json.data.user.id, ['scorer'])
    const up = await api(srv.base, '/api/db', {
      token: inn.json.data.session.access_token,
      headers,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext,
            game_n: 9411,
            game_pin: GAME_PIN,
            connection_pins: PINS,
            connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
            status: 'live',
            sport_type: 'indoor',
            home_team: { name: 'Home VC' },
            away_team: { name: 'Away VC' },
            scheduled_at: new Date().toISOString()
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(up.status, 200, up.text)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('one tablet\'s typos lock neither the other devices of the hall nor its scoreboard', async () => {
    const hall = '198.51.100.40'
    // tablet B mistypes the referee PIN 12 times (it used to lock the hall at 10-11)
    for (let i = 0; i < 12; i++) assert.equal(await typed(hall, nextWrong(), 'referee', 'referee'), 404)
    // the bench types its right PIN
    const bench = await typed(hall, PINS.bench_home, 'bench_home', 'homeTeam')
    assert.equal(bench, 200, 'the bench with its right PIN')
    // referee A reloads: its stored PIN, re-checked for its stored match
    const reload = await connectionPin(hall, PINS.referee, 'referee', { matchExternalId: ext })
    assert.equal(reload.status, 200, reload.text)
    // a fresh referee types the right PIN: 12 typos counted once each (not 24)
    const fresh = await connectionPin(hall, PINS.referee, 'referee')
    assert.equal(fresh.status, 200, fresh.text)
    // A scoreboard claim of this match is checked against its database row
    // (from elsewhere: a wrong game PIN is refused)
    const squatter = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': '192.0.2.99' } })
    try {
      squatter.send({ type: 'sync-match-data', matchId: 7, match: { id: 7, seed_key: ext, gamePin: '999999', status: 'live' }, sets: [], events: [] })
      assert.equal((await squatter.waitFor((m) => m.type === 'error')).code, 'not-match-owner')
    } finally {
      squatter.ws.close()
    }
    // B goes on to 20 typos: the referee PIN search of the hall is locked now
    // (for the right PIN too: no guessing oracle) ...
    for (let i = 0; i < 8; i++) { const r = await relayPin(hall, nextWrong(), 'referee'); assert.equal(r.status, 404, i + ' ' + r.text) }
    assert.equal((await connectionPin(hall, PINS.referee, 'referee')).status, 429)
    // ... and still nothing else: the reloading referee of its match, the
    // bench, and the scoreboard's socket that reconnects and re-proves its own
    // match (game PIN)
    assert.equal((await connectionPin(hall, PINS.referee, 'referee', { matchExternalId: ext })).status, 200)
    assert.equal(await typed(hall, PINS.bench_home, 'bench_home', 'homeTeam'), 200)
    const scorer = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': hall } })
    try {
      scorer.send({ type: 'sync-match-data', matchId: 7, match: { id: 7, seed_key: ext, gamePin: GAME_PIN, status: 'live' }, sets: [], events: [] })
      scorer.send({ type: 'ping' })
      await scorer.waitFor((m) => m.type === 'pong')
      assert.deepEqual(scorer.messages.filter((m) => m.type === 'error'), [])
    } finally {
      scorer.ws.close()
    }
  })

  it('wrong roster-upload PINs do not lock the referee connect', async () => {
    const hall = '198.51.100.41'
    assert.equal((await connectionPin(hall, PINS.referee, 'referee')).status, 200)
    for (let i = 0; i < 20; i++) {
      const r = await api(srv.base, '/api/match/upload-roster', {
        proto: null,
        headers: { 'cf-connecting-ip': hall },
        body: { matchExternalId: ext, team: 'home', pin: nextWrong(), roster: { players: [] } }
      })
      assert.equal(r.status, 403, r.text)
    }
    const referee = await connectionPin(hall, PINS.referee, 'referee')
    assert.equal(referee.status, 200, referee.text)
    // the upload of that team is what the 20 wrong PINs locked
    const upload = await api(srv.base, '/api/match/upload-roster', {
      proto: null,
      headers: { 'cf-connecting-ip': hall },
      body: { matchExternalId: ext, team: 'home', pin: PINS.upload_home, roster: { players: [] } }
    })
    assert.equal(upload.status, 429)
  })

  it('brute force still stops: one scope after 20 wrong PINs, the address after 60', async () => {
    const guesser = '203.0.113.50'
    // 20 different wrong referee PINs, on both checks of that PIN type
    for (let i = 0; i < 10; i++) {
      assert.equal((await connectionPin(guesser, nextWrong(), 'referee')).status, 404)
      assert.equal((await relayPin(guesser, nextWrong(), 'referee')).status, 404)
    }
    const right = await connectionPin(guesser, PINS.referee, 'referee')
    assert.equal(right.status, 429, 'over the limit the right PIN is not compared either')
    assert.equal(right.headers.get('retry-after'), '600')
    // another PIN type is another scope
    assert.equal((await connectionPin(guesser, PINS.bench_away, 'bench_away')).status, 200)
    // 40 more wrong PINs across the other types: 60, the ceiling of the address
    for (const type of ['bench_home', 'upload_home', 'upload_away']) {
      for (let i = 0; i < (type === 'upload_away' ? 14 : 13); i++) {
        assert.equal((await connectionPin(guesser, nextWrong(), type)).status, 404, type)
      }
    }
    const locked = await connectionPin(guesser, PINS.bench_away, 'bench_away')
    assert.equal(locked.status, 429)
    assert.equal(locked.headers.get('retry-after'), '600')
    // another address is not affected
    assert.equal((await connectionPin('203.0.113.51', PINS.bench_away, 'bench_away')).status, 200)
  })

  // 2026-10-26: once a hall had spent the address's ceiling on other PINs,
  // the scoreboard re-proving its own match on the relay (a reconnect) was
  // refused for 10 minutes, and its referee and benches froze
  it('the match\'s own scorer device re-proves its match after the hall spent the ceiling; another device does not', async () => {
    const hall = '203.0.113.60'
    const SCORER = '5c0e5c0e-0000-4000-8000-00000000000a'
    const OTHER = '5c0e5c0e-0000-4000-8000-00000000000b'
    await sql.query(
      `INSERT INTO public.match_scorer_devices (match_id, device_id, platform)
       SELECT id, $1, 'web' FROM public.matches WHERE external_id = $2
       ON CONFLICT (match_id) DO UPDATE SET device_id = EXCLUDED.device_id`, [SCORER, ext])
    for (const type of ['referee', 'bench_home', 'upload_home']) {
      for (let i = 0; i < 20; i++) assert.equal((await connectionPin(hall, nextWrong(), type)).status, 404, type)
    }
    assert.equal((await connectionPin(hall, PINS.bench_away, 'bench_away')).status, 429, 'the address is spent')
    const claim = async (device, gamePin) => {
      const sock = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': hall } })
      try {
        sock.send({ type: 'sync-match-data', matchId: 7, match: { id: 7, seed_key: ext, gamePin, status: 'live' }, sets: [], events: [], device: { id: device, platform: 'web' } })
        sock.send({ type: 'ping' })
        await sock.waitFor((m) => m.type === 'pong')
        return sock.messages.filter((m) => m.type === 'error').map((m) => m.code)
      } finally {
        sock.ws.close()
      }
    }
    // another device with the right PIN: the ceiling holds
    assert.deepEqual(await claim(OTHER, GAME_PIN), ['rate-limited'])
    // the scorer's device: its own match's scope only
    assert.deepEqual(await claim(SCORER, GAME_PIN), [])
    assert.deepEqual(await claim(SCORER, '000111'), ['not-match-owner'])
    assert.deepEqual(await claim(SCORER, GAME_PIN), [])
  })
})
