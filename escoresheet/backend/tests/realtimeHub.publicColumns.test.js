/**
 * A live state's private columns (lib/publicColumns.js
 * LIVE_STATE_PRIVATE_COLUMNS: line-ups, substitutions, sanctions, the last
 * event's data, the scorer's alarm) on the live hub (audit 2611 PERM-03): an
 * anonymous subscribe-db on sport_type=indoor got them for every live match,
 * while anonymous /api/db and the relay's PIN-less summary leave them out.
 *
 *   - LIVE_COLUMNS.match_live_state is the public set; a channel gets the
 *     private columns of a row only when privateRows.grants says so, checked
 *     on every publish (unit part: the hub's mechanism)
 *   - server.js: the channel of a match token of that match; and, for the
 *     apps in the halls that send no token (OpenVolley 26.11.x, 3.x), a
 *     channel that follows that one match by its match_id, the only match
 *     its socket follows so, unless OV_LIVE_PRIVATE=token (end to end)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createRealtimeHub } from '../lib/realtimeHub.js'
import { redactSecrets } from '../lib/secrets.js'
import { projectLiveRow, projectLiveGrantedRow, LIVE_STATE_PRIVATE_COLUMNS } from '../lib/publicColumns.js'
import { SKIP, bootServer, api, openSocket, provisionDatabase, subscribe, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PRIVATE = {
  lineup_a: { I: { number: 7 }, II: { number: 4 } },
  subs_a: [{ playerIn: 12, playerOut: 7 }],
  sanctions_a: [{ type: 'yellow', player: 9 }],
  last_event_data: { playerNumber: 9 },
  scorer_attention_trigger: '2026-11-23T12:00:00.000Z'
}
const privateKeysOf = (row) => LIVE_STATE_PRIVATE_COLUMNS.filter((c) => row && row[c] != null)

class FakeSocket {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.handlers = {} }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn) }
  off() {}
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  terminate() { this.readyState = 3 }
  ping() {}
  deliver(msg) { for (const fn of this.handlers.message || []) fn(Buffer.from(JSON.stringify(msg)), false) }
  changes() { return this.sent.filter((m) => m.type === 'db-change') }
}

describe('realtimeHub: a live state\'s private columns only to a granted channel', () => {
  function hubWith(grants) {
    const hub = createRealtimeHub({
      redact: redactSecrets,
      project: projectLiveRow,
      privateRows: { project: projectLiveGrantedRow, grants },
      grantChannel: (msg) => (msg.token === 'ok' ? { ok: true } : null),
      pingIntervalMs: 0,
      channelGraceMs: 0,
      logger: { log() {}, warn() {} }
    })
    const socket = () => {
      const ws = new FakeSocket()
      hub.handleConnection(ws, null, { ip: '198.51.100.7' })
      return ws
    }
    const sub = (ws, id, subs, token) => {
      ws.deliver({ type: 'subscribe-db', id, subs, ...(token ? { token } : {}) })
      assert.equal(ws.sent.at(-1).type, 'subscribe-db-ack')
    }
    return { hub, socket, sub }
  }
  const row = (extra = {}) => ({ match_id: 'm-1', sport_type: 'indoor', points_a: 3, updated_at: '2026-11-23T12:00:00.000Z', game_pin: '123456', ...PRIVATE, ...extra })

  it('the public projection leaves them out; a granted channel gets them, asked on every publish', () => {
    let allowed = true
    const { hub, socket, sub } = hubWith((channel) => channel.grant?.ok === true && allowed)
    const anon = socket()
    sub(anon, 'all', [{ table: 'match_live_state', column: 'sport_type', value: 'indoor' }])
    const tablet = socket()
    sub(tablet, 'one', [{ table: 'match_live_state', column: 'match_id', value: 'm-1' }], 'ok')
    hub.broadcastDbChange('match_live_state', 'UPDATE', [row()])
    assert.deepEqual(privateKeysOf(anon.changes()[0].new), [])
    assert.equal(anon.changes()[0].new.points_a, 3)
    assert.deepEqual(privateKeysOf(tablet.changes()[0].new).sort(), Object.keys(PRIVATE).sort())
    assert.equal(JSON.stringify(tablet.sent).includes('123456'), false, 'a PIN never goes out')
    // the grant ends: the next publish goes out public
    allowed = false
    hub.broadcastDbChange('match_live_state', 'UPDATE', [row({ points_a: 4, updated_at: '2026-11-23T12:00:01.000Z' })])
    assert.deepEqual(privateKeysOf(tablet.changes()[1].new), [])
    hub.close()
  })

  it('a socket with a granted and a plain channel gets the row once, whole', () => {
    const { hub, socket, sub } = hubWith((channel) => channel.grant?.ok === true)
    const ws = socket()
    sub(ws, 'plain', [{ table: 'match_live_state', column: 'sport_type', value: 'indoor' }])
    sub(ws, 'granted', [{ table: 'match_live_state', column: 'match_id', value: 'm-1' }], 'ok')
    hub.broadcastDbChange('match_live_state', 'UPDATE', [row()])
    const frames = ws.changes()
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0].ids.sort(), ['granted', 'plain'])
    assert.equal(frames[0].new.lineup_a.I.number, 7)
    hub.close()
  })

  it('a change of a private column alone (the scorer\'s alarm at the same updated_at) still reaches a granted channel', () => {
    const { hub, socket, sub } = hubWith((channel) => channel.grant?.ok === true)
    const ws = socket()
    sub(ws, 'granted', [{ table: 'match_live_state', column: 'match_id', value: 'm-1' }], 'ok')
    hub.broadcastDbChange('match_live_state', 'UPDATE', [row()])
    hub.broadcastDbChange('match_live_state', 'UPDATE', [row({ scorer_attention_trigger: '2026-11-23T12:05:00.000Z' })])
    assert.equal(ws.changes().length, 2)
    assert.equal(ws.changes()[1].new.scorer_attention_trigger, '2026-11-23T12:05:00.000Z')
    hub.close()
  })
})

describe('server.js: who gets a live state\'s private columns (end to end)', { skip: SKIP }, () => {
  const PIN_SECRET = randomBytes(32).toString('base64url')
  const PINS = { referee: '461302', bench_home: '730214', bench_away: '519027' }
  const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  let db
  let sql
  let matchUuid
  let otherUuid
  let scorer

  async function boot(env = {}) {
    return bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET, ...env })
  }
  const upsertMatch = async (srv, externalId, gameN) => {
    const r = await api(srv.base, '/api/db', {
      token: scorer,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: externalId, game_n: gameN, game_pin: '824613', connection_pins: PINS,
            connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
            status: 'live', sport_type: 'indoor', home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' },
            scheduled_at: new Date().toISOString()
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(r.status, 200, r.text)
    return r.json.data.id
  }
  let seq = 0
  const pushLiveState = async (srv, matchId) => {
    seq++
    const r = await api(srv.base, '/api/db', {
      token: scorer,
      body: {
        table: 'match_live_state',
        action: 'upsert',
        params: { data: { match_id: matchId, sport_type: 'indoor', current_set: 1, points_a: seq, points_b: 0, ...PRIVATE, updated_at: new Date(Date.now() + seq * 1000).toISOString() }, onConflict: 'match_id' }
      }
    })
    assert.equal(r.status, 200, r.text)
    return seq
  }
  const frameOf = (c, n) => c.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.new.points_a === n, 5000, `live state ${n}`)
  const liveSocket = (srv, ip) => openSocket(`${srv.wsUrl}/?purpose=live`, { headers: { 'cf-connecting-ip': ip } })
  const subWith = async (c, id, subs, token) => {
    c.send({ type: 'subscribe-db', id, subs, ...(token ? { token } : {}) })
    const ack = await c.waitFor((m) => (m.type === 'subscribe-db-ack' || m.type === 'subscribe-db-error') && m.id === id, 5000, `ack ${id}`)
    assert.equal(ack.type, 'subscribe-db-ack', JSON.stringify(ack))
  }
  const byMatch = (id) => [{ table: 'match_live_state', event: '*', column: 'match_id', value: id }]

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    const srv = await boot()
    try {
      const email = `scorer-${randomBytes(3).toString('hex')}@example.ch`
      const headers = { 'cf-connecting-ip': '198.51.100.71' }
      assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password: 'correct-horse-battery' } })).status, 200)
      const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password: 'correct-horse-battery' } })
      await grantRoles(sql, inn.json.data.user.id, ['scorer'])
      scorer = inn.json.data.session.access_token
      matchUuid = await upsertMatch(srv, ext, 9501)
      otherUuid = await upsertMatch(srv, `${ext}_b`, 9502)
    } finally { await srv.stop() }
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  describe('the default (the apps in the halls send no token)', () => {
    let srv
    const sockets = []
    before(async () => { srv = await boot() })
    after(async () => {
      for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
      await srv?.stop()
    })

    it('sport_type=indoor gets the public columns only; one match by match_id or with its token gets them whole', async () => {
      const open = async (ip) => { const c = await liveSocket(srv, ip); sockets.push(c); return c }
      const wide = await open('203.0.113.77')
      await subscribe(wide, 'all-indoor', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
      // the referee page of an installed app: one match, by its match_id, two channels
      const referee = await open('203.0.113.78')
      await subscribe(referee, 'referee-alarm', byMatch(matchUuid))
      await subscribe(referee, 'refetch', [...byMatch(matchUuid), { table: 'sets', event: '*', column: 'match_id', value: matchUuid }])
      // a socket that follows two matches so: neither whole
      const scraper = await open('203.0.113.79')
      await subscribe(scraper, 'a', byMatch(matchUuid))
      await subscribe(scraper, 'b', byMatch(otherUuid))
      // a bench of a newer app: its match token on a socket that follows two matches
      const pin = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '203.0.113.80' }, body: { pin: PINS.bench_home, type: 'bench_home', matchExternalId: ext } })
      assert.equal(pin.status, 200, pin.text)
      const bench = await open('203.0.113.81')
      await subWith(bench, 'mine', byMatch(matchUuid), pin.json.token)
      await subscribe(bench, 'other', byMatch(otherUuid))
      // a forged token proves nothing
      const forged = await open('203.0.113.82')
      await subWith(forged, 'f', byMatch(matchUuid), pin.json.token.slice(0, -2) + 'AA')
      await subscribe(forged, 'g', byMatch(otherUuid))
      await sleep(300) // the token's match row is read once (liveChannelGrant)

      const n = await pushLiveState(srv, matchUuid)
      const frames = { wide: await frameOf(wide, n), referee: await frameOf(referee, n), scraper: await frameOf(scraper, n), bench: await frameOf(bench, n), forged: await frameOf(forged, n) }
      assert.deepEqual(privateKeysOf(frames.wide.new), [], 'sport_type=indoor')
      assert.equal(frames.wide.new.points_a, n)
      assert.deepEqual(privateKeysOf(frames.referee.new).sort(), Object.keys(PRIVATE).sort(), 'one match by match_id (the apps in the halls)')
      assert.deepEqual(privateKeysOf(frames.scraper.new), [], 'a socket that follows two matches')
      assert.deepEqual(privateKeysOf(frames.bench.new).sort(), Object.keys(PRIVATE).sort(), 'the match token')
      assert.deepEqual(privateKeysOf(frames.forged.new), [], 'a forged token')
      // the token grants its own match only
      const m = await pushLiveState(srv, otherUuid)
      assert.deepEqual(privateKeysOf((await frameOf(bench, m)).new), [])
    })

    it('a token whose bench connection was switched off grants nothing (the row read again)', async () => {
      const pin = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '203.0.113.90' }, body: { pin: PINS.bench_away, type: 'bench_away', matchExternalId: ext } })
      assert.equal(pin.status, 200, pin.text)
      const bench = await liveSocket(srv, '203.0.113.91')
      sockets.push(bench)
      await subWith(bench, 'mine', byMatch(matchUuid), pin.json.token)
      await subscribe(bench, 'other', byMatch(otherUuid))
      await sleep(300)
      const n = await pushLiveState(srv, matchUuid)
      assert.equal((await frameOf(bench, n)).new.lineup_a.I.number, 7)
      await sql.query("UPDATE matches SET connections = jsonb_set(connections::jsonb, '{away_bench_enabled}', 'false') WHERE id = $1", [matchUuid])
      try {
        // a new subscribe reads the row again at once
        await subWith(bench, 'mine', byMatch(matchUuid), pin.json.token)
        await sleep(300)
        const k = await pushLiveState(srv, matchUuid)
        assert.deepEqual(privateKeysOf((await frameOf(bench, k)).new), [])
      } finally {
        await sql.query("UPDATE matches SET connections = jsonb_set(connections::jsonb, '{away_bench_enabled}', 'true') WHERE id = $1", [matchUuid])
      }
    })
  })

  describe('OV_LIVE_PRIVATE=token: only the match token', () => {
    let srv
    const sockets = []
    before(async () => { srv = await boot({ OV_LIVE_PRIVATE: 'token' }) })
    after(async () => {
      for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
      await srv?.stop()
    })

    it('one match by match_id without a token gets the public columns; with its token, them whole', async () => {
      const plain = await liveSocket(srv, '203.0.113.95')
      sockets.push(plain)
      await subscribe(plain, 'one', byMatch(matchUuid))
      const pin = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '203.0.113.96' }, body: { pin: PINS.referee, type: 'referee', matchExternalId: ext } })
      const referee = await liveSocket(srv, '203.0.113.97')
      sockets.push(referee)
      await subWith(referee, 'one', byMatch(matchUuid), pin.json.token)
      await sleep(300)
      const n = await pushLiveState(srv, matchUuid)
      assert.deepEqual(privateKeysOf((await frameOf(plain, n)).new), [])
      assert.deepEqual(privateKeysOf((await frameOf(referee, n)).new).sort(), Object.keys(PRIVATE).sort())
    })
  })
})
