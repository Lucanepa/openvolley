/**
 * The Global tool's live page for TVs through the relay (server.js
 * live-state-update -> lib/globalLive.js -> GET /api/global/live/<code>):
 *
 *   - a Global match whose scorer sends `globalLive` shows up under that code,
 *     score summary only (no players, no PINs, no room key)
 *   - a test match that is not Global, a socket that does not own the room
 *     and a bad code put nothing on the page
 *   - the page answers CORS * (any TV page or school site may read it)
 *
 *   cd escoresheet/backend && node --test tests/globalLive.relay.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { bootServer, openSocket } from './helpers/e2eServer.js'

const CODE = 'TVPG2345'
const hex = () => randomBytes(3).toString('hex')

function sync(room, match = {}) {
  return {
    type: 'sync-match-data',
    matchId: 1,
    match: { id: 1, seed_key: room, status: 'live', test: true, gamePin: '515253', refereePin: '316271', coinTossTeamA: 'home', hall: 'Hall 1', ...match },
    homeTeam: { id: 1, name: 'Munich IS' },
    awayTeam: { id: 2, name: 'Zurich IS' },
    homePlayers: [{ id: 1, firstName: 'Anna', lastName: 'Muster', number: 7 }],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true }, { id: 2, index: 2, homePoints: 3, awayPoints: 1, finished: false }],
    events: []
  }
}
const liveState = (over = {}) => ({
  team_a_name: 'Munich IS', team_b_name: 'Zurich IS', sets_won_a: 1, sets_won_b: 0, points_a: 3, points_b: 1,
  current_set: 2, best_of: 5, side_a: 'left', serving_team: 'left', match_status: 'live', lineup_a: { I: 7 }, ...over
})

async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}
async function page(base, code = CODE) {
  const r = await fetch(`${base}/api/global/live/${code}`, { headers: { Origin: 'https://livescore.openvolley.app' }, signal: AbortSignal.timeout(5000) })
  return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json().catch(() => null) }
}

describe('Global live page through the relay', () => {
  let srv
  const sockets = []
  // the cloud a venue relay forwards to (OV_GLOBAL_LIVE_FORWARD), captured here
  const forwarded = []
  let cloud
  before(async () => {
    cloud = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => { forwarded.push({ path: req.url, type: req.headers['content-type'], body: JSON.parse(body || 'null') }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":{"ok":true}}') })
    })
    await new Promise((ok) => cloud.listen(0, '127.0.0.1', ok))
    srv = await bootServer({ OV_GLOBAL_LIVE_FORWARD: `http://127.0.0.1:${cloud.address().port}` }, ['--local'])
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    cloud?.close()
  })
  const open = async () => { const c = await openSocket(srv.wsUrl); sockets.push(c); return c }

  it('a Global match with the code shows its court, summary only, CORS *', async () => {
    const room = `match_test_${hex()}`
    const scorer = await open()
    scorer.send(sync(room, { global: true }))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState(), globalLive: CODE })
    await settle(scorer)
    const r = await page(srv.base)
    assert.equal(r.status, 200)
    assert.equal(r.cors, '*')
    const courts = r.json.data.courts
    assert.equal(courts.length, 1)
    assert.deepEqual(courts[0].points, { home: 3, away: 1 })
    assert.deepEqual(courts[0].sets, [{ home: 25, away: 20 }])
    assert.equal(courts[0].home.name, 'Munich IS')
    assert.equal(courts[0].hall, 'Hall 1')
    const text = JSON.stringify(r.json)
    for (const leak of ['Anna', 'Muster', '515253', '316271', room, 'lineup']) assert.equal(text.includes(leak), false, leak)
  })

  it('any match type may opt in: a league match (not a test match) shows its court too', async () => {
    const code = 'LEAG2345'
    const room = `match_${hex()}`
    const scorer = await open()
    scorer.send(sync(room, { test: false }))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState({ points_a: 9 }), globalLive: code })
    await settle(scorer)
    const r = await page(srv.base, code)
    assert.equal(r.json.data.courts.length, 1)
    assert.equal(r.json.data.courts[0].points.home, 9)
  })

  it('nothing without a code, from a socket that does not own the room, or with a bad code', async () => {
    const code = 'NNNN2345'
    const room = `match_test_${hex()}`
    const scorer = await open()
    scorer.send(sync(room))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState() }) // no code: not on any page
    await settle(scorer)

    const globalRoom = `match_test_${hex()}`
    const owner = await open()
    owner.send(sync(globalRoom, { global: true }))
    await settle(owner)
    const stranger = await open()
    stranger.send({ type: 'live-state-update', matchId: globalRoom, liveState: liveState({ team_a_name: 'FAKE' }), globalLive: code })
    await settle(stranger)
    owner.send({ type: 'live-state-update', matchId: globalRoom, liveState: liveState(), globalLive: 'bad-code' })
    await settle(owner)

    const r = await page(srv.base, code)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.data.courts, [])
    assert.equal((await page(srv.base, 'bad-code')).status, 404)
  })

  it('the TV page and its script are served for a code, case and spaces forgiven; a bad code goes back to the form', async () => {
    const r = await fetch(`${srv.base}/tv/tvpg-2345`, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    assert.match(await r.text(), /data-code="TVPG2345"/)
    const js = await fetch(`${srv.base}/tv/tv.js`, { signal: AbortSignal.timeout(5000) })
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
    const bad = await fetch(`${srv.base}/tv/nope`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.equal(bad.status, 302)
    assert.equal(bad.headers.get('location'), '/tv/?wrong=1')
  })

  it('a scorer whose relay is not this server pushes its court over HTTP; with the same court token the relay path updates the same court', async () => {
    const code = 'PUSH2345'
    const court = 'a'.repeat(32)
    const push = (body) => fetch(`${srv.base}/api/global/live/${code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    const r = await push({ court, liveState: liveState({ points_a: 7 }), match: { coinTossTeamA: 'home', hall: 'Hall 3' }, homeTeam: { name: 'Munich IS' }, awayTeam: { name: 'Zurich IS' }, sets: [{ index: 1, homePoints: 25, awayPoints: 22, finished: true }], homePlayers: [{ lastName: 'Muster' }] })
    assert.equal(r.status, 200)
    let p = await page(srv.base, code)
    assert.equal(p.json.data.courts.length, 1)
    assert.equal(p.json.data.courts[0].points.home, 7)
    assert.equal(p.json.data.courts[0].hall, 'Hall 3')
    assert.equal(JSON.stringify(p.json).includes('Muster'), false)

    const room = `match_test_${hex()}`
    const scorer = await open()
    scorer.send(sync(room, { global: true, hall: 'Hall 3' }))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState({ points_a: 8 }), globalLive: code, globalLiveCourt: court })
    await settle(scorer)
    p = await page(srv.base, code)
    assert.equal(p.json.data.courts.length, 1, 'one court, not two')
    assert.equal(p.json.data.courts[0].points.home, 8)

    assert.equal((await push({ court: 'not-a-token', liveState: liveState() })).status, 400)
    assert.equal((await fetch(`${srv.base}/api/global/live/bad`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })).status, 400)
  })

  it('a venue relay forwards its Global courts to the cloud: summary fields only, one court token', async () => {
    const code = 'FWRD2345'
    const room = `match_test_${hex()}`
    const scorer = await open()
    scorer.send(sync(room, { global: true }))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState({ points_a: 4 }), globalLive: code, globalLiveCourt: 'b'.repeat(32) })
    await settle(scorer)
    const deadline = Date.now() + 5000
    while (!forwarded.some((f) => f.path === `/api/global/live/${code}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const f = forwarded.find((x) => x.path === `/api/global/live/${code}`)
    assert.ok(f, 'forwarded to the cloud')
    assert.match(f.type, /application\/json/)
    assert.equal(f.body.court, 'b'.repeat(32))
    assert.equal(f.body.liveState.points_a, 4)
    assert.equal('lineup_a' in f.body.liveState, false)
    assert.deepEqual(f.body.sets, [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }])
    const text = JSON.stringify(f.body)
    for (const leak of ['Anna', 'Muster', '515253', '316271', room]) assert.equal(text.includes(leak), false, leak)
  })

  it('/tv without a code asks for it; /tv/go sends a good code to its page and a bad one back', async () => {
    for (const path of ['/tv', '/tv/']) {
      const r = await fetch(`${srv.base}${path}`, { signal: AbortSignal.timeout(5000) })
      assert.equal(r.status, 200, path)
      assert.match(await r.text(), /action="\/tv\/go"/)
    }
    const go = (code) => fetch(`${srv.base}/tv/go?code=${encodeURIComponent(code)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    let r = await go('tvpg 2345')
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/tv/TVPG2345')
    r = await go('nope')
    assert.equal(r.headers.get('location'), '/tv/?wrong=1')
    const back = await fetch(`${srv.base}/tv/?wrong=1`, { signal: AbortSignal.timeout(5000) })
    assert.match(await back.text(), /class="err"/)
  })

  it('one court of a live screen (/tv/<code>/<court>) and one game by its number (/tv/<game number>) on a venue relay', async () => {
    const code = 'CRTS2345'
    const roomA = `match_${hex()}`
    const roomB = `match_${hex()}`
    const a = await open()
    a.send(sync(roomA, { test: false, gameN: 8801 }))
    await settle(a)
    a.send({ type: 'live-state-update', matchId: roomA, liveState: liveState({ points_a: 11 }), globalLive: code, globalLiveScreen: 1 })
    await settle(a)
    const b = await open()
    b.send(sync(roomB, { test: false, gameN: 8802 }))
    await settle(b)
    b.send({ type: 'live-state-update', matchId: roomB, liveState: liveState({ points_a: 22 }), globalLive: code, globalLiveScreen: 2 })
    await settle(b)
    const get = async (path) => (await fetch(`${srv.base}${path}`, { signal: AbortSignal.timeout(5000) })).json()
    assert.equal((await get(`/api/global/live/${code}`)).data.courts.length, 2)
    assert.deepEqual((await get(`/api/global/live/${code}?screen=2`)).data.courts.map(c => c.points.home), [22])
    // a game number, from the relay's own room
    const g = await get('/api/global/live/game/8801')
    assert.equal(g.data.courts.length, 1)
    assert.equal(g.data.courts[0].points.home, 11)
    assert.deepEqual((await get('/api/global/live/game/9999')).data.courts, [])
    // the pages and the form
    const page = await (await fetch(`${srv.base}/tv/${code.toLowerCase()}/2`, { signal: AbortSignal.timeout(5000) })).text()
    assert.match(page, /data-src="\/api\/global\/live\/CRTS2345\?screen=2"/)
    const gamePage = await (await fetch(`${srv.base}/tv/8801`, { signal: AbortSignal.timeout(5000) })).text()
    assert.match(gamePage, /data-src="\/api\/global\/live\/game\/8801"/)
    const go = async (q) => (await fetch(`${srv.base}/tv/go?${q}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })).headers.get('location')
    assert.equal(await go('code=crts2345&court=2'), '/tv/CRTS2345/2')
    assert.equal(await go('code=crts2345&court='), '/tv/CRTS2345')
    assert.equal(await go('code=8801'), '/tv/8801')
  })
})
