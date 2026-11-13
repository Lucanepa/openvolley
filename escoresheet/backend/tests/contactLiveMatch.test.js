// The support form's "match running" check (LIVE_MATCH_SQL): only a match
// that is not over counts.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createTestDatabase, SKIP_PG } from './helpers/pgTestDb.js'
import { LIVE_MATCH_SQL } from '../lib/contact.js'

describe('contact live match on Postgres', { skip: SKIP_PG }, () => {
  let tdb, c
  before(async () => {
    tdb = await createTestDatabase('contactlive', { schemaSql: `
      CREATE TABLE public.matches (id int PRIMARY KEY, status text);
      CREATE TABLE public.match_scorer_devices (match_id int, claimed_by uuid, claimed_at timestamptz);` })
    c = new pg.Client({ connectionString: tdb.url })
    await c.connect()
  })
  after(async () => {
    await c?.end()
    await tdb?.drop()
  })

  it('a live match counts; an approved or final one does not', async () => {
    const user = '00000000-0000-4000-8000-000000000001'
    const live = async (status) => {
      await c.query('TRUNCATE public.matches, public.match_scorer_devices')
      await c.query('INSERT INTO public.matches VALUES (1, $1)', [status])
      await c.query('INSERT INTO public.match_scorer_devices VALUES (1, $1, now())', [user])
      return (await c.query(LIVE_MATCH_SQL, [user])).rows.length > 0
    }
    assert.equal(await live('live'), true)
    assert.equal(await live(null), true)
    for (const s of ['approved', 'final', 'ended']) assert.equal(await live(s), false, s)
  })
})
