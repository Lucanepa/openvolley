// The scorer answers 'seen' to every pending bench-request on its one relay
// socket: those answers have their own budget, so bench traffic cannot push
// the scorer's socket over its 120 messages a minute.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { bootServer } from './helpers/e2eServer.js'

function openClient (url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const client = { ws, messages: [], closed: null }
    client.send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)) }
    client.waitFor = (pred, timeoutMs = 4000) => new Promise((ok, fail) => {
      const found = client.messages.find(pred)
      if (found) return ok(found)
      const timer = setTimeout(() => { ws.off('message', check); fail(new Error('timed out waiting for message')) }, timeoutMs)
      const check = () => {
        const m = client.messages.find(pred)
        if (m) {
          clearTimeout(timer)
          ws.off('message', check)
          ok(m)
        }
      }
      ws.on('message', check)
    })
    ws.on('message', (data) => client.messages.push(JSON.parse(data.toString())))
    ws.on('close', (code, reason) => { client.closed = { code, reason: reason.toString() } })
    ws.once('open', () => client.waitFor((m) => m.type === 'connected').then(() => res(client), rej))
    ws.once('error', rej)
  })
}

const PINS = Object.freeze({
  gamePin: '402719',
  refereePin: '513820',
  homeTeamPin: '624931',
  awayTeamPin: '735042'
})

function syncMessage (seed, over = {}, sets = [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }]) {
  return {
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: seed,
      status: 'live',
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      ...PINS,
      ...over
    },
    homeTeam: { id: 1, name: 'Team H' },
    awayTeam: { id: 2, name: 'Team A' },
    homePlayers: [4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: n, teamId: 1, number: n })),
    awayPlayers: [1, 2, 3, 12, 13, 14].map((n) => ({ id: 100 + n, teamId: 2, number: n })),
    sets,
    events: [],
    _timestamp: Date.now()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


test('bench requests do not get the scorer socket closed by its seen answers', async () => {
  const srv = await bootServer({}, ['--local'])
  const { wsUrl } = srv
  try {
    const seed = `delta-br-dos-${Date.now().toString(36)}`
    const scorer = await openClient(wsUrl)
    // The scorer app's bridge: every pending bench-request is answered 'seen'
    // on the same socket (useBenchRequestBridge.js:81)
    let seenSent = 0
    scorer.ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.type === 'bench-request' && m.request?.kind !== 'cancel' && m.status === 'pending') {
        scorer.send({ type: 'bench-response', matchId: seed, team: m.team, id: m.request.id, status: 'seen' })
        seenSent++
      }
    })
    scorer.send(syncMessage(seed))
    await sleep(300)
    // Five sockets with the home bench PIN (one device can open them all)
    const benches = []
    for (let i = 0; i < 5; i++) {
      const b = await openClient(wsUrl)
      b.send({ type: 'subscribe-match', matchId: seed, pin: PINS.homeTeamPin, device: 'bench', team: 'home' })
      await b.waitFor((m) => m.type === 'bench-request-state')
      benches.push(b)
    }
    // 26 time-out requests per bench socket (under its own 30/min bench limit);
    // each new one supersedes the open one, so the scorer's queue stays at one card
    let n = 0
    for (let k = 0; k < 26; k++) {
      for (const b of benches) b.send({ type: 'bench-request', matchId: seed, team: 'home', request: { id: `t-${++n}`, kind: 'timeout', setIndex: 1 } })
      await sleep(20)
    }
    await sleep(1500)
    const acks = benches.reduce((s, b) => s + b.messages.filter((m) => m.type === 'bench-request-ack').length, 0)
    const refused = benches.reduce((s, b) => s + b.messages.filter((m) => m.type === 'error').length, 0)
    assert.ok(seenSent > 120, `the scorer answered ${seenSent} requests`)
    assert.equal(scorer.closed, null, 'the scorer socket stays open')
    // and still relays its own traffic
    scorer.send({ type: 'ping' })
    await sleep(100)
    assert.equal(scorer.closed, null)
    void acks; void refused
    for (const b of benches) b.ws.close()
  } finally {
    await srv.stop()
  }
})
