/**
 * OpenVolley (indoor) and OpenBeach (beach): one login, separate memberships
 * and roles, end to end through server.js (db/012,
 * ~/ov-ops/openbeach-separation-tournaments-PLAN.md phase S1):
 *   1. a beach-only scorer cannot write indoor, an indoor scorer cannot write
 *      beach (matches, children, scoresheets, the official-game check); the
 *      sport is the row's, whatever the app sends
 *   2. a match cannot change its sport
 *   3. invite codes per sport; a beach code grants beach:<role> and the
 *      membership; the admin lists filter by ?app=
 *   4. "Join OpenBeach with your existing password": POST /api/account/join
 *   5. GET /api/me: the indoor flags on top (2.1/2.2 clients), apps per app
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('indoor / beach separation end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  let gameSeq = 81000
  const tag = randomBytes(3).toString('hex')

  async function account (name, { roles = null } = {}) {
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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, password }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const upload = (user, path) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'scoresheets', path, fileBase64: Buffer.from('{}').toString('base64'), contentType: 'application/json' } })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const eq = (column, value) => ({ type: 'eq', column, value })
  const match = (sport, extra = {}) => ({ external_id: `m_${sport}_${tag}_${gameSeq}`, game_n: gameSeq++, status: 'live', sport_type: sport, scheduled_at: '2026-11-07T14:00:00Z', ...extra })
  const insert = (user, data) => dbCall(user, 'matches', 'insert', { data, returning: 'id', single: true })
  const memberships = async (userId) => (await sql.query('SELECT app FROM auth.app_memberships WHERE user_id = $1 ORDER BY app', [userId])).rows.map((r) => r.app)

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-sep-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-sep-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', { roles: ['admin'] })
    await account('ivan', { roles: ['scorer'] }) // indoor scorer
    await account('bea', { roles: ['beach:scorer'] }) // beach-only scorer
    await account('both', { roles: ['scorer', 'beach:scorer'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('a beach-only scorer writes beach and cannot write indoor (matches, children, scoresheets, official check)', async () => {
    const b = await insert(users.bea, match('beach'))
    assert.equal(b.status, 200, b.text)
    const bExt = (await sql.query('SELECT external_id FROM matches WHERE id = $1', [b.json.data.id])).rows[0].external_id
    assert.equal((await dbCall(users.bea, 'sets', 'insert', { data: { external_id: `${bExt}:s:1`, match_id: b.json.data.id, index: 1, sport_type: 'beach' } })).status, 200)
    expectCode(await insert(users.bea, match('indoor')), 403, 'OV_SCORER_REQUIRED')
    expectCode(await insert(users.bea, { external_id: `m_nosport_${tag}`, game_n: gameSeq++, status: 'live' }), 403, 'OV_SCORER_REQUIRED')
    assert.equal((await insert(users.bea, match('indoor', { test: true }))).status, 200, 'an indoor test match is fine')
    // an indoor match it edits: no writes
    const i = await insert(users.ivan, match('indoor'))
    assert.equal(i.status, 200, i.text)
    await sql.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [i.json.data.id, users.bea.id])
    expectCode(await dbCall(users.bea, 'matches', 'update', { data: { status: 'ended' }, filters: [eq('id', i.json.data.id)] }), 403, 'OV_SCORER_REQUIRED')
    expectCode(await dbCall(users.bea, 'match_live_state', 'upsert', { data: { match_id: i.json.data.id, points_a: 1 }, onConflict: 'match_id' }), 403, 'OV_SCORER_REQUIRED')
    // scoresheets: beach/ only (any spelling of the folder counts as beach)
    assert.equal((await upload(users.bea, `beach/2026-11-07/game${gameSeq}_final.json`)).status, 200)
    expectCode(await upload(users.bea, `2026-11-07/game${gameSeq}_final.json`), 403, 'OV_SCORER_REQUIRED')
    // the official-game check: the sport of the body
    assert.equal((await call(users.bea, 'POST', '/api/match/official-check', { game_n: 7, sport_type: 'beach' })).status, 200)
    expectCode(await call(users.bea, 'POST', '/api/match/official-check', { game_n: 7, sport_type: 'indoor' }), 403, 'OV_SCORER_REQUIRED')
    expectCode(await call(users.bea, 'POST', '/api/match/official-check', { game_n: 7 }), 403, 'OV_SCORER_REQUIRED')
  })

  it('an indoor scorer is unchanged indoors and cannot write beach', async () => {
    const i = await insert(users.ivan, match('indoor'))
    assert.equal(i.status, 200, i.text)
    assert.equal((await dbCall(users.ivan, 'matches', 'update', { data: { status: 'ended' }, filters: [eq('id', i.json.data.id)] })).status, 200)
    expectCode(await insert(users.ivan, match('beach')), 403, 'OV_SCORER_REQUIRED')
    assert.equal((await insert(users.ivan, match('beach', { test: true }))).status, 200)
    expectCode(await upload(users.ivan, `beach/2026-11-07/game${gameSeq}_final.json`), 403, 'OV_SCORER_REQUIRED')
    expectCode(await upload(users.ivan, `BEACH/2026-11-07/game${gameSeq}_final.json`), 403, 'OV_SCORER_REQUIRED')
    assert.equal((await upload(users.ivan, `2026-11-07/game${gameSeq}_final.json`)).status, 200)
    assert.equal((await call(users.ivan, 'POST', '/api/match/official-check', { game_n: 7 })).status, 200)
    expectCode(await call(users.ivan, 'POST', '/api/match/official-check', { game_n: 7, sport_type: 'beach' }), 403, 'OV_SCORER_REQUIRED')
    // both roles: both sports
    assert.equal((await insert(users.both, match('beach'))).status, 200)
    assert.equal((await insert(users.both, match('indoor'))).status, 200)
  })

  it('a beach-only scorer never learns who holds an indoor game (the 403 comes first)', async () => {
    const n = gameSeq++
    assert.equal((await insert(users.ivan, match('indoor', { game_n: n }))).status, 200)
    const r = await insert(users.bea, match('indoor', { game_n: n }))
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    assert.equal(r.text.includes('ivan'), false)
  })

  it('the sport of a match cannot change (409 OV_SPORT_LOCKED)', async () => {
    const i = await insert(users.both, match('indoor'))
    expectCode(await dbCall(users.both, 'matches', 'update', { data: { sport_type: 'beach' }, filters: [eq('id', i.json.data.id)] }), 409, 'OV_SPORT_LOCKED')
    const t = await insert(users.ivan, match('beach', { test: true }))
    expectCode(await dbCall(users.ivan, 'matches', 'update', { data: { sport_type: 'indoor' }, filters: [eq('id', t.json.data.id)] }), 409, 'OV_SPORT_LOCKED')
    expectCode(await dbCall(users.admin, 'matches', 'update', { data: { sport_type: 'indoor' }, filters: [eq('id', t.json.data.id)] }), 409, 'OV_SPORT_LOCKED')
    assert.equal((await sql.query('SELECT sport_type::text AS s FROM matches WHERE id = $1', [t.json.data.id])).rows[0].s, 'beach')
  })

  it('GET /api/me: indoor flags on top, both apps with membership', async () => {
    assert.equal((await call(null, 'GET', '/api/me')).status, 401)
    const bea = await call(users.bea, 'GET', '/api/me')
    assert.equal(bea.status, 200, bea.text)
    assert.equal(bea.headers.get('cache-control'), 'no-store')
    const d = bea.json.data
    assert.equal(d.id, users.bea.id)
    assert.deepEqual(d.roles, ['beach:scorer'])
    // an OpenVolley 2.1/2.2 client reads the top level: pending there
    assert.deepEqual([d.canScore, d.canReadTeams, d.isPending, d.isAdmin], [false, false, true, false])
    assert.deepEqual(d.apps.beach, { member: true, roles: ['beach:scorer'], canScore: true, canManageTeams: false, canReadTeams: true, isPending: false })
    assert.equal(d.apps.indoor.canScore, false)
    assert.equal(d.apps.indoor.isPending, true)
    const ivan = (await call(users.ivan, 'GET', '/api/me')).json.data
    assert.deepEqual([ivan.canScore, ivan.isPending, ivan.apps.indoor.member, ivan.apps.beach.member, ivan.apps.beach.canScore], [true, false, true, false, false])
    const admin = (await call(users.admin, 'GET', '/api/me')).json.data
    assert.deepEqual([admin.apps.indoor.canScore, admin.apps.beach.canScore, admin.apps.indoor.member, admin.apps.beach.member], [true, true, true, true])
  })

  it('invite codes per sport: a beach code grants beach:<role> and the beach membership', async () => {
    const indoorCode = await call(users.admin, 'POST', '/api/admin/invites', { label: 'Indoor club' })
    assert.equal(indoorCode.status, 201, indoorCode.text)
    assert.equal(indoorCode.json.data.invite.sport, 'indoor')
    const beachCode = await call(users.admin, 'POST', '/api/admin/invites?app=beach', { label: 'Zürich tour volunteers', max_uses: 30 })
    assert.equal(beachCode.status, 201, beachCode.text)
    assert.equal(beachCode.json.data.invite.sport, 'beach')
    assert.equal(beachCode.json.data.invite.role, 'scorer')
    const body = await call(users.admin, 'POST', '/api/admin/invites', { label: 'Beach refs', role: 'referee', sport: 'beach' })
    assert.equal(body.json.data.invite.sport, 'beach')
    expectCode(await call(users.admin, 'POST', '/api/admin/invites?app=beach', { label: 'x', sport: 'indoor' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.admin, 'POST', '/api/admin/invites', { label: 'x', sport: 'snow' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.admin, 'POST', '/api/admin/invites', { label: 'x', role: 'beach:scorer' }), 400, 'OV_INVALID_ROLE')

    const beachList = (await call(users.admin, 'GET', '/api/admin/invites?app=beach')).json.data.invites
    assert.ok(beachList.length >= 2 && beachList.every((i) => i.sport === 'beach'))
    const indoorList = (await call(users.admin, 'GET', '/api/admin/invites?app=indoor')).json.data.invites
    assert.ok(indoorList.some((i) => i.id === indoorCode.json.data.invite.id))
    assert.equal(indoorList.some((i) => i.sport === 'beach'), false)
    const allList = (await call(users.admin, 'GET', '/api/admin/invites')).json.data.invites
    assert.ok(allList.length >= beachList.length + indoorList.length, 'no ?app=: every code, as before')
    expectCode(await call(users.admin, 'GET', '/api/admin/invites?app=snow'), 400, 'OV_INVALID_REQUEST')

    const v = await account('volunteer')
    const red = await call(v, 'POST', '/api/account/redeem-invite', { code: beachCode.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.deepEqual(red.json.data, { roles: ['beach:scorer'], role_granted: 'beach:scorer', already_had: false, sport: 'beach' })
    assert.deepEqual(await memberships(v.id), ['beach', 'indoor'], 'joined beach; its implicit indoor membership is kept')
    const me = (await call(v, 'GET', '/api/me')).json.data
    assert.deepEqual([me.apps.beach.canScore, me.apps.beach.member, me.isPending, me.canScore], [true, true, true, false])
    // it scores beach, not indoor
    assert.equal((await insert(v, match('beach'))).status, 200)
    expectCode(await insert(v, match('indoor')), 403, 'OV_SCORER_REQUIRED')
    // a second redemption is idempotent
    assert.equal((await call(v, 'POST', '/api/account/redeem-invite', { code: beachCode.json.data.code })).json.data.already_had, true)

    // the audit per app
    const beachAudit = (await call(users.admin, 'GET', '/api/admin/audit?app=beach&limit=200')).json.data.entries
    assert.ok(beachAudit.some((e) => e.action === 'invite.create' && e.details.invite_id === beachCode.json.data.invite.id))
    const redeem = beachAudit.find((e) => e.action === 'invite.redeem' && e.target_email === v.email)
    assert.deepEqual(redeem.details, { invite_id: beachCode.json.data.invite.id, label: 'Zürich tour volunteers', role: 'beach:scorer', sport: 'beach' })
    assert.ok(beachAudit.every((e) => e.app === 'beach'))
    const indoorAudit = (await call(users.admin, 'GET', '/api/admin/audit?app=indoor&limit=200')).json.data.entries
    assert.ok(indoorAudit.some((e) => e.action === 'invite.create' && e.details.invite_id === indoorCode.json.data.invite.id))
    assert.equal(indoorAudit.some((e) => e.app === 'beach' || e.details.invite_id === beachCode.json.data.invite.id), false)
    expectCode(await call(users.admin, 'GET', '/api/admin/audit?app=snow'), 400, 'OV_INVALID_REQUEST')
  })

  it('Join OpenBeach with your existing password: POST /api/account/join', async () => {
    expectCode(await call(null, 'POST', '/api/account/join', { app: 'beach' }), 401, 'missing_token')
    const ex = await account('existing') // an OpenVolley account
    assert.deepEqual(await memberships(ex.id), [], 'sign-up writes no membership yet: no row counts as indoor')
    let me = (await call(ex, 'GET', '/api/me')).json.data
    assert.deepEqual([me.apps.indoor.member, me.apps.beach.member], [true, false])
    expectCode(await call(ex, 'POST', '/api/account/join', { app: 'snow' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(ex, 'POST', '/api/account/join', {}), 400, 'OV_INVALID_REQUEST')

    // the same password signs in from OpenBeach; then it joins
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': nextIp() }, body: { email: ex.email, password: ex.password } })
    assert.equal(inn.status, 200, inn.text)
    const beachSession = { token: inn.json.data.session.access_token }
    const j = await call(beachSession, 'POST', '/api/account/join', { app: 'beach' })
    assert.equal(j.status, 200, j.text)
    assert.deepEqual(j.json.data, { app: 'beach', member: true, already_member: false })
    assert.deepEqual((await call(ex, 'POST', '/api/account/join', { app: 'beach' })).json.data, { app: 'beach', member: true, already_member: true })
    assert.deepEqual(await memberships(ex.id), ['beach', 'indoor'])
    me = (await call(ex, 'GET', '/api/me')).json.data
    // joined but without a beach role: pending in OpenBeach, writes beach test matches only
    assert.deepEqual([me.apps.beach.member, me.apps.beach.isPending, me.apps.beach.canScore], [true, true, false])
    expectCode(await insert(ex, match('beach')), 403, 'OV_SCORER_REQUIRED')
    const audits = (await sql.query("SELECT app, details FROM public.audit_log WHERE action = 'account.join' AND actor_id = $1", [ex.id])).rows
    assert.deepEqual(audits, [{ app: 'beach', details: { app: 'beach' } }], 'audited once')

    // the beach console lists it as pending; the indoor console too (no indoor role either)
    const beachPending = (await call(users.admin, 'GET', '/api/admin/accounts?app=beach&filter=pending')).json.data.accounts
    assert.ok(beachPending.some((a) => a.id === ex.id && a.pending === true))
    const indoorPending = (await call(users.admin, 'GET', '/api/admin/accounts?app=indoor&filter=pending')).json.data.accounts
    assert.ok(indoorPending.some((a) => a.id === ex.id))
    // beach members only on the beach list: the indoor scorer is not there
    const beachAll = (await call(users.admin, 'GET', '/api/admin/accounts?app=beach&filter=all')).json.data.accounts
    assert.equal(beachAll.some((a) => a.id === users.ivan.id), false)
    assert.ok(beachAll.some((a) => a.id === users.bea.id), 'a beach role counts as membership')
    assert.ok(beachAll.some((a) => a.id === users.admin.id), 'the global admin is in both')
    // the indoor list has no beach-only member (the volunteer has its implicit indoor row; bea had no row: indoor)
    const indoorAll = (await call(users.admin, 'GET', '/api/admin/accounts?app=indoor&filter=all')).json.data.accounts
    assert.ok(indoorAll.some((a) => a.id === users.ivan.id))
    expectCode(await call(users.admin, 'GET', '/api/admin/accounts?app=snow'), 400, 'OV_INVALID_REQUEST')
    // no ?app=: as before (pending = no indoor role), so the beach scorer is pending there
    const legacyPending = (await call(users.admin, 'GET', '/api/admin/accounts?filter=pending')).json.data.accounts
    assert.ok(legacyPending.some((a) => a.id === users.bea.id && a.pending === true))
    assert.equal(legacyPending.some((a) => a.id === users.ivan.id), false)
  })

  it('an account that joined only OpenBeach is not an indoor member', async () => {
    const only = await account('beachonly')
    await sql.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'signup')", [only.id])
    const me = (await call(only, 'GET', '/api/me')).json.data
    assert.deepEqual([me.apps.indoor.member, me.apps.beach.member], [false, true])
    const indoorAll = (await call(users.admin, 'GET', `/api/admin/accounts?app=indoor&filter=all&q=${encodeURIComponent(only.email)}`)).json.data.accounts
    assert.deepEqual(indoorAll, [])
    // joining indoor later is the same endpoint
    assert.equal((await call(only, 'POST', '/api/account/join', { app: 'indoor' })).json.data.already_member, false)
    assert.deepEqual(await memberships(only.id), ['beach', 'indoor'])
  })

  it('an admin grants beach roles per app; each app keeps its own audit entry', async () => {
    const t = await account('target')
    const r = await call(users.admin, 'POST', `/api/admin/accounts/${t.id}/roles`, { add: ['beach:competition_manager', 'referee'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.roles, ['beach:competition_manager', 'referee'])
    assert.deepEqual(await memberships(t.id), ['beach', 'indoor'])
    const entries = (await sql.query("SELECT app, details FROM public.audit_log WHERE action = 'account.roles' AND target_user_id = $1 ORDER BY id", [t.id])).rows
    assert.deepEqual(entries.map((e) => [e.app, e.details.added]).sort(), [[null, ['referee']], ['beach', ['beach:competition_manager']]].sort())
    expectCode(await call(users.admin, 'POST', `/api/admin/accounts/${t.id}/roles`, { add: ['beach:admin'] }), 400, 'OV_INVALID_ROLE')
    // the beach competition manager manages beach pairs only
    const c = await call(t, 'POST', '/api/saved-teams/competitions', { name: 'Tour', season: '2026', sport: 'beach' })
    assert.equal(c.status, 201, c.text)
    expectCode(await call(t, 'POST', '/api/saved-teams/competitions', { name: 'Liga', season: '2026/27' }), 403, 'OV_FORBIDDEN')
  })

  it('the admin match list filters by ?app=; nobody but the admin uses /api/admin/*', async () => {
    const beach = (await call(users.admin, 'GET', '/api/admin/matches?app=beach&state=all')).json.data.matches
    assert.ok(beach.length > 0 && beach.every((m) => m.sport === 'beach'))
    const indoor = (await call(users.admin, 'GET', '/api/admin/matches?app=indoor&state=all')).json.data.matches
    assert.ok(indoor.length > 0 && indoor.every((m) => m.sport === 'indoor'))
    const all = (await call(users.admin, 'GET', '/api/admin/matches?state=all')).json.data.matches
    assert.equal(all.length, beach.length + indoor.length)
    for (const u of [users.bea, users.ivan, users.target]) {
      expectCode(await call(u, 'GET', '/api/admin/accounts?app=beach'), 403, 'OV_FORBIDDEN')
      expectCode(await call(u, 'GET', '/api/admin/invites?app=beach'), 403, 'OV_FORBIDDEN')
    }
  })

  it('a beach match closes with a beach audit entry; roles stay off /api/db', async () => {
    const b = await insert(users.bea, match('beach'))
    assert.equal((await dbCall(users.bea, 'matches', 'update', { data: { status: 'final' }, filters: [eq('id', b.json.data.id)] })).status, 200)
    const { rows: [e] } = await sql.query("SELECT app FROM public.audit_log WHERE action = 'match.close' AND match_id = $1", [b.json.data.id])
    assert.equal(e.app, 'beach')
    // an admin action on it takes the match's app too
    const re = await call(users.admin, 'POST', `/api/admin/matches/${b.json.data.id}/reopen`, { reason: 'Wrong final score' })
    assert.equal(re.status, 200, re.text)
    const { rows: [ro] } = await sql.query("SELECT app FROM public.audit_log WHERE action = 'match.reopen' AND match_id = $1", [b.json.data.id])
    assert.equal(ro.app, 'beach')
    const i = await insert(users.ivan, match('indoor'))
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${i.json.data.id}/release-game`, { reason: 'Duplicate' })).status, 200)
    const { rows: [rg] } = await sql.query("SELECT app FROM public.audit_log WHERE action = 'match.release_game' AND match_id = $1", [i.json.data.id])
    assert.equal(rg.app, null, 'indoor entries keep app NULL')
    // nobody grants itself a beach role through /api/db
    const self = await dbCall(users.ivan, 'profiles', 'update', { data: { roles: ['beach:scorer'] }, filters: [eq('user_id', users.ivan.id)] })
    assert.equal((await sql.query('SELECT roles FROM profiles WHERE user_id = $1', [users.ivan.id])).rows[0].roles.includes('beach:scorer'), false, self.text)
    expectCode(await dbCall(users.admin, 'app_memberships', 'select', { columns: '*' }), 400, 'OV_INVALID_REQUEST')
  })
})
