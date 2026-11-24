/**
 * Scoreboard codes on the cloud relay (IS_CLOUD, addresses from Cloudflare):
 * wrong codes from one address no longer stop that address's boards (audit
 * 2611 SEC-21). Any page opened on a phone behind a hall's NAT fired 21
 * no-cors text/plain POSTs to /api/display/lookup, and every board of the
 * hall got 429 for five minutes on /api/display/live and on the WebSocket
 * code subscription.
 *
 *   - a page of another site counts on a bucket of its own (server.js
 *     displayLookupKey): the native boards (no Origin) and the board page
 *     (our own origin) keep their budget, new boards included
 *   - a code the address resolved before resolves over the wrong-code budget
 *     too (lib/displayCodes.js resolve), polling over HTTP and reconnecting
 *     over the WebSocket; a code it never resolved is still refused there,
 *     before any comparison
 *   - boards on other sites keep the HTTP feed (CORS *, text/plain)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootServer, openSocket } from './helpers/e2eServer.js'

describe('scoreboard codes: wrong codes do not stop a hall\'s boards (cloud relay)', () => {
  let srv
  const sockets = []
  before(async () => { srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }, ['--local']) })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  const post = (endpoint, code, ip, { origin, type = 'application/json' } = {}) => fetch(`${srv.base}/api/display/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'cf-connecting-ip': ip, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ code })
  })
  const sync = (c, room, gamePin) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: { id: 1, seed_key: room, status: 'live', gameNumber: 7621, refereeConnectionEnabled: false, gamePin },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 4, awayPoints: 2, finished: false }],
    events: [],
    _timestamp: Date.now()
  })
  const setCode = async (room, code, gamePin, ip) => {
    const scorer = await open(ip)
    sync(scorer, room, gamePin)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000, 'display-presence')
    scorer.send({ type: 'display-code-set', matchId: room, code, issuedAt: Date.now() })
    await scorer.waitFor((m) => m.type === 'display-code-state' && m.active === true, 5000, 'display-code-state')
  }
  const HALL = '198.51.100.40'
  const roomA = `origin-a-${Date.now().toString(36)}`
  const roomB = `origin-b-${Date.now().toString(36)}`

  before(async () => {
    await setCode(roomA, 'MNPQ3456', '736251', '203.0.113.40')
    await setCode(roomB, 'RSTU5678', '736252', '203.0.113.41')
  })

  it('a page of another site spends only its own budget: the hall\'s boards, new ones too, go on', async () => {
    // the polling board of the hall follows room A
    assert.equal((await post('live', 'MNPQ3456', HALL)).status, 200)
    // a page of another site on a phone of the hall: 20 wrong codes, then refused
    for (let i = 0; i < 20; i++) {
      assert.equal((await post('lookup', 'ZZZZZZZZ', HALL, { origin: 'https://evil.example', type: 'text/plain;charset=UTF-8' })).status, 404)
    }
    const refused = await post('lookup', 'ZZZZZZZZ', HALL, { origin: 'https://evil.example', type: 'text/plain;charset=UTF-8' })
    assert.equal(refused.status, 429)
    assert.equal((await post('lookup', 'RSTU5678', HALL, { origin: 'https://other-board.example' })).status, 429, 'other sites share one bucket per address')
    // the hall's boards: the polling one, a new one (room B), a board page of our own origin
    assert.equal((await post('live', 'MNPQ3456', HALL)).status, 200)
    assert.equal((await post('lookup', 'RSTU5678', HALL)).status, 200, 'a new native board of the hall')
    const own = await post('lookup', 'MNPQ3456', HALL, { origin: 'https://livescore.openvolley.app' })
    assert.equal(own.status, 200, 'the board page (our own origin)')
    const ws = await open(HALL)
    ws.send({ type: 'subscribe-match', code: 'MNPQ3456', device: 'display' })
    const answer = await ws.waitFor((m) => m.type === 'display-code', 5000, 'display-code')
    assert.equal(answer.ok, true)
    assert.equal(answer.matchId, roomA)
  })

  it('wrong codes from the address itself: the codes it resolved before still resolve, no other code is compared', async () => {
    const ip = '198.51.100.41'
    assert.equal((await post('live', 'MNPQ3456', ip)).status, 200)
    const board = await open(ip)
    board.send({ type: 'subscribe-match', code: 'MNPQ3456', device: 'display' })
    assert.equal((await board.waitFor((m) => m.type === 'display-code', 5000, 'display-code')).ok, true)
    for (let i = 0; i < 20; i++) assert.equal((await post('lookup', 'ZZZZZZZY', ip)).status, 404)
    assert.equal((await post('lookup', 'ZZZZZZZY', ip)).status, 429)
    // a correct code after 20 wrong ones from the same address
    const again = await post('live', 'MNPQ3456', ip)
    assert.equal(again.status, 200)
    assert.equal((await again.json()).matchId, roomA)
    // the board reconnecting: its code again on a new socket
    const reconnect = await open(ip)
    reconnect.send({ type: 'subscribe-match', code: 'MNPQ3456', device: 'display' })
    assert.equal((await reconnect.waitFor((m) => m.type === 'display-code', 5000, 'display-code')).ok, true)
    // a code this address never resolved: refused before any comparison
    const other = await post('lookup', 'RSTU5678', ip)
    assert.equal(other.status, 429)
    assert.ok(Number(other.headers.get('retry-after')) > 0)
  })

  it('boards on other sites keep the HTTP feed (CORS *, text/plain without a preflight)', async () => {
    const r = await post('live', 'MNPQ3456', '198.51.100.42', { origin: 'https://club.example', type: 'text/plain;charset=UTF-8' })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.equal((await r.json()).matchId, roomA)
  })
})
