/**
 * Scoreboard codes through the --local relay (backend/server.js): the wire
 * contract every relay runtime passes (tests/helpers/displayCodeContract.js,
 * docs/scoreboard-code-spec.md).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { runDisplayCodeContract } from './helpers/displayCodeContract.js'

describe('scoreboard codes: the --local relay', () => {
  let srv
  before(async () => {
    srv = await bootServer({}, ['--local'])
  })
  after(async () => {
    await srv?.stop()
  })

  it('the shared contract: set by the scorer, followed by code, public only, ended by a new code', async () => {
    await runDisplayCodeContract({ wsUrl: srv.wsUrl, httpBase: srv.base, openClient: (url) => openSocket(url), tag: 'node-local' })
  })
})

describe('scoreboard codes: the cloud relay (IS_CLOUD, addresses from Cloudflare)', () => {
  let srv
  const sockets = []
  before(async () => {
    srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }, ['--local'])
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  const post = (endpoint, body, ip, headers = {}) => fetch(`${srv.base}/api/display/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify(body)
  })
  const room = `cloud-code-${Date.now().toString(36)}`
  const sync = (c) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: { id: 1, seed_key: room, status: 'live', gameNumber: 7603, refereeConnectionEnabled: false, gamePin: '736251', refereePin: '847362' },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 4, awayPoints: 2, finished: false }],
    events: [],
    _timestamp: Date.now()
  })

  it('another network cannot list a match without the referee connection, but finds it by its code', async () => {
    const scorer = await open('203.0.113.10')
    sync(scorer)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000, 'display-presence')
    scorer.send({ type: 'display-code-set', matchId: room, code: 'MNPQ3456', issuedAt: Date.now() })
    await scorer.waitFor((m) => m.type === 'display-code-state' && m.active === true, 5000, 'display-code-state')

    const list = await (await fetch(`${srv.base}/api/match/list`, { headers: { 'cf-connecting-ip': '198.51.100.20' } })).json()
    assert.equal(list.matches.some((m) => m.id === room), false, 'not listed to another network (cloudListsMatch)')
    const own = await (await fetch(`${srv.base}/api/match/list`, { headers: { 'cf-connecting-ip': '203.0.113.10' } })).json()
    assert.equal(own.matches.some((m) => m.id === room), true, 'listed to its own venue')

    const look = await post('lookup', { code: 'mnpq-3456' }, '198.51.100.20', { Origin: 'https://board.example' })
    assert.equal(look.status, 200, 'a foreign site may look up (CORS *, no Origin refusal)')
    assert.equal(look.headers.get('access-control-allow-origin'), '*')
    assert.equal(look.headers.get('access-control-allow-credentials'), null)
    assert.equal((await look.json()).matchId, room)

    const board = await open('198.51.100.20')
    board.send({ type: 'subscribe-match', code: 'MNPQ3456', device: 'display' })
    const full = await board.waitFor((m) => m.type === 'match-full-data' && m.matchId === room, 5000, 'match-full-data')
    assert.equal(full.access, 'summary')
    assert.ok(!JSON.stringify(full).includes('736251'), 'no PIN')
    const pre = await fetch(`${srv.base}/api/display/live`, { method: 'OPTIONS', headers: { Origin: 'https://board.example', 'Access-Control-Request-Method': 'POST' } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  })

  it('wrong codes from one address are refused after 20, other addresses go on', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await post('lookup', { code: 'ZZZZZZZZ' }, '192.0.2.77')
      assert.equal(r.status, 404)
    }
    const blocked = await post('lookup', { code: 'MNPQ3456' }, '192.0.2.77')
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    // the same /64 is one address on the cloud
    const ws = await open('192.0.2.77')
    ws.send({ type: 'subscribe-match', code: 'MNPQ3456' })
    const answer = await ws.waitFor((m) => m.type === 'display-code', 5000, 'display-code')
    assert.equal(answer.reason, 'rate-limited')
    const other = await post('lookup', { code: 'MNPQ3456' }, '192.0.2.78')
    assert.equal(other.status, 200)
  })

  it('the code is never in the server log', () => {
    const log = srv.output.join('')
    assert.ok(/\[Display\] display\.set ref=[0-9a-f]{8} via=cloud/.test(log), 'one line per change, by ref')
    for (const c of ['MNPQ3456', 'MNPQ-3456', 'mnpq-3456', 'ZZZZZZZZ']) assert.ok(!log.includes(c), `no ${c} in the log`)
  })
})
