/**
 * People added to a club's licence lists by hand (db/026, lib/licences.js
 * addPeople, docs/club-licences-spec.md section 8). Owner 2026-11-10: "if I
 * add somebody manually, when saving ask if I want to save him/her in the
 * club. Those from the club/recognized/linked -> green shield. Those added
 * manually -> gray shield, but can be linked later."
 *
 * Both routes (the team's and the club's), who may, the body rules, the
 * `manual` flag and counts of the reads, an upload that keeps the hand-added
 * rows and takes over those it contains, Delete list, and the audit (counts
 * only, never a name or a licence number).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

// made-up people of VBC Musterdorf (no real person)
const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const LEA = { sv_number: '100002', last_name: 'Muster', first_name: 'Lea', dob: '2006-01-31', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: null, gender: null }
const COACH = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f' }
const NAMES = ['Beispiel', 'Muster', 'Probe', 'Testmann', 'Trainer', 'Anders', 'Handmann', '100001', '100002', '100003', '100004', '200001', '100009']
const ZERO = '00000000-0000-4000-8000-000000000000'

describe('club licence lists: people added by hand', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  let musterdorf, other, h1, d1, otherH1

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
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
  const put = (user, clubId, list, people) => call(user, 'PUT', `/api/club/${clubId}/licences/${list}`, { people })
  const addForTeam = (user, teamId, people) => call(user, 'POST', `/api/team/${teamId}/club-people`, { people })
  const addForClub = (user, clubId, people) => call(user, 'POST', `/api/club/${clubId}/licences/people`, { people })
  const rowsOf = async (clubId) => (await sql.query(
    'SELECT list, sv_number, last_name, first_name, source, imported_by FROM public.club_licences WHERE club_id = $1 ORDER BY list, sv_number', [clubId])).rows
  const countOf = async (clubId) => (await sql.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [clubId])).rows[0].n

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    const admin = await account('admin', ['admin'])
    await account('clubmgr', null)
    await account('othermgr', null)
    await account('scorer', ['scorer'])
    await account('coach', null)
    await account('othercoach', null)
    await account('stranger', null)
    musterdorf = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1', 'VBC Musterdorf D1'] })).json.data.club
    other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })).json.data.club
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${musterdorf.id}/managers`, { emails: [users.clubmgr.email] })).status, 200)
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${other.id}/managers`, { emails: [users.othermgr.email] })).status, 200)
    await call(admin, 'PUT', `/api/admin/accounts/${users.scorer.id}/clubs`, { club_ids: [musterdorf.id] })
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    h1 = teams.find((t) => t.name === 'VBC Musterdorf H1')
    d1 = teams.find((t) => t.name === 'VBC Musterdorf D1')
    otherH1 = (await call(users.othermgr, 'GET', `/api/club/${other.id}/teams`)).json.data.teams[0]
    // the coach manages H1 only, the other coach VBC Other H1 (team links)
    for (const [mgr, clubId, teamId, coach] of [[users.clubmgr, musterdorf.id, h1.id, users.coach], [users.othermgr, other.id, otherH1.id, users.othercoach]]) {
      const link = await call(mgr, 'POST', `/api/club/${clubId}/teams/${teamId}/invites`, { max_uses: 1 })
      assert.equal(link.status, 201, link.text)
      assert.equal((await call(coach, 'POST', '/api/account/redeem-invite', { code: link.json.data.code })).status, 200)
    }
    // the club's uploads: Anna and Lea players, Tina a coach
    assert.equal((await put(users.clubmgr, musterdorf.id, 'players', [ANNA, LEA])).status, 200)
    assert.equal((await put(users.clubmgr, musterdorf.id, 'coaches', [COACH])).status, 200)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('a team manager adds people typed in by hand to its club; a licence number already there is left as it is', async () => {
    const r = await addForTeam(users.coach, h1.id, [
      { list: 'players', ...MARCO },
      { list: 'coaches', ...NOAH },
      // already in the uploaded players list: not overwritten
      { list: 'players', ...ANNA, last_name: 'Anders' }
    ])
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { club_id: musterdorf.id, added: 2, already: 1 })
    const rows = await rowsOf(musterdorf.id)
    assert.deepEqual(rows.map((x) => `${x.list}:${x.sv_number}:${x.last_name}:${x.source}`), [
      'coaches:100004:Testmann:manual', 'coaches:200001:Trainer:import',
      'players:100001:Beispiel:import', 'players:100002:Muster:import', 'players:100003:Probe:manual'
    ])
    assert.equal(rows.find((x) => x.sv_number === '100003').imported_by, users.coach.id)
    assert.equal(rows.find((x) => x.sv_number === '100001').imported_by, users.clubmgr.id)
    // again: everything is there already
    const again = await addForTeam(users.coach, h1.id, [{ list: 'players', ...MARCO, first_name: 'Marc' }])
    assert.equal(again.status, 200, again.text)
    assert.deepEqual(again.json.data, { club_id: musterdorf.id, added: 0, already: 1 })
    assert.equal((await rowsOf(musterdorf.id)).find((x) => x.sv_number === '100003').first_name, 'Marco')
  })

  it('the club\'s managers and admins add by hand too, to any of the three lists', async () => {
    const r = await addForClub(users.clubmgr, musterdorf.id, [{ list: 'scorers', ...NOAH }, { list: 'coaches', ...LEA }])
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { club_id: musterdorf.id, added: 2, already: 0 })
    const a = await addForClub(users.admin, musterdorf.id, [{ list: 'players', sv_number: '100009', last_name: 'Handmann', first_name: null, dob: null, gender: null }])
    assert.deepEqual(a.json.data, { club_id: musterdorf.id, added: 1, already: 0 })
    // the club's manager acts for each of its teams
    const t = await addForTeam(users.clubmgr, d1.id, [{ list: 'players', ...LEA }])
    assert.deepEqual(t.json.data, { club_id: musterdorf.id, added: 0, already: 1 })
  })

  it('the reads flag the people added by hand (manual) and count them per list', async () => {
    const r = await call(users.coach, 'GET', `/api/team/${h1.id}/club-players`)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.players.map((p) => [p.sv_number, p.manual]), [['100001', false], ['100009', true], ['100002', false], ['100003', true]])
    assert.deepEqual(r.json.data.players.find((p) => p.sv_number === '100003'), { ...MARCO, manual: true })
    // a person of an uploaded list is not manual, whatever else was added by hand (Lea: players uploaded, coaches by hand)
    assert.deepEqual(r.json.data.people.map((p) => [p.sv_number, p.lists, p.manual]), [
      ['100001', ['players'], false], ['100009', ['players'], true], ['100002', ['players', 'coaches'], false],
      ['100003', ['players'], true], ['100004', ['scorers', 'coaches'], true], ['200001', ['coaches'], false]
    ])
    const c = await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/licences`)
    assert.equal(c.status, 200, c.text)
    const { lists } = c.json.data
    assert.deepEqual([lists.players.count, lists.players.manual], [4, 2])
    assert.deepEqual([lists.coaches.count, lists.coaches.manual], [3, 2])
    // a list with nothing uploaded: no upload time, no uploader
    assert.deepEqual(lists.scorers, { count: 1, manual: 1, imported_at: null, imported_by_name: null })
    // the upload's time and uploader, not the hand-added rows'
    assert.equal(lists.players.imported_by_name, 'clubmgr Test')
    assert.equal(lists.coaches.imported_by_name, 'clubmgr Test')
    const { rows: [up] } = await sql.query("SELECT max(imported_at) AS at FROM public.club_licences WHERE club_id = $1 AND list = 'players' AND source = 'import'", [musterdorf.id])
    assert.equal(lists.players.imported_at, up.at.toISOString())
    assert.equal(c.json.data.people.find((p) => p.sv_number === '100003').manual, true)
    // the scoring tablet's copy has the flag too
    const s = await call(users.scorer, 'GET', '/api/club-licences')
    assert.equal(s.status, 200, s.text)
    const club = s.json.data.clubs[0]
    assert.deepEqual(club.players.filter((p) => p.manual).map((p) => p.sv_number), ['100009', '100003'])
    assert.deepEqual(club.people.filter((p) => p.manual).map((p) => p.sv_number), ['100009', '100003', '100004'])
  })

  it('who may: whoever may manage the team, the club\'s managers and admins; nobody else', async () => {
    const before = await countOf(musterdorf.id)
    const one = [{ list: 'players', ...MARCO, sv_number: '100099' }]
    assert.equal((await addForTeam(null, h1.id, one)).status, 401)
    assert.equal((await addForClub(null, musterdorf.id, one)).status, 401)
    // another team of the club, another club's team manager, an account with nothing
    assert.equal((await addForTeam(users.coach, d1.id, one)).status, 403)
    assert.equal((await addForTeam(users.othercoach, h1.id, one)).status, 403)
    assert.equal((await addForTeam(users.stranger, h1.id, one)).status, 403)
    assert.equal((await addForTeam(users.scorer, h1.id, one)).status, 403)
    // the club's route is the club managers' only
    assert.equal((await addForClub(users.coach, musterdorf.id, one)).status, 403)
    assert.equal((await addForClub(users.othermgr, musterdorf.id, one)).status, 403)
    assert.equal((await addForClub(users.scorer, musterdorf.id, one)).status, 403)
    // no such team or club
    assert.equal((await addForTeam(users.admin, ZERO, one)).status, 404)
    assert.equal((await addForClub(users.admin, ZERO, one)).status, 404)
    // the team's route of another club adds to that club, never to this one
    const o = await addForTeam(users.othercoach, otherH1.id, one)
    assert.equal(o.status, 200, o.text)
    assert.equal(o.json.data.club_id, other.id)
    assert.equal(await countOf(musterdorf.id), before)
    assert.equal(await countOf(other.id), 1)
    // GET is not a route here
    assert.equal((await call(users.coach, 'GET', `/api/team/${h1.id}/club-people`)).status, 405)
  })

  it('refuses a bad body: the list and the five fields only, 1 to 30 people', async () => {
    const before = await countOf(musterdorf.id)
    const bad = async (body, re) => {
      const r = await call(users.coach, 'POST', `/api/team/${h1.id}/club-people`, body)
      assert.equal(r.status, 400, r.text)
      assert.equal(r.json.error.code, 'OV_INVALID_REQUEST')
      if (re) assert.match(r.json.error.details, re)
    }
    const p = { list: 'players', sv_number: '100050', last_name: 'Neu' }
    await bad({}, /people/)
    await bad({ people: [] }, /people/)
    await bad({ people: p }, /people/)
    await bad({ people: [p], team_id: h1.id }, /team_id: not accepted/)
    await bad({ people: [{ ...p, email: 'neu@example.ch' }] }, /email: not accepted/)
    await bad({ people: [{ ...p, license_number: '100050' }] }, /license_number: not accepted/)
    await bad({ people: [{ ...p, list: 'referees' }] }, /list/)
    await bad({ people: [{ sv_number: '100050', last_name: 'Neu' }] }, /list/)
    await bad({ people: [{ ...p, sv_number: '12' }] }, /sv_number/)
    await bad({ people: [{ ...p, sv_number: undefined }] }, /sv_number/)
    await bad({ people: [{ ...p, last_name: ' ' }] }, /last_name/)
    await bad({ people: [{ ...p, dob: '06.05.2004' }] }, /dob/)
    await bad({ people: [{ ...p, gender: 'x' }] }, /gender/)
    await bad({ people: ['100050'] }, /must be an object/)
    // at most 30 per request (one bad entry refuses the whole batch)
    const many = (n, base) => Array.from({ length: n }, (_, i) => ({ list: 'scorers', sv_number: String(base + i), last_name: `Hand${i}` }))
    await bad({ people: many(31, 300000) }, /at most 30/)
    await bad({ people: [...many(29, 300000), { ...p, gender: 'x' }] }, /people\[29\]\.gender/)
    // the club's route has the same rules
    const r = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/licences/people`, { people: [{ ...p, phone: '000' }] })
    assert.equal(r.status, 400, r.text)
    assert.equal(await countOf(musterdorf.id), before)
    // exactly 30 is fine; a licence number twice in one list is one person
    const ok30 = await addForClub(users.clubmgr, musterdorf.id, many(30, 300000))
    assert.equal(ok30.status, 200, ok30.text)
    assert.deepEqual(ok30.json.data, { club_id: musterdorf.id, added: 30, already: 0 })
    const twice = await addForTeam(users.coach, h1.id, [p, { ...p, first_name: 'Nina' }, { ...p, list: 'coaches' }])
    assert.deepEqual(twice.json.data, { club_id: musterdorf.id, added: 2, already: 0 })
    const { rows } = await sql.query("SELECT list, first_name FROM public.club_licences WHERE club_id = $1 AND sv_number = '100050' ORDER BY list", [musterdorf.id])
    assert.deepEqual(rows.map((x) => [x.list, x.first_name]), [['coaches', null], ['players', 'Nina']])
    await sql.query("DELETE FROM public.club_licences WHERE club_id = $1 AND (list = 'scorers' AND sv_number LIKE '30%' OR sv_number = '100050')", [musterdorf.id])
  })

  it('an upload keeps the people added by hand, and takes over those it contains; Delete list removes both', async () => {
    // the players upload: Anna, and Marco (added by hand) with VolleyManager's spelling; Lea left the list
    const r = await put(users.clubmgr, musterdorf.id, 'players', [ANNA, { ...MARCO, last_name: 'Probe-VM' }])
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.count, 2)
    assert.equal(r.json.data.manual, 1)
    const rows = await rowsOf(musterdorf.id)
    assert.deepEqual(rows.filter((x) => x.list === 'players').map((x) => `${x.sv_number}:${x.last_name}:${x.source}`), [
      '100001:Beispiel:import', '100003:Probe-VM:import', '100009:Handmann:manual'
    ])
    // Marco is linked now: the upload's fields, uploaded by the club manager
    assert.equal(rows.find((x) => x.list === 'players' && x.sv_number === '100003').imported_by, users.clubmgr.id)
    // the other lists are untouched (Lea and Noah by hand in coaches, Tina uploaded)
    assert.deepEqual(rows.filter((x) => x.list === 'coaches').map((x) => `${x.sv_number}:${x.source}`), ['100002:manual', '100004:manual', '200001:import'])
    const read = await call(users.coach, 'GET', `/api/team/${h1.id}/club-players`)
    assert.deepEqual(read.json.data.players.map((p) => [p.sv_number, p.last_name, p.manual]), [
      ['100001', 'Beispiel', false], ['100009', 'Handmann', true], ['100003', 'Probe-VM', false]
    ])
    // Lea now only by hand (coaches): manual
    assert.deepEqual(read.json.data.people.find((p) => p.sv_number === '100002'), { ...LEA, manual: true, lists: ['coaches'] })
    const c = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/licences`)).json.data
    assert.deepEqual([c.lists.players.count, c.lists.players.manual], [3, 1])
    // a hand-added row is never taken back to manual by adding it again
    const again = await addForTeam(users.coach, h1.id, [{ list: 'players', ...MARCO }])
    assert.deepEqual(again.json.data, { club_id: musterdorf.id, added: 0, already: 1 })
    assert.equal((await rowsOf(musterdorf.id)).find((x) => x.list === 'players' && x.sv_number === '100003').source, 'import')
    // Delete list (an empty upload): every row of the list, the hand-added ones too
    const del = await put(users.clubmgr, musterdorf.id, 'coaches', [])
    assert.equal(del.status, 200, del.text)
    assert.deepEqual([del.json.data.count, del.json.data.manual], [0, 0])
    assert.deepEqual((await rowsOf(musterdorf.id)).filter((x) => x.list === 'coaches'), [])
    assert.deepEqual((await rowsOf(musterdorf.id)).map((x) => x.list).filter((l, i, a) => a.indexOf(l) === i), ['players', 'scorers'])
  })

  it('the audit keeps the club, the team and the counts per list, never a name or a licence number', async () => {
    const { rows } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'club.licences.manual' ORDER BY at, id")
    // the batches that added someone (not those where everyone was there already)
    assert.equal(rows.length, 6)
    for (const r of rows) {
      assert.deepEqual(Object.keys(r.details).sort(), ['added', 'club_id', 'lists', 'team_id'])
      const text = JSON.stringify(r.details)
      for (const name of NAMES) assert.ok(!text.includes(name), name)
    }
    assert.deepEqual(rows[0].details, { club_id: musterdorf.id, team_id: h1.id, added: 2, lists: { players: 1, coaches: 1 } })
    assert.equal(rows[0].actor_id, users.coach.id)
    assert.deepEqual(rows[1].details, { club_id: musterdorf.id, team_id: null, added: 2, lists: { scorers: 1, coaches: 1 } })
    assert.equal(rows[1].actor_id, users.clubmgr.id)
    assert.deepEqual(rows.map((r) => r.details.added), [2, 2, 1, 1, 30, 2])
    const list = await call(users.admin, 'GET', '/api/admin/audit?action=club.licences.manual')
    assert.equal(list.status, 200, list.text)
    assert.equal(list.json.data.entries.length, 6)
  })

  it('the hand-added rows go with the club (ON DELETE CASCADE)', async () => {
    assert.ok(await countOf(other.id) > 0)
    assert.equal((await call(users.admin, 'DELETE', `/api/admin/clubs/${other.id}`)).status, 200)
    assert.equal(await countOf(other.id), 0)
    assert.equal((await addForClub(users.admin, other.id, [{ list: 'players', ...ANNA }])).status, 404)
  })
})
