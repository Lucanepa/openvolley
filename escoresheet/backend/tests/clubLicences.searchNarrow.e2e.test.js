/**
 * PERM-19 fix-up (review CR-1): the team manager's people search spends its
 * daily budget on lookups, not on keystrokes. The picker asks the server 300
 * ms after each pause from 3 letters on, so a manager who pauses on "Sch",
 * "Schm", "Schmid" ... got up to 10 new people each time, and after 4
 * officials looked up the budget of SEARCH_DAILY_PEOPLE was gone: a unique
 * full name came back as { people: [], more: true, limited: true }, and the
 * picker said "type more of the name" for the next 24 hours. Now a budgeted
 * answer names people only when it is whole (at most SEARCH_NARROW_MAX
 * match): a broader query names nobody and costs nothing, every narrower
 * query after a whole answer finds people shown already, and an answer that
 * the budget cut says limited: true with more: false. A club manager's
 * search is unchanged (up to MAX_SEARCH_RESULTS, more: true). Made-up people.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { MAX_SEARCH_RESULTS, SEARCH_DAILY_PEOPLE, SEARCH_NARROW_MAX } from '../lib/licences.js'

// the reviewer's probe: 8 "Sch..." surnames of 10 people each, and one Weber Tom
const SURNAMES = ['Schmid', 'Schneider', 'Schärer', 'Schweizer', 'Schuler', 'Scholl', 'Schaub', 'Schibli']
const FIRST = ['Anna', 'Beat', 'Carla', 'Dario', 'Eva', 'Fabio', 'Gina', 'Hans', 'Ines', 'Jonas']
const PEOPLE = SURNAMES.flatMap((last, i) => FIRST.map((first, j) => ({ sv_number: String(400000 + i * 10 + j), last_name: last, first_name: first, gender: j % 2 ? 'm' : 'f' })))
const WEBER = { sv_number: '410001', last_name: 'Weber', first_name: 'Tom', gender: 'm' }
// a surname of a few people: a whole answer
const KELLER = ['Mia', 'Noe', 'Lea'].map((first, j) => ({ sv_number: String(410010 + j), last_name: 'Keller', first_name: first, gender: 'f' }))

describe('club people search: the budget follows lookups, not keystrokes (CR-1)', { skip: SKIP }, () => {
  let db, srv, sql, club, team
  let ipSeq = 1
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
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
  const search = async (user, q) => {
    const r = await call(user, 'GET', `/api/team/${team}/club-people?q=${encodeURIComponent(q)}`)
    assert.equal(r.status, 200, `${q}: ${r.text}`)
    return r.json.data
  }
  const names = (d) => d.people.map((p) => `${p.first_name} ${p.last_name}`)
  // the different people the account was shown in 24 hours (what the budget counts)
  const spent = async (user) => (await sql.query(
    `SELECT count(DISTINCT x)::int AS n FROM public.audit_log a, jsonb_array_elements_text(a.details -> 'ids') x
      WHERE a.actor_id = $1 AND a.action = 'club.people_search'`, [user.id])).rows[0].n

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('admin')
    await account('Clubby')
    await account('Teamy')
    await account('Busy')
    await sql.query(`UPDATE public.profiles SET roles = ARRAY['admin'] WHERE user_id = $1`, [users.admin.id])
    club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    team = (await sql.query('SELECT id FROM public.club_teams WHERE club_id = $1', [club.id])).rows[0].id
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club.id, users.Clubby.id])
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2), ($1, $3)', [team, users.Teamy.id, users.Busy.id])
    const up = await call(users.Clubby, 'PUT', `/api/club/${club.id}/licences/coaches`, { people: [...PEOPLE, WEBER, ...KELLER] })
    assert.equal(up.status, 200, up.text)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('pauses on a name being typed cost nothing; a unique full name is found after them', async () => {
    for (const q of ['Sch', 'Schm', 'Schmid', 'Schn', 'Schneider', 'Schä', 'Schärer', 'Schw', 'Schweizer']) {
      const d = await search(users.Teamy, q)
      assert.deepEqual(d.people, [], `${q}: more than ${SEARCH_NARROW_MAX} match, nobody named`)
      assert.equal(d.more, true, q)
      assert.equal(d.limited, undefined, q)
    }
    assert.equal(await spent(users.Teamy), 0, 'no budget spent on the pauses')
    assert.deepEqual(names(await search(users.Teamy, 'Weber Tom')), ['Tom Weber'])
    // the manager goes on typing the first name: one person, one of the budget
    assert.deepEqual(names(await search(users.Teamy, 'Schmid An')), ['Anna Schmid'])
    assert.equal(await spent(users.Teamy), 2)
  })

  it('a whole answer costs its people once; narrowing it costs nothing', async () => {
    const d = await search(users.Teamy, 'Kel')
    assert.deepEqual(names(d).sort(), ['Lea Keller', 'Mia Keller', 'Noe Keller'])
    assert.equal(d.more, false)
    assert.equal(await spent(users.Teamy), 5)
    for (const q of ['Kell', 'Keller', 'Keller M', 'Keller Mia']) await search(users.Teamy, q)
    assert.deepEqual(names(await search(users.Teamy, 'Keller Mia')), ['Mia Keller'])
    assert.equal(await spent(users.Teamy), 5, 'the people of the whole answer came again for free')
    // every search is audited, the pauses too (ids and counts only)
    const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'club.people_search' AND actor_id = $1", [users.Teamy.id])
    assert.ok(rows.length >= 16, String(rows.length))
    assert.ok(!JSON.stringify(rows).includes('Keller'))
  })

  it('the budget used up: limited, and more: false when only the budget held people back', async () => {
    let i = 0
    for (const p of PEOPLE) {
      if (i++ >= SEARCH_DAILY_PEOPLE) break
      const d = await search(users.Busy, `${p.last_name} ${p.first_name}`)
      assert.equal(d.people.length, 1, `${p.last_name} ${p.first_name}`)
    }
    assert.equal(await spent(users.Busy), SEARCH_DAILY_PEOPLE)
    const d = await search(users.Busy, 'Weber Tom')
    assert.deepEqual(d.people, [])
    assert.equal(d.limited, true)
    assert.equal(d.more, false, 'typing more of the name would not help')
    // those shown before still come
    assert.deepEqual(names(await search(users.Busy, `${PEOPLE[0].last_name} ${PEOPLE[0].first_name}`)), [`${PEOPLE[0].first_name} ${PEOPLE[0].last_name}`])
  })

  it('a club manager searches as before: the first rows of a broad query, more: true', async () => {
    const d = await search(users.Clubby, 'Sch')
    assert.equal(d.people.length, MAX_SEARCH_RESULTS)
    assert.equal(d.more, true)
  })
})
