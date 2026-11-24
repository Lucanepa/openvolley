/**
 * PERM-02 (audit round 3): the pairs of a beach tournament are bounded, and
 * the anonymous public page is built once and bounded. Before, createEntry
 * and the import (600 rows a call, any number of calls) had no cap, and the
 * public page serialised every entry on every request: 24000 imported pairs
 * made a 7 MB page, and 60 parallel anonymous reads ran the shared backend
 * out of memory (poc/beach/entries-flood.mjs, public-burst.mjs,
 * poc/perm-02/measure.mjs).
 *
 *   - createEntry: 409 OV_DRAW_FULL past ENTRIES_PER_DRAW_MAX registered pairs
 *     of the draw (also a withdrawn pair registered again), 409
 *     OV_TOURNAMENT_ENTRIES_FULL past TOURNAMENT_ENTRIES_MAX entries of the
 *     tournament (any status)
 *   - the import: the same bounds against what the tournament already holds
 *     (imports one after the other), as row errors; pairs already there stay
 *   - publicTournament: one build for parallel requests, the JSON bytes and
 *     their gzip kept (not the object), a write drops them, at most
 *     PUBLIC_MAX_BYTES (truncated beyond); the editors' read is bounded too
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import {
  createBeachTournaments, ENTRIES_PER_DRAW_MAX, TOURNAMENT_ENTRIES_MAX, ENTRIES_READ_MAX, PUBLIC_MAX_BYTES
} from '../lib/beachTournaments.js'
import { accessFromRoles } from '../lib/access.js'

const quiet = { error () {}, warn () {}, log () {} }
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('beach tournaments: entry caps and the public page (PERM-02)', { skip: SKIP_PG }, () => {
  let db, pool, beach
  let publicBuilds = 0
  const organiser = { id: uid(21) }
  const access = accessFromRoles(['beach:competition_manager'])

  before(async () => {
    db = await createTestDatabase('fix_beach_backend_cap')
    const real = new pg.Pool({ connectionString: db.url, max: 8 })
    real.on('error', () => {})
    // counts the public page's tournament lookups (one per build)
    pool = new Proxy(real, {
      get (target, prop) {
        if (prop === 'query') {
          return (text, ...rest) => {
            if (typeof text === 'string' && /WHERE slug = \$1 AND public/.test(text)) publicBuilds++
            return target.query(text, ...rest)
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      }
    })
    await real.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [organiser.id, 'cap-organiser@example.invalid'])
    await real.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, ARRAY['beach:competition_manager'])", [organiser.id])
    beach = createBeachTournaments({ pool, accounts: { audit: async () => {} }, logger: quiet })
  })
  after(async () => {
    await pool?.end()
    await db?.drop()
  })

  const data = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body.data }
  const call = (method, pathname, body, query) => beach.route({ method, pathname, body, query, user: organiser, access })
  let seq = 0
  async function tournament ({ title, slug } = {}) {
    const body = { title: title || `Cap Cup ${++seq}`, starts_on: '2026-07-04', ends_on: '2026-07-05' }
    if (slug) body.slug = slug
    return data(await beach.createTournament({ user: organiser, access, body }), 201).tournament
  }
  const draw = async (t, category, gender = 'mixed') => data(await call('POST', `/api/beach/tournaments/${t.id}/draws`, { gender, category }), 201).draw
  /** n entries of `status` straight into the draw (as a tournament imported before the caps could have them). */
  async function fill (d, n, { status = 'registered', name = (i) => `Pair ${i}` } = {}) {
    await pool.query(
      `INSERT INTO public.beach_entries (draw_id, name, player1, player2, status)
       SELECT $1, $3 || g, jsonb_build_object('first', 'F' || g, 'last', 'A' || g, 'licence', 'L' || g, 'country', 'SUI'),
              jsonb_build_object('first', 'G' || g, 'last', 'B' || g, 'licence', 'M' || g, 'country', 'GER'), $4
         FROM generate_series(1, $2) g`, [d.id, n, name(''), status])
  }
  const entry = (d, i) => call('POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `X${i}` }, player2: { last: `Y${i}` } })
  const expectErr = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    assert.equal(r.body.error.code, code)
  }
  const importRows = (d, n, from = 0) => Array.from({ length: n }, (_, i) => ({
    draw: d, gender: 'mixed', p1_last: `Imp${from + i}a`, p1_licence: `I${from + i}A`, p2_last: `Imp${from + i}b`, p2_licence: `I${from + i}B`
  }))
  const preview = async (t, entries) => data(await beach.importTournament({ user: organiser, access, id: t.id, body: { entries }, query: new URLSearchParams('dryRun=1') }))
  const codesOf = (plan) => plan.rows.entries.flatMap((r) => r.messages.filter((m) => m.level === 'error').map((m) => m.code))

  it(`a draw takes at most ${ENTRIES_PER_DRAW_MAX} registered pairs by hand: 409 OV_DRAW_FULL, also for a pair registered again`, async () => {
    const t = await tournament()
    const d = await draw(t, 'D1')
    await fill(d, ENTRIES_PER_DRAW_MAX - 1)
    await fill(d, 3, { status: 'withdrawn', name: () => 'Gone ' })
    const last = data(await entry(d, 'last'), 201).entry
    expectErr(await entry(d, 'one more'), 409, 'OV_DRAW_FULL')
    const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered'", [d.id])
    assert.equal(n, ENTRIES_PER_DRAW_MAX)
    // a withdrawn pair registered again counts like a new one
    const { rows: [gone] } = await pool.query("SELECT id FROM public.beach_entries WHERE draw_id = $1 AND status = 'withdrawn' LIMIT 1", [d.id])
    expectErr(await call('PATCH', `/api/beach/entries/${gone.id}`, { status: 'registered' }), 409, 'OV_DRAW_FULL')
    // withdrawing one makes room again
    data(await call('PATCH', `/api/beach/entries/${last.id}`, { status: 'withdrawn' }))
    data(await call('PATCH', `/api/beach/entries/${gone.id}`, { status: 'registered' }))
    // another draw of the tournament is not full
    data(await entry(await draw(t, 'D2'), 1), 201)
  })

  it(`a tournament takes at most ${TOURNAMENT_ENTRIES_MAX} entries of any status: 409 OV_TOURNAMENT_ENTRIES_FULL`, async () => {
    const t = await tournament()
    const d1 = await draw(t, 'T1')
    const d2 = await draw(t, 'T2')
    await fill(d1, 200)
    await fill(d1, TOURNAMENT_ENTRIES_MAX - 201, { status: 'withdrawn', name: () => 'Gone ' })
    data(await entry(d2, 'last'), 201)
    expectErr(await entry(d2, 'one more'), 409, 'OV_TOURNAMENT_ENTRIES_FULL')
    expectErr(await entry(await draw(t, 'T3'), 'elsewhere'), 409, 'OV_TOURNAMENT_ENTRIES_FULL')
    // a tournament beyond the cap (from before it) stays readable and editable
    await fill(d1, 50)
    const b = data(await beach.getTournament({ user: organiser, access, id: t.id }))
    assert.equal(b.entries.length, TOURNAMENT_ENTRIES_MAX + 50)
    assert.equal(b.entries_truncated, undefined)
    data(await call('PATCH', `/api/beach/tournaments/${t.id}`, { venue: 'Still editable' }))
  })

  it('the import counts what the draw already holds: imports one after the other cannot pass the bound', async () => {
    const t = await tournament()
    const d = await draw(t, 'I1')
    await fill(d, ENTRIES_PER_DRAW_MAX - 5)
    // the file names the draw's pairs (they stay) and 8 new ones: 5 fit
    const { rows: had } = await pool.query("SELECT player1, player2 FROM public.beach_entries WHERE draw_id = $1 ORDER BY name", [d.id])
    const kept = had.map((e) => ({ draw: 'I1', gender: 'mixed', p1_last: e.player1.last, p1_first: e.player1.first, p1_licence: e.player1.licence, p2_last: e.player2.last, p2_first: e.player2.first, p2_licence: e.player2.licence }))
    const plan = await preview(t, [...kept, ...importRows('I1', 8)])
    assert.equal(plan.can_apply, false)
    assert.deepEqual(codesOf(plan), ['draw_full', 'draw_full', 'draw_full'])
    const bad = plan.rows.entries.filter((r) => r.status === 'error')
    assert.deepEqual(bad.map((r) => r.row), plan.rows.entries.slice(-3).map((r) => r.row), 'the last rows of the file')
    assert.deepEqual(bad[0].messages.find((m) => m.code === 'draw_full'), { level: 'error', code: 'draw_full', category: 'I1', gender: 'mixed', max: ENTRIES_PER_DRAW_MAX })
    // 5 new ones fit and are applied; then the draw is full for the next import
    const fits = await preview(t, [...kept, ...importRows('I1', 5)])
    assert.equal(fits.can_apply, true, JSON.stringify(codesOf(fits)))
    const applied = data(await beach.importTournament({ user: organiser, access, id: t.id, body: { entries: [...kept, ...importRows('I1', 5)], hash: fits.hash }, query: new URLSearchParams() }))
    assert.equal(applied.applied.entries_new, 5)
    const next = await preview(t, [...kept, ...importRows('I1', 5), ...importRows('I1', 1, 100)])
    assert.deepEqual(codesOf(next), ['draw_full'])
    // the pairs already there are no error, even in a draw beyond the bound (from before it)
    await fill(d, 3)
    const over = await preview(t, [...kept, ...importRows('I1', 5)])
    assert.deepEqual(codesOf(over), [])
  })

  it('the import counts the entries of the whole tournament, of any status (a withdrawn pair stays a row)', async () => {
    const t = await tournament()
    const d = await draw(t, 'W1')
    await fill(d, TOURNAMENT_ENTRIES_MAX - 4, { status: 'withdrawn', name: () => 'Gone ' })
    const plan = await preview(t, importRows('W2', 6))
    assert.deepEqual(codesOf(plan), ['tournament_full', 'tournament_full'])
    assert.equal(plan.can_apply, false)
    assert.deepEqual(plan.rows.entries.filter((r) => r.status === 'error').map((r) => r.messages[0]), [
      { level: 'error', code: 'tournament_full', max: TOURNAMENT_ENTRIES_MAX }, { level: 'error', code: 'tournament_full', max: TOURNAMENT_ENTRIES_MAX }])
    // one import after the other, each into a new draw (the audit's flood of
    // 40 x 600): the tournament's bound holds across them
    const t2 = await tournament()
    const perImport = 250
    let total = 0
    let refused = null
    for (let k = 0; k < 6 && !refused; k++) {
      const rows = importRows(`F${k}`, perImport, k * 1000)
      const p = await preview(t2, rows)
      if (!p.can_apply) {
        refused = p
        break
      }
      data(await beach.importTournament({ user: organiser, access, id: t2.id, body: { entries: rows, hash: p.hash }, query: new URLSearchParams() }))
      total += perImport
    }
    assert.ok(refused, 'an import is refused before the bound is passed')
    const room = TOURNAMENT_ENTRIES_MAX - total
    assert.deepEqual(codesOf(refused), Array(perImport - room).fill('tournament_full'))
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id WHERE d.tournament_id = $1', [t2.id])
    assert.equal(n, total)
    assert.ok(n <= TOURNAMENT_ENTRIES_MAX, `${n} entries`)
    // a draw of 600 rows: the rows past the draw's bound are errors
    const p600 = await preview(await tournament(), importRows('Big', 600))
    assert.equal(codesOf(p600).length, 600 - ENTRIES_PER_DRAW_MAX)
    assert.ok(codesOf(p600).every((c) => c === 'draw_full'))
  })

  it('the public page: one build for parallel reads, kept as bytes and gzip, dropped by a write', async () => {
    const t = await tournament({ title: 'Public Cup', slug: 'public-cap-cup' })
    const d = await draw(t, 'P1')
    await fill(d, 40)
    data(await call('PATCH', `/api/beach/tournaments/${t.id}`, { public: true, status: 'published' }))
    publicBuilds = 0
    const answers = await Promise.all(Array.from({ length: 60 }, () => beach.publicTournament({ slug: 'public-cap-cup' })))
    assert.equal(publicBuilds, 1, 'one build for 60 parallel reads')
    for (const a of answers) {
      assert.equal(a.status, 200)
      assert.equal(a.raw.text, answers[0].raw.text, 'the same bytes, not serialised again')
    }
    const text = answers[0].raw.text
    assert.ok(Buffer.isBuffer(text))
    assert.deepEqual(gunzipSync(answers[0].raw.gzip), text)
    const parsed = JSON.parse(text.toString())
    assert.deepEqual(answers[0].body, parsed)
    assert.equal(parsed.data.entries.length, 40)
    assert.equal(parsed.data.tournament.title, 'Public Cup')
    assert.equal(text.toString().includes('licence'), false, 'never a licence')
    // within the cache period: no new build
    await beach.publicTournament({ slug: 'public-cap-cup' })
    assert.equal(publicBuilds, 1)
    // a write of the tournament (here: a pair added) is shown at once
    data(await entry(d, 'new'), 201)
    const fresh = await beach.publicTournament({ slug: 'public-cap-cup' })
    assert.equal(publicBuilds, 2)
    assert.equal(JSON.parse(fresh.raw.text.toString()).data.entries.length, 41)
    data(await call('PATCH', `/api/beach/tournaments/${t.id}`, { title: 'Public Cup renamed' }))
    assert.equal((await beach.publicTournament({ slug: 'public-cap-cup' })).body.data.tournament.title, 'Public Cup renamed')
    // a write of another tournament keeps this one's answer
    const builds = publicBuilds
    data(await call('PATCH', `/api/beach/tournaments/${(await tournament()).id}`, { venue: 'elsewhere' }))
    await beach.publicTournament({ slug: 'public-cap-cup' })
    assert.equal(publicBuilds, builds)
    // an address unknown first, then made public: not kept as "not found"
    assert.equal((await beach.publicTournament({ slug: 'later-cap-cup' })).status, 404)
    const later = await tournament({ title: 'Later', slug: 'later-cap-cup' })
    data(await call('PATCH', `/api/beach/tournaments/${later.id}`, { public: true, status: 'published' }))
    assert.equal((await beach.publicTournament({ slug: 'later-cap-cup' })).status, 200)
  })

  it(`the public page is at most ${PUBLIC_MAX_BYTES} bytes, and the editors' read at most ${ENTRIES_READ_MAX} entries, for a tournament from before the caps`, async () => {
    const t = await tournament({ title: 'Flood Cup', slug: 'flood-cap-cup' })
    const d = await draw(t, 'F1')
    const long = (i) => `${'Lastname-with-a-long-name-'.repeat(3)}${i}`.slice(0, 100) + ' '
    await fill(d, ENTRIES_READ_MAX + 10, { name: () => long('') })
    data(await call('PATCH', `/api/beach/tournaments/${t.id}`, { public: true, status: 'live' }))
    const r = await beach.publicTournament({ slug: 'flood-cap-cup' })
    assert.equal(r.status, 200)
    assert.ok(r.raw.text.length <= PUBLIC_MAX_BYTES, `${r.raw.text.length} bytes`)
    const body = JSON.parse(r.raw.text.toString())
    assert.equal(body.data.truncated, true)
    assert.equal(body.data.tournament.title, 'Flood Cup')
    assert.equal(body.data.draws.length, 1)
    const b = data(await beach.getTournament({ user: organiser, access, id: t.id }))
    assert.equal(b.entries.length, ENTRIES_READ_MAX)
    assert.equal(b.entries_truncated, true)
    // and nothing more can be added to it
    expectErr(await entry(d, 'more'), 409, 'OV_DRAW_FULL')
  })
})
