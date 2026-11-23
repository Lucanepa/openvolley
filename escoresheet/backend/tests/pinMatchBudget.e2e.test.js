/**
 * Wrong PINs counted per match and PIN type across address buckets, end to
 * end: server.js against a real Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1;
 * see tests/server.e2e.test.js) behind TRUST_PROXY=cloudflare, where
 * cf-connecting-ip is the client's address. Owner decision 1 (audit 2026-11,
 * SEC-05 / SEC-06): only the guessing address range is refused, the right PIN
 * from anywhere else passes, and every caller together raises an ops alert.
 * This file pinned the old rule (3 wrong PINs here from any addresses refused
 * the right PIN to everyone) and now checks the new one. The shares are tiny
 * (OV_PIN_RANGE_FAILURES=2: 2 for an address, 3 for an IPv6 /56, 4 for a /48
 * or an IPv4 /24; alerts at OV_PIN_MATCH_FAILURES=3 / OV_PIN_SEARCH_FAILURES=3),
 * and the guesses of each test come from fresh /64s of one /56 of their own
 * (guesser()), far below the per-address budget of tests/pinBudget.e2e.test.js.
 *
 *   1. wrong restore-by-pin PINs lock restore-by-pin of that game number for
 *      the guessing range (the right PIN too; one [PIN] line), not the
 *      match's own game PIN; wrong claims lock that (one line); another range
 *      gets in, and so does the match's creator; the match's other PIN types,
 *      another match and a match token issued before keep working; one alert
 *   2. one counter per match and PIN type for every path: wrong PINs on the
 *      relay (GET /api/match/:id) lock the referee PIN of
 *      validate-connection-pin for that range; its PIN-only search does not
 *      prove the locked match, another range's does; the match's own scorer
 *      device still re-proves its match from the range, another device does
 *      not; a new PIN synced to the relay lifts that PIN's lock
 *   3. the scorer writing a new PIN lifts that PIN's lock; a write of the
 *      same PIN lifts nothing
 *   4. lookups that name no match are counted per range of their own; the
 *      guessing range is refused, every other range not, and no lookup that
 *      names its match; one alert; '[PIN] lookup without a match' lines; the
 *      relay's validate-pin takes its three PIN types only
 *   5. upload PIN lookups must name their match; a named match that does not
 *      exist counts nothing
 *   6. a scoreboard claim on the relay is counted under the database match
 *      whose game PIN it compares, whatever room key (seed_key) it names
 *   7. a room re-pointed at a match it never proved: its live state is one
 *      counted comparison, refused under a lock of its range; the scorer's
 *      own room is bound to its match and keeps publishing
 *   8. a match only the relay holds: the room's own scoring device reconnects
 *      under a lock of its game PIN, another device (or none) does not
 * And the venue relay (--local, no database): the scoring device reconnects
 * under a lock of its game PIN.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, subscribe, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const tag = randomBytes(3).toString('hex')
// Three wrong PINs (no match below uses them)
const WRONG = ['101010', '202020', '303030']
const mk = (name, n, d) => ({
  ext: `pmb_${name}_${tag}`,
  n,
  gamePin: `${d}1${d}2${d}3`,
  pins: { referee: `${d}4${d}5${d}6`, bench_home: `${d}7${d}8${d}9`, bench_away: `${d}0${d}9${d}8`, upload_home: `${d}7${d}6${d}5`, upload_away: `${d}4${d}3${d}2` }
})
const A = mk('a', 9601, 2)
const B = mk('b', 9602, 3)
const C = mk('c', 9603, 4)
const D = mk('d', 9604, 5)
const E = mk('e', 9605, 6)
const F = mk('f', 9606, 7)
const G = mk('g', 9607, 8)
const SCORER_DEVICE = '5c0e5c0e-0000-4000-8000-0000000000f1'
const OTHER_DEVICE = '5c0e5c0e-0000-4000-8000-0000000000f2'

/** One sync-match-data on a socket of its own; the error codes it got. */
async function syncOnce(wsUrl, ip, match, { device = null, roomId = 'x1' } = {}) {
  const sock = await openSocket(wsUrl, { headers: { 'cf-connecting-ip': ip } })
  try {
    sock.send({ type: 'sync-match-data', matchId: roomId, match: { id: roomId, status: 'live', ...match }, sets: [], events: [], ...(device ? { device } : {}) })
    sock.send({ type: 'ping' })
    await sock.waitFor((m) => m.type === 'pong')
    return sock.messages.filter((m) => m.type === 'error').map((m) => m.code)
  } finally {
    sock.ws.close()
  }
}

/** A referee tablet in the room: it keeps the room (and the relay copy) while the scorer is away. */
async function refereeIn(wsUrl, ip, matchId) {
  const referee = await openSocket(wsUrl, { headers: { 'cf-connecting-ip': ip } })
  referee.send({ type: 'subscribe-match', matchId, role: 'referee' })
  referee.send({ type: 'ping' })
  await referee.waitFor((m) => m.type === 'pong')
  return referee
}

describe('PIN failure budget per match and PIN type, by address range', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let scorer
  // other scorer accounts: not the matches' creator (a creator's or an
  // editor's claim is not refused by a range lock, lib/matchRestore.js
  // trustedFor); a successful claim makes `other` an editor, `stranger` stays none
  let other
  let stranger
  // The guessers: every guesser() a /56 of its own (2001:db8:7a<n>::/48),
  // each call a fresh /64 of it
  let guessers = 0
  const guesser = () => {
    const n = (guessers++).toString(16)
    let i = 0
    return () => `2001:db8:7a${n.padStart(2, '0')}:${(i++).toString(16)}::1`
  }
  // Everybody else: a /48 of its own each time
  let elsewhereSeq = 0
  const elsewhere = () => `2001:db8:e${(elsewhereSeq++).toString(16).padStart(3, '0')}::1`
  const as = (ip) => ({ 'cf-connecting-ip': ip })

  const connectionPin = (ip, body) => api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: as(ip), body })
  const relayPin = (ip, pin, type = 'referee') => api(srv.base, '/api/match/validate-pin', { proto: null, headers: as(ip), body: { pin, type } })
  const restore = (ip, body) => api(srv.base, '/api/match/restore-by-pin', { proto: null, headers: as(ip), body })
  const claim = (ip, body, who = other) => api(srv.base, '/api/match/claim', { token: who.token, proto: null, headers: as(ip), body })
  const matchByPin = (ip, m, pin) => api(srv.base, `/api/match/${encodeURIComponent(m.ext)}`, {
    method: 'GET', proto: null, headers: { ...as(ip), 'X-OV-Match-Pin': pin }
  })
  const anonMatch = (m, headers = {}) => api(srv.base, '/api/db', {
    proto: null, headers, body: { table: 'matches', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: m.ext }], maybeSingle: true } }
  })
  const writePins = (m, connectionPins) => api(srv.base, '/api/db', {
    token: scorer.token,
    headers: as('192.0.2.201'),
    body: { table: 'matches', action: 'update', params: { data: { connection_pins: connectionPins }, filters: [{ type: 'eq', column: 'external_id', value: m.ext }] } }
  })
  const pinLines = () => srv.output.join('').split('\n').filter((l) => l.startsWith('[PIN] '))
  // the lock lines (one per range lock), not the alerts of all callers nor the lookup lines
  const pinLockLines = () => pinLines().filter((l) => !l.includes('from all callers') && / refused for \d+ min/.test(l))
  const alertLines = () => pinLines().filter((l) => l.includes('from all callers'))
  const alertEvents = async () => (await sql.query("SELECT message, view, data FROM public.error_events WHERE source = 'server' AND view LIKE 'pin budget%' ORDER BY id")).rows

  /** A scoreboard socket syncing `m` to the relay (game PIN, referee connection on); the claim's error codes. */
  async function scoreboard(ip, m, { device = null, keep = false } = {}) {
    const sock = await openSocket(srv.wsUrl, { headers: as(ip) })
    sock.send({
      type: 'sync-match-data',
      matchId: 7,
      match: { id: 7, seed_key: m.ext, gamePin: m.gamePin, refereePin: m.pins.referee, refereeConnectionEnabled: true, status: 'live' },
      sets: [],
      events: [],
      ...(device ? { device: { id: device, platform: 'web' } } : {})
    })
    sock.send({ type: 'ping' })
    await sock.waitFor((msg) => msg.type === 'pong')
    const errors = sock.messages.filter((msg) => msg.type === 'error').map((msg) => msg.code)
    if (!keep) sock.ws.close()
    return keep ? { sock, errors } : errors
  }

  async function account(prefix, ip) {
    const email = `${prefix}-${tag}@example.ch`
    const password = 'correct-horse-battery'
    const headers = as(ip)
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password, metadata: { first_name: 'Scorer' } } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const who = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, who.id, ['scorer'])
    return who
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-pmb-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-pmb-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      OV_PIN_SECRET: randomBytes(32).toString('base64url'),
      OV_PIN_RANGE_FAILURES: '2',
      OV_PIN_MATCH_FAILURES: '3',
      OV_PIN_SEARCH_FAILURES: '3',
      ERROR_ALERTS: 'off'
    })
    scorer = await account('pmb', '192.0.2.200')
    other = await account('pmb-other', '192.0.2.202')
    stranger = await account('pmb-stranger', '192.0.2.203')
    const headers = as('192.0.2.200')
    for (const m of [A, B, C, D, E, F, G]) {
      const up = await api(srv.base, '/api/db', {
        token: scorer.token,
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
              connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
              status: m === E ? 'setup' : 'live',
              sport_type: 'indoor',
              home_team: { name: `Home ${m.n}` },
              away_team: { name: `Away ${m.n}` },
              players_home: [{ number: 7, first_name: 'Mia', last_name: `Example${m.n}` }],
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
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('wrong game PINs from one range lock restore-by-pin of the game number for that range, wrong claims the match\'s game PIN; other ranges and the creator get in', async () => {
    // a referee connected before: its match token
    const ref = await connectionPin(elsewhere(), { pin: A.pins.referee, type: 'referee', matchExternalId: A.ext })
    assert.equal(ref.status, 200, ref.text)
    assert.ok(ref.json.token)
    // three wrong game PINs from three /64s of one /56 (each far below its own limits)
    const g = guesser()
    for (const pin of WRONG) assert.equal((await restore(g(), { gameN: A.n, pin })).status, 404, pin)
    // the right game PIN from yet another /64 of that range is not compared any more
    const right = await restore(g(), { gameN: A.n, pin: A.gamePin })
    assert.equal(right.status, 429, right.text)
    assert.equal(right.headers.get('retry-after'), '600')
    await waitUntil(() => pinLockLines().some((l) => l.includes(`game number ${A.n}`)), { timeoutMs: 3000, what: 'the [PIN] game number line' })
    // from anywhere else the right game PIN restores the match
    const fine = await restore(elsewhere(), { gameN: A.n, pin: A.gamePin })
    assert.equal(fine.status, 200, fine.text)
    assert.equal(fine.json.data.match.external_id, A.ext)
    // counted for the game number only: the match's own game PIN still proves it, from the range too
    assert.equal((await claim(g(), { externalId: A.ext, pin: A.gamePin })).status, 200)
    // wrong claims from another guessing range lock the match's game PIN there
    const g2 = guesser()
    for (const pin of WRONG) assert.equal((await claim(g2(), { externalId: A.ext, pin }, stranger)).status, 404, pin)
    assert.equal((await claim(g2(), { externalId: A.ext, pin: A.gamePin }, stranger)).status, 429)
    // ... not for the match's creator or an editor (signed in, trusted beyond the PIN), nor anywhere else
    assert.equal((await claim(g2(), { externalId: A.ext, pin: A.gamePin }, scorer)).status, 200)
    assert.equal((await claim(g2(), { externalId: A.ext, pin: A.gamePin }, other)).status, 200)
    assert.equal((await claim(elsewhere(), { externalId: A.ext, pin: A.gamePin }, stranger)).status, 200)
    // the operator gets one line for each lock
    await waitUntil(() => pinLockLines().some((l) => l.includes(A.ext)), { timeoutMs: 3000, what: 'the [PIN] lock line' })
    assert.equal(pinLockLines().filter((l) => l.includes(A.ext)).length, 1)
    assert.equal(pinLockLines().filter((l) => l.includes(`game number ${A.n}`)).length, 1)
    // every caller together past 3: one ops alert each (the game number, the match's game PIN), none refused for it
    await waitUntil(async () => (await alertEvents()).length >= 2, { timeoutMs: 5000, what: 'the alerts in the error tracker' })
    const events = await alertEvents()
    assert.equal(events.filter((e) => e.view === 'pin budget game').length, 1)
    assert.equal(events.filter((e) => e.view === 'pin budget match').length, 1)
    assert.match(events.find((e) => e.view === 'pin budget game').message, /^PIN guessing: game number 9601: 3 wrong game PINs in restore-by-pin from all callers/)
    assert.equal(events.find((e) => e.view === 'pin budget game').data.count, 3)
    for (const e of events) for (const pin of [...WRONG, A.gamePin]) assert.equal(JSON.stringify(e).includes(pin), false, 'never a PIN')
    // the match's other PIN types go on
    const bench = await connectionPin(g2(), { pin: A.pins.bench_home, type: 'bench_home', matchExternalId: A.ext })
    assert.equal(bench.status, 200, bench.text)
    // the token issued before still reads the roster of its match
    const read = await anonMatch(A, { 'X-OV-Match-Token': ref.json.token })
    assert.equal(read.status, 200, read.text)
    assert.ok(Array.isArray(read.json.data.players_home), read.text)
    // another match: untouched, from the guessing ranges too
    const otherMatch = await restore(g(), { gameN: B.n, pin: B.gamePin })
    assert.equal(otherMatch.status, 200, otherMatch.text)
    assert.equal(otherMatch.json.data.match.external_id, B.ext)
    assert.equal((await claim(g2(), { externalId: B.ext, pin: B.gamePin }, stranger)).status, 200)
  })

  it('one counter per match and PIN type on every path; the match\'s own scorer device still re-proves it from the guessing range', async () => {
    await sql.query(
      `INSERT INTO public.match_scorer_devices (match_id, device_id, platform)
       SELECT id, $1, 'web' FROM public.matches WHERE external_id = $2
       ON CONFLICT (match_id) DO UPDATE SET device_id = EXCLUDED.device_id`, [SCORER_DEVICE, C.ext])
    const { sock, errors } = await scoreboard('192.0.2.30', C, { device: SCORER_DEVICE, keep: true })
    try {
      assert.deepEqual(errors, [])
      // wrong PINs on the relay, from three /64s of one range: the summary only
      const g = guesser()
      for (const pin of WRONG) {
        const r = await matchByPin(g(), C, pin)
        assert.equal(r.status, 200, r.text)
        assert.equal(r.json.access, 'summary')
      }
      // each was compared with the referee PIN (and the game PIN) of the
      // match: the referee PIN is locked for that range on validate-connection-pin too
      assert.equal((await connectionPin(g(), { pin: C.pins.referee, type: 'referee', matchExternalId: C.ext })).status, 429)
      assert.equal((await matchByPin(g(), C, C.pins.referee)).status, 429)
      // the range's PIN-only searches do not prove the locked match
      assert.equal((await connectionPin(g(), { pin: C.pins.referee, type: 'referee' })).status, 404)
      assert.equal((await relayPin(g(), C.pins.referee)).status, 404)
      // every other range: the right referee PIN, named or not, on every path
      assert.equal((await connectionPin(elsewhere(), { pin: C.pins.referee, type: 'referee', matchExternalId: C.ext })).status, 200)
      assert.equal((await connectionPin(elsewhere(), { pin: C.pins.referee, type: 'referee' })).status, 200)
      assert.equal((await relayPin(elsewhere(), C.pins.referee)).status, 200)
      const full = await matchByPin(elsewhere(), C, C.pins.referee)
      assert.equal(full.status, 200, full.text)
      assert.equal(full.json.access, 'full')
      // the bench PIN was never compared there
      assert.equal((await connectionPin(g(), { pin: C.pins.bench_home, type: 'bench_home', matchExternalId: C.ext })).status, 200)
      // from the guessing range, the scorer device the database names re-proves its match; another device does not
      assert.deepEqual(await scoreboard(g(), C, { device: OTHER_DEVICE }), ['rate-limited'])
      assert.deepEqual(await scoreboard(g(), C, { device: SCORER_DEVICE }), [])
      // the scorer sets a new referee PIN on the relay: that PIN type opens
      // again for the range (the game PIN stays locked)
      const NEW_REFEREE_PIN = '575757'
      sock.send({
        type: 'sync-match-data',
        matchId: 7,
        match: { id: 7, seed_key: C.ext, gamePin: C.gamePin, refereePin: NEW_REFEREE_PIN, refereeConnectionEnabled: true, status: 'live' },
        sets: [],
        events: [],
        device: { id: SCORER_DEVICE, platform: 'web' }
      })
      sock.send({ type: 'ping' })
      await sock.waitFor(() => sock.messages.filter((msg) => msg.type === 'pong').length >= 2)
      assert.deepEqual(sock.messages.filter((msg) => msg.type === 'error'), [])
      const reopened = await matchByPin(g(), C, NEW_REFEREE_PIN)
      assert.equal(reopened.status, 200, reopened.text)
      assert.equal(reopened.json.access, 'full')
      assert.deepEqual(await scoreboard(g(), C, { device: OTHER_DEVICE }), ['rate-limited'])
    } finally {
      sock.ws.close()
    }
  })

  it('the scorer setting a new PIN lifts that PIN\'s lock; a write of the same PIN lifts nothing', async () => {
    const g = guesser()
    for (const type of ['referee', 'bench_home']) {
      for (const pin of WRONG) assert.equal((await connectionPin(g(), { pin, type, matchExternalId: D.ext })).status, 404, type)
      assert.equal((await connectionPin(g(), { pin: D.pins[type], type, matchExternalId: D.ext })).status, 429, type)
      assert.equal((await connectionPin(elsewhere(), { pin: D.pins[type], type, matchExternalId: D.ext })).status, 200, `${type} elsewhere`)
    }
    // the scorer's app writes the new referee PIN (the sync queue's full connection_pins)
    const NEW_REFEREE_PIN = '646464'
    const upd = await writePins(D, { ...D.pins, referee: NEW_REFEREE_PIN })
    assert.equal(upd.status, 200, upd.text)
    const ok = await connectionPin(g(), { pin: NEW_REFEREE_PIN, type: 'referee', matchExternalId: D.ext })
    assert.equal(ok.status, 200, ok.text)
    // the bench PIN it wrote unchanged stays locked for the range
    assert.equal((await connectionPin(g(), { pin: D.pins.bench_home, type: 'bench_home', matchExternalId: D.ext })).status, 429)
  })

  it('lookups that name no match are counted per range; the guessing range is refused, every other range and every named lookup not', async () => {
    // wrong away-bench PINs without a match from one range, on both checks
    const g = guesser()
    assert.equal((await connectionPin(g(), { pin: WRONG[0], type: 'bench_away' })).status, 404)
    assert.equal((await relayPin(g(), WRONG[1], 'awayTeam')).status, 404)
    assert.equal((await connectionPin(g(), { pin: WRONG[2], type: 'bench_away' })).status, 404)
    // the right PIN without a match from that range is refused now, on both checks
    const search = await connectionPin(g(), { pin: E.pins.bench_away, type: 'bench_away' })
    assert.equal(search.status, 429, search.text)
    assert.equal(search.headers.get('retry-after'), '600')
    assert.equal((await relayPin(g(), E.pins.bench_away, 'awayTeam')).status, 429)
    await waitUntil(() => pinLockLines().some((l) => l.includes('bench_away') && l.includes('without a match')), { timeoutMs: 3000, what: 'the [PIN] search lock line' })
    // every other range: the right PIN without a match (as OpenBeach and older apps send it)
    const fine = await connectionPin(elsewhere(), { pin: E.pins.bench_away, type: 'bench_away' })
    assert.equal(fine.status, 200, fine.text)
    assert.equal(fine.json.match.id, E.ext)
    // every caller together past 3: one alert for the lookups, nobody refused for it
    await waitUntil(() => alertLines().some((l) => l.includes('indoor:bench_away') && l.includes('without a match')), { timeoutMs: 3000, what: 'the search alert line' })
    await waitUntil(async () => (await alertEvents()).some((e) => e.view === 'pin budget search'), { timeoutMs: 5000, what: 'the search alert event' })
    // the operator sees the lookups that name no match
    assert.ok(pinLines().some((l) => l.startsWith('[PIN] lookup without a match: indoor:bench_away on validate-connection-pin: wrong')))
    assert.ok(pinLines().some((l) => l.startsWith('[PIN] lookup without a match: indoor:bench_away on validate-connection-pin: found')))
    assert.ok(pinLines().some((l) => l.startsWith('[PIN] lookup without a match: indoor:bench_away on validate-pin: wrong')))
    // the bench that names its match gets in from the guessing range too: the match is not locked
    const named = await connectionPin(g(), { pin: E.pins.bench_away, type: 'bench_away', matchExternalId: E.ext })
    assert.equal(named.status, 200, named.text)
    // another PIN type is another lookup
    assert.equal((await connectionPin(g(), { pin: E.pins.bench_home, type: 'bench_home' })).status, 200)
    // the relay's validate-pin knows three PIN types: any other is no lookup
    // (it never matched, and each spelling took a counter of its own)
    for (const type of ['upload_home', 'bench', 'x'.repeat(40), 7]) {
      const r = await relayPin(elsewhere(), WRONG[0], type)
      assert.equal(r.status, 400, `${type}: ${r.text}`)
      assert.equal(r.json.error, 'Invalid PIN type')
    }
  })

  it('upload PIN lookups name their match; a named match that does not exist counts nothing', async () => {
    const search = await connectionPin(elsewhere(), { pin: E.pins.upload_home, type: 'upload_home' })
    assert.equal(search.status, 400, search.text)
    const named = await connectionPin(elsewhere(), { pin: E.pins.upload_home, type: 'upload_home', matchExternalId: E.ext })
    assert.equal(named.status, 200, named.text)
    assert.equal(named.json.match.id, E.ext)
    // no match to guess at: never locked, never a counter of its own
    const nosuch = `pmb_nosuch_${tag}`
    const g = guesser()
    for (const pin of [...WRONG, E.pins.upload_home]) {
      assert.equal((await connectionPin(g(), { pin, type: 'upload_home', matchExternalId: nosuch })).status, 404, pin)
    }
    assert.equal(pinLines().some((l) => l.includes(nosuch)), false)
  })

  it('a relay claim counts for the database match it compares, whatever room key it names', async () => {
    const { rows: [{ id: uuid }] } = await sql.query('SELECT id FROM public.matches WHERE external_id = $1', [F.ext])
    // matches.id is public; each claim names a room key of its own (seed_key)
    // and points the synced match at the row through externalId
    const g = guesser()
    for (const [i, pin] of WRONG.entries()) {
      assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: `pmb_room_${tag}_${i}`, externalId: uuid, gamePin: pin }), ['not-match-owner'], pin)
    }
    // that match's game PIN is locked for the range: for claim, and for the right PIN under yet another room key
    assert.equal((await claim(g(), { externalId: F.ext, pin: F.gamePin })).status, 429)
    assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: `pmb_room_${tag}_ok`, externalId: uuid, gamePin: F.gamePin }), ['rate-limited'])
    // the room keys never got a counter, the match did
    await waitUntil(() => pinLockLines().some((l) => l.includes(F.ext)), { timeoutMs: 3000, what: 'the [PIN] lock line' })
    assert.equal(pinLines().some((l) => l.includes(`pmb_room_${tag}`)), false)
    // another range: the right game PIN proves it
    assert.equal((await claim(elsewhere(), { externalId: F.ext, pin: F.gamePin })).status, 200)
  })

  it('a room re-pointed at a match it never proved is a counted comparison; the scorer\'s own room keeps publishing', async () => {
    const { rows: [{ id: uuid }] } = await sql.query('SELECT id FROM public.matches WHERE external_id = $1', [G.ext])
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    // the scorer's room: its game PIN proved against the row when it synced
    const { sock: board, errors } = await scoreboard('192.0.2.40', G, { keep: true })
    const g = guesser()
    try {
      assert.deepEqual(errors, [])
      await subscribe(live, 'ls', [{ table: 'match_live_state', event: '*', column: 'match_id', value: uuid }])
      const published = (marker) => live.messages.some((m) => m.type === 'db-change' && m.new?.points_a === marker)
      // A room of its own (not in the database), re-synced by its owner with
      // the synced match pointed at the row, then a live state
      const repoint = async (pin, marker) => {
        const sock = await openSocket(srv.wsUrl, { headers: as(g()) })
        try {
          const own = `pmb_own_${tag}_${marker}`
          sock.send({ type: 'sync-match-data', matchId: 'y', match: { id: 'y', seed_key: own, gamePin: pin, status: 'live' }, sets: [], events: [] })
          sock.send({ type: 'sync-match-data', matchId: 'y', match: { id: 'y', seed_key: own, externalId: uuid, status: 'live' }, sets: [], events: [] })
          sock.send({ type: 'live-state-update', matchId: 'y', liveState: { points_a: marker, points_b: 0 } })
          sock.send({ type: 'ping' })
          await sock.waitFor((m) => m.type === 'pong')
          await sleep(300)
          assert.deepEqual(sock.messages.filter((m) => m.type === 'error'), [])
        } finally {
          sock.send({ type: 'delete-match', matchId: 'y' })
          await sleep(50)
          sock.ws.close()
        }
      }
      // wrong game PINs publish nothing and count for that match
      for (const [i, pin] of WRONG.entries()) await repoint(pin, 81 + i)
      assert.equal((await claim(g(), { externalId: G.ext, pin: G.gamePin })).status, 429)
      // the right PIN under the lock of its range publishes nothing either
      await repoint(G.gamePin, 85)
      // the scorer's room is bound to the row: its live state still goes out
      board.send({ type: 'live-state-update', matchId: 7, liveState: { points_a: 12, points_b: 10 } })
      await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new?.points_a === 12, 5000, 'the scorer\'s live state')
      await sleep(200)
      for (const marker of [81, 82, 83, 85]) assert.equal(published(marker), false, `live state ${marker} was published`)
    } finally {
      live.ws.close()
      board.ws.close()
    }
  })

  it('a match only the relay holds: its scoring device reconnects under a lock of its game PIN, others do not', async () => {
    const R = { seed_key: `pmb_relayonly_${tag}`, gamePin: '919293' }
    const device = (id) => ({ id, platform: 'web' })
    const { sock, errors } = await scoreboard('192.0.2.50', { ext: R.seed_key, gamePin: R.gamePin, pins: { referee: '949596' } }, { device: SCORER_DEVICE, keep: true })
    assert.deepEqual(errors, [])
    const referee = await refereeIn(srv.wsUrl, '192.0.2.55', R.seed_key)
    const g = guesser()
    try {
      // wrong claims of other devices from one range
      for (const pin of WRONG) {
        assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: R.seed_key, gamePin: pin }, { device: device(OTHER_DEVICE) }), ['not-match-owner'], pin)
      }
      assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: R.seed_key, gamePin: R.gamePin }, { device: device(OTHER_DEVICE) }), ['rate-limited'])
      // the scorer's tablet drops off the Wi-Fi and comes back, in that range (another /64 of it)
      sock.ws.close()
      await sleep(200)
      assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: R.seed_key, gamePin: R.gamePin }, { device: device(SCORER_DEVICE) }), [])
      // a scoreboard of that range that names no device (older apps) waits for the lock to end
      assert.deepEqual(await syncOnce(srv.wsUrl, g(), { seed_key: R.seed_key, gamePin: R.gamePin }), ['rate-limited'])
    } finally {
      referee.ws.close()
      sock.ws.close()
    }
  })
})

describe('venue relay (--local): the scoring device reconnects under a lock of its game PIN', () => {
  const DEVICE = '5c0e5c0e-0000-4000-8000-0000000000a1'
  const CLAIM = 'claim-aaaaaaaaaaaaaaaa'
  let srv
  before(async () => {
    srv = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_RANGE_FAILURES: '2', OV_PIN_MATCH_FAILURES: '3' }, ['--local'])
  })
  after(async () => { await srv?.stop() })

  it('the scoring device gets back in; another device, or a sync that names none, does not', async () => {
    const ext = 'venue_match_1'
    const GAME = '414243'
    const me = { id: DEVICE, platform: 'web', claim: CLAIM }
    const scorer = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': '10.0.0.10' } })
    scorer.send({ type: 'sync-match-data', matchId: 1, match: { id: 1, seed_key: ext, gamePin: GAME, status: 'live' }, sets: [], events: [], device: me })
    scorer.send({ type: 'ping' })
    await scorer.waitFor((m) => m.type === 'pong')
    assert.deepEqual(scorer.messages.filter((m) => m.type === 'error'), [])
    const referee = await refereeIn(srv.wsUrl, '10.0.0.20', ext)
    try {
      // wrong claims from other hall devices: the hall's /24 (share 4) locks
      for (const [ip, pin] of [['10.0.0.31', '101010'], ['10.0.0.31', '202020'], ['10.0.0.32', '303030'], ['10.0.0.33', '404040']]) {
        assert.deepEqual(await syncOnce(srv.wsUrl, ip, { seed_key: ext, gamePin: pin }, { roomId: 1 }), ['not-match-owner'], pin)
      }
      assert.deepEqual(await syncOnce(srv.wsUrl, '10.0.0.34', { seed_key: ext, gamePin: GAME }, { roomId: 1 }), ['rate-limited'])
      const other = { id: '5c0e5c0e-0000-4000-8000-0000000000a2', platform: 'web', claim: 'claim-bbbbbbbbbbbbbbbb' }
      assert.deepEqual(await syncOnce(srv.wsUrl, '10.0.0.10', { seed_key: ext, gamePin: GAME }, { roomId: 1, device: other }), ['rate-limited'])
      // the scorer's tablet sleeps and reconnects
      scorer.ws.close()
      await sleep(200)
      assert.deepEqual(await syncOnce(srv.wsUrl, '10.0.0.10', { seed_key: ext, gamePin: GAME }, { roomId: 1, device: me }), [])
    } finally {
      referee.ws.close()
      scorer.ws.close()
    }
  })
})
