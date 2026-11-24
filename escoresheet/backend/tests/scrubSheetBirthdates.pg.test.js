/**
 * scripts/scrub-sheet-birthdates.mjs (db/048's deploy step), against a test
 * database, a temporary storage root and a fake render service:
 *   - the dry run counts and lists, and changes nothing (no render either);
 *   - --apply replaces every recorded PDF of an indoor match in place with
 *     one vector PDF of its record ("Birthdates removed" sent as the
 *     rebuild's reason), same paths and owners, records and audit updated;
 *     takes the dates out of the JSON files; clears the leftovers of the
 *     deploy window; lists (never deletes) a beach PDF, a PDF without a
 *     record and one whose match is gone;
 *   - a second run does nothing again (the match counts as done).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createStorage, SENTINEL_NAME } from '../lib/storage.js'
import { countBirthdates } from '../lib/birthdates.js'
import { REASON, wire, scrubLeftovers, rebuildSheets, scrubJsonFiles, parseArgs } from '../scripts/scrub-sheet-birthdates.mjs'

const silent = { error () {}, warn () {}, log () {}, info () {} }
const sha = (b) => createHash('sha256').update(b).digest('hex')
const DAY = '2026-10-03'
// a match's result as its close writes it, and its last point at the set's score (one set 25:20)
const RESULT_COLUMNS = 'set_results, final_score, winner'
const RESULT_VALUES = `'[{"set":1,"home":25,"away":20}]', '1-0', 'home'`
const LAST_POINT_SQL = `INSERT INTO public.events (match_id, set_index, type, payload, seq) VALUES ($1, 1, 'point', '{"team":"home","score":{"home":25,"away":20}}', 45)`

describe('scrub-sheet-birthdates', { skip: SKIP_PG }, () => {
  let tdb, sql, base, storage, w
  const renders = []
  // the render service: a PDF that names the reason and the record's first player
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    renders.push(body)
    const pdf = Buffer.from(`%PDF-1.4 rebuilt ${body.rebuildReason} ${body.record.match.players_home?.[0]?.dob ?? 'none'}`)
    return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } })
  }
  const id = {}
  const paths = {}
  const env = { OV_RENDER_URL: 'http://render.invalid', OV_RENDER_TOKEN: 'test-render-token-'.padEnd(32, 'x'), OV_PIN_SECRET: 'test-pin-secret-'.padEnd(40, 'x') }
  const file = async (p) => (await storage.readTrusted({ bucket: 'scoresheets', path: p })).toString('latin1')

  async function storeFile (path, text, owner, { record = null, contentType = 'application/pdf' } = {}) {
    const data = Buffer.from(text)
    await storage.upload({ bucket: 'scoresheets', path, data, contentType, userId: owner })
    if (record !== null) {
      await sql.query('INSERT INTO public.match_scoresheets (path, match_id, stored_by, sha256, size) VALUES ($1, $2, $3, $4, $5)',
        [path, record, owner, sha(data), data.length])
    }
  }

  before(async () => {
    tdb = await createTestDatabase('scrubsheets')
    sql = new pg.Client({ connectionString: tdb.url })
    await sql.connect()
    // the step ran between db/048 and db/049: profiles.dob was still there (db/049's test: the step skips it after)
    await sql.query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS dob date')
    base = await mkdtemp(join(tmpdir(), 'ov-scrub-test-'))
    await writeFile(join(base, SENTINEL_NAME), '')
    storage = createStorage({ root: base, statfs: async () => ({ bavail: 1e9, bsize: 4096 }), uploaderReadBuckets: ['scoresheets'], logger: silent })
    w = wire({ connectionString: tdb.url, env, logger: silent, storage, fetchImpl })

    id.user = (await sql.query("INSERT INTO auth.users (email) VALUES ('scorer@example.test') RETURNING id")).rows[0].id
    await sql.query("INSERT INTO public.profiles (user_id, first_name, dob) VALUES ($1, 'Mia', '1990-01-01')", [id.user])
    await sql.query(`INSERT INTO public.game_rosters (game_number, season, side, team_name, players) VALUES ('480101', 2026, 'home', 'VBC Musterdorf',
      '[{"number":1,"last_name":"Muster","dob":"2008-03-14","license_number":"123456"}]')`)
    // an indoor match closed with two PDFs (the approval's and a rebuild), its record already without dates (db/048)
    const players = JSON.stringify([{ number: 1, first_name: 'Mia', last_name: 'Muster', dob: '123456' }, { number: 2, first_name: 'Lea', last_name: 'Probe', dob: null }])
    // (the record ends as its close says, lib/scoresheets.js recordGate: owner decision 3 for any vector
    // print that replaces the device's PDF)
    id.indoor = (await sql.query(`INSERT INTO public.matches (external_id, game_n, status, scheduled_at, players_home, created_by, ${RESULT_COLUMNS})
      VALUES ('scrub_indoor', 480101, 'live', '${DAY}T18:00:00Z', $1, $2, ${RESULT_VALUES}) RETURNING id`, [players, id.user])).rows[0].id
    await sql.query("INSERT INTO public.sets (match_id, index, home_points, away_points, finished) VALUES ($1, 1, 25, 20, true)", [id.indoor])
    await sql.query(LAST_POINT_SQL, [id.indoor])
    await sql.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [id.indoor])
    paths.a = `${DAY}/game480101_k${randomBytes(16).toString('hex')}.pdf`
    paths.b = `${DAY}/game480101_k${randomBytes(16).toString('hex')}.pdf`
    await storeFile(paths.a, '%PDF-1.4 old sheet 14.03.2008', id.user, { record: id.indoor })
    await storeFile(paths.b, '%PDF-1.4 old rebuild 14.03.2008', id.user, { record: id.indoor })
    // a beach match with a PDF: the render service prints the indoor sheet only
    id.beach = (await sql.query(`INSERT INTO public.matches (external_id, game_n, status, sport_type, scheduled_at, created_by)
      VALUES ('scrubbeach', 12, 'final', 'beach', '${DAY}T10:00:00Z', $1) RETURNING id`, [id.user])).rows[0].id
    paths.beach = `beach/${DAY}/game12_scrubbeach.pdf`
    await storeFile(paths.beach, '%PDF-1.4 beach sheet 1999-09-09', id.user, { record: id.beach })
    // its JSON sheet, with dates of birth; and an indoor JSON without any
    paths.beachJson = `beach/${DAY}/game12_scrubbeach.json`
    await storeFile(paths.beachJson, JSON.stringify({ team1Players: [{ number: 1, lastName: 'Sand', dob: '1999-09-09' }, { number: 2, lastName: 'Strand', dob: '55555' }] }), id.user, { contentType: 'application/json' })
    paths.indoorJson = `${DAY}/game480101_k${randomBytes(16).toString('hex')}.json`
    await storeFile(paths.indoorJson, JSON.stringify({ players: [{ dob: '123456' }] }), id.user, { contentType: 'application/json' })
    // a PDF without a record (stored before db/033, never recorded)
    paths.unrecorded = `${DAY}/game480199.pdf`
    await storeFile(paths.unrecorded, '%PDF-1.4 unrecorded', id.user)
    // a record whose match is gone
    paths.gone = `${DAY}/game480198_k${randomBytes(16).toString('hex')}.pdf`
    await storeFile(paths.gone, '%PDF-1.4 gone', id.user)
    await sql.query('INSERT INTO public.match_scoresheets (path, match_id, stored_by, sha256, size) VALUES ($1, NULL, $2, $3, 1)', [paths.gone, id.user, sha('gone')])
  })
  after(async () => {
    await w?.pool.end().catch(() => {})
    await sql?.end().catch(() => {})
    await tdb?.drop()
    if (base) await rm(base, { recursive: true, force: true })
  })

  const run = async (apply) => ({
    left: await scrubLeftovers(w.pool, { apply }),
    sheets: await rebuildSheets({ q: w.pool, storage: w.storage, scoresheets: w.scoresheets, vectorEnabled: w.vector.enabled, apply }),
    json: await scrubJsonFiles(w.storage, { apply })
  })
  const codes = (cannot) => Object.fromEntries(cannot.map((c) => [c.path, c.code]))

  it('the arguments', () => {
    assert.deepEqual(parseArgs([]), { apply: false, limit: Infinity })
    assert.deepEqual(parseArgs(['--apply', '--limit', '5']), { apply: true, limit: 5 })
    assert.match(parseArgs(['--limit', '0']).error, /--limit/)
    assert.match(parseArgs(['--dob']).error, /Unknown argument/)
  })

  it('a dry run counts and lists, and changes nothing', async () => {
    const r = await run(false)
    assert.equal(r.left['profiles.dob'], 1)
    assert.equal(r.left.game_rosters, 1)
    assert.equal(r.left.auth_users, 0)
    assert.deepEqual([r.sheets.matches, r.sheets.pdfs, r.sheets.done, r.sheets.rebuilt], [1, 2, 0, 0])
    assert.deepEqual(codes(r.sheets.cannot), { [paths.gone]: 'OV_MATCH_DELETED', [paths.unrecorded]: 'OV_NO_RECORD', [paths.beach]: 'OV_BEACH_SHEET' })
    assert.deepEqual([r.json.files, r.json.withBirthdates, r.json.rewritten], [2, 1, 0])
    assert.equal(renders.length, 0, 'the dry run draws nothing')
    assert.match(await file(paths.a), /old sheet 14\.03\.2008/)
    assert.equal((await sql.query('SELECT dob FROM public.profiles WHERE user_id = $1', [id.user])).rows[0].dob !== null, true)
  })

  it('--apply replaces the recorded PDFs in place, scrubs the JSON files and the leftovers, lists the rest', async () => {
    const before = (await sql.query('SELECT path, stored_at FROM public.match_scoresheets WHERE match_id = $1 ORDER BY path', [id.indoor])).rows
    const r = await run(true)
    assert.deepEqual([r.left['profiles.dob'], r.left.game_rosters], [1, 1])
    assert.deepEqual([r.sheets.matches, r.sheets.pdfs, r.sheets.rebuilt, r.sheets.replaced], [1, 2, 1, 2])
    assert.deepEqual(codes(r.sheets.cannot), { [paths.gone]: 'OV_MATCH_DELETED', [paths.unrecorded]: 'OV_NO_RECORD', [paths.beach]: 'OV_BEACH_SHEET' })
    // one render of the scrubbed record, with the reason
    assert.equal(renders.length, 1)
    assert.equal(renders[0].rebuildReason, REASON)
    assert.equal(renders[0].record.match.id, id.indoor)
    assert.equal(countBirthdates(renders[0].record.match.players_home), 0)
    // both files replaced in place, the records with them, the owners kept
    for (const p of [paths.a, paths.b]) {
      const text = await file(p)
      assert.equal(text, '%PDF-1.4 rebuilt Birthdates removed 123456')
      const { rows: [rec] } = await sql.query('SELECT sha256, size, stored_at FROM public.match_scoresheets WHERE path = $1', [p])
      assert.equal(rec.sha256, sha(Buffer.from(text)))
      assert.equal(rec.size, text.length)
      assert.ok(rec.stored_at > before.find((x) => x.path === p).stored_at)
      assert.deepEqual(await storage.getOwners({ bucket: 'scoresheets', path: p }), [id.user])
    }
    const { rows: audits } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'scoresheet.rebuild' AND match_id = $1", [id.indoor])
    assert.equal(audits.length, 1)
    assert.deepEqual([audits[0].details.reason, audits[0].details.mode, audits[0].details.replaced], [REASON, 'vector', 2])
    // the others are left as they were, never deleted
    assert.match(await file(paths.beach), /1999-09-09/)
    assert.match(await file(paths.unrecorded), /unrecorded/)
    assert.match(await file(paths.gone), /gone/)
    // the JSON sheet without its date, the licence kept
    assert.deepEqual([r.json.withBirthdates, r.json.rewritten, r.json.cannot], [1, 1, []])
    assert.deepEqual(JSON.parse(await file(paths.beachJson)).team1Players.map((p) => p.dob), [null, '55555'])
    assert.deepEqual(await storage.getOwners({ bucket: 'scoresheets', path: paths.beachJson }), [id.user])
    // the leftovers
    assert.equal((await sql.query('SELECT dob FROM public.profiles WHERE user_id = $1', [id.user])).rows[0].dob, null)
    assert.ok((await sql.query('SELECT players FROM public.game_rosters')).rows[0].players.every((p) => !('dob' in p)))
  })

  it('a second run does nothing again', async () => {
    const r = await run(true)
    assert.deepEqual([r.sheets.matches, r.sheets.done, r.sheets.rebuilt, r.json.withBirthdates], [0, 1, 0, 0])
    assert.equal(renders.length, 1, 'no new render')
    assert.equal(r.left['profiles.dob'], 0)
  })

  it('the render service down: nothing is replaced, every file of the match is listed', async () => {
    const id2 = (await sql.query(`INSERT INTO public.matches (external_id, game_n, status, scheduled_at, created_by, ${RESULT_COLUMNS})
      VALUES ('scrub_indoor2', 480102, 'live', '${DAY}T20:00:00Z', $1, ${RESULT_VALUES}) RETURNING id`, [id.user])).rows[0].id
    await sql.query("INSERT INTO public.sets (match_id, index, home_points, away_points, finished) VALUES ($1, 1, 25, 20, true)", [id2])
    await sql.query(LAST_POINT_SQL, [id2])
    await sql.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [id2])
    const p = `${DAY}/game480102_k${randomBytes(16).toString('hex')}.pdf`
    await storeFile(p, '%PDF-1.4 keep me', id.user, { record: id2 })
    const down = wire({ connectionString: tdb.url, env, logger: silent, storage, fetchImpl: async () => new Response('busy', { status: 503 }) })
    try {
      const r = await rebuildSheets({ q: down.pool, storage, scoresheets: down.scoresheets, vectorEnabled: true, apply: true })
      assert.equal(r.rebuilt, 0)
      assert.equal(codes(r.cannot)[p], 'OV_RENDER_FAILED')
      assert.equal(await file(p), '%PDF-1.4 keep me')
      // without the service configured: listed, not drawn
      const off = await rebuildSheets({ q: down.pool, storage, scoresheets: down.scoresheets, vectorEnabled: false, apply: true })
      assert.equal(codes(off.cannot)[p], 'OV_RENDER_UNAVAILABLE')
    } finally {
      await down.pool.end()
    }
  })
})
