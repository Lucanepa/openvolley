/**
 * SEC-05 (audit 2026-11, owner decision 1): the PIN lock across address
 * buckets is scoped to the guessing address ranges, end to end with the
 * production numbers (no OV_PIN_* override) and the production grants
 * (ov_app): server.js against a real Postgres (PG_TEST_URL, or
 * OV_E2E_DOCKER=1) behind TRUST_PROXY=cloudflare, where cf-connecting-ip is
 * the client's address.
 *
 * The audit's PoC (poc/pins-codes/lock-dos.mjs, poc/sec-05/scope-checks.mjs,
 * poc/beach/low-findings.sh part a): 30 wrong X-OV-Match-Pin values on GET
 * /api/match/:id from two addresses refused the RIGHT referee, bench and game
 * PIN of the match to everyone for 10 minutes (validate-connection-pin,
 * the relay's validate-pin, restore-by-pin, claim, relay subscribe-match),
 * and nobody was alerted. Now:
 *
 *   1. those 30 wrong PINs refuse nobody: the right PINs pass on every path,
 *      from the guessers' /24 too (below its share), and one ops alert is
 *      captured for the match (error tracker, never a PIN)
 *   2. past its share (40 for an IPv4 /24) the guessing range is refused that
 *      match's PIN checks, the right PIN too; every other range passes on
 *      every path; one lock line per PIN type, still one alert
 *   3. restore-by-pin of a game number and claim: the guessing range is
 *      refused, another range passes; a signed-in creator, the device the
 *      database names as the match's scorer and a valid match token are not
 *      refused by the range lock, and neither is the scorer's own scoreboard
 *      on the relay
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
const M = {
  ext: `psl_m_${tag}`,
  n: 9701,
  gamePin: '471925',
  pins: { referee: '583016', bench_home: '694127', bench_away: '705238', upload_home: '816349', upload_away: '927450' }
}
// a second match, only in the database: restore-by-pin of its game number
const M2 = { ext: `psl_m2_${tag}`, n: 9702, gamePin: '138264', pins: { referee: '249375', bench_home: '350486', bench_away: '461597' } }
const SCORER_DEVICE = '5c0e5c0e-0000-4000-8000-0000000005c1'
const SCORER_DEVICE_2 = '5c0e5c0e-0000-4000-8000-0000000005c2'
// the guessers' range (IPv4 /24) and everybody else
const A = (i) => `203.0.113.${i}`
const B = (i) => `198.51.100.${i}`

describe('SEC-05: the PIN lock refuses the guessing ranges only', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let creator
  let board
  let wrongSeq = 100000
  // a wrong PIN no match uses
  const nextWrong = () => {
    let p
    do p = String(wrongSeq++)
    while ([M.gamePin, M2.gamePin, ...Object.values(M.pins), ...Object.values(M2.pins)].includes(p))
    return p
  }
  const as = (ip) => ({ 'cf-connecting-ip': ip })
  const connectionPin = (ip, body) => api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: as(ip), body })
  const relayPin = (ip, body) => api(srv.base, '/api/match/validate-pin', { proto: null, headers: as(ip), body })
  const matchByPin = (ip, pin) => api(srv.base, `/api/match/${encodeURIComponent(M.ext)}`, { method: 'GET', proto: null, headers: { ...as(ip), 'X-OV-Match-Pin': pin } })
  const restore = (ip, body, token) => api(srv.base, '/api/match/restore-by-pin', { proto: null, token, headers: as(ip), body })
  const claim = (ip, who, body) => api(srv.base, '/api/match/claim', { token: who.token, proto: null, headers: as(ip), body })
  const pinLines = () => srv.output.join('').split('\n').filter((l) => l.startsWith('[PIN] '))
  const alertEvents = async (view) => (await sql.query("SELECT message, data FROM public.error_events WHERE source = 'server' AND view = $1 ORDER BY id", [view])).rows

  /** subscribe-match on a socket of its own: the bundle's access and the error codes. */
  async function subscribeAs(ip, extra) {
    const s = await openSocket(srv.wsUrl, { headers: as(ip) })
    try {
      s.send({ type: 'subscribe-match', matchId: M.ext, role: 'referee', device: 'referee', ...extra })
      const data = await s.waitFor((m) => m.type === 'match-full-data', 5000, 'match-full-data')
      return { access: data.access, errors: s.messages.filter((m) => m.type === 'error').map((m) => m.code) }
    } finally {
      s.ws.close()
    }
  }
  /** One scoreboard sync of M on a socket of its own; its error codes (keep: the socket stays). */
  async function scoreboard(ip, device, { keep = false } = {}) {
    const s = await openSocket(srv.wsUrl, { headers: as(ip) })
    s.send({
      type: 'sync-match-data',
      matchId: M.ext,
      match: {
        seed_key: M.ext,
        gamePin: M.gamePin,
        refereePin: M.pins.referee,
        homeTeamPin: M.pins.bench_home,
        awayTeamPin: M.pins.bench_away,
        refereeConnectionEnabled: true,
        homeTeamConnectionEnabled: true,
        awayTeamConnectionEnabled: true,
        status: 'live',
        gameNumber: M.n
      },
      homeTeam: { name: 'Home VC' },
      awayTeam: { name: 'Away VC' },
      homePlayers: [{ number: 7, firstName: 'Mia', lastName: 'Example' }],
      awayPlayers: [],
      sets: [],
      events: [],
      device: { id: device, platform: 'web' }
    })
    s.send({ type: 'ping' })
    await s.waitFor((m) => m.type === 'pong')
    const errors = s.messages.filter((m) => m.type === 'error').map((m) => m.code)
    if (!keep) s.ws.close()
    return keep ? { sock: s, errors } : errors
  }
  async function account(name, ip) {
    const email = `${name}-${tag}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: as(ip), body: { email, password, metadata: { first_name: 'Scorer' } } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: as(ip), body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const who = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, who.id, ['scorer'])
    return who
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-psl-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-psl-status-'))
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
    creator = await account('psl', '192.0.2.200')
    for (const m of [M, M2]) {
      const up = await api(srv.base, '/api/db', {
        token: creator.token,
        headers: as('192.0.2.200'),
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
    }
    for (const [m, device] of [[M, SCORER_DEVICE], [M2, SCORER_DEVICE_2]]) {
      await sql.query(
        `INSERT INTO public.match_scorer_devices (match_id, device_id, platform)
         SELECT id, $1, 'web' FROM public.matches WHERE external_id = $2
         ON CONFLICT (match_id) DO UPDATE SET device_id = EXCLUDED.device_id`, [device, m.ext])
    }
    // the scorer's tablet holds M on the relay
    const held = await scoreboard('192.0.2.10', SCORER_DEVICE, { keep: true })
    assert.deepEqual(held.errors, [])
    board = held.sock
  })

  after(async () => {
    board?.ws.close()
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the PoC: 30 wrong X-OV-Match-Pin from two addresses refuse nobody; the right PINs pass on every path; one alert', async () => {
    assert.equal((await connectionPin(B(1), { pin: M.pins.referee, type: 'referee', matchExternalId: M.ext })).status, 200, 'before')
    // 30 wrong PINs, 15 from each of two addresses of one /24 (no account)
    for (let i = 0; i < 30; i++) {
      const r = await matchByPin(A(1 + (i % 2)), nextWrong())
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.access, 'summary')
    }
    // the right PINs, from fresh addresses of that /24 and from elsewhere
    for (const ip of [A(201), B(201)]) {
      const ref = await connectionPin(ip, { pin: M.pins.referee, type: 'referee', matchExternalId: M.ext })
      assert.equal(ref.status, 200, `${ip} referee: ${ref.text}`)
      assert.equal((await connectionPin(ip, { pin: M.pins.bench_home, type: 'bench_home', matchExternalId: M.ext })).status, 200, `${ip} bench`)
      assert.equal((await relayPin(ip, { pin: M.pins.referee, type: 'referee', matchId: M.ext })).status, 200, `${ip} relay validate-pin`)
      const full = await matchByPin(ip, M.pins.bench_away)
      assert.equal(full.status, 200, full.text)
      assert.equal(full.json.access, 'full', `${ip} GET with the bench PIN`)
      const rbp = await restore(ip, { gameN: M.n, pin: M.gamePin })
      assert.equal(rbp.status, 200, `${ip} restore-by-pin: ${rbp.text}`)
      assert.equal(rbp.json.data.match.external_id, M.ext)
      assert.deepEqual(await subscribeAs(ip, { pin: M.pins.referee }), { access: 'full', errors: [] }, `${ip} relay subscribe`)
    }
    // claim by a scorer who is neither creator nor editor
    const claimer = await account('psl-claimer', '192.0.2.201')
    assert.equal((await claim(A(202), claimer, { externalId: M.ext, pin: M.gamePin })).status, 200)
    // one ops alert for the match, all four PIN types it compared, no PIN in it
    await waitUntil(async () => (await alertEvents('pin budget match')).length > 0, { timeoutMs: 5000, what: 'the alert in the error tracker' })
    const [alert, ...more] = await alertEvents('pin budget match')
    assert.deepEqual(more, [])
    // the range by its width and a pseudonym, never its address (PL-R3: privacy section 14)
    assert.match(alert.message, /^PIN guessing: match psl_m_[0-9a-f]+: 30 wrong referee\/bench_home\/bench_away\/game PINs from all callers within 10 min \(IPv4 \/24 #[b-z]{8} x30\)/)
    assert.equal(alert.data.count, 30)
    assert.equal(alert.data.ranges.length, 1)
    assert.match(alert.data.ranges[0], /^IPv4 \/24 #[b-z]{8} x30$/)
    assert.equal(/203\.0\.113/.test(JSON.stringify(alert)), false, 'never an address')
    assert.equal(alert.data.match, M.ext)
    const text = JSON.stringify(alert)
    for (const pin of [M.gamePin, ...Object.values(M.pins)]) assert.equal(text.includes(pin), false, 'never a PIN')
    assert.equal(pinLines().filter((l) => l.includes(M.ext) && l.includes('from all callers')).length, 1)
    assert.equal(pinLines().some((l) => l.includes(M.ext) && / refused for \d+ min/.test(l)), false, 'no range is locked yet')
  })

  it('past its share the guessing range is refused the match\'s PIN checks, the right PIN too; every other range passes', async () => {
    // 10 more from a third address: the /24 has 40 now (its share)
    for (let i = 0; i < 10; i++) assert.equal((await matchByPin(A(3), nextWrong())).json.access, 'summary')
    const guesser = A(9)
    const named = await connectionPin(guesser, { pin: M.pins.referee, type: 'referee', matchExternalId: M.ext })
    assert.equal(named.status, 429, named.text)
    assert.equal(named.headers.get('retry-after'), '600')
    assert.equal((await connectionPin(guesser, { pin: M.pins.bench_home, type: 'bench_home', matchExternalId: M.ext })).status, 429)
    assert.equal((await matchByPin(guesser, M.pins.referee)).status, 429)
    assert.equal((await relayPin(guesser, { pin: M.pins.referee, type: 'referee', matchId: M.ext })).status, 429)
    assert.deepEqual(await subscribeAs(guesser, { pin: M.pins.referee }), { access: 'summary', errors: ['rate-limited'] })
    // its PIN-only lookups never prove the match it is locked out of
    assert.equal((await connectionPin(guesser, { pin: M.pins.referee, type: 'referee' })).status, 404)
    // every other range: the right PIN, on every path
    for (const ip of [B(20), '2001:db8:5e05::1']) {
      assert.equal((await connectionPin(ip, { pin: M.pins.referee, type: 'referee', matchExternalId: M.ext })).status, 200, ip)
      assert.equal((await connectionPin(ip, { pin: M.pins.referee, type: 'referee' })).status, 200, `${ip} PIN-only`)
      assert.equal((await connectionPin(ip, { pin: M.pins.bench_away, type: 'bench_away', matchExternalId: M.ext })).status, 200, ip)
      assert.equal((await relayPin(ip, { pin: M.pins.referee, type: 'referee', matchId: M.ext })).status, 200, ip)
      assert.equal((await matchByPin(ip, M.pins.referee)).json.access, 'full', ip)
      assert.deepEqual(await subscribeAs(ip, { pin: M.pins.bench_home, role: 'bench', team: 'home' }), { access: 'full', errors: [] }, ip)
    }
    // one lock line per PIN type for the range; still one alert
    const lockLine = (type) => new RegExp(`^\\[PIN\\] match ${M.ext}: 40 wrong ${type} PINs from IPv4 /24 #[b-z]{8} within`)
    await waitUntil(() => pinLines().some((l) => lockLine('referee').test(l)), { timeoutMs: 3000, what: 'the lock line' })
    for (const type of ['referee', 'bench_home', 'bench_away', 'game']) {
      assert.equal(pinLines().filter((l) => lockLine(type).test(l)).length, 1, type)
    }
    // one name for the range in every line; no address in any [PIN] line (PL-R3)
    assert.equal(new Set(pinLines().filter((l) => /^\[PIN\] match .*: 40 wrong/.test(l)).map((l) => /IPv4 \/24 #[b-z]{8}/.exec(l)[0])).size, 1)
    assert.deepEqual(pinLines().filter((l) => /203\.0\.113|198\.51\.100|192\.0\.2|2001:db8/.test(l)), [])
    assert.equal((await alertEvents('pin budget match')).length, 1)
  })

  it('restore-by-pin and claim: the guessing range is refused, others pass; creator, scorer device and match token are not refused', async () => {
    // wrong game PINs for M2's game number from 8 addresses of the guessing /24 (5 each: its per-caller limit)
    for (let a = 30; a < 38; a++) {
      for (let i = 0; i < 5; i++) assert.equal((await restore(A(a), { gameN: M2.n, pin: nextWrong() })).status, 404, `${a}/${i}`)
    }
    const refused = await restore(A(41), { gameN: M2.n, pin: M2.gamePin })
    assert.equal(refused.status, 429, refused.text)
    assert.equal(refused.headers.get('retry-after'), '600')
    await waitUntil(() => pinLines().some((l) => new RegExp(`^\\[PIN\\] game number ${M2.n}: 40 wrong game PINs in restore-by-pin from IPv4 /24 #[b-z]{8} within`).test(l)), { timeoutMs: 3000, what: 'the game number lock line' })
    // another range
    const fine = await restore(B(41), { gameN: M2.n, pin: M2.gamePin })
    assert.equal(fine.status, 200, fine.text)
    assert.equal(fine.json.data.match.external_id, M2.ext)
    // trusted beyond the PIN, from the guessing range: the signed-in creator ...
    const own = await restore(A(42), { gameN: M2.n, pin: M2.gamePin }, creator.token)
    assert.equal(own.status, 200, own.text)
    // ... and the device the database names as the match's scorer (the take-back on a new install)
    const device = await restore(A(43), { gameN: M2.n, pin: M2.gamePin, claim: true, device: { id: SCORER_DEVICE_2, platform: 'web' } })
    assert.equal(device.status, 200, device.text)
    // a device the database does not name is refused
    assert.equal((await restore(A(44), { gameN: M2.n, pin: M2.gamePin, claim: true, device: { id: '5c0e5c0e-0000-4000-8000-0000000005c9', platform: 'web' } })).status, 429)
    // one alert for the game number
    await waitUntil(async () => (await alertEvents('pin budget game')).length > 0, { timeoutMs: 5000, what: 'the game number alert' })
    assert.equal((await alertEvents('pin budget game')).length, 1)

    // M's game PIN is locked for the guessing range (the wrong X-OV-Match-Pin
    // values above compared it): restore-by-pin of its game number from there
    // answers it as a wrong PIN, except to its signed-in creator
    assert.equal((await restore(A(50), { gameN: M.n, pin: M.gamePin })).status, 404)
    const ownM = await restore(A(51), { gameN: M.n, pin: M.gamePin }, creator.token)
    assert.equal(ownM.status, 200, ownM.text)
    assert.equal(ownM.json.data.match.external_id, M.ext)
    // ... and claim from there
    const stranger = await account('psl-stranger', '192.0.2.202')
    assert.equal((await claim(A(45), stranger, { externalId: M.ext, pin: M.gamePin })).status, 429)
    assert.equal((await claim(A(46), creator, { externalId: M.ext, pin: M.gamePin })).status, 200, 'the creator')
    assert.equal((await claim(B(46), stranger, { externalId: M.ext, pin: M.gamePin })).status, 200, 'another range')
    // a valid match token, from the guessing range, on the relay
    const issued = await connectionPin(B(47), { pin: M.pins.referee, type: 'referee', matchExternalId: M.ext })
    assert.equal(issued.status, 200, issued.text)
    assert.deepEqual(await subscribeAs(A(47), { token: issued.json.token }), { access: 'full', errors: [] })
    // the scorer's tablet reconnects from the guessing range: its own match
    assert.deepEqual(await scoreboard(A(48), SCORER_DEVICE), [])
    // another device with the right game PIN from there: refused
    assert.deepEqual(await scoreboard(A(49), '5c0e5c0e-0000-4000-8000-0000000005c8'), ['rate-limited'])
  })

  // Audit 2026-11 review, PL-R1 (the reviewer's PoC): the trust of
  // restore-by-pin held for the whole game number. An account that owned ANY
  // match with it (any account may make a test match) was trusted for all of
  // them: from the locked range its guesses were compared uncounted, and the
  // victim's right PIN with claim made it editor and scorer of the victim's match.
  it('an account owning a test match of the game number is refused from the locked range, for a wrong PIN and the victim\'s right PIN alike', async () => {
    const ATTACKER_DEVICE = '5c0e5c0e-0000-4000-8000-0000000005ca'
    const T = { ext: `psl_t_${tag}`, gamePin: '000111' }
    // a plain sign-up (no scorer role) and its own test match with M2's game number
    const email = `psl-attacker-${tag}@example.ch`
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: as('192.0.2.203'), body: { email, password: 'correct-horse-battery', metadata: { first_name: 'X' } } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: as('192.0.2.203'), body: { email, password: 'correct-horse-battery' } })
    const attacker = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    const t = await api(srv.base, '/api/db', {
      token: attacker.token,
      headers: as('192.0.2.203'),
      body: { table: 'matches', action: 'upsert', params: { data: { external_id: T.ext, game_n: M2.n, game_pin: T.gamePin, test: true, connections: {}, status: 'live', sport_type: 'indoor', home_team: { name: 'H' }, away_team: { name: 'A' }, scheduled_at: new Date().toISOString() }, onConflict: 'external_id', returning: 'id', single: true } }
    })
    assert.equal(t.status, 200, t.text)
    // M2's game number is locked for the guessing /24 (the test before): anonymous, the right PIN is refused
    assert.equal((await restore(A(60), { gameN: M2.n, pin: M2.gamePin })).status, 429)
    // signed in as the attacker, from that /24: wrong PINs and the victim's right PIN, all refused
    for (let a = 61; a < 71; a++) {
      const r = await restore(A(a), { gameN: M2.n, pin: nextWrong() }, attacker.token)
      assert.equal(r.status, 429, `${a}: ${r.text}`)
    }
    const hit = await restore(A(71), { gameN: M2.n, pin: M2.gamePin, claim: true, device: { id: ATTACKER_DEVICE, platform: 'web' } }, attacker.token)
    assert.equal(hit.status, 429, hit.text)
    assert.equal(hit.json.error.code, 'OV_TOO_MANY_ATTEMPTS')
    // the victim's match kept its scorer and got no editor
    const dev = await sql.query('SELECT d.device_id FROM public.match_scorer_devices d JOIN public.matches m ON m.id = d.match_id WHERE m.external_id = $1', [M2.ext])
    assert.deepEqual(dev.rows.map((r) => r.device_id), [SCORER_DEVICE_2])
    const editors = await sql.query('SELECT count(*)::int n FROM public.match_editors e JOIN public.matches m ON m.id = e.match_id WHERE m.external_id = $1 AND e.user_id = $2', [M2.ext, attacker.id])
    assert.equal(editors.rows[0].n, 0)
    // its own test match: proved from there
    const own = await restore(A(72), { gameN: M2.n, pin: T.gamePin }, attacker.token)
    assert.equal(own.status, 200, own.text)
    assert.equal(own.json.data.match.external_id, T.ext)
  })
})
