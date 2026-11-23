/**
 * Audit 2611 PERM-10: POST /api/match/restore wrote matches.released_at and
 * created_at, which /api/db strips (server.js WRITE_DENYLIST). A scorer could
 * un-release a match an admin had released as a duplicate (it then counted as
 * official again for the final mail and the Scoresheets list), and pick the
 * season of its official-game key through created_at. Both paths now drop one
 * list, lib/matchRestore.js MATCH_SERVER_ONLY_COLUMNS.
 * The database half needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore, MATCH_SERVER_ONLY_COLUMNS, RESTORE_DEFAULTS } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('the server-only match columns (one list for /api/db and restore)', () => {
  it('names every column only the server writes', () => {
    for (const c of ['created_by', 'closed_at', 'closed_by', 'first_closed_at', 'official_game_exempt', 'released_at', 'created_at', 'tournament_match_id']) {
      assert.ok(MATCH_SERVER_ONLY_COLUMNS.includes(c), c)
    }
    assert.ok(Object.isFrozen(MATCH_SERVER_ONLY_COLUMNS))
  })

  it('a restore drops exactly that list', () => {
    assert.deepEqual([...RESTORE_DEFAULTS.serverOnlyColumns].sort(), [...MATCH_SERVER_ONLY_COLUMNS].sort())
  })

  it("/api/db's WRITE_DENYLIST of matches is that list (server.js is not importable: its source)", () => {
    const src = readFileSync(join(here, '..', 'server.js'), 'utf8')
    const block = src.slice(src.indexOf('const WRITE_DENYLIST = {'), src.indexOf('\n}\n', src.indexOf('const WRITE_DENYLIST = {')))
    assert.match(block, /\n\s*matches:\s*MATCH_SERVER_ONLY_COLUMNS,/)
    assert.match(src, /import \{[^}]*\bMATCH_SERVER_ONLY_COLUMNS\b[^}]*\} from '\.\/lib\/matchRestore\.js'/)
  })
})

describe('restoreMatch keeps the server-only columns', { skip: SKIP_PG }, () => {
  let tdb, db, restore, raw
  let seq = 0
  const W = { proto: '2' }
  const uniq = () => `deny_${process.pid}_${Date.now().toString(36)}_${seq++}`
  const backup = (ext, extra = {}) => ({
    match: { external_id: ext, game_n: 61000 + seq, game_pin: '424242', status: 'live', home_team: { name: 'Home' }, ...extra },
    sets: [],
    events: []
  })

  before(async () => {
    tdb = await createTestDatabase('mw_restore_deny')
    const logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    restore = createMatchRestore(db, { logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  it('a restore of a match an admin released leaves it released, and its created_at as it was', async () => {
    const ext = uniq()
    const made = await restore.restoreMatch(backup(ext), W)
    assert.equal(made.status, 200, JSON.stringify(made.body))
    const id = made.body.data.id
    // the admin's release-game (lib/accounts.js): exempt and released
    await raw.query("UPDATE matches SET official_game_exempt = true, released_at = now() - interval '1 hour' WHERE id = $1", [id])
    const before = (await raw.query('SELECT released_at, created_at, official_game_exempt FROM matches WHERE id = $1', [id])).rows[0]

    const r = await restore.restoreMatch(backup(ext, { released_at: null, created_at: '2001-01-01T00:00:00Z', official_game_exempt: false }), W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const after = (await raw.query('SELECT released_at, created_at, official_game_exempt FROM matches WHERE id = $1', [id])).rows[0]
    assert.notEqual(after.released_at, null, 'the release stays')
    assert.equal(after.released_at.getTime(), before.released_at.getTime())
    assert.equal(after.official_game_exempt, true)
    assert.equal(after.created_at.getTime(), before.created_at.getTime())
  })

  it('a match a restore creates gets the database\'s created_at, not the backup\'s', async () => {
    const ext = uniq()
    const r = await restore.restoreMatch(backup(ext, { created_at: '2001-01-01T00:00:00Z', released_at: '2001-01-02T00:00:00Z' }), W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const row = (await raw.query('SELECT released_at, created_at FROM matches WHERE external_id = $1', [ext])).rows[0]
    assert.equal(row.released_at, null)
    assert.ok(Date.now() - row.created_at.getTime() < 10 * 60 * 1000, String(row.created_at))
  })
})
