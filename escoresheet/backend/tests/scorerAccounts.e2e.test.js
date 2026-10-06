/**
 * Approved scorers, one cloud match per official game, server-locked closing,
 * the admin console and saved teams, end to end through server.js
 * (docs/scorer-accounts-spec.md section 7, db/007).
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, openSocket, subscribe } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '583920'

describe('scorer accounts end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  let gameSeq = 70100

  async function account (name, { first = name, last = 'Test', roles = null } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: first, last_name: last, roles: ['admin'] } } })
    assert.equal(up.status, 200, up.text)
    // lib/auth.js allows 5 sign-ins a second in total (503 auth_busy beyond): wait and retry
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const call = (user, method, path, body, headers = {}) =>
    api(srv.base, path, { method, token: user?.token, body, proto: null, headers })
  const upload = (user, bucket, path, content) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket, path, fileBase64: Buffer.from(content).toString('base64'), contentType: 'application/json' } })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const eq = (column, value) => ({ type: 'eq', column, value })
  const auditRows = async (action) => (await sql.query('SELECT * FROM public.audit_log WHERE action = $1 ORDER BY id', [action])).rows

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-scorer-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-scorer-status-'))
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
    await account('admin', { first: 'Ada', last: 'Admin', roles: ['admin'] })
    await account('anna', { first: 'Anna', last: 'Muster', roles: ['scorer'] })
    await account('ben', { first: 'Ben', last: 'Beispiel', roles: ['scorer'] })
    await account('carl', { first: 'Carl', last: 'Fremd', roles: ['scorer'] })
    await account('cm', { first: 'Cora', last: 'Manager', roles: ['competition_manager'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('a pending account scores test matches only, until it redeems an invite code', async () => {
    const p = await account('pending', { first: 'Pia' })
    const prof = await api(srv.base, '/api/auth/profile', { body: { access_token: p.token } })
    assert.deepEqual(prof.json.data.roles, [], 'sign-up gives no role, whatever the client sent')

    const official = { external_id: `match_${Date.now()}_pend`, game_n: gameSeq++, status: 'setup', game_pin: GAME_PIN }
    expectCode(await dbCall(p, 'matches', 'insert', { data: official }), 403, 'OV_SCORER_REQUIRED')
    expectCode(await dbCall(p, 'matches', 'upsert', { data: official, onConflict: 'external_id' }), 403, 'OV_SCORER_REQUIRED')
    const testExt = `match_${Date.now()}_test`
    const test = await dbCall(p, 'matches', 'insert', { data: { external_id: testExt, game_n: 1, test: true, status: 'setup' }, returning: 'id', single: true })
    assert.equal(test.status, 200, test.text)
    assert.equal((await dbCall(p, 'sets', 'insert', { data: { external_id: `${testExt}:s:1`, match_id: test.json.data.id, index: 1 } })).status, 200, 'children of a test match')
    assert.equal((await dbCall(p, 'matches', 'update', { data: { status: 'final' }, filters: [eq('id', test.json.data.id)] })).status, 200, 'a test match may be finished')
    expectCode(await dbCall(p, 'matches', 'update', { data: { test: false }, filters: [eq('id', test.json.data.id)] }), 403, 'OV_SCORER_REQUIRED')
    expectCode(await upload(p, 'scoresheets', '2026-10-05/game1_final.json', '{}'), 403, 'OV_SCORER_REQUIRED')
    assert.equal((await upload(p, 'backup', 'backups/backup_g1/b1.json', '{"x":1}')).status, 200)
    expectCode(await call(p, 'POST', '/api/match/official-check', { game_n: 5 }), 403, 'OV_SCORER_REQUIRED')
    expectCode(await call(p, 'GET', '/api/saved-teams'), 403, 'OV_FORBIDDEN')

    const inv = await call(users.admin, 'POST', '/api/admin/invites', { label: 'Club X', club: 'VBC X' })
    assert.equal(inv.status, 201, inv.text)
    assert.equal(inv.headers.get('cache-control'), 'no-store')
    const red = await call(p, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code.toLowerCase() })
    assert.equal(red.status, 200, red.text)
    assert.deepEqual(red.json.data, { roles: ['scorer'], role_granted: 'scorer', already_had: false })
    const ok = await dbCall(p, 'matches', 'insert', { data: official })
    assert.equal(ok.status, 200, ok.text)
    // single use: another pending account cannot use it
    const q = await account('pending2')
    expectCode(await call(q, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code }), 409, 'OV_INVITE_USED_UP')
    const audit = await auditRows('invite.redeem')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].target_user_id, p.id)
  })

  it('invite codes: expired 410, revoked 404, and failed attempts are rate limited per account and IP', async () => {
    const r = await account('redeemer')
    const mk = async (body) => (await call(users.admin, 'POST', '/api/admin/invites', { label: 'L', ...body })).json.data
    const exp = await mk({})
    await sql.query("UPDATE public.invite_codes SET expires_at = now() - interval '1 second' WHERE id = $1", [exp.invite.id])
    expectCode(await call(r, 'POST', '/api/account/redeem-invite', { code: exp.code }), 410, 'OV_INVITE_EXPIRED')
    const rev = await mk({})
    assert.equal((await call(users.admin, 'POST', `/api/admin/invites/${rev.invite.id}/revoke`)).json.data.invite.state, 'revoked')
    expectCode(await call(r, 'POST', '/api/account/redeem-invite', { code: rev.code }), 404, 'OV_INVITE_INVALID')

    // a fresh account and IP: 10 failed attempts, then 429 for 10 minutes
    const brute = await account('brute')
    const ip = { 'cf-connecting-ip': '198.18.0.77' }
    for (let i = 0; i < 10; i++) {
      expectCode(await call(brute, 'POST', '/api/account/redeem-invite', { code: `ZZZZ-ZZZZ-ZZ${String(i).padStart(2, '0')}`.replace(/\d/g, 'Z') }, ip), 404, 'OV_INVITE_INVALID')
    }
    const blocked = await call(brute, 'POST', '/api/account/redeem-invite', { code: (await mk({})).code }, ip)
    expectCode(blocked, 429, 'OV_TOO_MANY_ATTEMPTS')
    assert.equal(blocked.headers.get('retry-after'), '600')
    // the IP bucket blocks another account on the same address, not one elsewhere
    const other = await account('other-ip')
    expectCode(await call(other, 'POST', '/api/account/redeem-invite', { code: 'ZZZZ-ZZZZ-ZZZZ' }, ip), 429, 'OV_TOO_MANY_ATTEMPTS')
    expectCode(await call(other, 'POST', '/api/account/redeem-invite', { code: 'ZZZZ-ZZZZ-ZZZZ' }, { 'cf-connecting-ip': '198.18.0.78' }), 404, 'OV_INVITE_INVALID')
    // a success does not count
    const fresh = await account('fresh-ok')
    const fip = { 'cf-connecting-ip': '198.18.0.90' }
    for (let i = 0; i < 9; i++) await call(fresh, 'POST', '/api/account/redeem-invite', { code: 'ZZZZ-ZZZZ-ZZZZ' }, fip)
    assert.equal((await call(fresh, 'POST', '/api/account/redeem-invite', { code: (await mk({})).code }, fip)).status, 200)
    expectCode(await call(fresh, 'POST', '/api/account/redeem-invite', { code: 'ZZZZ-ZZZZ-ZZZZ' }, fip), 404, 'OV_INVITE_INVALID')
  })

  it('an admin approves a pending account', async () => {
    const w = await account('waiting')
    const list = await call(users.admin, 'GET', '/api/admin/accounts?filter=pending')
    assert.equal(list.status, 200, list.text)
    assert.ok(list.json.data.accounts.some((a) => a.id === w.id && a.pending === true))
    expectCode(await dbCall(w, 'matches', 'insert', { data: { external_id: `match_${Date.now()}_w`, game_n: gameSeq++ } }), 403, 'OV_SCORER_REQUIRED')
    const r = await call(users.admin, 'POST', `/api/admin/accounts/${w.id}/roles`, { add: ['scorer'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.roles, ['scorer'])
    assert.equal((await dbCall(w, 'matches', 'insert', { data: { external_id: `match_${Date.now()}_w2`, game_n: gameSeq++ } })).status, 200, 'the access cache was invalidated')
    const list2 = await call(users.admin, 'GET', '/api/admin/accounts?filter=pending')
    assert.equal(list2.json.data.accounts.some((a) => a.id === w.id), false)
    expectCode(await call(users.admin, 'POST', `/api/admin/accounts/${users.admin.id}/roles`, { remove: ['admin'] }), 409, 'OV_SELF_DEMOTE')
    expectCode(await call(users.admin, 'POST', `/api/admin/accounts/${w.id}/roles`, { add: ['super_admin'] }), 400, 'OV_INVALID_ROLE')
  })

  describe('one official game, two scorers, closing and reopening', () => {
    const ext = `match_${Date.now()}_anna`
    let n, matchId

    it('the second scorer gets 409 OV_GAME_TAKEN with a clean claim, audited once', async () => {
      n = gameSeq++
      const a = await dbCall(users.anna, 'matches', 'insert', { data: { external_id: ext, game_n: n, status: 'live', game_pin: GAME_PIN, scheduled_at: '2026-10-10T16:00:00Z', home_team: { name: 'Home' } }, returning: 'id', single: true })
      assert.equal(a.status, 200, a.text)
      matchId = a.json.data.id
      assert.equal((await dbCall(users.anna, 'sets', 'insert', { data: { external_id: `${ext}:s:1`, match_id: matchId, index: 1 } })).status, 200)

      const second = { external_id: `match_${Date.now()}_ben`, game_n: n, status: 'setup', game_pin: '111222', scheduled_at: '2026-10-10T16:00:00Z', official_game_exempt: true }
      for (let i = 0; i < 2; i++) {
        const b = await dbCall(users.ben, 'matches', 'upsert', { data: second, onConflict: 'external_id' })
        expectCode(b, 409, 'OV_GAME_TAKEN')
        assert.deepEqual(b.json.error.claim, { game_n: n, season: 2026, sport: 'indoor', status: 'live', scorer_name: 'Anna Muster', mine: false, scheduled_at: '2026-10-10T16:00:00.000Z' })
        for (const secret of [GAME_PIN, users.anna.email, users.anna.id, ext, matchId]) assert.equal(b.text.includes(secret), false, secret)
      }
      assert.equal((await auditRows('match.game_taken')).filter((r) => r.actor_id === users.ben.id).length, 1)
      assert.equal((await auditRows('match.claim_game')).filter((r) => r.match_id === matchId).length, 1)

      const chk = await call(users.ben, 'POST', '/api/match/official-check', { game_n: n, scheduled_at: '2026-10-11T10:00:00Z', sport_type: 'indoor', external_id: null })
      assert.equal(chk.status, 200, chk.text)
      assert.equal(chk.json.data.taken, true)
      assert.equal(chk.json.data.claim.mine, false)
      assert.equal((await call(users.anna, 'POST', '/api/match/official-check', { game_n: n, scheduled_at: '2026-10-11T10:00:00Z', sport_type: 'indoor', external_id: 'other-device' })).json.data.claim.mine, true)
      assert.deepEqual((await call(users.ben, 'POST', '/api/match/official-check', { game_n: n, scheduled_at: '2027-10-11T10:00:00Z', sport_type: 'indoor' })).json.data, { taken: false })
      // a test match for the same game is fine
      assert.equal((await dbCall(users.ben, 'matches', 'insert', { data: { ...second, external_id: `match_${Date.now()}_bt`, test: true } })).status, 200)
    })

    it('the second scorer joins with the game PIN (restore-by-pin) and may then write', async () => {
      expectCode(await dbCall(users.ben, 'matches', 'update', { data: { status: 'live' }, filters: [eq('id', matchId)] }), 403, 'OV_NOT_MATCH_OWNER')
      const r = await api(srv.base, '/api/match/restore-by-pin', { token: users.ben.token, body: { gameN: n, pin: GAME_PIN } })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.access, 'editor')
      for (const k of ['created_by', 'closed_by', 'official_game_exempt', 'game_pin']) assert.equal(k in r.json.data.match, false, k)
      assert.equal((await auditRows('match.claim_pin')).filter((x) => x.actor_id === users.ben.id && x.details.via === 'restore-by-pin').length, 1)
      assert.equal((await dbCall(users.ben, 'sets', 'insert', { data: { external_id: `${ext}:s:2`, match_id: matchId, index: 2 } })).status, 200)
    })

    it('closing is locked: a non-owner cannot close, nobody writes after, approved -> final passes', async () => {
      expectCode(await dbCall(users.carl, 'matches', 'update', { data: { status: 'final' }, filters: [eq('id', matchId)] }), 403, 'OV_NOT_MATCH_OWNER')
      // a client cannot stamp or exempt itself
      assert.equal((await dbCall(users.anna, 'matches', 'update', { data: { closed_at: '2001-01-01T00:00:00Z', official_game_exempt: true }, filters: [eq('id', matchId)] })).status, 200)
      let { rows: [m] } = await sql.query('SELECT closed_at, official_game_exempt FROM matches WHERE id = $1', [matchId])
      assert.deepEqual(m, { closed_at: null, official_game_exempt: false })

      const close = await dbCall(users.anna, 'matches', 'update', { data: { status: 'approved' }, filters: [eq('id', matchId)] })
      assert.equal(close.status, 200, close.text);
      ({ rows: [m] } = await sql.query('SELECT closed_at, closed_by FROM matches WHERE id = $1', [matchId]))
      assert.ok(m.closed_at)
      assert.equal(m.closed_by, users.anna.id)
      const [entry] = (await auditRows('match.close')).filter((x) => x.match_id === matchId)
      assert.equal(entry.actor_id, users.anna.id)

      expectCode(await dbCall(users.ben, 'sets', 'insert', { data: { external_id: `${ext}:s:3`, match_id: matchId, index: 3 } }), 409, 'OV_MATCH_CLOSED')
      expectCode(await dbCall(users.anna, 'events', 'upsert', { data: { external_id: `${ext}:e:1`, match_id: matchId, set_index: 1, type: 'point', seq: 1 }, onConflict: 'external_id' }), 409, 'OV_MATCH_CLOSED')
      expectCode(await dbCall(users.admin, 'matches', 'update', { data: { status: 'live' }, filters: [eq('id', matchId)] }), 409, 'OV_MATCH_CLOSED')
      const restore = await api(srv.base, '/api/match/restore', { token: users.anna.token, body: { match: { external_id: ext, game_n: n, status: 'live', scheduled_at: '2026-10-10T16:00:00Z' }, sets: [], events: [] } })
      expectCode(restore, 409, 'OV_MATCH_CLOSED')
      assert.equal((await sql.query('SELECT count(*)::int n FROM sets WHERE match_id = $1', [matchId])).rows[0].n, 2, 'nothing changed')
      assert.equal((await dbCall(users.anna, 'matches', 'update', { data: { status: 'final' }, filters: [eq('id', matchId)] })).status, 200)
    })

    it('only an admin reopens (audited), then the scorers write again', async () => {
      expectCode(await call(users.anna, 'POST', `/api/admin/matches/${matchId}/reopen`, { reason: 'please' }), 403, 'OV_FORBIDDEN')
      const r = await call(users.admin, 'POST', `/api/admin/matches/${matchId}/reopen`, { reason: 'Score correction' })
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.json.data.match, { id: matchId, external_id: ext, status: 'ended', closed_at: null })
      assert.equal((await dbCall(users.ben, 'sets', 'insert', { data: { external_id: `${ext}:s:3`, match_id: matchId, index: 3 } })).status, 200)
      const audit = await call(users.admin, 'GET', '/api/admin/audit?action=match.reopen')
      assert.equal(audit.status, 200, audit.text)
      assert.equal(audit.json.data.entries[0].details.reason, 'Score correction')
      assert.equal(audit.json.data.entries[0].actor_email, users.admin.email)
      expectCode(await call(users.admin, 'POST', `/api/admin/matches/${matchId}/reopen`, { reason: 'again!' }), 409, 'OV_NOT_CLOSED')
      const lst = await call(users.admin, 'GET', `/api/admin/matches?state=open&q=${n}`)
      assert.equal(lst.json.data.matches[0].editors, 1)
    })

    it('a released match cannot be moved onto a claimed game, and an update gets the friendly 409', async () => {
      // review: B's released match 74005 was PATCHed to game 74004 (Anna's)
      const bExt = `match_${Date.now()}_rel`
      const b = await dbCall(users.ben, 'matches', 'insert', { data: { external_id: bExt, game_n: gameSeq++, status: 'live', scheduled_at: '2026-10-10T16:00:00Z' }, returning: 'id', single: true })
      assert.equal(b.status, 200, b.text)
      assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${b.json.data.id}/release-game`, { reason: 'Wrong number' })).status, 200)
      const moved = await dbCall(users.ben, 'matches', 'update', { data: { game_n: n }, filters: [eq('id', b.json.data.id)] })
      expectCode(moved, 409, 'OV_GAME_TAKEN')
      assert.equal(moved.json.error.claim.scorer_name, 'Anna Muster')
      // the database refuses it too, without the server's pre-check
      await assert.rejects(() => sql.query('UPDATE matches SET game_n = $1 WHERE id = $2', [n, b.json.data.id]), (err) => err.code === '23505')
      const { rows: [row] } = await sql.query('SELECT game_n, official_game_exempt FROM matches WHERE id = $1', [b.json.data.id])
      assert.equal(row.official_game_exempt, true, 'unchanged')
      assert.notEqual(row.game_n, n)
    })

    it('created_at is the server\'s, and a date shifted out of VolleyManager\'s season is still taken', async () => {
      const g = gameSeq++
      await sql.query("INSERT INTO public.svrz_games (game_number, datetime, league) VALUES ($1, '2026-10-17T18:00:00', '2L')", [String(g)])
      const a = await dbCall(users.anna, 'matches', 'insert', { data: { external_id: `match_${Date.now()}_vm`, game_n: g, status: 'setup', scheduled_at: '2026-10-17T16:00:00Z', created_at: '2001-01-01T00:00:00Z' } })
      assert.equal(a.status, 200, a.text)
      const { rows: [row] } = await sql.query('SELECT created_at FROM matches WHERE game_n = $1', [g])
      assert.ok(Date.now() - row.created_at.getTime() < 60000, 'created_at is now(), not the client\'s')
      for (const data of [
        { external_id: `match_${Date.now()}_vm2`, game_n: g, status: 'setup', scheduled_at: '2027-10-17T16:00:00Z' },
        { external_id: `match_${Date.now()}_vm3`, game_n: g, status: 'setup', scheduled_at: null, created_at: '2024-10-17T16:00:00Z' }
      ]) {
        const r = await dbCall(users.carl, 'matches', 'upsert', { data, onConflict: 'external_id' })
        expectCode(r, 409, 'OV_GAME_TAKEN')
        assert.equal(r.json.error.claim.season, 2026)
      }
      assert.equal((await sql.query('SELECT count(*)::int n FROM matches WHERE game_n = $1 AND test IS NOT TRUE', [g])).rows[0].n, 1)
    })
  })

  it('the PIN-gated relay publishes no live score for a closed match', async () => {
    const ext = `match_${Date.now()}_relay`
    const m = await dbCall(users.anna, 'matches', 'insert', { data: { external_id: ext, game_n: gameSeq++, status: 'live', game_pin: GAME_PIN, scheduled_at: '2026-10-10T16:00:00Z' }, returning: 'id', single: true })
    assert.equal(m.status, 200, m.text)
    const id = m.json.data.id
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    const scoreboard = await openSocket(srv.wsUrl)
    try {
      await subscribe(live, 'relay-closed', [{ table: 'match_live_state', event: '*', column: 'match_id', value: id }])
      scoreboard.send({ type: 'sync-match-data', matchId: 41, match: { id: 41, seed_key: ext, gamePin: GAME_PIN, status: 'live' }, sets: [], events: [] })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((x) => x.type === 'pong')
      const push = (points) => scoreboard.send({ type: 'live-state-update', matchId: 41, liveState: { points_a: points, points_b: 0, match_id: id, updated_at: new Date(Date.now() + points * 1000).toISOString() } })
      push(3)
      await live.waitFor((x) => x.type === 'db-change' && x.table === 'match_live_state' && x.new?.points_a === 3, 5000, 'open match relayed')
      assert.equal((await dbCall(users.anna, 'matches', 'update', { data: { status: 'approved' }, filters: [eq('id', id)] })).status, 200)
      push(9)
      scoreboard.send({ type: 'ping' })
      await sleep(1000)
      assert.equal(live.messages.some((x) => x.type === 'db-change' && x.table === 'match_live_state' && x.new?.points_a === 9), false, 'closed: nothing relayed')
    } finally {
      scoreboard.ws.close()
      live.ws.close()
    }
  })

  it('the admin routes refuse non-admins (403) and anonymous callers (401)', async () => {
    const id = randomUUID()
    const routes = [
      ['GET', '/api/admin/accounts'], ['POST', `/api/admin/accounts/${id}/roles`], ['GET', '/api/admin/invites'], ['POST', '/api/admin/invites'],
      ['POST', `/api/admin/invites/${id}/revoke`], ['GET', '/api/admin/official-games'], ['GET', '/api/admin/matches'],
      ['POST', `/api/admin/matches/${id}/reopen`], ['POST', `/api/admin/matches/${id}/editors`], ['POST', `/api/admin/matches/${id}/release-game`],
      ['GET', '/api/admin/audit'], ['GET', '/api/admin/nope']
    ]
    for (const [method, path] of routes) {
      for (const u of [users.anna, users.cm]) expectCode(await call(u, method, path, method === 'GET' ? undefined : {}), 403, 'OV_FORBIDDEN')
      assert.equal((await call(null, method, path, method === 'GET' ? undefined : {})).status, 401, path)
    }
    expectCode(await call(users.admin, 'GET', '/api/admin/nope'), 404, 'OV_NOT_FOUND')
    expectCode(await call(users.admin, 'POST', '/api/admin/matches/not-a-uuid/reopen', { reason: 'xyz' }), 404, 'OV_NOT_FOUND')
    expectCode(await call(users.admin, 'DELETE', '/api/admin/invites'), 405, 'OV_METHOD_NOT_ALLOWED')
    const games = await call(users.admin, 'GET', '/api/admin/official-games')
    assert.equal(games.status, 200, games.text)
  })

  it('saved teams: never anonymous, scorers read, competition managers and admins write', async () => {
    const pending = await account('pending-st')
    assert.equal((await call(null, 'GET', '/api/saved-teams')).status, 401)
    expectCode(await call(pending, 'GET', '/api/saved-teams'), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.anna, 'POST', '/api/saved-teams/competitions', { name: 'Liga', season: '2026/27' }), 403, 'OV_FORBIDDEN')
    const c = await call(users.cm, 'POST', '/api/saved-teams/competitions', { name: '2. Liga', season: '2026/27', gender: 'women', vm_leagues: ['2L'] })
    assert.equal(c.status, 201, c.text)
    const t = await call(users.cm, 'POST', '/api/saved-teams/teams', { competition_id: c.json.data.competition.id, name: 'VBC Test', color: '#e2001a' })
    assert.equal(t.status, 201, t.text)
    const teamId = t.json.data.team.id
    expectCode(await call(users.cm, 'POST', '/api/saved-teams/teams', { competition_id: c.json.data.competition.id, name: 'vbc test' }), 409, 'OV_DUPLICATE')
    const put = await call(users.cm, 'PUT', `/api/saved-teams/teams/${teamId}/roster`, { players: [{ number: 4, first_name: 'Lia', last_name: 'Libera', dob: '2004-05-06', license_number: 'LIC-9', is_libero: true }], staff: [{ role: 'Coach', last_name: 'Trainer' }] })
    assert.equal(put.status, 200, put.text)
    expectCode(await call(users.anna, 'PUT', `/api/saved-teams/teams/${teamId}/roster`, { players: [], staff: [] }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.anna, 'DELETE', `/api/saved-teams/teams/${teamId}`), 403, 'OV_FORBIDDEN')
    assert.equal((await call(users.admin, 'PATCH', `/api/saved-teams/teams/${teamId}`, { short_name: 'VBC' })).status, 200)

    const bundle = await call(users.anna, 'GET', '/api/saved-teams')
    assert.equal(bundle.status, 200, bundle.text)
    assert.equal(bundle.headers.get('cache-control'), 'no-store')
    const team = bundle.json.data.teams.find((x) => x.id === teamId)
    assert.equal(team.players[0].dob, '2004-05-06')
    assert.equal(team.short_name, 'VBC')

    // never through /api/db (not on the allowlist), anonymous or signed in
    for (const table of ['competitions', 'competition_teams', 'competition_players', 'competition_staff', 'invite_codes', 'invite_redemptions', 'audit_log']) {
      expectCode(await dbCall(null, table, 'select', { columns: '*' }), 400, 'OV_INVALID_REQUEST')
      expectCode(await dbCall(users.admin, table, 'select', { columns: '*' }), 400, 'OV_INVALID_REQUEST')
      expectCode(await dbCall(users.admin, table, 'insert', { data: { name: 'x' } }), 400, 'OV_INVALID_REQUEST')
    }
    // and no personal data of a saved team reaches an anonymous reader anywhere
    const anonMatches = await dbCall(null, 'matches', 'select', { columns: '*' })
    assert.equal(anonMatches.text.includes('LIC-9'), false)
  })

  it('the reopen password endpoint is gone, and the CORS preflight allows PATCH', async () => {
    assert.equal((await api(srv.base, '/api/verify-reopen-password', { body: { password: 'x' } })).status, 404)
    const pre = await fetch(`${srv.base}/api/saved-teams/teams/${randomUUID()}`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH' } })
    assert.equal(pre.status, 200)
    assert.match(pre.headers.get('access-control-allow-methods'), /\bPATCH\b/)
  })
})
