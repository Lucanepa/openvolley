/**
 * PERM-06 (audit 2611): a member a club manager (or an admin) took off the
 * club came back with ANY other active code of the club made before the
 * removal (the season's shared code in the group chat): membership and the
 * scorer role again, the manager not told. Only the same code was refused
 * (be-accounts-4); team links had the full check (be-clubs-teams-5). Now a
 * club code refuses 409 OV_INVITE_REMOVED when the account was taken off the
 * club at or after the code was made; a code made later, or the club adding
 * the account again, is the club asking it back.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('club codes after a removal (PERM-06)', { skip: SKIP }, () => {
  let db, srv, sql, club
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name, roles = []) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: null, headers: { 'cf-connecting-ip': user.ip } })
  const code = async (label) => {
    const r = await call(users.manager, 'POST', `/api/club/${club.id}/invites`, { label, role: 'scorer', max_uses: 50 })
    assert.equal(r.status, 201, r.text)
    return r.json.data.code
  }
  const redeem = (user, c) => call(user, 'POST', '/api/account/redeem-invite', { code: c })
  const preview = (user, c) => call(user, 'POST', '/api/account/invite-preview', { code: c })
  const isMember = async (u) => (await sql.query('SELECT 1 FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [u.id, club.id])).rowCount === 1
  const expectRemoved = (r) => {
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.error.code, 'OV_INVITE_REMOVED')
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('admin', ['admin'])
    await account('manager')
    club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club.id, users.manager.id])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('taken off by the club\'s manager: no other code of before brings it back; a later one does', async () => {
    const k1 = await code('Season code')
    const k2 = await code('Second code')
    const x = await account('Removed')
    assert.equal((await redeem(x, k1)).status, 200)
    assert.ok(await isMember(x))
    await sleep(20) // the removal after the codes were made
    const rm = await call(users.manager, 'DELETE', `/api/club/${club.id}/members/${x.id}`)
    assert.equal(rm.status, 200, rm.text)
    assert.deepEqual(rm.json.data.roles_removed, ['scorer'])
    // the same code (as before) and any other code of before
    expectRemoved(await redeem(x, k1))
    expectRemoved(await preview(x, k2))
    expectRemoved(await redeem(x, k2))
    assert.equal(await isMember(x), false)
    const { rows: [p] } = await sql.query('SELECT roles FROM public.profiles WHERE user_id = $1', [x.id])
    assert.deepEqual(p.roles, [], 'no scorer role either')
    const { rows: [k2Row] } = await sql.query("SELECT uses FROM public.invite_codes WHERE label = 'Second code'")
    assert.equal(k2Row.uses, 0, 'the refused code is not used up')
    // a code made after the removal: the club asks it back
    await sleep(20)
    const k3 = await code('New code')
    const back = await redeem(x, k3)
    assert.equal(back.status, 200, back.text)
    assert.equal(back.json.data.role_granted, 'scorer')
    assert.ok(await isMember(x))
  })

  it('taken off by an admin: the same', async () => {
    const k = await code('Before the admin')
    const y = await account('AdminRemoved')
    const k0 = await code('Used one')
    assert.equal((await redeem(y, k0)).status, 200)
    await sleep(20)
    assert.equal((await call(users.admin, 'PUT', `/api/admin/accounts/${y.id}/clubs`, { club_ids: [] })).status, 200)
    expectRemoved(await redeem(y, k))
    // the admin adds it again: an older code works as for any member
    assert.equal((await call(users.admin, 'PUT', `/api/admin/accounts/${y.id}/clubs`, { club_ids: [club.id] })).status, 200)
    const again = await redeem(y, k)
    assert.equal(again.status, 200, again.text)
    assert.ok(await isMember(y))
  })

  it('someone never taken off joins with an older code as before', async () => {
    const k = await code('Old shared code')
    await sleep(20)
    const z = await account('Newcomer')
    const r = await redeem(z, k)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.role_granted, 'scorer')
    assert.ok(await isMember(z))
  })
})
