/**
 * Audit 2611 PERM-07: any approved scorer could insert any number of rows
 * into the league-wide referee directory (referee_database) through /api/db
 * (201,000 in 2.5 s); past 200,000 rows every indoor picker was empty
 * (frontend lib/selectAll.js gave up), and below that the real referees were
 * buried. A non-admin now adds 1 to 5 referees per request, none already
 * there, at most 50 per account and 24 h; the account is recorded (db/056
 * created_by, admins only read it). Admins are not capped.
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

const hex = () => randomBytes(3).toString('hex')

describe('referee directory writes (PERM-07)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot
  let ipN = 30
  const nextIp = () => `198.51.100.${ipN++}`

  async function account (name, roles) {
    const ip = nextIp()
    const email = `${name}-${hex()}@example.ch`
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
    api(srv.base, '/api/db', { token: user.token, proto: action === 'select' ? null : '2', headers: { 'cf-connecting-ip': user.ip }, body: { table: 'referee_database', action, params } })
  // what the apps insert (useOfficialHistory saveReferee, OpenBeach too)
  const referee = (last, first = 'Rita', sport = 'indoor') => ({ first_name: first, last_name: last, country: 'CHE', dob: null, sport_type: [sport], created_at: '2001-01-01T00:00:00.000Z' })
  const countBy = async (userId) => (await sql.query('SELECT count(*)::int AS n FROM referee_database WHERE created_by = $1', [userId])).rows[0].n

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-refdir-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    srv = await bootServer({ DATABASE_URL: db.appUrl(), STORAGE_ROOT: storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('a flood in one request is refused; 1 to 5 referees go in, recorded as the account\'s, with the server\'s created_at', async () => {
    const scorer = await account('flood', ['scorer'])
    const tag = hex()
    // the audit's flood: 50,000 short rows in one request (under the 5 MB body limit)
    const flood = await dbCall(scorer, 'insert', { data: Array.from({ length: 50000 }, (_, i) => ({ first_name: 'R', last_name: `F${i}`, sport_type: ['indoor'] })) })
    assert.equal(flood.status, 400, flood.text.slice(0, 300))
    assert.equal(flood.json.error.code, 'OV_REFEREE_DIRECTORY_ROWS')
    const six = await dbCall(scorer, 'insert', { data: Array.from({ length: 6 }, (_, i) => referee(`Six${tag}${i}`)) })
    assert.equal(six.status, 400, six.text)
    assert.equal(await countBy(scorer.id), 0)

    const five = await dbCall(scorer, 'insert', { data: Array.from({ length: 5 }, (_, i) => referee(`Five${tag}${i}`)) })
    assert.equal(five.status, 200, five.text)
    // the older apps' single object
    const one = await dbCall(scorer, 'insert', { data: referee(`One${tag}`) })
    assert.equal(one.status, 200, one.text)
    assert.equal(await countBy(scorer.id), 6)
    const row = (await sql.query('SELECT created_at FROM referee_database WHERE last_name = $1', [`One${tag}`])).rows[0]
    assert.ok(Date.now() - row.created_at.getTime() < 10 * 60 * 1000, 'not the 2001 the app sent')

    // a referee without a name is no referee
    const nameless = await dbCall(scorer, 'insert', { data: { first_name: ' ', last_name: 'X', sport_type: ['indoor'] } })
    assert.equal(nameless.status, 400, nameless.text)
    // nor is created_by the client's
    const forged = await dbCall(scorer, 'insert', { data: { ...referee(`Forged${tag}`), created_by: (await account('victim', ['scorer'])).id } })
    assert.equal(forged.status, 200, forged.text)
    assert.equal((await sql.query('SELECT created_by FROM referee_database WHERE last_name = $1', [`Forged${tag}`])).rows[0].created_by, scorer.id)
  })

  it('a referee already there is refused as a duplicate (any case and spacing, a sport in common); another sport is not one', async () => {
    const scorer = await account('dup', ['scorer'])
    const last = `Referee${hex()}`
    assert.equal((await dbCall(scorer, 'insert', { data: referee(last) })).status, 200)
    const again = await dbCall(scorer, 'insert', { data: referee(`  ${last.toUpperCase()} `, ' rita ') })
    assert.equal(again.status, 409, again.text)
    assert.equal(again.json.error.code, 'OV_REFEREE_DUPLICATE')
    // the older apps' save stays quiet on a message with "duplicate" (useOfficialHistory)
    assert.match(again.json.error.message, /duplicate/)
    const twice = await dbCall(scorer, 'insert', { data: [referee(`Twin${last}`), referee(`twin${last}`)] })
    assert.equal(twice.status, 409, twice.text)
    const beach = await dbCall(scorer, 'insert', { data: referee(last, 'Rita', 'beach') })
    assert.equal(beach.status, 200, beach.text)
    // adding a sport to the row stays open (refereeSportsKept)
    const { rows: [r] } = await sql.query('SELECT id FROM referee_database WHERE last_name = $1 AND sport_type::text LIKE \'%indoor%\'', [last])
    const add = await dbCall(scorer, 'update', { data: { sport_type: ['indoor', 'beach'] }, filters: [{ type: 'eq', column: 'id', value: r.id }] })
    assert.equal(add.status, 200, add.text)
  })

  it('at most 50 new referees per account and day; an admin is not capped', async () => {
    const scorer = await account('daily', ['scorer'])
    const tag = hex()
    for (let i = 0; i < 10; i++) {
      const r = await dbCall(scorer, 'insert', { data: Array.from({ length: 5 }, (_, j) => referee(`Day${tag}${i}x${j}`)) })
      assert.equal(r.status, 200, `${i}: ${r.text}`)
    }
    const over = await dbCall(scorer, 'insert', { data: referee(`Day${tag}over`) })
    assert.equal(over.status, 429, over.text)
    assert.equal(over.json.error.code, 'OV_REFEREE_DIRECTORY_DAILY_LIMIT')
    assert.equal(await countBy(scorer.id), 50)
    // the rows of yesterday do not count
    await sql.query("UPDATE referee_database SET created_at = now() - interval '25 hours' WHERE created_by = $1", [scorer.id])
    assert.equal((await dbCall(scorer, 'insert', { data: referee(`Day${tag}next`) })).status, 200)

    const admin = await account('boss', ['admin'])
    const many = await dbCall(admin, 'insert', { data: Array.from({ length: 60 }, (_, i) => referee(`Admin${tag}${i}`)) })
    assert.equal(many.status, 200, many.text.slice(0, 300))
    const dup = await dbCall(admin, 'insert', { data: referee(`Admin${tag}0`) })
    assert.equal(dup.status, 200, 'an admin decides about namesakes')
    assert.equal(await countBy(admin.id), 61)
  })

  it('who added a referee is for admins; the picker\'s prefix search with a limit works for a scorer', async () => {
    const scorer = await account('reader', ['scorer'])
    const admin = await account('boss2', ['admin'])
    const tag = `Zz${hex()}`
    assert.equal((await dbCall(scorer, 'insert', { data: Array.from({ length: 5 }, (_, i) => referee(`${tag}${i}`)) })).status, 200)
    const all = await dbCall(scorer, 'select', { columns: '*', filters: [{ type: 'ilike', column: 'last_name', value: `${tag}*` }] })
    assert.equal(all.status, 200, all.text)
    assert.equal(all.json.data.length, 5)
    for (const r of all.json.data) assert.equal('created_by' in r, false)
    const probe = await dbCall(scorer, 'select', { columns: 'id', filters: [{ type: 'eq', column: 'created_by', value: scorer.id }] })
    assert.equal(probe.status, 400, probe.text)
    assert.equal(probe.json.error.code, 'OV_SECRET_FILTER')
    const seen = await dbCall(admin, 'select', { columns: 'id, created_by', filters: [{ type: 'ilike', column: 'last_name', value: `${tag}*` }] })
    assert.equal(seen.status, 200, seen.text)
    assert.ok(seen.json.data.every((r) => r.created_by === scorer.id))

    // RefereeSelector's search: a prefix, the sport, by last name, a limit
    const search = await dbCall(scorer, 'select', {
      columns: 'id, first_name, last_name, country',
      filters: [{ type: 'contains', column: 'sport_type', value: '["indoor"]' }, { type: 'ilike', column: 'last_name', value: `${tag.toLowerCase()}*` }],
      order: [{ column: 'last_name', ascending: true }],
      limit: 3
    })
    assert.equal(search.status, 200, search.text)
    assert.deepEqual(search.json.data.map((r) => r.last_name), [`${tag}0`, `${tag}1`, `${tag}2`])
  })

  it('an account that goes leaves its referees in the directory, without its id', async () => {
    const scorer = await account('leaver', ['scorer'])
    const last = `Leaver${hex()}`
    assert.equal((await dbCall(scorer, 'insert', { data: referee(last) })).status, 200)
    await sql.query('DELETE FROM auth.users WHERE id = $1', [scorer.id])
    const { rows } = await sql.query('SELECT created_by FROM referee_database WHERE last_name = $1', [last])
    assert.deepEqual(rows, [{ created_by: null }])
  })
})
