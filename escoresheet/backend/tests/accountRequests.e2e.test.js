/**
 * Sign-up requests and who approves them (db/025, lib/accountRequests.js,
 * docs/account-approval-spec.md section 8): the public clubs list of the
 * sign-up form, what a sign-up may ask for, that nothing is granted then, and
 * every approver path (admin, a club's managers, a team's managers), with the
 * cascades and the audit.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('sign-up requests and their approval', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  let must, msh, mustH1, mustD2, mshH1

  const ip = () => `198.51.100.${ipSeq++}`
  async function signIn (email, from) {
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': from }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    return inn
  }
  /** A new account; `requests` go in the sign-up body as the manager's form sends them. */
  async function account (name, { roles = null, requests, app } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const from = ip()
    const up = await api(srv.base, '/api/auth/sign-up', {
      headers: { 'cf-connecting-ip': from },
      body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Beispiel' }, ...(app ? { app } : {}), ...(requests ? { requests } : {}) }
    })
    if (up.status !== 200) return { up, email }
    const inn = await signIn(email, from)
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, up }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const me = async (u) => (await call(u, 'GET', '/api/me')).json.data
  const rolesOf = async (u) => (await sql.query('SELECT roles FROM public.profiles WHERE user_id = $1', [u.id])).rows[0]?.roles ?? []
  const count = async (q, params) => (await sql.query(q, params)).rows[0].n
  const partOf = (parts, kind, extra = {}) => parts.find((p) => p.kind === kind && Object.entries(extra).every(([k, v]) => p[k] === v))
  const pendingList = async () => (await call(users.admin, 'GET', '/api/admin/accounts?filter=pending&app=indoor')).json.data.accounts

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    // an admin's reject deletes the account's files too: a storage of its own
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-req-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-req-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
    })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, datetime) VALUES
      ('950001', 'VBC Musterdorf H1', 'VBC Mustershausen H1', '2L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '2026-11-20T18:00:00'),
      ('950002', 'VBC Mustershausen H1', 'VBC Musterdorf D2', '3L Damen', 'f', 'Halle Mustershausen', 'Bern', 5, '2026-11-21T18:00:00')`)
    const admin = await account('admin', { roles: ['admin'] })
    await account('clubmgr')
    await account('mshmgr')
    await account('coach')
    await account('scorer', { roles: ['scorer'] })
    await account('cm', { roles: ['competition_manager'] })
    must = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1', 'VBC Musterdorf D2'] })).json.data.club
    msh = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Mustershausen', teams: ['VBC Mustershausen H1'] })).json.data.club
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${must.id}/managers`, { emails: [users.clubmgr.email] })).status, 200)
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${msh.id}/managers`, { emails: [users.mshmgr.email] })).status, 200)
    const teamsOf = async (club) => (await call(admin, 'GET', `/api/club/${club.id}/teams`)).json.data.teams
    const mt = await teamsOf(must)
    mustH1 = mt.find((t) => t.name === 'VBC Musterdorf H1')
    mustD2 = mt.find((t) => t.name === 'VBC Musterdorf D2')
    mshH1 = (await teamsOf(msh))[0]
    // the coach manages VBC Musterdorf H1 (as after a team link)
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [mustH1.id, users.coach.id])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the public clubs list: club and team ids and names, nothing else, cached, per-IP limited', async () => {
    const r = await api(srv.base, '/api/public/clubs', { method: 'GET', proto: null, headers: { 'cf-connecting-ip': '203.0.113.50' } })
    assert.equal(r.status, 200, r.text)
    assert.match(r.headers.get('cache-control') || '', /public/)
    assert.deepEqual(r.json.data.clubs, [
      { id: must.id, name: 'VBC Musterdorf', teams: [{ id: mustD2.id, name: 'VBC Musterdorf D2' }, { id: mustH1.id, name: 'VBC Musterdorf H1' }] },
      { id: msh.id, name: 'VBC Mustershausen', teams: [{ id: mshH1.id, name: 'VBC Mustershausen H1' }] }
    ])
    // no address, no manager, no count
    assert.doesNotMatch(r.text, /@|manager|scorers|contact/)
    let last
    for (let i = 0; i < 31; i++) last = await api(srv.base, '/api/public/clubs', { method: 'GET', proto: null, headers: { 'cf-connecting-ip': '203.0.113.51' } })
    assert.equal(last.status, 429)
  })

  it('a sign-up asks only for what it may: refused requests create no account', async () => {
    const bad = [
      [{ kind: 'competition_manager' }],
      [{ kind: 'referee', club_id: must.id }],
      [{ kind: 'scorer' }],
      [{ kind: 'scorer', club_id: must.id, team_id: mustH1.id }],
      [{ kind: 'team_manager', club_id: must.id }],
      [{ kind: 'team_manager', team_id: mshH1.id, club_id: must.id }],
      [{ kind: 'scorer', club_id: randomUUID() }],
      [{ kind: 'team_manager', team_id: randomUUID() }],
      'scorer'
    ]
    for (const requests of bad) {
      const r = await account('refused', { requests })
      assert.equal(r.up.status, 422, `${JSON.stringify(requests)}: ${r.up.text}`)
      assert.equal(r.up.json.error.code, 'validation_failed')
      assert.equal(await count('SELECT count(*)::int AS n FROM auth.users WHERE email = $1', [r.email]), 0)
    }
    // OpenBeach's sign-up asks for nothing (requests are OpenVolley's clubs)
    const beach = await account('beachy', { app: 'beach', requests: [{ kind: 'referee' }] })
    assert.equal(beach.up.status, 422, beach.up.text)
  })

  let anna, parts
  it('a sign-up with requests is granted nothing; /api/me lists them', async () => {
    anna = await account('anna', {
      requests: [
        { kind: 'scorer', club_id: must.id },
        { kind: 'scorer', club_id: msh.id },
        { kind: 'referee' },
        // the club of a team manager request is the team's (sent or not)
        { kind: 'team_manager', team_id: mustH1.id },
        { kind: 'club_manager', club_id: must.id },
        { kind: 'referee' }
      ]
    })
    assert.equal(anna.up.status, 200, anna.up.text)
    assert.deepEqual(await rolesOf(anna), [])
    assert.equal(await count('SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = $1', [anna.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.team_managers WHERE user_id = $1', [anna.id]), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.club_managers WHERE user_id = $1', [anna.id]), 0)
    const m = await me(anna)
    assert.equal(m.isPending, true)
    parts = m.requests
    assert.deepEqual(parts.map((p) => [p.kind, p.club_name, p.team_name]), [
      ['scorer', 'VBC Musterdorf', null],
      ['scorer', 'VBC Mustershausen', null],
      ['referee', null, null],
      ['team_manager', 'VBC Musterdorf', 'VBC Musterdorf H1'],
      ['club_manager', 'VBC Musterdorf', null]
    ])
    // the admin's Pending list shows it with its parts
    const row = (await pendingList()).find((a) => a.id === anna.id)
    assert.ok(row, 'anna is in the Pending list')
    assert.equal(row.pending, true)
    assert.equal(row.requests.length, 5)
    // never on /api/db
    const viaDb = await call(anna, 'POST', '/api/db', { table: 'account_requests', action: 'select' })
    assert.notEqual(viaDb.status, 200, viaDb.text)
  })

  it('each approver sees its own part only', async () => {
    const mine = await call(users.clubmgr, 'GET', `/api/club/${must.id}/requests`)
    assert.equal(mine.status, 200, mine.text)
    const entry = mine.json.data.requests.find((x) => x.user.id === anna.id)
    assert.equal(entry.user.email, anna.email)
    assert.equal(entry.user.name, 'anna Beispiel')
    assert.deepEqual(entry.parts.map((p) => p.kind), ['scorer', 'team_manager', 'club_manager'])
    assert.ok(entry.parts.every((p) => p.club_id === must.id))
    // another club's manager: its own club's part only, and not this club
    const other = await call(users.mshmgr, 'GET', `/api/club/${msh.id}/requests`)
    assert.deepEqual(other.json.data.requests.find((x) => x.user.id === anna.id).parts.map((p) => [p.kind, p.club_id]), [['scorer', msh.id]])
    assert.equal((await call(users.mshmgr, 'GET', `/api/club/${must.id}/requests`)).status, 403)
    // the team's manager: the team manager part of its team only
    const team = await call(users.coach, 'GET', `/api/team/${mustH1.id}/requests`)
    assert.equal(team.status, 200, team.text)
    assert.deepEqual(team.json.data.requests.find((x) => x.user.id === anna.id).parts.map((p) => [p.kind, p.team_id]), [['team_manager', mustH1.id]])
    assert.equal((await call(users.coach, 'GET', `/api/team/${mustD2.id}/requests`)).status, 403)
    assert.equal((await call(users.coach, 'GET', `/api/club/${must.id}/requests`)).status, 403)
    // a scorer and anonymous: nothing
    assert.equal((await call(users.scorer, 'GET', `/api/club/${must.id}/requests`)).status, 403)
    assert.equal((await call(users.scorer, 'GET', `/api/team/${mustH1.id}/requests`)).status, 403)
    assert.equal((await call(null, 'GET', `/api/club/${must.id}/requests`)).status, 401)
    assert.equal((await call(null, 'GET', `/api/team/${mustH1.id}/requests`)).status, 401)
  })

  it('a part outside the approver\'s scope is refused and nothing changes', async () => {
    const mustScorer = partOf(parts, 'scorer', { club_id: must.id })
    const referee = partOf(parts, 'referee')
    const clubMgr = partOf(parts, 'club_manager')
    // the other club's manager, through its own club's path
    let r = await call(users.mshmgr, 'POST', `/api/club/${msh.id}/requests/${anna.id}`, { approve: [{ id: mustScorer.id }] })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.error.code, 'OV_REQUEST_GONE')
    // ... and through this club's path
    assert.equal((await call(users.mshmgr, 'POST', `/api/club/${must.id}/requests/${anna.id}`, { approve: [{ id: mustScorer.id }] })).status, 403)
    // referee parts are the admin's
    r = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${anna.id}`, { approve: [{ id: referee.id }] })
    assert.equal(r.status, 409, r.text)
    // the team's manager decides team manager parts of its team only
    r = await call(users.coach, 'POST', `/api/team/${mustH1.id}/requests/${anna.id}`, { approve: [{ id: clubMgr.id }] })
    assert.equal(r.status, 409, r.text)
    assert.equal((await call(users.coach, 'POST', `/api/team/${mustD2.id}/requests/${anna.id}`, { approve: [{ id: clubMgr.id }] })).status, 403)
    // a scorer, a competition manager and anonymous never
    assert.equal((await call(users.scorer, 'POST', `/api/admin/accounts/${anna.id}/requests`, { approve: [{ id: referee.id }] })).status, 403)
    assert.equal((await call(users.cm, 'POST', `/api/admin/accounts/${anna.id}/requests`, { approve: [{ id: referee.id }] })).status, 403)
    assert.equal((await call(users.scorer, 'POST', `/api/club/${must.id}/requests/${anna.id}`, { approve: [{ id: mustScorer.id }] })).status, 403)
    assert.equal((await call(null, 'POST', `/api/admin/accounts/${anna.id}/requests`, { approve: [{ id: referee.id }] })).status, 401)
    assert.equal((await call(null, 'POST', `/api/club/${must.id}/requests/${anna.id}`, { approve: [{ id: mustScorer.id }] })).status, 401)
    // a bad body
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${anna.id}/requests`, {})).status, 400)
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${anna.id}/requests`, { approve: [{ id: referee.id }], reject: [referee.id] })).status, 400)
    assert.deepEqual(await rolesOf(anna), [])
    assert.equal((await me(anna)).requests.length, 5)
  })

  it('the team\'s manager approves the team part: the account manages the team and is no longer pending', async () => {
    const h1 = partOf(parts, 'team_manager')
    const r = await call(users.coach, 'POST', `/api/team/${mustH1.id}/requests/${anna.id}`, { approve: [{ id: h1.id }] })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.approved, 1)
    assert.deepEqual(r.json.data.requests, [])
    const m = await me(anna)
    assert.deepEqual(m.managedTeams.map((t) => [t.name, t.via]), [['VBC Musterdorf H1', 'team']])
    assert.deepEqual(m.roles, [])
    assert.equal(m.requests.length, 4)
    // approved once: not pending for the admin any more, but its open parts keep it in the list
    const row = (await pendingList()).find((a) => a.id === anna.id)
    assert.equal(row.pending, false)
    assert.deepEqual(row.managed_teams.map((t) => t.name), ['VBC Musterdorf H1'])
    assert.equal(row.requests.length, 4)
    // and a sign-up somebody approved is deleted, not rejected
    const rej = await call(users.admin, 'POST', `/api/admin/accounts/${anna.id}/reject`, { email: anna.email })
    assert.equal(rej.status, 409, rej.text)
    assert.equal(rej.json.error.code, 'OV_NOT_PENDING')
    // done meanwhile: a second decision of the same part
    const again = await call(users.coach, 'POST', `/api/team/${mustH1.id}/requests/${anna.id}`, { approve: [{ id: h1.id }] })
    assert.equal(again.status, 409, again.text)
  })

  it('the club\'s manager approves the scorer part and rejects the club manager part', async () => {
    const scorer = partOf(parts, 'scorer', { club_id: must.id })
    const clubMgr = partOf(parts, 'club_manager')
    const r = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${anna.id}`, { approve: [{ id: scorer.id }], reject: [clubMgr.id] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.json.data.approved, r.json.data.rejected, r.json.data.requests], [1, 1, []])
    assert.deepEqual(await rolesOf(anna), ['scorer'])
    const m = await me(anna)
    assert.equal(m.isPending, false)
    assert.deepEqual(m.clubs.map((c) => c.name), ['VBC Musterdorf'])
    assert.deepEqual(m.managedClubs, [])
    // what is left: the admin's referee part and the other club's scorer part
    assert.deepEqual(m.requests.map((p) => [p.kind, p.club_name]), [['scorer', 'VBC Mustershausen'], ['referee', null]])
    assert.equal(await count('SELECT count(*)::int AS n FROM public.club_managers WHERE user_id = $1', [anna.id]), 0)
  })

  it('the admin approves the rest as requested; the account leaves the Pending list', async () => {
    const left = (await me(anna)).requests
    const r = await call(users.admin, 'POST', `/api/admin/accounts/${anna.id}/requests`, { approve: left.map((p) => ({ id: p.id })) })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.approved, 2)
    assert.deepEqual((await rolesOf(anna)).sort(), ['referee', 'scorer'])
    const m = await me(anna)
    assert.deepEqual(m.requests, [])
    assert.deepEqual(m.clubs.map((c) => c.name), ['VBC Musterdorf', 'VBC Mustershausen'])
    assert.equal((await pendingList()).some((a) => a.id === anna.id), false)
  })

  it('every decision is audited: kind, ids, who decided, no names', async () => {
    const a = await call(users.admin, 'GET', '/api/admin/audit?action=account.request_approve')
    assert.equal(a.status, 200, a.text)
    const mineA = a.json.data.entries.filter((e) => e.target_email === anna.email)
    assert.deepEqual(mineA.map((e) => [e.details.kind, e.details.via]).sort(), [
      ['referee', 'admin'], ['scorer', 'admin'], ['scorer', 'club'], ['team_manager', 'team']
    ])
    const teamEntry = mineA.find((e) => e.details.kind === 'team_manager')
    assert.deepEqual(teamEntry.details, { kind: 'team_manager', club_id: must.id, team_id: mustH1.id, via: 'team' })
    const rej = await call(users.admin, 'GET', '/api/admin/audit?action=account.request_reject')
    const mineR = rej.json.data.entries.filter((e) => e.target_email === anna.email)
    assert.deepEqual(mineR.map((e) => e.details), [{ kind: 'club_manager', club_id: must.id, via: 'club' }])
    assert.doesNotMatch(JSON.stringify([...mineA, ...mineR].map((e) => e.details)), /anna|Beispiel|@/)
    // the role grants are in the log as an admin's are
    const roles = await call(users.admin, 'GET', '/api/admin/audit?action=account.roles')
    assert.ok(roles.json.data.entries.some((e) => e.target_email === anna.email && e.details.added.includes('referee')))
  })

  it('an admin may change a part\'s club or team before approving it', async () => {
    const ben = await account('ben', { requests: [{ kind: 'scorer', club_id: must.id }, { kind: 'team_manager', team_id: mustD2.id }, { kind: 'scorer', club_id: msh.id }, { kind: 'referee' }] })
    const p = (await me(ben)).requests
    const referee = partOf(p, 'referee')
    // a referee has no club; a scorer has no team
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${ben.id}/requests`, { approve: [{ id: referee.id, club_id: must.id }] })).status, 400)
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${ben.id}/requests`, { approve: [{ id: partOf(p, 'scorer', { club_id: must.id }).id, team_id: mustH1.id }] })).status, 400)
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${ben.id}/requests`, { approve: [{ id: partOf(p, 'team_manager').id, team_id: randomUUID() }] })).status, 404)
    const r = await call(users.admin, 'POST', `/api/admin/accounts/${ben.id}/requests`, {
      approve: [{ id: partOf(p, 'scorer', { club_id: must.id }).id, club_id: msh.id }, { id: partOf(p, 'team_manager').id, team_id: mshH1.id }],
      reject: [referee.id]
    })
    assert.equal(r.status, 200, r.text)
    const m = await me(ben)
    assert.deepEqual(m.clubs.map((c) => c.name), ['VBC Mustershausen'])
    assert.deepEqual(m.managedTeams.map((t) => t.name), ['VBC Mustershausen H1'])
    // the scorer part for VBC Mustershausen was answered by the change too
    assert.deepEqual(m.requests, [])
    const audit = (await call(users.admin, 'GET', '/api/admin/audit?action=account.request_approve')).json.data.entries.filter((e) => e.target_email === ben.email)
    assert.ok(audit.some((e) => e.details.kind === 'team_manager' && e.details.team_id === mshH1.id && e.details.club_id === msh.id && e.details.changed === true))
  })

  it('a club\'s manager moves a team part to another team of its own club only', async () => {
    const carla = await account('carla', { requests: [{ kind: 'team_manager', team_id: mustH1.id }, { kind: 'scorer', club_id: must.id }] })
    const p = (await me(carla)).requests
    const tm = partOf(p, 'team_manager')
    let r = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${carla.id}`, { approve: [{ id: tm.id, team_id: mshH1.id }] })
    assert.equal(r.status, 403, r.text)
    // nor another club for a scorer part
    r = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${carla.id}`, { approve: [{ id: partOf(p, 'scorer').id, club_id: msh.id }] })
    assert.equal(r.status, 403, r.text)
    // a team's manager approves its team as asked, never another
    r = await call(users.coach, 'POST', `/api/team/${mustH1.id}/requests/${carla.id}`, { approve: [{ id: tm.id, team_id: mustD2.id }] })
    assert.equal(r.status, 400, r.text)
    r = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${carla.id}`, { approve: [{ id: tm.id, team_id: mustD2.id }] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await me(carla)).managedTeams.map((t) => t.name), ['VBC Musterdorf D2'])
    assert.deepEqual(r.json.data.requests.map((x) => x.kind), ['scorer'])
  })

  it('an unconfirmed address gets nothing approved, but may be rejected', async () => {
    const dora = await account('dora', { requests: [{ kind: 'referee' }, { kind: 'scorer', club_id: must.id }] })
    await sql.query(`UPDATE auth.users SET email_confirmed_at = NULL,
                       raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"ov_email_confirmation": "link"}'::jsonb
                     WHERE id = $1`, [dora.id])
    const p = (await me(dora)).requests
    const r = await call(users.admin, 'POST', `/api/admin/accounts/${dora.id}/requests`, { approve: [{ id: partOf(p, 'referee').id }] })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.error.code, 'OV_EMAIL_UNCONFIRMED')
    const no = await call(users.clubmgr, 'POST', `/api/club/${must.id}/requests/${dora.id}`, { reject: [partOf(p, 'scorer').id] })
    assert.equal(no.status, 200, no.text)
    assert.deepEqual(await rolesOf(dora), [])
    assert.deepEqual((await me(dora)).requests.map((x) => x.kind), ['referee'])
  })

  it('requests go with their team, their club and their account', async () => {
    const tmp = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterstadt', teams: ['VBC Musterstadt H2'] })).json.data.club
    const tmpTeam = (await call(users.admin, 'GET', `/api/club/${tmp.id}/teams`)).json.data.teams[0]
    const emil = await account('emil', { requests: [{ kind: 'scorer', club_id: tmp.id }, { kind: 'team_manager', team_id: tmpTeam.id }, { kind: 'referee' }] })
    assert.equal((await me(emil)).requests.length, 3)
    // the team leaves the club: its part goes
    assert.equal((await call(users.admin, 'PATCH', `/api/admin/clubs/${tmp.id}`, { teams: [] })).status, 200)
    assert.deepEqual((await me(emil)).requests.map((x) => x.kind), ['scorer', 'referee'])
    // the club goes: its part goes
    assert.equal((await call(users.admin, 'DELETE', `/api/admin/clubs/${tmp.id}`)).status, 200)
    assert.deepEqual((await me(emil)).requests.map((x) => x.kind), ['referee'])
    // the account goes (a rejected sign-up): every part goes
    const rej = await call(users.admin, 'POST', `/api/admin/accounts/${emil.id}/reject`, { email: emil.email })
    assert.equal(rej.status, 200, rej.text)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.account_requests WHERE user_id = $1', [emil.id]), 0)
  })

  it('invite codes and team links still skip the approval', async () => {
    const fritz = await account('fritz', { requests: [{ kind: 'referee' }] })
    const inv = await call(users.clubmgr, 'POST', `/api/club/${must.id}/invites`, { label: 'Scorers', role: 'scorer' })
    assert.equal(inv.status, 201, inv.text)
    const red = await call(fritz, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.deepEqual(await rolesOf(fritz), ['scorer'])
    assert.deepEqual((await me(fritz)).clubs.map((c) => c.name), ['VBC Musterdorf'])
    // its own request stays for the admin
    assert.deepEqual((await me(fritz)).requests.map((x) => x.kind), ['referee'])
    const link = await call(users.clubmgr, 'POST', `/api/club/${must.id}/teams/${mustD2.id}/invites`, {})
    const gina = await account('gina')
    assert.equal((await call(gina, 'POST', '/api/account/redeem-invite', { code: link.json.data.code })).status, 200)
    assert.deepEqual((await me(gina)).managedTeams.map((t) => t.name), ['VBC Musterdorf D2'])
    // a team link account approved nobody needs: not pending for the admin, and deleted, not rejected
    assert.equal((await pendingList()).some((a) => a.id === gina.id), false)
  })

  it('the saved team editor\'s VolleyManager names: competition managers only', async () => {
    const r = await call(users.cm, 'GET', '/api/saved-teams/vm-teams')
    assert.equal(r.status, 200, r.text)
    const names = r.json.data.teams.map((t) => t.name)
    assert.ok(names.includes('VBC Musterdorf H1') && names.includes('VBC Mustershausen H1') && names.includes('VBC Musterdorf D2'))
    assert.equal(r.json.data.teams.find((t) => t.name === 'VBC Musterdorf H1').club_id, must.id)
    const filtered = await call(users.cm, 'GET', '/api/saved-teams/vm-teams?q=hausen')
    assert.deepEqual(filtered.json.data.teams.map((t) => t.name), ['VBC Mustershausen H1'])
    assert.equal((await call(users.admin, 'GET', '/api/saved-teams/vm-teams')).status, 200)
    assert.equal((await call(users.scorer, 'GET', '/api/saved-teams/vm-teams')).status, 403)
    assert.equal((await call(users.coach, 'GET', '/api/saved-teams/vm-teams')).status, 403)
    assert.equal((await call(null, 'GET', '/api/saved-teams/vm-teams')).status, 401)
  })
})
