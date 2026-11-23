/**
 * PERM-19 (audit 2611, owner decision 7): GET /api/team/:id/club-people?q=
 * finds a person, it cannot dump the club's lists. Before, any 3 characters
 * matched anywhere in "<last> <first> <first> <last>" and only the answer
 * was capped, so a team manager rebuilt all 311 people of a club in 1200
 * requests, without an audit trace (poc search_enum2.mjs). Now:
 *   - a word matches the START of a part of the name, the longest word has
 *     at least 3 letters; a licence number matches whole;
 *   - at most MAX_SEARCH_RESULTS rows an answer;
 *   - at most SEARCH_DAILY_PEOPLE different people per account in 24 hours
 *     (those shown already come again; `limited` says someone was left out);
 *   - every search is audited (ids and counts, never a name or the query);
 *   - a manager of the club (who reads the whole lists anyway) and an admin
 *     have no budget.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { MAX_SEARCH_RESULTS, SEARCH_DAILY_PEOPLE } from '../lib/licences.js'

const UP = 'ABCDEFGH'
const LOW = 'abcdefghij'
// 80 coaches "Muster, <Xy>ina": one query each finds exactly one of them
const PEOPLE = [...UP].flatMap((a, i) => [...LOW].map((b, j) => ({ sv_number: String(300000 + i * 10 + j), last_name: 'Muster', first_name: `${a}${b}ina`, gender: 'm' })))
const MUELLER = { sv_number: '310001', last_name: 'Müller', first_name: 'Anna', gender: 'f' }
const ZELLER = { sv_number: '310002', last_name: 'von Zeller', first_name: 'Beat', gender: 'm' }

describe('club people search: a person, never the list (PERM-19)', { skip: SKIP }, () => {
  let db, srv, sql, club, team
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    users[name] = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    return users[name]
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: method === 'GET' ? null : '2', headers: { 'cf-connecting-ip': user.ip } })
  const search = (user, q) => call(user, 'GET', `/api/team/${team}/club-people?q=${encodeURIComponent(q)}`)
  const names = (r) => r.json.data.people.map((p) => `${p.first_name} ${p.last_name}`)

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('admin')
    await account('Clubby')
    await account('Teamy')
    await sql.query(`UPDATE public.profiles SET roles = ARRAY['admin'] WHERE user_id = $1`, [users.admin.id])
    club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    team = (await sql.query('SELECT id FROM public.club_teams WHERE club_id = $1', [club.id])).rows[0].id
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club.id, users.Clubby.id])
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team, users.Teamy.id])
    const up = await call(users.Clubby, 'PUT', `/api/club/${club.id}/licences/coaches`, { people: [...PEOPLE, MUELLER, ZELLER] })
    assert.equal(up.status, 200, up.text)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('a word begins a part of the name; a licence number whole; nothing in the middle', async () => {
    assert.deepEqual(names(await search(users.Teamy, 'mül')), ['Anna Müller'])
    assert.deepEqual(names(await search(users.Teamy, 'Anna MUL')), ['Anna Müller'], 'accents and case aside, either order')
    assert.deepEqual(names(await search(users.Teamy, 'zel')), ['Beat von Zeller'], 'a part of a last name of two words')
    assert.deepEqual(names(await search(users.Teamy, MUELLER.sv_number)), ['Anna Müller'])
    assert.deepEqual(names(await search(users.Teamy, 'ller')), [], 'not in the middle')
    assert.deepEqual(names(await search(users.Teamy, '3100')), [], 'not a part of a licence number')
    // the enumerator's needles: "<last letter> <first letter>"
    for (const q of ['r a', 'a b', 'ab', 'ü a']) {
      const r = await search(users.Teamy, q)
      assert.equal(r.status, 400, `${q}: ${r.text}`)
    }
  })

  it('at most a few rows an answer', async () => {
    const r = await search(users.Teamy, 'muster')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.people.length, MAX_SEARCH_RESULTS)
    assert.equal(r.json.data.more, true)
  })

  it('a team manager gets at most SEARCH_DAILY_PEOPLE different people a day; those shown come again', async () => {
    const found = new Set()
    let limited = 0
    for (const p of PEOPLE) {
      const r = await search(users.Teamy, `muster ${p.first_name.slice(0, 2)}`)
      assert.equal(r.status, 200, r.text)
      for (const x of r.json.data.people) found.add(x.sv_number)
      if (r.json.data.limited) limited++
    }
    assert.ok(found.size <= SEARCH_DAILY_PEOPLE + 2, `${found.size} people found`)
    assert.ok(found.size >= SEARCH_DAILY_PEOPLE - MAX_SEARCH_RESULTS, `${found.size} people found`)
    assert.ok(limited > 0, 'the budget said so')
    // someone shown before is found again
    const again = await search(users.Teamy, 'mül')
    assert.deepEqual(names(again), ['Anna Müller'])
    // a new one is not
    const fresh = PEOPLE.find((p) => !found.has(p.sv_number))
    const r = await search(users.Teamy, `muster ${fresh.first_name.slice(0, 2)}`)
    assert.deepEqual(r.json.data.people, [])
    assert.equal(r.json.data.limited, true)
    assert.equal(r.json.data.more, true)
  })

  it('every search is audited, with ids and counts only', async () => {
    const { rows } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'club.people_search' ORDER BY id")
    assert.ok(rows.length >= PEOPLE.length, String(rows.length))
    assert.ok(rows.every((a) => a.actor_id === users.Teamy.id))
    assert.ok(rows.every((a) => a.details.team_id === team && a.details.club_id === club.id && Array.isArray(a.details.ids)))
    const text = JSON.stringify(rows)
    for (const s of ['Müller', 'Muster', 'Anna', MUELLER.sv_number, 'mül']) assert.ok(!text.includes(s), s)
  })

  it('the club\'s manager and an admin search without a budget (they read the lists anyway)', async () => {
    const before = (await sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'club.people_search'")).rows[0].n
    const found = new Set()
    for (const p of PEOPLE) {
      const r = await search(users.Clubby, `muster ${p.first_name.slice(0, 2)}`)
      for (const x of r.json.data.people) found.add(x.sv_number)
    }
    assert.equal(found.size, PEOPLE.length)
    assert.equal((await search(users.admin, 'muster bj')).json.data.people.length, 1)
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'club.people_search'")).rows[0].n, before)
  })
})
