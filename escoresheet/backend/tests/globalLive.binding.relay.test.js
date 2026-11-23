/**
 * The live screen for TVs through a running server (audit round 3 SEC-07): a
 * scorer's court on the relay cannot be taken over by anyone who computes its
 * court token from the public seed key (what OpenVolley up to 26.11.x and
 * OpenBeach send), neither by an anonymous HTTP push nor from a relay room
 * the attacker owns, nor pushed out by 24 random courts. A court nobody
 * proved (the desktop app's push, a venue relay's forward) still works with
 * such a token.
 *
 *   cd escoresheet/backend && node --test tests/globalLive.binding.relay.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { bootServer, openSocket } from './helpers/e2eServer.js'

// the court token OpenVolley up to 26.11.x and OpenBeach make of a match's seed key
const legacyCourtToken = (seed) => createHash('sha256').update(`court\0${seed}`).digest('hex').slice(0, 32)

const hex = () => randomBytes(3).toString('hex')
function sync(room, match = {}) {
  return {
    type: 'sync-match-data',
    matchId: room,
    match: { seed_key: room, status: 'live', test: false, gamePin: '515253', refereePin: '316271', coinTossTeamA: 'home', hall: 'Sporthalle Musterdorf', gameN: 900102, ...match },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'VC Beispielstadt' },
    homePlayers: [], awayPlayers: [], sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 18, finished: true }], events: []
  }
}
const liveState = (over = {}) => ({ team_a_name: 'VBC Musterdorf', team_b_name: 'VC Beispielstadt', sets_won_a: 1, sets_won_b: 0, points_a: 12, points_b: 9, current_set: 2, best_of: 5, side_a: 'left', serving_team: 'left', match_status: 'live', ...over })
const forged = { team_a_name: 'X', team_b_name: 'Y', points_a: 0, points_b: 25, sets_won_a: 0, sets_won_b: 3, current_set: 3, match_status: 'final' }

async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}

describe('live screen courts the relay proved', () => {
  let srv
  const sockets = []
  before(async () => { srv = await bootServer({ OV_GLOBAL_LIVE_FORWARD: 'off' }, ['--local']) })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async () => { const c = await openSocket(srv.wsUrl); sockets.push(c); return c }
  const page = async (code) => (await (await fetch(`${srv.base}/api/global/live/${code}`, { signal: AbortSignal.timeout(5000) })).json()).data.courts
  const push = (code, body) => fetch(`${srv.base}/api/global/live/${code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })

  it('an anonymous HTTP push with the token of the public seed key cannot overwrite the court (409); an attacker\'s relay room cannot either', async () => {
    const code = 'BNDX2345'
    const seed = `match_${Date.now()}_${hex()}`
    const token = legacyCourtToken(seed) // as OpenVolley 26.11.x makes it
    const scorer = await open()
    scorer.send(sync(seed))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: seed, liveState: liveState(), globalLive: code, globalLiveCourt: token })
    await settle(scorer)
    const before = await page(code)
    assert.equal(before.length, 1)
    assert.deepEqual(before[0].points, { home: 12, away: 9 })

    // the attacker: the external id from the public API, the same token, no Origin
    const r = await push(code, { court: legacyCourtToken(seed), liveState: forged, match: { hall: 'MATCH CANCELLED - go home' }, homeTeam: { name: 'X' }, awayTeam: { name: 'Y' } })
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error.code, 'OV_COURT_BOUND')
    assert.deepEqual((await page(code)).map((c) => [c.id, c.hall, c.points.home]), [[before[0].id, 'Sporthalle Musterdorf', 12]])

    // the attacker's own (test) room naming the same court
    const attacker = await open()
    const own = `match_test_${hex()}`
    attacker.send(sync(own, { test: true, hall: 'WS FORGED', gamePin: '112233' }))
    await settle(attacker)
    attacker.send({ type: 'live-state-update', matchId: own, liveState: { ...forged, team_a_name: 'WS Fake A' }, globalLive: code, globalLiveCourt: token })
    await settle(attacker)
    const after = await page(code)
    assert.equal(after.length, 1)
    assert.equal(after[0].home.name, 'VBC Musterdorf')
    assert.equal(after[0].points.home, 12)

    // the scorer's next rally lands as always
    scorer.send({ type: 'live-state-update', matchId: seed, liveState: liveState({ points_a: 13 }), globalLive: code, globalLiveCourt: token })
    await settle(scorer)
    assert.equal((await page(code))[0].points.home, 13)
  })

  it('24 random courts pushed anonymously do not push the real one out', async () => {
    const code = 'EVCT2345'
    const seed = `match_${Date.now()}_${hex()}`
    const scorer = await open()
    scorer.send(sync(seed))
    await settle(scorer)
    scorer.send({ type: 'live-state-update', matchId: seed, liveState: liveState(), globalLive: code, globalLiveCourt: legacyCourtToken(seed) })
    await settle(scorer)
    const real = (await page(code))[0].id
    const statuses = []
    for (let i = 0; i < 24; i++) statuses.push((await push(code, { court: randomBytes(16).toString('hex'), liveState: { team_a_name: `SPAM ${i}`, team_b_name: 'SPAM', points_a: 0, points_b: 0, match_status: 'live' } })).status)
    assert.equal(statuses.filter((s) => s === 200).length, 23)
    assert.equal(statuses.filter((s) => s === 503).length, 1)
    assert.ok((await page(code)).some((c) => c.id === real), 'the real court is still there')
  })

  it('a court nobody proved works as before: an older app\'s token over HTTP is shown and updated', async () => {
    const code = 'DESK2345'
    const token = legacyCourtToken(`match_${Date.now()}_desktop`)
    assert.equal((await push(code, { court: token, liveState: liveState({ points_a: 3 }), homeTeam: { name: 'VBC Musterdorf' }, awayTeam: { name: 'VC Beispielstadt' } })).status, 200)
    assert.equal((await push(code, { court: token, liveState: liveState({ points_a: 4 }), homeTeam: { name: 'VBC Musterdorf' }, awayTeam: { name: 'VC Beispielstadt' } })).status, 200)
    assert.deepEqual((await page(code)).map((c) => c.points.home), [4])
  })
})
