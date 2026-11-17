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
  before(async () => { srv = await bootServer({}, ['--local']) })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
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

  it('nothing from a test match that is not Global, from a socket that does not own the room, or with a bad code', async () => {
    const code = 'NNNN2345'
    const room = `match_test_${hex()}`
    const scorer = await open()
    scorer.send(sync(room)) // a test match, not Global
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: liveState(), globalLive: code })
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
})
