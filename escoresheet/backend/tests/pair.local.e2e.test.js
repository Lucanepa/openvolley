/**
 * Pair a phone on the LAN / SEA backend (server.js --local, no database;
 * docs/phone-keyboard-spec.md): the shared HTTP scenario from the relay host
 * (loopback), the phone page with its headers, no secret or typed text in the
 * server output, and from ANOTHER machine (TRUST_PROXY from loopback, so this
 * process speaks as hall devices at documentation addresses): no PIN -> 403,
 * the game PIN of a synced match from the scoring device that holds it -> 201
 * and a phone at yet another address joins, the same PIN from another device
 * -> 403, wrong PINs -> 403 and counted until 429.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { pairHttpScenario, pairPageCheck } from '../../frontend/electron/__fixtures__/pairHttpScenario.mjs'

const GAME_PIN = '987654'
const SEED = `e2e-pair-${randomBytes(3).toString('hex')}`
const CTX = { home: 'A', away: 'B' }
const SCORER_IP = '192.0.2.10'
const OTHER_IP = '192.0.2.11'
const PHONE_IP = '192.0.2.200'

async function postJson(base, path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function syncRoom(wsUrl, ip, matchId, gamePin) {
  const socket = await openSocket(wsUrl, { headers: { 'cf-connecting-ip': ip } })
  socket.send({
    type: 'sync-match-data',
    matchId,
    match: { id: 1, seed_key: matchId, status: 'live', gamePin, refereePin: '314159', refereeConnectionEnabled: true },
    homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [], awayPlayers: [], sets: [], events: []
  })
  await new Promise((r) => setTimeout(r, 300))
  return socket
}

describe('Pair a phone, backend --local', () => {
  let srv
  before(async () => { srv = await bootServer({}, ['--local']) })
  after(async () => { await srv?.stop() })

  it('speaks the shared protocol from the relay host', async () => {
    assert.deepEqual(await pairHttpScenario({ httpBase: srv.base }), [])
  })

  it('serves the phone page with its headers', async () => {
    assert.deepEqual(await pairPageCheck({ httpBase: srv.base, expectBody: 'OpenVolley' }), [])
  })

  it('logs no secret, code, context or typed text', async () => {
    const s = await postJson(srv.base, '/api/pair/start', { context: { home: 'Marker Club', away: 'B' } })
    const { token, watch, code } = s.json
    const j = await postJson(srv.base, '/api/pair/join', { k: token })
    const phone = j.json.phone
    await postJson(srv.base, '/api/pair/focus', { watch, field: { id: 'f', label: 'Marker label', text: 'Marker text' } })
    await postJson(srv.base, '/api/pair/input', { phone, n: 1, field: 'f', text: 'Typed marker words' })
    await postJson(srv.base, '/api/pair/close', { watch })
    const out = srv.output.join('')
    assert.ok(/pair\.start ref=[0-9a-f]{8} via=lan/.test(out), out.slice(-2000))
    assert.ok(/pair\.join ref=[0-9a-f]{8} via=lan/.test(out), out.slice(-2000))
    for (const secret of [token, watch, code, phone, 'Marker']) assert.ok(!out.includes(secret), `server output contains ${secret}`)
  })

  it('another machine needs the game PIN of the match its own scoreboard holds; wrong PINs are counted', async () => {
    const remote = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' }, ['--local'])
    const sockets = []
    try {
      sockets.push(await syncRoom(remote.wsUrl, SCORER_IP, SEED, GAME_PIN))
      const start = (pin, { matchKey = SEED, ip = SCORER_IP } = {}) => postJson(remote.base, '/api/pair/start', { matchKey, context: CTX },
        { 'cf-connecting-ip': ip, ...(pin ? { 'X-OV-Match-Pin': pin } : {}) })
      const none = await start(null)
      assert.equal(none.status, 403)
      assert.equal(none.json.code, 'OV_PAIR_FORBIDDEN')
      assert.equal((await start(GAME_PIN, { matchKey: 'not-on-this-relay' })).json.code, 'OV_PAIR_FORBIDDEN')
      const ok = await start(GAME_PIN)
      assert.equal(ok.status, 201, JSON.stringify(ok))
      // the phone is another machine: the token alone lets it in, once
      const joined = await postJson(remote.base, '/api/pair/join', { code: ok.json.code }, { 'cf-connecting-ip': PHONE_IP })
      assert.equal(joined.json.state, 'paired')
      const again = await postJson(remote.base, '/api/pair/join', { k: ok.json.token }, { 'cf-connecting-ip': '192.0.2.201' })
      assert.equal(again.json.code, 'OV_PAIR_USED')
      const other = await start(GAME_PIN, { ip: OTHER_IP })
      assert.equal(other.status, 403)
      assert.equal(other.json.code, 'OV_PAIR_FORBIDDEN')
      // five live pairings per address at most
      for (let i = 0; i < 4; i++) assert.equal((await start(GAME_PIN)).status, 201)
      const capped = await start(GAME_PIN)
      assert.equal(capped.status, 429)
      assert.equal(capped.json.code, 'OV_PAIR_RATE_LIMITED')
      for (let i = 0; i < 20; i++) {
        const r = await start(String(100000 + i))
        assert.equal(r.status, 403)
        assert.equal(r.json.code, 'OV_PAIR_PIN_INVALID')
      }
      const blocked = await start(GAME_PIN)
      assert.equal(blocked.status, 429)
      assert.equal(blocked.json.code, 'OV_PAIR_RATE_LIMITED')
    } finally {
      for (const socket of sockets) socket.ws.close()
      await remote.stop()
    }
  })
})
