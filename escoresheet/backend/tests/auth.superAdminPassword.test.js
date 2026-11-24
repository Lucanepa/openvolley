/**
 * Audit 2611 SEC-36: the longer password of an admin (14 characters) keyed on
 * the literal role 'admin', so a super admin (roles {super_admin}) could set a
 * 10-character one (poc/auth-sessions/p04-admin-password-policy.mjs). Now it
 * follows lib/access.js accessFromRoles().isAdmin. Existing passwords keep
 * working: sign-in checks no length.
 *
 * The first part runs on a stand-in pool; the change-password and reset flows
 * need PG_TEST_URL (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase } from './helpers/pgTestDb.js'
import { createAuth, generateToken, hashToken } from '../lib/auth.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }
const TEN = 'ten-chars!'
const FOURTEEN = 'fourteen-chars'

/** A pool that answers the few queries setPassword makes before its transaction. */
function standInPool(roles) {
  const ID = '00000000-0000-4000-8000-000000000001'
  return {
    async query(sql) {
      if (/information_schema\.columns/.test(sql)) {
        return { rows: ['id', 'email', 'encrypted_password'].map((c) => ({ column_name: c, data_type: 'text', udt_name: 'text', is_generated: 'NEVER', is_identity: 'NO' })) }
      }
      if (/SELECT id, lower\(email\)/.test(sql)) return { rows: [{ id: ID, email: 'someone@example.ch' }] }
      if (/FROM "public"\."profiles"/.test(sql)) return { rows: roles === null ? [] : [{ roles }] }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`)
    },
    async connect() { throw Object.assign(new Error('reached the transaction'), { code: 'REACHED' }) }
  }
}

describe('the admin password minimum covers the super admin (SEC-36)', () => {
  for (const [roles, min] of [[['super_admin'], 14], [['admin'], 14], ['{super_admin}', 14], [['beach:scorer', 'super_admin'], 14], [['scorer'], 10], [['competition_manager'], 10], [[], 10], [null, 10]]) {
    it(`roles ${JSON.stringify(roles)}: at least ${min} characters`, async () => {
      const auth = createAuth({ pool: standInPool(roles), logger: silent, bcryptCost: 4 })
      if (min > 10) {
        await assert.rejects(auth.setPassword('someone@example.ch', TEN), /at least 14 characters/)
      } else {
        await assert.rejects(auth.setPassword('someone@example.ch', TEN), (e) => e.code === 'REACHED', 'the policy lets it through')
      }
      await assert.rejects(auth.setPassword('someone@example.ch', FOURTEEN), (e) => e.code === 'REACHED')
    })
  }
})

describe('change-password and reset of a super admin (SEC-36)', { skip: SKIP_PG }, () => {
  let tdb, pool
  let ipSeq = 0
  const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`
  before(async () => {
    tdb = await createTestDatabase('authsignin_superadmin', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })
  async function addUser(email, roles, password) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at) VALUES ($1, crypt($2, gen_salt('bf', 4)), now()) RETURNING id`, [email, password])
    await pool.query('DELETE FROM public.profiles WHERE user_id = $1', [u.id])
    await pool.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2::text[])', [u.id, roles])
    return u.id
  }
  const auth = () => createAuth({ pool, logger: silent, bcryptCost: 4, limits: { signInGlobal: false } })

  it('a super admin\'s 10-character password is refused like an admin\'s; 14 works; an old short one still signs in', async () => {
    const a = auth()
    for (const [email, roles, expect] of [['super@example.ch', ['super_admin'], 422], ['admin@example.ch', ['admin'], 422], ['scorer@example.ch', ['scorer'], 200]]) {
      // an old 10-character password (set before the rule): it signs in
      await addUser(email, roles, 'old-pass-1')
      const si = await a.handleAuthRequest('sign-in', { email, password: 'old-pass-1' }, { ip: nextIp() })
      assert.equal(si.status, 200, `${email}: an existing password keeps working`)
      const token = si.body.data.session.access_token
      const r = await a.handleAuthRequest('change-password', { access_token: token, password: 'old-pass-1', new_password: TEN }, { ip: nextIp() })
      assert.equal(r.status, expect, `${email}: ${JSON.stringify(r.body.error)}`)
      if (expect === 422) {
        assert.equal(r.body.error.code, 'weak_password')
        assert.match(r.body.error.message, /at least 14/)
        const ok = await a.handleAuthRequest('change-password', { access_token: token, password: 'old-pass-1', new_password: FOURTEEN }, { ip: nextIp() })
        assert.equal(ok.status, 200, JSON.stringify(ok.body))
      }
    }
  })

  it('a reset link of a super admin needs 14 characters too', async () => {
    const id = await addUser('super-reset@example.ch', ['super_admin'], 'old-pass-1')
    const token = generateToken()
    await pool.query(`INSERT INTO auth.app_tokens (hash, purpose, user_id, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 hour')`, [hashToken(token), id])
    const a = auth()
    const short = await a.handleAuthRequest('reset-password/confirm', { token, password: TEN }, { ip: nextIp() })
    assert.equal(short.status, 422)
    assert.equal(short.body.error.code, 'weak_password')
    const long = await a.handleAuthRequest('reset-password/confirm', { token, password: FOURTEEN }, { ip: nextIp() })
    assert.equal(long.status, 200, JSON.stringify(long.body))
  })
})
