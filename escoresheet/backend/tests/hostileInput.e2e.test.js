/**
 * Hostile input on every anonymous route and every role-socket message type,
 * end to end: server.js against a real Postgres (PG_TEST_URL, or
 * OV_E2E_DOCKER=1; see tests/server.e2e.test.js), and as a venue relay
 * (--local, no database).
 *
 * Each route gets prototype keys (__proto__, constructor, toString) as query
 * values, path segments, header values and body keys, objects where a string
 * or number belongs ({ toString: 1 }), arrays, numbers, huge strings and
 * deeply nested values. Each socket message type gets the same in its fields,
 * and a sync whose PINs are objects is followed by a GET with a match PIN.
 *
 * The server must answer every request without a 5xx, never reach its
 * request error boundary (a route that threw), keep answering /health/live,
 * and keep its process: an anonymous request that ended it lost every relay
 * room, PIN budget and sign-in lockout on match day.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKIP, bootServer, openSocket, provisionDatabase, sleep } from './helpers/e2eServer.js'

const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']

// Values a field can get instead of the string or number it expects
const HOSTILE_VALUES = [
  ...PROTO_NAMES,
  { toString: 1, valueOf: 1 },
  { constructor: { prototype: { polluted: true } } },
  JSON.parse('{"__proto__": {"polluted": true}}'),
  [],
  ['a', 'b'],
  [{ toString: 1 }],
  -1,
  1e308,
  0.5,
  true,
  null,
  'x'.repeat(64 * 1024),
  nested(100)
]

// The field names the anonymous routes and the socket messages read
const FIELDS = [
  'pin', 'type', 'role', 'team', 'matchId', 'match_id', 'id', 'gameNumber', 'game_number', 'seed_key', 'externalId',
  'email', 'password', 'code', 'token', 'k', 'slot', 'lang', 'name', 'message', 'subject', 'metadata', 'redirectTo',
  'table', 'action', 'params', 'fn', 'args', 'entries', 'revisions', 'roster', 'side', 'data', 'match', 'liveState',
  'events', 'sets', 'homeTeam', 'awayTeam', 'device', 'requestId', 'updates', 'pad', 'strokes', 'federation', 'league',
  'gamePin', 'refereePin', 'homeTeamPin', 'awayTeamPin', 'matches', 'ids'
]

function nested(depth) {
  let v = { leaf: 1 }
  for (let i = 0; i < depth; i++) v = { a: v }
  return v
}

/** Bodies for a JSON route: hostile values in every field, prototype keys, non-objects, huge and deep. */
function hostileBodies() {
  const bodies = HOSTILE_VALUES.map((v) => JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, v]))))
  bodies.push(
    '{"__proto__": {"admin": true, "roles": ["admin"]}, "constructor": {"prototype": {"admin": true}}}',
    '{"toString": 1, "valueOf": 1, "hasOwnProperty": 1}',
    '[]', '[1,2,3]', '1', '"text"', 'null', 'true', '{', '{"a":',
    JSON.stringify({ blob: 'y'.repeat(900 * 1024) }),
    // deeper than any parser limit of ours (JSON.parse itself copes)
    '['.repeat(5000) + ']'.repeat(5000)
  )
  return bodies
}

const hostileQuery = (v) => FIELDS.map((f) => `${f}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`).join('&')
// ?a=1&a=2 (searchParams.getAll) and a[b]=c (the qs shape some apps send)
const ARRAY_QUERY = FIELDS.map((f) => `${f}=1&${f}=2&${f}[__proto__]=x`).join('&')

// Anonymous routes. `:x` is replaced by each prototype name; GET routes get
// hostile queries, the others hostile bodies.
const GET_ROUTES = [
  '/health/live', '/api/server/status', '/api/server/connections',
  '/api/official-matches', '/api/official-matches/leagues',
  '/api/match/list', '/api/match/:x', '/api/match/by-game-number', '/api/match/known',
  '/api/public/clubs', '/api/public/beach/t/:x',
  '/api/public/v1/matches', '/api/public/v1/matches/:x', '/api/public/v1/matches/:x/live', '/api/public/v1/matches/:x/stats',
  '/api/scoresheet-view/:x', '/api/storage/:x', '/api/storage/backup/:x/:x',
  '/api/games/today', '/api/me', '/api/settings', '/api/notifications', '/api/account/invite-preview',
  '/embed/livescore.js', '/sign', '/api/:x', '/:x'
]
const POST_ROUTES = [
  '/api/match/validate-pin', '/api/match/validate-connection-pin', '/api/match/restore-by-pin', '/api/match/restore',
  '/api/match/claim', '/api/match/known', '/api/match/official-check', '/api/match/send-info', '/api/match/scorer',
  '/api/match/upload-roster', '/api/match/event-revisions', '/api/db', '/api/db/rpc', '/api/activity', '/api/contact',
  '/api/account/join', '/api/account/redeem-invite', '/api/account/invite-preview',
  '/api/auth/sign-up', '/api/auth/sign-in', '/api/auth/reset-password', '/api/auth/resend-confirmation',
  '/api/auth/confirm-email', '/api/auth/get-user', '/api/auth/sign-out', '/api/auth/:x',
  '/api/sign/start', '/api/sign/open', '/api/sign/submit', '/api/sign/wait', '/api/sign/close',
  '/api/scoresheet/test-mail', '/api/storage/:x'
]
const PATCH_ROUTES = ['/api/match/:x']

// The test server has no mailer: reset-password answers 503 "temporarily
// unavailable" (lib/auth.js), whatever the body
const NO_MAILER_503 = new Set(['/api/auth/reset-password'])

const expand = (route) => route.includes(':x') ? PROTO_NAMES.map((n) => route.replaceAll(':x', encodeURIComponent(n))) : [route]

// The socket message types of the role relay (server.js handleSocketMessage)
const SOCKET_TYPES = [
  'join_match', 'leave_match', 'match_update', 'sync-match-data', 'match-action', 'action', 'live-state-update',
  'clear-all-matches', 'delete-match', 'subscribe-match', 'unsubscribe-match', 'bench-request', 'bench-response',
  ...PROTO_NAMES
]

/**
 * `noDatabase`: the venue relay answers the account and database routes 503
 * (no database here), a defined answer like a 4xx.
 */
function hostileHarness(getSrv, { noDatabase = false } = {}) {
  let ipSeq = 0
  // a fresh address per request: rate limits answer 429 (fine), but the
  // other cases of a route should still be reached
  const nextIp = () => { ipSeq++; return `203.0.${(ipSeq >> 8) & 255}.${ipSeq & 255}` }
  const problems = []

  async function call(method, path, { body, headers = {} } = {}) {
    const srv = getSrv()
    try {
      const res = await fetch(srv.base + path, {
        method,
        headers: { 'cf-connecting-ip': nextIp(), 'X-OV-Proto': '2', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body
      })
      await res.arrayBuffer().catch(() => {})
      if (res.status >= 500 && !(res.status === 503 && (noDatabase || NO_MAILER_503.has(path.split('?')[0])))) {
        problems.push(`${method} ${path.slice(0, 120)} -> ${res.status} (body ${String(body ?? '').slice(0, 60)})`)
      }
      return res.status
    } catch (err) {
      // A body over the route's limit is answered 413 and the connection
      // closed while the upload still runs: the client may see only the close
      if (String(body ?? '').length > 64 * 1024 && ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(err.cause?.code)) return 0
      problems.push(`${method} ${path.slice(0, 120)} -> no answer: ${err.cause?.code || err.message}`)
      return 0
    }
  }

  async function stillUp(after) {
    const srv = getSrv()
    const r = await fetch(`${srv.base}/health/live`).catch((err) => ({ ok: false, status: err.cause?.code || err.message }))
    assert.ok(r.ok, `the server stopped answering after ${after}: ${r.status}\n${srv.output.join('').slice(-3000)}`)
  }

  /** Lines of the request error boundary (server.js createServer): a route threw. */
  const boundaryHits = () => getSrv().output.join('').split('\n').filter((l) => /^❌ [A-Z]+ \S+ failed:/.test(l))

  return {
    problems,
    stillUp,
    boundaryHits,
    async getRoutes() {
      problems.length = 0
      // Node refuses a request head over 16 KB itself: the long values stay under it
      const queries = [
        ...HOSTILE_VALUES.filter((v) => typeof v !== 'object' || v === null).map((v) => hostileQuery(typeof v === 'string' ? v.slice(0, 200) : v)),
        hostileQuery({ toString: 1 }), hostileQuery(nested(20)), ARRAY_QUERY, `q=${'x'.repeat(12 * 1024)}`
      ]
      for (const route of GET_ROUTES) {
        for (const path of expand(route)) {
          for (const q of queries) await call('GET', `${path}?${q}`)
          await call('GET', path, { headers: { 'X-OV-Match-Pin': '[object Object]', 'X-OV-Match-Token': '__proto__', Authorization: 'Bearer __proto__' } })
          await call('GET', path, { headers: { 'X-OV-Match-Pin': 'p'.repeat(6 * 1024), Authorization: `Bearer ${'t'.repeat(6 * 1024)}` } })
        }
        await stillUp(`GET ${route}`)
      }
    },
    async bodyRoutes() {
      problems.length = 0
      const bodies = hostileBodies()
      for (const [method, routes] of [['POST', POST_ROUTES], ['PATCH', PATCH_ROUTES]]) {
        for (const route of routes) {
          for (const path of expand(route)) {
            for (const body of bodies) await call(method, path, { body })
            await call(method, path, { body: '{"pin":"123456"}', headers: { 'Content-Type': 'text/plain' } })
            await call(method, path, { body: '{}', headers: { 'X-OV-Match-Pin': '__proto__', Authorization: 'Bearer constructor' } })
            await call(method, `${path}?${ARRAY_QUERY}`, { body: '{}' })
          }
          await stillUp(`${method} ${route}`)
        }
      }
    },
    async sockets() {
      problems.length = 0
      const srv = getSrv()
      // One socket per message type: the relay may refuse or close a socket
      // that sends garbage (rate and frame budgets), that is an answer too.
      // It must not leave it hanging: a ping is answered or the socket closed.
      const hostileSocket = async (what, frames, url = srv.wsUrl) => {
        const sock = await openSocket(url)
        const closed = new Promise((r) => sock.ws.once('close', () => r('closed')))
        for (const f of frames) if (sock.ws.readyState === 1) sock.ws.send(typeof f === 'string' ? f : JSON.stringify(f))
        if (sock.ws.readyState === 1) sock.send({ type: 'ping' })
        const outcome = await Promise.race([closed, sock.waitFor((m) => m.type === 'pong', 10000, 'pong').then(() => 'pong', () => 'nothing')])
        if (outcome === 'nothing') problems.push(`socket ${what}: neither a pong nor a close`)
        sock.ws.close()
      }
      for (const type of SOCKET_TYPES) {
        const frames = HOSTILE_VALUES.map((v) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, v])), type }))
        frames.push(
          `{"type":${JSON.stringify(type)},"__proto__":{"scoreboard":true},"constructor":{"prototype":{"x":1}}}`,
          { type, matchId: '__proto__', match: { id: '__proto__', seed_key: 'constructor', gamePin: { toString: 1 } } }
        )
        await hostileSocket(type, frames)
      }
      // not JSON, not an object, too deep
      await hostileSocket('raw frames', ['{', 'null', '[]', '1', '"ping"', '['.repeat(5000) + ']'.repeat(5000)])
      await stillUp('the hostile socket messages')
      const fresh = await openSocket(srv.wsUrl)
      fresh.send({ type: 'ping' })
      await fresh.waitFor((m) => m.type === 'pong', 10000, 'pong of a new socket after the hostile ones')
      fresh.ws.close()

      // A sync whose PINs are objects, then the match read with a match PIN:
      // the PIN compare of GET /api/match/:id must not throw on them
      const board = await openSocket(srv.wsUrl)
      const seed = `seed-hostile-${Date.now()}`
      try {
        board.send({
          type: 'sync-match-data', matchId: 41, _timestamp: Date.now(),
          match: { id: 41, seed_key: seed, gameNumber: 4141, status: 'live', refereeConnectionEnabled: true, gamePin: { toString: 1 }, refereePin: { valueOf: 1 }, homeTeamPin: ['414141'], awayTeamPin: 414141 },
          homeTeam: { name: 'Home VC', toString: 1 }, awayTeam: { name: { __proto__: 1 } }, homePlayers: [{ toString: 1 }], awayPlayers: {}, sets: 'x', events: { length: 1e9 }
        })
        board.send({ type: 'live-state-update', matchId: 41, liveState: { blob: 'z'.repeat(300 * 1024) } })
        board.send({ type: 'live-state-update', matchId: 41, liveState: { constructor: { prototype: 1 }, points_a: { toString: 1 } } })
        board.send({ type: 'ping' })
        await board.waitFor((m) => m.type === 'pong', 10000, 'pong after the hostile sync')
        for (const id of [seed, '41', '__proto__', 'constructor']) {
          for (const pin of ['[object Object]', '414141', '__proto__', 'constructor', '1']) {
            await call('GET', `/api/match/${encodeURIComponent(id)}`, { headers: { 'X-OV-Match-Pin': pin } })
          }
          await call('GET', `/api/match/by-game-number?gameNumber=4141`, { headers: { 'X-OV-Match-Pin': '[object Object]' } })
        }
        await call('POST', '/api/match/validate-pin', { body: JSON.stringify({ pin: '414141', type: 'referee' }) })
        await call('POST', '/api/match/validate-pin', { body: JSON.stringify({ pin: { toString: 1 }, type: 'referee', matchId: seed }) })
        const viewer = await openSocket(srv.wsUrl)
        try {
          viewer.send({ type: 'subscribe-match', matchId: seed, pin: '[object Object]' })
          viewer.send({ type: 'subscribe-match', matchId: seed, pin: { toString: 1 } })
          viewer.send({ type: 'ping' })
          await viewer.waitFor((m) => m.type === 'pong', 10000, 'pong of the viewer')
        } finally {
          viewer.ws.close()
        }
      } finally {
        board.ws.close()
      }
      await stillUp('the sync with object PINs and the PIN reads')

      // A live state over the relay's cap is refused, not kept or sent on
      const owner = await openSocket(srv.wsUrl)
      try {
        owner.send({
          type: 'sync-match-data', matchId: 42, _timestamp: Date.now(),
          match: { id: 42, seed_key: `${seed}-cap`, gameNumber: 4242, status: 'live', gamePin: '424242' },
          homeTeam: { name: 'Home VC' }, awayTeam: { name: 'Away VC' }, homePlayers: [], awayPlayers: [], sets: [], events: []
        })
        owner.send({ type: 'ping' })
        await owner.waitFor((m) => m.type === 'pong', 10000, 'pong after the sync')
        owner.send({ type: 'live-state-update', matchId: 42, liveState: { blob: 'z'.repeat(300 * 1024) } })
        const refusal = await owner.waitFor((m) => m.type === 'error' && m.code === 'too-large', 10000, 'the live state refusal')
        assert.match(refusal.message, /Live state too large/)
      } finally {
        owner.ws.close()
      }

      // The live hub's socket (?purpose=live; the venue relay has none and
      // takes it as a role socket) gets the same in its own messages
      const liveFrames = HOSTILE_VALUES.flatMap((v) => [
        { type: 'subscribe-db', id: v, subs: v },
        { type: 'subscribe-db', id: 's1', subs: [{ table: v, filter: v, event: v, schema: v }] },
        { type: 'unsubscribe-db', id: v }
      ])
      await hostileSocket('live hub', liveFrames, `${srv.wsUrl}/?purpose=live`)
      await stillUp('the hostile live hub frames')
    }
  }
}

function hostileSuite(label, boot) {
  describe(label, { skip: label.includes('Postgres') ? SKIP : false }, () => {
    let ctx
    let harness

    before(async () => {
      ctx = await boot()
      harness = hostileHarness(() => ctx.srv, { noDatabase: ctx.noDatabase })
    })
    after(async () => { await ctx?.stop() })

    it('anonymous GET routes: prototype names, objects and huge values in queries, paths and headers', async () => {
      await harness.getRoutes()
      assert.deepEqual(harness.problems, [])
      assert.deepEqual(harness.boundaryHits(), [])
    })

    it('anonymous POST and PATCH routes: hostile bodies', async () => {
      await harness.bodyRoutes()
      assert.deepEqual(harness.problems, [])
      assert.deepEqual(harness.boundaryHits(), [])
    })

    it('every role-socket message type: hostile fields, object PINs, oversize live state', async () => {
      await harness.sockets()
      // the server process is still the one booted (no restart hid a crash)
      await sleep(200)
      await harness.stillUp('the socket tests')
      assert.deepEqual(harness.problems, [])
      assert.deepEqual(harness.boundaryHits(), [])
    })
  })
}

hostileSuite('hostile input: server.js with Postgres', async () => {
  const db = await provisionDatabase()
  const storageRoot = mkdtempSync(join(tmpdir(), 'ov-hostile-storage-'))
  writeFileSync(join(storageRoot, '.ovdata'), '')
  const statusDir = mkdtempSync(join(tmpdir(), 'ov-hostile-status-'))
  writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
  const srv = await bootServer({
    DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir,
    TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
  })
  return {
    srv,
    async stop() {
      await srv.stop()
      await db.drop()
      rmSync(storageRoot, { recursive: true, force: true })
      rmSync(statusDir, { recursive: true, force: true })
    }
  }
})

hostileSuite('hostile input: venue relay (--local, no database)', async () => {
  const srv = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' }, ['--local'])
  return { srv, noDatabase: true, stop: () => srv.stop() }
})
