/**
 * No referee's date of birth since db/048 (owner 2026-11-19): db/049 dropped
 * referee_database.dob and svrz_games.referee_1_dob / referee_2_dob, but
 * installed apps still select them, so /api/db answers them as null for every
 * caller (pgQuery nullColumns), takes no filter or order on them (400
 * OV_DOB_FILTER) and stores none (WRITE_DENYLIST, nullColumns); GET
 * /api/games/today has none. An older app's dates of birth (a referee it
 * adds) never come out either.
 * The directory itself stays for the accounts that fill a scoresheet's
 * officials (admins, indoor and beach scorers): 401 without a session, 403
 * otherwise. Covers the app screens' own queries, the rows a directory write
 * returns, the referees a scorer adds, the live sockets and a failed role
 * lookup (503).
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
// No date of birth anywhere in the answer, under any key
const noDob = (r) => !ALL_DOBS.some((d) => r.text.includes(d))

describe('the referee directory and the schedule: no dates of birth (db/048)', { skip: SKIP }, () => {
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
    await sql.query(`INSERT INTO public.referee_database (first_name, last_name, country, sport_type) VALUES
      ('Mia', 'Zzminor', 'CHE', '["indoor"]'::json),
      ('Rolf', 'Zzadult', 'CHE', '["indoor"]'::json),
      ('Sina', 'Zzbeach', 'CHE', '["beach"]'::json)`)
    await sql.query(`INSERT INTO public.svrz_games (game_number, datetime, league, gender, team_home, team_away,
      referee_1_first_name, referee_1_last_name, referee_2_first_name, referee_2_last_name) VALUES
      ('940001', '2099-01-01T18:00:00', 'H9', 'men', 'VBC Testdorf H1', 'VBC Other H1', 'Mia', 'Zzminor', 'Rolf', 'Zzadult'),
      ('940002', '${today}T18:00:00', 'H9', 'men', 'VBC Testdorf H1', 'VBC Third H1', 'Mia', 'Zzminor', 'Rolf', 'Zzadult')`)
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

  // The directory, refused: not even the names (Match setup's picker is for
  // the official match of a scorer; test and easy matches have none)
  const refusedDirectory = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json.error.code, code)
    assert.equal(r.json.data, null)
    assert.ok(!/Zzminor|Zzadult|Zzbeach/.test(r.text), r.text.slice(0, 300))
  }
  const dobFilterRefused = (r) => {
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error.code, 'OV_DOB_FILTER')
    assert.ok(noDob(r), r.text.slice(0, 300))
  }

  it('without a session the directory is refused', async () => {
    for (const params of [pickerQuery('indoor'), pickerQuery('beach'), { columns: 'id, last_name' }, { columns: '*' }]) {
      refusedDirectory(await dbCall(null, 'referee_database', 'select', params), 401, 'OV_SIGN_IN_REQUIRED')
    }
    // the schedule's public columns, as before
    const games = await dbCall(null, 'svrz_games', 'select', loaderQuery)
    assert.equal(games.status, 200, games.text)
    assert.ok(noDob(games), games.text.slice(0, 300))
  })

  it('an account without a role is refused the directory and reads the schedule without dates of birth', async () => {
    for (const params of [pickerQuery('indoor'), pickerQuery('beach'), { columns: 'id, last_name' }, { columns: '*' }]) {
      refusedDirectory(await dbCall(users.pending, 'referee_database', 'select', params), 403, 'OV_REFEREE_DIRECTORY')
    }
    const games = await dbCall(users.pending, 'svrz_games', 'select', loaderQuery)
    assert.equal(games.status, 200, games.text)
    assert.ok(noDob(games), games.text.slice(0, 300))
    const g = games.json.data.find((row) => row.game_number === '940001')
    assert.equal(g.referee_1_last_name, 'Zzminor')
    assert.ok(g.referee_1_dob == null && g.referee_2_dob == null)
  })

  it('nobody filters or orders on a date of birth, an admin neither', async () => {
    for (const name of ['pending', 'manager', 'scorer', 'beachScorer', 'admin']) {
      for (const params of [
        { columns: 'id, last_name', filters: [{ type: 'gte', column: 'dob', value: '2008-01-01' }] },
        { columns: 'id, last_name', order: [{ column: 'dob', ascending: false }], limit: 1 },
        { columns: 'id', filters: [{ type: 'eq', column: 'dob', value: MINOR_DOB }], head: true, count: 'exact' }
      ]) dobFilterRefused(await dbCall(users[name], 'referee_database', 'select', params))
      dobFilterRefused(await dbCall(users[name], 'svrz_games', 'select', { columns: 'id, game_number', filters: [{ type: 'eq', column: 'referee_1_dob', value: MINOR_DOB }] }))
      dobFilterRefused(await dbCall(users[name], 'svrz_games', 'select', { columns: 'id', order: { column: 'referee_2_dob', ascending: true } }))
      dobFilterRefused(await dbCall(users[name], 'profiles', 'select', { columns: 'id', filters: [{ type: 'eq', column: 'dob', value: MINOR_DOB }] }))
    }
    dobFilterRefused(await dbCall(null, 'svrz_games', 'select', { columns: 'id', filters: [{ type: 'eq', column: 'referee_1_dob', value: MINOR_DOB }] }))
  })

  it('a referee directory write by an account that does not score is refused; a scorer\'s returns no date of birth', async () => {
    const id = (await sql.query("SELECT id FROM public.referee_database WHERE last_name = 'Zzminor'")).rows[0].id
    // Match setup's saveReferee: add the sport to an existing referee
    for (const name of ['pending', 'manager', 'referee']) {
      const upd = await dbCall(users[name], 'referee_database', 'update', {
        data: { sport_type: ['indoor'] }, filters: [{ type: 'eq', column: 'id', value: id }], returning: '*'
      })
      assert.equal(upd.status, 403, `${name}: ${upd.text}`)
      assert.ok(noDob(upd), upd.text.slice(0, 300))
    }
    const mine = await dbCall(users.scorer, 'referee_database', 'update', {
      data: { sport_type: ['indoor'] }, filters: [{ type: 'eq', column: 'id', value: id }], returning: '*'
    })
    assert.equal(mine.status, 200, mine.text)
    assert.equal(mine.json.data[0].last_name, 'Zzminor')
    assert.equal(mine.json.data[0].dob, null)
    assert.ok(noDob(mine), mine.text.slice(0, 300))
  })

  it('competition managers and referees: no directory; the schedule without dates of birth', async () => {
    for (const name of ['manager', 'referee']) {
      refusedDirectory(await dbCall(users[name], 'referee_database', 'select', pickerQuery('indoor')), 403, 'OV_REFEREE_DIRECTORY')
      const games = await dbCall(users[name], 'svrz_games', 'select', loaderQuery)
      assert.equal(games.status, 200, games.text)
      assert.ok(noDob(games), `${name}: ${games.text.slice(0, 300)}`)
      // The saved team screens' schedule reads
      const leagues = await dbCall(users[name], 'svrz_games', 'select', { columns: 'id, league, gender' })
      assert.equal(leagues.status, 200, leagues.text)
      const teams = await dbCall(users[name], 'svrz_games', 'select', { columns: 'id, team_home, team_away', filters: [{ type: 'in', column: 'league', value: ['H9'] }] })
      assert.equal(teams.status, 200, teams.text)
      assert.ok(teams.json.data.some((row) => row.team_home === 'VBC Testdorf H1'))
    }
  })

  it('an indoor scorer, a beach scorer and an admin read the directory, without dates of birth', async () => {
    for (const [name, sport, last] of [['scorer', 'indoor', 'Zzminor'], ['admin', 'indoor', 'Zzadult'], ['beachScorer', 'beach', 'Zzbeach']]) {
      const refs = await dbCall(users[name], 'referee_database', 'select', pickerQuery(sport))
      assert.equal(refs.status, 200, refs.text)
      const row = refs.json.data.find((r) => r.last_name === last)
      assert.ok(row, name)
      assert.equal(row.dob, null, name)
      assert.ok(noDob(refs), `${name}: ${refs.text.slice(0, 300)}`)
      const games = await dbCall(users[name], 'svrz_games', 'select', loaderQuery)
      assert.equal(games.status, 200, games.text)
      assert.ok(noDob(games), `${name}: ${games.text.slice(0, 300)}`)
      const g = games.json.data.find((r) => r.game_number === '940001')
      assert.deepEqual([g.referee_1_last_name, g.referee_1_dob, g.referee_2_dob], ['Zzminor', null, null])
    }
  })

  it('today\'s home games carry no referee\'s date of birth, for a scorer of the club neither', async () => {
    for (const name of ['scorer', 'referee']) {
      const r = await api(srv.base, '/api/games/today', { method: 'GET', proto: null, token: users[name].token })
      assert.equal(r.status, 200, r.text)
      const g = r.json.data.games.find((row) => row.game_number === '940002')
      assert.equal(g.referee_1_last_name, 'Zzminor', 'the rest of the game stays')
      assert.ok(!('referee_1_dob' in g) && !('referee_2_dob' in g))
      assert.ok(noDob(r), r.text.slice(0, 300))
    }
  })

  it('only a scorer (or an admin) adds a referee, and it is stored without a date of birth', async () => {
    const add = (user, row, extra = {}) => dbCall(user, 'referee_database', 'insert', {
      data: { country: 'CHE', sport_type: ['indoor'], created_at: new Date().toISOString(), ...row }, ...extra
    })
    try {
      for (const name of ['pending', 'manager', 'referee']) {
        const r = await add(users[name], { first_name: 'Rolf', last_name: 'Zzadult', dob: ADULT_DOB }, { returning: '*' })
        assert.equal(r.status, 403, `${name}: ${r.text}`)
        assert.ok(noDob(r), r.text.slice(0, 300))
      }
      assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.referee_database WHERE last_name = 'Zzadult'")).rows[0].n, 1)
      // an older scorer app still sends the date it typed: dropped (WRITE_DENYLIST)
      const mine = await add(users.scorer, { first_name: 'Nora', last_name: 'Zzscorer', dob: '1992-06-07' }, { returning: '*' })
      assert.equal(mine.status, 200, mine.text)
      assert.equal(mine.json.data[0].dob, null)
      const kept = (await sql.query("SELECT to_jsonb(r) ->> 'dob' AS dob FROM public.referee_database r WHERE last_name = 'Zzscorer'")).rows
      assert.deepEqual(kept.map((row) => row.dob), [null])
    } finally {
      await sql.query("DELETE FROM public.referee_database WHERE last_name = 'Zzscorer'")
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

  it('when the roles cannot be read, the directory is 503, never a silent "no"; the schedule needs no lookup', async () => {
    // New scorers: nothing of theirs is in the access cache (30 s) yet
    const reader = await account('lateReader', ['scorer'])
    const writer = await account('lateWriter', ['scorer'])
    await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles TO roles_unreadable')
    try {
      for (const params of [{ columns: 'id, last_name' }, pickerQuery('indoor')]) {
        const r = await dbCall(reader, 'referee_database', 'select', params)
        assert.equal(r.status, 503, r.text)
        assert.equal(r.json.error.code, 'OV_DB_UNAVAILABLE')
        assert.equal(r.json.data, null)
      }
      const games = await dbCall(reader, 'svrz_games', 'select', loaderQuery)
      assert.equal(games.status, 200, games.text)
      assert.ok(noDob(games), games.text.slice(0, 300))
      // A new referee is not stored while the roles cannot be read
      const add = await dbCall(writer, 'referee_database', 'insert', {
        data: { first_name: 'Ida', last_name: 'Zzlate', country: 'CHE', sport_type: ['indoor'] }
      })
      assert.equal(add.status, 503, add.text)
      assert.equal(add.json.error.code, 'OV_DB_UNAVAILABLE')
      assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.referee_database WHERE last_name = 'Zzlate'")).rows[0].n, 0)
    } finally {
      await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles_unreadable TO roles')
    }
  })
})
