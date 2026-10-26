/**
 * OpenBeach tournaments end to end through server.js (db/014,
 * lib/beachTournaments.js; ~/ov-ops/openbeach-separation-tournaments-PLAN.md
 * phase T1):
 *   1. who may read, create and edit (beach roles of the row's sport; an
 *      indoor role gives nothing; drafts only for their editors)
 *   2. a tournament with courts, two draws, entries from a saved beach pair
 *      and typed pairs, seeds, the bracket (preview, write, game numbers per
 *      tournament), the schedule, manual results through to the final
 *      ranking, corrections and the bracket lock, the ranking CSV
 *   3. the public page: names and countries, never licences (D9)
 *   4. /api/db and restore never set matches.tournament_match_id
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('beach tournaments end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const tag = randomBytes(3).toString('hex')
  const ids = {}

  async function account (name, { roles = null } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, password }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const get = (user, path) => call(user, 'GET', path)
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    if (code) assert.equal(r.json?.error?.code, code, r.text)
  }
  const okData = (r, status = 200) => {
    assert.equal(r.status, status, r.text)
    return r.json.data
  }
  const bundle = async (user = users.mia) => okData(await get(user, `/api/beach/tournaments/${ids.t}`))
  const byCode = (b, drawId) => new Map(b.matches.filter((m) => m.draw_id === drawId).map((m) => [m.code, m]))

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-bt-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-bt-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', { roles: ['admin'] })
    await account('mia', { roles: ['beach:competition_manager'] }) // the organiser
    await account('max', { roles: ['beach:competition_manager'] }) // another organiser
    await account('bea', { roles: ['beach:scorer'] }) // a court-tablet scorer
    await account('ivan', { roles: ['scorer', 'competition_manager'] }) // indoor only
    await account('nobody')
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('only beach roles reach /api/beach; only beach competition managers create', async () => {
    expectCode(await api(srv.base, '/api/beach/tournaments', { method: 'GET', proto: null }), 401)
    expectCode(await get(users.ivan, '/api/beach/tournaments'), 403, 'OV_FORBIDDEN')
    expectCode(await get(users.nobody, '/api/beach/tournaments'), 403, 'OV_FORBIDDEN')
    assert.deepEqual(okData(await get(users.bea, '/api/beach/tournaments')).tournaments, [])
    const body = { title: 'Züri Open', starts_on: '2026-07-11', ends_on: '2026-07-12', courts: 2 }
    expectCode(await call(users.bea, 'POST', '/api/beach/tournaments', body), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.ivan, 'POST', '/api/beach/tournaments', body), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.mia, 'POST', '/api/beach/tournaments', { ...body, ends_on: '2026-07-10' }), 400, 'OV_INVALID_REQUEST')
    const t = okData(await call(users.mia, 'POST', '/api/beach/tournaments', body), 201).tournament
    assert.equal(t.slug, 'zuri-open-2026')
    assert.equal(t.status, 'draft')
    assert.equal(t.can_edit, true)
    ids.t = t.id
    // the same title again gets the next free address; a taken address is 409
    assert.equal(okData(await call(users.mia, 'POST', '/api/beach/tournaments', body), 201).tournament.slug, 'zuri-open-2026-2')
    expectCode(await call(users.max, 'POST', '/api/beach/tournaments', { ...body, slug: 'zuri-open-2026' }), 409, 'OV_SLUG_TAKEN')
    // the same title created at the same moment (two organisers, a double submit): each gets its own address
    const same = { ...body, title: `Race Cup ${tag}` }
    const raced = await Promise.all(Array.from({ length: 5 }, () => call(users.mia, 'POST', '/api/beach/tournaments', same)))
    for (const r of raced) assert.equal(r.status, 201, r.text)
    const slugs = raced.map((r) => r.json.data.tournament.slug).sort()
    assert.deepEqual(slugs, [`race-cup-${tag}-2026`, ...[2, 3, 4, 5].map((n) => `race-cup-${tag}-2026-${n}`)])
    for (const r of raced) okData(await call(users.mia, 'DELETE', `/api/beach/tournaments/${r.json.data.tournament.id}`))
  })

  it('drafts are their editors\' only; co-managers edit; the admin edits everything', async () => {
    expectCode(await get(users.bea, `/api/beach/tournaments/${ids.t}`), 404, 'OV_NOT_FOUND')
    expectCode(await get(users.max, `/api/beach/tournaments/${ids.t}`), 404, 'OV_NOT_FOUND')
    expectCode(await call(users.max, 'PATCH', `/api/beach/tournaments/${ids.t}`, { venue: 'Hack' }), 404)
    const b = okData(await get(users.admin, `/api/beach/tournaments/${ids.t}`))
    assert.equal(b.tournament.can_edit, true)
    assert.deepEqual(b.courts.map((c) => c.number), [1, 2])
    // co-managers: beach competition managers only (else the same 404)
    expectCode(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/managers`, { email: users.ivan.email }), 404)
    expectCode(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/managers`, { email: 'nobody@nowhere.example' }), 404)
    okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/managers`, { email: users.max.email.toUpperCase() }))
    okData(await call(users.max, 'PATCH', `/api/beach/tournaments/${ids.t}`, { venue: 'Strandbad Mythenquai', city: 'Zürich' }))
    const managers = (await bundle()).managers
    assert.deepEqual(managers.map((m) => [m.email, m.creator]), [[users.mia.email, true], [users.max.email, false]])
    okData(await call(users.mia, 'DELETE', `/api/beach/tournaments/${ids.t}/managers/${users.max.id}`))
    expectCode(await call(users.max, 'PATCH', `/api/beach/tournaments/${ids.t}`, { venue: 'x' }), 404)
    // published: scorers read it, but cannot change it
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { status: 'published' }))
    const forBea = okData(await get(users.bea, `/api/beach/tournaments/${ids.t}`))
    assert.equal(forBea.tournament.can_edit, false)
    assert.deepEqual(forBea.managers, [])
    expectCode(await call(users.bea, 'PATCH', `/api/beach/tournaments/${ids.t}`, { venue: 'x' }), 403, 'OV_FORBIDDEN')
    assert.equal(okData(await get(users.bea, '/api/beach/tournaments')).tournaments.length, 1)
    // courts: the full list
    const courts = okData(await call(users.mia, 'PUT', `/api/beach/tournaments/${ids.t}/courts`, {
      courts: [{ number: 1, name: 'Center' }, { number: 2 }, { number: 3, flex: true }]
    })).courts
    assert.deepEqual(courts.map((c) => [c.number, c.name, c.flex]), [[1, 'Center', false], [2, null, false], [3, null, true]])
    expectCode(await call(users.mia, 'PUT', `/api/beach/tournaments/${ids.t}/courts`, { courts: [{ number: 1 }, { number: 1 }] }), 400)
  })

  it('draws and entries: a saved beach pair, typed pairs, seeds', async () => {
    expectCode(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'women', category: 'A1', format: 'POOLS_SE' }), 400)
    const women = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'women', category: 'A1', slot_minutes: 45, rest_minutes: 15 }), 201).draw
    const men = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'men', category: 'B1' }), 201).draw
    ids.women = women.id
    ids.men = men.id
    // one draw per category (any case) and gender: the import finds draws so
    expectCode(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'women', category: 'a1' }), 409, 'OV_DRAW_EXISTS')
    const mixed = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'mixed', category: 'A1' }), 201).draw
    expectCode(await call(users.mia, 'PATCH', `/api/beach/draws/${men.id}`, { category: 'A1', gender: 'women' }), 409, 'OV_DRAW_EXISTS')
    expectCode(await call(users.mia, 'PATCH', `/api/beach/draws/${men.id}`, { category: 'a1 ', gender: 'mixed' }), 409, 'OV_DRAW_EXISTS')
    okData(await call(users.mia, 'PATCH', `/api/beach/draws/${women.id}`, { category: 'A1' })) // itself: no clash
    okData(await call(users.mia, 'DELETE', `/api/beach/draws/${mixed.id}`))
    // a NUL typed by hand is a 400, not a 503 from Postgres
    expectCode(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/draws`, { gender: 'men', category: 'B\u00002' }), 400)
    expectCode(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { venue: 'Strand\u0000bad' }), 400)
    // a saved beach pair (db/009) of the organiser
    const comp = okData(await call(users.mia, 'POST', '/api/saved-teams/competitions', { name: `Tour ${tag}`, season: '2026', sport: 'beach' }), 201)
    const team = okData(await call(users.mia, 'POST', '/api/saved-teams/teams', { competition_id: comp.competition?.id ?? comp.id, name: 'Muster/Beispiel' }), 201)
    const teamId = team.team?.id ?? team.id
    okData(await call(users.mia, 'PUT', `/api/saved-teams/teams/${teamId}/roster`, {
      players: [{ number: 1, first_name: 'Anna', last_name: 'Muster', license_number: 'LIC-1001', country: 'SUI' },
        { number: 2, first_name: 'Bea', last_name: 'Beispiel', license_number: 'LIC-1002', country: 'SUI' }],
      staff: []
    }))
    const fromPair = okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { team_id: teamId }), 201).entry
    assert.equal(fromPair.name, 'Muster/Beispiel')
    assert.deepEqual(fromPair.player1, { first: 'Anna', last: 'Muster', licence: 'LIC-1001', country: 'SUI' })
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { team_id: teamId }), 409, 'OV_ENTRY_EXISTS')
    // an indoor team is not a pair
    const indoor = okData(await call(users.admin, 'POST', '/api/saved-teams/competitions', { name: `Liga ${tag}`, season: '2026/27' }), 201)
    const indoorTeam = okData(await call(users.admin, 'POST', '/api/saved-teams/teams', { competition_id: indoor.competition?.id ?? indoor.id, name: 'VBC' }), 201)
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { team_id: indoorTeam.team?.id ?? indoorTeam.id }), 400)
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { player1: { last: 'Solo' } }), 400)
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { player1: { last: 'A', country: 'Switzerland' }, player2: { last: 'B' } }), 400)
    const entries = [fromPair]
    for (let i = 2; i <= 12; i++) {
      entries.push(okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, {
        player1: { first: `F${i}`, last: `West${i}`, licence: `W${i}A`, country: 'SUI' },
        player2: { first: `G${i}`, last: `Ost${i}`, licence: `W${i}B`, country: i % 2 ? 'GER' : 'SUI' }
      }), 201).entry)
    }
    assert.equal(entries[1].name, 'West2/Ost2')
    ids.womenEntries = entries.map((e) => e.id)
    // seeds: the pair from the saved team is seed 1, then the order typed
    okData(await call(users.mia, 'PUT', `/api/beach/draws/${ids.women}/seeds`, { order: ids.womenEntries }))
    expectCode(await call(users.mia, 'PUT', `/api/beach/draws/${ids.women}/seeds`, { order: [ids.womenEntries[0], ids.womenEntries[0]] }), 400)
    // a withdrawn pair does not play
    const extra = okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/entries`, { player1: { last: 'Late' }, player2: { last: 'Pair' } }), 201).entry
    okData(await call(users.mia, 'PATCH', `/api/beach/entries/${extra.id}`, { seed: 13 }))
    const withdrawn = okData(await call(users.mia, 'PATCH', `/api/beach/entries/${extra.id}`, { status: 'withdrawn' })).entry
    assert.equal(withdrawn.seed, null, 'a withdrawn pair gives up its seed')
    for (let i = 1; i <= 8; i++) {
      okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.men}/entries`, { seed: i, player1: { last: `M${i}a` }, player2: { last: `M${i}b` } }), 201)
    }
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.men}/entries`, { seed: 1, player1: { last: 'X' }, player2: { last: 'Y' } }), 400)
    // licences are for editors (the ranking for MyBeach); a scorer reads names and countries
    const forBea = await get(users.bea, `/api/beach/tournaments/${ids.t}`)
    assert.deepEqual(okData(forBea).entries.find((e) => e.id === fromPair.id).player1, { first: 'Anna', last: 'Muster', country: 'SUI' })
    for (const secret of ['LIC-1001', 'W2A', 'licence']) assert.equal(forBea.text.includes(secret), false, secret)
    assert.equal((await bundle()).entries.find((e) => e.id === fromPair.id).player1.licence, 'LIC-1001')
  })

  it('the bracket: preview, then written with game numbers per tournament', async () => {
    const preview = okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/generate`, { dryRun: true }))
    assert.equal(preview.teams, 12)
    assert.equal(preview.board_size, 16)
    assert.equal(preview.matches.length, 22)
    assert.deepEqual(preview.warnings, [])
    assert.equal((await bundle()).matches.length, 0, 'a preview writes nothing')
    expectCode(await call(users.bea, 'POST', `/api/beach/draws/${ids.women}/generate`, {}), 403)
    okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/generate`, {}))
    const men = okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.men}/generate`, {}))
    assert.deepEqual(men.warnings, [], 'B1 with 8 pairs')
    const b = await bundle()
    assert.deepEqual(b.matches.map((m) => m.game_n), Array.from({ length: 36 }, (_, i) => i + 1))
    const w = byCode(b, ids.women)
    // seeds 1-4 wait for the first round; the first round is ready
    assert.equal(w.get('W1').status, 'ready')
    assert.equal(w.get('W5').status, 'scheduled')
    assert.equal(w.get('W5').entry1_id, ids.womenEntries[0])
    assert.equal(b.draws.find((d) => d.id === ids.women).status, 'drawn')
    // seeds and entries are frozen once drawn
    expectCode(await call(users.mia, 'PUT', `/api/beach/draws/${ids.women}/seeds`, { order: ids.womenEntries }), 409, 'OV_DRAW_DRAWN')
    // regenerating before any result keeps the game numbers of the other draw
    okData(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/generate`, {}))
    const again = await bundle()
    assert.deepEqual(again.matches.filter((m) => m.draw_id === ids.men).map((m) => m.game_n), Array.from({ length: 14 }, (_, i) => 23 + i))
    assert.deepEqual(again.matches.filter((m) => m.draw_id === ids.women).map((m) => m.game_n), Array.from({ length: 22 }, (_, i) => 37 + i))
  })

  it('the schedule: every match on a court, inside the day, after what it waits for', async () => {
    const dry = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/schedule`, { dryRun: true, day_start: '08:30', day_end: '19:00' }))
    assert.equal(dry.unplaced.length, 0)
    assert.equal(dry.slots.length, 36)
    assert.equal((await bundle()).matches.every((m) => m.scheduled_at === null), true, 'a dry run writes nothing')
    const r = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/schedule`, { day_start: '08:30', day_end: '19:00' }))
    assert.equal(r.slots.length, 36)
    const b = await bundle()
    assert.equal(b.tournament.day_start, '08:30')
    assert.ok(b.matches.every((m) => m.court_id && m.scheduled_at))
    const first = b.matches.map((m) => m.scheduled_at).sort()[0]
    assert.equal(first, '2026-07-11T06:30:00.000Z', '08:30 in Zurich (summer time)')
    // a manual move: another court of this tournament only
    const m = byCode(b, ids.men).get('F')
    const other = b.courts.find((c) => c.id !== m.court_id)
    okData(await call(users.mia, 'PATCH', `/api/beach/tmatches/${m.id}`, { court_id: other.id, scheduled_at: '2026-07-12T15:00:00Z', referee: 'R. Pfiff' }))
    expectCode(await call(users.mia, 'PATCH', `/api/beach/tmatches/${m.id}`, { court_id: '00000000-0000-4000-8000-000000000000' }), 400)

    // a hand move is checked like the planner: court, days, hours, rest after its sources and before its dependents
    const w = byCode(b, ids.women)
    const move = (code, body) => call(users.mia, 'PATCH', `/api/beach/tmatches/${w.get(code).id}`, body)
    const reasons = (r) => {
      expectCode(r, 409, 'OV_SLOT_CONFLICT')
      return r.json.error.details.conflicts
    }
    const w1 = w.get('W1')
    const sameCourt = b.matches.find((x) => x.id !== w1.id && x.court_id === w1.court_id && x.draw_id === ids.women && x.code !== 'W5')
    const c1 = reasons(await call(users.mia, 'PATCH', `/api/beach/tmatches/${sameCourt.id}`, { scheduled_at: w1.scheduled_at }))
    assert.ok(c1.some((c) => c.reason === 'court' && c.code === 'W1' && c.game_n === w1.game_n), JSON.stringify(c1))
    // 07:00 in Zurich: before the play hours and before W1, whose winner W5 waits for
    const c2 = reasons(await move('W5', { scheduled_at: '2026-07-11T05:00:00Z' }))
    assert.ok(c2.some((c) => c.reason === 'hours'), JSON.stringify(c2))
    assert.ok(c2.some((c) => c.reason === 'before_source' && c.code === 'W1'), JSON.stringify(c2))
    assert.ok(reasons(await move('W5', { scheduled_at: '2026-07-13T08:00:00Z' })).some((c) => c.reason === 'days'))
    // W1 moved onto W5's start: W5 would start before W1 has ended
    assert.ok(reasons(await move('W1', { scheduled_at: w.get('W5').scheduled_at })).some((c) => c.reason === 'after_dependent' && c.code === 'W5'))
    expectCode(await move('W5', { scheduled_at: '2026-07-11T05:00:00Z', force: 'yes' }), 400)
    // the manager may keep it on purpose; nothing moved before that
    assert.equal((await bundle()).matches.find((x) => x.id === w.get('W5').id).scheduled_at, w.get('W5').scheduled_at)
    assert.equal(okData(await move('W5', { scheduled_at: '2026-07-11T05:00:00Z', force: true })).match.scheduled_at, '2026-07-11T05:00:00.000Z')
    // clearing a slot is never refused; back to the planned slot
    okData(await move('W5', { court_id: null }))
    okData(await move('W5', { court_id: w.get('W5').court_id, scheduled_at: w.get('W5').scheduled_at }))
    // referee and scorer names are not slot changes
    okData(await move('W1', { referee: 'A. Pfiff' }))
  })

  it('results: sets checked, the bracket advances, corrections, the lock, the final ranking', async () => {
    let b = await bundle()
    let w = byCode(b, ids.women)
    const result = (code, body) => call(users.mia, 'POST', `/api/beach/tmatches/${w.get(code).id}/result`, body)
    expectCode(await result('W5', { winner: 1, sets: [[21, 10], [21, 10]] }), 409, 'OV_MATCH_NOT_READY')
    expectCode(await result('W1', { winner: 1, sets: [[21, 20], [21, 10]] }), 400, 'OV_INVALID_REQUEST')
    expectCode(await result('W1', { winner: 1, sets: [[21, 10], [10, 21]] }), 400)
    expectCode(await result('W1', { winner: 2, sets: [[21, 10], [21, 12]] }), 400)
    expectCode(await result('W1', { winner: 1, sets: [[21, 10], [21, 12], [15, 3]] }), 400)
    expectCode(await call(users.bea, 'POST', `/api/beach/tmatches/${w.get('W1').id}/result`, { winner: 1, sets: [[21, 10], [21, 12]] }), 403)
    // W1: seed 8 against seed 9, won by seed 9 (an upset), in three sets
    okData(await result('W1', { winner: 2, sets: [[19, 21], [24, 22], [13, 15]] }))
    b = await bundle()
    w = byCode(b, ids.women)
    assert.equal(w.get('W5').entry2_id, ids.womenEntries[8], 'seed 9 meets seed 1')
    assert.equal(w.get('W5').status, 'ready')
    assert.equal(w.get('L1').entry1_id, ids.womenEntries[7], 'seed 8 drops to the losers bracket')
    assert.equal(b.draws.find((d) => d.id === ids.women).status, 'playing')
    // a second screen that still showed W1 open cannot overwrite it silently
    const stale = { winner_entry_id: null, result: null, sets: null }
    const r409 = await result('W1', { winner: 1, sets: [[21, 19], [22, 24], [15, 13]], expect: stale })
    expectCode(r409, 409, 'OV_RESULT_CHANGED')
    assert.equal(r409.json.error.details.match.winner_entry_id, ids.womenEntries[8])
    expectCode(await result('W1', { winner: 1, sets: [[21, 19], [22, 24], [15, 13]], expect: 'open' }), 400)
    // a correction before anything depends on it moves both teams (from the result the screen showed)
    okData(await result('W1', {
      winner: 1,
      sets: [[21, 19], [22, 24], [15, 13]],
      expect: { winner_entry_id: ids.womenEntries[8], result: 'played', sets: [[19, 21], [24, 22], [13, 15]] }
    }))
    w = byCode(await bundle(), ids.women)
    assert.equal(w.get('W5').entry2_id, ids.womenEntries[7])
    assert.equal(w.get('L1').entry1_id, ids.womenEntries[8])
    // W5 played: W1 can no longer change winner or be withdrawn
    okData(await result('W5', { winner: 1, result: 'retired', sets: [[21, 15], [3, 1]] }))
    expectCode(await result('W1', { winner: 2, sets: [[19, 21], [24, 22], [13, 15]] }), 409, 'OV_BRACKET_LOCKED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/tmatches/${w.get('W1').id}/result`), 409, 'OV_BRACKET_LOCKED')
    // the same winner with corrected points is fine
    okData(await result('W1', { winner: 1, sets: [[21, 19], [22, 24], [15, 11]] }))
    // withdraw W5 and play it again
    okData(await call(users.mia, 'DELETE', `/api/beach/tmatches/${w.get('W5').id}/result`))
    expectCode(await call(users.mia, 'DELETE', `/api/beach/tmatches/${w.get('W5').id}/result`), 409, 'OV_NO_RESULT')
    // the rest: the better seed wins (seed = position in ids.womenEntries + 1); one walkover
    const seedOf = (id) => ids.womenEntries.indexOf(id) + 1
    for (let guard = 0; guard < 40; guard++) {
      w = byCode(await bundle(), ids.women)
      const next = [...w.values()].find((m) => m.status === 'ready')
      if (!next) break
      const better = seedOf(next.entry1_id) < seedOf(next.entry2_id) ? 1 : 2
      const body = next.code === 'L1' ? { winner: better, result: 'walkover' } : { winner: better, sets: better === 1 ? [[21, 17], [21, 18]] : [[17, 21], [18, 21]] }
      okData(await call(users.mia, 'POST', `/api/beach/tmatches/${next.id}/result`, body))
    }
    const end = await bundle()
    assert.equal(end.draws.find((d) => d.id === ids.women).status, 'done')
    const rankOf = new Map(end.entries.filter((e) => e.draw_id === ids.women).map((e) => [e.id, e.final_rank]))
    assert.deepEqual(ids.womenEntries.map((id) => rankOf.get(id)), [1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9])
    assert.equal(byCode(end, ids.women).get('L1').status, 'walkover')
    // the ranking with licences, as CSV for MyBeach
    const r = okData(await get(users.mia, `/api/beach/draws/${ids.women}/ranking`))
    assert.equal(r.complete, true)
    assert.deepEqual(r.ranking.slice(0, 2).map((e) => [e.final_rank, e.name]), [[1, 'Muster/Beispiel'], [2, 'West2/Ost2']])
    const lines = r.csv.trim().split('\r\n')
    assert.equal(lines.length, 13)
    assert.match(lines[0], /^Rank;Seed;Team;/)
    assert.equal(lines[1], '1;1;Muster/Beispiel;Muster;Anna;LIC-1001;SUI;Beispiel;Bea;LIC-1002;SUI')
    expectCode(await get(users.bea, `/api/beach/draws/${ids.women}/ranking`), 403)
    // a played draw cannot be drawn again, reset or deleted
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.women}/generate`, {}), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/draws/${ids.women}/bracket`), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/draws/${ids.women}`), 409, 'OV_DRAW_STARTED')
  })

  it('a match that has begun on a court locks its draw', async () => {
    const b = await bundle()
    const m = byCode(b, ids.men).get('W1')
    await sql.query("UPDATE public.beach_tmatches SET status = 'in_progress' WHERE id = $1", [m.id])
    expectCode(await call(users.mia, 'POST', `/api/beach/draws/${ids.men}/generate`, {}), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/draws/${ids.men}/bracket`), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/draws/${ids.men}`), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'DELETE', `/api/beach/tournaments/${ids.t}`), 409, 'OV_DRAW_STARTED')
    expectCode(await call(users.mia, 'PATCH', `/api/beach/tmatches/${m.id}`, { court_id: null }), 409, 'OV_MATCH_BEGUN')
    await sql.query("UPDATE public.beach_tmatches SET status = 'ready' WHERE id = $1", [m.id])
  })

  it('the public page: public tournaments only, names and countries, never licences', async () => {
    const pub = (slug) => api(srv.base, `/api/public/beach/t/${slug}`, { method: 'GET', proto: null })
    expectCode(await pub('zuri-open-2026'), 404, 'OV_NOT_FOUND')
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { public: true, status: 'live' }))
    // the 404 above is cached for 15 s per process: the second address was never asked for
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { slug: 'zuri-open-live' }))
    const r = await pub('zuri-open-live')
    assert.equal(r.status, 200, r.text)
    assert.match(r.headers.get('cache-control'), /public, max-age=15/)
    const data = r.json.data
    assert.equal(data.tournament.title, 'Züri Open')
    assert.equal(data.draws.length, 2)
    assert.equal(data.entries.length, 20, 'registered pairs only')
    assert.deepEqual(data.entries.find((e) => e.name === 'Muster/Beispiel').players,
      [{ first: 'Anna', last: 'Muster', country: 'SUI' }, { first: 'Bea', last: 'Beispiel', country: 'SUI' }])
    assert.equal(data.matches.length, 36)
    assert.ok(data.matches.every((m) => m.court === null || Number.isInteger(m.court)))
    for (const secret of ['LIC-1001', 'licence', users.mia.email, users.mia.id, 'created_by', 'match_id', 'claimed_by', 'referee']) {
      assert.equal(r.text.includes(secret), false, secret)
    }
    expectCode(await pub('Not-A-Slug'), 404)
    expectCode(await api(srv.base, '/api/public/beach/t/zuri-open-live', { method: 'POST', proto: null, body: {} }), 404)
  })

  it('/api/db never writes matches.tournament_match_id; the audit log names the app', async () => {
    const b = await bundle()
    const tm = b.matches[0]
    const ins = await api(srv.base, '/api/db', {
      token: users.bea.token,
      proto: '2',
      body: { table: 'matches', action: 'insert', params: { data: { external_id: `bt_${tag}`, sport_type: 'beach', status: 'live', game_n: 1, tournament_match_id: tm.id }, returning: 'id', single: true } }
    })
    assert.equal(ins.status, 200, ins.text)
    assert.equal((await sql.query('SELECT tournament_match_id FROM public.matches WHERE id = $1', [ins.json.data.id])).rows[0].tournament_match_id, null)
    // game 1 of a beach tournament: never "taken" by another season's beach game 1 (db/013)
    const ins2 = await api(srv.base, '/api/db', {
      token: users.bea.token,
      proto: '2',
      body: { table: 'matches', action: 'insert', params: { data: { external_id: `bt2_${tag}`, sport_type: 'beach', status: 'live', game_n: 1 }, returning: 'id', single: true } }
    })
    assert.equal(ins2.status, 200, ins2.text)
    const audit = okData(await get(users.admin, '/api/admin/audit?app=beach&limit=200')).entries
    const actions = new Set(audit.map((e) => e.action))
    for (const a of ['tournament.create', 'tournament.update', 'tournament.managers', 'tournament.draw', 'tournament.entry', 'tournament.schedule', 'tournament.result']) {
      assert.ok(actions.has(a), a)
    }
    assert.ok(audit.every((e) => e.app === 'beach'))
    const indoor = okData(await get(users.admin, '/api/admin/audit?app=indoor&limit=200')).entries
    assert.equal(indoor.some((e) => e.action.startsWith('tournament.')), false)
  })

  it('a small tournament: the board follows late pairs, the 3rd place completes a draw, two draws generated at once', async () => {
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', { title: 'Mini Cup', starts_on: '2026-07-04', ends_on: '2026-07-04', courts: 2 }), 201).tournament
    const draw = async (category) => okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'mixed', category }), 201).draw
    const pairs = async (d, k, from = 1) => {
      const out = []
      for (let i = from; i < from + k; i++) {
        out.push(okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `${d.category}${i}a` }, player2: { last: `${d.category}${i}b` } }), 201).entry)
      }
      return out
    }
    const generate = (d, body = {}) => call(users.max, 'POST', `/api/beach/draws/${d.id}/generate`, body)
    const drawOf = async (d) => okData(await get(users.max, `/api/beach/tournaments/${t.id}`)).draws.find((x) => x.id === d.id)

    // 8 pairs on a board of 8; a late 9th pair after a reset gets a board of 16
    const b = await draw('B1')
    await pairs(b, 8)
    assert.equal(okData(await generate(b)).board_size, 8)
    assert.equal((await drawOf(b)).board_size, null, 'a derived size is not stored as a choice')
    okData(await call(users.max, 'DELETE', `/api/beach/draws/${b.id}/bracket`))
    const [late] = await pairs(b, 1, 9)
    assert.equal(okData(await generate(b)).board_size, 16)
    // and back to 8 when it withdraws
    okData(await call(users.max, 'DELETE', `/api/beach/draws/${b.id}/bracket`))
    okData(await call(users.max, 'PATCH', `/api/beach/entries/${late.id}`, { status: 'withdrawn' }))
    assert.equal(okData(await generate(b, { dryRun: true })).board_size, 8)
    // a manager's choice is kept while it fits, and gives way when it no longer does
    okData(await call(users.max, 'PATCH', `/api/beach/draws/${b.id}`, { board_size: 16 }))
    assert.equal(okData(await generate(b, { dryRun: true })).board_size, 16)
    okData(await call(users.max, 'PATCH', `/api/beach/draws/${b.id}`, { board_size: 8 }))
    okData(await call(users.max, 'PATCH', `/api/beach/entries/${late.id}`, { status: 'registered' }))
    expectCode(await generate(b, { board_size: 8 }), 400, 'OV_INVALID_REQUEST')
    assert.equal(okData(await generate(b)).board_size, 16)
    assert.equal((await drawOf(b)).board_size, null)

    // 4 pairs: the final before the 3rd place leaves the draw playing and the ranking provisional
    const a = await draw('A1')
    await pairs(a, 4)
    okData(await generate(a))
    const matchesOf = async () => new Map(okData(await get(users.max, `/api/beach/tournaments/${t.id}`)).matches.filter((m) => m.draw_id === a.id).map((m) => [m.code, m]))
    const win1 = (m) => call(users.max, 'POST', `/api/beach/tmatches/${m.id}/result`, { winner: 1, sets: [[21, 15], [21, 15]] })
    for (let guard = 0; guard < 10; guard++) {
      const next = [...(await matchesOf()).values()].find((m) => m.status === 'ready' && m.code !== 'F' && m.code !== 'P3')
      if (!next) break
      okData(await win1(next))
    }
    let ms = await matchesOf()
    assert.equal(ms.get('F').status, 'ready')
    assert.equal(ms.get('P3').status, 'ready')
    okData(await win1(ms.get('F')))
    assert.equal((await drawOf(a)).status, 'playing')
    let r = okData(await get(users.max, `/api/beach/draws/${a.id}/ranking`))
    assert.equal(r.complete, false)
    assert.deepEqual(r.ranking.map((e) => e.final_rank), [1, 2, null, null])
    ms = await matchesOf()
    okData(await win1(ms.get('P3')))
    assert.equal((await drawOf(a)).status, 'done')
    r = okData(await get(users.max, `/api/beach/draws/${a.id}/ranking`))
    assert.equal(r.complete, true)
    assert.deepEqual(r.ranking.map((e) => e.final_rank), [1, 2, 3, 4])

    // two draws of the tournament generated at the same moment: both get their game numbers
    const c = await draw('C1')
    const d = await draw('D1')
    await pairs(c, 8)
    await pairs(d, 8)
    const both = await Promise.all([generate(c), generate(d)])
    for (const x of both) assert.equal(x.status, 200, x.text)
    const games = okData(await get(users.max, `/api/beach/tournaments/${t.id}`)).matches.map((m) => m.game_n).sort((x, y) => x - y)
    assert.equal(new Set(games).size, games.length)
    assert.deepEqual(games, Array.from({ length: games.length }, (_, i) => i + 1))
  })

  it('a result or a withdrawal from an outdated screen is refused, never credited to another pair', async () => {
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', { title: 'Stale Cup', starts_on: '2026-07-18', ends_on: '2026-07-18', courts: 2 }), 201).tournament
    const d = okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'women', category: 'S1' }), 201).draw
    for (let i = 1; i <= 8; i++) {
      okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `S${i}a` }, player2: { last: `S${i}b` } }), 201)
    }
    okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/generate`, {}))
    const matches = async () => new Map(okData(await get(users.max, `/api/beach/tournaments/${t.id}`)).matches.map((m) => [m.code, m]))
    // what manager-beach's ResultModal sends: the match as its screen shows it
    const screen = (m) => ({ winner_entry_id: m.winner_entry_id, result: m.result, sets: m.sets, entry1_id: m.entry1_id, entry2_id: m.entry2_id })
    const result = (m, winner, expect) => call(users.max, 'POST', `/api/beach/tmatches/${m.id}/result`, {
      winner, sets: winner === 1 ? [[21, 15], [21, 15]] : [[15, 21], [15, 21]], ...(expect ? { expect } : {})
    })
    const withdraw = (m, expect) => call(users.max, 'DELETE', `/api/beach/tmatches/${m.id}/result${expect ? `?expect=${encodeURIComponent(JSON.stringify(expect))}` : ''}`)
    let ms = await matches()
    const w1 = ms.get('W1')
    const dep = [...ms.values()].find((m) => m.source1 === 'winner:W1' || m.source2 === 'winner:W1')
    const feeder = (dep.source1 === 'winner:W1' ? dep.source2 : dep.source1).slice('winner:'.length)
    okData(await result(w1, 1, screen(w1)))
    okData(await result(ms.get(feeder), 1))
    ms = await matches()
    const w1first = ms.get('W1')
    // manager A's screen: the dependent match with W1's winner X in it, no result yet
    const seen = ms.get(dep.code)
    const sideX = seen.source1 === 'winner:W1' ? 1 : 2
    const x = sideX === 1 ? seen.entry1_id : seen.entry2_id
    // co-manager B corrects W1: Z won, so Z replaces X in the dependent match
    okData(await result(w1first, 2, screen(w1first)))
    ms = await matches()
    assert.equal([ms.get(dep.code).entry1_id, ms.get(dep.code).entry2_id].includes(x), false, 'X is no longer in the match')
    // A saves "X won" from the outdated screen: refused, with the match as it is now
    const r = await result(seen, sideX, screen(seen))
    expectCode(r, 409, 'OV_MATCH_TEAMS_CHANGED')
    assert.equal(r.json.error.details.match.id, seen.id)
    assert.deepEqual([r.json.error.details.match.entry1_id, r.json.error.details.match.entry2_id], [ms.get(dep.code).entry1_id, ms.get(dep.code).entry2_id])
    ms = await matches()
    assert.equal(ms.get(dep.code).winner_entry_id, null, 'nothing stored')
    assert.equal(ms.get(dep.code).status, 'ready')
    expectCode(await result(seen, sideX, { ...screen(seen), entry1_id: 'not-an-id' }), 400, 'OV_INVALID_REQUEST')
    // a screen with the current teams saves; a withdrawal without expect (an older app) still works
    okData(await result(ms.get(dep.code), sideX, screen(ms.get(dep.code))))
    okData(await call(users.max, 'DELETE', `/api/beach/tmatches/${ms.get(dep.code).id}/result`))

    // a withdrawal from a screen that still shows W1's first result: B's correction stays
    expectCode(await withdraw(w1, screen(w1first)), 409, 'OV_RESULT_CHANGED')
    ms = await matches()
    assert.equal(ms.get('W1').winner_entry_id, w1first.entry2_id, 'the correction is kept')
    expectCode(await call(users.max, 'DELETE', `/api/beach/tmatches/${w1.id}/result?expect=%7Bnope`), 400, 'OV_INVALID_REQUEST')
    expectCode(await withdraw(w1, { ...screen(ms.get('W1')), sets: 'x' }), 400, 'OV_INVALID_REQUEST')
    // from the current screen it goes; the same outdated screen again is refused
    assert.equal(okData(await withdraw(w1, screen(ms.get('W1')))).match.winner_entry_id, null)
    expectCode(await withdraw(w1, screen(ms.get('W1'))), 409, 'OV_RESULT_CHANGED')
  })

  it('a court keeps the matches played on it: not removed, and shown on the public page when switched off', async () => {
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', { title: 'Court History Cup', starts_on: '2026-08-08', ends_on: '2026-08-08', courts: 3 }), 201).tournament
    const d = okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'women', category: 'H1' }), 201).draw
    for (let i = 1; i <= 8; i++) {
      okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `H${i}a` }, player2: { last: `H${i}b` } }), 201)
    }
    okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/generate`, {}))
    okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/schedule`, {}))
    let b = okData(await get(users.max, `/api/beach/tournaments/${t.id}`))
    const court3 = b.courts.find((c) => c.number === 3)
    const played = b.matches.find((m) => m.court_id === court3.id && m.status === 'ready')
    assert.ok(played, 'a first-round match on court 3')
    okData(await call(users.max, 'POST', `/api/beach/tmatches/${played.id}/result`, { winner: 1, sets: [[21, 15], [21, 15]] }))
    // dropping court 3 from the list would erase where that match was played
    const put = (courts) => call(users.max, 'PUT', `/api/beach/tournaments/${t.id}/courts`, { courts })
    expectCode(await put([{ number: 1 }, { number: 2 }]), 409, 'OV_COURT_IN_USE')
    b = okData(await get(users.max, `/api/beach/tournaments/${t.id}`))
    assert.equal(b.matches.find((m) => m.id === played.id).court_id, court3.id)
    assert.equal(b.courts.length, 3)
    // switched off instead (flooded): kept, and the public page still names it
    okData(await put([{ number: 1 }, { number: 2 }, { number: 3, active: false }]))
    okData(await call(users.max, 'PATCH', `/api/beach/tournaments/${t.id}`, { public: true, status: 'live' }))
    const pub = await api(srv.base, `/api/public/beach/t/${t.slug}`, { method: 'GET', proto: null })
    assert.equal(pub.status, 200, pub.text)
    const onCourt3 = b.matches.filter((m) => m.court_id === court3.id).map((m) => m.game_n)
    assert.ok(onCourt3.length > 0)
    for (const n of onCourt3) assert.equal(pub.json.data.matches.find((m) => m.game_n === n).court, 3, `game ${n}`)
    assert.deepEqual(pub.json.data.courts.map((c) => c.number), [1, 2], 'the list shows the courts in use')
    // a court with no match begun on it can still go (its open matches lose the court, as before)
    const court2 = b.courts.find((c) => c.number === 2)
    assert.equal(b.matches.some((m) => m.court_id === court2.id && !['scheduled', 'ready'].includes(m.status)), false)
    okData(await put([{ number: 1 }, { number: 3, active: false }]))
  })

  it('a result or a withdrawal for a match the bracket drawn again has replaced: 404, not "database unavailable"', async () => {
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', { title: 'Redraw Cup', starts_on: '2026-07-25', ends_on: '2026-07-25', courts: 1 }), 201).tournament
    const d = okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'mixed', category: 'R1' }), 201).draw
    for (let i = 1; i <= 4; i++) {
      okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `R${i}a` }, player2: { last: `R${i}b` } }), 201)
    }
    okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/generate`, {}))
    const list = okData(await get(users.max, `/api/beach/tournaments/${t.id}`)).matches
    const w1 = list.find((m) => m.code === 'W1')
    const w2 = list.find((m) => m.code === 'W2')
    okData(await call(users.max, 'POST', `/api/beach/tmatches/${w2.id}/result`, { winner: 1, sets: [[21, 15], [21, 15]] }))
    // the request waits for the draw (as behind another manager's "Draw the bracket"); meanwhile the match goes
    const replaced = async (id, send) => {
      await sql.query('BEGIN')
      await sql.query('SELECT 1 FROM public.beach_draws WHERE id = $1 FOR UPDATE', [d.id])
      const pending = send()
      await sleep(300)
      await sql.query('DELETE FROM public.beach_tmatches WHERE id = $1', [id])
      await sql.query('COMMIT')
      return pending
    }
    expectCode(await replaced(w1.id, () => call(users.max, 'POST', `/api/beach/tmatches/${w1.id}/result`, { winner: 1, sets: [[21, 15], [21, 15]] })), 404, 'OV_NOT_FOUND')
    expectCode(await replaced(w2.id, () => call(users.max, 'DELETE', `/api/beach/tmatches/${w2.id}/result`)), 404, 'OV_NOT_FOUND')
  })

  it('a match on court keeps its court, its time and its pairs: Start, and a slot that has begun', async () => {
    // yesterday to tomorrow (Zurich), all day: "now" is always on a tournament day
    const zurichDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' })
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', {
      title: 'Court Cup', starts_on: zurichDay(Date.now() - 86400000), ends_on: zurichDay(Date.now() + 86400000), day_start: '00:00', day_end: '23:55', courts: 4
    }), 201).tournament
    const d = okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'men', category: 'C1' }), 201).draw
    for (let i = 1; i <= 8; i++) {
      okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `C${i}a` }, player2: { last: `C${i}b` } }), 201)
    }
    okData(await call(users.max, 'POST', `/api/beach/draws/${d.id}/generate`, {}))
    const tour = async () => okData(await get(users.max, `/api/beach/tournaments/${t.id}`))
    const matches = async () => new Map((await tour()).matches.map((m) => [m.code, m]))
    const courts = (await tour()).courts
    const status = (m, s) => call(users.max, 'POST', `/api/beach/tmatches/${m.id}/status`, { status: s })
    const win = (m, winner) => call(users.max, 'POST', `/api/beach/tmatches/${m.id}/result`, { winner, sets: winner === 1 ? [[21, 15], [21, 15]] : [[15, 21], [15, 21]] })
    const place = (m, court, at, force = true) => call(users.max, 'PATCH', `/api/beach/tmatches/${m.id}`, { court_id: court.id, scheduled_at: at, force })
    const at = (min) => new Date(Math.floor(Date.now() / 300000) * 300000 + min * 60000).toISOString()
    let ms = await matches()

    // W1 ended; W2 started by the manager (its slot later than planned: started early);
    // W3 on court since its slot began 30 minutes ago, nobody pressed Start
    okData(await place(ms.get('W1'), courts[0], at(-60)))
    okData(await place(ms.get('W2'), courts[1], at(120)))
    okData(await place(ms.get('W3'), courts[2], at(-30)))
    okData(await place(ms.get('W4'), courts[3], at(90)))
    okData(await win(ms.get('W1'), 1))
    assert.equal(okData(await status(ms.get('W2'), 'in_progress')).match.status, 'in_progress')
    ms = await matches()
    const before = (c) => ({ court_id: ms.get(c).court_id, scheduled_at: ms.get(c).scheduled_at })
    const keep = { W2: before('W2'), W3: before('W3') }
    const w4 = before('W4')
    okData(await call(users.max, 'POST', `/api/beach/tournaments/${t.id}/schedule`, {}))
    ms = await matches()
    assert.deepEqual(before('W2'), keep.W2, 'a started match keeps its court and time')
    assert.deepEqual(before('W3'), keep.W3, 'a ready match whose slot has begun keeps its court and time')
    assert.notDeepEqual(before('W4'), w4, 'a match whose slot lies ahead is placed again')
    for (const m of ms.values()) {
      if (['W1', 'W2', 'W3'].includes(m.code) || !m.scheduled_at || m.court_id !== keep.W3.court_id) continue
      assert.ok(Date.parse(m.scheduled_at) >= Date.parse(keep.W3.scheduled_at) + 50 * 60000, `${m.code} is not put on W3's court while W3 is played`)
    }
    // a hand move of a match whose slot has begun asks first (it may be on court)
    const moved = await place(ms.get('W3'), courts[2], at(60), false)
    expectCode(moved, 409, 'OV_SLOT_CONFLICT')
    assert.ok(moved.json.error.details.conflicts.some((c) => c.reason === 'begun'), moved.text)
    // a started match is not moved at all (as before)
    expectCode(await place(ms.get('W2'), courts[1], at(180)), 409, 'OV_MATCH_BEGUN')

    // W1's winner X plays the next match; once it is started, a correction of W1 is refused
    const dep = [...ms.values()].find((m) => m.source1 === 'winner:W1' || m.source2 === 'winner:W1')
    const feeder = (dep.source1 === 'winner:W1' ? dep.source2 : dep.source1).slice('winner:'.length)
    expectCode(await status(dep, 'in_progress'), 409, 'OV_MATCH_NOT_READY')
    okData(await status(ms.get(feeder), 'open'))
    okData(await win(ms.get(feeder), 1))
    ms = await matches()
    okData(await status(ms.get(dep.code), 'called'))
    assert.equal(okData(await status(ms.get(dep.code), 'in_progress')).match.status, 'in_progress')
    expectCode(await win(ms.get('W1'), 2), 409, 'OV_BRACKET_LOCKED')
    expectCode(await call(users.max, 'DELETE', `/api/beach/tmatches/${ms.get('W1').id}/result`), 409, 'OV_BRACKET_LOCKED')
    // not started after all: back to open, and the correction goes through
    assert.equal(okData(await status(ms.get(dep.code), 'open')).match.status, 'ready')
    okData(await win(ms.get('W1'), 2))
    // the result of a started match is entered as usual
    ms = await matches()
    okData(await status(ms.get(dep.code), 'in_progress'))
    assert.equal(okData(await win(ms.get(dep.code), 1)).match.status, 'finished')
    expectCode(await status(ms.get(dep.code), 'in_progress'), 409, 'OV_MATCH_ENDED')
    expectCode(await status(ms.get(dep.code), 'open'), 409, 'OV_MATCH_ENDED')
    // checked input, editors only
    expectCode(await status(ms.get('W4'), 'finished'), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.max, 'POST', `/api/beach/tmatches/${ms.get('W4').id}/status`, {}), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.bea, 'POST', `/api/beach/tmatches/${ms.get('W4').id}/status`, { status: 'in_progress' }), 404)
    const audit = okData(await get(users.admin, '/api/admin/audit?app=beach&limit=200')).entries
    assert.ok(audit.some((e) => e.action === 'tournament.schedule' && e.details?.op === 'status' && e.details?.status === 'in_progress'))
  })

  it('deleting a tournament that has not begun removes everything', async () => {
    const t = okData(await call(users.max, 'POST', '/api/beach/tournaments', { title: 'Kurz', starts_on: '2026-08-01', ends_on: '2026-08-01', courts: 1 }), 201).tournament
    expectCode(await call(users.mia, 'DELETE', `/api/beach/tournaments/${t.id}`), 404)
    okData(await call(users.max, 'DELETE', `/api/beach/tournaments/${t.id}`))
    expectCode(await get(users.max, `/api/beach/tournaments/${t.id}`), 404)
    expectCode(await call(users.max, 'GET', '/api/beach/nothing'), 404)
    expectCode(await call(users.max, 'PUT', '/api/beach/tournaments'), 405)
  })
})
