/**
 * Referees' dates of birth (referee_database.dob, svrz_games.referee_1_dob /
 * referee_2_dob) go only to the accounts that fill a scoresheet's officials:
 * admins and accounts that can score (referee_database: indoor or beach;
 * svrz_games, the indoor schedule: indoor). Every other reader, signed in or
 * not, gets the anonymous projection (lib/publicColumns.js ANON_DB_COLUMNS)
 * and cannot filter or order on the hidden columns. Covers /api/db selects
 * (the app screens' own queries), the rows a referee directory write returns,
 * the referees such an account adds (no date of birth stored), GET
 * /api/games/today, the live sockets, and a failed role lookup (503).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'

const MINOR_DOB = '2010-03-04'
const ADULT_DOB = '1975-08-09'
const BEACH_DOB = '1988-02-03'
const ALL_DOBS = [MINOR_DOB, ADULT_DOB, BEACH_DOB]
const day = (v) => (v == null ? v : String(v).slice(0, 10))
// No date of birth anywhere in the answer, under any key
const noDob = (r) => !ALL_DOBS.some((d) => r.text.includes(d))

describe('referees\' dates of birth only for the roles that fill the sheet', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  const today = zurichDay()

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })

  // The app screens' own requests (frontend/src and OpenBeach's src_beach)
  const pickerQuery = (sport) => ({
    // RefereeSelector / useOfficialHistory through selectAll (keyset on id)
    columns: 'id, first_name, last_name, country, dob, created_at',
    filters: [{ type: 'contains', column: 'sport_type', value: JSON.stringify([sport]) }],
    order: [{ column: 'id', ascending: true }],
    limit: 1000
  })
  // LoadOfficialMatchModal fetchMatchesFromSupabase
  const loaderQuery = {
    columns: '*',
    filters: [{ type: 'eq', column: 'gender', value: 'men' }, { type: 'eq', column: 'league', value: 'H9' }, { type: 'gte', column: 'datetime', value: '2000-01-01' }],
    order: [{ column: 'datetime', ascending: true }]
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.referee_database (first_name, last_name, country, dob, sport_type) VALUES
      ('Mia', 'Zzminor', 'CHE', $1, '["indoor"]'::json),
      ('Rolf', 'Zzadult', 'CHE', $2, '["indoor"]'::json),
      ('Sina', 'Zzbeach', 'CHE', $3, '["beach"]'::json)`, [MINOR_DOB, ADULT_DOB, BEACH_DOB])
    await sql.query(`INSERT INTO public.svrz_games (game_number, datetime, league, gender, team_home, team_away,
      referee_1_first_name, referee_1_last_name, referee_1_dob, referee_2_first_name, referee_2_last_name, referee_2_dob) VALUES
      ('940001', '2099-01-01T18:00:00', 'H9', 'men', 'VBC Testdorf H1', 'VBC Other H1', 'Mia', 'Zzminor', $1, 'Rolf', 'Zzadult', $2),
      ('940002', '${today}T18:00:00', 'H9', 'men', 'VBC Testdorf H1', 'VBC Third H1', 'Mia', 'Zzminor', $1, 'Rolf', 'Zzadult', $2)`, [MINOR_DOB, ADULT_DOB])
    await account('pending') // sign-up: no role
    await account('manager', ['competition_manager'])
    await account('referee', ['referee'])
    await account('beachScorer', ['beach:scorer'])
    await account('scorer', ['scorer'])
    await account('admin', ['admin'])
    // Club members: a scorer and a referee of the home team's club (club invites)
    const call = (method, path, body) => api(srv.base, path, { method, token: users.admin.token, body })
    const club = (await call('POST', '/api/admin/clubs', { name: 'VBC Testdorf', teams: ['VBC Testdorf H1'] })).json.data.club
    for (const u of [users.scorer, users.referee]) {
      assert.equal((await call('PUT', `/api/admin/accounts/${u.id}/clubs`, { club_ids: [club.id] })).status, 200)
    }
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('an account without a role reads the directory and the schedule like an anonymous reader', async () => {
    for (const sport of ['indoor', 'beach']) {
      const r = await dbCall(users.pending, 'referee_database', 'select', pickerQuery(sport))
      assert.equal(r.status, 200, r.text)
      assert.ok(noDob(r), r.text.slice(0, 300))
      assert.ok(r.json.data.length > 0 && r.json.data.every((row) => !('dob' in row) && row.last_name), 'names stay, dob goes')
    }
    const star = await dbCall(users.pending, 'referee_database', 'select', { columns: '*' })
    assert.equal(star.status, 200, star.text)
    assert.ok(noDob(star), star.text.slice(0, 300))
    assert.deepEqual(star.json.data.map((row) => row.last_name).sort(), ['Zzadult', 'Zzbeach', 'Zzminor'])

    const games = await dbCall(users.pending, 'svrz_games', 'select', loaderQuery)
    assert.equal(games.status, 200, games.text)
    assert.ok(noDob(games), games.text.slice(0, 300))
    const g = games.json.data.find((row) => row.game_number === '940001')
    assert.equal(g.referee_1_last_name, 'Zzminor')
    assert.ok(!('referee_1_dob' in g) && !('referee_2_dob' in g))
  })

  it('an account without a role cannot filter or order on a date of birth', async () => {
    for (const [table, params] of [
      ['referee_database', { columns: 'id, last_name', filters: [{ type: 'gte', column: 'dob', value: '2008-01-01' }] }],
      ['referee_database', { columns: 'id, last_name', order: [{ column: 'dob', ascending: false }], limit: 1 }],
      ['referee_database', { columns: 'id', filters: [{ type: 'eq', column: 'dob', value: MINOR_DOB }], head: true, count: 'exact' }],
      ['svrz_games', { columns: 'id, game_number', filters: [{ type: 'eq', column: 'referee_1_dob', value: MINOR_DOB }] }],
      ['svrz_games', { columns: 'id', order: { column: 'referee_2_dob', ascending: true } }]
    ]) {
      const r = await dbCall(users.pending, table, 'select', params)
      assert.equal(r.status, 400, `${table} ${JSON.stringify(params)}: ${r.text}`)
      assert.equal(r.json.error.code, 'OV_SECRET_FILTER')
    }
  })

  it('a referee directory write by an account without a role does not return dates of birth', async () => {
    const id = (await sql.query("SELECT id FROM public.referee_database WHERE last_name = 'Zzminor'")).rows[0].id
    // Match setup's saveReferee: add the sport to an existing referee
    const upd = await dbCall(users.pending, 'referee_database', 'update', {
      data: { sport_type: ['indoor'] }, filters: [{ type: 'eq', column: 'id', value: id }], returning: '*'
    })
    assert.equal(upd.status, 200, upd.text)
    assert.ok(noDob(upd), upd.text.slice(0, 300))
    assert.equal(upd.json.data[0].last_name, 'Zzminor')
    assert.ok(!('dob' in upd.json.data[0]))
    // A scorer's write returns the whole row
    const mine = await dbCall(users.scorer, 'referee_database', 'update', {
      data: { sport_type: ['indoor'] }, filters: [{ type: 'eq', column: 'id', value: id }], returning: '*'
    })
    assert.equal(mine.status, 200, mine.text)
    assert.equal(day(mine.json.data[0].dob), MINOR_DOB)
  })

  it('competition managers and referees do not get them either', async () => {
    for (const name of ['manager', 'referee']) {
      const refs = await dbCall(users[name], 'referee_database', 'select', pickerQuery('indoor'))
      assert.equal(refs.status, 200, refs.text)
      assert.ok(noDob(refs), `${name}: ${refs.text.slice(0, 300)}`)
      const games = await dbCall(users[name], 'svrz_games', 'select', loaderQuery)
      assert.equal(games.status, 200, games.text)
      assert.ok(noDob(games), `${name}: ${games.text.slice(0, 300)}`)
      const probe = await dbCall(users[name], 'referee_database', 'select', { columns: 'id', filters: [{ type: 'gte', column: 'dob', value: '2008-01-01' }] })
      assert.equal(probe.status, 400, probe.text)
      // The saved team screens' schedule reads need no hidden column
      const leagues = await dbCall(users[name], 'svrz_games', 'select', { columns: 'id, league, gender' })
      assert.equal(leagues.status, 200, leagues.text)
      const teams = await dbCall(users[name], 'svrz_games', 'select', { columns: 'id, team_home, team_away', filters: [{ type: 'in', column: 'league', value: ['H9'] }] })
      assert.equal(teams.status, 200, teams.text)
      assert.ok(teams.json.data.some((row) => row.team_home === 'VBC Testdorf H1'))
    }
  })

  it('an indoor scorer and an admin read them, and may filter on them', async () => {
    for (const name of ['scorer', 'admin']) {
      const refs = await dbCall(users[name], 'referee_database', 'select', pickerQuery('indoor'))
      assert.equal(refs.status, 200, refs.text)
      assert.equal(day(refs.json.data.find((row) => row.last_name === 'Zzminor').dob), MINOR_DOB, name)
      const games = await dbCall(users[name], 'svrz_games', 'select', loaderQuery)
      assert.equal(games.status, 200, games.text)
      const g = games.json.data.find((row) => row.game_number === '940001')
      assert.equal(day(g.referee_1_dob), MINOR_DOB, name)
      assert.equal(day(g.referee_2_dob), ADULT_DOB, name)
      const filtered = await dbCall(users[name], 'referee_database', 'select', { columns: 'last_name', filters: [{ type: 'eq', column: 'dob', value: ADULT_DOB }] })
      assert.equal(filtered.status, 200, filtered.text)
      assert.deepEqual(filtered.json.data.map((row) => row.last_name), ['Zzadult'])
    }
  })

  it('a beach scorer reads the directory\'s dates of birth (OpenBeach\'s picker), not the indoor schedule\'s', async () => {
    const refs = await dbCall(users.beachScorer, 'referee_database', 'select', pickerQuery('beach'))
    assert.equal(refs.status, 200, refs.text)
    assert.equal(day(refs.json.data.find((row) => row.last_name === 'Zzbeach').dob), BEACH_DOB)
    const games = await dbCall(users.beachScorer, 'svrz_games', 'select', loaderQuery)
    assert.equal(games.status, 200, games.text)
    assert.ok(noDob(games), games.text.slice(0, 300))
  })

  it('today\'s home games carry the referees\' dates of birth for a scorer of the club only', async () => {
    const mine = await api(srv.base, '/api/games/today', { method: 'GET', proto: null, token: users.scorer.token })
    assert.equal(mine.status, 200, mine.text)
    const g = mine.json.data.games.find((row) => row.game_number === '940002')
    assert.equal(day(g.referee_1_dob), MINOR_DOB)
    assert.equal(day(g.referee_2_dob), ADULT_DOB)
    const ref = await api(srv.base, '/api/games/today', { method: 'GET', proto: null, token: users.referee.token })
    assert.equal(ref.status, 200, ref.text)
    const rg = ref.json.data.games.find((row) => row.game_number === '940002')
    assert.equal(rg.referee_1_last_name, 'Zzminor', 'the rest of the game stays')
    assert.equal(rg.referee_1_dob, null)
    assert.equal(rg.referee_2_dob, null)
    assert.ok(noDob(ref), ref.text.slice(0, 300))
  })

  it('a referee added by an account without a role is stored without its date of birth, so the answer never depends on a stored one', async () => {
    // A unique key over the name and the date of birth (the production
    // directory has a unique index; its columns are not in the repository)
    await sql.query('CREATE UNIQUE INDEX test_referee_name_dob ON public.referee_database (first_name, last_name, dob)')
    try {
      const add = (user, row, extra = {}) => dbCall(user, 'referee_database', 'insert', {
        data: { country: 'CHE', sport_type: ['indoor'], created_at: new Date().toISOString(), ...row }, ...extra
      })
      // The same referee with a wrong and with the stored date of birth
      const wrong = await add(users.pending, { first_name: 'Rolf', last_name: 'Zzadult', dob: '1975-08-10' })
      const right = await add(users.pending, { first_name: 'Rolf', last_name: 'Zzadult', dob: ADULT_DOB })
      assert.equal(wrong.status, 200, wrong.text)
      assert.equal(right.status, 200, right.text)
      assert.deepEqual(right.json, wrong.json, 'the same answer either way')
      const stored = (await sql.query("SELECT dob::text AS dob FROM public.referee_database WHERE last_name = 'Zzadult' ORDER BY dob NULLS LAST")).rows
      assert.deepEqual(stored.map((row) => row.dob), [ADULT_DOB, null, null], 'only the earlier row has a date of birth')
      // With returning: the public columns of the new row
      const back = await add(users.manager, { first_name: 'Lena', last_name: 'Zzreturned', dob: '1991-04-05' }, { returning: '*' })
      assert.equal(back.status, 200, back.text)
      assert.equal(back.json.data[0].last_name, 'Zzreturned')
      assert.ok(!('dob' in back.json.data[0]), back.text)
      // A scorer's new referee keeps its date of birth
      const mine = await add(users.scorer, { first_name: 'Nora', last_name: 'Zzscorer', dob: '1992-06-07' })
      assert.equal(mine.status, 200, mine.text)
      const kept = (await sql.query("SELECT dob::text AS dob FROM public.referee_database WHERE last_name = 'Zzscorer'")).rows
      assert.deepEqual(kept.map((row) => row.dob), ['1992-06-07'])
    } finally {
      await sql.query("DELETE FROM public.referee_database WHERE (last_name = 'Zzadult' AND dob IS NULL) OR last_name IN ('Zzreturned', 'Zzscorer')")
      await sql.query('DROP INDEX IF EXISTS public.test_referee_name_dob')
    }
  })

  it('live sockets cannot subscribe to the referee tables', async () => {
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      for (const table of ['referee_database', 'svrz_games']) {
        const id = `ch-${table}`
        live.send({ type: 'subscribe-db', id, subs: [{ table, event: '*', column: 'external_id', value: 'x' }] })
        const ack = await live.waitFor((m) => (m.type === 'subscribe-db-ack' || m.type === 'subscribe-db-error') && m.id === id, 5000, `ack ${id}`)
        assert.equal(ack.type, 'subscribe-db-error', JSON.stringify(ack))
      }
    } finally {
      live.ws.close()
    }
  })

  it('when the roles cannot be read, a scorer gets 503, never the cut-down row; public columns need no lookup', async () => {
    // New scorers: nothing of theirs is in the access cache (30 s) yet
    const reader = await account('lateReader', ['scorer'])
    const writer = await account('lateWriter', ['scorer'])
    await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles TO roles_unreadable')
    try {
      const pub = await dbCall(reader, 'referee_database', 'select', { columns: 'id, last_name' })
      assert.equal(pub.status, 200, pub.text)
      assert.ok(pub.json.data.some((row) => row.last_name === 'Zzminor'))
      for (const [table, params] of [['referee_database', pickerQuery('indoor')], ['svrz_games', loaderQuery]]) {
        const r = await dbCall(reader, table, 'select', params)
        assert.equal(r.status, 503, `${table}: ${r.text}`)
        assert.equal(r.json.error.code, 'OV_DB_UNAVAILABLE')
        assert.equal(r.json.data, null)
      }
      // A new referee is neither stored without its date of birth nor at all
      const add = await dbCall(writer, 'referee_database', 'insert', {
        data: { first_name: 'Ida', last_name: 'Zzlate', country: 'CHE', dob: '1993-08-09', sport_type: ['indoor'] }
      })
      assert.equal(add.status, 503, add.text)
      assert.equal(add.json.error.code, 'OV_DB_UNAVAILABLE')
      assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.referee_database WHERE last_name = 'Zzlate'")).rows[0].n, 0)
    } finally {
      await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles_unreadable TO roles')
    }
  })
})
