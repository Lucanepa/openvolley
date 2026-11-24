/**
 * Who a room's proof protects at the cloud relay's caps (server.js
 * protectedSockets, review of the audit 2611 SEC-04 fix), with a database:
 *
 *   - only a room the DATABASE proved protects its sockets (its scorer
 *     synced the game PIN of the match's row): anyone may sync a made-up
 *     room with a game PIN of their choice, and every socket that sends that
 *     PIN owns it. 2000 sockets of one /56 "proved" their own room, were
 *     never pushed out, were left out of the /56 caps, and every scorer,
 *     referee and bench socket was refused with 1013;
 *   - and only its first ROOM_PROTECTED_OWNERS owners (4) and
 *     ROOM_PROTECTED_FOLLOWERS others: one game PIN does not protect
 *     thousands of sockets;
 *   - a hall's PIN-less board (Point Hub following its cloud match) that
 *     connected before a flood of one socket per network, each parked in a
 *     made-up room, keeps its socket; the parked ones are closed as idle.
 *
 * Boots server.js against Postgres (PG_TEST_URL) as the cloud does, with a
 * small OV_MAX_CONNECTIONS.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import WebSocket from 'ws'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '824613'
const PINS = { referee: '461302', bench_home: '730214', bench_away: '519027' }

/** A socket from `ip`: { ok, ws, messages, closed } once it was greeted or closed. */
function open(url, ip) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'cf-connecting-ip': ip } })
    const s = { ws, ip, messages: [], closed: null, ok: false }
    s.send = (m) => ws.send(JSON.stringify(m))
    let done = false
    const fin = () => { if (!done) { done = true; resolve(s) } }
    ws.on('message', (d) => {
      try { s.messages.push(JSON.parse(d.toString())) } catch { /* ignore */ }
      if (s.messages[0]?.type === 'connected') s.ok = true
      fin()
    })
    ws.on('close', (code, reason) => { s.closed = { code, reason: reason.toString() }; fin() })
    ws.on('error', () => fin())
  })
}
const isOpen = (s) => s.ok && s.closed === null && s.ws.readyState === WebSocket.OPEN
const until = (s, pred, what) => waitUntil(() => s.messages.find(pred), { timeoutMs: 8000, what })
const in56 = (net, i) => `2001:db8:${net}:${(0x1000 + i).toString(16)}::1`

function sync(seed, { gamePin, refereePin = PINS.referee } = {}) {
  return {
    type: 'sync-match-data',
    matchId: seed,
    match: {
      id: 1, seed_key: seed, status: 'live', gamePin, refereePin,
      homeTeamPin: PINS.bench_home, awayTeamPin: PINS.bench_away,
      refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true
    },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: [],
    _timestamp: Date.now()
  }
}
/** The socket owns its room: the relay answered its first accepted sync. */
const owns = (s, seed) => until(s, (m) => m.type === 'display-presence' && m.matchId === seed, `${s.ip} owns ${seed}`)

describe('cloud relay with a database: only a room the database proved protects its sockets', { skip: SKIP }, () => {
  let db
  let sql
  let scorerToken
  const ext = `match_caps_${Date.now()}_${randomBytes(3).toString('hex')}`

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    const srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET })
    try {
      const email = `scorer-${randomBytes(3).toString('hex')}@example.ch`
      const headers = { 'cf-connecting-ip': '198.51.100.71' }
      assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password: 'correct-horse-battery' } })).status, 200)
      const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password: 'correct-horse-battery' } })
      await grantRoles(sql, inn.json.data.user.id, ['scorer'])
      scorerToken = inn.json.data.session.access_token
      const r = await api(srv.base, '/api/db', {
        token: scorerToken,
        headers,
        body: {
          table: 'matches',
          action: 'upsert',
          params: {
            data: {
              external_id: ext, game_n: 9601, game_pin: GAME_PIN, connection_pins: PINS,
              connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
              status: 'live', sport_type: 'indoor', home_team: { name: 'VBC Musterdorf' }, away_team: { name: 'Volley Beispiel' },
              scheduled_at: new Date().toISOString()
            },
            onConflict: 'external_id',
            returning: 'id',
            single: true
          }
        }
      })
      assert.equal(r.status, 200, r.text)
    } finally { await srv.stop() }
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  describe('sockets of one /56 that "prove" a room of their own', () => {
    let srv
    const all = []
    const connect = async (ip) => { const s = await open(srv.wsUrl, ip); all.push(s); return s }
    before(async () => {
      srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET, OV_MAX_CONNECTIONS: '40' })
    })
    after(async () => {
      for (const s of all) { try { s.ws.terminate() } catch { /* gone */ } }
      await srv?.stop()
    })

    it('hold no slot against a referee and a scorer of a real match; the flood\'s newcomer is refused', async () => {
      // the real match, proved against its database row
      const scorer = await connect('198.51.100.10')
      scorer.send(sync(ext, { gamePin: GAME_PIN }))
      await owns(scorer, ext)
      // the flood: every socket syncs the same self-made room with its own game PIN
      const flood = []
      for (let i = 0; i < 39; i++) {
        const s = await connect(in56(77, i))
        s.send(sync('atk-room-1', { gamePin: '111111', refereePin: '222222' }))
        flood.push(s)
      }
      await Promise.all(flood.map((s) => owns(s, 'atk-room-1')))
      assert.equal(all.filter(isOpen).length, 40, 'the relay is full')
      // a referee tablet of the real match, from another network
      const referee = await connect('203.0.113.50')
      assert.equal(isOpen(referee), true, 'the referee is admitted')
      referee.send({ type: 'subscribe-match', matchId: ext, role: 'referee', pin: PINS.referee })
      const full = await until(referee, (m) => m.type === 'match-full-data', 'the referee\'s bundle')
      assert.equal(full.access, 'full')
      await waitUntil(() => flood.filter((s) => s.closed).length === 1, { timeoutMs: 3000, what: 'one flood socket made room' })
      assert.equal(flood.at(-1).closed?.code, 1013, 'the flood\'s newest')
      // the scorer's tablet reconnecting (its first socket still open)
      const again = await connect('198.51.100.10')
      assert.equal(isOpen(again), true, 'the scorer\'s second socket is admitted')
      // the flood's newcomer: its network holds the most
      const more = await connect(in56(77, 100))
      assert.equal(more.closed?.code, 1013)
      assert.equal(isOpen(scorer) && isOpen(referee), true)
    })
  })

  describe('a hall\'s PIN-less board and a flood of one socket per network', () => {
    let srv
    const all = []
    const connect = async (ip) => { const s = await open(srv.wsUrl, ip); all.push(s); return s }
    before(async () => {
      srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET, OV_MAX_CONNECTIONS: '30', OV_ROLE_IDLE_MS: '1500' })
    })
    after(async () => {
      for (const s of all) { try { s.ws.terminate() } catch { /* gone */ } }
      await srv?.stop()
    })

    it('the board that connected first stays, the flood makes room for nobody and is closed as idle under load', async () => {
      const scorer = await connect('198.51.100.10')
      scorer.send(sync(ext, { gamePin: GAME_PIN }))
      await owns(scorer, ext)
      // Point Hub on "OpenVolley online": the hall's match, no PIN, no code, behind the hall's NAT
      const board = await connect('198.51.100.10')
      board.send({ type: 'subscribe-match', matchId: ext, device: 'display', settingsUrl: 'http://172.24.1.1:8890/#settings' })
      await until(board, (m) => m.type === 'match-full-data', 'the board\'s summary')
      // the reviewer's flood: one socket per IPv4 /24, parked in a made-up room
      const flood = []
      for (let i = 0; i < 35; i++) {
        const s = await connect(`203.0.${i}.7`)
        if (isOpen(s)) s.send({ type: 'subscribe-match', matchId: `nope-${i}` })
        flood.push(s)
        await sleep(10)
      }
      await sleep(300)
      assert.equal(isOpen(board), true, 'the board kept its socket')
      assert.equal(isOpen(scorer), true)
      assert.equal(flood.filter((s) => s.closed?.code === 1013).length >= 7, true, 'the flood past the cap was refused')
      // closed as idle while the relay is under load (above half its slots)
      await waitUntil(() => all.filter(isOpen).length <= 15, { timeoutMs: 8000, what: 'the parked sockets closed as idle' })
      assert.ok(flood.some((s) => s.closed?.reason === 'Idle connection closed, retry shortly'))
      assert.equal(isOpen(board) && isOpen(scorer), true)
    })
  })

  describe('one game PIN protects a room\'s first owners only', () => {
    let srv
    const all = []
    const connect = async (ip) => { const s = await open(srv.wsUrl, ip); all.push(s); return s }
    before(async () => {
      srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET, OV_MAX_CONNECTIONS: '10' })
    })
    after(async () => {
      for (const s of all) { try { s.ws.terminate() } catch { /* gone */ } }
      await srv?.stop()
    })

    it('ten sockets with the real game PIN: the fifth and later make room for a referee of another network', async () => {
      const owners = []
      for (let i = 0; i < 10; i++) {
        const s = await connect(in56(66, i))
        s.send(sync(ext, { gamePin: GAME_PIN }))
        await owns(s, ext)
        owners.push(s)
      }
      await sleep(100)
      const referee = await connect('203.0.113.60')
      assert.equal(isOpen(referee), true, 'the referee is admitted')
      await waitUntil(() => owners.some((s) => s.closed), { timeoutMs: 3000, what: 'an owner made room' })
      assert.equal(owners.slice(0, 4).every(isOpen), true, 'the room\'s first four owners stay')
      assert.equal(owners.at(-1).closed?.code, 1013, 'the newest unprotected owner made room')
    })
  })
})
