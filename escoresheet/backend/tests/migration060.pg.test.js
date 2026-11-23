/**
 * db/060_deleted_match_devices.sql (2611 review, SR-1): the record of a
 * deleted match keeps the devices that scored it (its scoring device, db/019,
 * and its event revisions' devices, db/015, lower case, at most 20), so
 * server.js matchState says "deleted" to a request that names one of them.
 *   - a delete records the devices next to the owners (db/056);
 *   - a match without a device records an empty list; one deleted before
 *     this file keeps NULL (the owners rule alone);
 *   - a second run changes nothing; the function body is current_definitions.sql's.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { currentDefinitions } from '../lib/schemaVersion.js'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(join(here, '..', 'db', '060_deleted_match_devices.sql'), 'utf8')

describe('migration 060: the devices of a deleted match', { skip: SKIP_PG }, () => {
  let t, raw
  const tombstone = async (ext) => (await raw.query('SELECT owners, devices FROM public.deleted_matches WHERE external_id = $1', [ext])).rows[0]
  async function match (ext) {
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, status, game_n) VALUES ($1, 'live', 9601) RETURNING id", [ext])
    return m.id
  }
  before(async () => {
    t = await createTestDatabase('mig060')
    raw = new pg.Client({ connectionString: t.url })
    await raw.connect()
  })
  after(async () => {
    await raw?.end().catch(() => {})
    await t?.drop()
  })

  it('a delete keeps the scoring device and the revisions\' devices, lower case, each once', async () => {
    const id = await match('m060_a')
    const tablet = randomUUID()
    const phone = randomUUID()
    await raw.query("INSERT INTO public.match_scorer_devices (match_id, device_id, platform) VALUES ($1, $2, 'android')", [id, tablet])
    for (const d of [tablet.toUpperCase(), phone, null]) {
      await raw.query(`INSERT INTO public.event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts, device_id)
                       VALUES ($1, $2, 'e1', 'void', 'undo', false, now(), $3)`, [randomUUID(), id, d])
    }
    await raw.query('DELETE FROM public.matches WHERE id = $1', [id])
    assert.deepEqual((await tombstone('m060_a')).devices, [tablet, phone].sort())
  })

  it('a match without a device keeps an empty list; a record of before stays NULL; a second run changes nothing', async () => {
    await match('m060_b')
    await raw.query("DELETE FROM public.matches WHERE external_id = 'm060_b'")
    assert.deepEqual((await tombstone('m060_b')).devices, [])
    await raw.query("INSERT INTO public.deleted_matches (external_id) VALUES ('m060_old')")
    await raw.query(MIGRATION)
    await raw.query(MIGRATION)
    assert.equal((await tombstone('m060_old')).devices, null)
    assert.deepEqual((await tombstone('m060_a')).devices.length, 2)
    const { rows: [fn] } = await raw.query("SELECT prosrc FROM pg_proc WHERE proname = 'ov_matches_deleted_owners'")
    assert.equal(fn.prosrc, currentDefinitions().find((d) => d.name === 'public.ov_matches_deleted_owners').body)
  })
})
