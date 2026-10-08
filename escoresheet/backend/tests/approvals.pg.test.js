// lib/approvals.js on Postgres (docs/account-approval-spec.md 6.1): the
// approval PIN, approving per slot, the order of the checks, the lockout,
// one slot per account, stale results, closed matches, undo, visibility,
// races, account deletion and the admin search.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { createAccessResolver } from '../lib/access.js'
import { createAccounts } from '../lib/accounts.js'
import { createAuth } from '../lib/auth.js'
import { createApprovals, approvalRoleFor, callerRolesFor, PIN_LOCK_EVERY } from '../lib/approvals.js'
import { macPin, deriveKeys } from '../lib/approvalPin.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

const SESSIONS_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', '002_app_sessions.sql'), 'utf8')

const SECRET = 'x'.repeat(40)
const PW = 'Pw-correct-9d2f'
const SETS = [[1, 25, 20], [2, 23, 25], [3, 25, 18], [4, 25, 22]]
const KEY = 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:25:22'
const RECORD_KEYS = ['id', 'short_id', 'slot', 'name', 'approved_at', 'result_key', 'result_matches', 'mine']

describe('account approvals on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, db, access, auth, approvals, accounts, logger
  const U = {}
  let seq = 0
  let gameSeq = 91000
  const allPins = new Set()

  async function user (name, roles, { first = name[0].toUpperCase() + name.slice(1), last = 'Test', confirmed = true, pin } = {}) {
    const id = randomUUID()
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    await pool.query('INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)',
      [id, email, await auth._hashPassword(PW), confirmed])
    await pool.query('INSERT INTO public.profiles (user_id, first_name, last_name, roles) VALUES ($1, $2, $3, $4)', [id, first, last, roles])
    U[name] = { id, email, pin }
    if (pin) {
      allPins.add(pin)
      const r = await approvals.setPin({ userId: id, body: { password: PW, pin } })
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`)
    }
    return U[name]
  }

  async function newMatch (owner, { status = 'ended', sets = SETS, sport = 'indoor', test = false } = {}) {
    const ext = `appr_${++seq}_${randomBytes(2).toString('hex')}`
    const gameN = gameSeq++
    const { rows: [m] } = await pool.query(
      `INSERT INTO public.matches (external_id, status, created_by, sport_type, game_n, test, home_team, away_team)
       VALUES ($1, $2, $3, $4, $5, $6, '{"name":"Home"}', '{"name":"Away"}') RETURNING id`,
      [ext, status, U[owner].id, sport, gameN, test])
    // as each app stores them: indoor home_points / away_points, OpenBeach
    // team1_points / team2_points (its home / away columns keep their default 0)
    const cols = sport === 'beach' ? 'team1_points, team2_points, sport_type' : 'home_points, away_points, sport_type'
    for (const [index, h, a] of sets) {
      await pool.query(`INSERT INTO public.sets (match_id, index, ${cols}, finished) VALUES ($1, $2, $3, $4, $5, true)`, [m.id, index, h, a, sport])
    }
    return { id: m.id, ext, gameN }
  }

  async function approveAs (caller, m, slot, official, { pin, sets = SETS, email, deviceId, ip = '203.0.113.7' } = {}) {
    const body = { external_id: m.ext ?? m, slot, email: email ?? U[official].email, pin: pin ?? U[official].pin, result: { sets } }
    if (deviceId !== undefined) body.device_id = deviceId
    return approvals.approve({ callerId: U[caller].id, access: await access.get(U[caller].id), body, ip })
  }
  const listAs = async (caller, m) => approvals.listForMatch({ callerId: U[caller].id, access: await access.get(U[caller].id), externalId: m.ext })
  const undoAs = async (caller, id) => approvals.revoke({ callerId: U[caller].id, access: await access.get(U[caller].id), id })
  const expectErr = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    assert.equal(r.body.error?.code, code, JSON.stringify(r.body))
  }
  const auditOf = async (action, matchId) => (await pool.query(
    `SELECT * FROM public.audit_log WHERE action = $1 ${matchId ? 'AND match_id = $2' : ''} ORDER BY id`, matchId ? [action, matchId] : [action])).rows
  const pinRow = async (name) => (await pool.query('SELECT * FROM auth.approval_pins WHERE user_id = $1', [U[name].id])).rows[0]
  const rowsOf = async (m) => (await pool.query('SELECT * FROM public.match_approvals WHERE match_id = $1 ORDER BY approved_at, id', [m.id])).rows
  const closeMatch = (m) => pool.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [m.id])

  before(async () => {
    tdb = await createTestDatabase('approvals', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    logger = quietLogger()
    pool = new pg.Pool({ connectionString: tdb.url, options: '-c TimeZone=UTC', max: 12 })
    db = createPgQuery({ pool, logger })
    access = createAccessResolver({ pool, ttlMs: 0 })
    auth = createAuth({ pool, bcryptCost: 4, logger })
    approvals = createApprovals({ pool, auth, secret: SECRET, logger })
    accounts = createAccounts({ pool, db, restore: createMatchRestore(db, { logger }), access, logger, approvalsForMatches: approvals.approvalsForMatches })
    await user('owner', ['scorer'], { first: 'Olga', last: 'Owner', pin: '615038' })
    await user('ref1', ['referee'], { first: 'Anna', last: 'Muster', pin: '482917' })
    await user('ref2', ['referee'], { first: 'Ben', last: 'Beispiel', pin: '730164' })
    await user('ref3', ['referee'], { first: 'Cleo', last: 'Dritt', pin: '205819' })
    await user('scorer2', ['scorer'], { first: 'Sam', last: 'Zweit', pin: '918273' })
    await user('admin', ['admin'], { first: 'Ada', last: 'Admin' })
    await user('stranger', ['scorer'], { first: 'Stan', last: 'Fremd' })
    await user('plain', [], { first: 'Paul', last: 'Plain' })
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  describe('approval PIN', () => {
    it('status: available, eligible by role and confirmed address, set or not', async () => {
      const s = await approvals.getPinStatus({ userId: U.ref1.id })
      assert.equal(s.status, 200)
      assert.equal(s.body.data.available, true)
      assert.equal(s.body.data.eligible, true)
      assert.equal(s.body.data.set, true)
      assert.ok(Date.parse(s.body.data.set_at) > Date.now() - 60000)
      assert.deepEqual({ ...s.body.data, set_at: null }, { available: true, eligible: true, set: true, set_at: null, locked_until: null, disabled: false })
      const p = await approvals.getPinStatus({ userId: U.plain.id })
      assert.deepEqual(p.body.data, { available: true, eligible: false, set: false, set_at: null, locked_until: null, disabled: false })
      const unc = await user('uncStatus', ['referee'], { confirmed: false })
      assert.equal((await approvals.getPinStatus({ userId: unc.id })).body.data.eligible, false)
      // a row of an older key generation reads as not set
      await pool.query('UPDATE auth.approval_pins SET key_id = 2 WHERE user_id = $1', [U.scorer2.id])
      assert.equal((await approvals.getPinStatus({ userId: U.scorer2.id })).body.data.set, false)
      await pool.query('UPDATE auth.approval_pins SET key_id = 1 WHERE user_id = $1', [U.scorer2.id])
    })

    it('set: body, format, weak, confirmed address, role, password; stored as an HMAC; audited', async () => {
      const me = await user('setter', ['referee'])
      const set = (body) => approvals.setPin({ userId: me.id, body })
      expectErr(await set({ password: PW, pin: 482917 }), 400, 'OV_INVALID_REQUEST')
      expectErr(await set({ pin: '482917' }), 400, 'OV_INVALID_REQUEST')
      expectErr(await set({ password: 'é'.repeat(37), pin: '482917' }), 400, 'OV_INVALID_REQUEST')
      expectErr(await set(null), 400, 'OV_INVALID_REQUEST')
      expectErr(await set({ password: PW, pin: '123' }), 400, 'OV_APPROVAL_PIN_FORMAT')
      expectErr(await set({ password: PW, pin: '1234567' }), 400, 'OV_APPROVAL_PIN_FORMAT')
      expectErr(await set({ password: PW, pin: '123456' }), 400, 'OV_APPROVAL_PIN_WEAK')
      expectErr(await set({ password: PW, pin: '0000' }), 400, 'OV_APPROVAL_PIN_WEAK')
      const unc = await user('uncSetter', ['referee'], { confirmed: false })
      expectErr(await approvals.setPin({ userId: unc.id, body: { password: PW, pin: '482917' } }), 409, 'OV_EMAIL_UNCONFIRMED')
      const noRole = await approvals.setPin({ userId: U.plain.id, body: { password: PW, pin: '482917' } })
      expectErr(noRole, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(noRole.body.error.details, { roles: ['referee', 'scorer'] })

      // a wrong password is 403 (never 401) and counts in the sign-in lockout of the address
      expectErr(await set({ password: 'wrong-password', pin: '482917' }), 403, 'OV_PASSWORD_INVALID')
      assert.equal(auth.lockout.check(me.email).failures, 1)
      assert.equal(await pinRow('setter'), undefined)

      const ok1 = await set({ password: PW, pin: '048213' })
      assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
      assert.equal(ok1.body.data.set, true)
      assert.equal(auth.lockout.check(me.email).failures, 0, 'a right password clears the failures')
      const row = await pinRow('setter')
      assert.equal(row.salt.length, 16)
      assert.equal(row.mac.length, 32)
      assert.deepEqual(row.mac, macPin(deriveKeys(SECRET).pinKey, row.salt, me.id, '048213'))
      assert.equal(JSON.stringify(row).includes('048213'), false)
      // change: new salt, counters reset
      await pool.query('UPDATE auth.approval_pins SET failed_attempts = 7, disabled_at = now(), locked_until = now() + interval \'1 hour\' WHERE user_id = $1', [me.id])
      assert.equal((await set({ password: PW, pin: '590371' })).status, 200)
      const row2 = await pinRow('setter')
      assert.notDeepEqual(row2.salt, row.salt)
      assert.deepEqual([row2.failed_attempts, row2.disabled_at, row2.locked_until, row2.last_failed_at], [0, null, null, null])
      const audits = (await auditOf('approval_pin.set')).filter((a) => a.target_user_id === me.id)
      assert.deepEqual(audits.map((a) => [a.actor_id, a.details]), [[me.id, { changed: false }], [me.id, { changed: true }]])
    })

    it('remove: password required, idempotent, audited once', async () => {
      const me = await user('remover', ['scorer'], { pin: '381946' })
      const rm = (password) => approvals.removePin({ userId: me.id, body: { password } })
      expectErr(await approvals.removePin({ userId: me.id, body: {} }), 400, 'OV_INVALID_REQUEST')
      expectErr(await rm('nope'), 403, 'OV_PASSWORD_INVALID')
      assert.ok(await pinRow('remover'))
      const r = await rm(PW)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data, { set: false })
      assert.equal(await pinRow('remover'), undefined)
      assert.deepEqual((await rm(PW)).body.data, { set: false }, 'idempotent')
      assert.equal((await auditOf('approval_pin.remove')).filter((a) => a.target_user_id === me.id).length, 1)
    })

    it('the sign-in lockout of the address answers 429 with Retry-After', async () => {
      const me = await user('locker', ['referee'])
      for (let i = 0; i < 10; i++) expectErr(await approvals.setPin({ userId: me.id, body: { password: 'bad', pin: '482917' } }), 403, 'OV_PASSWORD_INVALID')
      const r = await approvals.setPin({ userId: me.id, body: { password: PW, pin: '482917' } })
      expectErr(r, 429, 'OV_TOO_MANY_ATTEMPTS')
      assert.ok(Number(r.headers['Retry-After']) > 0)
      // the same address cannot sign in either
      const s = await auth.handleAuthRequest('sign-in', { email: me.email, password: PW }, { ip: '198.51.100.1' })
      assert.equal(s.status, 429)
      auth.lockout.reset(me.email)
    })

    it('without OV_PIN_SECRET: status says unavailable, everything else is 503', async () => {
      const off = createApprovals({ pool, auth, secret: null, logger })
      assert.deepEqual((await off.getPinStatus({ userId: U.ref1.id })).body.data, { available: false, eligible: false, set: false, set_at: null, locked_until: null, disabled: false })
      expectErr(await off.setPin({ userId: U.ref1.id, body: { password: PW, pin: '482917' } }), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectErr(await off.removePin({ userId: U.ref1.id, body: { password: PW } }), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectErr(await off.approve({ callerId: U.owner.id, body: { external_id: 'x', slot: 'scorer', email: 'a@b.ch', pin: '482917', result: { sets: [] } } }), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectErr(await off.listForMatch({ callerId: U.owner.id, externalId: 'x' }), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectErr(await off.revoke({ callerId: U.owner.id, id: randomUUID() }), 503, 'OV_APPROVAL_UNAVAILABLE')
      assert.throws(() => createApprovals({ pool, secret: 'short' }), /at least 32/)
    })
  })

  describe('approve', () => {
    it('happy path for all three slots; records carry no ids, emails or hashes; audited', async () => {
      const m = await newMatch('owner')
      const devId = randomUUID()
      const r1 = await approveAs('owner', m, 'referee1', 'ref1', { deviceId: devId })
      assert.equal(r1.status, 200, JSON.stringify(r1.body))
      assert.equal(r1.body.data.already, false)
      const rec = r1.body.data.approval
      assert.deepEqual(Object.keys(rec), RECORD_KEYS)
      assert.equal(rec.slot, 'referee1')
      assert.equal(rec.name, 'Muster Anna', '"Last First", as the PDF')
      assert.equal(rec.result_key, KEY)
      assert.equal(rec.result_matches, true)
      assert.equal(rec.mine, false, 'the caller is not the approver')
      assert.equal(rec.short_id, rec.id.slice(0, 8).toUpperCase())
      const r2 = await approveAs('owner', m, 'referee2', 'ref2')
      assert.equal(r2.status, 200, JSON.stringify(r2.body))
      const r3 = await approveAs('owner', m, 'scorer', 'owner')
      assert.equal(r3.status, 200, JSON.stringify(r3.body))
      assert.equal(r3.body.data.approval.mine, true)
      assert.equal(r3.body.data.approval.name, 'Owner Olga')
      // the stored row
      const rows = await rowsOf(m)
      assert.equal(rows.length, 3)
      const [row1] = rows
      assert.equal(row1.user_id, U.ref1.id)
      assert.equal(row1.requested_by, U.owner.id)
      assert.equal(row1.match_status, 'ended')
      assert.equal(row1.ip_hash.toString('hex'), '95eef55bcfc176347ee83e195b4b67d6919c3d60684254dc30d46f4a1969cfc1')
      assert.equal(row1.device_hash.length, 32)
      assert.equal(rows[1].device_hash, null)
      // the PIN counters: last used, nothing failed
      const p = await pinRow('ref1')
      assert.equal(p.failed_attempts, 0)
      assert.ok(p.last_used_at)
      // audit
      const audits = await auditOf('match.approve', m.id)
      assert.equal(audits.length, 3)
      assert.equal(audits[0].actor_id, U.owner.id)
      assert.equal(audits[0].target_user_id, U.ref1.id)
      assert.deepEqual(audits[0].details, { slot: 'referee1', short_id: rec.short_id, external_id: m.ext, game_n: m.gameN, result_key: KEY })
      // the list, ordered by slot
      const l = await listAs('owner', m)
      assert.equal(l.status, 200)
      assert.deepEqual(l.body.data.match, { status: 'ended', closed_at: null, result_key: KEY })
      assert.deepEqual(l.body.data.approvals.map((a) => a.slot), ['referee1', 'referee2', 'scorer'])
      for (const a of l.body.data.approvals) assert.deepEqual(Object.keys(a), RECORD_KEYS)
      assert.equal(/@|user_id|hash/.test(JSON.stringify(l.body)), false)
    })

    it('checks in the contract order', async () => {
      const m = await newMatch('owner')
      const good = { external_id: m.ext, slot: 'referee1', email: U.ref1.email, pin: U.ref1.pin, result: { sets: SETS } }
      const call = (body, caller = 'owner') => access.get(U[caller].id).then((a) => approvals.approve({ callerId: U[caller].id, access: a, body, ip: '203.0.113.9' }))
      // 1. body
      for (const body of [null, { ...good, external_id: '' }, { ...good, external_id: 'x'.repeat(201) }, { ...good, slot: 'assistant' },
        { ...good, email: 'nope' }, { ...good, email: `${'a'.repeat(250)}@x.ch` }, { ...good, pin: 482917 }, { ...good, result: null },
        { ...good, result: { sets: [[1, 25]] } }, { ...good, result: { sets: [[0, 25, 20]] } }, { ...good, result: { sets: [[1, 100, 20]] } },
        { ...good, result: { sets: [[1, 25.5, 20]] } }, { ...good, result: { sets: Array(6).fill([1, 25, 20]) } }, { ...good, device_id: 'abc' }]) {
        expectErr(await call(body), 400, 'OV_INVALID_REQUEST')
      }
      // 3. unknown match
      expectErr(await call({ ...good, external_id: 'no-such-match' }), 404, 'OV_NOT_FOUND')
      // 4. beach
      const beach = await newMatch('owner', { sport: 'beach' })
      expectErr(await call({ ...good, external_id: beach.ext }), 409, 'OV_APPROVAL_UNSUPPORTED')
      // 5. the caller may not write the match (before anything about the match is told)
      expectErr(await call(good, 'stranger'), 403, 'OV_NOT_MATCH_OWNER')
      expectErr(await call(good, 'ref1'), 403, 'OV_NOT_MATCH_OWNER')
      // 7. not ended
      const live = await newMatch('owner', { status: 'live' })
      const nl = await call({ ...good, external_id: live.ext })
      expectErr(nl, 409, 'OV_MATCH_NOT_ENDED')
      assert.deepEqual(nl.body.error.details, { status: 'live' })
      // 8. result differs: the server's sets in details
      const ns = await call({ ...good, result: { sets: SETS.slice(0, 3) } })
      expectErr(ns, 409, 'OV_RESULT_NOT_SYNCED')
      assert.deepEqual(ns.body.error.details, { server: SETS })
      const empty = await newMatch('owner', { sets: [] })
      expectErr(await call({ ...good, external_id: empty.ext, result: { sets: [] } }), 409, 'OV_RESULT_NOT_SYNCED')
      // 9. unknown email answers exactly like a wrong PIN
      const unknown = await call({ ...good, email: 'ghost@example.ch' })
      const wrong = await call({ ...good, pin: '000001' })
      expectErr(unknown, 403, 'OV_APPROVAL_PIN_INVALID')
      assert.deepEqual(unknown, wrong)
      assert.equal(unknown.body.error.details, undefined)
      assert.equal((await pinRow('ref1')).failed_attempts, 1, 'the wrong PIN counted')
      // the email is matched case-insensitively
      const r = await call({ ...good, email: U.ref1.email.toUpperCase() })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal((await pinRow('ref1')).failed_attempts, 1, 'a right PIN does not clear the rolling count')
      await pool.query('UPDATE auth.approval_pins SET failed_attempts = 0, last_failed_at = NULL WHERE user_id = $1', [U.ref1.id])
      // an admin who is not the owner may send it
      const m2 = await newMatch('owner')
      assert.equal((await call({ ...good, external_id: m2.ext }, 'admin')).status, 200)
    })

    it('eligibility is checked only after a right PIN', async () => {
      const m = await newMatch('owner')
      // a referee who lost the role: a wrong PIN tells nothing, the right one says why
      const lost = await user('lostRole', ['referee'], { first: 'Lea', last: 'Los', pin: '603917' })
      await pool.query("UPDATE public.profiles SET roles = '{}' WHERE user_id = $1", [lost.id])
      expectErr(await approveAs('owner', m, 'referee1', 'lostRole', { pin: '603918' }), 403, 'OV_APPROVAL_PIN_INVALID')
      const rr = await approveAs('owner', m, 'referee1', 'lostRole')
      expectErr(rr, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(rr.body.error.details, { role: 'referee' })
      const lr = await pinRow('lostRole')
      assert.equal(lr.failed_attempts, 1, 'the failure is committed with the refusal')
      assert.ok(lr.last_used_at, 'and so is the use of the right PIN')
      // a referee cannot take the scorer slot; a scorer cannot take a referee slot
      const rs = await approveAs('owner', m, 'scorer', 'ref1')
      expectErr(rs, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(rs.body.error.details, { role: 'scorer' })
      expectErr(await approveAs('owner', m, 'referee2', 'scorer2'), 403, 'OV_APPROVAL_ROLE_REQUIRED')
      // admin alone does not make a scorer (D2)
      await user('adminPin', ['admin', 'referee'], { first: 'Ari', last: 'Admin', pin: '471920' })
      expectErr(await approveAs('owner', m, 'scorer', 'adminPin'), 403, 'OV_APPROVAL_ROLE_REQUIRED')
      // the scorer slot needs the match's creator or an editor
      expectErr(await approveAs('owner', m, 'scorer', 'scorer2'), 403, 'OV_APPROVAL_NOT_MATCH_SCORER')
      await pool.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'admin')", [m.id, U.scorer2.id])
      const ok1 = await approveAs('owner', m, 'scorer', 'scorer2')
      assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
      assert.equal(ok1.body.data.approval.name, 'Zweit Sam')
      // an address confirmed no more
      const unc = await user('uncRef', ['referee'], { pin: '836104' })
      await pool.query('UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1', [unc.id])
      expectErr(await approveAs('owner', m, 'referee2', 'uncRef'), 409, 'OV_EMAIL_UNCONFIRMED')
      // a profile without a name
      const nameless = await user('nameless', ['referee'], { pin: '952608' })
      await pool.query("UPDATE public.profiles SET first_name = '  ', last_name = NULL WHERE user_id = $1", [nameless.id])
      expectErr(await approveAs('owner', m, 'referee2', 'nameless'), 409, 'OV_APPROVAL_NAME_REQUIRED')
      // a banned account is unknown
      const banned = await user('banned', ['referee'], { pin: '284716' })
      await pool.query('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz')
      await pool.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [banned.id])
      expectErr(await approveAs('owner', m, 'referee2', 'banned'), 403, 'OV_APPROVAL_PIN_INVALID')
      assert.equal((await pinRow('banned')).failed_attempts, 0, 'an unknown account is not counted')
      assert.equal((await rowsOf(m)).length, 1)
    })

    it('lockout: 5 wrong PINs lock for 15 min, 10 disable; a paused PIN answers like a wrong one; audited and committed', async () => {
      const m = await newMatch('owner')
      const lk = await user('lockRef', ['referee'], { first: 'Lou', last: 'Lock', pin: '709152' })
      for (let i = 1; i <= 5; i++) expectErr(await approveAs('owner', m, 'referee1', 'lockRef', { pin: '100000' }), 403, 'OV_APPROVAL_PIN_INVALID')
      let p = await pinRow('lockRef')
      assert.equal(p.failed_attempts, 5)
      assert.ok(p.locked_until > new Date(Date.now() + 14 * 60000))
      assert.equal(p.disabled_at, null)
      // locked: even the right PIN answers exactly like an unknown address (no oracle), not counted
      const locked = await approveAs('owner', m, 'referee1', 'lockRef')
      const ghost = await approveAs('owner', m, 'referee1', 'lockRef', { email: 'ghost@example.ch' })
      expectErr(locked, 403, 'OV_APPROVAL_PIN_INVALID')
      assert.deepEqual(locked, ghost)
      assert.equal((await pinRow('lockRef')).failed_attempts, 5, 'not counted while locked')
      const [a1] = await auditOf('approval_pin.locked', m.id)
      assert.equal(a1.actor_id, U.owner.id)
      assert.equal(a1.target_user_id, lk.id)
      assert.equal(a1.details.failures, 5)
      assert.equal(a1.details.disabled, false)
      assert.ok(a1.details.locked_until)
      // the owner sees it in the profile
      assert.ok((await approvals.getPinStatus({ userId: lk.id })).body.data.locked_until)
      // the lock expires
      await pool.query("UPDATE auth.approval_pins SET locked_until = now() - interval '1 second' WHERE user_id = $1", [lk.id])
      for (let i = 6; i <= 10; i++) expectErr(await approveAs('owner', m, 'referee1', 'lockRef', { pin: '100000' }), 403, 'OV_APPROVAL_PIN_INVALID')
      p = await pinRow('lockRef')
      assert.equal(p.failed_attempts, 10)
      assert.ok(p.disabled_at)
      await pool.query("UPDATE auth.approval_pins SET locked_until = now() - interval '1 second' WHERE user_id = $1", [lk.id])
      const dis = await approveAs('owner', m, 'referee1', 'lockRef')
      assert.deepEqual(dis, ghost, 'disabled: the same answer as a wrong PIN')
      const audits = await auditOf('approval_pin.locked', m.id)
      assert.equal(audits.length, 2)
      assert.deepEqual([audits[1].details.failures, audits[1].details.disabled], [10, true])
      assert.equal((await approvals.getPinStatus({ userId: lk.id })).body.data.disabled, true)
      // only a new PIN (with the password) clears it
      assert.equal((await approvals.setPin({ userId: lk.id, body: { password: PW, pin: '518203' } })).status, 200)
      U.lockRef.pin = '518203'
      allPins.add('518203')
      assert.equal((await approveAs('owner', m, 'referee1', 'lockRef')).status, 200)
    })

    it('the failure count is rolling: a right PIN does not clear it, 30 quiet days restart it (review fix)', async () => {
      const m = await newMatch('owner')
      const rs = await user('rollRef', ['referee'], { first: 'Rolf', last: 'Roll', pin: '362915' })
      for (let i = 0; i < 4; i++) expectErr(await approveAs('owner', m, 'referee2', 'rollRef', { pin: '362916' }), 403, 'OV_APPROVAL_PIN_INVALID')
      const ok1 = await approveAs('owner', m, 'referee2', 'rollRef')
      assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
      assert.equal((await pinRow('rollRef')).failed_attempts, 4, 'a right PIN keeps the count')
      // the official's next approval: one more wrong PIN locks (5 in the window)
      await undoAs('owner', ok1.body.data.approval.id)
      expectErr(await approveAs('owner', m, 'referee2', 'rollRef', { pin: '362916' }), 403, 'OV_APPROVAL_PIN_INVALID')
      let p = await pinRow('rollRef')
      assert.equal(p.failed_attempts, 5)
      assert.ok(p.locked_until > new Date())
      // 30 days without a failure: the count starts again at 1
      await pool.query("UPDATE auth.approval_pins SET locked_until = NULL, last_failed_at = now() - interval '31 days' WHERE user_id = $1", [rs.id])
      expectErr(await approveAs('owner', m, 'referee2', 'rollRef', { pin: '362916' }), 403, 'OV_APPROVAL_PIN_INVALID')
      p = await pinRow('rollRef')
      assert.equal(p.failed_attempts, 1)
      assert.equal(p.disabled_at, null)
    })

    it('a malformed PIN is refused before any lookup and never counted (review fix)', async () => {
      const m = await newMatch('owner')
      const before = (await pinRow('ref2')).failed_attempts
      for (const pin of ['123', '12', '', '1234567', '12a4']) {
        expectErr(await approveAs('owner', m, 'referee2', 'ref2', { pin }), 400, 'OV_APPROVAL_PIN_FORMAT')
      }
      assert.equal((await pinRow('ref2')).failed_attempts, before)
    })

    it('the scoring side cannot fill a referee slot, even under the referee\'s name (review fix)', async () => {
      // a club volunteer with both roles scores the match and renames itself
      const dual = await user('dual', ['scorer', 'referee'], { first: 'Dora', last: 'Doppel', pin: '583027' })
      const m = await newMatch('dual')
      await pool.query("UPDATE public.profiles SET first_name = 'Anna', last_name = 'Muster' WHERE user_id = $1", [dual.id])
      const self = await approveAs('dual', m, 'referee1', 'dual')
      expectErr(self, 403, 'OV_APPROVAL_SCORER_NOT_REFEREE')
      // the scorer slot stays theirs
      assert.equal((await approveAs('dual', m, 'scorer', 'dual')).status, 200)
      // an editor of the match (game PIN) with the referee role: refused as well
      const ed = await user('editorRef', ['referee'], { first: 'Edi', last: 'Tor', pin: '692041' })
      await pool.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'game_pin')", [m.id, ed.id])
      expectErr(await approveAs('dual', m, 'referee2', 'editorRef'), 403, 'OV_APPROVAL_SCORER_NOT_REFEREE')
      // the account that sends it (an admin helping out) cannot approve itself as referee
      const adm = await user('adminRef', ['admin', 'referee'], { first: 'Adi', last: 'Ref', pin: '847203' })
      expectErr(await approveAs('adminRef', m, 'referee1', 'adminRef'), 403, 'OV_APPROVAL_SCORER_NOT_REFEREE')
      assert.ok(adm.id)
      // a real referee still can
      assert.equal((await approveAs('dual', m, 'referee1', 'ref1')).status, 200)
      assert.deepEqual((await rowsOf(m)).map((r) => [r.slot, r.user_id]), [['scorer', dual.id], ['referee1', U.ref1.id]])
    })

    it('an account without the scorer or referee role cannot send approvals, not even on its own test match (review fix)', async () => {
      const m = await newMatch('plain', { test: true })
      const before = (await pinRow('ref1')).failed_attempts
      for (let i = 0; i < 6; i++) {
        expectErr(await approveAs('plain', m, 'referee1', 'ref1', { pin: '100000' }), 403, 'OV_APPROVAL_CALLER_ROLE')
      }
      assert.equal((await pinRow('ref1')).failed_attempts, before, 'the official\'s counter is not touched')
      assert.equal((await pinRow('ref1')).locked_until, null)
    })

    it('one slot per account, a taken slot, an idempotent retry', async () => {
      const m = await newMatch('owner')
      assert.equal((await approveAs('owner', m, 'referee1', 'ref1')).status, 200)
      const one = await approveAs('owner', m, 'referee2', 'ref1')
      expectErr(one, 409, 'OV_APPROVAL_ONE_SLOT')
      assert.deepEqual(one.body.error.details, { slot: 'referee1' })
      const taken = await approveAs('owner', m, 'referee1', 'ref2')
      expectErr(taken, 409, 'OV_APPROVAL_SLOT_TAKEN')
      assert.equal(taken.body.error.details.name, 'Muster Anna')
      assert.ok(taken.body.error.details.approved_at)
      const again = await approveAs('owner', m, 'referee1', 'ref1')
      assert.equal(again.status, 200)
      assert.equal(again.body.data.already, true)
      assert.equal((await auditOf('match.approve', m.id)).length, 1, 'no second audit row')
      assert.equal((await rowsOf(m)).length, 1, 'no second row')
    })

    it('a changed result: stale approvals read as such and a new approval replaces them', async () => {
      const m = await newMatch('owner')
      assert.equal((await approveAs('owner', m, 'referee1', 'ref1')).status, 200)
      assert.equal((await approveAs('owner', m, 'referee2', 'ref2')).status, 200)
      await pool.query('UPDATE public.sets SET home_points = 26, away_points = 24 WHERE match_id = $1 AND index = 1', [m.id])
      const NEW = [[1, 26, 24], ...SETS.slice(1)]
      const l = await listAs('owner', m)
      assert.deepEqual(l.body.data.approvals.map((a) => a.result_matches), [false, false])
      assert.equal(l.body.data.match.result_key, 'ov-result-v1|1:26:24,2:23:25,3:25:18,4:25:22')
      // the old client result is refused
      expectErr(await approveAs('owner', m, 'referee1', 'ref1'), 409, 'OV_RESULT_NOT_SYNCED')
      // the same official approves again
      const r = await approveAs('owner', m, 'referee1', 'ref1', { sets: NEW })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.already, false)
      // another official takes the stale slot of someone else
      const r2 = await approveAs('owner', m, 'referee2', 'ref3', { sets: NEW })
      assert.equal(r2.status, 200, JSON.stringify(r2.body))
      const rows = await rowsOf(m)
      assert.deepEqual(rows.map((x) => [x.slot, x.revoked_reason, x.revoked_by]), [
        ['referee1', 'result_changed', U.owner.id], ['referee2', 'result_changed', U.owner.id], ['referee1', null, null], ['referee2', null, null]])
      // a stale approval in another slot does not block the account: it is revoked first
      await pool.query('UPDATE public.sets SET home_points = 27, away_points = 25 WHERE match_id = $1 AND index = 1', [m.id])
      const NEW2 = [[1, 27, 25], ...SETS.slice(1)]
      const r3 = await approveAs('owner', m, 'referee2', 'ref1', { sets: NEW2 })
      assert.equal(r3.status, 200, JSON.stringify(r3.body))
      assert.deepEqual((await listAs('owner', m)).body.data.approvals.map((a) => [a.slot, a.name, a.result_matches]), [['referee2', 'Muster Anna', true]])
    })

    it('a closed match refuses approve and undo; the admin reopen voids, then new approvals are taken', async () => {
      const m = await newMatch('owner')
      const a = await approveAs('owner', m, 'referee1', 'ref1')
      assert.equal(a.status, 200)
      await closeMatch(m)
      expectErr(await approveAs('owner', m, 'referee2', 'ref2'), 409, 'OV_MATCH_CLOSED')
      expectErr(await undoAs('owner', a.body.data.approval.id), 409, 'OV_MATCH_CLOSED')
      expectErr(await undoAs('ref1', a.body.data.approval.id), 409, 'OV_MATCH_CLOSED')
      const l = await listAs('owner', m)
      assert.ok(l.body.data.match.closed_at, 'the list says closed')
      assert.equal(l.body.data.approvals.length, 1, 'closing keeps the approvals')
      // admin reopen
      const re = await accounts.reopenMatch({ actorId: U.admin.id, matchId: m.id, body: { reason: 'Wrong score' } })
      assert.equal(re.status, 200, JSON.stringify(re.body))
      assert.deepEqual((await listAs('owner', m)).body.data.approvals, [])
      const [row] = await rowsOf(m)
      assert.deepEqual([row.revoked_reason, row.revoked_by], ['match_reopened', U.admin.id])
      const [v] = await auditOf('match.approval_void', m.id)
      assert.equal(v.actor_id, U.admin.id)
      assert.deepEqual(v.details, { count: 1, reason: 'match_reopened', external_id: m.ext, game_n: m.gameN })
      const again = await approveAs('owner', m, 'referee1', 'ref1')
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.equal(again.body.data.already, false)
    })

    it('reopening the last set (ended -> live through /api/db) voids them', async () => {
      const m = await newMatch('owner')
      assert.equal((await approveAs('owner', m, 'referee1', 'ref1')).status, 200)
      const w = await db.runQuery({ table: 'matches', action: 'update', params: { data: { status: 'live' }, filters: [{ type: 'eq', column: 'id', value: m.id }] } },
        { proto: 2, matchOwner: { userId: U.owner.id }, actorId: U.owner.id })
      assert.equal(w.status, 200, JSON.stringify(w.body))
      const [row] = await rowsOf(m)
      assert.deepEqual([row.revoked_reason, row.revoked_by], ['match_reopened', U.owner.id])
      expectErr(await approveAs('owner', m, 'referee1', 'ref1'), 409, 'OV_MATCH_NOT_ENDED')
    })

    it('test matches may be approved (D6), and stay undoable after approved', async () => {
      const m = await newMatch('owner', { test: true })
      const a = await approveAs('owner', m, 'referee1', 'ref1')
      assert.equal(a.status, 200)
      await closeMatch(m)
      const u = await undoAs('owner', a.body.data.approval.id)
      assert.equal(u.status, 200, JSON.stringify(u.body))
    })

    it('parallel approves of one slot by two officials: exactly one wins', async () => {
      const m = await newMatch('owner')
      const results = await Promise.all([approveAs('owner', m, 'referee1', 'ref1'), approveAs('owner', m, 'referee1', 'ref2')])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      expectErr(results.find((r) => r.status === 409), 409, 'OV_APPROVAL_SLOT_TAKEN')
      assert.equal((await rowsOf(m)).length, 1)
    })
  })

  describe('undo and visibility', () => {
    it('undo by the approver, by the owner; a stranger is refused; twice is already', async () => {
      const m = await newMatch('owner')
      const a1 = (await approveAs('owner', m, 'referee1', 'ref1')).body.data.approval
      const a2 = (await approveAs('owner', m, 'referee2', 'ref2')).body.data.approval
      expectErr(await undoAs('stranger', a1.id), 403, 'OV_FORBIDDEN')
      expectErr(await undoAs('ref2', a1.id), 403, 'OV_FORBIDDEN')
      expectErr(await undoAs('owner', randomUUID()), 404, 'OV_NOT_FOUND')
      const byApprover = await undoAs('ref1', a1.id)
      assert.equal(byApprover.status, 200, JSON.stringify(byApprover.body))
      assert.equal(byApprover.body.data.already, false)
      assert.equal(byApprover.body.data.approval.mine, true)
      assert.equal(byApprover.body.data.approval.revoked_reason, 'undo')
      const twice = await undoAs('owner', a1.id)
      assert.equal(twice.status, 200)
      assert.equal(twice.body.data.already, true)
      const byOwner = await undoAs('owner', a2.id)
      assert.equal(byOwner.status, 200)
      const audits = await auditOf('match.approval_revoke', m.id)
      assert.deepEqual(audits.map((a) => [a.actor_id, a.target_user_id, a.details]), [
        [U.ref1.id, U.ref1.id, { slot: 'referee1', short_id: a1.short_id, external_id: m.ext, reason: 'undo' }],
        [U.owner.id, U.ref2.id, { slot: 'referee2', short_id: a2.short_id, external_id: m.ext, reason: 'undo' }]])
      const rows = await rowsOf(m)
      assert.deepEqual(rows.map((r) => [r.revoked_reason, r.revoked_by]), [['undo', U.ref1.id], ['undo', U.owner.id]])
      // the slot is free again
      assert.equal((await approveAs('owner', m, 'referee1', 'ref2')).status, 200)
    })

    it('GET: owner, editor and admin see all; the approver only their own; a stranger is refused', async () => {
      const m = await newMatch('owner')
      await approveAs('owner', m, 'referee1', 'ref1')
      await approveAs('owner', m, 'referee2', 'ref2')
      await pool.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'game_pin')", [m.id, U.scorer2.id])
      for (const who of ['owner', 'scorer2', 'admin']) {
        const r = await listAs(who, m)
        assert.equal(r.status, 200, who)
        assert.equal(r.body.data.approvals.length, 2, who)
      }
      const own = await listAs('ref1', m)
      assert.equal(own.status, 200)
      assert.deepEqual(own.body.data.approvals.map((a) => [a.slot, a.mine]), [['referee1', true]])
      expectErr(await listAs('stranger', m), 403, 'OV_FORBIDDEN')
      expectErr(await listAs('ref3', m), 403, 'OV_FORBIDDEN')
      expectErr(await approvals.listForMatch({ callerId: U.owner.id, externalId: 'nope' }), 404, 'OV_NOT_FOUND')
      expectErr(await approvals.listForMatch({ callerId: U.owner.id, externalId: '' }), 400, 'OV_INVALID_REQUEST')
      const beach = await newMatch('owner', { sport: 'beach' })
      assert.deepEqual((await listAs('owner', beach)).body.data.approvals, [])
    })
  })

  describe('accounts and admin', () => {
    it('deleting the approver account keeps the row (name kept, user_id NULL), also on a closed match', async () => {
      const gone = await user('goneRef', ['referee'], { first: 'Gina', last: 'Weg', pin: '640271' })
      const m = await newMatch('owner')
      assert.equal((await approveAs('owner', m, 'referee1', 'goneRef')).status, 200)
      await closeMatch(m)
      const s = await auth.handleAuthRequest('sign-in', { email: gone.email, password: PW }, { ip: '198.51.100.7' })
      assert.equal(s.status, 200, JSON.stringify(s.body))
      const del = await auth.handleAuthRequest('delete-account', { access_token: s.body.data.session.access_token }, { ip: '198.51.100.7' })
      assert.equal(del.status, 200, JSON.stringify(del.body))
      const [row] = await rowsOf(m)
      assert.deepEqual([row.user_id, row.display_name, row.revoked_at], [null, 'Weg Gina', null])
      assert.equal((await pool.query('SELECT count(*)::int n FROM auth.approval_pins WHERE user_id = $1', [gone.id])).rows[0].n, 0)
      // still listed (the PDF ID stays checkable)
      const l = await listAs('owner', m)
      assert.deepEqual(l.body.data.approvals.map((a) => [a.name, a.mine]), [['Weg Gina', false]])
    })

    it('admin search by short id, game number or external_id; with emails and hash prefixes', async () => {
      const m = await newMatch('owner')
      const devId = randomUUID()
      const a = (await approveAs('owner', m, 'referee1', 'ref1', { deviceId: devId })).body.data.approval
      const b = (await approveAs('owner', m, 'referee2', 'ref2')).body.data.approval
      await undoAs('owner', b.id)
      const byShort = await approvals.adminSearch({ q: a.short_id })
      assert.equal(byShort.status, 200, JSON.stringify(byShort.body))
      const rec = byShort.body.data.approvals.find((x) => x.id === a.id)
      assert.ok(rec)
      assert.equal(rec.email, U.ref1.email)
      assert.equal(rec.user_id, U.ref1.id)
      assert.equal(rec.requested_by_name, 'Olga Owner')
      assert.equal(rec.ip_hash8, '95eef55b')
      assert.match(rec.device_hash8, /^[0-9a-f]{8}$/)
      assert.equal(rec.result_matches, true)
      assert.deepEqual(rec.match, { id: m.id, external_id: m.ext, game_n: m.gameN, home_name: 'Home', away_name: 'Away', status: 'ended', closed_at: null })
      const byGame = await approvals.adminSearch({ q: String(m.gameN) })
      assert.deepEqual(byGame.body.data.approvals.map((x) => x.slot), ['referee1'], 'revoked ones are left out by default')
      const withRevoked = await approvals.adminSearch({ q: m.ext, includeRevoked: '1' })
      assert.deepEqual(withRevoked.body.data.approvals.map((x) => [x.slot, x.revoked_reason]).sort(), [['referee1', null], ['referee2', 'undo']])
      const rv = withRevoked.body.data.approvals.find((x) => x.slot === 'referee2')
      assert.equal(rv.revoked_by_name, 'Olga Owner')
      expectErr(await approvals.adminSearch({ limit: '0' }), 400, 'OV_INVALID_REQUEST')
      expectErr(await approvals.adminSearch({ includeRevoked: 'yes' }), 400, 'OV_INVALID_REQUEST')
      assert.ok((await approvals.adminSearch({})).body.data.approvals.length > 0)
    })

    it('never logs or audits a PIN, the password, a MAC or an approver email', async () => {
      const logs = JSON.stringify(logger.lines)
      const { rows } = await pool.query('SELECT details::text AS d FROM public.audit_log')
      const audit = rows.map((r) => r.d).join('\n')
      for (const secret of [...allPins, PW]) {
        assert.equal(logs.includes(secret), false, `log: ${secret}`)
        assert.equal(audit.includes(secret), false, `audit: ${secret}`)
      }
      for (const u of Object.values(U)) assert.equal(audit.includes(u.email), false, 'no email in audit details')
      const { rows: pins } = await pool.query("SELECT encode(mac, 'hex') AS mac FROM auth.approval_pins")
      for (const p of pins) {
        assert.equal(logs.includes(p.mac), false)
        assert.equal(audit.includes(p.mac), false)
      }
    })
  })

  describe('review fixes: teams, the official\'s own list, notification mails, the lookup', () => {
    it('renaming or swapping the teams after the end voids the approvals; the same names keep them', async () => {
      const m = await newMatch('owner')
      assert.equal((await approveAs('owner', m, 'referee1', 'ref1')).status, 200)
      const write = (data) => db.runQuery({ table: 'matches', action: 'update', params: { data, filters: [{ type: 'eq', column: 'id', value: m.id }] } },
        { proto: 2, matchOwner: { userId: U.owner.id }, actorId: U.owner.id })
      // a rewrite of the same teams (other keys, other case) keeps them
      const same = await write({ home_team: { name: ' home ', short_name: 'H', color: '#ff0000' }, away_team: { name: 'Away' } })
      assert.equal(same.status, 200, JSON.stringify(same.body))
      assert.equal((await listAs('owner', m)).body.data.approvals.length, 1)
      // swapped
      const swap = await write({ home_team: { name: 'Away' }, away_team: { name: 'Home' } })
      assert.equal(swap.status, 200, JSON.stringify(swap.body))
      assert.deepEqual((await listAs('owner', m)).body.data.approvals, [])
      const [row] = await rowsOf(m)
      assert.deepEqual([row.revoked_reason, row.revoked_by], ['result_changed', U.owner.id])
      const [v] = await auditOf('match.approval_void', m.id)
      assert.deepEqual(v.details, { count: 1, reason: 'result_changed', external_id: m.ext, game_n: m.gameN })
      // the referee approves the sheet as it is now
      assert.equal((await approveAs('owner', m, 'referee1', 'ref1')).status, 200)
    })

    it('GET /api/account/approvals: the official sees every use of their PIN and can undo it', async () => {
      const m = await newMatch('owner')
      const a = (await approveAs('owner', m, 'referee1', 'ref3')).body.data.approval
      const mine = await approvals.listMine({ callerId: U.ref3.id })
      assert.equal(mine.status, 200, JSON.stringify(mine.body))
      const rec = mine.body.data.approvals.find((x) => x.id === a.id)
      assert.ok(rec)
      assert.equal(rec.mine, true)
      assert.equal(rec.result_matches, true)
      assert.equal(rec.requested_by_name, 'Olga Owner')
      assert.deepEqual(rec.match, { external_id: m.ext, game_n: m.gameN, home_name: 'Home', away_name: 'Away', status: 'ended', closed_at: null, test: false })
      assert.equal(/@|user_id|hash/.test(JSON.stringify(mine.body)), false, 'no ids, emails or hashes')
      assert.ok(mine.body.data.approvals.every((x) => x.mine === true), 'only their own')
      // nothing of someone else's
      const other = await approvals.listMine({ callerId: U.stranger.id })
      assert.deepEqual(other.body.data.approvals, [])
      // undo by the official from their own list; it stays listed as revoked
      assert.equal((await undoAs('ref3', a.id)).status, 200)
      const after = (await approvals.listMine({ callerId: U.ref3.id })).body.data.approvals.find((x) => x.id === a.id)
      assert.equal(after.revoked_reason, 'undo')
      expectErr(await approvals.listMine({ callerId: U.ref3.id, limit: '0' }), 400, 'OV_INVALID_REQUEST')
    })

    it('mails the official on every approval and when the PIN locks; never on a plain failure', async () => {
      const sent = []
      const mailer = { enabled: true, managerUrl: 'https://manager.example.test', async send (kind, o) { sent.push({ kind, ...o }); return { sent: true } } }
      const mailed = createApprovals({ pool, auth, secret: SECRET, mailer, logger })
      const official = await user('mailRef', ['referee'], { first: 'Mia', last: 'Mail', pin: '736185' })
      const m = await newMatch('owner')
      const call = async (pin, slot = 'referee1') => mailed.approve({
        callerId: U.owner.id,
        access: await access.get(U.owner.id),
        body: { external_id: m.ext, slot, email: official.email, pin, result: { sets: SETS }, lang: 'de-CH' },
        ip: '203.0.113.7',
        lang: 'en-US,en;q=0.9'
      })
      const ok1 = await call('736185')
      assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
      await mailed.settle()
      assert.equal(sent.length, 1)
      assert.deepEqual(sent[0], {
        kind: 'approval',
        to: official.email,
        lang: 'de',
        link: 'https://manager.example.test',
        vars: {
          slot: 'referee1',
          game: `#${m.gameN} Home – Away`,
          result: '25:20, 23:25, 25:18, 25:22',
          id: ok1.body.data.approval.short_id,
          time: sent[0].vars.time,
          sender: 'Olga Owner'
        }
      })
      assert.match(sent[0].vars.time, /^\d\d\.\d\d\.\d{4} \d\d:\d\d$/)
      // the idempotent retry sends nothing
      assert.equal((await call('736185')).body.data.already, true)
      await mailed.settle()
      assert.equal(sent.length, 1)
      // four failures: no mail; the fifth locks and mails
      for (let i = 0; i < 4; i++) await call('100000')
      await mailed.settle()
      assert.equal(sent.length, 1)
      await call('100000')
      await mailed.settle()
      assert.equal(sent.length, 2)
      assert.equal(sent[1].kind, 'approval_pin_locked')
      assert.equal(sent[1].to, official.email)
      assert.equal(sent[1].vars.disabled, false)
      assert.match(sent[1].vars.until, /^\d\d\.\d\d\.\d{4} \d\d:\d\d$/)
      // a failing mailer never fails the request
      const broken = createApprovals({ pool, auth, secret: SECRET, logger, mailer: { enabled: true, managerUrl: 'https://x.test', async send () { throw new Error('smtp down') } } })
      const m2 = await newMatch('owner')
      const r = await broken.approve({ callerId: U.owner.id, access: await access.get(U.owner.id), body: { external_id: m2.ext, slot: 'referee2', email: U.ref2.email, pin: U.ref2.pin, result: { sets: SETS } } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await broken.settle()
    })

    it('the admin lookup takes the ID as printed on the PDF', async () => {
      const m = await newMatch('owner')
      const a = (await approveAs('owner', m, 'referee1', 'ref1')).body.data.approval
      for (const q of [`ID ${a.short_id}`, `#${a.short_id}`, ` id: ${a.short_id.toLowerCase()} `]) {
        const r = await approvals.adminSearch({ q })
        assert.ok(r.body.data.approvals.some((x) => x.id === a.id), q)
      }
      const byGame = await approvals.adminSearch({ q: `#${m.gameN}` })
      assert.deepEqual(byGame.body.data.approvals.map((x) => x.id), [a.id])
    })
  })

  // ~/ov-ops/openbeach-separation-tournaments-PLAN.md 1.3: the role of the
  // MATCH's sport. Beach approvals stay off by default (spec D3); a module
  // created with beachApprovals: true takes the beach roles.
  describe('the role of the match\'s sport (db/012)', () => {
    let beachApp
    const B = {}
    const PIN = { bOwner: '640281', bRef1: '307519', bRef2: '851046', bRef3: '492730', both: '186405' }
    const beachUser = async (name, roles, opts = {}) => {
      const u = await user(name, roles, opts)
      const r = await beachApp.setPin({ userId: u.id, body: { password: PW, pin: PIN[name] } })
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`)
      u.pin = PIN[name]
      allPins.add(PIN[name])
      B[name] = u
      return u
    }
    const beachApprove = async (caller, m, slot, official, { pin } = {}) => beachApp.approve({
      callerId: U[caller].id,
      access: await access.get(U[caller].id),
      body: { external_id: m.ext, slot, email: U[official].email, pin: pin ?? U[official].pin, result: { sets: SETS } },
      ip: '203.0.113.21'
    })
    const appsOf = async (action, matchId) => (await auditOf(action, matchId)).map((r) => r.app)

    before(async () => {
      beachApp = createApprovals({ pool, auth, secret: SECRET, logger, beachApprovals: true })
      await beachUser('bOwner', ['beach:scorer'], { first: 'Bea', last: 'Strand' })
      await beachUser('bRef1', ['beach:referee'], { first: 'Rita', last: 'Sand' })
      await beachUser('bRef2', ['beach:referee'], { first: 'Rolf', last: 'Sand' })
      await beachUser('bRef3', ['beach:referee'], { first: 'Rosa', last: 'Sand' })
      await beachUser('both', ['referee', 'beach:referee'], { first: 'Bo', last: 'Beide' })
    })

    it('helpers: the slot role and the scoring-table roles of each sport', () => {
      assert.equal(approvalRoleFor('referee1', 'indoor'), 'referee')
      assert.equal(approvalRoleFor('referee2', null), 'referee')
      assert.equal(approvalRoleFor('referee1', 'beach'), 'beach:referee')
      assert.equal(approvalRoleFor('referee2', 'beach'), 'beach:referee')
      assert.equal(approvalRoleFor('scorer', 'indoor'), 'scorer')
      assert.equal(approvalRoleFor('scorer', 'beach'), 'beach:scorer')
      assert.equal(approvalRoleFor('assistant', 'beach'), null)
      assert.deepEqual(callerRolesFor('indoor'), ['scorer', 'referee'])
      assert.deepEqual(callerRolesFor('beach'), ['beach:scorer', 'beach:referee'])
    })

    it('by default (D3) beach roles hold no approval PIN and beach matches stay refused', async () => {
      const s = await approvals.getPinStatus({ userId: B.bRef1.id })
      assert.equal(s.body.data.eligible, false)
      const r = await approvals.setPin({ userId: B.bRef1.id, body: { password: PW, pin: '529163' } })
      expectErr(r, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(r.body.error.details, { roles: ['referee', 'scorer'] })
      assert.equal((await beachApp.getPinStatus({ userId: B.bRef1.id })).body.data.eligible, true)
      const m = await newMatch('bOwner', { sport: 'beach' })
      expectErr(await approveAs('bOwner', m, 'referee1', 'bRef1'), 409, 'OV_APPROVAL_UNSUPPORTED')
      assert.equal((await beachApprove('bOwner', m, 'referee1', 'bRef1')).status, 200)
      assert.deepEqual((await listAs('bOwner', m)).body.data.approvals, [], 'the default module lists none')
      const l = await beachApp.listForMatch({ callerId: B.bOwner.id, access: await access.get(B.bOwner.id), externalId: m.ext })
      assert.deepEqual(l.body.data.approvals.map((a) => a.slot), ['referee1'])
    })

    it('an indoor match: referee slots need referee, beach:referee is not enough', async () => {
      const m = await newMatch('owner')
      for (const app of [approvals, beachApp]) {
        const r = await app.approve({ callerId: U.owner.id, access: await access.get(U.owner.id), body: { external_id: m.ext, slot: 'referee1', email: B.bRef1.email, pin: B.bRef1.pin, result: { sets: SETS } }, ip: '203.0.113.22' })
        expectErr(r, 403, 'OV_APPROVAL_ROLE_REQUIRED')
        assert.deepEqual(r.body.error.details, { role: 'referee' })
      }
      // an account with both roles approves either sport
      assert.equal((await beachApprove('owner', m, 'referee1', 'both')).status, 200)
    })

    it('an indoor match: the scoring table needs an indoor scorer or referee, beach:scorer is not enough', async () => {
      const m = await newMatch('bOwner')
      const r = await beachApprove('bOwner', m, 'referee1', 'ref1')
      expectErr(r, 403, 'OV_APPROVAL_CALLER_ROLE')
      assert.deepEqual(r.body.error.details, { roles: ['scorer', 'referee'] })
    })

    it('a beach match: referee slots need beach:referee, the scorer slot beach:scorer, the scoring table a beach role', async () => {
      const m = await newMatch('bOwner', { sport: 'beach' })
      // the indoor referee role is not enough on a beach match
      const indoorRef = await beachApprove('bOwner', m, 'referee1', 'ref1')
      expectErr(indoorRef, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(indoorRef.body.error.details, { role: 'beach:referee' })
      // an indoor-only scorer as the scoring table of a beach match
      await pool.query('INSERT INTO public.match_editors (match_id, user_id) VALUES ($1, $2)', [m.id, U.owner.id])
      const indoorTable = await beachApprove('owner', m, 'referee1', 'bRef1')
      expectErr(indoorTable, 403, 'OV_APPROVAL_CALLER_ROLE')
      assert.deepEqual(indoorTable.body.error.details, { roles: ['beach:scorer', 'beach:referee'] })
      // the scorer slot: the indoor scorer (an editor) lacks beach:scorer
      const indoorScorer = await beachApprove('bOwner', m, 'scorer', 'owner')
      expectErr(indoorScorer, 403, 'OV_APPROVAL_ROLE_REQUIRED')
      assert.deepEqual(indoorScorer.body.error.details, { role: 'beach:scorer' })
      // the beach officials
      assert.equal((await beachApprove('bOwner', m, 'referee1', 'bRef1')).status, 200)
      assert.equal((await beachApprove('bOwner', m, 'referee2', 'bRef2')).status, 200)
      const sc = await beachApprove('bOwner', m, 'scorer', 'bOwner')
      assert.equal(sc.status, 200, JSON.stringify(sc.body))
    })

    it('audit entries carry the match\'s app: approve, undo, PIN lockout and void', async () => {
      const indoor = await newMatch('owner')
      assert.equal((await approveAs('owner', indoor, 'referee1', 'ref2')).status, 200)
      const beach = await newMatch('bOwner', { sport: 'beach' })
      const a = await beachApprove('bOwner', beach, 'referee1', 'bRef1')
      assert.equal(a.status, 200)
      assert.equal((await beachApprove('bOwner', beach, 'referee2', 'bRef2')).status, 200)
      assert.deepEqual(await appsOf('match.approve', indoor.id), [null])
      assert.deepEqual(await appsOf('match.approve', beach.id), ['beach', 'beach'])
      // undo
      const u = await beachApp.revoke({ callerId: B.bOwner.id, access: await access.get(B.bOwner.id), id: a.body.data.approval.id })
      assert.equal(u.status, 200, JSON.stringify(u.body))
      assert.deepEqual(await appsOf('match.approval_revoke', beach.id), ['beach'])
      // the PIN lockout on a beach match
      for (let i = 0; i < PIN_LOCK_EVERY; i++) expectErr(await beachApprove('bOwner', beach, 'referee1', 'bRef3', { pin: '100000' }), 403, 'OV_APPROVAL_PIN_INVALID')
      assert.deepEqual(await appsOf('approval_pin.locked', beach.id), ['beach'])
      // the void of db/011's trigger (db/012 names the app): admin close and reopen
      await closeMatch(beach)
      const re = await accounts.reopenMatch({ actorId: U.admin.id, matchId: beach.id, body: { reason: 'Wrong pair' } })
      assert.equal(re.status, 200, JSON.stringify(re.body))
      const [v] = await auditOf('match.approval_void', beach.id)
      assert.equal(v.app, 'beach')
      assert.deepEqual(v.details, { count: 1, reason: 'match_reopened', external_id: beach.ext, game_n: beach.gameN })
      await closeMatch(indoor)
      assert.equal((await accounts.reopenMatch({ actorId: U.admin.id, matchId: indoor.id, body: { reason: 'Wrong score' } })).status, 200)
      assert.deepEqual(await appsOf('match.approval_void', indoor.id), [null])
      // the account's own PIN entries stay app NULL (one PIN for the account)
      const pinSet = (await auditOf('approval_pin.set')).filter((r) => r.target_user_id === B.bRef1.id)
      assert.deepEqual(pinSet.map((r) => r.app), [null])
    })

    it('a beach match: the result is its sets\' team1 / team2 points (OpenBeach\'s resultKey), never home / away', async () => {
      const m = await newMatch('bOwner', { sport: 'beach', sets: [[1, 21, 19], [2, 18, 21], [3, 15, 12]] })
      const BEACH_KEY = 'ov-result-v1|1:21:19,2:18:21,3:15:12'
      // the beach sets' home_points / away_points are the column default 0
      const { rows: stored } = await pool.query('SELECT home_points, away_points FROM public.sets WHERE match_id = $1', [m.id])
      assert.ok(stored.every((r) => r.home_points === 0 && r.away_points === 0))
      // OpenBeach sends [index, team1, team2] (accountApproval_beach.js resultKey)
      const asCaller = async (sets) => beachApp.approve({
        callerId: U.bOwner.id,
        access: await access.get(U.bOwner.id),
        body: { external_id: m.ext, slot: 'referee1', email: U.bRef1.email, pin: U.bRef1.pin, result: { sets } },
        ip: '203.0.113.23'
      })
      // the old reading (home / away = 0:0) is refused, and says what the server has
      const zeros = await asCaller([[1, 0, 0], [2, 0, 0], [3, 0, 0]])
      expectErr(zeros, 409, 'OV_RESULT_NOT_SYNCED')
      assert.deepEqual(zeros.body.error.details, { server: [[1, 21, 19], [2, 18, 21], [3, 15, 12]] })
      const a = await asCaller([[1, 21, 19], [2, 18, 21], [3, 15, 12]])
      assert.equal(a.status, 200, JSON.stringify(a.body))
      assert.equal(a.body.data.approval.result_key, BEACH_KEY)
      assert.equal(a.body.data.approval.result_matches, true)
      // every list reads the same key: the match's list, the official's own, the admin's, the admin match lists
      const l = await beachApp.listForMatch({ callerId: B.bOwner.id, access: await access.get(B.bOwner.id), externalId: m.ext })
      assert.deepEqual(l.body.data.approvals.map((x) => [x.slot, x.result_matches]), [['referee1', true]])
      const mine = await beachApp.listMine({ callerId: B.bRef1.id })
      assert.equal(mine.body.data.approvals.find((x) => x.id === a.body.data.approval.id).result_matches, true)
      const admin = await beachApp.adminSearch({ q: m.ext })
      assert.deepEqual(admin.body.data.approvals.map((x) => x.result_matches), [true])
      assert.deepEqual((await beachApp.approvalsForMatches([m.id])).get(m.id).map((x) => x.result_matches), [true])
      // a later change of a beach set's team 2 points makes it stale everywhere
      await pool.query('UPDATE public.sets SET team2_points = 17 WHERE match_id = $1 AND index = 3', [m.id])
      const after = await beachApp.listForMatch({ callerId: B.bOwner.id, access: await access.get(B.bOwner.id), externalId: m.ext })
      assert.equal(after.body.data.approvals[0].result_matches, false)
      assert.equal((await beachApp.adminSearch({ q: m.ext })).body.data.approvals[0].result_matches, false)
      assert.equal((await beachApp.approvalsForMatches([m.id])).get(m.id)[0].result_matches, false)
      // ... and a change of home_points alone (not a beach column) does not
      await pool.query('UPDATE public.sets SET team2_points = 12, home_points = 9 WHERE match_id = $1 AND index = 3', [m.id])
      assert.equal((await beachApp.approvalsForMatches([m.id])).get(m.id)[0].result_matches, true)
    })

    it('a beach match names its teams from team1_data / team2_data (mail, the official\'s list, admin search)', async () => {
      const sent = []
      const mailer = { enabled: true, managerUrl: 'https://manager.example.test', async send (kind, o) { sent.push({ kind, ...o }); return { sent: true } } }
      const mailed = createApprovals({ pool, auth, secret: SECRET, mailer, logger, beachApprovals: true })
      const m = await newMatch('bOwner', { sport: 'beach', sets: [[1, 21, 19], [2, 21, 17]] })
      // as OpenBeach stores a match: team1_data / team2_data, no home_team / away_team
      await pool.query(`UPDATE public.matches SET home_team = NULL, away_team = NULL,
        team1_data = '{"name":"Muster / Beispiel"}', team2_data = '{"name":"Sand / Strand"}' WHERE id = $1`, [m.id])
      const r = await mailed.approve({
        callerId: U.bOwner.id,
        access: await access.get(U.bOwner.id),
        body: { external_id: m.ext, slot: 'referee1', email: B.bRef2.email, pin: B.bRef2.pin, result: { sets: [[1, 21, 19], [2, 21, 17]] } },
        ip: '203.0.113.24'
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await mailed.settle()
      assert.equal(sent.length, 1)
      assert.equal(sent[0].vars.game, `#${m.gameN} Muster / Beispiel – Sand / Strand`)
      assert.equal(sent[0].vars.result, '21:19, 21:17')
      const mine = (await mailed.listMine({ callerId: B.bRef2.id })).body.data.approvals.find((x) => x.id === r.body.data.approval.id)
      assert.deepEqual([mine.match.home_name, mine.match.away_name], ['Muster / Beispiel', 'Sand / Strand'])
      const admin = (await mailed.adminSearch({ q: m.ext })).body.data.approvals
      assert.deepEqual(admin.map((x) => [x.match.home_name, x.match.away_name]), [['Muster / Beispiel', 'Sand / Strand']])
      // an indoor match keeps home_team / away_team even when team1_data holds a name
      const i = await newMatch('owner')
      await pool.query(`UPDATE public.matches SET team1_data = '{"name":"X"}', team2_data = '{"name":"Y"}' WHERE id = $1`, [i.id])
      const ri = await approveAs('owner', i, 'referee1', 'ref1')
      assert.equal(ri.status, 200, JSON.stringify(ri.body))
      const ai = (await approvals.adminSearch({ q: i.ext })).body.data.approvals
      assert.deepEqual(ai.map((x) => [x.match.home_name, x.match.away_name]), [['Home', 'Away']])
    })

    it('an indoor match still reads home / away, whatever its sets\' team1 / team2 columns hold', async () => {
      const m = await newMatch('owner')
      await pool.query('UPDATE public.sets SET team1_points = 1, team2_points = 2 WHERE match_id = $1', [m.id])
      const r = await beachApprove('owner', m, 'referee1', 'both')
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.approval.result_key, KEY)
      assert.deepEqual((await beachApp.approvalsForMatches([m.id])).get(m.id).map((x) => x.result_matches), [true])
    })

    it('the admin search takes ?app=', async () => {
      const indoor = await newMatch('owner')
      const ai = (await approveAs('owner', indoor, 'referee1', 'ref3')).body.data.approval
      const beach = await newMatch('bOwner', { sport: 'beach' })
      const ab = (await beachApprove('bOwner', beach, 'referee1', 'bRef2')).body.data.approval
      const ids = async (app) => (await approvals.adminSearch({ app, limit: 200 })).body.data.approvals.map((x) => x.id)
      assert.ok((await ids('beach')).includes(ab.id))
      assert.ok(!(await ids('beach')).includes(ai.id))
      assert.ok((await ids('indoor')).includes(ai.id))
      assert.ok(!(await ids('indoor')).includes(ab.id))
      const all = await ids(undefined)
      assert.ok(all.includes(ai.id) && all.includes(ab.id))
      expectErr(await approvals.adminSearch({ app: 'snow' }), 400, 'OV_INVALID_REQUEST')
    })
  })
})
