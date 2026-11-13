/**
 * lib/beachTournaments.js against a real Postgres: the bounds of a
 * tournament, the per-account limits of the heavy calls, the locks of
 * delete and court removal, the saved-pair copy at the draw, and the
 * add-manager answer. Synthetic names and licences only.
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createBeachTournaments, MAX_DRAWS } from '../lib/beachTournaments.js'
import { createSavedTeams } from '../lib/savedTeams.js'
import { accessFromRoles } from '../lib/access.js'

const quiet = { error () {}, warn () {}, log () {} }
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('beach tournaments: bounds, limits and locks', { skip: SKIP_PG }, () => {
  let db, pool, beach, saved
  const organiser = { id: uid(1) }
  const other = { id: uid(2) }
  const adminOnly = { id: uid(3) }
  const access = accessFromRoles(['beach:competition_manager'])
  const emails = { [organiser.id]: 'organiser@example.invalid', [other.id]: 'other@example.invalid', [adminOnly.id]: 'admin@example.invalid' }

  before(async () => {
    db = await createTestDatabase('beachlimits')
    pool = new pg.Pool({ connectionString: db.url, max: 8 })
    pool.on('error', () => {})
    for (const [id, email] of Object.entries(emails)) {
      await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email])
    }
    await pool.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, ARRAY['beach:competition_manager']), ($2, ARRAY['beach:competition_manager']), ($3, ARRAY['admin'])",
      [organiser.id, other.id, adminOnly.id])
    beach = createBeachTournaments({ pool, accounts: { audit: async () => {} }, logger: quiet })
    saved = createSavedTeams({ pool, logger: quiet })
  })
  after(async () => {
    await pool?.end()
    await db?.drop()
  })

  const data = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body.data }
  const call = (user, method, pathname, body) => beach.route({ method, pathname, body, user, access })
  let seq = 0
  async function tournamentWithDraw ({ courts = 1, pairs = 4, user = organiser } = {}) {
    const t = data(await beach.createTournament({ user, access, body: { title: `Cup ${++seq}`, starts_on: '2026-07-04', ends_on: '2026-07-04', courts } }), 201).tournament
    const d = data(await call(user, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'mixed', category: 'L1' }), 201).draw
    for (let i = 0; i < pairs; i++) data(await call(user, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `A${i}` }, player2: { last: `B${i}` } }), 201)
    return { t, d }
  }
  /** Resolves with the answer, or 'waiting' when it has not come within `ms`. */
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('waiting'), ms))])

  it('deleting a tournament waits for a result being entered, then refuses (the result stays)', async () => {
    const { t, d } = await tournamentWithDraw()
    data(await beach.generate({ user: organiser, access, id: d.id, body: {} }))
    const { rows: [w1] } = await pool.query("SELECT id, entry1_id FROM public.beach_tmatches WHERE draw_id = $1 AND code = 'W1'", [d.id])
    // a second editor's result: enterResult's locks (the draw, then its matches) and update, not yet committed
    const x = await pool.connect()
    try {
      await x.query('BEGIN')
      await x.query('SELECT * FROM public.beach_draws WHERE id = $1 FOR UPDATE', [d.id])
      await x.query('SELECT * FROM public.beach_tmatches WHERE draw_id = $1 ORDER BY game_n FOR UPDATE', [d.id])
      await x.query("UPDATE public.beach_tmatches SET status = 'finished', result = 'played', winner_entry_id = $2, sets = '[[21,10],[21,12]]' WHERE id = $1", [w1.id, w1.entry1_id])
      const del = beach.deleteTournament({ user: organiser, access, id: t.id })
      assert.equal(await within(del, 300), 'waiting', 'the delete waits for the draw')
      await x.query('COMMIT')
      const r = await del
      assert.equal(r.status, 409, JSON.stringify(r.body))
      assert.equal(r.body.error.code, 'OV_DRAW_STARTED')
    } finally { x.release() }
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM public.beach_tmatches WHERE tournament_id = $1 AND status = $2', [t.id, 'finished'])
    assert.equal(n, 1)
  })

  it('removing a court waits for a Start on it, then refuses', async () => {
    const { t, d } = await tournamentWithDraw({ courts: 2 })
    data(await beach.generate({ user: organiser, access, id: d.id, body: {} }))
    data(await beach.schedule({ user: organiser, access, id: t.id, body: {} }))
    const { rows: [m] } = await pool.query(
      `SELECT m.id FROM public.beach_tmatches m JOIN public.beach_courts c ON c.id = m.court_id
        WHERE m.draw_id = $1 AND m.status = 'ready' AND c.number = 2 ORDER BY m.game_n LIMIT 1`, [d.id])
    assert.ok(m, 'a ready match on court 2')
    // setStatus' locks (the draw, then the match) and update, not yet committed
    const x = await pool.connect()
    try {
      await x.query('BEGIN')
      await x.query('SELECT * FROM public.beach_draws WHERE id = $1 FOR UPDATE', [d.id])
      await x.query('SELECT * FROM public.beach_tmatches WHERE id = $1 FOR UPDATE', [m.id])
      await x.query("UPDATE public.beach_tmatches SET status = 'called' WHERE id = $1", [m.id])
      const put = beach.route({ method: 'PUT', pathname: `/api/beach/tournaments/${t.id}/courts`, body: { courts: [{ number: 1 }] }, user: organiser, access })
      assert.equal(await within(put, 300), 'waiting', 'the court list waits for the draw')
      await x.query('COMMIT')
      const r = await put
      assert.equal(r.status, 409, JSON.stringify(r.body))
      assert.equal(r.body.error.code, 'OV_COURT_IN_USE')
    } finally { x.release() }
    const { rows: [{ court }] } = await pool.query('SELECT court_id IS NOT NULL AS court FROM public.beach_tmatches WHERE id = $1', [m.id])
    assert.equal(court, true, 'the called match keeps its court')
  })

  it('a schedule dry run takes no lock: it answers while another change holds the tournament', async () => {
    const { t, d } = await tournamentWithDraw()
    data(await beach.generate({ user: organiser, access, id: d.id, body: {} }))
    const x = await pool.connect()
    try {
      await x.query('BEGIN')
      await x.query('SELECT 1 FROM public.beach_tournaments WHERE id = $1 FOR UPDATE', [t.id])
      const dry = await within(beach.schedule({ user: organiser, access, id: t.id, body: { dryRun: true } }), 2000)
      assert.notEqual(dry, 'waiting', 'the dry run did not wait for the lock')
      assert.equal(dry.status, 200, JSON.stringify(dry.body))
      assert.ok(dry.body.data.slots.length > 0)
    } finally {
      await x.query('ROLLBACK')
      x.release()
    }
  })

  it('drawing the bracket keeps corrections made on the entry and never empties a player; an untouched copy follows the saved pair', async () => {
    const comp = data(await saved.createCompetition({ actorId: other.id, body: { name: 'Pairs 2026', season: '2026', sport: 'beach' } }), 201).competition
    const pairA = data(await saved.createTeam({ actorId: other.id, body: { competition_id: comp.id, name: 'Alpha/Beta' } }), 201).team
    data(await saved.putRoster({ id: pairA.id, body: { players: [{ number: 1, last_name: 'Alpha', license_number: 'LIC-OLD-1' }, { number: 2, last_name: 'Beta', license_number: 'LIC-OLD-2' }], staff: [] } }))
    const pairB = data(await saved.createTeam({ actorId: other.id, body: { competition_id: comp.id, name: 'Gamma' } }), 201).team
    data(await saved.putRoster({ id: pairB.id, body: { players: [{ number: 1, last_name: 'Gamma', license_number: 'LIC-G-1' }], staff: [] } }))

    const t = data(await beach.createTournament({ user: organiser, access, body: { title: 'Snap Cup', starts_on: '2026-07-04', ends_on: '2026-07-04', courts: 1 } }), 201).tournament
    const d = data(await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'mixed', category: 'S1' }), 201).draw
    const entry = (body) => call(organiser, 'POST', `/api/beach/draws/${d.id}/entries`, body)
    const eA = data(await entry({ team_id: pairA.id }), 201).entry
    // the organiser corrects player 2's licence on the entry
    data(await call(organiser, 'PATCH', `/api/beach/entries/${eA.id}`, { player2: { last: 'Beta', licence: 'LIC-NEW-2' } }))
    // a saved pair with one player, completed by hand on the entry
    const eB = data(await entry({ team_id: pairB.id, player2: { last: 'Delta', licence: 'LIC-D-2' } }), 201).entry
    for (let i = 0; i < 3; i++) data(await entry({ player1: { last: `X${i}` }, player2: { last: `Y${i}` } }), 201)
    // meanwhile the saved pair's player 1 gets a new licence: the untouched copy follows it
    data(await saved.putRoster({ id: pairA.id, body: { players: [{ number: 1, last_name: 'Alpha', license_number: 'LIC-NEW-1' }, { number: 2, last_name: 'Beta', license_number: 'LIC-OLD-2' }], staff: [] } }))

    data(await beach.generate({ user: organiser, access, id: d.id, body: {} }))
    const { rows } = await pool.query('SELECT id, player1, player2 FROM public.beach_entries WHERE id = ANY($1::uuid[])', [[eA.id, eB.id]])
    const got = new Map(rows.map((r) => [r.id, r]))
    assert.equal(got.get(eA.id).player2.licence, 'LIC-NEW-2', 'the correction stays')
    assert.equal(got.get(eA.id).player1.licence, 'LIC-NEW-1', 'the untouched copy follows the saved pair')
    assert.equal(got.get(eB.id).player2.last, 'Delta', 'the typed player 2 stays')
    assert.equal(got.get(eB.id).player1.last, 'Gamma')
    const rank = data(await beach.ranking({ user: organiser, access, id: d.id }))
    assert.ok(rank.csv.includes('LIC-NEW-2') && !rank.csv.includes('LIC-OLD-2'))
  })

  it(`a tournament takes at most ${MAX_DRAWS} draws, by hand and by an import`, async () => {
    const t = data(await beach.createTournament({ user: organiser, access, body: { title: 'Big Cup', starts_on: '2026-07-04', ends_on: '2026-07-04' } }), 201).tournament
    for (let i = 1; i < MAX_DRAWS; i++) {
      await pool.query("INSERT INTO public.beach_draws (tournament_id, category, gender) VALUES ($1, $2, 'mixed')", [t.id, `C${i}`])
    }
    data(await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'mixed', category: 'Last' }), 201)
    const r = await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'women', category: 'One more' })
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.equal(r.body.error.code, 'OV_TOURNAMENT_FULL')
    // an import that would add two draws: an error on their rows, nothing applied
    const row = (draw, i) => ({ draw, gender: 'women', p1_last: `P${i}`, p2_last: `Q${i}` })
    const preview = data(await beach.importTournament({
      user: organiser, access, id: t.id, body: { entries: [row('N1', 1), row('N1', 2), row('N2', 3)] }, query: new URLSearchParams('dryRun=1')
    }))
    assert.equal(preview.can_apply, false)
    assert.ok(preview.rows.entries.every((x) => x.messages.some((m) => m.code === 'too_many_draws' && m.max === MAX_DRAWS)), JSON.stringify(preview.rows.entries))
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM public.beach_draws WHERE tournament_id = $1', [t.id])
    assert.equal(n, MAX_DRAWS)
  })

  it('schedule runs and imports are limited per account', async () => {
    const t = data(await beach.createTournament({ user: other, access, body: { title: 'Busy Cup', starts_on: '2026-07-04', ends_on: '2026-07-04', courts: 1 } }), 201).tournament
    let last = null
    for (let i = 0; i < 40 && !(last && last.status === 429); i++) {
      last = i % 2 === 0
        ? await beach.schedule({ user: other, access, id: t.id, body: { dryRun: true } })
        : await beach.importTournament({ user: other, access, id: t.id, body: { entries: [] }, query: new URLSearchParams('dryRun=1') })
    }
    assert.equal(last.status, 429, JSON.stringify(last.body))
    assert.equal(last.body.error.code, 'OV_TOO_MANY_ATTEMPTS')
    // another account is not held up
    const { t: mine } = await tournamentWithDraw()
    assert.equal((await beach.schedule({ user: organiser, access, id: mine.id, body: { dryRun: true } })).status, 200)
  })

  it('add-manager answers the same for any address and adds only beach competition managers', async () => {
    const t = data(await beach.createTournament({ user: organiser, access, body: { title: 'Team Cup', starts_on: '2026-07-04', ends_on: '2026-07-04' } }), 201).tournament
    const add = (email) => call(organiser, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email })
    const known = await add(emails[other.id].toUpperCase())
    const unknown = await add('nobody@example.invalid')
    const admin = await add(emails[adminOnly.id])
    for (const r of [known, unknown, admin]) {
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body, known.body, 'one answer for every address')
    }
    assert.ok(!JSON.stringify(known.body).includes(other.id), 'no account id')
    const managers = data(await beach.getTournament({ user: organiser, access, id: t.id })).managers
    assert.deepEqual(managers.map((m) => m.email).sort(), [emails[organiser.id], emails[other.id]].sort())
    // a few a minute only
    let last = null
    for (let i = 0; i < 20 && !(last && last.status === 429); i++) last = await add(`probe${i}@example.invalid`)
    assert.equal(last.status, 429)
  })
})
