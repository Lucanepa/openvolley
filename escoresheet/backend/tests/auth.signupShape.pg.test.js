/**
 * Audit 2611 SEC-14: with mail on, a sign-up of an address that has an
 * account answers like a new account (no address oracle), but the shadow
 * user object differed: no app_metadata.ov_email_confirmation, and its
 * timestamps were JS toISOString ('...113Z') where a real row has to_jsonb's
 * ('...041713+00:00'). poc/auth-sessions/p01-signup-oracle-and-confirm.mjs
 * told known from new every time. Both answers are compared here key by key,
 * in key order, and by the format of every value.
 *
 * Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase } from './helpers/pgTestDb.js'
import { createAuth } from '../lib/auth.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }

function memoryMailer() {
  const mails = []
  return { enabled: true, reason: null, managerUrl: 'https://manager.example.test', mails, async send(kind, m) { mails.push({ kind, ...m }); return { sent: true } }, close() {} }
}

/**
 * The shape of a JSON value: objects keep their keys in order, every string
 * becomes its format (digits -> 9, hex/letters of a UUID -> x, ...), so two
 * answers have the same shape exactly when nothing but the values differs.
 */
function shapeOf(v) {
  if (Array.isArray(v)) return v.map(shapeOf)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
  if (typeof v === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return '<uuid>'
    // the offset stays; the fraction's length does not (Postgres drops trailing zeros, in both answers alike)
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.replace(/\.\d+/, '.f').replace(/\d/g, '9')
    if (/@/.test(v)) return '<email>'
    return v
  }
  return v
}

describe('sign-up of a known address answers exactly like a new one (SEC-14)', { skip: SKIP_PG }, () => {
  let tdb, pool
  let ipSeq = 0
  const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`
  before(async () => {
    tdb = await createTestDatabase('authsignin_shape', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query(`INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
      VALUES ('known@example.ch', crypt('known-password-1', gen_salt('bf', 4)), now(), '{"provider":"email","providers":["email"]}', now() - interval '1 year', now() - interval '1 year')`)
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  const body = (email) => ({
    email,
    password: 'stranger-pass-123',
    app: 'indoor',
    lang: 'de',
    metadata: { first_name: 'Evil', last_name: 'Stranger', license_number: '123456', country: 'CHE' }
  })

  it('same keys, same key order, same value formats; the known address gets a reset mail instead', async () => {
    const mailer = memoryMailer()
    const auth = createAuth({ pool, logger: silent, mailer, bcryptCost: 4 })
    const fresh = await auth.handleAuthRequest('sign-up', body(`brand-new-${Date.now()}@example.ch`), { ip: nextIp() })
    const known = await auth.handleAuthRequest('sign-up', body('known@example.ch'), { ip: nextIp() })
    await auth.settle()
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
    assert.equal(known.status, 200, JSON.stringify(known.body))
    assert.deepEqual(Object.keys(known.body.data), Object.keys(fresh.body.data))
    assert.deepEqual(Object.keys(known.body.data.user), Object.keys(fresh.body.data.user), 'the same keys in the same order')
    // the PoC's tells
    assert.equal(known.body.data.user.app_metadata.ov_email_confirmation, 'link')
    assert.match(known.body.data.user.created_at, /\.\d{1,6}[+-]\d{2}:\d{2}$/, 'to_jsonb\'s timestamp, not toISOString')
    assert.equal(JSON.stringify(shapeOf(known.body)), JSON.stringify(shapeOf(fresh.body)), 'byte for byte the same shape')
    // the values a stranger chose come back alike, the address and ids are fresh
    assert.equal(known.body.data.user.email, 'known@example.ch')
    assert.notEqual(known.body.data.user.id, fresh.body.data.user.id)
    assert.equal(known.body.data.email_confirmation, 'sent')
    // no account was made for the known address, its owner got a reset link
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth.users WHERE lower(email) = 'known@example.ch'`)).rows[0].n, 1)
    assert.deepEqual(mailer.mails.map((m) => m.kind).sort(), ['confirm', 'reset'])
  })

  it('a timestamp whose microseconds end in zeros has the same format too (Postgres prints both)', async () => {
    // the session time zone decides the offset of both answers alike
    const client = await pool.connect()
    try {
      const { rows: [r] } = await client.query(`SELECT to_jsonb(timestamptz '2026-11-23 10:00:00.120000+00') AS t, to_jsonb(r) AS u
        FROM jsonb_populate_record(NULL::auth.users, jsonb_build_object('created_at', timestamptz '2026-11-23 10:00:00.120000+00')) r`)
      assert.equal(r.u.created_at, r.t, 'the shadow takes its timestamp the way the real row gives it back')
    } finally {
      client.release()
    }
  })
})
