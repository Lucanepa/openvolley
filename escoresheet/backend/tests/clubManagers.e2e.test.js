/**
 * Club managers (db/020, lib/clubs.js, ~/ov-ops/club-manager-home-email-PLAN.md
 * step 2), end to end: admins name a club's managers; a manager sees and runs
 * its own club only (contact address, members, invite codes within limits);
 * taking someone off a club removes the club link only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { CLUB_INVITE_MAX_DAYS, clubInviteBody, contactEmail } from '../lib/clubs.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('club managers (unit)', () => {
  it('a contact address: trimmed and lower-case; empty clears it; anything else is refused', () => {
    assert.equal(contactEmail('  Info@VBC-Musterdorf.ch '), 'info@vbc-musterdorf.ch')
    assert.equal(contactEmail(''), null)
    assert.equal(contactEmail(null), null)
    assert.equal(contactEmail('no-at-sign'), undefined)
    assert.equal(contactEmail('a@b'), undefined)
    assert.equal(contactEmail(7), undefined)
  })

  it('an invite code body within a club manager\'s limits', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    const d = clubInviteBody({ label: 'H1' }, now)
    assert.equal(d.body.role, 'scorer')
    assert.equal(d.body.max_uses, 1)
    assert.equal(d.body.expires_at, new Date(now + 30 * DAY_MS).toISOString())
    assert.equal(clubInviteBody({ label: 'x', role: 'referee', max_uses: 50 }, now).body.max_uses, 50)
    assert.match(clubInviteBody({ label: 'x', role: 'competition_manager' }, now).error, /role/)
    assert.match(clubInviteBody({ label: 'x', role: 'admin' }, now).error, /role/)
    assert.match(clubInviteBody({ label: 'x', max_uses: 51 }, now).error, /max_uses/)
    assert.match(clubInviteBody({ label: 'x', max_uses: 0 }, now).error, /max_uses/)
    assert.match(clubInviteBody({ label: 'x', max_uses: '5' }, now).error, /max_uses/)
    assert.match(clubInviteBody({ label: 'x', expires_at: new Date(now + (CLUB_INVITE_MAX_DAYS + 1) * DAY_MS).toISOString() }, now).error, /expires_at/)
    assert.match(clubInviteBody([], now).error, /body/)
  })
})

describe('club managers end to end', { skip: SKIP }, () => {
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
  const count1 = async (q) => (await sql.query(q)).rows[0].n
  const auditOf = async (action) => (await sql.query('SELECT actor_id, target_user_id, details FROM public.audit_log WHERE action = $1 ORDER BY at', [action])).rows

  let musterdorf, other
  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('910001', 'VBC Musterdorf H1', 'VBC Other H1', '2L', '2026-10-17T16:00:00Z'),
      ('910002', 'VBC Other H1', 'VBC Musterdorf H1', '2L', '2026-10-24T16:00:00Z'),
      ('910003', 'VBC Musterdorf H1', 'VBC Third H1', '2L', '2026-10-31T16:00:00Z'),
      ('910004', 'VBC Other H1', 'VBC Third H1', '2L', '2026-11-07T16:00:00Z')`)
    await account('admin', ['admin'])
    await account('boss', null) // becomes VBCM's club manager: no role at all
    await account('scorer', ['scorer'])
    await account('cm', ['competition_manager'])
    musterdorf = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    other = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })).json.data.club
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('admins pick a club\'s managers from its accounts; anyone else gets a club manager link; non-admins refused; audited', async () => {
    const put = (user, body) => call(user, 'PUT', `/api/admin/clubs/${musterdorf.id}/managers`, body)
    const candidates = async () => (await call(users.admin, 'GET', `/api/admin/clubs/${musterdorf.id}/manager-candidates`)).json.data.candidates
    expectCode(await put(users.cm, { user_ids: [users.boss.id] }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.cm, 'GET', `/api/admin/clubs/${musterdorf.id}/manager-candidates`), 403, 'OV_FORBIDDEN')
    expectCode(await put(users.admin, { user_ids: 'x' }), 400, 'OV_INVALID_REQUEST')
    // the old body (any address) is gone
    expectCode(await put(users.admin, { emails: [users.boss.email] }), 400, 'OV_INVALID_REQUEST')
    // the boss is not linked to the club: not pickable
    assert.deepEqual(await candidates(), [])
    expectCode(await put(users.admin, { user_ids: [users.boss.id] }), 422, 'OV_NOT_A_CLUB_MEMBER')

    // a club manager link instead (no SMTP here: not mailed, answered)
    expectCode(await call(users.admin, 'POST', `/api/admin/clubs/${musterdorf.id}/manager-invites`, { email: 'not an address' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.cm, 'POST', `/api/admin/clubs/${musterdorf.id}/manager-invites`, { email: users.boss.email }), 403, 'OV_FORBIDDEN')
    const inv = await call(users.admin, 'POST', `/api/admin/clubs/${musterdorf.id}/manager-invites`, { email: users.boss.email })
    assert.equal(inv.status, 201, inv.text)
    assert.equal(inv.json.data.mailed, false)
    assert.match(inv.json.data.link, /\/#club=[A-Z0-9-]+$/)
    assert.equal(inv.json.data.invite.role, 'club_manager')
    assert.equal(inv.json.data.invite.max_uses, 1)
    const red = await call(users.boss, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.equal(red.json.data.role_granted, 'club_manager')
    assert.deepEqual(red.json.data.club, { id: musterdorf.id, name: 'VBC Musterdorf' })
    // db/030: the club manager role, and the club
    assert.deepEqual(red.json.data.roles, ['club_manager'])
    assert.equal(await count1(`SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = '${users.boss.id}' AND club_id = '${musterdorf.id}'`), 1)
    // used once: nobody else becomes manager with it
    expectCode(await call(users.scorer, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code }), 409, 'OV_INVITE_USED_UP')

    // now linked (as its manager): the list keeps it
    assert.deepEqual((await candidates()).map((x) => [x.id, x.via]), [[users.boss.id, ['club_manager']]])
    const set = await put(users.admin, { user_ids: [users.boss.id] })
    assert.equal(set.status, 200, set.text)
    assert.deepEqual(set.json.data.club.managers.map((m) => m.user_id), [users.boss.id])
    const list = await call(users.admin, 'GET', '/api/admin/clubs')
    assert.deepEqual(list.json.data.clubs.find((c) => c.id === musterdorf.id).managers.map((m) => m.email), [users.boss.email])
    assert.deepEqual(list.json.data.clubs.find((c) => c.id === other.id).managers, [])
    const [entry] = await auditOf('club.managers')
    assert.deepEqual(entry.details.after, [users.boss.id])

    // a scorer of the club is pickable, one of another club is not
    await sql.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [users.scorer.id, musterdorf.id])
    assert.ok((await candidates()).some((x) => x.id === users.scorer.id && x.via.includes('scorer')))
    assert.equal((await put(users.admin, { user_ids: [users.boss.id, users.scorer.id] })).status, 200)
    expectCode(await call(users.admin, 'PUT', `/api/admin/clubs/${other.id}/managers`, { user_ids: [users.scorer.id] }), 422, 'OV_NOT_A_CLUB_MEMBER')
    assert.equal((await put(users.admin, { user_ids: [users.boss.id] })).status, 200)
    await sql.query('DELETE FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [users.scorer.id, musterdorf.id])
  })

  it('/api/me names the clubs an account manages; the club manager role (db/030), nothing more', async () => {
    const me = await call(users.boss, 'GET', '/api/me')
    assert.deepEqual(me.json.data.managedClubs, [{ id: musterdorf.id, name: 'VBC Musterdorf' }])
    assert.deepEqual(me.json.data.roles, ['club_manager'])
    assert.equal(me.json.data.canScore, false)
    assert.equal(me.json.data.isAdmin, false)
    assert.deepEqual((await call(users.scorer, 'GET', '/api/me')).json.data.managedClubs, [])
    expectCode(await call(users.boss, 'GET', '/api/admin/clubs'), 403, 'OV_FORBIDDEN')
  })

  it('a manager sees its own club only; admins see any; others none', async () => {
    const mine = await call(users.boss, 'GET', `/api/club/${musterdorf.id}`)
    assert.equal(mine.status, 200, mine.text)
    assert.equal(mine.json.data.club.name, 'VBC Musterdorf')
    expectCode(await call(users.boss, 'GET', `/api/club/${other.id}`), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.scorer, 'GET', `/api/club/${musterdorf.id}/members`), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.cm, 'GET', `/api/club/${musterdorf.id}/invites`), 403, 'OV_FORBIDDEN')
    assert.equal((await call(users.admin, 'GET', `/api/club/${other.id}`)).status, 200)
    expectCode(await call(users.admin, 'GET', '/api/club/00000000-0000-4000-8000-000000000000'), 404, 'OV_NOT_FOUND')
  })

  it('the contact address: set by the manager (or an admin), cleared with null, audited without the address', async () => {
    expectCode(await call(users.boss, 'PATCH', `/api/club/${musterdorf.id}`, { contact_email: 'not an address' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.boss, 'PATCH', `/api/club/${other.id}`, { contact_email: 'x@other.ch' }), 403, 'OV_FORBIDDEN')
    const set = await call(users.boss, 'PATCH', `/api/club/${musterdorf.id}`, { contact_email: ' Sekretariat@VBC-Musterdorf.ch ' })
    assert.equal(set.status, 200, set.text)
    assert.equal(set.json.data.club.contact_email, 'sekretariat@vbc-musterdorf.ch')
    const [entry] = await auditOf('club.contact')
    assert.deepEqual(entry.details, { club_id: musterdorf.id, set: true })
    const byAdmin = await call(users.admin, 'PATCH', `/api/admin/clubs/${other.id}`, { contact_email: 'info@other.ch' })
    assert.equal(byAdmin.json.data.club.contact_email, 'info@other.ch')
    assert.equal((await call(users.admin, 'PATCH', `/api/admin/clubs/${other.id}`, { contact_email: null })).json.data.club.contact_email, null)
  })

  let code, otherCode
  it('invite codes: the club and the sport fixed, scorer or referee, capped; the club\'s own codes only', async () => {
    expectCode(await call(users.boss, 'POST', `/api/club/${musterdorf.id}/invites`, { label: 'x', role: 'competition_manager' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.boss, 'POST', `/api/club/${musterdorf.id}/invites`, { label: 'x', max_uses: 500 }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.boss, 'POST', `/api/club/${musterdorf.id}/invites`, { label: '' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.boss, 'POST', `/api/club/${other.id}/invites`, { label: 'x' }), 403, 'OV_FORBIDDEN')
    // a club or a sport in the body is ignored: the route's club, indoor
    const made = await call(users.boss, 'POST', `/api/club/${musterdorf.id}/invites`, { label: 'H1 scorers', max_uses: 10, club_id: other.id, sport: 'beach' })
    assert.equal(made.status, 201, made.text)
    assert.equal(made.json.data.invite.club_id, musterdorf.id)
    assert.equal(made.json.data.invite.sport, 'indoor')
    assert.equal(made.json.data.invite.role, 'scorer')
    assert.equal(made.json.data.invite.max_uses, 10)
    code = made.json.data.code
    otherCode = (await call(users.admin, 'POST', '/api/admin/invites', { label: 'Other scorers', club_id: other.id })).json.data

    const list = await call(users.boss, 'GET', `/api/club/${musterdorf.id}/invites`)
    assert.deepEqual(list.json.data.invites.map((i) => i.label), ['H1 scorers'])
    // the admin's club manager link (its label names the invitee) is not the club manager's to see
    expectCode(await call(users.boss, 'POST', `/api/club/${musterdorf.id}/invites/${otherCode.invite.id}/revoke`), 404, 'OV_NOT_FOUND')
    const [entry] = (await auditOf('invite.create')).filter((e) => e.details.label === 'H1 scorers')
    assert.equal(entry.details.club_id, musterdorf.id)
    assert.equal(entry.actor_id, users.boss.id)
  })

  it('whoever redeems the code becomes a member; the manager sees the members', async () => {
    const fresh = await account('fresh', null)
    assert.equal((await call(fresh, 'POST', '/api/account/redeem-invite', { code })).status, 200)
    const members = await call(users.boss, 'GET', `/api/club/${musterdorf.id}/members`)
    assert.equal(members.status, 200, members.text)
    const row = members.json.data.members.find((m) => m.id === fresh.id)
    assert.equal(row.email, fresh.email)
    assert.deepEqual(row.roles, ['scorer'])
    assert.equal(row.manager, false)
  })

  it('taking someone off a club removes the club link only: roles and other clubs stay; with the rule on, the club\'s games are refused', async () => {
    const multi = await account('multi', null)
    assert.equal((await call(multi, 'POST', '/api/account/redeem-invite', { code })).status, 200)
    assert.equal((await call(multi, 'POST', '/api/account/redeem-invite', { code: otherCode.code })).status, 200)
    assert.deepEqual((await call(multi, 'GET', '/api/me')).json.data.clubs.map((c) => c.name), ['VBC Musterdorf', 'VBC Other'])

    expectCode(await call(users.boss, 'DELETE', `/api/club/${other.id}/members/${multi.id}`), 403, 'OV_FORBIDDEN')
    const removed = await call(users.boss, 'DELETE', `/api/club/${musterdorf.id}/members/${multi.id}`)
    assert.equal(removed.status, 200, removed.text)
    expectCode(await call(users.boss, 'DELETE', `/api/club/${musterdorf.id}/members/${multi.id}`), 404, 'OV_NOT_FOUND')

    const me = (await call(multi, 'GET', '/api/me')).json.data
    assert.deepEqual(me.clubs.map((c) => c.name), ['VBC Other'], 'the other club stays')
    assert.deepEqual(me.roles, ['scorer'], 'the account keeps its role')
    const [entry] = await auditOf('club.member_remove')
    assert.equal(entry.target_user_id, multi.id)
    assert.equal(entry.actor_id, users.boss.id)

    assert.equal((await call(users.admin, 'PUT', '/api/admin/club-rule', { enabled: true })).status, 200)
    expectCode(await insertMatch(multi, { game_n: 910003 }), 403, 'OV_NOT_YOUR_CLUB')
    assert.equal((await insertMatch(multi, { game_n: 910004 })).status, 200, 'its other club\'s home game')
  })

  it('removing a manager ends its access at once', async () => {
    assert.equal((await call(users.admin, 'PUT', `/api/admin/clubs/${musterdorf.id}/managers`, { user_ids: [] })).status, 200)
    expectCode(await call(users.boss, 'GET', `/api/club/${musterdorf.id}`), 403, 'OV_FORBIDDEN')
    assert.deepEqual((await call(users.boss, 'GET', '/api/me')).json.data.managedClubs, [])
    // db/030: the role goes with the last managed club; the club membership stays
    const roles = (await sql.query('SELECT roles FROM public.profiles WHERE user_id = $1', [users.boss.id])).rows[0].roles
    assert.ok(!roles.includes('club_manager'), String(roles))
    assert.equal(await count1(`SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = '${users.boss.id}' AND club_id = '${musterdorf.id}'`), 1)
  })

  it('the audit list names the club of each club entry and of a club\'s invite code; a deleted club keeps the name in its details', async () => {
    const gone = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Gone' })).json.data.club
    assert.equal((await call(users.admin, 'DELETE', `/api/admin/clubs/${gone.id}`)).status, 200)
    const r = await call(users.admin, 'GET', '/api/admin/audit?limit=200')
    assert.equal(r.status, 200, r.text)
    const of = (action) => r.json.data.entries.filter((e) => e.action === action)
    const clubOf = (e) => e.details.club_id
    for (const action of ['club.create', 'club.update', 'club.managers', 'club.contact', 'club.member_remove']) {
      const live = of(action).filter((e) => clubOf(e) !== gone.id)
      assert.ok(live.length, action)
      for (const e of live) assert.equal(e.club_name, clubOf(e) === musterdorf.id ? 'VBC Musterdorf' : 'VBC Other', action)
    }
    assert.deepEqual(of('club.member_remove').map((e) => e.club_name), ['VBC Musterdorf'])
    assert.equal(of('invite.create').find((e) => e.details.label === 'H1 scorers').club_name, 'VBC Musterdorf')
    assert.ok(of('invite.redeem').some((e) => e.club_name === 'VBC Musterdorf'))
    // gone: no name from the list, its own in the delete entry
    const [deleted] = of('club.delete')
    assert.equal(deleted.club_name, null)
    assert.equal(deleted.details.name, 'VBC Gone')
    assert.equal(of('club.create').find((e) => clubOf(e) === gone.id).club_name, null)
    // an entry about no club names none
    assert.ok(of('club_rule.set').length)
    for (const e of of('club_rule.set')) assert.equal(e.club_name, null)
  })
})
