/**
 * Audit 2611 PERM-17: POST /api/match/known (and /api/db's 404 for an update
 * of one match the server lacks) told any signed-in account whether any
 * match had been deleted (external_ids are public). 'deleted' is now said
 * only to the accounts that could write the match when it went (its creator
 * and editors, db/056 deleted_matches.owners) and to admins; anyone else
 * hears 'unknown' (OV_MATCH_UNKNOWN), as of a match never stored. The app
 * that holds the match's sent jobs is its creator's or an editor's, so it
 * still hears 'deleted' and never sends a deleted match again.
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

describe('who hears that a match was deleted (PERM-17)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot
  let ipN = 60
  const nextIp = () => `198.51.100.${ipN++}`
  let gameN = 93000

  async function account (name, roles = ['scorer']) {
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
    await grantRoles(sql, u.id, roles)
    return u
  }
  const dbCall = (user, action, params) =>
    api(srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': user.ip }, body: { table: 'matches', action, params } })
  const known = async (user, ext) => {
    const r = await api(srv.base, '/api/match/known', { token: user.token, headers: { 'cf-connecting-ip': user.ip }, body: { external_id: ext } })
    assert.equal(r.status, 200, r.text)
    return r.json.data.state
  }
  const updateCode = async (user, ext) => (await dbCall(user, 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'external_id', value: ext }] })).json?.error?.code ?? null
  async function deletedMatch (owner, { editor } = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const pin = String(100000 + Math.floor(Math.random() * 899999))
    assert.equal((await dbCall(owner, 'insert', { data: { external_id: ext, game_n: gameN++, status: 'live', game_pin: pin } })).status, 200)
    if (editor) {
      const c = await api(srv.base, '/api/match/claim', { token: editor.token, headers: { 'cf-connecting-ip': editor.ip }, body: { externalId: ext, pin } })
      assert.equal(c.status, 200, c.text)
    }
    assert.equal((await dbCall(owner, 'delete', { filters: [{ type: 'eq', column: 'external_id', value: ext }] })).status, 200)
    return ext
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-known-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    srv = await bootServer({ DATABASE_URL: db.appUrl(), STORAGE_ROOT: storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('the creator, an editor and an admin hear "deleted"; another account hears "unknown", as of a match never stored', async () => {
    const owner = await account('owner')
    const editor = await account('editor')
    const outsider = await account('outsider')
    const admin = await account('admin', ['admin'])
    const ext = await deletedMatch(owner, { editor })
    assert.deepEqual((await sql.query('SELECT owners FROM deleted_matches WHERE external_id = $1', [ext])).rows[0].owners.sort(), [owner.id, editor.id].sort())

    assert.equal(await known(owner, ext), 'deleted')
    assert.equal(await known(editor, ext), 'deleted')
    assert.equal(await known(admin, ext), 'deleted')
    assert.equal(await known(outsider, ext), 'unknown')
    assert.equal(await known(outsider, `match_${Date.now()}_never`), 'unknown')

    // the update of one match that matched no row answers the same
    assert.equal(await updateCode(owner, ext), 'OV_MATCH_DELETED')
    assert.equal(await updateCode(editor, ext), 'OV_MATCH_DELETED')
    assert.equal(await updateCode(outsider, ext), 'OV_MATCH_UNKNOWN')
  })

  it('a stored match is "stored" to anyone (public through /api/db; "unknown" would make an app send it again)', async () => {
    const owner = await account('keeper')
    const outsider = await account('stranger')
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    assert.equal((await dbCall(owner, 'insert', { data: { external_id: ext, game_n: gameN++, status: 'live', game_pin: '615283' } })).status, 200)
    assert.equal(await known(owner, ext), 'stored')
    assert.equal(await known(outsider, ext), 'stored')
  })

  it('a match deleted before db/056 (no owners kept) answers as before; an account that goes leaves the lists', async () => {
    const owner = await account('legacy')
    const outsider = await account('passerby')
    const ext = await deletedMatch(owner)
    await sql.query('UPDATE deleted_matches SET owners = NULL WHERE external_id = $1', [ext])
    assert.equal(await known(outsider, ext), 'deleted')

    const gone = await account('gone')
    const ext2 = await deletedMatch(gone)
    assert.deepEqual((await sql.query('SELECT owners FROM deleted_matches WHERE external_id = $1', [ext2])).rows[0].owners, [gone.id])
    await sql.query('DELETE FROM auth.users WHERE id = $1', [gone.id])
    assert.deepEqual((await sql.query('SELECT owners FROM deleted_matches WHERE external_id = $1', [ext2])).rows[0].owners, [])
    assert.equal(await known(outsider, ext2), 'unknown')
  })
})
