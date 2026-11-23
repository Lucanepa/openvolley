// The 'scoresheets' bucket's limits per account (audit 2026-11-23 SEC-16):
// one approved scorer wrote 400 MiB a minute (200 plain + 200 exempt final
// JSON) into a day folder like 2099-12-31/, which the retention never swept,
// and had no total of its own. Now: a total per account counted from the
// owner records, a much smaller budget for final JSONs, no day folder more
// than a week ahead (server.js), and the retention sweeps far-future folders.
// The retention part needs PG_TEST_URL (tests/helpers/pgTestDb.js).
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import {
  createStorage, createWriteQuota, storageOptionsFromEnv, scoresheetDayTooFar, scoresheetDayOf, isFarFutureDay,
  DEFAULTS, DEFAULT_EXEMPT_MAX_BYTES, SCORESHEET_MAX_FUTURE_DAYS, SENTINEL_NAME, StorageError
} from '../lib/storage.js'
import { createRetention, FUTURE_FOLDER_DAYS } from '../lib/retention.js'
import { createTestDatabase, SKIP_PG } from './helpers/pgTestDb.js'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const silent = { error() {}, warn() {}, log() {} }
const plenty = async () => ({ bavail: 100 * GiB / 4096, bsize: 4096 })
const U1 = '11111111-2222-4333-8444-555555555555'
const U2 = '66666666-2222-4333-8444-555555555555'
const b64 = (n) => crypto.randomBytes(n).toString('base64')
const path_ = (day, i, final = false) => `${day}/game${i}_k${'a'.repeat(32)}${final ? '_final' : ''}.json`

let base, root
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-sheets-quota-'))
  root = path.join(base, 'storage')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, SENTINEL_NAME), '')
})
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }) })
const make = (opts = {}) => createStorage({ root, statfs: plenty, logger: silent, uploaderReadBuckets: ['scoresheets'], ownerScope: 'prefix', ownerScopeBuckets: ['backup'], ...opts })
const up = (s, userId, p, n, extra = {}) => s.upload({ bucket: 'scoresheets', path: p, fileBase64: b64(n), contentType: 'application/json', userId, ...extra })
const refused = (promise, status, code) => assert.rejects(promise, (e) => e instanceof StorageError && e.status === status && e.code === code)

describe('scoresheets: a total per account (SEC-16)', () => {
  it('default 4 GiB; STORAGE_SCORESHEETS_ACCOUNT_MAX_MB sets it (0: off), beside the backup total', () => {
    assert.equal(DEFAULTS.maxOwnerBytes.scoresheets, 4 * GiB)
    assert.equal(DEFAULTS.maxOwnerBytes.backup, 6 * GiB)
    assert.deepEqual(storageOptionsFromEnv({ STORAGE_SCORESHEETS_ACCOUNT_MAX_MB: '1024' }).maxOwnerBytes, { scoresheets: GiB })
    assert.deepEqual(storageOptionsFromEnv({ STORAGE_SCORESHEETS_ACCOUNT_MAX_MB: '0', STORAGE_BACKUP_ACCOUNT_MAX_MB: '10' }).maxOwnerBytes, { backup: 10 * MiB, scoresheets: 0 })
    assert.throws(() => storageOptionsFromEnv({ STORAGE_SCORESHEETS_ACCOUNT_MAX_MB: 'x' }), /STORAGE_SCORESHEETS_ACCOUNT_MAX_MB/)
  })

  it('an account holds at most its total, counted from the owner records (also those of an earlier process); others are not affected', async () => {
    const first = make({ maxOwnerBytes: { scoresheets: 3000 } })
    await up(first, U1, path_('2026-11-20', 1), 1000)
    // a restart: the new process counts what the records say
    const s = make({ maxOwnerBytes: { scoresheets: 3000 } })
    await up(s, U1, path_('2026-11-20', 2), 1500)
    await refused(up(s, U1, path_('2026-11-20', 3), 600), 507, 'OV_STORAGE_ACCOUNT_FULL')
    assert.equal(await fs.access(path.join(root, 'scoresheets', path_('2026-11-20', 3))).then(() => true, () => false), false, 'nothing written')
    // another account has its own total
    await up(s, U2, path_('2026-11-20', 4), 2900)
    // replacing an object counts the difference only
    await up(s, U1, path_('2026-11-20', 2), 1900)
    await refused(up(s, U1, path_('2026-11-20', 2), 2100), 507, 'OV_STORAGE_ACCOUNT_FULL')
    // removing frees it
    await s.remove({ bucket: 'scoresheets', paths: [path_('2026-11-20', 1)], userId: U1 })
    await up(s, U1, path_('2026-11-20', 3), 900)
    // the HTTP answer
    const r = await s.handle('upload', { bucket: 'scoresheets', path: path_('2026-11-20', 5), fileBase64: b64(500), contentType: 'application/json' }, { userId: U1 })
    assert.equal(r.status, 507)
    assert.equal(r.body.error.code, 'OV_STORAGE_ACCOUNT_FULL')
  })

  it('an adopted object (lib/scoresheets.js: another writer of the match) moves to the adopter\'s total', async () => {
    const s = make({ maxOwnerBytes: { scoresheets: 2000 } })
    const p = path_('2026-11-20', 7)
    await up(s, U1, p, 1500)
    await up(s, U2, p, 1500, { adopt: (owners) => owners })
    await up(s, U1, path_('2026-11-20', 8), 1900) // U1 got the 1500 back
    await refused(up(s, U2, path_('2026-11-20', 9), 600), 507, 'OV_STORAGE_ACCOUNT_FULL')
  })

  it('0 turns it off; the operator is alerted near the total', async () => {
    const off = make({ maxOwnerBytes: { scoresheets: 0 } })
    await up(off, U1, path_('2026-11-20', 1), 5000)
    const errors = []
    const s = make({ maxOwnerBytes: { scoresheets: 1000 }, logger: { ...silent, error: (...a) => errors.push(a.join(' ')) } })
    await up(s, U2, path_('2026-11-20', 2), 900)
    assert.equal(errors.filter((e) => /ALERT account .* of scoresheets\//.test(e)).length, 1)
    assert.equal((await s.health()).alerts.accountsNearQuota, 1)
  })

  it('the audit\'s PoC: 40 plain and 40 final 5 MiB files a minute; the finals now stop at 32 MiB', async () => {
    assert.equal(DEFAULT_EXEMPT_MAX_BYTES, 32 * MiB)
    const q = createWriteQuota({ now: () => 0 })
    const ok = (final, i) => q({ userId: U1, bucket: 'scoresheets', path: `2026-11-20/game${i}${final ? '_final' : ''}.json`, size: 5 * MiB }) === true
    let plain = 0; let finals = 0
    for (let i = 0; i < 40; i++) { if (ok(false, i)) plain++; if (ok(true, i)) finals++ }
    assert.equal(plain, 40, 'the ordinary budget: 200 MiB')
    assert.equal(finals, 6, 'the finals: 32 MiB (was 200 MiB)')
    // a smaller ordinary budget keeps the finals at most as large
    const small = createWriteQuota({ maxBytes: 10, now: () => 0 })
    assert.equal(small({ userId: 'u', bucket: 'scoresheets', path: '2026-10-05/game1_final.json', size: 10 }), true)
    assert.equal(small({ userId: 'u', bucket: 'scoresheets', path: '2026-10-05/game2_final.json', size: 1 }).ok, false)
  })
})

describe('scoresheets: day folders far in the future (SEC-16)', () => {
  const NOW = Date.parse('2026-11-23T12:00:00Z')
  it('a day more than a week ahead, or no real date, is too far; today, the past and the next days are not', () => {
    assert.equal(SCORESHEET_MAX_FUTURE_DAYS, 7)
    assert.equal(scoresheetDayOf('2099-12-31/game1_final.json'), '2099-12-31')
    assert.equal(scoresheetDayOf('beach/2026-11-23/game3_ab.json'), '2026-11-23')
    assert.equal(scoresheetDayOf('d/game1.json'), null)
    for (const p of ['2099-12-31/game1.json', 'beach/2099-12-31/game1.pdf', '2026-12-01/game1.json', '2026-13-01/game1.json', '2026-02-30/game1.json']) {
      assert.equal(scoresheetDayTooFar(p, { now: NOW }), true, p)
    }
    for (const p of ['2026-11-23/game1.json', '2024-09-14/game1.pdf', '2026-11-30/game1.json', 'beach/2026-11-24/game2_x.json', 'd/game1.json']) {
      assert.equal(scoresheetDayTooFar(p, { now: NOW }), false, p)
    }
    assert.equal(isFarFutureDay('2027-11-23', { now: NOW, maxDays: FUTURE_FOLDER_DAYS }), false, 'a year typo stays for the retention')
    assert.equal(isFarFutureDay('2099-12-31', { now: NOW, maxDays: FUTURE_FOLDER_DAYS }), true)
  })
})

describe('retention sweeps far-future day folders (SEC-16)', { skip: SKIP_PG }, () => {
  let tdb, owner, pool
  const NOW = new Date('2026-11-23T12:00:00Z')
  before(async () => {
    tdb = await createTestDatabase('sheetsfuture')
    owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
  })
  after(async () => { await owner?.end(); await pool?.end(); await tdb?.drop() })

  it('2099-12-31/ goes (files and records); a near-future day, a year typo and a folder with a match\'s PDF stay', async () => {
    const storage = make()
    const put = (p) => storage.upload({ bucket: 'scoresheets', path: p, fileBase64: b64(100), contentType: p.endsWith('.pdf') ? 'application/pdf' : 'application/json', userId: U1 })
    await put('2099-12-31/gamejunk1.json')
    await put('2099-12-31/gamejunk2_final.json')
    await put('beach/2099-12-31/game9_x.json')
    await put('2026-11-25/game1.json')
    await put('2027-11-23/game2.json')
    await put('2088-01-01/game77.pdf')
    const { rows: [m] } = await owner.query("INSERT INTO public.matches (external_id, status, test) VALUES ('m-typo', 'live', false) RETURNING id")
    await owner.query("INSERT INTO public.match_scoresheets (path, match_id, size, sha256) VALUES ('2088-01-01/game77.pdf', $1, 100, repeat('a', 64))", [m.id])
    await owner.query("INSERT INTO public.match_scoresheets (path, match_id, size, sha256) VALUES ('2099-12-31/gamejunk3.pdf', NULL, 100, repeat('b', 64))")
    const retention = createRetention({ pool, storage, log: silent })
    const dry = await retention.sweep({ now: NOW, dryRun: true })
    assert.equal(dry.scoresheetFutureFolders, 2)
    const r = await retention.sweep({ now: NOW })
    assert.equal(r.scoresheetFutureFolders, 2)
    const left = async (dir) => fs.readdir(path.join(root, 'scoresheets', dir)).catch(() => null)
    assert.equal(await left('2099-12-31'), null)
    assert.equal(await left('beach/2099-12-31'), null)
    assert.deepEqual(await left('2026-11-25'), ['game1.json'])
    assert.deepEqual(await left('2027-11-23'), ['game2.json'])
    assert.deepEqual(await left('2088-01-01'), ['game77.pdf'])
    const { rows } = await owner.query('SELECT path FROM public.match_scoresheets ORDER BY path')
    assert.deepEqual(rows.map((x) => x.path), ['2088-01-01/game77.pdf'])
  })
})
