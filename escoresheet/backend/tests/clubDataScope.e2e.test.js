/**
 * Saved teams and club licence lists: only what each role needs (owner
 * decisions 1 and 2), audited deletes with the name typed, the first squad
 * save under a lock, and the bounds of the rows added by hand (db/037).
 *
 *   1. a scorer reads the saved teams of its own matches this season only
 *      (its clubs' teams, their home opponents, the games of its matches);
 *      competition managers and admins read them all;
 *   2. deleting a competition or a team with content needs its name, and the
 *      deletes and roster replacements are audited;
 *   3. two first saves of a team's squad at once make one competition and one
 *      saved team;
 *   4. a team manager gets the club's players of its team's gender and age
 *      class, dates of birth only of the people of its saved team (filled in
 *      on save), and finds an official by name (a few rows);
 *   5. a scorer's download has no dates of birth; the tablet asks for those
 *      of the people it adds, of its own clubs only;
 *   6. a licence number of another list is never added by hand, `manual` is
 *      per list, the rows by hand are bounded per club and per account a day,
 *      and a club manager deletes one of them;
 *   7. a list of a past season is neither served nor kept.
 *
 * All people are made up. Needs PG_TEST_URL (see tests/helpers/pgTestDb.js)
 * or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'
import { seasonOf } from '../lib/officialGame.js'
import { seasonLabel } from '../lib/teams.js'
import { createLicences, MAX_MANUAL_PER_CLUB, MAX_MANUAL_PER_DAY, MAX_SEARCH_RESULTS } from '../lib/licences.js'

const dayPlus = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const YEAR = seasonOf(new Date())
const SEASON = seasonLabel(YEAR)
const PAST = seasonLabel(YEAR - 1)
// the club's lists (made-up people): an under-16 girl, a woman, a boy, a girl without a date of birth, a coach
const ALICE = { sv_number: '110001', last_name: 'Aebi', first_name: 'Alice', dob: `${YEAR - 14}-03-04`, gender: 'f' }
const BEA = { sv_number: '110002', last_name: 'Brunner', first_name: 'Bea', dob: '1990-01-01', gender: 'f' }
const CARL = { sv_number: '110003', last_name: 'Caduff', first_name: 'Carl', dob: `${YEAR - 15}-05-05`, gender: 'm' }
const DORA = { sv_number: '110004', last_name: 'Dubach', first_name: 'Dora', dob: null, gender: 'f' }
const COACHY = { sv_number: '210001', last_name: 'Coachmann', first_name: 'Ueli', dob: '1975-07-07', gender: 'm' }
const helpers = Array.from({ length: 12 }, (_, i) => ({ sv_number: String(220001 + i), last_name: `Muster${String.fromCharCode(97 + i)}`, first_name: 'Helfer', dob: '1980-01-01', gender: null }))
const player = (number, p, extra = {}) => ({ number, first_name: p.first_name, last_name: p.last_name, dob: p.dob, license_number: p.sv_number, ...extra })

describe('club data: only what each role needs', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  const today = zurichDay()
  const clubs = {}
  const teams = {}
  const saved = {}

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `203.0.113.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
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
  const teamLink = async (clubId, teamId, coach) => {
    const link = await call(users.admin, 'POST', `/api/club/${clubId}/teams/${teamId}/invites`, { max_uses: 1 })
    assert.equal(link.status, 201, link.text)
    assert.equal((await call(coach, 'POST', '/api/account/redeem-invite', { code: link.json.data.code })).status, 200)
  }
  const savedTeam = async (competitionId, name, p) => {
    const t = await call(users.cm, 'POST', '/api/saved-teams/teams', { competition_id: competitionId, name, svrz_team_name: name })
    assert.equal(t.status, 201, t.text)
    const r = await call(users.cm, 'PUT', `/api/saved-teams/teams/${t.json.data.team.id}/roster`, { players: [player(7, p)], staff: [] })
    assert.equal(r.status, 200, r.text)
    return t.json.data.team.id
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    // this season's schedule: Alpha H1 at home against Beta H1, away at Gamma H1;
    // Alpha's under-16 girls at home; Delta plays nobody of these
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, datetime) VALUES
      ('960001', 'VBC Alpha H1', 'VBC Beta H1', '2L Herren', 'men', 'Halle A', 'Alpha', 5, '${dayPlus(today, 2)}T18:00:00'),
      ('960002', 'VBC Gamma H1', 'VBC Alpha H1', '2L Herren', 'men', 'Halle G', 'Gamma', 5, '${dayPlus(today, 9)}T20:00:00'),
      ('960003', 'VBC Alpha U16', 'VBC Beta U16', 'U16 Juniorinnen', 'women', 'Halle A', 'Alpha', 3, '${dayPlus(today, 3)}T14:00:00'),
      ('960004', 'VBC Delta H1', 'VBC Epsilon H1', '2L Herren', 'men', 'Halle D', 'Delta', 5, '${dayPlus(today, 4)}T18:00:00')`)
    const admin = await account('admin', ['admin'])
    await account('cm', ['competition_manager'])
    await account('scorerA', ['scorer'])
    await account('scorerNone', ['scorer'])
    await account('clubmgrA', null)
    await account('clubmgrB', null)
    await account('coachU16', null)
    await account('coachH1', null)
    for (const [name, list] of [['Alpha', ['VBC Alpha H1', 'VBC Alpha U16']], ['Beta', ['VBC Beta H1', 'VBC Beta U16']], ['Gamma', ['VBC Gamma H1']], ['Delta', ['VBC Delta H1']]]) {
      const c = await call(admin, 'POST', '/api/admin/clubs', { name: `VBC ${name}`, teams: list })
      assert.equal(c.status, 201, c.text)
      clubs[name] = c.json.data.club
    }
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2), ($3, $4)', [clubs.Alpha.id, users.clubmgrA.id, clubs.Beta.id, users.clubmgrB.id])
    assert.equal((await call(admin, 'PUT', `/api/admin/accounts/${users.scorerA.id}/clubs`, { club_ids: [clubs.Alpha.id] })).status, 200)
    for (const t of (await call(admin, 'GET', `/api/club/${clubs.Alpha.id}/teams`)).json.data.teams) teams[t.name] = t
    await teamLink(clubs.Alpha.id, teams['VBC Alpha U16'].id, users.coachU16)
    await teamLink(clubs.Alpha.id, teams['VBC Alpha H1'].id, users.coachH1)
    // the club's lists
    assert.equal((await call(users.clubmgrA, 'PUT', `/api/club/${clubs.Alpha.id}/licences/players`, { people: [ALICE, BEA, CARL, DORA] })).status, 200)
    assert.equal((await call(users.clubmgrA, 'PUT', `/api/club/${clubs.Alpha.id}/licences/coaches`, { people: [COACHY, ...helpers] })).status, 200)
    // the competition manager's saved teams: this season's league, an archived
    // competition of this season and last season's
    const comp = await call(users.cm, 'POST', '/api/saved-teams/competitions', { name: '2L Herren', season: SEASON, vm_leagues: ['2L Herren'] })
    assert.equal(comp.status, 201, comp.text)
    saved.comp = comp.json.data.competition.id
    for (const [name, p] of [['VBC Alpha H1', CARL], ['VBC Beta H1', BEA], ['VBC Gamma H1', ALICE], ['VBC Delta H1', DORA]]) saved[name] = await savedTeam(saved.comp, name, p)
    const archived = await call(users.cm, 'POST', '/api/saved-teams/competitions', { name: 'Cup', season: SEASON })
    saved.archivedComp = archived.json.data.competition.id
    saved.archivedTeam = await savedTeam(saved.archivedComp, 'VBC Beta H1', BEA)
    assert.equal((await call(users.cm, 'PATCH', `/api/saved-teams/competitions/${saved.archivedComp}`, { archived: true })).status, 200)
    const past = await call(users.cm, 'POST', '/api/saved-teams/competitions', { name: '2L Herren', season: PAST })
    saved.pastComp = past.json.data.competition.id
    saved.pastTeam = await savedTeam(saved.pastComp, 'VBC Alpha H1', CARL)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  describe('1. saved teams (be-clubs-teams-2)', () => {
    it('a scorer reads the teams of its club and their home opponents of this season only', async () => {
      const r = await call(users.scorerA, 'GET', '/api/saved-teams')
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.json.data.teams.map((t) => t.id).sort(), [saved['VBC Alpha H1'], saved['VBC Beta H1']].sort())
      // never Gamma (Alpha plays there away), Delta, an archived or a past competition
      assert.deepEqual(r.json.data.competitions.map((c) => c.id), [saved.comp])
      assert.equal(r.json.data.teams.find((t) => t.id === saved['VBC Beta H1']).players[0].dob, BEA.dob)
      // the same with ?sport=all
      const all = await call(users.scorerA, 'GET', '/api/saved-teams?sport=all')
      assert.deepEqual(all.json.data.teams.map((t) => t.id).sort(), [saved['VBC Alpha H1'], saved['VBC Beta H1']].sort())
    })

    it('a scorer without a club reads nothing, then the teams of the official game of its own match', async () => {
      const none = await call(users.scorerNone, 'GET', '/api/saved-teams')
      assert.equal(none.status, 200, none.text)
      assert.deepEqual([none.json.data.teams, none.json.data.competitions], [[], []])
      await sql.query("INSERT INTO public.matches (external_id, game_n, created_by, test) VALUES ('scope-own-1', 960001, $1, false)", [users.scorerNone.id])
      const own = await call(users.scorerNone, 'GET', '/api/saved-teams')
      assert.deepEqual(own.json.data.teams.map((t) => t.id).sort(), [saved['VBC Alpha H1'], saved['VBC Beta H1']].sort())
      // a test match counts for nothing
      await sql.query("UPDATE public.matches SET test = true WHERE external_id = 'scope-own-1'")
      assert.deepEqual((await call(users.scorerNone, 'GET', '/api/saved-teams')).json.data.teams, [])
      await sql.query("UPDATE public.matches SET test = false WHERE external_id = 'scope-own-1'")
    })

    it('changing its match\'s game number does not walk through the league: near games only, a few a week, audited', async () => {
      const teamsNow = async () => (await call(users.scorerNone, 'GET', '/api/saved-teams')).json.data.teams.map((t) => t.id).sort()
      const setGame = (n) => sql.query("UPDATE public.matches SET game_n = $1 WHERE external_id = 'scope-own-1'", [n])
      // a game far ahead gives nothing (and uses up nothing)
      await setGame(960002)
      assert.deepEqual(await teamsNow(), [])
      // five more near games, then a sixth near one whose teams have saved teams
      for (let i = 0; i < 5; i++) {
        await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime)
          VALUES ($1, 'VBC Filler A', 'VBC Filler B', '2L Herren', 'men', $2)`, [String(970001 + i), `${dayPlus(today, 1)}T18:00:00`])
        await setGame(970001 + i)
        assert.deepEqual(await teamsNow(), [])
      }
      await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime)
        VALUES ('970010', 'VBC Gamma H1', 'VBC Delta H1', '2L Herren', 'men', $1)`, [`${dayPlus(today, 1)}T20:00:00`])
      await setGame(970010)
      assert.deepEqual(await teamsNow(), [])
      // a game given before still is
      await setGame(960001)
      assert.deepEqual(await teamsNow(), [saved['VBC Alpha H1'], saved['VBC Beta H1']].sort())
      const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'saved_teams.scope' AND actor_id = $1", [users.scorerNone.id])
      assert.deepEqual(rows.flatMap((r) => r.details.games).sort(), ['960001', '970001', '970002', '970003', '970004', '970005'])
    })

    it('competition managers and admins read every team, archived and past ones too', async () => {
      for (const u of [users.cm, users.admin]) {
        const r = await call(u, 'GET', '/api/saved-teams')
        assert.equal(r.status, 200, r.text)
        const ids = r.json.data.teams.map((t) => t.id)
        for (const id of [saved['VBC Alpha H1'], saved['VBC Beta H1'], saved['VBC Gamma H1'], saved['VBC Delta H1'], saved.archivedTeam, saved.pastTeam]) assert.ok(ids.includes(id), id)
        assert.ok(r.json.data.competitions.some((c) => c.id === saved.pastComp))
      }
    })
  })

  describe('2. deletes and roster replacements (fe-manage-2)', () => {
    it('a competition with teams goes only with its name typed, audited with the counts', async () => {
      const del = (confirm) => call(users.cm, 'DELETE', `/api/saved-teams/competitions/${saved.pastComp}${confirm == null ? '' : `?confirm=${encodeURIComponent(confirm)}`}`)
      const no = await del(null)
      assert.equal(no.status, 400, no.text)
      assert.equal(no.json.error.code, 'OV_CONFIRM_NAME')
      assert.equal((await del('Another')).json.error.code, 'OV_CONFIRM_NAME')
      assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.competition_teams WHERE competition_id = $1', [saved.pastComp])).rows[0].n, 1)
      assert.equal((await del(' 2l herren ')).status, 200)
      const { rows } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'saved_teams.competition_delete'")
      assert.equal(rows.length, 1)
      assert.equal(rows[0].actor_id, users.cm.id)
      assert.deepEqual(rows[0].details, { competition_id: saved.pastComp, name: '2L Herren', season: PAST, teams: 1, players: 1, staff: 0 })
      // an empty one goes without
      const empty = await call(users.cm, 'POST', '/api/saved-teams/competitions', { name: 'Empty', season: SEASON })
      assert.equal((await call(users.cm, 'DELETE', `/api/saved-teams/competitions/${empty.json.data.competition.id}`)).status, 200)
    })

    it('a team with people goes only with its name typed; a roster replacement is audited too', async () => {
      const put = await call(users.cm, 'PUT', `/api/saved-teams/teams/${saved.archivedTeam}/roster`, { players: [player(1, BEA), player(2, ALICE)], staff: [] })
      assert.equal(put.status, 200, put.text)
      const { rows: [r] } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'saved_teams.roster' AND details->>'team_id' = $1 ORDER BY at DESC LIMIT 1", [saved.archivedTeam])
      assert.equal(r.actor_id, users.cm.id)
      assert.deepEqual(r.details, { team_id: saved.archivedTeam, competition_id: saved.archivedComp, name: 'VBC Beta H1', before: { players: 1, staff: 0 }, players: 2, staff: 0 })
      assert.ok(!JSON.stringify(r.details).includes('Brunner'))
      assert.equal((await call(users.cm, 'DELETE', `/api/saved-teams/teams/${saved.archivedTeam}`)).json.error.code, 'OV_CONFIRM_NAME')
      assert.equal((await call(users.cm, 'DELETE', `/api/saved-teams/teams/${saved.archivedTeam}?confirm=VBC%20Beta%20H1`)).status, 200)
      const { rows: [d] } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'saved_teams.team_delete'")
      assert.deepEqual(d.details, { team_id: saved.archivedTeam, competition_id: saved.archivedComp, name: 'VBC Beta H1', players: 2, staff: 0 })
    })
  })

  describe('3. the first squad save (be-races-4)', () => {
    it('two first saves of each of ten teams at once: one competition of the league, one saved team each', async () => {
      const names = Array.from({ length: 10 }, (_, i) => `VBC Zeta D${i + 1}`)
      const day = dayPlus(today, 6)
      await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime)
        SELECT '97' || lpad(i::text, 4, '0'), n, 'VBC Other D1', '3L Damen Zeta', 'women', $2 || 'T18:00:00'
          FROM unnest($1::text[]) WITH ORDINALITY AS x(n, i)`, [names, day])
      const zeta = await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Zeta', teams: names })
      assert.equal(zeta.status, 201, zeta.text)
      const zt = (await call(users.admin, 'GET', `/api/club/${zeta.json.data.club.id}/teams`)).json.data.teams
      const body = (n) => ({ players: [{ number: n, first_name: 'Erika', last_name: `Spielerin${n}` }], staff: [] })
      const answers = await Promise.all(zt.flatMap((t) => [call(users.admin, 'PUT', `/api/team/${t.id}/squad`, body(1)), call(users.admin, 'PUT', `/api/team/${t.id}/squad`, body(2))]))
      assert.deepEqual(answers.map((a) => a.status), answers.map(() => 200), answers.map((a) => a.text).join('\n'))
      const { rows: comps } = await sql.query("SELECT count(*)::int AS n FROM public.competitions WHERE season = $1 AND '3L Damen Zeta' = ANY(vm_leagues)", [SEASON])
      assert.equal(comps[0].n, 1)
      const { rows: per } = await sql.query('SELECT svrz_team_name, count(*)::int AS n FROM public.competition_teams WHERE svrz_team_name = ANY($1::text[]) GROUP BY 1', [names])
      assert.equal(per.length, 10)
      assert.ok(per.every((x) => x.n === 1), JSON.stringify(per))
    })
  })

  describe('4. a team manager (be-clubs-teams-6, fe-manage-3)', () => {
    it('gets the club\'s players of its team\'s gender and age class, without dates of birth', async () => {
      const r = await call(users.coachU16, 'GET', `/api/team/${teams['VBC Alpha U16'].id}/club-players`)
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.gender, 'f')
      assert.equal(r.json.data.age_class, 'U16')
      // the girls born late enough, and the one without a date of birth: never Bea (adult) or Carl (a boy)
      assert.deepEqual(r.json.data.players.map((p) => p.sv_number), [ALICE.sv_number, DORA.sv_number])
      assert.ok(r.json.data.players.every((p) => p.dob === null))
      assert.deepEqual(r.json.data.people.map((p) => p.sv_number), [ALICE.sv_number, DORA.sv_number])
      // the adult men's team: the men (Carl), no age class
      const h = await call(users.coachH1, 'GET', `/api/team/${teams['VBC Alpha H1'].id}/club-players`)
      assert.equal(h.json.data.age_class, null)
      assert.deepEqual(h.json.data.players.map((p) => p.sv_number), [CARL.sv_number])
    })

    it('finds an official by name: a few rows, no dates of birth', async () => {
      const path = (q) => `/api/team/${teams['VBC Alpha U16'].id}/club-people?q=${encodeURIComponent(q)}`
      const r = await call(users.coachU16, 'GET', path('coachm'))
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.json.data.people.map((p) => [p.sv_number, p.lists, p.dob]), [[COACHY.sv_number, ['coaches'], null]])
      assert.equal(r.json.data.more, false)
      // by licence number, and Bea of the players list (an official may be anyone of the club)
      assert.deepEqual((await call(users.coachU16, 'GET', path(BEA.sv_number))).json.data.people.map((p) => p.last_name), ['Brunner'])
      const many = await call(users.coachU16, 'GET', path('MUSTER'))
      assert.equal(many.json.data.people.length, MAX_SEARCH_RESULTS)
      assert.equal(many.json.data.more, true)
      assert.equal((await call(users.coachU16, 'GET', path('ab'))).status, 400)
      assert.equal((await call(users.coachH1, 'GET', `/api/team/${teams['VBC Alpha U16'].id}/club-people?q=coachm`)).status, 403)
    })

    it('a person saved into the squad or a game roster gets the club\'s date of birth', async () => {
      const id = teams['VBC Alpha U16'].id
      const put = await call(users.coachU16, 'PUT', `/api/team/${id}/squad`, {
        players: [player(4, { ...ALICE, dob: null }), player(5, DORA)],
        staff: [{ role: 'Coach', first_name: COACHY.first_name, last_name: COACHY.last_name, license_number: COACHY.sv_number }]
      })
      assert.equal(put.status, 200, put.text)
      assert.deepEqual(put.json.data.squad.players.map((p) => [p.license_number, p.dob]), [[ALICE.sv_number, ALICE.dob], [DORA.sv_number, null]])
      // an official is not of the team's players: no date of birth from the lists
      assert.equal(put.json.data.squad.staff[0].dob, null)
      // now in the saved team: their dates of birth are read
      const r = await call(users.coachU16, 'GET', `/api/team/${id}/club-players`)
      assert.equal(r.json.data.players.find((p) => p.sv_number === ALICE.sv_number).dob, ALICE.dob)
      assert.equal(r.json.data.people.find((p) => p.sv_number === COACHY.sv_number).dob, null)
      assert.equal((await call(users.coachU16, 'GET', `/api/team/${id}/club-people?q=coachm`)).json.data.people[0].dob, null)
      // a game roster the same way
      const roster = await call(users.coachH1, 'PUT', `/api/team/${teams['VBC Alpha H1'].id}/roster?game=960001`, { players: [player(9, { ...CARL, dob: null })], staff: [] })
      assert.equal(roster.status, 200, roster.text)
      assert.equal(roster.json.data.roster.players[0].dob, CARL.dob)
    })
  })

  describe('4b. a squad does not reveal people outside the team', () => {
    it('someone of another age class or gender put into the squad gets no date of birth; the audit names the licence numbers', async () => {
      const id = teams['VBC Alpha U16'].id
      const put = await call(users.coachU16, 'PUT', `/api/team/${id}/squad`, {
        players: [player(4, { ...ALICE, dob: null }), player(6, { ...BEA, dob: null })],
        staff: [{ role: 'Coach', first_name: CARL.first_name, last_name: CARL.last_name, license_number: CARL.sv_number }]
      })
      assert.equal(put.status, 200, put.text)
      assert.deepEqual(put.json.data.squad.players.map((p) => [p.license_number, p.dob]), [[ALICE.sv_number, ALICE.dob], [BEA.sv_number, null]])
      assert.equal(put.json.data.squad.staff[0].dob, null)
      const r = await call(users.coachU16, 'GET', `/api/team/${id}/club-players`)
      assert.equal(r.json.data.people.find((p) => p.sv_number === BEA.sv_number).dob, null)
      assert.equal(r.json.data.people.find((p) => p.sv_number === CARL.sv_number).dob, null)
      assert.equal((await call(users.coachU16, 'GET', `/api/team/${id}/club-people?q=brunner`)).json.data.people[0].dob, null)
      const { rows: [a] } = await sql.query(
        "SELECT details FROM public.audit_log WHERE action = 'team.squad' AND details ->> 'team_id' = $1 ORDER BY id DESC LIMIT 1", [id])
      assert.deepEqual([a.details.added.sort(), a.details.removed.sort()], [[BEA.sv_number, CARL.sv_number].sort(), [COACHY.sv_number, DORA.sv_number].sort()])
    })
  })

  describe('5. a scorer (delta-be-managers-5)', () => {
    it('downloads its clubs\' lists without dates of birth, and asks for those of the people it adds', async () => {
      const r = await call(users.scorerA, 'GET', '/api/club-licences')
      assert.equal(r.status, 200, r.text)
      const c = r.json.data.clubs.find((x) => x.club_id === clubs.Alpha.id)
      assert.ok(c.players.length >= 4 && c.people.length >= 5)
      assert.ok([...c.players, ...c.people].every((p) => p.dob === null))
      const ask = (clubId, sv) => call(users.scorerA, 'GET', `/api/club-licences/dob?club=${clubId}&sv=${sv}`)
      const d = await ask(clubs.Alpha.id, [ALICE.sv_number, DORA.sv_number, COACHY.sv_number, '999999'].join(','))
      assert.equal(d.status, 200, d.text)
      assert.deepEqual(d.json.data, { club_id: clubs.Alpha.id, people: [{ sv_number: ALICE.sv_number, dob: ALICE.dob }, { sv_number: COACHY.sv_number, dob: COACHY.dob }] })
      // never another club's, never more than a roster's
      assert.equal((await ask(clubs.Beta.id, ALICE.sv_number)).status, 404)
      assert.equal((await ask(clubs.Alpha.id, Array.from({ length: 31 }, (_, i) => String(500000 + i)).join(','))).status, 400)
      assert.equal((await ask(clubs.Alpha.id, 'abc')).status, 400)
      assert.equal((await call(users.coachU16, 'GET', `/api/club-licences/dob?club=${clubs.Alpha.id}&sv=${ALICE.sv_number}`)).status, 403)
      assert.equal((await call(null, 'GET', `/api/club-licences/dob?club=${clubs.Alpha.id}&sv=${ALICE.sv_number}`)).status, 401)
    })

    it('cannot read the whole lists in chunks: so many dates of birth a day, each lookup audited', async () => {
      const all = [ALICE, BEA, CARL, COACHY, ...helpers].map((p) => p.sv_number).join(',')
      let got = 0
      let last
      for (let i = 0; i < 10; i++) {
        last = await call(users.scorerA, 'GET', `/api/club-licences/dob?club=${clubs.Alpha.id}&sv=${all}`)
        if (last.status !== 200) break
        got += last.json.data.people.length
      }
      assert.equal(last.status, 429, last.text)
      assert.equal(last.json.error.code, 'OV_DOB_LIMIT')
      assert.ok(got <= 80, String(got))
      const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'club.licences.dob' AND actor_id = $1", [users.scorerA.id])
      assert.equal(rows.reduce((n, r) => n + r.details.count, 0), got + 2)
      assert.ok(rows.every((r) => r.details.club_id === clubs.Alpha.id && Object.keys(r.details).length === 2))
    })
  })

  describe('6. rows added by hand (delta-fe-manage-2, delta-be-managers-4)', () => {
    const add = (user, people) => call(user, 'POST', `/api/team/${teams['VBC Alpha H1'].id}/club-people`, { people })
    const people = async () => (await call(users.clubmgrA, 'GET', `/api/club/${clubs.Alpha.id}/licences`)).json.data.people

    it('a licence number of another list is never added by hand; nothing passes for that person', async () => {
      const r = await add(users.coachH1, [{ list: 'players', sv_number: COACHY.sv_number, last_name: 'Erfunden', first_name: 'Nemo', dob: '2000-02-02', gender: 'm' }])
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.json.data, { club_id: clubs.Alpha.id, added: 0, already: 1 })
      const p = (await people()).find((x) => x.sv_number === COACHY.sv_number)
      assert.deepEqual([p.last_name, p.lists, p.manual], ['Coachmann', ['coaches'], false])
    })

    it('a row of before planted by hand under a coach\'s number: manual in its list, the upload\'s fields first', async () => {
      await sql.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob, gender, source)
        VALUES ($1, 'players', $2, 'Erfunden', 'Nemo', '2000-02-02', 'm', 'manual')`, [clubs.Alpha.id, COACHY.sv_number])
      const s = (await call(users.scorerA, 'GET', '/api/club-licences')).json.data.clubs.find((x) => x.club_id === clubs.Alpha.id)
      assert.deepEqual(s.players.find((x) => x.sv_number === COACHY.sv_number), { sv_number: COACHY.sv_number, last_name: 'Erfunden', first_name: 'Nemo', dob: null, gender: 'm', manual: true })
      const p = s.people.find((x) => x.sv_number === COACHY.sv_number)
      assert.deepEqual([p.last_name, p.first_name, p.lists, p.manual], ['Coachmann', 'Ueli', ['players', 'coaches'], false])
      const c = (await people()).find((x) => x.sv_number === COACHY.sv_number)
      assert.equal(c.dob, COACHY.dob)
      assert.deepEqual(c.hand_rows.map((h) => h.list), ['players'])
    })

    it('a person keeps its page id across uploads', async () => {
      const before = (await people()).find((x) => x.sv_number === ALICE.sv_number)
      assert.ok(before.id && before.row_ids.includes(before.id))
      assert.equal((await call(users.clubmgrA, 'PUT', `/api/club/${clubs.Alpha.id}/licences/players`, { people: [ALICE, BEA, CARL, DORA] })).status, 200)
      assert.equal((await people()).find((x) => x.sv_number === ALICE.sv_number).id, before.id)
    })

    it('a club manager deletes one row added by hand, never an imported one; audited without a name', async () => {
      const c = (await people()).find((x) => x.sv_number === COACHY.sv_number)
      const row = c.hand_rows[0].id
      const del = (user, id) => call(user, 'DELETE', `/api/club/${clubs.Alpha.id}/licences/rows/${id}`)
      assert.equal((await del(users.coachH1, row)).status, 403)
      assert.equal((await del(users.clubmgrB, row)).status, 403)
      const { rows: [imported] } = await sql.query("SELECT id FROM public.club_licences WHERE club_id = $1 AND list = 'coaches' AND sv_number = $2", [clubs.Alpha.id, COACHY.sv_number])
      const no = await del(users.clubmgrA, imported.id)
      assert.equal(no.status, 409, no.text)
      assert.equal(no.json.error.code, 'OV_NOT_HAND_ADDED')
      const ok = await del(users.clubmgrA, row)
      assert.equal(ok.status, 200, ok.text)
      assert.deepEqual(ok.json.data, { deleted: true, list: 'players' })
      assert.equal((await del(users.clubmgrA, row)).status, 404)
      assert.deepEqual((await people()).find((x) => x.sv_number === COACHY.sv_number).lists, ['coaches'])
      const { rows: [a] } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'club.licences.manual_delete'")
      assert.equal(a.actor_id, users.clubmgrA.id)
      assert.deepEqual(a.details, { club_id: clubs.Alpha.id, list: 'players' })
    })

    it('at most so many rows by hand per club, and per account a day', async () => {
      const one = [{ list: 'scorers', sv_number: '480000', last_name: 'Neu' }]
      // the club is full
      await sql.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source)
        SELECT $1, 'scorers', (400000 + i)::text, 'Hand', 'manual' FROM generate_series(1, $2::int) i`, [clubs.Alpha.id, MAX_MANUAL_PER_CLUB])
      const full = await add(users.coachH1, one)
      assert.equal(full.status, 409, full.text)
      assert.equal(full.json.error.code, 'OV_MANUAL_LIMIT')
      await sql.query("DELETE FROM public.club_licences WHERE club_id = $1 AND sv_number LIKE '4%' AND last_name = 'Hand'", [clubs.Alpha.id])
      // this account added its day's share (in another club too)
      await sql.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source, imported_by)
        SELECT $1, 'scorers', (400000 + i)::text, 'Hand', 'manual', $3 FROM generate_series(1, $2::int) i`, [clubs.Beta.id, MAX_MANUAL_PER_DAY, users.coachH1.id])
      const day = await add(users.coachH1, one)
      assert.equal(day.status, 409, day.text)
      assert.equal(day.json.error.code, 'OV_MANUAL_LIMIT')
      // another account of the club still adds
      assert.deepEqual((await call(users.clubmgrA, 'POST', `/api/club/${clubs.Alpha.id}/licences/people`, { people: one })).json.data, { club_id: clubs.Alpha.id, added: 1, already: 0 })
      // a day later the account adds again
      await sql.query("UPDATE public.club_licences SET imported_at = now() - interval '25 hours' WHERE imported_by = $1", [users.coachH1.id])
      assert.equal((await add(users.coachH1, [{ list: 'scorers', sv_number: '480001', last_name: 'Neu' }])).json.data.added, 1)
      await sql.query("DELETE FROM public.club_licences WHERE sv_number LIKE '4%' AND last_name IN ('Hand', 'Neu')")
    })
  })

  describe('7. seasons (be-clubs-teams-10)', () => {
    it('a row of a past season is not served, blocks nothing, and the sweep deletes it', async () => {
      await sql.query('UPDATE public.club_licences SET season = $3 WHERE club_id = $1 AND sv_number = $2', [clubs.Alpha.id, BEA.sv_number, YEAR - 1])
      const c = (await call(users.clubmgrA, 'GET', `/api/club/${clubs.Alpha.id}/licences`)).json.data
      assert.equal(c.people.some((p) => p.sv_number === BEA.sv_number), false)
      assert.equal(c.lists.players.count, 3)
      const s = (await call(users.scorerA, 'GET', '/api/club-licences')).json.data.clubs.find((x) => x.club_id === clubs.Alpha.id)
      assert.equal(s.people.some((p) => p.sv_number === BEA.sv_number), false)
      // the men's team takes her now (no gender check from last season's list)
      assert.equal((await call(users.coachH1, 'PUT', `/api/team/${teams['VBC Alpha H1'].id}/roster?game=960001`, { players: [player(1, CARL), player(2, BEA)], staff: [] })).status, 200)
      // the daily sweep
      const pool = new pg.Pool({ connectionString: db.url })
      try {
        const lic = createLicences({ pool, audit: async () => {}, logger: quietLogger() })
        assert.equal(await lic.sweep(), 1)
        assert.equal(await lic.sweep(), 0)
      } finally {
        await pool.end()
      }
      assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1 AND sv_number = $2', [clubs.Alpha.id, BEA.sv_number])).rows[0].n, 0)
    })

    it('an upload or a row by hand removes the club\'s past seasons first', async () => {
      await sql.query("UPDATE public.club_licences SET season = $2 WHERE club_id = $1 AND list = 'players' AND sv_number = $3", [clubs.Alpha.id, YEAR - 1, CARL.sv_number])
      const r = await call(users.coachH1, 'POST', `/api/team/${teams['VBC Alpha H1'].id}/club-people`, { people: [{ list: 'players', ...CARL, last_name: 'Caduff-Neu' }] })
      assert.deepEqual(r.json.data, { club_id: clubs.Alpha.id, added: 1, already: 0 })
      const { rows } = await sql.query("SELECT season, source, last_name FROM public.club_licences WHERE club_id = $1 AND list = 'players' AND sv_number = $2", [clubs.Alpha.id, CARL.sv_number])
      assert.deepEqual(rows, [{ season: YEAR, source: 'manual', last_name: 'Caduff-Neu' }])
    })
  })
})
