/**
 * db/051: the referees' licence numbers of the schedule (svrz_games
 * referee_1_licence / referee_2_licence, filled by lib/vmSync.js from
 * VolleyManager's person.associationId) are for the accounts that fill an
 * official match's referees only: admins and indoor scorers. /api/db never
 * answers them anonymously (publicColumns ANON_DB_COLUMNS) nor to any other
 * session (the rows without them; no filter or order on them, 400
 * OV_SECRET_FILTER); GET /api/games/today the same. Made-up people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'

const L1 = '512345'
const L2 = '623456'
const leaks = (text) => text.includes(L1) || text.includes(L2)

describe('the referees\' licence numbers of the schedule: scorers and admins only (db/051)', { skip: SKIP }, () => {
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
  const dbCall = (user, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: null, body: { table: 'svrz_games', action: 'select', params } })
  // LoadOfficialMatchModal fetchMatchesFromSupabase
  const loaderQuery = {
    columns: '*',
    filters: [{ type: 'eq', column: 'gender', value: 'men' }, { type: 'eq', column: 'league', value: 'H8' }],
    order: [{ column: 'datetime', ascending: true }]
  }
  const named = { columns: 'game_number, referee_1_last_name, referee_1_licence, referee_2_licence', filters: [{ type: 'eq', column: 'game_number', value: '951001' }] }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, datetime, league, gender, team_home, team_away,
      referee_1_first_name, referee_1_last_name, referee_1_licence, referee_2_first_name, referee_2_last_name, referee_2_licence) VALUES
      ('951001', '2099-01-01T18:00:00', 'H8', 'men', 'VBC Musterdorf H1', 'VBC Beispiel H1', 'Rita', 'Pfeife', $1, 'Rolf', 'Linie', $2),
      ('951002', '${today}T18:00:00', 'H8', 'men', 'VBC Musterdorf H1', 'VBC Beispiel H2', 'Rita', 'Pfeife', $1, 'Rolf', 'Linie', $2)`, [L1, L2])
    await account('pending')
    await account('manager', ['competition_manager'])
    await account('referee', ['referee'])
    await account('beachScorer', ['beach:scorer'])
    await account('scorer', ['scorer'])
    await account('admin', ['admin'])
    const call = (method, path, body) => api(srv.base, path, { method, token: users.admin.token, body })
    const club = (await call('POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    for (const u of [users.scorer, users.referee]) {
      assert.equal((await call('PUT', `/api/admin/accounts/${u.id}/clubs`, { club_ids: [club.id] })).status, 200)
    }
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the migration: two columns of 4 to 7 digits or NULL', async () => {
    for (const bad of ['123', '12345678', 'SV1234', '']) {
      await assert.rejects(sql.query("UPDATE public.svrz_games SET referee_1_licence = $1 WHERE game_number = '951001'", [bad]), /referee_1_licence_check/, bad)
    }
    const { rows: [g] } = await sql.query("SELECT referee_1_licence, referee_2_licence FROM public.svrz_games WHERE game_number = '951001'")
    assert.deepEqual(g, { referee_1_licence: L1, referee_2_licence: L2 })
  })

  it('without a session: the schedule without the licences, no filter on them', async () => {
    const games = await dbCall(null, loaderQuery)
    assert.equal(games.status, 200, games.text)
    assert.ok(games.json.data.length >= 1)
    assert.ok(games.json.data.every((g) => !('referee_1_licence' in g) && !('referee_2_licence' in g)))
    assert.ok(!leaks(games.text), games.text.slice(0, 300))
    const r = await dbCall(null, { columns: 'id', filters: [{ type: 'eq', column: 'referee_1_licence', value: L1 }] })
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error.code, 'OV_SECRET_FILTER')
  })

  it('an account that does not score indoor: the rows without the licences; no filter or order on them', async () => {
    for (const name of ['pending', 'manager', 'referee', 'beachScorer']) {
      for (const params of [loaderQuery, named]) {
        const games = await dbCall(users[name], params)
        assert.equal(games.status, 200, `${name}: ${games.text}`)
        assert.ok(games.json.data.length >= 1, name)
        assert.ok(games.json.data.every((g) => !('referee_1_licence' in g) && !('referee_2_licence' in g)), name)
        assert.ok(games.json.data.some((g) => g.referee_1_last_name === 'Pfeife'), `${name}: the rest of the row stays`)
        assert.ok(!leaks(games.text), `${name}: ${games.text.slice(0, 300)}`)
      }
      for (const params of [
        { columns: 'id', filters: [{ type: 'eq', column: 'referee_1_licence', value: L1 }] },
        { columns: 'id', filters: [{ type: 'like', column: 'referee_2_licence', value: '6*' }], head: true, count: 'exact' },
        { columns: 'id', order: [{ column: 'referee_2_licence', ascending: false }], limit: 1 }
      ]) {
        const r = await dbCall(users[name], params)
        assert.equal(r.status, 400, `${name}: ${r.text}`)
        assert.equal(r.json.error.code, 'OV_SECRET_FILTER', name)
        assert.ok(!leaks(r.text))
      }
    }
  })

  it('an indoor scorer and an admin read them (Load official match)', async () => {
    for (const name of ['scorer', 'admin']) {
      const games = await dbCall(users[name], loaderQuery)
      assert.equal(games.status, 200, games.text)
      const g = games.json.data.find((row) => row.game_number === '951001')
      assert.deepEqual([g.referee_1_last_name, g.referee_1_licence, g.referee_2_licence], ['Pfeife', L1, L2], name)
      const one = await dbCall(users[name], { ...named, single: true })
      assert.deepEqual(one.json.data, { game_number: '951001', referee_1_last_name: 'Pfeife', referee_1_licence: L1, referee_2_licence: L2 })
      const f = await dbCall(users[name], { columns: 'game_number', filters: [{ type: 'eq', column: 'referee_2_licence', value: L2 }, { type: 'eq', column: 'game_number', value: '951001' }] })
      assert.deepEqual(f.json.data, [{ game_number: '951001' }], name)
    }
  })

  it('today\'s home games: the licences for the club\'s scorer, not for its referee', async () => {
    const of = async (name) => {
      const r = await api(srv.base, '/api/games/today', { method: 'GET', proto: null, token: users[name].token })
      assert.equal(r.status, 200, r.text)
      return { r, g: r.json.data.games.find((row) => row.game_number === '951002') }
    }
    const scorer = await of('scorer')
    assert.deepEqual([scorer.g.referee_1_last_name, scorer.g.referee_1_licence, scorer.g.referee_2_licence], ['Pfeife', L1, L2])
    const referee = await of('referee')
    assert.equal(referee.g.referee_1_last_name, 'Pfeife', 'the rest of the game stays')
    assert.ok(!('referee_1_licence' in referee.g) && !('referee_2_licence' in referee.g))
    assert.ok(!leaks(referee.r.text), referee.r.text.slice(0, 300))
  })

  it('when the roles cannot be read: the schedule without the licences (and no filter on them), never with', async () => {
    // a new scorer: nothing of it is in the access cache (30 s) yet
    const late = await account('lateScorer', ['scorer'])
    await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles TO roles_unreadable')
    try {
      const r = await dbCall(late, loaderQuery)
      assert.equal(r.status, 200, r.text)
      assert.ok(r.json.data.some((g) => g.referee_1_last_name === 'Pfeife'))
      assert.ok(!leaks(r.text), r.text.slice(0, 300))
      const f = await dbCall(late, { columns: 'id', filters: [{ type: 'eq', column: 'referee_1_licence', value: L1 }] })
      assert.equal(f.status, 400, f.text)
      assert.equal(f.json.error.code, 'OV_SECRET_FILTER')
    } finally {
      await sql.query('ALTER TABLE public.profiles RENAME COLUMN roles_unreadable TO roles')
    }
  })
})
