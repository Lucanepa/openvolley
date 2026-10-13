/**
 * Scorers score the home games of their own club (db/018, lib/clubs.js,
 * docs/scorer-clubs-spec.md), end to end: the admin's clubs and
 * the switch, the database's refusal on every write path (/api/db insert,
 * upsert and update, /api/match/restore), what /api/me and the official-game
 * check tell the app, and invite codes that carry a club.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { teamList } from '../lib/clubs.js'

describe('clubs (unit)', () => {
  it('a club\'s team list: trimmed, one space, unique case-insensitively; invalid entries refuse the list', () => {
    assert.deepEqual(teamList(['  KSC  Wiedikon H1 ', 'ksc wiedikon h1', 'KSC Wiedikon D2']), ['KSC Wiedikon H1', 'KSC Wiedikon D2'])
    assert.deepEqual(teamList([]), [])
    assert.equal(teamList(['ok', '']), undefined)
    assert.equal(teamList(['ok', 7]), undefined)
    assert.equal(teamList('KSC'), undefined)
    assert.equal(teamList(Array.from({ length: 61 }, (_, i) => `T${i}`)), undefined)
  })
})

describe('clubs end to end', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
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
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const ext = () => `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  const insertMatch = (user, data) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'insert', params: { data: { external_id: ext(), status: 'live', scheduled_at: '2026-10-17T16:00:00Z', ...data }, returning: 'id,external_id', single: true } } })
  const upsertMatch = (user, data) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'upsert', params: { data, onConflict: 'external_id', returning: 'id', single: true } } })
  const updateMatch = (user, externalId, data) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'update', params: { data, filters: [{ type: 'eq', column: 'external_id', value: externalId }] } } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    // VolleyManager's schedule: home games of KSC Wiedikon and of another club
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('900001', 'KSC Wiedikon H1', 'VBC Other H1', '2L', '2026-10-17T16:00:00Z'),
      ('900002', 'VBC Other H1', 'KSC Wiedikon H1', '2L', '2026-10-24T16:00:00Z'),
      ('900004', 'KSC Wiedikon D2', 'VBC Other D1', '3L', '2026-10-18T14:00:00Z'),
      ('900005', 'KSC Wiedikon H1', 'VBC Third H1', '2L', '2026-10-31T16:00:00Z'),
      ('900006', 'KSC Wiedikon H1', 'VBC Third H2', '2L', '2026-11-07T16:00:00Z'),
      ('900007', 'KSC Wiedikon H1', 'VBC Third H3', '2L', '2026-11-14T16:00:00Z'),
      ('900008', 'KSC Wiedikon D2', 'VBC Third D1', '3L', '2026-11-15T14:00:00Z')`)
    await account('admin', ['admin'])
    await account('ksc', ['scorer'])
    await account('noclub', ['scorer'])
    await account('cm', ['competition_manager'])
    await account('beachy', ['beach:scorer'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  let ksc
  it('admins create clubs with their VolleyManager teams; a team plays for one club; others are refused', async () => {
    const made = await call(users.admin, 'POST', '/api/admin/clubs', { name: '  KSC  Wiedikon ', teams: ['KSC Wiedikon H1', 'ksc wiedikon h1', 'KSC Wiedikon D2'] })
    assert.equal(made.status, 201, made.text)
    ksc = made.json.data.club
    assert.equal(ksc.name, 'KSC Wiedikon')
    assert.deepEqual(ksc.teams, ['KSC Wiedikon D2', 'KSC Wiedikon H1'])
    assert.equal(ksc.scorers, 0)

    expectCode(await call(users.admin, 'POST', '/api/admin/clubs', { name: 'ksc wiedikon' }), 409, 'OV_CLUB_EXISTS')
    expectCode(await call(users.admin, 'POST', '/api/admin/clubs', { name: 'Other', teams: ['KSC WIEDIKON H1'] }), 409, 'OV_TEAM_TAKEN')
    const other = await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })
    assert.equal(other.status, 201, other.text)
    expectCode(await call(users.admin, 'POST', '/api/admin/clubs', { name: '' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.cm, 'POST', '/api/admin/clubs', { name: 'Nope' }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.ksc, 'GET', '/api/admin/clubs'), 403, 'OV_FORBIDDEN')

    const list = await call(users.admin, 'GET', '/api/admin/clubs')
    assert.equal(list.status, 200, list.text)
    assert.deepEqual(list.json.data.clubs.map((c) => c.name), ['KSC Wiedikon', 'VBC Other'])
    assert.equal(list.json.data.rule.enabled, false, 'off until an admin turns it on')

    const teams = await call(users.admin, 'GET', '/api/admin/club-teams?q=wiedikon')
    assert.equal(teams.status, 200, teams.text)
    assert.deepEqual(teams.json.data.teams.map((t) => [t.name, t.club_name]), [['KSC Wiedikon D2', 'KSC Wiedikon'], ['KSC Wiedikon H1', 'KSC Wiedikon']])
    const all = await call(users.admin, 'GET', '/api/admin/club-teams')
    assert.ok(all.json.data.teams.some((t) => t.name === 'VBC Third H1' && t.club_id === null), 'away teams too, without a club')
  })

  let earlier
  it('with the rule off nothing changes: a scorer without a club scores any official game', async () => {
    const r = await insertMatch(users.noclub, { game_n: 900005 })
    assert.equal(r.status, 200, r.text)
    earlier = r.json.data.external_id
  })

  it('the switch: admins only, audited', async () => {
    expectCode(await call(users.ksc, 'PUT', '/api/admin/club-rule', { enabled: true }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.admin, 'PUT', '/api/admin/club-rule', { enabled: 'yes' }), 400, 'OV_INVALID_REQUEST')
    const on = await call(users.admin, 'PUT', '/api/admin/club-rule', { enabled: true })
    assert.equal(on.status, 200, on.text)
    const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'club_rule.set'")
    assert.deepEqual(rows.map((r) => r.details.enabled), [true])
  })

  it('a scorer without a club scores no official game; test and beach matches still', async () => {
    expectCode(await insertMatch(users.noclub, { game_n: 900001 }), 403, 'OV_CLUB_REQUIRED')
    assert.equal((await insertMatch(users.noclub, { game_n: 900001, test: true })).status, 200)
    assert.equal((await insertMatch(users.noclub, { game_n: null })).status, 200, 'no game number: not official')
    // the match it scored before the rule went on goes on as it was
    const again = await updateMatch(users.noclub, earlier, { status: 'live', remarks: 'set 2' })
    assert.equal(again.status, 200, again.text)
  })

  it('an account gets its clubs from an admin (the whole list, audited); /api/me shows them', async () => {
    const set = await call(users.admin, 'PUT', `/api/admin/accounts/${users.ksc.id}/clubs`, { club_ids: [ksc.id] })
    assert.equal(set.status, 200, set.text)
    assert.deepEqual(set.json.data.clubs.map((c) => c.name), ['KSC Wiedikon'])
    expectCode(await call(users.admin, 'PUT', `/api/admin/accounts/${users.ksc.id}/clubs`, { club_ids: ['00000000-0000-4000-8000-000000000000'] }), 404, 'OV_CLUB_NOT_FOUND')
    expectCode(await call(users.ksc, 'PUT', `/api/admin/accounts/${users.ksc.id}/clubs`, { club_ids: [] }), 403, 'OV_FORBIDDEN')
    const { rows } = await sql.query("SELECT target_user_id, details FROM public.audit_log WHERE action = 'account.clubs'")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].target_user_id, users.ksc.id)
    assert.deepEqual(rows[0].details.names, ['KSC Wiedikon'])

    const me = await call(users.ksc, 'GET', '/api/me')
    assert.equal(me.status, 200, me.text)
    assert.equal(me.json.data.clubRule, true)
    assert.deepEqual(me.json.data.clubs.map((c) => [c.name, c.teams]), [['KSC Wiedikon', ['KSC Wiedikon D2', 'KSC Wiedikon H1']]])
    const listed = await call(users.admin, 'GET', '/api/admin/accounts?filter=all')
    assert.deepEqual(listed.json.data.accounts.find((a) => a.id === users.ksc.id).clubs.map((c) => c.name), ['KSC Wiedikon'])
  })

  it('the home games of its club only: away games and games VolleyManager does not know are refused', async () => {
    const home = await insertMatch(users.ksc, { game_n: 900001 })
    assert.equal(home.status, 200, home.text)
    assert.equal((await insertMatch(users.ksc, { game_n: 900004 })).status, 200, 'any team of the club')
    expectCode(await insertMatch(users.ksc, { game_n: 900002 }), 403, 'OV_NOT_YOUR_CLUB')
    expectCode(await insertMatch(users.ksc, { game_n: 900003 }), 403, 'OV_GAME_NOT_IN_SCHEDULE')
    const beach = await insertMatch(users.beachy, { game_n: 900002, sport_type: 'beach' })
    assert.equal(beach.status, 200, `beach is not checked: ${beach.text}`)

    // a resent upsert of its stored match passes; moving it to an away game does not
    const resent = await upsertMatch(users.ksc, { external_id: home.json.data.external_id, game_n: 900001, status: 'live' })
    assert.equal(resent.status, 200, resent.text)
    expectCode(await updateMatch(users.ksc, home.json.data.external_id, { game_n: 900002 }), 403, 'OV_NOT_YOUR_CLUB')
    // a test match made official later is checked then
    const t = await insertMatch(users.ksc, { game_n: 900002, test: true })
    assert.equal(t.status, 200, t.text)
    expectCode(await updateMatch(users.ksc, t.json.data.external_id, { test: false }), 403, 'OV_NOT_YOUR_CLUB')
  })

  it('the backup restore is checked as well', async () => {
    const e = ext()
    const away = await api(srv.base, '/api/match/restore', { token: users.ksc.token, body: { match: { external_id: e, game_n: 900002, status: 'live', sport_type: 'indoor', scheduled_at: '2026-10-24T16:00:00Z' }, sets: [], events: [] } })
    expectCode(away, 403, 'OV_NOT_YOUR_CLUB')
    const home = await api(srv.base, '/api/match/restore', { token: users.ksc.token, body: { match: { external_id: e, game_n: 900006, status: 'live', sport_type: 'indoor', scheduled_at: '2026-11-07T16:00:00Z' }, sets: [], events: [] } })
    assert.equal(home.status, 200, home.text)
  })

  it('admins score any game', async () => {
    assert.equal((await insertMatch(users.admin, { game_n: 900002 })).status, 200)
  })

  it('the official-game check tells the app before it starts', async () => {
    const check = (user, n) => call(user, 'POST', '/api/match/official-check', { game_n: n, sport_type: 'indoor' })
    const mine = await check(users.ksc, 900005)
    assert.equal(mine.status, 200, mine.text)
    assert.deepEqual(mine.json.data.club, { ok: true, home_team: 'KSC Wiedikon H1' })
    const away = await check(users.ksc, 900002)
    assert.deepEqual(away.json.data.club, { ok: false, code: 'OV_NOT_YOUR_CLUB', home_team: 'VBC Other H1', clubs: ['KSC Wiedikon'] })
    assert.equal((await check(users.ksc, 900003)).json.data.club.code, 'OV_GAME_NOT_IN_SCHEDULE')
    assert.equal((await check(users.noclub, 900001)).json.data.club.code, 'OV_CLUB_REQUIRED')
    assert.deepEqual((await check(users.admin, 900002)).json.data.club, { ok: true })
  })

  it('an invite code may carry a club: whoever redeems it joins it', async () => {
    const inv = await call(users.admin, 'POST', '/api/admin/invites', { label: 'KSC scorers 2026', club_id: ksc.id, max_uses: 5 })
    assert.equal(inv.status, 201, inv.text)
    assert.equal(inv.json.data.invite.club_id, ksc.id)
    assert.equal(inv.json.data.invite.club, 'KSC Wiedikon', 'the club column labels it')
    expectCode(await call(users.admin, 'POST', '/api/admin/invites', { label: 'x', club_id: '00000000-0000-4000-8000-000000000000' }), 404, 'OV_CLUB_NOT_FOUND')
    expectCode(await call(users.admin, 'POST', '/api/admin/invites?app=beach', { label: 'x', club_id: ksc.id }), 400, 'OV_INVALID_REQUEST')

    const fresh = await account('fresh', null)
    const redeemed = await call(fresh, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code })
    assert.equal(redeemed.status, 200, redeemed.text)
    const me = await call(fresh, 'GET', '/api/me')
    assert.deepEqual(me.json.data.clubs.map((c) => c.name), ['KSC Wiedikon'])
    assert.equal(me.json.data.canScore, true)
    const scored = await insertMatch(fresh, { game_n: 900007 })
    assert.equal(scored.status, 200, scored.text)
  })

  it('a deleted club takes its teams and memberships with it', async () => {
    const del = await call(users.admin, 'DELETE', `/api/admin/clubs/${ksc.id}`)
    assert.equal(del.status, 200, del.text)
    const me = await call(users.ksc, 'GET', '/api/me')
    assert.deepEqual(me.json.data.clubs, [])
    expectCode(await insertMatch(users.ksc, { game_n: 900008 }), 403, 'OV_CLUB_REQUIRED')
    expectCode(await call(users.admin, 'DELETE', `/api/admin/clubs/${ksc.id}`), 404, 'OV_NOT_FOUND')
  })
})
