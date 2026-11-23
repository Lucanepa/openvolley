// What the Global cloud copies write (GCS-R1, the review of the SEC-01 fix):
// the table's size was capped, but anonymous re-saves of a few copies could
// write 256 MiB a minute for everyone together (15 GiB an hour), and every
// byte becomes WAL that the archive keeps on the database volume, beside the
// official records, until the hourly backup takes it away. Now everyone
// writes at most a minute's, an hour's and a day's budget, counted as
// Postgres stores it; one network (IPv6 /48, IPv4 /24) a quarter of each,
// the last quarter kept for networks that wrote little; and with walGuard no
// cloud write while too much WAL waits for the backup or the archiving fails.
// Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, WAL_ROW_BYTES } from '../lib/globalMatches.js'

const silent = { error() {}, warn() {}, log() {} }
const KiB = 1024
const MiB = 1024 * KiB
const newKey = () => crypto.randomBytes(16).toString('base64url')
const summary = { home: { name: 'Bergtal IS' }, away: { name: 'Seeblick IS' }, status: 'live' }
// filler Postgres cannot compress (the reviewer's 3.5 MiB of random base64, smaller)
const randomBundleOf = (n) => ({ version: 1, match: { id: 1 }, events: [{ note: crypto.randomBytes(Math.ceil(n * 0.75)).toString('base64') }] })
// a match's events as the app exports them: it compresses as a real one does
const matchBundleOf = (points) => ({
  version: 1,
  match: { id: 1, status: 'live', hall: 'Sporthalle Bergtal', league: 'Plauschturnier' },
  events: Array.from({ length: points }, (_, i) => ({ id: i + 1, type: 'point', team: i % 3 ? 'home' : 'away', setIndex: 1 + Math.floor(i / 45), homePoints: i % 25, awayPoints: (i * 7) % 25, ts: `2026-11-23T10:${String(i % 60).padStart(2, '0')}:00.000Z`, recordedBy: 'scorer' }))
})
const MINUTE = 60_000

describe('Global cloud: what the copies write (GCS-R1)', { skip: SKIP_PG }, () => {
  let tdb, pool
  before(async () => {
    tdb = await createTestDatabase('gcs_writes')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
  })
  after(async () => { await pool?.end(); await tdb?.drop() })
  beforeEach(async () => {
    const owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
    try { await owner.query('DELETE FROM public.global_matches') } finally { await owner.end() }
  })

  it('a save is counted as Postgres stores it: a real match\'s JSON a fraction of its size, random filler all of it', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const real = matchBundleOf(900)
    const realBytes = Buffer.byteLength(JSON.stringify(real))
    assert.equal((await gm.save(newKey(), '4711', { bundle: real, summary }, { ip: '198.51.100.40' })).status, 200)
    const afterReal = gm.writes.used().minute.total
    assert.ok(afterReal < realBytes / 2, `a ${realBytes}-byte match counted ${afterReal}`)
    assert.equal((await gm.save(newKey(), '4711', { bundle: randomBundleOf(100 * KiB), summary }, { ip: '198.51.101.40' })).status, 200)
    const junk = gm.writes.used().minute.total - afterReal
    assert.ok(junk >= 100 * KiB + WAL_ROW_BYTES, `random filler counted in full: ${junk}`)
  })

  it('sustained re-saves of three copies from three networks stop at each one\'s share; the hour stays within its budget; a hall that writes little still saves', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    // scaled down 16-fold from the defaults (16 MiB a minute, 256 MiB an hour)
    const perMinute = 1 * MiB
    const perHour = 16 * MiB
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t), writtenPerMinute: perMinute, writtenPerHour: perHour, writtenPerDay: 32 * MiB })
    const attackers = [0, 1, 2].map((i) => ({ key: newKey(), ip: { ip: `203.0.${113 + i}.9` }, written: 0, saves: 0 }))
    const hall = { key: newKey(), ip: { ip: '198.51.100.41' } }
    const junk = randomBundleOf(100 * KiB) // re-sent every time: incompressible
    const junkCost = Buffer.byteLength(JSON.stringify(junk)) + WAL_ROW_BYTES
    const refusals = {}
    let hallSaved = 0
    for (let minute = 0; minute < 60; minute++) {
      for (const a of attackers) {
        for (let n = 0; n < 6; n++) {
          const r = await gm.save(a.key, '1111', { bundle: junk, summary }, a.ip)
          if (r.status !== 200) { refusals[r.status] = (refusals[r.status] || 0) + 1; break }
          a.saves++
          a.written += junkCost
        }
      }
      // the genuine match on the same server: once a minute, a few KB (in
      // proportion, what a match writes in a real hour: about 1% of it)
      if ((await gm.save(hall.key, '4711', { bundle: matchBundleOf(30), summary }, hall.ip)).status === 200) hallSaved++
      t += MINUTE
    }
    assert.equal(hallSaved, 60, 'the hall saved every minute')
    for (const a of attackers) {
      // a quarter of the hour, give or take the save that passed it
      assert.ok(a.written <= perHour / 4 + junkCost, `one network wrote ${a.written} in the hour`)
    }
    const total = attackers.reduce((n, a) => n + a.written, 0)
    assert.ok(total <= perHour, `the three wrote ${total} in the hour (budget ${perHour})`)
    assert.ok(refusals[429] > 0, JSON.stringify(refusals))
  })

  it('the last quarter of a window is for networks that wrote little: heavy ones are refused there, a new one is not', async () => {
    let t = Date.parse('2026-11-23T11:00:00Z')
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t), writtenPerMinute: 400 * KiB, writtenNetShare: 0.5 })
    const heavy = [{ ip: '203.0.113.20' }, { ip: '203.0.114.20' }]
    const keys = heavy.map(() => newKey())
    // each heavy network writes its 120 KiB saves until it is refused
    const got = []
    for (let i = 0; i < 6; i++) got.push((await gm.save(keys[i % 2], '1111', { bundle: randomBundleOf(120 * KiB), summary }, heavy[i % 2])).status)
    // 3 saves (about 366 KiB) take the minute past its first three quarters (300 KiB)
    assert.deepEqual(got.slice(0, 3), [200, 200, 200])
    assert.ok(got.slice(3).every((s) => s === 429), JSON.stringify(got))
    // a hall that has not written this minute is still let in
    assert.equal((await gm.save(newKey(), '4711', { bundle: matchBundleOf(50), summary }, { ip: '198.51.100.42' })).status, 200)
    t += MINUTE
    assert.equal((await gm.save(keys[0], '1111', { bundle: randomBundleOf(120 * KiB), summary }, heavy[0])).status, 200, 'a new minute')
  })

  it('walGuard: no cloud write while more WAL than walMaxBytes waits for the next backup run, or while the archiving fails', async () => {
    let t = Date.parse('2026-11-23T12:00:00Z')
    let lsn = 5_000_000_000
    let failing = false
    let backupAt = t - 10 * MINUTE
    const alerts = []
    const gm = createGlobalMatches({
      pool, logger: silent, now: () => new Date(t), onAlert: (m) => alerts.push(m),
      walMaxBytes: 100 * MiB,
      walGuard: { lastBackupAt: async () => backupAt, probe: async () => ({ lsn, failing }) }
    })
    const key = newKey()
    const save = () => gm.save(key, '4711', { bundle: matchBundleOf(20), summary }, { ip: '198.51.100.43' })
    assert.equal((await save()).status, 200)
    lsn += 150 * MiB // official matches, imports, anything: 150 MiB of WAL since the run
    t += MINUTE + 1
    const r = await save()
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'OV_BUSY')
    assert.equal(r.retryAfter, 300)
    assert.ok(alerts.some((m) => /wait for the next backup run/.test(m)), alerts.join('\n'))
    // the hourly run takes the archive away
    backupAt = t + 5_000
    lsn += 2 * MiB
    t += MINUTE + 1
    assert.equal((await save()).status, 200)
    // archive_command fails (the volume is full, the directory is gone)
    failing = true
    t += MINUTE + 1
    assert.equal((await save()).status, 503)
    failing = false
    t += MINUTE + 1
    assert.equal((await save()).status, 200)
    // no backup stamp (a server without the host's backups): the WAL is not held against it
    backupAt = null
    lsn += 500 * MiB
    t += MINUTE + 1
    assert.equal((await save()).status, 200)
  })

  it('walGuard with the real probe: the app role reads the WAL position and pg_stat_archiver', async () => {
    const warnings = []
    const gm = createGlobalMatches({ pool, logger: { ...silent, warn: (...a) => warnings.push(a.join(' ')) }, walGuard: { lastBackupAt: async () => Date.now() - 30 * MINUTE } })
    assert.equal((await gm.save(newKey(), '4711', { bundle: matchBundleOf(20), summary }, { ip: '198.51.100.44' })).status, 200)
    const w = await gm.wal()
    assert.equal(w.failing, false)
    assert.ok(Number.isFinite(w.pending) && w.pending >= 0, JSON.stringify(w))
    assert.deepEqual(warnings, [])
  })
})
