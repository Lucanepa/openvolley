/**
 * POST /api/match/upload-roster, end to end: server.js against a real
 * Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1; see tests/server.e2e.test.js).
 *
 *   1. a roster the app's rules refuse (lib/uploadedRoster.js) is never
 *      stored: shapes, numbers, captains, libero slots, bench roles, and
 *      signatures that are not the pad's PNG data URL
 *   2. an upload fills empty signatures only: the scorer's stay, and two
 *      teams uploading at once both keep theirs
 *   3. the status is tested again in the write: a coin toss that lands
 *      between the PIN check and the write refuses the upload
 *   4. a match update that leaves 'setup' drops the pending rosters
 *
 * Made-up names.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '583016'
const PINS = { referee: '640271', bench_home: '172839', bench_away: '905162', upload_home: '318274', upload_away: '726405' }
const png = (tag) => `data:image/png;base64,${Buffer.from(`png-${tag}`).toString('base64').replace(/=+$/, '')}`
const roster = (extra = {}) => ({
  players: [
    { number: 4, firstName: 'Anna', lastName: 'Muster', dob: '14/03/2008', libero: '', isCaptain: true },
    { number: 9, firstName: 'Eva', lastName: 'Beispiel', dob: '', libero: 'libero1', isCaptain: false }
  ],
  bench: [{ role: 'Coach', firstName: 'Hans', lastName: 'Exemple', dob: '' }],
  timestamp: '2026-11-12T18:30:00.000Z',
  ...extra
})

describe('upload-roster: checked, never over stored signatures, never after the coin toss', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  let matchUuid
  let alice

  const upload = (team, body = {}) => api(srv.base, '/api/match/upload-roster', {
    proto: null,
    headers: { 'cf-connecting-ip': nextIp() },
    body: { matchExternalId: ext, team, pin: team === 'home' ? PINS.upload_home : PINS.upload_away, roster: roster(), ...body }
  })
  const stored = async () => (await sql.query('SELECT status, connections, signatures FROM matches WHERE id = $1', [matchUuid])).rows[0]
  const reset = (signatures = {}) => sql.query(
    "UPDATE matches SET status = 'setup', signatures = $2::json, connections = (coalesce(connections::jsonb, '{}') - 'pending_home_roster' - 'pending_away_roster')::json WHERE id = $1",
    [matchUuid, JSON.stringify(signatures)])

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET })
    const email = `scorer-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password } })
    alice = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, alice.id, ['scorer'])
    const r = await api(srv.base, '/api/db', {
      token: alice.token,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext, game_n: 9402, game_pin: GAME_PIN, connection_pins: PINS, status: 'setup', sport_type: 'indoor',
            connections: { referee_enabled: true }, home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' }
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(r.status, 200, r.text)
    matchUuid = r.json.data.id
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('a roster the app would refuse at Accept is not stored', async () => {
    await reset()
    const refused = [
      { roster: { players: 'x' } },
      { roster: roster({ players: [{ number: {}, lastName: {} }] }) },
      { roster: roster({ players: [{ number: 'constructor', lastName: 'Muster' }] }) },
      { roster: roster({ bench: [{ role: 'constructor', lastName: 'Muster' }] }) },
      { roster: roster({ players: [{ number: 1, isCaptain: true }, { number: 2, isCaptain: true }] }) },
      { roster: roster({ players: [{ number: 1, libero: 'libero1' }, { number: 2, libero: 'libero1' }] }) },
      { roster: roster({ players: [{ number: 7 }, { number: '7' }] }) },
      { coachSignature: 'https://tracker.example/s.png' },
      { captainSignature: 'x' }
    ]
    for (const body of refused) {
      const r = await upload('home', body)
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 120)}: ${r.text}`)
      assert.match(r.json.error, /^Invalid roster \(/)
    }
    const row = await stored()
    assert.equal(row.connections.pending_home_roster, undefined)
    assert.deepEqual(row.signatures, {})
  })

  it('stores the checked roster; the scorer\'s signatures stay, empty ones are filled', async () => {
    await reset({ home_coach: png('scorer-coach'), away_coach: png('away-coach') })
    const r = await upload('home', {
      roster: { ...roster(), extra: 'dropped' },
      coachSignature: png('upload-coach'),
      captainSignature: png('upload-captain')
    })
    assert.equal(r.status, 200, r.text)
    const row = await stored()
    assert.deepEqual(row.signatures, { home_coach: png('scorer-coach'), home_captain: png('upload-captain'), away_coach: png('away-coach') })
    const pending = row.connections.pending_home_roster
    assert.equal(pending.extra, undefined)
    assert.deepEqual(pending.players[1], { number: 9, firstName: 'Eva', lastName: 'Beispiel', dob: '', libero: 'libero1', isCaptain: false, isLfp: false })
    // the scorer sees what the team signed (and takes it into empty slots only)
    assert.equal(pending.coachSignature, png('upload-coach'))
    assert.equal(pending.captainSignature, png('upload-captain'))
    assert.equal(row.connections.referee_enabled, true, 'the other connection keys stay')
  })

  it('two teams uploading at once both keep their signatures', async () => {
    for (let round = 0; round < 4; round++) {
      await reset()
      const [h, a] = await Promise.all([
        upload('home', { coachSignature: png(`home-${round}`), captainSignature: png(`home-c-${round}`) }),
        upload('away', { coachSignature: png(`away-${round}`), captainSignature: png(`away-c-${round}`) })
      ])
      assert.equal(h.status, 200, h.text)
      assert.equal(a.status, 200, a.text)
      const row = await stored()
      assert.deepEqual(row.signatures, {
        home_coach: png(`home-${round}`), home_captain: png(`home-c-${round}`),
        away_coach: png(`away-${round}`), away_captain: png(`away-c-${round}`)
      }, `round ${round}`)
      assert.ok(row.connections.pending_home_roster && row.connections.pending_away_roster)
    }
  })

  it('a coin toss between the PIN check and the write refuses the upload', async () => {
    await reset()
    const { rows: [{ datname }] } = await sql.query('SELECT current_database() AS datname')
    const tx = new pg.Client({ connectionString: db.url })
    await tx.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('SELECT id FROM matches WHERE id = $1 FOR UPDATE', [matchUuid])
      const pendingUpload = upload('home', { coachSignature: png('late-coach') })
      // the upload has read the match (status setup) and waits for the row
      await waitUntil(async () => {
        const { rows } = await sql.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()", [datname])
        return rows[0].n > 0
      }, { timeoutMs: 10000, intervalMs: 25, what: 'the upload waiting for the row' })
      await tx.query("UPDATE matches SET status = 'live' WHERE id = $1", [matchUuid])
      await tx.query('COMMIT')
      const r = await pendingUpload
      assert.equal(r.status, 409, r.text)
    } finally {
      await tx.end().catch(() => {})
    }
    const row = await stored()
    assert.equal(row.status, 'live')
    assert.equal(row.connections.pending_home_roster, undefined)
    assert.deepEqual(row.signatures, {})
    assert.equal((await upload('home')).status, 409, 'and after it, as before')
  })

  it('the coin toss write (status leaves setup) drops the pending rosters', async () => {
    await reset()
    assert.equal((await upload('home')).status, 200)
    assert.equal((await upload('away')).status, 200)
    const r = await api(srv.base, '/api/db', {
      token: alice.token,
      body: {
        table: 'matches',
        action: 'update',
        params: { data: { status: 'live', current_set: 1, connections: { referee_enabled: true, home_bench_enabled: false } }, filters: [{ type: 'eq', column: 'external_id', value: ext }] }
      }
    })
    assert.equal(r.status, 200, r.text)
    const row = await stored()
    assert.equal(row.connections.pending_home_roster, null)
    assert.equal(row.connections.pending_away_roster, null)
    assert.equal(row.connections.referee_enabled, true)
    assert.equal(row.connections.home_bench_enabled, false)
    // a write that keeps the status leaves them alone
    await reset()
    assert.equal((await upload('home')).status, 200)
    const info = await api(srv.base, '/api/db', {
      token: alice.token,
      body: { table: 'matches', action: 'update', params: { data: { status: 'setup', connections: { referee_enabled: false } }, filters: [{ type: 'eq', column: 'external_id', value: ext }] } }
    })
    assert.equal(info.status, 200, info.text)
    assert.ok((await stored()).connections.pending_home_roster)
  })
})
