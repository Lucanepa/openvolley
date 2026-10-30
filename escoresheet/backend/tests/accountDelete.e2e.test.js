/**
 * An admin deletes an account, or rejects a sign-up, in the manager
 * (POST /api/admin/accounts/:id/delete|reject, lib/accounts.js deleteAccount),
 * end to end: server.js against a real Postgres (PG_TEST_URL, or
 * OV_E2E_DOCKER=1; see tests/server.e2e.test.js) and a temp storage root.
 *
 *   1. who: admins only; never the caller's own account; a super admin only
 *      by a super admin; never the last super admin that can still sign in;
 *      the typed address must be the account's
 *   2. what goes: the account, its sessions, profile, roles, memberships,
 *      club links, club manager entries, My Matches links, editor rights,
 *      approval PIN, invite redemptions and its backup files (the deletion
 *      of delete-account, README "Deleting an account")
 *   3. what stays: its official matches (created_by NULL) with their events
 *      and the scorer named on the scoresheet, the audit entries it wrote or
 *      was the target of (actor / target NULL), its club, its invite codes
 *   4. the audit entry: account.delete / account.reject, without the address
 *   5. reject: a sign-up without any role only
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const digest = (email) => createHash('sha256').update('ov-account-email:' + email.toLowerCase()).digest('hex')

describe('an admin deletes an account', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
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
  const del = (actor, target, email = target.email) => call(actor, 'POST', `/api/admin/accounts/${target.id}/delete`, { email })
  const reject = (actor, target, email = target.email) => call(actor, 'POST', `/api/admin/accounts/${target.id}/reject`, { email })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const count = async (q, p) => (await sql.query(q, p)).rows[0].n
  const exists = (u) => count('SELECT count(*)::int AS n FROM auth.users WHERE id = $1', [u.id]).then((n) => n === 1)
  const upload = (user, bucket, path, content) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket, path, fileBase64: Buffer.from(content).toString('base64'), contentType: 'application/json' } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-del-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-del-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      OV_PIN_SECRET: PIN_SECRET
    })
    await account('admin', ['admin'])
    await account('cm', ['competition_manager'])
    await account('scorer', ['scorer'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('the accounts list says this server can delete accounts', async () => {
    const r = await call(users.admin, 'GET', '/api/admin/accounts?filter=all')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.can_delete, true)
  })

  it('only admins; never the own account; the typed address must match; unknown accounts are 404', async () => {
    const target = await account('target1', ['scorer'])
    expectCode(await del(users.cm, target), 403, 'OV_FORBIDDEN')
    expectCode(await del(users.scorer, target), 403, 'OV_FORBIDDEN')
    expectCode(await reject(users.scorer, target), 403, 'OV_FORBIDDEN')
    assert.equal((await del(null, target)).status, 401)
    expectCode(await del(users.admin, users.admin), 409, 'OV_SELF_DELETE')
    expectCode(await del(users.admin, target, 'someone-else@example.ch'), 400, 'OV_CONFIRM_MISMATCH')
    expectCode(await call(users.admin, 'POST', `/api/admin/accounts/${target.id}/delete`, {}), 400, 'OV_INVALID_REQUEST')
    expectCode(await del(users.admin, { id: '00000000-0000-4000-8000-000000000000', email: 'x@example.ch' }), 404, 'OV_ACCOUNT_NOT_FOUND')
    assert.equal(await exists(target), true, 'nothing was deleted')
    // the address is compared without case and spaces
    const ok = await del(users.admin, target, `  ${target.email.toUpperCase()} `)
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.json.data, { id: target.id, deleted: true })
    assert.equal(await exists(target), false)
    expectCode(await del(users.admin, target), 404, 'OV_ACCOUNT_NOT_FOUND')
  })

  it('a super admin only by a super admin, and never the last one that can still sign in', async () => {
    const boss = await account('boss', ['super_admin'])
    const boss2 = await account('boss2', ['super_admin'])
    expectCode(await del(users.admin, boss2), 403, 'OV_FORBIDDEN')
    assert.equal(await exists(boss2), true)
    // boss2 loses super_admin in the database while boss's role is still
    // cached (30 s, lib/access.js): boss is the last super admin, and boss2
    // may not delete it even with its stale rights
    assert.equal((await call(boss2, 'GET', '/api/me')).json.data.isSuperAdmin, true) // caches boss2's access
    await grantRoles(sql, boss2.id, ['admin'])
    expectCode(await del(boss2, boss), 409, 'OV_LAST_SUPER_ADMIN')
    assert.equal(await exists(boss), true)
    // a banned super admin does not count as one left (without that rule the
    // answer would be the transaction's re-check: boss2 is no super admin)
    const boss3 = await account('boss3', ['super_admin'])
    // (the production users table has the column, the synthetic one not)
    await sql.query('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz')
    await sql.query("UPDATE auth.users SET banned_until = now() + interval '10 years' WHERE id = $1", [boss3.id])
    expectCode(await del(boss2, boss), 409, 'OV_LAST_SUPER_ADMIN')
    assert.equal(await exists(boss), true)
    // two super admins: one deletes the other
    await grantRoles(sql, boss2.id, ['super_admin'])
    const r = await del(boss, boss2)
    assert.equal(r.status, 200, r.text)
    assert.equal(await exists(boss2), false)
    assert.equal(await exists(boss), true)
  })

  it('deletes the personal data and keeps the official records', async () => {
    const leaver = await account('leaver', ['scorer'])
    const other = await account('other', ['scorer'])
    // an official match, closed, scored by the leaver, with the scorer named on the sheet
    const ext = `match_${Date.now()}_del`
    const m = await api(srv.base, '/api/db', {
      token: leaver.token,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext,
            game_n: 9701,
            game_pin: '615203',
            status: 'live',
            sport_type: 'indoor',
            home_team: { name: 'H' },
            away_team: { name: 'A' },
            scheduled_at: new Date().toISOString(),
            officials: [{ role: '1st referee', firstName: 'Rita', lastName: 'Referee' }, { role: 'scorer', firstName: 'Lea', lastName: 'Leaver' }]
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(m.status, 200, m.text)
    const matchId = m.json.data.id
    await sql.query(`INSERT INTO public.events (external_id, match_id, type, payload) VALUES ($1, $2, 'point', '{}')`, [`${ext}_e1`, matchId])
    const close = await api(srv.base, '/api/db', { token: leaver.token, body: { table: 'matches', action: 'update', params: { data: { status: 'final' }, filters: [{ type: 'eq', column: 'id', value: matchId }] } } })
    assert.equal(close.status, 200, close.text)
    assert.ok((await sql.query('SELECT closed_at FROM public.matches WHERE id = $1', [matchId])).rows[0].closed_at, 'closed')
    // the other account's match, where the leaver is an editor
    const om = await api(srv.base, '/api/db', { token: other.token, body: { table: 'matches', action: 'upsert', params: { data: { external_id: `${ext}_o`, game_n: 9702, status: 'live', sport_type: 'indoor' }, onConflict: 'external_id', returning: 'id', single: true } } })
    assert.equal(om.status, 200, om.text)
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${om.json.data.id}/editors`, { email: leaver.email })).status, 200)
    assert.equal((await api(srv.base, '/api/db', { token: leaver.token, body: { table: 'user_matches', action: 'insert', params: { data: { match_external_id: ext, role: 'scorer' } } } })).status, 200)
    // a club it scores for and manages, an invite code it redeemed, OpenBeach joined, an approval PIN
    const club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'KSC Delete', teams: ['KSC Delete H1'] })).json.data.club
    assert.equal((await call(users.admin, 'PUT', `/api/admin/accounts/${leaver.id}/clubs`, { club_ids: [club.id] })).status, 200)
    assert.equal((await call(users.admin, 'PUT', `/api/admin/clubs/${club.id}/managers`, { emails: [leaver.email] })).status, 200)
    const invite = await call(users.admin, 'POST', '/api/admin/invites', { label: 'del test', role: 'referee', max_uses: 5 })
    assert.equal(invite.status, 201, invite.text)
    assert.equal((await call(leaver, 'POST', '/api/account/redeem-invite', { code: invite.json.data.code })).status, 200)
    assert.equal((await call(leaver, 'POST', '/api/account/join', { app: 'beach' })).status, 200)
    await sql.query('INSERT INTO auth.approval_pins (user_id, salt, mac) VALUES ($1, $2, $3)', [leaver.id, randomBytes(16), randomBytes(32)])
    // its backups (go) and a scoresheet it uploaded (stays as the record)
    assert.equal((await upload(leaver, 'backup', 'backups/backup_g9701/b1.json', '{"roster":"x"}')).status, 200)
    const sheet = `2026-10-30/game9701_k${'c'.repeat(32)}_final.json`
    assert.equal((await upload(leaver, 'scoresheets', sheet, '{"sheet":1}')).status, 200)
    assert.equal(existsSync(join(storageRoot, 'backup', leaver.id)), true)
    const auditBefore = await count('SELECT count(*)::int AS n FROM public.audit_log')
    const authored = await count('SELECT count(*)::int AS n FROM public.audit_log WHERE actor_id = $1 OR target_user_id = $1', [leaver.id])
    assert.ok(authored >= 4, `the leaver has audit entries (${authored})`)

    const r = await del(users.admin, leaver)
    assert.equal(r.status, 200, r.text)

    // gone
    for (const [q, what] of [
      ['SELECT count(*)::int AS n FROM auth.users WHERE id = $1', 'account'],
      ['SELECT count(*)::int AS n FROM auth.app_sessions WHERE user_id = $1', 'sessions'],
      ['SELECT count(*)::int AS n FROM public.profiles WHERE user_id = $1', 'profile and roles'],
      ['SELECT count(*)::int AS n FROM auth.app_memberships WHERE user_id = $1', 'memberships'],
      ['SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = $1', 'club links'],
      ['SELECT count(*)::int AS n FROM public.club_managers WHERE user_id = $1', 'club manager entries'],
      ['SELECT count(*)::int AS n FROM public.user_matches WHERE user_id = $1', 'My Matches links'],
      ['SELECT count(*)::int AS n FROM public.match_editors WHERE user_id = $1', 'editor rights'],
      ['SELECT count(*)::int AS n FROM public.invite_redemptions WHERE user_id = $1', 'invite redemptions'],
      ['SELECT count(*)::int AS n FROM auth.approval_pins WHERE user_id = $1', 'approval PIN'],
      ['SELECT count(*)::int AS n FROM public.audit_log WHERE actor_id = $1 OR target_user_id = $1', 'audit links to the account']
    ]) assert.equal(await count(q, [leaver.id]), 0, what)
    assert.equal(existsSync(join(storageRoot, 'backup', leaver.id)), false, 'backup files')
    assert.equal((await call(leaver, 'GET', '/api/me')).status, 401, 'signed out everywhere')

    // kept
    const { rows: [match] } = await sql.query('SELECT created_by, closed_by, status, closed_at FROM public.matches WHERE id = $1', [matchId])
    assert.equal(match.created_by, null)
    assert.equal(match.closed_by, null)
    assert.equal(match.status, 'final')
    assert.ok(match.closed_at)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.events WHERE match_id = $1', [matchId]), 1, 'events stay')
    assert.equal(await count('SELECT count(*)::int AS n FROM public.matches WHERE id = $1', [om.json.data.id]), 1)
    assert.equal(existsSync(join(storageRoot, 'scoresheets', sheet)), true, 'the uploaded scoresheet stays')
    assert.equal(await count('SELECT count(*)::int AS n FROM public.clubs WHERE id = $1', [club.id]), 1, 'the club stays')
    assert.equal(await count('SELECT count(*)::int AS n FROM public.invite_codes WHERE id = $1', [invite.json.data.invite.id]), 1)
    // every audit row stays (the account's own entries without it), plus the deletion's
    const { rows: entries } = await sql.query("SELECT action, actor_id, target_user_id, details, app FROM public.audit_log WHERE action = 'account.delete' AND details->>'account_id' = $1 ORDER BY id", [leaver.id])
    assert.equal(await count('SELECT count(*)::int AS n FROM public.audit_log'), auditBefore + entries.length)
    // one entry per app it was a member of (OpenVolley and OpenBeach)
    assert.deepEqual(entries.map((e) => e.app), [null, 'beach'])
    for (const e of entries) {
      assert.equal(e.actor_id, users.admin.id)
      assert.equal(e.target_user_id, null)
      assert.equal(e.details.account_id, leaver.id)
      assert.equal(e.details.email_sha256, digest(leaver.email))
      assert.deepEqual(e.details.roles.sort(), ['referee', 'scorer'])
      assert.deepEqual(e.details.apps, ['indoor', 'beach'])
      assert.equal(e.details.matches_kept, 1)
      const text = JSON.stringify(e.details)
      assert.equal(text.includes(leaver.email), false, 'no address in clear')
      assert.equal(text.includes(leaver.email.split('@')[0]), false)
      assert.equal(/leaver/i.test(text), false, 'no name')
    }
    // the admin lists name the scorer from the scoresheet now that the account is gone
    const closed = await call(users.admin, 'GET', '/api/admin/matches?state=closed')
    const row = closed.json.data.matches.find((x) => x.id === matchId)
    assert.equal(row.scorer_name, null)
    assert.equal(row.scorer_email, null)
    assert.equal(row.sheet_scorer_name, 'Lea Leaver')
    const sheets = await call(users.admin, 'GET', '/api/scoresheets?app=indoor')
    assert.equal(sheets.json.data.matches.find((x) => x.id === matchId).sheet_scorer_name, 'Lea Leaver')
    // the Audit log lists the entry
    const audit = await call(users.admin, 'GET', '/api/admin/audit?action=account.delete&app=indoor')
    assert.equal(audit.status, 200, audit.text)
    const listed = audit.json.data.entries.find((e) => e.details.account_id === leaver.id)
    assert.equal(listed.target_email, null)
    assert.equal(listed.actor_email, users.admin.email)
  })

  it('reject: a sign-up without any role, audited as account.reject', async () => {
    const newbie = await account('newbie')
    const scorer2 = await account('scorer2', ['beach:scorer'])
    // an account with a role of any app is deleted, not rejected
    expectCode(await reject(users.admin, scorer2), 409, 'OV_NOT_PENDING')
    expectCode(await reject(users.admin, users.admin), 409, 'OV_SELF_DELETE')
    assert.equal(await exists(scorer2), true)
    const r = await reject(users.admin, newbie)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { id: newbie.id, deleted: true, rejected: true })
    assert.equal(await exists(newbie), false)
    const { rows: [e] } = await sql.query("SELECT actor_id, details, app FROM public.audit_log WHERE action = 'account.reject' ORDER BY id DESC LIMIT 1")
    assert.equal(e.actor_id, users.admin.id)
    assert.equal(e.app, null)
    assert.deepEqual(e.details.roles, [])
    assert.equal(e.details.email_sha256, digest(newbie.email))
    assert.equal(JSON.stringify(e.details).includes(newbie.email), false)
    // a beach-only account (OpenBeach membership, no OpenVolley one): its entry is OpenBeach's
    await sql.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'signup')", [scorer2.id])
    assert.equal((await del(users.admin, scorer2)).status, 200)
    const { rows: beach } = await sql.query("SELECT app FROM public.audit_log WHERE action = 'account.delete' AND details->>'account_id' = $1", [scorer2.id])
    assert.deepEqual(beach.map((x) => x.app), ['beach'])
  })
})
