/**
 * PERM-09 (audit round 3), owner decision 5, through server.js:
 *   1. a beach scorer reads only the saved pairs of its own tournaments (a
 *      published or live tournament of which it claimed a match, or whose
 *      scored match it recorded or edits); before, every beach scorer read
 *      every saved pair with its licence numbers (poc/beach/saved-pairs-read.sh)
 *   2. a beach competition manager changes or deletes only the beach
 *      competitions it owns (competitions.created_by, db/055), their teams
 *      and rosters; before, any one deleted another organiser's competition
 *   3. it reopens only a beach match it manages (of a tournament it edits,
 *      or one it recorded or edits)
 * The admins keep everything; indoor is unchanged (scorerAccounts.e2e.test.js).
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js).
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

describe('saved beach pairs and beach competitions: own only (PERM-09, owner decision 5)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const tag = randomBytes(3).toString('hex')
  const ids = {}

  async function account (name, roles) {
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
    await grantRoles(sql, u.id, roles)
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
  const pairsOf = async (user, sport = 'beach') => okData(await get(user, `/api/saved-teams?sport=${sport}`)).teams
    .filter((t) => t.sport === 'beach')
    .map((t) => [t.name, t.players.map((p) => p.license_number)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  /** A beach match recorded by `user` (as OpenBeach writes it through /api/db). */
  async function beachMatch (user, n) {
    const r = await api(srv.base, '/api/db', {
      token: user.token,
      proto: '2',
      body: { table: 'matches', action: 'insert', params: { data: { external_id: `bs_${tag}_${n}`, sport_type: 'beach', status: 'live', game_n: n }, returning: 'id', single: true } }
    })
    assert.equal(r.status, 200, r.text)
    return r.json.data.id
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-bscope-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-bscope-status-'))
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
    await account('admin', ['admin'])
    await account('mia', ['beach:competition_manager']) // the organiser and owner
    await account('max', ['beach:competition_manager']) // another organiser
    await account('bea', ['beach:scorer']) // a court tablet of mia's tournament
    await account('bo', ['beach:scorer']) // scores mia's match on its own tablet
    await account('eve', ['beach:scorer']) // no tournament of hers
    await account('duo', ['scorer', 'beach:scorer']) // both sports, no beach tournament

    // mia's saved pairs (with licences) and a tournament with the first one entered
    const comp = okData(await call(users.mia, 'POST', '/api/saved-teams/competitions', { name: `Tour ${tag}`, season: '2026', sport: 'beach' }), 201).competition
    ids.comp = comp.id
    const pair = async (name, a, b) => {
      const team = okData(await call(users.mia, 'POST', '/api/saved-teams/teams', { competition_id: comp.id, name }), 201).team
      okData(await call(users.mia, 'PUT', `/api/saved-teams/teams/${team.id}/roster`, {
        players: [{ number: 1, first_name: 'Anna', last_name: name.split('/')[0], license_number: a, country: 'SUI' },
          { number: 2, first_name: 'Bea', last_name: name.split('/')[1], license_number: b, country: 'SUI' }],
        staff: []
      }))
      return team.id
    }
    ids.pairIn = await pair('Muster/Beispiel', '770011', '770012')
    ids.pairOut = await pair('Rossi/Bianchi', '770021', '770022')
    const t = okData(await call(users.mia, 'POST', '/api/beach/tournaments', { title: `Scope Open ${tag}`, starts_on: '2026-07-11', ends_on: '2026-07-11', courts: 1 }), 201).tournament
    ids.t = t.id
    const d = okData(await call(users.mia, 'POST', `/api/beach/tournaments/${t.id}/draws`, { gender: 'women', category: 'A1' }), 201).draw
    okData(await call(users.mia, 'POST', `/api/beach/draws/${d.id}/entries`, { team_id: ids.pairIn }), 201)
    for (let i = 0; i < 3; i++) okData(await call(users.mia, 'POST', `/api/beach/draws/${d.id}/entries`, { player1: { last: `T${i}` }, player2: { last: `U${i}` } }), 201)
    okData(await call(users.mia, 'POST', `/api/beach/draws/${d.id}/generate`, {}))
    const { rows } = await sql.query('SELECT id FROM public.beach_tmatches WHERE tournament_id = $1 ORDER BY game_n', [t.id])
    ids.tm = rows.map((r) => r.id)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('a beach scorer reads the saved pairs of its own tournaments only; managers and admins read every pair', async () => {
    const all = [['Muster/Beispiel', ['770011', '770012']], ['Rossi/Bianchi', ['770021', '770022']]]
    for (const u of [users.mia, users.max, users.admin]) assert.deepEqual(await pairsOf(u), all)
    // nobody's own tournament yet (a draft, nothing claimed or linked)
    for (const u of [users.bea, users.bo, users.eve, users.duo]) assert.deepEqual(await pairsOf(u), [])
    // court tablets (db/014 claimed_by, phase T3) and a scored match linked to the tournament
    await sql.query('UPDATE public.beach_tmatches SET claimed_by = $2 WHERE id = $1', [ids.tm[0], users.bea.id])
    ids.boMatch = await beachMatch(users.bo, 1)
    await sql.query('UPDATE public.beach_tmatches SET match_id = $2 WHERE id = $1', [ids.tm[1], ids.boMatch])
    // a draft tournament is nobody's yet
    for (const u of [users.bea, users.bo]) assert.deepEqual(await pairsOf(u), [])
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { status: 'published' }))
    const own = [['Muster/Beispiel', ['770011', '770012']]]
    assert.deepEqual(await pairsOf(users.bea), own, 'the pairs of the tournament it claimed a match of')
    assert.deepEqual(await pairsOf(users.bo), own, 'the pairs of the tournament of its scored match')
    assert.deepEqual(await pairsOf(users.bea, 'all'), own)
    for (const u of [users.eve, users.duo]) assert.deepEqual(await pairsOf(u), [])
    // the competition of an own pair comes along; none other
    const forBea = okData(await get(users.bea, '/api/saved-teams?sport=beach'))
    assert.deepEqual(forBea.competitions.map((c) => c.id), [ids.comp])
    assert.equal(JSON.stringify(forBea).includes('770021'), false, 'never another pair\'s licence')
    // an archived competition and a finished tournament are no longer read
    okData(await call(users.mia, 'PATCH', `/api/saved-teams/competitions/${ids.comp}`, { archived: true }))
    assert.deepEqual(await pairsOf(users.bea), [])
    okData(await call(users.mia, 'PATCH', `/api/saved-teams/competitions/${ids.comp}`, { archived: false }))
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { status: 'finished' }))
    assert.deepEqual(await pairsOf(users.bea), [])
    okData(await call(users.mia, 'PATCH', `/api/beach/tournaments/${ids.t}`, { status: 'live' }))
    assert.deepEqual(await pairsOf(users.bea), own)
  })

  it('a beach competition manager changes, fills or deletes only its own beach competitions; the admin every one', async () => {
    const team = ids.pairOut
    const refused = [
      ['PATCH', `/api/saved-teams/competitions/${ids.comp}`, { name: 'Taken over' }],
      ['DELETE', `/api/saved-teams/competitions/${ids.comp}?confirm=${encodeURIComponent(`Tour ${tag}`)}`],
      ['POST', '/api/saved-teams/teams', { competition_id: ids.comp, name: 'Intruder/Pair' }],
      ['PATCH', `/api/saved-teams/teams/${team}`, { short_name: 'XX' }],
      ['PUT', `/api/saved-teams/teams/${team}/roster`, { players: [], staff: [] }],
      ['DELETE', `/api/saved-teams/teams/${team}?confirm=${encodeURIComponent('Rossi/Bianchi')}`]
    ]
    for (const [method, path, body] of refused) expectCode(await call(users.max, method, path, body), 403, 'OV_FORBIDDEN')
    assert.deepEqual(await pairsOf(users.mia), [['Muster/Beispiel', ['770011', '770012']], ['Rossi/Bianchi', ['770021', '770022']]], 'nothing changed')
    // its own competition: everything
    const mine = okData(await call(users.max, 'POST', '/api/saved-teams/competitions', { name: `Max Tour ${tag}`, season: '2026', sport: 'beach' }), 201).competition
    const t = okData(await call(users.max, 'POST', '/api/saved-teams/teams', { competition_id: mine.id, name: 'Own/Pair' }), 201).team
    okData(await call(users.max, 'PATCH', `/api/saved-teams/teams/${t.id}`, { short_name: 'OP' }))
    okData(await call(users.max, 'PATCH', `/api/saved-teams/competitions/${mine.id}`, { name: `Max Tour 2 ${tag}` }))
    // ... which mia cannot touch either; an unknown one is still 404
    expectCode(await call(users.mia, 'DELETE', `/api/saved-teams/teams/${t.id}?confirm=Own%2FPair`), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.max, 'DELETE', '/api/saved-teams/competitions/00000000-0000-4000-8000-000000000999'), 404, 'OV_NOT_FOUND')
    // the admin changes every one
    okData(await call(users.admin, 'PATCH', `/api/saved-teams/teams/${team}`, { short_name: 'RB' }))
    okData(await call(users.admin, 'DELETE', `/api/saved-teams/teams/${t.id}?confirm=Own%2FPair`))
    // a competition whose owner's account is gone (created_by NULL) stays open to the beach managers (db/055 default)
    await sql.query('UPDATE public.competitions SET created_by = NULL WHERE id = $1', [mine.id])
    okData(await call(users.mia, 'PATCH', `/api/saved-teams/competitions/${mine.id}`, { name: `Orphan Tour ${tag}` }))
    okData(await call(users.mia, 'DELETE', `/api/saved-teams/competitions/${mine.id}`))
  })

  it('a beach competition manager reopens only a beach match it manages; the admin every one', async () => {
    const reopen = (user, id) => call(user, 'POST', `/api/admin/matches/${id}/reopen`, { reason: 'Wrong pair' })
    // bo's match is linked to mia's tournament
    await sql.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [ids.boMatch])
    expectCode(await reopen(users.max, ids.boMatch), 403, 'OV_FORBIDDEN')
    expectCode(await reopen(users.bo, ids.boMatch), 403, 'OV_FORBIDDEN')
    const { rows: [still] } = await sql.query('SELECT closed_at FROM public.matches WHERE id = $1', [ids.boMatch])
    assert.ok(still.closed_at, 'still closed')
    okData(await reopen(users.mia, ids.boMatch))
    // a co-manager (an accepted invitation) manages it too
    await sql.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [ids.boMatch])
    okData(await call(users.mia, 'POST', `/api/beach/tournaments/${ids.t}/managers`, { email: users.max.email }))
    const [inv] = okData(await get(users.max, '/api/beach/invites')).invites
    okData(await call(users.max, 'POST', `/api/beach/invites/${inv.id}/accept`, {}))
    okData(await reopen(users.max, ids.boMatch))
    // a beach match of no tournament of theirs: the admin only
    const loose = await beachMatch(users.eve, 2)
    await sql.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [loose])
    for (const u of [users.mia, users.max]) expectCode(await reopen(u, loose), 403, 'OV_FORBIDDEN')
    okData(await reopen(users.admin, loose))
    // an unknown match is 404 (not 403)
    expectCode(await reopen(users.mia, '00000000-0000-4000-8000-000000000999'), 404, 'OV_NOT_FOUND')
  })
})
