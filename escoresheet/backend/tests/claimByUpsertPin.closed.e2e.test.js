/**
 * Audit 2611 PERM-16: the inline game-PIN take-over of /api/db (server.js
 * claimByUpsertPin) added a match_editors row (granted_via game_pin) and an
 * audit entry to a match closed longer ago than POST /api/match/claim allows
 * (lib/matchRestore.js closedClaimWindowMs, 6 h): the game PIN is retired at
 * the close. Past the window it now adds no editor and answers 409
 * OV_MATCH_CLOSED, as the claim does. Within it nothing changed.
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

describe('inline take-over by game PIN of a closed match (PERM-16)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot
  let ipN = 10
  const nextIp = () => `198.51.100.${ipN++}`

  async function account (name) {
    const ip = nextIp()
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })).status, 200)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, ip }
    await grantRoles(sql, u.id, ['scorer'])
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { table, action, params } })
  const editors = async (ext) => (await sql.query(
    'SELECT e.user_id, e.granted_via FROM match_editors e JOIN matches m ON m.id = e.match_id WHERE m.external_id = $1', [ext])).rows
  const claimAudits = async (ext) => (await sql.query(
    "SELECT count(*)::int AS n FROM audit_log a JOIN matches m ON m.id = a.match_id WHERE m.external_id = $1 AND a.action = 'match.claim_pin'", [ext])).rows[0].n

  // An approved (closed) match of `owner`, closed `hoursAgo` hours ago
  async function closedMatch (owner, hoursAgo) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const pin = String(100000 + Math.floor(Math.random() * 899999))
    const ins = await dbCall(owner, 'matches', 'insert', { data: { external_id: ext, game_n: 92000 + ipN, status: 'approved', game_pin: pin } })
    assert.equal(ins.status, 200, ins.text)
    const c = await sql.query('SELECT closed_at FROM matches WHERE external_id = $1', [ext])
    assert.notEqual(c.rows[0].closed_at, null, 'closed by db/007')
    await sql.query('BEGIN')
    await sql.query("SELECT set_config('ov.allow_closed', 'on', true)")
    await sql.query(`UPDATE matches SET closed_at = now() - make_interval(hours => $2), first_closed_at = now() - make_interval(hours => $2) WHERE external_id = $1`, [ext, hoursAgo])
    await sql.query('COMMIT')
    return { ext, pin }
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-closedclaim-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    srv = await bootServer({ DATABASE_URL: db.appUrl(), STORAGE_ROOT: storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('past the window: no editor, no audit entry, 409 OV_MATCH_CLOSED (as POST /api/match/claim)', async () => {
    const owner = await account('olga')
    const other = await account('pius')
    const { ext, pin } = await closedMatch(owner, 7)

    const claim = await api(srv.base, '/api/match/claim', { token: other.token, headers: { 'cf-connecting-ip': other.ip }, body: { externalId: ext, pin } })
    assert.equal(claim.status, 409, claim.text)
    assert.equal(claim.json.error.code, 'OV_MATCH_CLOSED')

    const up = await dbCall(other, 'matches', 'upsert', { data: { external_id: ext, game_pin: pin }, onConflict: 'external_id' })
    assert.equal(up.status, 409, up.text)
    assert.equal(up.json.error.code, 'OV_MATCH_CLOSED')
    assert.deepEqual(await editors(ext), [])
    assert.equal(await claimAudits(ext), 0)

    // a wrong PIN still is just not the owner
    const wrong = await dbCall(other, 'matches', 'upsert', { data: { external_id: ext, game_pin: '000001' }, onConflict: 'external_id' })
    assert.equal(wrong.status, 403, wrong.text)
    assert.equal(wrong.json.error.code, 'OV_NOT_MATCH_OWNER')
  })

  it('within the window the take-over is unchanged: the account becomes an editor', async () => {
    const owner = await account('rita')
    const other = await account('sepp')
    const { ext, pin } = await closedMatch(owner, 1)
    const up = await dbCall(other, 'matches', 'upsert', { data: { external_id: ext, game_pin: pin }, onConflict: 'external_id' })
    assert.notEqual(up.json?.error?.code, 'OV_NOT_MATCH_OWNER', up.text)
    assert.deepEqual((await editors(ext)).map((e) => [e.user_id, e.granted_via]), [[other.id, 'game_pin']])
    assert.equal(await claimAudits(ext), 1)
  })
})
