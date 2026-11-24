/**
 * One court per match on the live screen (audit round 3 LOG-11): OpenVolley
 * up to 26.11.x sends the first live push after a page load without its court
 * token (still being worked out), every later one with it. The relay made two
 * courts of that, the first frozen at its score on every TV for up to 3 hours.
 * The server keeps one court per relay room now; the room's first court gives
 * way to its token's court. The current app works the token out first
 * (frontend utils/globalLive.js liveScreenFieldsFor).
 *
 *   cd escoresheet/backend && node --test tests/globalLive.ghostCourt.relay.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { bootServer, openSocket } from './helpers/e2eServer.js'

const ls = (a, b) => ({ team_a_name: 'Ghost Home', team_b_name: 'Ghost Away', points_a: a, points_b: b, sets_won_a: 0, sets_won_b: 0, current_set: 1, best_of: 5, side_a: 'left', serving_team: 'left', match_status: 'in_progress' })

async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}

describe('a match is one court on the TVs', () => {
  let srv
  const sockets = []
  before(async () => { srv = await bootServer({ OV_GLOBAL_LIVE_FORWARD: 'off' }, ['--local']) })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async () => { const c = await openSocket(srv.wsUrl); sockets.push(c); return c }
  const page = async (code) => (await (await fetch(`${srv.base}/api/global/live/${code}`, { signal: AbortSignal.timeout(5000) })).json()).data.courts

  it('a first push without the court token, then pushes with it: one court at the newest score', async () => {
    const code = 'GHST2345'
    const room = `match_${Date.now()}_ghost${randomBytes(2).toString('hex')}`
    const globalKey = randomBytes(16).toString('hex')
    const c = await open()
    c.send({ type: 'sync-match-data', matchId: room, match: { seed_key: room, status: 'live', global: true, test: true, coinTossTeamA: 'home', gamePin: '482913' },
      homeTeam: { id: 1, name: 'Ghost Home' }, awayTeam: { id: 2, name: 'Ghost Away' }, homePlayers: [], awayPlayers: [], sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0 }], events: [] })
    await settle(c)
    c.send({ type: 'live-state-update', matchId: room, liveState: ls(1, 0), globalLive: code })
    await settle(c)
    const token = createHash('sha256').update(`court\0${globalKey}`).digest('hex').slice(0, 32)
    for (let i = 2; i <= 10; i++) c.send({ type: 'live-state-update', matchId: room, liveState: ls(i, 0), globalLive: code, globalLiveCourt: token })
    await settle(c)
    const courts = await page(code)
    assert.deepEqual(courts.map((x) => x.points), [{ home: 10, away: 0 }])
    // a reload: the first push without the token again
    c.send({ type: 'live-state-update', matchId: room, liveState: ls(11, 0), globalLive: code })
    await settle(c)
    assert.deepEqual((await page(code)).map((x) => x.points.home), [11])
  })
})
