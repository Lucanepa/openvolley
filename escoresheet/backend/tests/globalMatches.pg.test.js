// lib/globalMatches.js on Postgres (db/046). Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, keyHash } from '../lib/globalMatches.js'
import { minimalPdf } from './helpers/pdfFixture.js'

const KEY = 'K'.repeat(22)
// a complete PDF (PERM-15: a %PDF prefix alone is refused since 2026-11-23)
const PDF = minimalPdf().toString('base64')
const summary = { home: { name: 'Bergtal IS' }, away: { name: 'Seeblick IS' }, setsWon: { home: 3, away: 1 }, status: 'final' }

describe('Global cloud on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, gm
  before(async () => {
    tdb = await createTestDatabase('globalmatches')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
    gm = createGlobalMatches({ pool })
  })
  after(async () => { await pool?.end(); await tdb?.drop() })

  it('save, load with the PIN, wrong PIN refused, only hashes stored', async () => {
    const s = await gm.save(KEY, '1234', { bundle: { match: { id: 1 }, events: [] }, summary, organizer: 'ABCDEFGHJK', pdf: PDF })
    assert.equal(s.status, 200)
    assert.equal(s.body.data.ok, true)
    assert.equal(s.body.data.shareToken, null)
    const l = await gm.load(KEY, '1234')
    assert.equal(l.status, 200)
    assert.deepEqual(l.body.data.bundle, { match: { id: 1 }, events: [] })
    assert.equal(l.body.data.summary.home.name, 'Bergtal IS')
    assert.equal(l.body.data.organizer, true)
    assert.equal((await gm.load(KEY, '9999')).status, 403)
    assert.equal((await gm.load('Q'.repeat(22), '1234')).status, 404)
    assert.equal((await gm.save(KEY, '9999', { bundle: {}, summary })).status, 403, 'another PIN cannot overwrite')
    const { rows } = await pool.query('SELECT key_hash, pin_hash FROM public.global_matches')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key_hash, keyHash(KEY))
    assert.equal(JSON.stringify(rows).includes(KEY), false)
    assert.equal(JSON.stringify(rows).includes('1234'), false)
  })

  it('a save without pdf keeps the stored PDF; null removes it', async () => {
    await gm.save(KEY, '1234', { bundle: { v: 2 }, summary, organizer: 'ABCDEFGHJK' })
    const org = await gm.organizerList('ABCDEFGHJK')
    assert.equal(org.body.data.matches[0].hasPdf, true)
    assert.ok(await gm.organizerPdf('ABCDEFGHJK', org.body.data.matches[0].id))
    await gm.save(KEY, '1234', { bundle: { v: 3 }, summary, organizer: 'ABCDEFGHJK', pdf: null })
    assert.equal((await gm.organizerList('ABCDEFGHJK')).body.data.matches[0].hasPdf, false)
    await gm.save(KEY, '1234', { bundle: { v: 4 }, summary, organizer: 'ABCDEFGHJK', pdf: PDF })
  })

  it('share link on and off; organizer list by code only', async () => {
    const on = await gm.setShare(KEY, '1234', true)
    const token = on.body.data.shareToken
    assert.match(token, /^[A-Za-z0-9_-]{22}$/)
    const sh = await gm.shared(token)
    assert.equal(sh.status, 200)
    assert.equal(sh.body.data.hasPdf, true)
    assert.equal('bundle' in sh.body.data, false)
    assert.equal((await gm.sharedPdf(token)).subarray(0, 4).toString(), '%PDF')
    assert.equal((await gm.setShare(KEY, '0000', false)).status, 403)
    await gm.setShare(KEY, '1234', false)
    assert.equal((await gm.shared(token)).status, 404)
    assert.equal(await gm.sharedPdf(token), null)
    assert.deepEqual((await gm.organizerList('BBBBBBBBBB')).body.data.matches, [])
    const list = (await gm.organizerList('ABCDEFGHJK')).body.data.matches
    assert.equal(list.length, 1)
    assert.equal('bundle' in list[0], false)
  })

  it('expired rows are gone from every read, swept, and a new save starts over', async () => {
    await pool.query("UPDATE public.global_matches SET expires_at = now() - interval '1 second'")
    assert.equal((await gm.load(KEY, '1234')).status, 404)
    assert.equal(await gm.sweepExpired(), 1)
    const s = await gm.save(KEY, '5678', { bundle: { fresh: true }, summary })
    assert.equal(s.status, 200, 'a new match under the old key with a new PIN')
    const { rows } = await pool.query("SELECT expires_at > now() + interval '179 days' AS fresh FROM public.global_matches")
    assert.equal(rows[0].fresh, true)
  })

  it('delete needs the PIN, then the row is gone', async () => {
    assert.equal((await gm.del(KEY, '1234')).status, 403)
    assert.equal((await gm.del(KEY, '5678')).status, 200)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.global_matches')).rows[0].n, 0)
  })
})

describe('Global cloud on Postgres: organizer code follows the latest save', { skip: SKIP_PG }, () => {
  let tdb, pool, gm
  before(async () => {
    tdb = await createTestDatabase('globalmatchesorg')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
    gm = createGlobalMatches({ pool })
  })
  after(async () => { await pool?.end(); await tdb?.drop() })
  it('a save with organizer null takes the match off that list', async () => {
    await gm.save(KEY, '1234', { bundle: {}, summary, organizer: 'ABCDEFGHJK' })
    assert.equal((await gm.organizerList('ABCDEFGHJK')).body.data.matches.length, 1)
    await gm.save(KEY, '1234', { bundle: {}, summary, organizer: null })
    assert.equal((await gm.organizerList('ABCDEFGHJK')).body.data.matches.length, 0)
  })
})
