/**
 * Codes and team links after their creator, a club or a team let the account
 * go (be-accounts-6, be-clubs-teams-5, be-clubs-teams-7).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PASSWORD = 'correct-horse-battery'

describe('invite codes after a removal', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  let alpha, beta, alphaH1

  async function account (name, { roles = null, requests = undefined } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Test' }, ...(requests ? { requests } : {}) } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    await sql.query("UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1 AND (to_jsonb(auth.users) ? 'email_confirmed_at')", [u.id]).catch(() => {})
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) =>
    api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2', headers: { 'cf-connecting-ip': user?.ip || '198.51.100.250' } })
  const rolesOf = async (u) => (await sql.query('SELECT roles FROM public.profiles WHERE user_id = $1', [u.id])).rows[0]?.roles ?? []
  const clubsOf = async (u) => (await sql.query('SELECT club_id FROM public.account_clubs WHERE user_id = $1 ORDER BY club_id', [u.id])).rows.map((r) => r.club_id)

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    const admin = await account('admin', { roles: ['admin'] })
    await account('mgrA')
    await account('mgrB')
    alpha = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Alpha', teams: ['VBC Alpha H1', 'VBC Alpha D1'] })).json.data.club
    beta = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Beta', teams: ['VBC Beta H1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2), ($3, $4)', [alpha.id, users.mgrA.id, beta.id, users.mgrB.id])
    alphaH1 = (await call(users.mgrA, 'GET', `/api/club/${alpha.id}/teams`)).json.data.teams.find((t) => t.name === 'VBC Alpha H1')
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('a code of an admin deactivated since makes nobody anything', async () => {
    const leaver = await account('leaver', { roles: ['admin'] })
    const made = await call(leaver, 'POST', '/api/admin/invites', { label: 'spare', role: 'competition_manager', max_uses: null, expires_at: null })
    assert.equal(made.status, 201, made.text)
    const off = await call(users.admin, 'POST', `/api/admin/accounts/${leaver.id}/deactivate`, {})
    assert.equal(off.status, 200, off.text)
    assert.equal((await call(leaver, 'GET', '/api/me')).status, 401, 'cannot sign in any more')
    const back = await account('leaverBack')
    const red = await call(back, 'POST', '/api/account/redeem-invite', { code: made.json.data.code })
    assert.equal(red.status, 404, red.text)
    assert.equal(red.json.error.code, 'OV_INVITE_INVALID')
    assert.deepEqual(await rolesOf(back), [])
  })

  it('a scorer code of a club manager deactivated since makes no club member', async () => {
    const mgrC = await account('mgrC')
    const gamma = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Gamma', teams: ['VBC Gamma H1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [gamma.id, mgrC.id])
    const code = (await call(mgrC, 'POST', `/api/club/${gamma.id}/invites`, { label: 'kept', role: 'scorer', max_uses: 50 })).json.data.code
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${mgrC.id}/deactivate`, {})).status, 200)
    const fresh = await account('freshC')
    const red = await call(fresh, 'POST', '/api/account/redeem-invite', { code })
    assert.equal(red.status, 404, red.text)
    assert.deepEqual(await clubsOf(fresh), [])
  })

  it('a scorer role from club A\'s code goes when B, joined later, takes the account off last', async () => {
    const codeA = (await call(users.mgrA, 'POST', `/api/club/${alpha.id}/invites`, { label: 'A scorers', role: 'scorer', max_uses: 5 })).json.data.code
    const codeB = (await call(users.mgrB, 'POST', `/api/club/${beta.id}/invites`, { label: 'B scorers', role: 'scorer', max_uses: 5 })).json.data.code
    const u = await account('hopper')
    assert.equal((await call(u, 'POST', '/api/account/redeem-invite', { code: codeA })).status, 200)
    const jb = await call(u, 'POST', '/api/account/redeem-invite', { code: codeB })
    assert.equal(jb.status, 200, jb.text)
    assert.deepEqual((await clubsOf(u)).sort(), [alpha.id, beta.id].sort())
    const offA = await call(users.mgrA, 'DELETE', `/api/club/${alpha.id}/members/${u.id}`)
    assert.equal(offA.status, 200, offA.text)
    assert.deepEqual(offA.json.data.roles_removed, [])
    const offB = await call(users.mgrB, 'DELETE', `/api/club/${beta.id}/members/${u.id}`)
    assert.equal(offB.status, 200, offB.text)
    assert.deepEqual(await clubsOf(u), [])
    assert.deepEqual(offB.json.data.roles_removed, ['scorer'])
    assert.deepEqual(await rolesOf(u), [])
  })

  it('the other order drops the role too', async () => {
    const codeA = (await call(users.mgrA, 'POST', `/api/club/${alpha.id}/invites`, { label: 'A scorers 2', role: 'scorer', max_uses: 5 })).json.data.code
    const codeB = (await call(users.mgrB, 'POST', `/api/club/${beta.id}/invites`, { label: 'B scorers 2', role: 'scorer', max_uses: 5 })).json.data.code
    const u = await account('hopper2')
    assert.equal((await call(u, 'POST', '/api/account/redeem-invite', { code: codeA })).status, 200)
    assert.equal((await call(u, 'POST', '/api/account/redeem-invite', { code: codeB })).status, 200)
    assert.equal((await call(users.mgrB, 'DELETE', `/api/club/${beta.id}/members/${u.id}`)).status, 200)
    const offA = await call(users.mgrA, 'DELETE', `/api/club/${alpha.id}/members/${u.id}`)
    assert.deepEqual(await rolesOf(u), [])
  })

  it('a removed team manager does not come back with another link made before; a link made after works', async () => {
    const own = await call(users.mgrA, 'POST', `/api/club/${alpha.id}/teams/${alphaH1.id}/invites`, { max_uses: 1 })
    const chat = await call(users.mgrA, 'POST', `/api/club/${alpha.id}/teams/${alphaH1.id}/invites`, { max_uses: 3 })
    const coach = await account('coachX')
    assert.equal((await call(coach, 'POST', '/api/account/redeem-invite', { code: own.json.data.code })).status, 200)
    const del = await call(users.mgrA, 'DELETE', `/api/club/${alpha.id}/teams/${alphaH1.id}/managers/${coach.id}`)
    assert.equal(del.status, 200, del.text)
    assert.equal((await call(coach, 'GET', `/api/team/${alphaH1.id}`)).status, 403)
    const again = await call(coach, 'POST', '/api/account/redeem-invite', { code: chat.json.data.code })
    assert.equal(again.status, 409, again.text)
    assert.equal(again.json.error.code, 'OV_INVITE_REMOVED')
    assert.equal((await call(coach, 'GET', `/api/team/${alphaH1.id}`)).status, 403)
    const { rows: [inv] } = await sql.query('SELECT uses FROM public.invite_codes WHERE id = $1', [chat.json.data.invite.id])
    assert.equal(inv.uses, 0)
    const asked = await call(users.mgrA, 'POST', `/api/club/${alpha.id}/teams/${alphaH1.id}/invites`, { max_uses: 1 })
    assert.equal((await call(coach, 'POST', '/api/account/redeem-invite', { code: asked.json.data.code })).status, 200)
    assert.equal((await call(coach, 'GET', `/api/team/${alphaH1.id}`)).status, 200, 'the club asked it back')
  })
})
