/**
 * The club API (db/032, lib/clubApi.js): a club manager makes tokens in the
 * manager; /api/club/v1/* with a token reads and writes the club's own teams,
 * rosters and licence lists, nothing of another club.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { hashToken, TOKEN_PREFIX } from '../lib/clubApi.js'

describe('club API tokens (unit)', () => {
  it('a token is hashed with SHA-256 and has a recognisable prefix', () => {
    assert.equal(hashToken('abc').length, 32)
    assert.notDeepEqual(hashToken('abc'), hashToken('abd'))
    assert.equal(TOKEN_PREFIX, 'ovk_')
  })
})

describe('club API end to end', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    users[name] = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    return users[name]
  }
  const session = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: method === 'GET' ? null : '2' })
  const club = (token, method, path, body) => api(srv.base, '/api/club/v1' + path, { method, body, proto: null, headers: token ? { Authorization: `Bearer ${token}` } : {} })

  let muster, other, teamH1, teamOther, readTok, writeTok
  const auditOf = async (action) => (await sql.query('SELECT actor_id, details FROM public.audit_log WHERE action = $1 ORDER BY at', [action])).rows

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('920001', 'VBC Musterdorf H1', 'VBC Other H1', '2L', now() + interval '3 days'),
      ('920002', 'VBC Other H1', 'VBC Third H1', '2L', now() + interval '4 days')`)
    await account('admin')
    await account('boss')
    await account('stranger')
    await sql.query(`UPDATE public.profiles SET roles = ARRAY['admin'] WHERE user_id = $1`, [users.admin.id])
    muster = (await session(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    other = (await session(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })).json.data.club
    teamH1 = (await sql.query(`SELECT id FROM public.club_teams WHERE club_id = $1`, [muster.id])).rows[0].id
    teamOther = (await sql.query(`SELECT id FROM public.club_teams WHERE club_id = $1`, [other.id])).rows[0].id
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [muster.id, users.boss.id])
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('a manager makes a read token; the secret is shown once and the list never has it', async () => {
    const r = await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'Website', scopes: ['read'] })
    assert.equal(r.status, 201, r.text)
    assert.match(r.json.data.token, /^ovk_[A-Za-z0-9_-]{43}$/)
    readTok = r.json.data.token
    const list = await session(users.boss, 'GET', `/api/club/${muster.id}/api-tokens`)
    assert.equal(list.json.data.tokens.length, 1)
    assert.ok(!list.text.includes(readTok))
    assert.equal(list.json.data.tokens[0].prefix, readTok.slice(0, 8))
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.club_api_tokens WHERE token_hash = $1', [Buffer.from(readTok)])).rows[0].n, 0, 'the token itself is not stored')
  })

  it('only the club\'s manager makes tokens; a write token needs the password', async () => {
    assert.equal((await session(users.stranger, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'x', scopes: ['read'] })).status, 403)
    assert.equal((await session(users.boss, 'POST', `/api/club/${other.id}/api-tokens`, { label: 'x', scopes: ['read'] })).status, 403)
    const noPw = await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'w', scopes: ['rosters:write'] })
    assert.equal(noPw.json.error.code, 'OV_PASSWORD_REQUIRED')
    const badPw = await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'w', scopes: ['rosters:write'], password: 'wrong-password-1' })
    assert.equal(badPw.json.error.code, 'OV_PASSWORD_INVALID')
    assert.equal((await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'w', scopes: ['bogus'] })).status, 400)
    const w = await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'Server', scopes: ['rosters:write', 'teams:write', 'licences:write'], password: PASSWORD })
    assert.equal(w.status, 201, w.text)
    assert.ok(w.json.data.scopes.includes('read'), 'a write scope brings read')
    writeTok = w.json.data.token
  })

  it('without a valid token: 401; another club\'s teams are not found', async () => {
    assert.equal((await club(null, 'GET', '/teams')).status, 401)
    assert.equal((await club('ovk_' + 'A'.repeat(43), 'GET', '/teams')).status, 401)
    const teams = await club(readTok, 'GET', '/teams')
    assert.equal(teams.status, 200, teams.text)
    assert.deepEqual(teams.json.data.teams, [{ id: teamH1, name: 'VBC Musterdorf H1' }])
    assert.equal((await club(readTok, 'GET', `/teams/${teamOther}/games`)).status, 404)
    assert.equal((await club(readTok, 'GET', `/teams/${teamOther}/squad`)).status, 404)
  })

  it('reads the club\'s games; a read token cannot write', async () => {
    const g = await club(readTok, 'GET', '/games')
    assert.equal(g.status, 200, g.text)
    assert.deepEqual(g.json.data.games.map((x) => x.game_number), ['920001'])
    const put = await club(readTok, 'PUT', `/teams/${teamH1}/games/920001/roster`, { players: [], staff: [] })
    assert.equal(put.status, 403)
    assert.equal(put.json.error.code, 'OV_SCOPE_REQUIRED')
  })

  it('roster CRUD with a write token, validated by the same rules as the manager', async () => {
    const path = `/teams/${teamH1}/games/920001/roster`
    const players = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, first_name: 'P' + i, last_name: 'Test', active: true }))
    const bad = await club(writeTok, 'PUT', path, { players: [{ number: 1, last_name: 'A', active: true }, { number: 1, last_name: 'B', active: true }], staff: [] })
    assert.equal(bad.status, 400)
    const put = await club(writeTok, 'PUT', path, { players, staff: [] })
    assert.equal(put.status, 200, put.text)
    const get = await club(readTok, 'GET', path)
    assert.equal(get.json.data.roster.players.length, 6)
    // another club's game number is not this team's game
    assert.equal((await club(writeTok, 'PUT', `/teams/${teamH1}/games/920002/roster`, { players, staff: [] })).status, 404)
    const del = await club(writeTok, 'DELETE', path)
    assert.equal(del.status, 200, del.text)
    assert.equal((await club(readTok, 'GET', path)).json.data?.roster ?? null, null)
  })

  it('a squad and a licence list can be replaced; the audit names the token', async () => {
    const squad = await club(writeTok, 'PUT', `/teams/${teamH1}/squad`, { players: [{ number: 5, first_name: 'A', last_name: 'B', active: true }], staff: [] })
    assert.equal(squad.status, 200, squad.text)
    const list = await club(writeTok, 'PUT', '/licences/players', { people: [{ first_name: 'Anna', last_name: 'Muster', sv_number: '123456', dob: '1999-01-01', gender: 'f' }] })
    assert.equal(list.status, 200, list.text)
    const calls = await auditOf('club_api.call')
    assert.ok(calls.length >= 3)
    assert.ok(calls.every((c) => c.details.token_id && c.details.club_id === muster.id))
    assert.ok((await auditOf('club_api.token')).length >= 2)
  })

  it('a token limited to one team cannot reach club-wide data', async () => {
    const t = (await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'H1 only', scopes: ['read'], team_id: teamH1 })).json.data.token
    assert.equal((await club(t, 'GET', '/teams')).json.data.teams.length, 1)
    assert.equal((await club(t, 'GET', '/licences')).json.error.code, 'OV_TOKEN_TEAM_ONLY')
  })

  it('a revoked token and a token of a removed manager stop working', async () => {
    const mk = async () => (await session(users.boss, 'POST', `/api/club/${muster.id}/api-tokens`, { label: 'tmp', scopes: ['read'] })).json.data
    const a = await mk()
    assert.equal((await club(a.token, 'GET', '/teams')).status, 200)
    assert.equal((await session(users.boss, 'DELETE', `/api/club/${muster.id}/api-tokens/${a.id}`)).status, 200)
    assert.equal((await club(a.token, 'GET', '/teams')).status, 401)
    const b = await mk()
    await sql.query('DELETE FROM public.club_managers WHERE user_id = $1', [users.boss.id])
    const gone = await club(b.token, 'GET', '/teams')
    assert.equal(gone.status, 403)
    assert.equal(gone.json.error.code, 'OV_TOKEN_OWNER')
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [muster.id, users.boss.id])
  })

  it('the public list filters by club', async () => {
    await sql.query(`INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team)
      VALUES ('ca_m1','live',31, now(), '{"name":"VBC Musterdorf H1"}', '{"name":"VBC Third H1"}'),
             ('ca_m2','live',32, now(), '{"name":"VBC Other H1"}', '{"name":"VBC Third H1"}')`)
    const pub = await api(srv.base, `/api/public/v1/matches?club=${muster.id}`, { method: 'GET', proto: null })
    assert.deepEqual(pub.json.matches.map((m) => m.id), ['ca_m1'])
    const mine = await club(readTok, 'GET', '/matches')
    assert.deepEqual(mine.json.matches.map((m) => m.id), ['ca_m1'])
    assert.equal((await club(readTok, 'GET', '/matches/ca_m2/live')).status, 404)
    assert.equal((await club(readTok, 'GET', '/matches/ca_m1/live')).status, 200)
  })
})
