/**
 * PERM-04 (audit 2611), owner decision 2026-11-23 no. 2, end to end with the
 * production grants: club A's scorer closes an official A-home match whose
 * away team is club B's. Club B's saved team and lists stay as they are;
 * whoever may manage B's team (its team manager, B's club managers, admins)
 * sees a suggestion with what it would change (GET
 * /api/team/:id/roster-suggestions) and confirms it (the roster merged then,
 * the confirming manager the actor) or rejects it (POST
 * /api/team/:id/roster-suggestions/:sid { decision }). Nobody else sees or
 * decides it. Made-up clubs and people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'

const A1 = 'VBC Musterdorf D2'
const B1 = 'VC Beispielstadt D1'
const dayPlus = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const player = (number, first, last, dob) => ({ number, first_name: first, last_name: last, dob, libero: '', is_captain: false, is_lfp: false })

describe('roster suggestions for another club\'s team (PERM-04)', { skip: SKIP }, () => {
  let db, srv, sql, clubA, clubB, teamA, teamB
  let ipSeq = 1
  const users = {}
  const today = zurichDay()
  const PASSWORD = 'correct-horse-battery'

  async function account (name, roles) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const write = (user, action, params) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action, params } })
  const list = (user) => call(user, 'GET', `/api/team/${teamB}/roster-suggestions`)
  const decide = (user, id, decision) => call(user, 'POST', `/api/team/${teamB}/roster-suggestions/${id}`, { decision })
  const squadB = async () => (await call(users.ManagerB, 'GET', `/api/team/${teamB}/squad`)).json.data.squad

  /** Club A's scorer: an official A-home match against B, the coin toss with both rosters, then the close. */
  async function playAndClose (gameN, awayPlayers) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const ins = await write(users.ScorerA, 'insert', {
      data: { external_id: ext, status: 'setup', game_n: gameN, home_team: { name: A1 }, away_team: { name: B1 } }, returning: 'id', single: true
    })
    assert.equal(ins.status, 200, ins.text)
    const toss = await write(users.ScorerA, 'update', {
      data: { status: 'live', players_home: [player(5, 'Heim', 'Muster', '970101')], players_away: awayPlayers, bench_home: [], bench_away: [{ role: 'Coach', first_name: 'Falscher', last_name: 'Trainer', dob: '971997' }] },
      filters: [{ type: 'eq', column: 'external_id', value: ext }]
    })
    assert.equal(toss.status, 200, toss.text)
    for (const status of ['approved', 'final']) {
      const w = await write(users.ScorerA, 'update', { data: { status }, filters: [{ type: 'eq', column: 'external_id', value: ext }] })
      assert.equal(w.status, 200, w.text)
    }
    return ins.json.data.id
  }
  const suggestionOf = (matchId) => waitUntil(async () => {
    const { rows: [r] } = await sql.query('SELECT id, status FROM public.roster_suggestions WHERE match_id = $1', [matchId])
    return r || null
  }, { what: 'the suggestion', timeoutMs: 20000 })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_SAVE_BACK_TEST_MS: '300' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime) VALUES
      ('962001', $1, $2, '4L Damen', 'f', '${dayPlus(today, -1)}T18:00:00'),
      ('962002', $1, $2, '4L Damen', 'f', '${today}T10:00:00')`, [A1, B1])
    const admin = await account('Admin', ['admin'])
    await account('ScorerA', ['scorer'])
    await account('ManagerB')
    await account('TeamB')
    await account('ManagerC')
    clubA = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: [A1] })).json.data.club
    clubB = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VC Beispielstadt', teams: [B1] })).json.data.club
    const clubC = (await call(admin, 'POST', '/api/admin/clubs', { name: 'SC Drittort', teams: ['SC Drittort D1'] })).json.data.club
    assert.equal((await call(admin, 'PUT', `/api/admin/accounts/${users.ScorerA.id}/clubs`, { club_ids: [clubA.id] })).status, 200)
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2), ($3, $4)', [clubB.id, users.ManagerB.id, clubC.id, users.ManagerC.id])
    teamA = (await sql.query('SELECT id FROM public.club_teams WHERE club_id = $1', [clubA.id])).rows[0].id
    teamB = (await sql.query('SELECT id FROM public.club_teams WHERE club_id = $1', [clubB.id])).rows[0].id
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [teamB, users.TeamB.id])
    // club B's own saved team
    const put = await call(users.ManagerB, 'PUT', `/api/team/${teamB}/squad`, {
      players: [{ number: 1, first_name: 'Gina', last_name: 'Gast', license_number: '970201', active: true }, { number: 2, first_name: 'Hanna', last_name: 'Heim', license_number: '970202', active: true }],
      staff: []
    })
    assert.equal(put.status, 200, put.text)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  let first
  it('the close: club B unchanged, a suggestion for B\'s team', async () => {
    const m = await playAndClose(962001, [player(2, 'Gina', 'Gast', '970201'), player(3, 'Erfunden', 'Niemand', '971999')])
    first = await suggestionOf(m)
    assert.equal(first.status, 'open')
    const sq = await squadB()
    assert.deepEqual(sq.players.map((x) => [x.last_name, x.number]), [['Gast', 1], ['Heim', 2]])
    assert.deepEqual(sq.staff, [])
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [clubB.id])).rows[0].n, 0)
  })

  it('the team\'s managers see it with what it would change; nobody else does', async () => {
    for (const who of ['TeamB', 'ManagerB', 'Admin']) {
      const r = await list(users[who])
      assert.equal(r.status, 200, `${who}: ${r.text}`)
      const [s] = r.json.data.suggestions
      assert.equal(s.id, first.id, who)
      assert.equal(s.game_number, '962001')
      assert.deepEqual(s.players.map((x) => [x.number, x.last_name, x.known]), [[2, 'Gast', true], [3, 'Niemand', false]])
      assert.deepEqual(s.staff.map((x) => [x.role, x.last_name, x.known]), [['Coach', 'Trainer', false]])
      assert.equal(s.changed, true)
    }
    for (const who of ['ScorerA', 'ManagerC']) {
      assert.equal((await list(users[who])).status, 403, who)
      assert.equal((await decide(users[who], first.id, 'confirm')).status, 403, who)
    }
    // another team's path does not reach it
    assert.equal((await call(users.Admin, 'POST', `/api/team/${teamA}/roster-suggestions/${first.id}`, { decision: 'confirm' })).status, 404)
    assert.equal((await decide(users.TeamB, first.id, 'maybe')).status, 400)
  })

  it('the team manager confirms: the roster joins B\'s saved team and lists, the manager the actor', async () => {
    const r = await decide(users.TeamB, first.id, 'confirm')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.suggestion.status, 'confirmed')
    assert.equal(r.json.data.result.changed, true)
    const sq = await squadB()
    // the latest match of the team: its numbers win (Gina takes 2, Hanna loses it)
    assert.deepEqual(Object.fromEntries(sq.players.map((x) => [x.last_name, x.number])), { Gast: 2, Heim: null, Niemand: 3 })
    assert.deepEqual(sq.staff.map((x) => [x.role, x.last_name]), [['Coach', 'Trainer']])
    const { rows } = await sql.query('SELECT sv_number, source, imported_by FROM public.club_licences WHERE club_id = $1 ORDER BY sv_number', [clubB.id])
    assert.deepEqual(rows.map((x) => [x.sv_number, x.source, x.imported_by]), [['970201', 'match', users.TeamB.id], ['971997', 'match', users.TeamB.id], ['971999', 'match', users.TeamB.id]])
    const { rows: audit } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'team.squad.suggestion' AND details ->> 'event' = 'confirmed'")
    assert.deepEqual(audit.map((a) => a.actor_id), [users.TeamB.id])
    assert.ok(!JSON.stringify(audit).match(/Niemand|971999/))
    // decided once
    const twice = await decide(users.ManagerB, first.id, 'reject')
    assert.equal(twice.status, 409)
    assert.equal(twice.json.error.code, 'OV_SUGGESTION_DECIDED')
    assert.deepEqual((await list(users.TeamB)).json.data.suggestions, [])
  })

  it('the club manager rejects the next one: nothing changes', async () => {
    const before = await squadB()
    const m = await playAndClose(962002, [player(9, 'Noch', 'Jemand', '971990')])
    const s = await suggestionOf(m)
    const r = await decide(users.ManagerB, s.id, 'reject')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.suggestion.status, 'rejected')
    assert.deepEqual((await squadB()).players, before.players)
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.club_licences WHERE sv_number = '971990'")).rows[0].n, 0)
  })
})
