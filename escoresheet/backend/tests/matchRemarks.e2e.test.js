/**
 * db/017: the scoresheet remarks (matches.remarks) end to end, server.js
 * against a real Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1; see
 * tests/server.e2e.test.js).
 *
 *   - the scorer writes them with /api/db upsert / update (the sync queue's
 *     match insert and update jobs), indoor and beach rows alike
 *   - the owner, the restore-by-pin lookup (game PIN) and an admin read them
 *   - anonymous readers, the live socket and signed-in non-owners never do,
 *     and cannot filter on them
 *   - POST /api/match/restore (backup restore) writes them
 *   - more than 8000 characters is refused (400), nothing changes
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, openSocket, provisionDatabase, subscribe } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '582914'
const REMARKS = 'Actual start time: 18:05\nTeam A, Set 2, Result 3:5: player no. 4 Muster injured'

describe('match remarks (db/017) over the API', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const ext = `rem_${Date.now()}_${randomBytes(3).toString('hex')}`
  const beachExt = `${ext}_beach`

  async function account(name, { admin = false } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, u.id, admin ? ['scorer', 'admin'] : ['scorer', 'beach:scorer'])
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const byExt = (value) => [{ type: 'eq', column: 'external_id', value }]
  const stored = async (e = ext) => (await sql.query('SELECT remarks FROM public.matches WHERE external_id = $1', [e])).rows[0]?.remarks

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({
      DATABASE_URL: db.url,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      OV_PIN_SECRET: randomBytes(32).toString('base64url')
    })
    users.alice = await account('alice') // the scorer
    users.erin = await account('erin') // another scorer
    users.carol = await account('carol', { admin: true })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the scorer inserts and updates remarks; last write wins', async () => {
    const ins = await dbCall(users.alice, 'matches', 'upsert', {
      data: {
        external_id: ext, game_n: 9417, game_pin: GAME_PIN, status: 'live', sport_type: 'indoor',
        home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' }, scheduled_at: new Date().toISOString(),
        connections: { referee_enabled: true }, remarks: 'First line'
      },
      onConflict: 'external_id', returning: '*', single: true
    })
    assert.equal(ins.status, 200, ins.text)
    assert.equal(ins.json.data.remarks, 'First line')
    assert.equal(await stored(), 'First line')
    // the sync queue's match update job: { remarks } alone
    const upd = await dbCall(users.alice, 'matches', 'update', { data: { remarks: REMARKS }, filters: byExt(ext) })
    assert.equal(upd.status, 200, upd.text)
    assert.equal(await stored(), REMARKS)
    // emptied (every line removed)
    const empty = await dbCall(users.alice, 'matches', 'update', { data: { remarks: '' }, filters: byExt(ext) })
    assert.equal(empty.status, 200, empty.text)
    assert.equal(await stored(), '')
    await dbCall(users.alice, 'matches', 'update', { data: { remarks: REMARKS }, filters: byExt(ext) })
  })

  it('a beach (OpenBeach) row takes remarks like an indoor one', async () => {
    const r = await dbCall(users.alice, 'matches', 'upsert', {
      data: { external_id: beachExt, game_n: 9418, status: 'live', sport_type: 'beach', team1_data: { name: 'T1' }, team2_data: { name: 'T2' } },
      onConflict: 'external_id'
    })
    assert.equal(r.status, 200, r.text)
    const upd = await dbCall(users.alice, 'matches', 'update', {
      data: { remarks: 'Team 2 forfeits the match due to no show' },
      filters: [...byExt(beachExt), { type: 'eq', column: 'sport_type', value: 'beach' }]
    })
    assert.equal(upd.status, 200, upd.text)
    assert.equal(await stored(beachExt), 'Team 2 forfeits the match due to no show')
  })

  it('more than 8000 characters is refused and the stored text stays', async () => {
    const r = await dbCall(users.alice, 'matches', 'update', { data: { remarks: 'x'.repeat(8001) }, filters: byExt(ext) })
    assert.equal(r.status, 400, r.text)
    assert.equal(await stored(), REMARKS)
    const ok = await dbCall(users.alice, 'matches', 'update', { data: { remarks: 'y'.repeat(8000) }, filters: byExt(ext) })
    assert.equal(ok.status, 200, ok.text)
    await dbCall(users.alice, 'matches', 'update', { data: { remarks: REMARKS }, filters: byExt(ext) })
  })

  it('the owner and an admin read them; anonymous readers and other accounts do not', async () => {
    const sel = (u) => dbCall(u, 'matches', 'select', { columns: '*', filters: byExt(ext) })
    assert.equal((await sel(users.alice)).json.data[0].remarks, REMARKS)
    assert.equal((await sel(users.carol)).json.data[0].remarks, REMARKS)
    for (const u of [null, users.erin]) {
      const r = await sel(u)
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.length, 1)
      assert.equal('remarks' in r.json.data[0], false, u ? 'signed-in non-owner' : 'anonymous')
      assert.equal(r.text.includes('Muster'), false)
      // asked for by name
      const named = await dbCall(u, 'matches', 'select', { columns: 'id,remarks', filters: byExt(ext) })
      assert.equal(named.text.includes('Muster'), false, named.text)
    }
    // no probing through a filter
    const probe = await dbCall(null, 'matches', 'select', { columns: 'id', filters: [...byExt(ext), { type: 'like', column: 'remarks', value: '%Muster%' }] })
    assert.notEqual(probe.status, 200, 'an anonymous filter on remarks answered')
    const probeErin = await dbCall(users.erin, 'matches', 'select', { columns: 'id', filters: [...byExt(ext), { type: 'like', column: 'remarks', value: '%Muster%' }] })
    assert.deepEqual(probeErin.json?.data ?? [], [])
  })

  it('the live socket never carries them', async () => {
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      await subscribe(live, 'rem-live', [{ table: 'matches', event: '*', column: 'external_id', value: ext }])
      await dbCall(users.alice, 'matches', 'update', { data: { remarks: REMARKS + '\nSecond Muster line' }, filters: byExt(ext) })
      const msg = await live.waitFor((m) => m.type === 'db-change' && m.table === 'matches', 5000, 'match change')
      assert.equal('remarks' in (msg.new || {}), false, JSON.stringify(msg))
      assert.equal(JSON.stringify(live.messages).includes('Muster'), false)
    } finally {
      live.ws.close()
    }
    await dbCall(users.alice, 'matches', 'update', { data: { remarks: REMARKS }, filters: byExt(ext) })
  })

  it('restore-by-pin (game PIN) returns them: a new scoring device gets the remarks back', async () => {
    const r = await api(srv.base, '/api/match/restore-by-pin', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { gameN: 9417, pin: GAME_PIN } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.match.remarks, REMARKS)
  })

  it('a backup restore (POST /api/match/restore) writes the backup\'s remarks', async () => {
    const body = {
      match: { external_id: ext, game_n: 9417, status: 'live', sport_type: 'indoor', game_pin: '', remarks: 'Restored from the backup' },
      sets: [{ external_id: `${ext}:s:1`, index: 1, home_points: 3, away_points: 1, finished: false }],
      events: [],
      liveState: { match_status: 'live', points_a: 3, points_b: 1, current_set: 1 }
    }
    const r = await api(srv.base, '/api/match/restore', { token: users.alice.token, body })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.dropped?.match, undefined, JSON.stringify(r.json.data.dropped))
    assert.equal(await stored(), 'Restored from the backup')
    // a backup without remarks (an app before 017) leaves the stored text alone
    const old = await api(srv.base, '/api/match/restore', { token: users.alice.token, body: { ...body, match: { external_id: ext, game_n: 9417, status: 'live', sport_type: 'indoor', game_pin: '' } } })
    assert.equal(old.status, 200, old.text)
    assert.equal(await stored(), 'Restored from the backup')
  })

  it('a closed match keeps its remarks', async () => {
    const close = await dbCall(users.alice, 'matches', 'update', { data: { status: 'approved', remarks: 'At approval' }, filters: byExt(ext) })
    assert.equal(close.status, 200, close.text)
    assert.equal(await stored(), 'At approval')
    const late = await dbCall(users.alice, 'matches', 'update', { data: { remarks: 'After the close' }, filters: byExt(ext) })
    assert.equal(late.status, 409, late.text)
    assert.equal(await stored(), 'At approval')
  })
})
