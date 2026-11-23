/**
 * SEC-06 (audit 2026-11, owner decision 1): the lookups that name no match
 * (validate-connection-pin without matchExternalId, the relay's validate-pin
 * without matchId) follow the same rule as the match locks: only the
 * guessing address ranges are refused, the right PIN from anywhere else
 * passes, and every caller together raises one ops alert. End to end with
 * the production numbers (no OV_PIN_* override) and the production grants
 * (ov_app), behind TRUST_PROXY=cloudflare (cf-connecting-ip is the client).
 *
 * The audit's PoC (poc/sec-06/search-lock-verify.mjs, poc/beach/search-lock.mjs,
 * poc/beach/pin-search-lockout.sh): 100 wrong PIN-only beach referee guesses
 * from 5 addresses refused every OpenBeach referee tablet (OpenBeach names no
 * match in its PIN checks) for 10 minutes, the right PIN included, on both
 * checks. Now:
 *
 *   1. 105 wrong guesses from five IPv6 /64s (of five /48s): each /64 is
 *      refused past its share, the right PIN from anywhere else passes on
 *      both checks (and still names its match: the PIN-only lookup stays
 *      until the OpenBeach build that names its match is out), the guessing
 *      /64s stay refused; one alert; '[PIN] lookup without a match' lines,
 *      capped
 *   2. 100 wrong guesses from five addresses of one IPv4 /24: past the share
 *      of the /24 (40) every address of it is refused, the right PIN from
 *      another /24 passes; a lookup that names its match, and indoor, are
 *      apart
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const tag = randomBytes(3).toString('hex')
const BEACH = { ext: `pss_b_${tag}`, n: 7, gamePin: '156158', pins: { referee: '568231', bench_team1: '679342', bench_team2: '780453' } }
const INDOOR = { ext: `pss_i_${tag}`, n: 9801, gamePin: '246802', pins: { referee: '864813', bench_home: '975924', bench_away: '186035' } }
const ALL_PINS = [BEACH.gamePin, INDOOR.gamePin, ...Object.values(BEACH.pins), ...Object.values(INDOOR.pins)]

describe('SEC-06: the PIN-only lookup lock refuses the guessing ranges only', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let board
  let wrongSeq = 200000
  const nextWrong = () => {
    let p
    do p = String(wrongSeq++)
    while (ALL_PINS.includes(p))
    return p
  }
  const as = (ip) => ({ 'cf-connecting-ip': ip, origin: 'https://beach-referee.openvolley.app' })
  // as OpenBeach sends them: no match named
  const obCheck = (ip, pin, extra = {}) => api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: as(ip), body: { pin, type: 'referee', sport: 'beach', ...extra } })
  const obRelay = (ip, pin) => api(srv.base, '/api/match/validate-pin', { proto: null, headers: as(ip), body: { pin, type: 'referee', sport: 'beach' } })
  const pinLines = () => srv.output.join('').split('\n').filter((l) => l.startsWith('[PIN] '))
  const alertEvents = async () => (await sql.query("SELECT message, data FROM public.error_events WHERE source = 'server' AND view = 'pin budget search' ORDER BY id")).rows

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-pss-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-pss-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      OV_PIN_SECRET: randomBytes(32).toString('base64url'),
      ERROR_ALERTS: 'off'
    })
    const email = `pss-${tag}@example.ch`
    const password = 'correct-horse-battery'
    const headers = { 'cf-connecting-ip': '192.0.2.200' }
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password, metadata: { first_name: 'Scorer' } } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    await grantRoles(sql, inn.json.data.user.id, ['scorer', 'beach:scorer'])
    const token = inn.json.data.session.access_token
    for (const [m, beach] of [[BEACH, true], [INDOOR, false]]) {
      const up = await api(srv.base, '/api/db', {
        token,
        headers,
        body: {
          table: 'matches',
          action: 'upsert',
          params: {
            data: {
              external_id: m.ext,
              game_n: m.n,
              game_pin: m.gamePin,
              connection_pins: m.pins,
              connections: beach
                ? { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: true }
                : { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
              status: 'live',
              sport_type: beach ? 'beach' : 'indoor',
              ...(beach ? { team1_data: { name: 'Pair One' }, team2_data: { name: 'Pair Two' } } : { home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' } }),
              scheduled_at: new Date().toISOString()
            },
            onConflict: 'external_id',
            returning: 'id',
            single: true
          }
        }
      })
      assert.equal(up.status, 200, up.text)
    }
    // the beach scorer's tablet holds its match on the relay
    board = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': '192.0.2.10' } })
    board.send({
      type: 'sync-match-data',
      matchId: BEACH.ext,
      match: { seed_key: BEACH.ext, sport_type: 'beach', gamePin: BEACH.gamePin, refereePin: BEACH.pins.referee, refereeConnectionEnabled: true, status: 'live', gameNumber: BEACH.n },
      sets: [],
      events: []
    })
    board.send({ type: 'ping' })
    await board.waitFor((m) => m.type === 'pong')
    assert.deepEqual(board.messages.filter((m) => m.type === 'error'), [])
  })

  after(async () => {
    board?.ws.close()
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the PoC: 105 wrong guesses from five /64s refuse those /64s only; the right PIN from elsewhere passes on both checks; one alert', async () => {
    const before = await obCheck('203.0.113.200', BEACH.pins.referee)
    assert.equal(before.status, 200, before.text)
    // the lookup without a match still names the match (kept until the OpenBeach build that names its match)
    assert.equal(before.json.match.id, BEACH.ext)
    const counts = {}
    for (let a = 0; a < 5; a++) {
      for (let i = 0; i < 21; i++) {
        const r = await obCheck(`2001:db8:${(a + 10).toString(16)}::1`, nextWrong())
        counts[r.status] = (counts[r.status] || 0) + 1
      }
    }
    assert.deepEqual(counts, { 404: 100, 429: 5 })
    // the right PIN, PIN-only as OpenBeach sends it, from fresh addresses: both checks
    const http = await obCheck('198.18.9.1', BEACH.pins.referee)
    assert.equal(http.status, 200, http.text)
    assert.equal(http.json.match.id, BEACH.ext)
    assert.ok(http.json.token)
    const relay = await obRelay('198.18.9.2', BEACH.pins.referee)
    assert.equal(relay.status, 200, relay.text)
    assert.equal(relay.json.match.id, BEACH.ext)
    assert.equal((await obCheck('2001:db8:99::1', BEACH.pins.referee)).status, 200)
    // the guessing /64s stay refused, the right PIN too, on both checks
    assert.equal((await obCheck('2001:db8:a::2', BEACH.pins.referee)).status, 429)
    assert.equal((await obRelay('2001:db8:b::2', BEACH.pins.referee)).status, 429)
    // every caller together past 100: one ops alert, never a PIN in it
    await waitUntil(async () => (await alertEvents()).length > 0, { timeoutMs: 5000, what: 'the search alert' })
    const events = await alertEvents()
    assert.equal(events.length, 1)
    assert.match(events[0].message, /^PIN guessing: 100 wrong beach:referee PINs in lookups without a match from all callers within 10 min/)
    assert.equal(events[0].data.count, 100)
    assert.equal(events[0].data.ranges.length, 5)
    for (const pin of ALL_PINS) assert.equal(JSON.stringify(events[0]).includes(pin), false, 'never a PIN')
    // the operator sees the lookups without a match, at most 60 lines per PIN type and window
    const lookups = pinLines().filter((l) => l.startsWith('[PIN] lookup without a match: beach:referee'))
    assert.ok(lookups.some((l) => l.includes('on validate-connection-pin: wrong')))
    assert.ok(lookups.some((l) => l.includes('on validate-connection-pin: found')))
    assert.equal(lookups.length, 61, lookups.slice(-3).join('\n'))
    assert.match(lookups[60], /more than 60 in 10 min, the rest of this window is not logged/)
    for (const l of lookups) for (const pin of ALL_PINS) assert.equal(l.includes(pin), false)
  })

  it('100 wrong guesses from one IPv4 /24 lock that /24 past its share; another /24, a named lookup and indoor go on', async () => {
    const counts = {}
    for (let a = 0; a < 5; a++) {
      for (let i = 0; i < 20; i++) {
        const r = await obCheck(`203.0.113.${50 + a}`, nextWrong())
        counts[r.status] = (counts[r.status] || 0) + 1
      }
    }
    // 20 from each of two addresses reach the share of the /24 (40): the rest is refused
    assert.deepEqual(counts, { 404: 40, 429: 60 })
    await waitUntil(() => pinLines().some((l) => l.startsWith('[PIN] 40 wrong beach:referee PINs in lookups without a match from 203.0.113.0/24')), { timeoutMs: 3000, what: 'the /24 lock line' })
    // a fresh address of that /24: refused, the right PIN too, on both checks
    assert.equal((await obCheck('203.0.113.99', BEACH.pins.referee)).status, 429)
    assert.equal((await obRelay('203.0.113.98', BEACH.pins.referee)).status, 429)
    // another /24: the right PIN passes
    assert.equal((await obCheck('198.18.7.7', BEACH.pins.referee)).status, 200)
    assert.equal((await obRelay('198.18.7.8', BEACH.pins.referee)).status, 200)
    // the lookup that names its match is apart, from the locked /24 too
    const named = await obCheck('203.0.113.97', BEACH.pins.referee, { matchExternalId: BEACH.ext })
    assert.equal(named.status, 200, named.text)
    // indoor is another lookup: PIN-only and named, from the locked /24 too
    const indoor = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '203.0.113.96' }, body: { pin: INDOOR.pins.referee, type: 'referee' } })
    assert.equal(indoor.status, 200, indoor.text)
    assert.equal(indoor.json.match.id, INDOOR.ext)
    // still one alert in the window
    assert.equal((await alertEvents()).length, 1)
  })
})
