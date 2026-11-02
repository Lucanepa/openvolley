/**
 * Passkeys (lib/passkeys.js, the passkey actions in lib/auth.js).
 *
 * The ceremonies run for real: a software authenticator below makes a P-256
 * key pair, answers the server's options with a "none" attestation and signs
 * assertions the way a phone does, so the library's checks (challenge,
 * origin, RP ID hash, user verification, signature, counter) are the ones the
 * server makes in production. The Postgres suite then drives the actions of
 * lib/auth.js: setting one up needs the password, a key signs in to the
 * account it belongs to, a new password removes them all.
 *
 *   npm test                                  (the Postgres part needs PG_TEST_URL)
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'
import {
  cleanTransports, createPasskeyCeremonies, originAllowed, passkeyConfig, passkeyDeviceLabel,
  PASSKEY_CHALLENGE_TTL_MS, PASSKEY_CHALLENGES_MAX
} from '../lib/passkeys.js'
import { createAuth } from '../lib/auth.js'
import { createDatabase, testSchemaSql } from './helpers/pgTestDb.js'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PG_TEST_URL = process.env.PG_TEST_URL
const APP = 'https://app.openvolley.app'
const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** A phone's passkey store, in software: one key pair, a signature counter. */
function softAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credId = randomBytes(16)
  let counter = 0
  let userHandle = null
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]])
  const authData = (rpId, flags, withKey) => {
    const cnt = Buffer.alloc(4)
    cnt.writeUInt32BE(counter)
    const parts = [createHash('sha256').update(rpId).digest(), Buffer.from([flags]), cnt]
    if (withKey) {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(credId.length)
      parts.push(Buffer.alloc(16), len, credId, Buffer.from(isoCBOR.encode(cose)))
    }
    return Buffer.concat(parts)
  }
  return {
    id: b64u(credId),
    /** navigator.credentials.create(): flags UP|UV|AT. */
    create(options, origin, rpId = options.rp.id) {
      userHandle = options.user.id
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
      const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, 0x45, true)]]))
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key',
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal', 'x-bogus'] },
        clientExtensionResults: {}, authenticatorAttachment: 'platform'
      }
    },
    /** navigator.credentials.get(): flags UP|UV, the counter moves on. */
    get(options, origin, { flags = 0x05 } = {}) {
      counter++
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }))
      const ad = authData(options.rpId, flags, false)
      const signature = sign('sha256', Buffer.concat([ad, createHash('sha256').update(clientData).digest()]), privateKey)
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key',
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(signature), userHandle },
        clientExtensionResults: {}, authenticatorAttachment: 'platform'
      }
    }
  }
}

describe('passkey rules', () => {
  const config = passkeyConfig({})

  it('one relying party, openvolley.app, for every OpenVolley and OpenBeach site', () => {
    assert.equal(config.rpId, 'openvolley.app')
    for (const o of [APP, 'https://manager.openvolley.app', 'https://manager-beach.openvolley.app', 'https://beach.openvolley.app', 'https://openvolley.app']) {
      assert.equal(originAllowed(o, config), true, o)
    }
  })

  it('the apps\' own schemes, plain http and look-alike hosts never ask', () => {
    for (const o of ['https://localhost', 'capacitor://localhost', 'tauri://localhost', 'http://tauri.localhost', 'http://localhost:5173',
      'http://app.openvolley.app', 'https://app.openvolley.app.evil.example', 'https://evilopenvolley.app', 'https://app.openvolley.app/', '', 'not a url']) {
      assert.equal(originAllowed(o, config), false, o)
    }
  })

  it('a local test names its origins explicitly', () => {
    const local = passkeyConfig({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGINS: 'http://localhost:5173' })
    assert.equal(local.rpId, 'localhost')
    assert.equal(originAllowed('http://localhost:5173', local), true)
    assert.equal(originAllowed('http://localhost:5174', local), false)
  })

  it('the device label names the device and the browser, nothing more', () => {
    assert.equal(passkeyDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'), 'iPhone · Safari')
    assert.equal(passkeyDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'), 'iPad · Safari')
    assert.equal(passkeyDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Windows · Edge')
    assert.equal(passkeyDeviceLabel(''), 'Device')
  })

  it('what a device says about its transports is cut to WebAuthn\'s list', () => {
    assert.deepEqual(cleanTransports(['internal', 'hybrid', 'x'.repeat(5000), 'internal', 7]), ['internal', 'hybrid'])
    assert.deepEqual(cleanTransports('usb'), [])
  })
})

describe('passkey ceremonies with a software authenticator', () => {
  const config = passkeyConfig({})

  it('sets up a key and signs in with it, as the account it belongs to', async () => {
    const c = createPasskeyCeremonies(config)
    const device = softAuthenticator()
    const reg = await c.registrationOptions({ userId: 'user-1', email: 'a@example.ch', existing: [] })
    assert.equal(reg.options.rp.id, 'openvolley.app')
    assert.equal(reg.options.authenticatorSelection.userVerification, 'required')
    const added = await c.finishRegistration({ challengeId: reg.challengeId, userId: 'user-1', response: device.create(reg.options, APP) })
    assert.equal(added.credentialId, device.id)
    assert.deepEqual(added.transports, ['internal'])
    const stored = { id: 'row-1', userId: 'user-1', ...added }

    // Set up on the scorer app, signing in on the manager: one RP, one key.
    const login = await c.authenticationOptions()
    const out = await c.finishAuthentication({
      challengeId: login.challengeId,
      response: device.get(login.options, 'https://manager.openvolley.app'),
      lookup: async (id) => (id === stored.credentialId ? stored : null)
    })
    assert.equal(out.passkey.userId, 'user-1')
    assert.equal(out.newCounter, 1)
  })

  it('refuses an answer sent twice, a page that may not ask, and a key without user verification', async () => {
    const c = createPasskeyCeremonies(config)
    const device = softAuthenticator()
    const reg = await c.registrationOptions({ userId: 'u', email: 'u@example.ch', existing: [] })
    const stored = { id: 'r', userId: 'u', ...(await c.finishRegistration({ challengeId: reg.challengeId, userId: 'u', response: device.create(reg.options, APP) })) }
    const lookup = async () => stored

    const first = await c.authenticationOptions()
    const answer = device.get(first.options, APP)
    await c.finishAuthentication({ challengeId: first.challengeId, response: answer, lookup })
    await assert.rejects(c.finishAuthentication({ challengeId: first.challengeId, response: answer, lookup }), { code: 'challenge' })

    const foreign = await c.authenticationOptions()
    await assert.rejects(c.finishAuthentication({ challengeId: foreign.challengeId, response: device.get(foreign.options, 'https://evil.example'), lookup }), { code: 'origin' })

    const noUv = await c.authenticationOptions()
    await assert.rejects(c.finishAuthentication({ challengeId: noUv.challengeId, response: device.get(noUv.options, APP, { flags: 0x01 }), lookup }), { code: 'invalid' })
  })

  it('a set-up is filed under the account it was started for, or not at all', async () => {
    const c = createPasskeyCeremonies(config)
    const device = softAuthenticator()
    const reg = await c.registrationOptions({ userId: 'a', email: 'a@example.ch', existing: [] })
    await assert.rejects(c.finishRegistration({ challengeId: reg.challengeId, userId: 'b', response: device.create(reg.options, APP) }), { code: 'mismatch' })
  })

  it('a key filed under another account does not open that account', async () => {
    const c = createPasskeyCeremonies(config)
    const device = softAuthenticator()
    const reg = await c.registrationOptions({ userId: 'owner', email: 'o@example.ch', existing: [] })
    const added = await c.finishRegistration({ challengeId: reg.challengeId, userId: 'owner', response: device.create(reg.options, APP) })
    const login = await c.authenticationOptions()
    await assert.rejects(c.finishAuthentication({
      challengeId: login.challengeId,
      response: device.get(login.options, APP),
      lookup: async () => ({ id: 'r', userId: 'someone-else', ...added })
    }), { code: 'invalid' })
  })

  it('a challenge expires, a malformed credential id never reaches a lookup, and the map has a ceiling', async () => {
    let now = 1_000_000
    const c = createPasskeyCeremonies(config, () => now)
    const { challengeId } = await c.authenticationOptions()
    now += PASSKEY_CHALLENGE_TTL_MS + 1
    await assert.rejects(c.finishAuthentication({ challengeId, response: { id: 'x' }, lookup: async () => null }), { code: 'challenge' })

    let looked = 0
    for (const id of ['x\\', 'a" OR 1=1 --', '']) {
      const fresh = await c.authenticationOptions()
      await assert.rejects(c.finishAuthentication({ challengeId: fresh.challengeId, response: { id }, lookup: async () => { looked++; return null } }), { code: 'invalid' })
    }
    assert.equal(looked, 0)

    const many = createPasskeyCeremonies(config)
    for (let i = 0; i < PASSKEY_CHALLENGES_MAX + 10; i++) await many.authenticationOptions()
    assert.equal(many.pending, PASSKEY_CHALLENGES_MAX)
  })
})

describe('passkeys against Postgres', { skip: PG_TEST_URL ? false : 'PG_TEST_URL not set' }, () => {
  let pg, admin, pool
  const dbName = `ov_passkey_test_${process.pid}_${Date.now()}`
  const silent = { log() {}, warn() {}, error: (...a) => { if (process.env.DEBUG_PASSKEY) console.error(...a) } }
  let ipSeq = 0
  const ctx = (headers = {}) => ({ ip: `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', ...headers } })
  const sent = []
  const mailer = { enabled: true, async send(kind, msg) { sent.push({ kind, ...msg }); return { sent: true } } }
  const makeAuth = () => createAuth({ pool, logger: silent, mailer, limits: { signInGlobal: false } })

  async function insertUser(email, password) {
    const { rows } = await pool.query(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
       VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf', 10)), now(), '{}'::jsonb) RETURNING id`,
      [email, password]
    )
    return rows[0].id
  }

  /** Signs in with the password and sets up a passkey; returns { token, device, userId }. */
  async function setUp(auth, email, password) {
    const userId = await insertUser(email, password)
    const signIn = await auth.handleAuthRequest('sign-in', { email, password }, ctx())
    const token = signIn.body.data.session.access_token
    const device = softAuthenticator()
    const opts = await auth.handleAuthRequest('passkey/register-options', { access_token: token, password }, ctx())
    assert.equal(opts.status, 200, JSON.stringify(opts.body))
    const reg = await auth.handleAuthRequest('passkey/register', {
      access_token: token, challengeId: opts.body.data.challengeId, response: device.create(opts.body.data.options, APP), lang: 'de'
    }, ctx())
    assert.equal(reg.status, 200, JSON.stringify(reg.body))
    return { token, device, userId, passkey: reg.body.data.passkey }
  }

  async function passkeySignIn(auth, device, origin = APP) {
    const o = await auth.handleAuthRequest('passkey/login-options', {}, ctx())
    return auth.handleAuthRequest('passkey/login', { challengeId: o.body.data.challengeId, response: device.get(o.body.data.options, origin) }, ctx())
  }

  before(async () => {
    pg = (await import('pg')).default
    admin = new pg.Client({ connectionString: PG_TEST_URL })
    await admin.connect()
    await createDatabase(admin, dbName)
    const u = new URL(PG_TEST_URL)
    u.pathname = '/' + dbName
    pool = new pg.Pool({ connectionString: u.toString(), max: 5 })
    pool.on('connect', (client) => client.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query(testSchemaSql())
    for (const f of ['002_app_sessions.sql', '010_auth_tokens.sql', '022_passkeys.sql']) {
      const migration = await readFile(path.join(BACKEND, 'db', f), 'utf8')
      await pool.query(migration)
    }
    await pool.query(await readFile(path.join(BACKEND, 'db/022_passkeys.sql'), 'utf8')) // idempotent
  })

  after(async () => {
    await pool?.end()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      await admin.end()
    }
  })

  it('a key set up with the password signs in to its account, with a session like a password sign-in', async () => {
    const auth = makeAuth()
    const { device, userId, passkey } = await setUp(auth, 'anna@example.ch', 'pw-anna-123')
    assert.equal(passkey.label, 'iPhone · Safari')
    await auth.settle?.()
    const mail = sent.find((m) => m.kind === 'passkey_added' && m.to === 'anna@example.ch')
    assert.ok(mail, 'the account is mailed')
    assert.deepEqual(mail.vars, { device: 'iPhone · Safari' })
    assert.equal(mail.lang, 'de')

    const r = await passkeySignIn(auth, device, 'https://beach.openvolley.app')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.user.id, userId)
    assert.equal(r.body.data.session.token_type, 'bearer')
    const me = await auth.handleAuthRequest('get-user', { access_token: r.body.data.session.access_token }, ctx())
    assert.equal(me.status, 200)
    assert.equal(me.body.data.user.email, 'anna@example.ch')
    const { rows } = await pool.query('SELECT counter, last_used_at FROM auth.passkeys WHERE user_id = $1', [userId])
    assert.equal(Number(rows[0].counter), 1)
    assert.ok(rows[0].last_used_at)
  })

  it('setting one up needs the right password, and a session', async () => {
    const auth = makeAuth()
    await insertUser('beat@example.ch', 'pw-beat-123')
    const token = (await auth.handleAuthRequest('sign-in', { email: 'beat@example.ch', password: 'pw-beat-123' }, ctx())).body.data.session.access_token
    const none = await auth.handleAuthRequest('passkey/register-options', { access_token: token }, ctx())
    assert.equal(none.body.error.code, 'password_required')
    const wrong = await auth.handleAuthRequest('passkey/register-options', { access_token: token, password: 'nope' }, ctx())
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error.code, 'invalid_password')
    const anon = await auth.handleAuthRequest('passkey/register-options', { password: 'pw-beat-123' }, ctx())
    assert.equal(anon.status, 401)
  })

  it('a new password removes every key, and a removed key signs in nowhere', async () => {
    const auth = makeAuth()
    const { device, token, passkey } = await setUp(auth, 'carla@example.ch', 'pw-carla-123')
    const list = await auth.handleAuthRequest('passkey/list', { access_token: token }, ctx())
    assert.deepEqual(list.body.data.passkeys.map((p) => p.id), [passkey.id])

    await auth.setPassword('carla@example.ch', 'pw-carla-456')
    const after = await passkeySignIn(auth, device)
    assert.equal(after.status, 401)
    assert.equal(after.body.error.code, 'passkey_unknown')
  })

  it('a key is removed by its owner only', async () => {
    const auth = makeAuth()
    const a = await setUp(auth, 'dora@example.ch', 'pw-dora-123')
    const b = await setUp(auth, 'emil@example.ch', 'pw-emil-123')
    const foreign = await auth.handleAuthRequest('passkey/delete', { access_token: b.token, id: a.passkey.id }, ctx())
    assert.equal(foreign.status, 404)
    assert.equal((await passkeySignIn(auth, a.device)).status, 200)
    const own = await auth.handleAuthRequest('passkey/delete', { access_token: a.token, id: a.passkey.id }, ctx())
    assert.equal(own.status, 200)
    assert.equal((await passkeySignIn(auth, a.device)).body.error.code, 'passkey_unknown')
  })

  it('a deleted account\'s keys go with it', async () => {
    const auth = makeAuth()
    const { device, userId } = await setUp(auth, 'fritz@example.ch', 'pw-fritz-123')
    await pool.query('DELETE FROM auth.users WHERE id = $1', [userId])
    assert.equal((await passkeySignIn(auth, device)).body.error.code, 'passkey_unknown')
  })

  it('without the table the passkey actions say so, and nothing else changes', async () => {
    const auth = createAuth({ pool, logger: silent, mailer, passkeysTable: 'auth.no_such_table', limits: { signInGlobal: false } })
    const r = await auth.handleAuthRequest('passkey/login-options', {}, ctx())
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'passkeys_unavailable')
  })
})
