/**
 * A bench's match token on anonymous /api/db (the referee/bench fallback when
 * the relay has no copy of the match) opens the rosters as the relay gives
 * that bench (lib/publicColumns.js relayBundleView): its own team by name,
 * the other team's players as shirt numbers and its officials as their role.
 * The referee's token opens both teams. Audit 2611 PERM-11: a home bench PIN
 * read the away team's players and bench officials by name over HTTP.
 *
 * The unit part needs nothing; the end-to-end part boots server.js against a
 * real Postgres (PG_TEST_URL, see tests/server.e2e.test.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { projectAnonDbRows, projectNonOwnerRows } from '../lib/publicColumns.js'

const ROW = Object.freeze({
  id: 'u-1',
  external_id: 'match_a',
  sport_type: 'indoor',
  connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
  players_home: [{ number: 4, first_name: 'Hana', last_name: 'Heim', is_captain: true }],
  players_away: [{ number: 1, first_name: 'Gast1', last_name: 'Muster', libero: true }],
  bench_home: [{ first_name: 'Hugo', last_name: 'Heimcoach', role: 'Coach' }],
  bench_away: [{ first_name: 'Gabi', last_name: 'Gastcoach', role: 'Coach' }]
})
const BEACH = Object.freeze({
  id: 'u-2',
  external_id: 'beach_a',
  sport_type: 'beach',
  players_team1: [{ number: 1, first_name: 'Tia', last_name: 'One' }],
  players_team2: [{ number: 2, first_name: 'Tom', last_name: 'Two' }]
})
const copy = (o) => JSON.parse(JSON.stringify(o))

describe('projectAnonDbRows: a granted row by the token\'s role', () => {
  it('a home bench: its own team by name, the away team as numbers and roles', () => {
    const out = projectAnonDbRows('matches', copy(ROW), { grantedExternalId: 'match_a', grantedRole: 'bench_home' })
    assert.deepEqual(out.players_home, ROW.players_home)
    assert.deepEqual(out.bench_home, ROW.bench_home)
    assert.deepEqual(out.players_away, [{ number: 1 }])
    assert.deepEqual(out.bench_away, [{ role: 'Coach' }])
  })
  it('an away bench the other way round', () => {
    const out = projectAnonDbRows('matches', [copy(ROW)], { grantedExternalId: 'match_a', grantedRole: 'bench_away' })[0]
    assert.deepEqual(out.players_away, ROW.players_away)
    assert.deepEqual(out.bench_away, ROW.bench_away)
    assert.deepEqual(out.players_home, [{ number: 4 }])
    assert.deepEqual(out.bench_home, [{ role: 'Coach' }])
  })
  it('the referee: both teams whole', () => {
    const out = projectAnonDbRows('matches', copy(ROW), { grantedExternalId: 'match_a', grantedRole: 'referee' })
    for (const c of ['players_home', 'players_away', 'bench_home', 'bench_away']) assert.deepEqual(out[c], ROW[c])
  })
  it('beach benches (bench_team1 / bench_team2) as home / away', () => {
    const t1 = projectAnonDbRows('matches', copy(BEACH), { grantedExternalId: 'beach_a', grantedRole: 'bench_team1' })
    assert.deepEqual(t1.players_team1, BEACH.players_team1)
    assert.deepEqual(t1.players_team2, [{ number: 2 }])
    const t2 = projectAnonDbRows('matches', copy(BEACH), { grantedExternalId: 'beach_a', grantedRole: 'bench_team2' })
    assert.deepEqual(t2.players_team2, BEACH.players_team2)
    assert.deepEqual(t2.players_team1, [{ number: 1 }])
  })
  it('a role that proves no team (an unknown one): both teams as numbers', () => {
    const out = projectAnonDbRows('matches', copy(ROW), { grantedExternalId: 'match_a', grantedRole: 'viewer' })
    assert.deepEqual(out.players_home, [{ number: 4 }])
    assert.deepEqual(out.players_away, [{ number: 1 }])
  })
  it('a signed-in reader who does not own the match gets the same (projectNonOwnerRows)', () => {
    const out = projectNonOwnerRows('matches', [{ ...copy(ROW), __owned: false }], { grantedExternalId: 'match_a', grantedRole: 'bench_home' })[0]
    assert.deepEqual(out.players_away, [{ number: 1 }])
    assert.deepEqual(out.players_home, ROW.players_home)
  })
  it('other rows keep no roster at all', () => {
    const out = projectAnonDbRows('matches', [copy(ROW), { ...copy(ROW), external_id: 'match_b' }], { grantedExternalId: 'match_a', grantedRole: 'bench_home' })
    assert.equal('players_home' in out[1], false)
    assert.equal('players_away' in out[1], false)
  })
})

describe('anonymous /api/db with a bench token (end to end)', { skip: SKIP }, () => {
  const PIN_SECRET = randomBytes(32).toString('base64url')
  const PINS = { referee: '461302', bench_home: '730214', bench_away: '519027' }
  const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  let db
  let srv
  let sql

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET })
    const email = `scorer-${randomBytes(3).toString('hex')}@example.ch`
    const headers = { 'cf-connecting-ip': '198.51.100.71' }
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password: 'correct-horse-battery' } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password: 'correct-horse-battery' } })
    await grantRoles(sql, inn.json.data.user.id, ['scorer'])
    const r = await api(srv.base, '/api/db', {
      token: inn.json.data.session.access_token,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext,
            game_n: 9401,
            game_pin: '824613',
            connection_pins: PINS,
            connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
            status: 'setup',
            sport_type: 'indoor',
            home_team: { name: 'Home VC' },
            away_team: { name: 'Away VC' },
            players_home: [{ number: 4, first_name: 'Hana', last_name: 'Heim' }],
            players_away: [{ number: 1, first_name: 'Gast1', last_name: 'Muster' }],
            bench_home: [{ first_name: 'Hugo', last_name: 'Heimcoach', role: 'Coach' }],
            bench_away: [{ first_name: 'Gabi', last_name: 'Gastcoach', role: 'Coach' }],
            scheduled_at: new Date().toISOString()
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(r.status, 200, r.text)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  const tokenOf = async (type, ip) => {
    const r = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': ip }, body: { pin: PINS[type], type } })
    assert.equal(r.status, 200, r.text)
    return r.json.token
  }
  const select = (token) => api(srv.base, '/api/db', {
    proto: null,
    headers: { 'X-OV-Match-Token': token, 'cf-connecting-ip': '203.0.113.203' },
    body: { table: 'matches', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: ext }], maybeSingle: true } }
  })

  it('the home bench\'s token: the away team as shirt numbers and roles, no name', async () => {
    const r = await select(await tokenOf('bench_home', '203.0.113.202'))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.players_home, [{ number: 4, first_name: 'Hana', last_name: 'Heim' }])
    assert.deepEqual(r.json.data.players_away, [{ number: 1 }])
    assert.deepEqual(r.json.data.bench_away, [{ role: 'Coach' }])
    assert.equal(r.text.includes('Gastcoach') || r.text.includes('Muster'), false)
  })

  it('the away bench\'s token: the home team so', async () => {
    const r = await select(await tokenOf('bench_away', '203.0.113.204'))
    assert.deepEqual(r.json.data.players_away, [{ number: 1, first_name: 'Gast1', last_name: 'Muster' }])
    assert.deepEqual(r.json.data.players_home, [{ number: 4 }])
    assert.deepEqual(r.json.data.bench_home, [{ role: 'Coach' }])
  })

  it('the referee\'s token: both teams by name', async () => {
    const r = await select(await tokenOf('referee', '203.0.113.205'))
    assert.equal(r.json.data.players_away[0].last_name, 'Muster')
    assert.equal(r.json.data.bench_home[0].last_name, 'Heimcoach')
  })
})
