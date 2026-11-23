/**
 * Sign-up needs the licence number on a production server (owner 23.11.2026:
 * "have registered people insert their licence n in registration"): server.js
 * turns lib/auth.js licenceRequired on unless OV_SIGNUP_LICENCE=optional,
 * which tests/helpers/e2eServer.js sets for every other e2e test. This one
 * boots the server as production does (the variable empty).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'

describe('sign-up on a production server needs the licence number', { skip: SKIP }, () => {
  let db, sql, srv
  let ipSeq = 1
  const signUp = (metadata) => {
    const email = `lic-${randomBytes(3).toString('hex')}@example.test`
    return api(srv.base, '/api/auth/sign-up', {
      proto: null,
      headers: { 'cf-connecting-ip': `203.0.113.${ipSeq++}` },
      body: { email, password: 'correct-horse-battery', metadata }
    }).then((r) => ({ ...r, email }))
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      OV_SIGNUP_LICENCE: ''
    })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('without one: 422 licence_required and no account; with one: the profile keeps it', async () => {
    const none = await signUp({ first_name: 'Nora', last_name: 'Neu' })
    assert.equal(none.status, 422, none.text)
    assert.equal(none.json?.error?.code, 'licence_required')
    const { rows: [n] } = await sql.query('SELECT count(*)::int AS n FROM auth.users WHERE email = $1', [none.email])
    assert.equal(n.n, 0)

    const ok = await signUp({ first_name: 'Nora', last_name: 'Neu', license_number: '123456' })
    assert.equal(ok.status, 200, ok.text)
    const { rows: [p] } = await sql.query(
      'SELECT p.license_number FROM public.profiles p JOIN auth.users u ON u.id = p.user_id WHERE u.email = $1', [ok.email])
    assert.equal(p.license_number, '123456')
  })
})
