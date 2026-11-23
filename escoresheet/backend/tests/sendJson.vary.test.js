// SEC-20, the server's half: an answer to a request with an account's or a
// match's credentials (Authorization, X-OV-Match-Token, X-OV-Match-Pin) says
// Vary: Authorization and Cache-Control: no-store. A cache keyed on the URL
// alone (OpenBeach's deployed service worker kept /api/ answers 24 h) then
// never hands account A's /api/me or approvals to account B or to a
// signed-out request. The client half (no /api/ runtime cache) is OpenBeach's.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import WebSocket from 'ws'
import { bootServer } from './helpers/e2eServer.js'

/** A GET with these headers, the body as it came (fetch would decode it). */
const rawGet = (srv, path, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.port, path, headers }, (res) => {
    const chunks = []
    res.on('data', (d) => chunks.push(d))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  }).on('error', reject)
})

const varyOf = (res) => (res.headers.get('vary') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

describe('Vary and no-store on answers to credentialed requests', () => {
  let srv
  before(async () => { srv = await bootServer({ IS_CLOUD: '1' }, ['--local']) })
  after(async () => { await srv?.stop() })

  it('a Bearer request: Vary names Authorization (and Origin), Cache-Control no-store', async () => {
    const res = await fetch(`${srv.base}/api/match/list`, { headers: { Authorization: 'Bearer abc', Origin: 'https://beach.openvolley.app' } })
    await res.text()
    assert.ok(varyOf(res).includes('authorization'), res.headers.get('vary'))
    assert.ok(varyOf(res).includes('origin'), res.headers.get('vary'))
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('a match token or PIN is a credential too', async () => {
    for (const h of [{ 'X-OV-Match-Token': 'v1.x.y' }, { 'X-OV-Match-Pin': '123456' }]) {
      const res = await fetch(`${srv.base}/api/match/list`, { headers: h })
      await res.text()
      assert.equal(res.headers.get('cache-control'), 'no-store', JSON.stringify(h))
    }
  })

  it('an anonymous answer still varies by Authorization, and keeps its own caching', async () => {
    const res = await fetch(`${srv.base}/api/match/list`)
    await res.text()
    assert.ok(varyOf(res).includes('authorization'))
    assert.notEqual(res.headers.get('cache-control'), 'no-store')
  })

  it('a gzipped JSON answer keeps Origin and Authorization next to Accept-Encoding', async () => {
    // the venue relay's GET /api/match/:id with the referee PIN: the whole
    // room, gzipped above 8 KiB (sendJsonText), which wrote Vary: Accept-Encoding alone
    const venue = await bootServer({}, ['--local'])
    const ws = new WebSocket(venue.wsUrl)
    try {
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      const matchId = 'vary-test-1'
      const players = Array.from({ length: 14 }, (_, i) => ({ number: i + 1, firstName: `Player${i}`, lastName: 'X'.repeat(600) }))
      ws.send(JSON.stringify({
        type: 'sync-match-data', matchId,
        match: { id: matchId, gamePin: '123456', refereePin: '654321', refereeConnectionEnabled: true, status: 'live' },
        homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' }, homePlayers: players, awayPlayers: players, sets: [], events: []
      }))
      let res
      for (let i = 0; i < 40; i++) {
        res = await rawGet(venue, `/api/match/${matchId}`, { 'accept-encoding': 'gzip', 'x-ov-match-pin': '654321', origin: 'http://192.168.1.30:5173' })
        if (res.status === 200) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.equal(res.status, 200)
      assert.equal(res.headers['content-encoding'], 'gzip')
      const vary = String(res.headers.vary).split(',').map((s) => s.trim().toLowerCase())
      assert.deepEqual(vary, ['origin', 'authorization', 'accept-encoding'])
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.ok(JSON.parse(gunzipSync(res.body).toString('utf8')).success)
    } finally {
      ws.close()
      await venue.stop()
    }
  })
})
