/**
 * The end of the match records (db/042, lib/retention.js): a match is kept for
 * its season and app_settings.retention_years seasons after it, then the
 * daily sweep removes it (also a closed one, with its rows), the scoresheet
 * files of those days and VolleyManager's rows of those games. Runs as the
 * backend role. Newer records stay.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createTestDatabase, SKIP_PG } from './helpers/pgTestDb.js'
import { createStorage, SENTINEL_NAME } from '../lib/storage.js'
import { SEASON_SQL } from '../lib/officialGame.js'
import { createRetention, expiredSeason, cutoffDay, DEFAULT_RETENTION_YEARS } from '../lib/retention.js'

const silent = { error() {}, warn() {}, log() {} }
const plenty = async () => ({ bavail: 1e9, bsize: 4096 })
// 14 November 2026: season 2026 (2026/27) runs; with 2 years 2023 is the last expired one
const NOW = new Date('2026-11-14T10:00:00Z')

describe('retention: the seasons', () => {
  it('a season is kept for N seasons after it and removed from 1 July of the next', () => {
    assert.equal(DEFAULT_RETENTION_YEARS, 2)
    assert.equal(expiredSeason(NOW, 2), 2023)
    assert.equal(cutoffDay(NOW, 2), '2024-07-01')
    // 30 June 2027 (Zurich) is still season 2026: 2024 kept; 1 July 2027 removes it
    assert.equal(expiredSeason(new Date('2027-06-30T12:00:00Z'), 2), 2023)
    assert.equal(expiredSeason(new Date('2027-07-01T12:00:00Z'), 2), 2024)
    assert.equal(expiredSeason(NOW, 0), null)
    assert.equal(cutoffDay(NOW, 5), '2021-07-01')
  })
})

describe('retention: the sweep', { skip: SKIP_PG }, () => {
  let tdb, owner, pool, base, storage, audits, retention

  const insertMatch = async (externalId, scheduledAt, extra = {}) => {
    const { rows: [m] } = await owner.query(
      `INSERT INTO public.matches (external_id, game_n, status, test, scheduled_at, players_home)
       VALUES ($1, $2, 'live', false, $3, $4::json) RETURNING id`,
      [externalId, extra.gameN ?? null, scheduledAt, JSON.stringify([{ number: 4, firstName: 'Mia', lastName: 'Example', dob: '2011-03-02' }])])
    // official_season is the server's (db/034: the kick-off in VolleyManager,
    // else the clock at creation): a match made in that season
    await owner.query("SET session_replication_role = replica")
    await owner.query(`UPDATE public.matches SET official_season = ${SEASON_SQL('scheduled_at')} WHERE id = $1`, [m.id])
    await owner.query("SET session_replication_role = DEFAULT")
    await owner.query('INSERT INTO public.sets (match_id, index) VALUES ($1, 1)', [m.id])
    await owner.query("INSERT INTO public.events (match_id, set_index, type, payload) VALUES ($1, 1, 'point', '{}'::json)", [m.id])
    await owner.query(
      `INSERT INTO public.activity_log (uid, client_ts, match_external_id, kind) VALUES (gen_random_uuid(), now(), $1, 'match.point')`, [externalId])
    if (extra.closed) await owner.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [m.id])
    return m.id
  }

  const writeSheet = async (rel) => {
    const full = path.join(base, 'storage', 'scoresheets', rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, 'pdf')
  }
  const exists = (rel) => fs.lstat(path.join(base, 'storage', 'scoresheets', rel)).then(() => true, () => false)
  const count = async (sql, args = []) => (await owner.query(sql, args)).rows[0].n

  before(async () => {
    tdb = await createTestDatabase('retention')
    owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
    pool = new pg.Pool({ connectionString: await tdb.createAppRole(), max: 2 })
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-retention-test-'))
    await fs.mkdir(path.join(base, 'storage'))
    await fs.writeFile(path.join(base, 'storage', SENTINEL_NAME), '')
    storage = createStorage({ root: path.join(base, 'storage'), statfs: plenty, logger: silent })
    audits = []
    retention = createRetention({ pool, storage, audit: async (_c, entry) => { audits.push(entry) }, log: silent })
  })

  after(async () => {
    await pool?.end().catch(() => {})
    await owner?.end().catch(() => {})
    if (base) await fs.rm(base, { recursive: true, force: true })
    await tdb?.drop()
  })

  it('db/042: the setting defaults to 2 years and refuses 0', async () => {
    assert.deepEqual(await retention.settings(), { years: 2 })
    await assert.rejects(owner.query('UPDATE public.app_settings SET retention_years = 0 WHERE id'), (e) => e.code === '23514')
  })

  it('removes expired matches (a closed one too, with its rows), their scoresheet files and svrz_games; keeps newer ones', async () => {
    const oldClosed = await insertMatch('m-old-closed', '2024-03-09T17:00:00Z', { gameN: 4101, closed: true })
    const oldOpen = await insertMatch('m-old-open', '2023-10-01T17:00:00Z')
    // season 2024 (2024/25): kept until 1 July 2027
    const kept = await insertMatch('m-kept', '2024-09-14T17:00:00Z', { gameN: 4102 })
    const { rows: [c] } = await owner.query('SELECT closed_at FROM public.matches WHERE id = $1', [oldClosed])
    assert.ok(c.closed_at, 'the old match is closed')
    await owner.query(
      `INSERT INTO public.match_scoresheets (path, match_id, sha256, size) VALUES
         ('2024-03-09/game4101.pdf', $1, repeat('a', 64), 3), ('2024-09-14/game4102.pdf', $2, repeat('b', 64), 3)`, [oldClosed, kept])
    await writeSheet('2024-03-09/game4101.pdf')
    await writeSheet('2024-03-09/game4101.json')
    await writeSheet('beach/2023-08-20/game7_abc.pdf')
    await writeSheet('2024-09-14/game4102.pdf')
    await owner.query(
      `INSERT INTO public.svrz_games (game_number, datetime, referee_1_first_name, referee_1_dob) VALUES
         ('4101', '2024-03-09T18:00:00+01:00', 'Rita', '1980-01-01'), ('4102', '2024-09-14T18:00:00+02:00', 'Rita', '1980-01-01')`)

    const dry = await retention.sweep({ now: NOW, dryRun: true })
    assert.equal(dry.matches, 2)
    assert.equal(dry.scoresheetFolders, 2)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.matches'), 3, 'a dry run removes nothing')

    const r = await retention.sweep({ now: NOW })
    assert.equal(r.cutoffDay, '2024-07-01')
    assert.equal(r.matches, 2)
    assert.equal(r.scoresheetFolders, 2)
    assert.equal(r.scoresheetFiles, 3)
    assert.equal(r.scoresheetRecords, 1)
    assert.equal(r.svrzGames, 1)

    const left = (await owner.query('SELECT external_id FROM public.matches ORDER BY 1')).rows.map((x) => x.external_id)
    assert.deepEqual(left, ['m-kept'])
    for (const id of [oldClosed, oldOpen]) {
      assert.equal(await count('SELECT count(*)::int AS n FROM public.sets WHERE match_id = $1', [id]), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM public.events WHERE match_id = $1', [id]), 0)
    }
    assert.equal(await count("SELECT count(*)::int AS n FROM public.activity_log WHERE match_external_id LIKE 'm-old%'"), 0)
    assert.equal(await count("SELECT count(*)::int AS n FROM public.activity_log WHERE match_external_id = 'm-kept'"), 1)
    // an app that still holds the match is told it was deleted (db/043)
    assert.equal(await count("SELECT count(*)::int AS n FROM public.deleted_matches WHERE external_id IN ('m-old-closed', 'm-old-open')"), 2)
    assert.equal(await exists('2024-03-09/game4101.pdf'), false)
    assert.equal(await exists('beach/2023-08-20/game7_abc.pdf'), false)
    assert.equal(await exists('2024-09-14/game4102.pdf'), true)
    assert.deepEqual((await owner.query('SELECT path FROM public.match_scoresheets')).rows.map((x) => x.path), ['2024-09-14/game4102.pdf'])
    assert.deepEqual((await owner.query('SELECT game_number FROM public.svrz_games')).rows.map((x) => x.game_number), ['4102'])
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'retention.sweep')
    assert.equal(audits[0].details.matches, 2)
    assert.equal(JSON.stringify(audits[0]).includes('Example'), false, 'no name in the audit entry')

    // a second run finds nothing and writes no audit entry
    const again = await retention.sweep({ now: NOW })
    assert.equal(again.matches + again.scoresheetFiles + again.svrzGames, 0)
    assert.equal(audits.length, 1)
  })

  it('follows the setting: more years keep more', async () => {
    await insertMatch('m-2022', '2022-11-05T17:00:00Z')
    await owner.query('UPDATE public.app_settings SET retention_years = 5 WHERE id')
    assert.equal((await retention.sweep({ now: NOW })).matches, 0)
    await owner.query('UPDATE public.app_settings SET retention_years = 2 WHERE id')
    assert.equal((await retention.sweep({ now: NOW })).matches, 1)
  })
})
