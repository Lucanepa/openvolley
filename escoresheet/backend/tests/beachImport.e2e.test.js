/**
 * The Excel/CSV import of an OpenBeach tournament end to end through
 * server.js (POST /api/beach/tournaments/:id/import, lib/beachImport.js;
 * ~/ov-ops/openbeach-separation-tournaments-PLAN.md 3.4, phase T2):
 *   1. editors only (scorers, other organisers and indoor roles are refused)
 *   2. ?dryRun=1 writes nothing and answers the rows, the diff and a hash
 *   3. the apply needs the preview's hash: a file or tournament changed
 *      meanwhile is refused (409 OV_IMPORT_CHANGED, with the new preview);
 *      rows with errors are refused (400 OV_IMPORT_INVALID)
 *   4. the same file again changes nothing; a second file withdraws, re-seeds
 *      and links a saved pair by its licences
 *   5. a Matches sheet draws the bracket and sets the organiser's slots and
 *      officials; the audit names the app
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

describe('beach tournament import end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const tag = randomBytes(3).toString('hex')
  let tid

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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    if (code) assert.equal(r.json?.error?.code, code, r.text)
  }
  const okData = (r, status = 200) => {
    assert.equal(r.status, status, r.text)
    return r.json.data
  }
  const preview = (user, body) => call(user, 'POST', `/api/beach/tournaments/${tid}/import?dryRun=1`, body)
  const apply = (user, body, hash) => call(user, 'POST', `/api/beach/tournaments/${tid}/import`, { ...body, hash })
  const bundle = async () => okData(await call(users.mia, 'GET', `/api/beach/tournaments/${tid}`))

  // The Entries sheet as the browser sends it (text cells, the sheet's row numbers)
  const pair = (row, l1, l2, extra = {}) => ({
    row, draw: 'A1', gender: 'Damen', seed: '', team: '', p1_last: l1, p1_first: `${l1}a`, p1_licence: `L-${l1}`, p1_country: 'SUI',
    p2_last: l2, p2_first: `${l2}b`, p2_licence: `L-${l2}`, p2_country: '', wildcard: '', ...extra
  })
  const FIRST = {
    entries: [
      pair(2, 'Muster', 'Beispiel', { seed: '1' }),
      pair(3, 'Keller', 'Frei', { seed: '2' }),
      pair(4, 'Huber', 'Meier', { seed: '3' }),
      pair(5, 'Graf', 'Roth', { seed: '4', wildcard: 'ja' }),
      pair(6, 'Weber', 'Wolf', { draw: 'B1', gender: 'Herren' })
    ]
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-bi-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-bi-status-'))
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
    await account('bea', { roles: ['beach:scorer'] })
    await account('ivan', { roles: ['scorer', 'competition_manager'] }) // indoor only
    const t = okData(await call(users.mia, 'POST', '/api/beach/tournaments', {
      title: `Import Cup ${tag}`, starts_on: '2026-07-11', ends_on: '2026-07-12', courts: 1, source: 'xlsx'
    }), 201).tournament
    assert.equal(t.source, 'xlsx')
    tid = t.id
    expectCode(await call(users.mia, 'POST', '/api/beach/tournaments', { title: 'X', starts_on: '2026-07-11', ends_on: '2026-07-11', source: 'swissvolley' }), 400)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('only the tournament\'s editors import', async () => {
    expectCode(await api(srv.base, `/api/beach/tournaments/${tid}/import?dryRun=1`, { body: FIRST, proto: null }), 401)
    expectCode(await preview(users.ivan, FIRST), 403, 'OV_FORBIDDEN')
    expectCode(await preview(users.bea, FIRST), 404, 'OV_NOT_FOUND') // a draft: not even readable
    expectCode(await preview(users.max, FIRST), 404, 'OV_NOT_FOUND')
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${tid}`, { status: 'published' }))
    expectCode(await preview(users.bea, FIRST), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.mia, 'GET', `/api/beach/tournaments/${tid}/import`), 405)
  })

  it('a preview writes nothing; the apply needs its hash', async () => {
    expectCode(await preview(users.mia, {}), 400, 'OV_INVALID_REQUEST')
    expectCode(await apply(users.mia, FIRST, 'nope'), 400, 'OV_INVALID_REQUEST')
    const p = okData(await preview(users.mia, FIRST))
    assert.match(p.hash, /^[0-9a-f]{64}$/)
    assert.equal(p.can_apply, true)
    assert.equal(p.summary.draws_new, 2)
    assert.equal(p.summary.entries_new, 5)
    assert.deepEqual(p.rows.entries.map((r) => [r.row, r.status, r.op]), [
      [2, 'ok', 'new'], [3, 'ok', 'new'], [4, 'ok', 'new'], [5, 'ok', 'new'], [6, 'ok', 'new']
    ])
    assert.equal((await bundle()).draws.length, 0, 'the preview wrote nothing')
    // another file under the preview's hash
    const other = { entries: FIRST.entries.slice(0, 4) }
    const r = await apply(users.mia, other, p.hash)
    expectCode(r, 409, 'OV_IMPORT_CHANGED')
    assert.equal(r.json.error.details.preview.summary.entries_new, 4)
    assert.equal((await bundle()).draws.length, 0)
    // the right one
    const done = okData(await apply(users.mia, FIRST, p.hash))
    assert.equal(done.applied.entries_new, 5)
    const b = await bundle()
    assert.deepEqual(b.draws.map((d) => [d.category, d.gender, d.status]), [['A1', 'women', 'seeded'], ['B1', 'men', 'entries']])
    // the file's order is kept by created_at (one transaction: not now(), whose ties fell to the random ids)
    const { rows: stamps } = await sql.query(
      `SELECT (SELECT count(DISTINCT created_at)::int FROM public.beach_draws WHERE tournament_id = $1) AS draws,
              (SELECT count(DISTINCT e.created_at)::int FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id WHERE d.tournament_id = $1) AS entries`, [tid])
    assert.deepEqual(stamps[0], { draws: 2, entries: 5 })
    const women = b.entries.filter((e) => e.draw_id === b.draws[0].id)
    assert.deepEqual(women.map((e) => [e.seed, e.name, e.wildcard]), [
      [1, 'Muster/Beispiel', false], [2, 'Keller/Frei', false], [3, 'Huber/Meier', false], [4, 'Graf/Roth', true]
    ])
    assert.deepEqual(women[0].player1, { first: 'Mustera', last: 'Muster', licence: 'L-Muster', country: 'SUI' })
    assert.deepEqual(women[0].player2, { first: 'Beispielb', last: 'Beispiel', licence: 'L-Beispiel', country: null })
  })

  it('the same file again changes nothing; the tournament changing after the preview is refused', async () => {
    const same = okData(await preview(users.mia, FIRST))
    assert.equal(same.can_apply, false)
    assert.equal(same.summary.entries_unchanged, 5)
    assert.deepEqual(okData(await apply(users.mia, FIRST, same.hash)).applied.entries_new, 0)

    const second = { entries: [pair(2, 'Muster', 'Beispiel', { team: 'Team Muster', seed: '1' }), ...FIRST.entries.slice(1, 3)] }
    const p = okData(await preview(users.mia, second))
    // meanwhile a co-organiser renames a pair in the console
    const b = await bundle()
    const keller = b.entries.find((e) => e.name === 'Keller/Frei')
    okData(await call(users.mia, 'PATCH', `/api/beach/entries/${keller.id}`, { name: 'Keller/Frei (Bern)' }))
    const r = await apply(users.mia, second, p.hash)
    expectCode(r, 409, 'OV_IMPORT_CHANGED')
    const fresh = r.json.error.details.preview
    assert.notEqual(fresh.hash, p.hash)
    // the file keeps the console's name (blank cell), so the fresh preview applies
    okData(await apply(users.mia, second, fresh.hash))
    const after = await bundle()
    const byName = new Map(after.entries.map((e) => [e.name, e]))
    assert.equal(byName.get('Team Muster').seed, 1)
    assert.equal(byName.get('Keller/Frei (Bern)').seed, 2)
    assert.equal(byName.get('Graf/Roth').status, 'withdrawn', 'missing from the file: withdrawn')
    assert.equal(byName.get('Graf/Roth').seed, null)
    assert.equal(byName.get('Weber/Wolf').status, 'registered', 'B1 was not in the file')
  })

  it('rows with errors are refused, and a saved pair is linked by both licences', async () => {
    const bad = { entries: [pair(2, 'Muster', 'Beispiel', { gender: 'Kids', p1_country: 'CH' })] }
    const p = okData(await preview(users.mia, bad))
    assert.equal(p.can_apply, false)
    assert.deepEqual(p.rows.entries[0].messages.map((m) => m.code).sort(), ['bad_country', 'bad_gender'])
    expectCode(await apply(users.mia, bad, p.hash), 400, 'OV_IMPORT_INVALID')
    // a NUL (Postgres refuses it) is a row error in the preview, never a 503 on the apply
    for (const nul of [{ p1_last: 'Mu\u0000ster' }, { team: 'Te\u0000am' }]) {
      const body = { entries: [pair(2, 'Muster', 'Beispiel', { draw: 'Z9', ...nul })] }
      const n = okData(await preview(users.mia, body))
      assert.equal(n.can_apply, false)
      assert.equal(n.rows.entries[0].status, 'error')
      assert.ok(n.rows.entries[0].messages.some((m) => m.code === 'bad_char'))
      expectCode(await apply(users.mia, body, n.hash), 400, 'OV_IMPORT_INVALID')
    }

    const comp = okData(await call(users.mia, 'POST', '/api/saved-teams/competitions', { name: `Pairs ${tag}`, season: '2026', sport: 'beach' }), 201)
    const team = okData(await call(users.mia, 'POST', '/api/saved-teams/teams', { competition_id: comp.competition?.id ?? comp.id, name: 'Graf/Roth' }), 201)
    const teamId = team.team?.id ?? team.id
    okData(await call(users.mia, 'PUT', `/api/saved-teams/teams/${teamId}/roster`, {
      players: [{ number: 1, first_name: 'Gina', last_name: 'Graf', license_number: 'L-Graf', country: 'SUI' },
        { number: 2, first_name: 'Rita', last_name: 'Roth', license_number: 'L-Roth', country: 'SUI' }],
      staff: []
    }))
    // Graf/Roth come back (re-registered, now linked to the saved pair); Lang/Kurz is new
    const third = {
      entries: [
        pair(2, 'Muster', 'Beispiel'), pair(3, 'Keller', 'Frei'), pair(4, 'Huber', 'Meier'),
        pair(5, 'Graf', 'Roth'), pair(6, 'Lang', 'Kurz')
      ]
    }
    const q = okData(await preview(users.mia, third))
    const graf = q.entries.find((e) => e.name === 'Graf/Roth')
    assert.deepEqual(graf.changes.map((c) => c.field), ['status', 'team_id'])
    assert.equal(graf.changes[1].to, teamId)
    okData(await apply(users.mia, third, q.hash))
    const b = await bundle()
    assert.equal(b.entries.find((e) => e.name === 'Graf/Roth').team_id, teamId)
    assert.equal(b.entries.find((e) => e.name === 'Lang/Kurz').seed, null)
  })

  it('a Matches sheet draws the bracket and sets the organiser\'s slots and officials', async () => {
    const plan = {
      matches: [
        { row: 2, draw: 'A1', gender: 'Damen', game: '1', date: '11.07.2026', time: '09:00', court: '1', team1: '4', team2: 'Lang/Kurz', referee: 'Rita Ref', scorer: 'Sam Score' },
        { row: 3, draw: 'A1', gender: 'Damen', game: '2', date: '11.07.2026', time: '09:00', court: '2' },
        { row: 4, draw: 'A1', gender: 'Damen', game: '4', date: '11.07.2026', time: '10:00', court: '1', phase: 'Hoffnungsrunde' }
      ]
    }
    const p = okData(await preview(users.mia, plan))
    const a1 = p.draws.find((d) => d.category === 'A1')
    assert.deepEqual(a1.bracket, { teams: 5, board_size: 8, first_game: 1, last_game: 8 })
    assert.equal(p.summary.courts_new, 1)
    assert.deepEqual(p.warnings.map((w) => w.code), ['seeds_assigned', 'too_few_teams'])
    // 5 pairs on a board of 8: W1 is seed 4 against seed 5 (Lang/Kurz), game 4 is L1
    assert.deepEqual(p.rows.matches.map((r) => [r.status, r.code]), [['ok', 'W1'], ['ok', 'W2'], ['ok', 'L1']])
    okData(await apply(users.mia, plan, p.hash))
    const b = await bundle()
    assert.deepEqual(b.courts.map((c) => c.number), [1, 2])
    const draw = b.draws.find((d) => d.category === 'A1')
    assert.equal(draw.status, 'drawn')
    const games = new Map(b.matches.map((m) => [m.game_n, m]))
    assert.equal(b.matches.length, 8)
    assert.equal(games.get(1).scheduled_at, '2026-07-11T07:00:00.000Z')
    assert.equal(games.get(1).court_id, b.courts[0].id)
    assert.equal(games.get(1).referee, 'Rita Ref')
    assert.equal(games.get(1).scorer, 'Sam Score')
    assert.equal(games.get(2).court_id, b.courts[1].id)
    // every registered pair has a seed 1..5 (Lang/Kurz took the next one)
    const seeds = b.entries.filter((e) => e.draw_id === draw.id && e.status === 'registered').map((e) => e.seed).sort()
    assert.deepEqual(seeds, [1, 2, 3, 4, 5])
    assert.equal(b.entries.find((e) => e.name === 'Lang/Kurz').seed, 5)

    // the bracket is drawn: a new pair is now an error, a slot move is not
    const late = okData(await preview(users.mia, { entries: [...[2, 3, 4, 5, 6].map((r, i) => pair(r, ...[['Muster', 'Beispiel'], ['Keller', 'Frei'], ['Huber', 'Meier'], ['Roth', 'Graf'], ['Lang', 'Kurz']][i])), pair(7, 'Neu', 'Spät')] }))
    assert.deepEqual(late.rows.entries.at(-1).messages.map((m) => m.code), ['draw_drawn'])
    const move = okData(await preview(users.mia, { matches: [{ row: 2, game: '2', court: '1', date: '11.07.2026', time: '09:00' }] }))
    assert.deepEqual(move.rows.matches[0].messages.map((m) => [m.code, m.reason]), [['slot_conflict', 'court']])
    assert.equal(move.can_apply, true)

    const audit = okData(await call(users.admin, 'GET', '/api/admin/audit?app=beach&limit=200')).entries
    const imports = audit.filter((e) => e.action === 'tournament.import')
    assert.equal(imports.length, 4)
    assert.ok(imports.every((e) => e.app === 'beach' && e.details.tournament_id === tid))
    assert.equal(imports[0].details.brackets, 1)
    assert.equal(JSON.stringify(imports).includes('L-Muster'), false, 'no licence in the audit')
  })
})
