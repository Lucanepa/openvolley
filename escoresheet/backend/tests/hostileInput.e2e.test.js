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
 *
 * The routes and socket types added since the first list (14.11; audit
 * SEC-59) have lists of their own: the TV, Global live / cloud / shared /
 * organizer, display codes, pair-a-phone, the error tracker, passkey login,
 * one route of every authenticated family (refused before it reads input,
 * which must not throw either), display-code-set and the server-to-client
 * types sent back. They are checked for no crash rather than exact codes, so
 * a defined 503 / 507 answer (JSON with an error code: a quota, an
 * unavailable service) passes. A test without a database fails when
 * server.js (or the endpoint modules it routes to) gets a path or socket
 * type that no list here reaches.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKIP, bootServer, openSocket, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { PAIR_ENDPOINTS } from '../lib/pairSessions.js'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// The fields the routes and socket types added since 14.11 read
const FIELDS_SINCE_1411 = [
  'court', 'screen', 'matchKey', 'match_external_id', 'text', 'value', 'field', 'secret', 'watch', 'phone', 'state',
  'courtToken', 'court_token', 'key', 'backup', 'pdf', 'fileBase64', 'stack', 'kind', 'view', 'url', 'release', 'app',
  'platform', 'breadcrumbs', 'context', 'errors', 'sport', 'teams', 'status', 'credential', 'response', 'challenge',
  'organizer', 'share', 'known', 'version', 'active', 'enabled', 'presence', 'globalLive', 'globalLiveScreen',
  'globalLiveShow', 'issuedAt', 'label', 'actionData'
]
const ALL_FIELDS = [...new Set([...FIELDS, ...FIELDS_SINCE_1411])]

function hostileBodiesOf(fields) {
  return [
    ...HOSTILE_VALUES.map((v) => JSON.stringify(Object.fromEntries(fields.map((f) => [f, v])))),
    ...hostileBodies().slice(HOSTILE_VALUES.length)
  ]
}

const hostileQuery = (v, fields = FIELDS) => fields.map((f) => `${f}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`).join('&')
// ?a=1&a=2 (searchParams.getAll) and a[b]=c (the qs shape some apps send)
const ARRAY_QUERY = FIELDS.map((f) => `${f}=1&${f}=2&${f}[__proto__]=x`).join('&')
const ARRAY_QUERY_ALL = ALL_FIELDS.map((f) => `${f}=1&${f}=2&${f}[__proto__]=x`).join('&')

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
  '/api/match/claim', '/api/match/known', '/api/match/official-check', '/api/match/send-info', '/api/match/send-pin', '/api/match/scorer',
  '/api/match/upload-roster', '/api/match/event-revisions', '/api/db', '/api/db/rpc', '/api/activity', '/api/contact',
  '/api/account/join', '/api/account/redeem-invite', '/api/account/invite-preview',
  '/api/auth/sign-up', '/api/auth/sign-in', '/api/auth/reset-password', '/api/auth/resend-confirmation',
  '/api/auth/confirm-email', '/api/auth/get-user', '/api/auth/sign-out', '/api/auth/:x',
  '/api/sign/start', '/api/sign/open', '/api/sign/submit', '/api/sign/wait', '/api/sign/close',
  '/api/scoresheet/test-mail', '/api/storage/:x'
]
const PATCH_ROUTES = ['/api/match/:x']

// Added since 14.11 (map/routes.json of ed07929ae, server.js), anonymous
const PAIR_ROUTES = PAIR_ENDPOINTS.map((e) => `/api/pair/${e}`)
const GET_ROUTES_SINCE_1411 = [
  '/health', '/tv', '/tv/', '/tv/go', '/tv/tv.js', '/tv/:x', '/tv/:x/:x', '/tv/1234567',
  '/api/global/live', '/api/global/live/:x', '/api/global/live/game/:x', '/api/global/live/ABCDEFGH', '/api/global/:x',
  '/api/global/shared/:x', '/api/global/shared/:x/pdf', '/api/global/organizer/:x', '/api/global/organizer/:x/:x/pdf',
  '/pair', '/pair/:x', '/sign/:x', '/embed/match/:x', '/embed/club/:x', '/embed/:x',
  '/api/public/v1/matches/:x/stream', '/api/display/lookup', '/api/errors', ...PAIR_ROUTES
]
const POST_ROUTES_SINCE_1411 = [
  '/api/display/lookup', '/api/display/live', ...PAIR_ROUTES, '/api/errors',
  '/api/global/live/:x', '/api/global/live/ABCDEFGH', '/api/global/save', '/api/global/load', '/api/global/:x',
  '/api/global/cloud/save', '/api/global/cloud/load', '/api/global/cloud/share', '/api/global/cloud/delete', '/api/global/cloud/:x',
  '/api/auth/passkey/login-options', '/api/auth/passkey/login', '/api/auth/reset-password/confirm'
]
// One route of each authenticated family: refused without an account, and
// the refusal must not throw on what it was sent either (the removed
// approval paths answer 410 to everyone)
const AUTH_FAMILY_ROUTES = [
  '/api/admin/:x', '/api/admin/activity/export', '/api/beach/:x', '/api/club/v1', '/api/club/v1/:x', '/api/club/:x',
  '/api/club-licences', '/api/club-licences/:x', '/api/game-rosters', '/api/game-rosters/:x', '/api/saved-teams',
  '/api/saved-teams/:x', '/api/scoresheets', '/api/scoresheets/:x', '/api/approvals', '/api/approvals/:x',
  '/api/account/approvals', '/api/account/approval-pin', '/api/account/approval-pin/remove', '/api/admin/approvals', '/api/match-editors/:x',
  '/api/team/:x', '/api/notifications/read', '/api/match/claim', '/api/match/scorer'
]

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
// Added since 14.11, and the server-to-client types a client may echo back
const SOCKET_TYPES_SINCE_1411 = [
  'display-code-set', 'display-presence', 'display-code', 'display-code-state', 'scorer-presence', 'scorer-moved',
  'match-full-data', 'match-data-update', 'joined_match', 'ping'
]

/**
 * A 5xx a route answers on purpose, never the error boundary's 500: 503 / 507
 * with a JSON error (unavailable, storage full), or /health's 503 with its
 * status (the test database is not production's: degraded by design).
 */
function definedServerAnswer(status, text, path) {
  if (status !== 503 && status !== 507) return false
  try {
    const j = JSON.parse(text)
    if (!j || typeof j !== 'object') return false
    if (path === '/health' && status === 503) return typeof j.status === 'string'
    return typeof j.code === 'string' || typeof j.error === 'string' ||
      (!!j.error && typeof j.error === 'object' && (typeof j.error.code === 'string' || typeof j.error.message === 'string'))
  } catch { return false }
}

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

  // `lenient` (the routes since 14.11): a defined 503 / 507 answer passes too
  async function call(method, path, { body, headers = {}, lenient = false } = {}) {
    const srv = getSrv()
    try {
      const res = await fetch(srv.base + path, {
        method,
        headers: { 'cf-connecting-ip': nextIp(), 'X-OV-Proto': '2', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body,
        // a route that never answers (or a stream it opened) is a problem too
        signal: AbortSignal.timeout(15000)
      })
      const text = lenient ? await res.text().catch(() => '') : (await res.arrayBuffer().catch(() => {}), '')
      if (res.status >= 500 && !(res.status === 503 && (noDatabase || NO_MAILER_503.has(path.split('?')[0]))) &&
          !(lenient && definedServerAnswer(res.status, text, path.split('?')[0]))) {
        problems.push(`${method} ${path.slice(0, 120)} -> ${res.status} (body ${String(body ?? '').slice(0, 60)})`)
      }
      return res.status
    } catch (err) {
      if (err.name === 'TimeoutError') {
        problems.push(`${method} ${path.slice(0, 120)} -> no answer in 15 s`)
        return 0
      }
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
    /** The routes since 14.11 and the authenticated families: GET with hostile queries and headers, POST with hostile bodies. */
    async routesSince1411() {
      problems.length = 0
      const queries = [
        ...HOSTILE_VALUES.filter((v) => typeof v !== 'object' || v === null).map((v) => hostileQuery(typeof v === 'string' ? v.slice(0, 100) : v, ALL_FIELDS)),
        hostileQuery({ toString: 1 }, ALL_FIELDS), hostileQuery(nested(20), ALL_FIELDS), ARRAY_QUERY_ALL, `q=${'x'.repeat(12 * 1024)}`
      ]
      const opts = { lenient: true }
      for (const route of [...GET_ROUTES_SINCE_1411, ...AUTH_FAMILY_ROUTES]) {
        for (const path of expand(route)) {
          for (const q of queries) await call('GET', `${path}?${q}`, opts)
          await call('GET', path, { ...opts, headers: { 'X-OV-Match-Pin': '[object Object]', 'X-OV-Match-Token': '__proto__', Authorization: 'Bearer __proto__' } })
          await call('GET', path, { ...opts, headers: { 'X-OV-Match-Pin': 'p'.repeat(6 * 1024), Authorization: `Bearer ${'t'.repeat(6 * 1024)}` } })
        }
        await stillUp(`GET ${route}`)
      }
      const bodies = hostileBodiesOf(ALL_FIELDS)
      for (const route of [...POST_ROUTES_SINCE_1411, ...AUTH_FAMILY_ROUTES]) {
        for (const path of expand(route)) {
          for (const body of bodies) await call('POST', path, { ...opts, body })
          // navigator.sendBeacon (the error reporter) sends text/plain
          for (const body of bodies.slice(0, 8)) await call('POST', path, { ...opts, body, headers: { 'Content-Type': 'text/plain' } })
          await call('POST', path, { ...opts, body: '{}', headers: { 'X-OV-Match-Pin': '__proto__', Authorization: 'Bearer constructor' } })
          await call('POST', `${path}?${ARRAY_QUERY_ALL}`, { ...opts, body: '{}' })
        }
        await stillUp(`POST ${route}`)
      }
    },
    /**
     * The socket types since 14.11 with hostile fields: on a socket of its
     * own each, then from the owner of a room (display-code-set, a live
     * state with Global live fields, bench answers), and a display that
     * follows a hostile code.
     */
    async socketsSince1411() {
      problems.length = 0
      const srv = getSrv()
      const answerOrClose = async (sock, what) => {
        const closed = new Promise((r) => sock.ws.once('close', () => r('closed')))
        if (sock.ws.readyState === 1) sock.send({ type: 'ping' })
        const outcome = await Promise.race([closed, sock.waitFor((m) => m.type === 'pong', 10000, 'pong').then(() => 'pong', () => 'nothing')])
        if (outcome === 'nothing') problems.push(`socket ${what}: neither a pong nor a close`)
        sock.ws.close()
      }
      for (const type of SOCKET_TYPES_SINCE_1411) {
        const sock = await openSocket(srv.wsUrl)
        for (const v of HOSTILE_VALUES) {
          if (sock.ws.readyState !== 1) break
          sock.ws.send(JSON.stringify({ ...Object.fromEntries(ALL_FIELDS.map((f) => [f, v])), type }))
        }
        await answerOrClose(sock, type)
      }
      // the owner of a local-only room (a test match: no database row)
      for (let i = 0; i < HOSTILE_VALUES.length; i++) {
        const v = HOSTILE_VALUES[i]
        const owner = await openSocket(srv.wsUrl)
        const room = `match_${Date.now()}_hostile${i}`
        owner.send({
          type: 'sync-match-data', matchId: room, _timestamp: Date.now(),
          match: { id: room, seed_key: room, test: true, gamePin: '515151', status: 'live', gameNumber: 9000 + i, court: v },
          homeTeam: { name: 'Home VC' }, awayTeam: { name: 'Away VC' }, homePlayers: [], awayPlayers: [], sets: [], events: []
        })
        const frames = [
          { type: 'display-code-set', matchId: room, code: v, issuedAt: v, active: v },
          { type: 'display-code-set', matchId: room, code: 'ABCDEFGH', issuedAt: Date.now() },
          { type: 'live-state-update', matchId: room, liveState: { points_a: v, team_a_name: v }, globalLive: v, globalLiveScreen: v, globalLiveShow: v, globalLiveCourt: v, courtToken: v },
          { type: 'live-state-update', matchId: room, liveState: { points_a: 1 }, globalLive: 'ABCDEFGH', globalLiveScreen: v, globalLiveCourt: v },
          { type: 'bench-response', matchId: room, team: v, id: v, answer: v, response: v },
          { type: 'display-presence', matchId: room, presence: v, settingsUrl: v },
          { type: 'subscribe-match', matchId: v, code: v, role: v, team: v }
        ]
        for (const f of frames) if (owner.ws.readyState === 1) owner.send(f)
        await answerOrClose(owner, `owner frames #${i}`)
      }
      // a display board that follows a code
      for (const v of HOSTILE_VALUES) {
        const board = await openSocket(srv.wsUrl)
        board.send({ type: 'subscribe-match', code: v })
        board.send({ type: 'subscribe-match', code: 'ABCDEFGH', matchId: v })
        await answerOrClose(board, 'display code')
      }
      await stillUp('the socket types since 14.11')
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

    it('routes since 14.11 (TV, Global, display, pair, errors, passkeys) and the authenticated families: no crash', async () => {
      await harness.routesSince1411()
      assert.deepEqual(harness.problems, [])
      assert.deepEqual(harness.boundaryHits(), [])
    })

    it('socket types since 14.11: display codes, Global live fields, server-to-client types sent back', async () => {
      await harness.socketsSince1411()
      await sleep(200)
      await harness.stillUp('the socket types since 14.11')
      assert.deepEqual(harness.problems, [])
      assert.deepEqual(harness.boundaryHits(), [])
    })
  })
}

// No database or server needed: every path server.js routes by a literal or
// a regex (and the endpoint lists of the modules it routes /api/pair,
// /api/sign and /api/display to) is reached by one of the lists above, and
// every socket type handleSocketMessage takes is in a socket list. A route
// or type added without a hostile-input case fails here.
describe('hostile input: the lists cover what server.js routes', () => {
  const read = (f) => readFileSync(join(BACKEND_DIR, f), 'utf8')
  const ALL_ROUTES = [...GET_ROUTES, ...POST_ROUTES, ...PATCH_ROUTES, ...GET_ROUTES_SINCE_1411, ...POST_ROUTES_SINCE_1411, ...AUTH_FAMILY_ROUTES]
    .map((r) => r.replaceAll(':x', 'x'))
  // not a route of its own: a redirect target
  const NOT_ROUTES = new Set(['/tv/?wrong=1'])

  /** Path literals ('/api/...') and regex paths (/^\/api\/x\/(a|b)$/, alternatives expanded). */
  function routedPaths(src) {
    const out = new Set()
    for (const m of src.matchAll(/'(\/(?:api|tv|pair|sign|embed|health)(?:\/[A-Za-z0-9_.:?=-]*)*\/?)'/g)) out.add(m[1])
    for (const m of src.matchAll(/\/\^((?:\\\/[A-Za-z0-9_.-]+)+)(\\\/)?(?:\(([a-z|-]+)\))?/g)) {
      const base = m[1].replaceAll('\\/', '/')
      if (m[3] && m[2]) for (const alt of m[3].split('|')) out.add(`${base}/${alt}`)
      else out.add(base + (m[2] ? '/' : ''))
    }
    return [...out]
  }
  // exact, or a route under the family (a prefix, or a regex path followed by more of it)
  const covered = (p) => ALL_ROUTES.some((r) => r === p || r === p.replace(/\/$/, '') || r.startsWith(p.endsWith('/') ? p : `${p}/`))

  it('every routed path has a hostile-input case', () => {
    const paths = [
      ...routedPaths(read('server.js')),
      ...['lib/pairSessions.js', 'lib/signSessions.js', 'lib/displayCodes.js'].flatMap((f) => routedPaths(read(f)).filter((p) => p.startsWith('/api/')))
    ]
    assert.ok(paths.length > 60, `found ${paths.length} routed paths: the extraction no longer matches server.js`)
    for (const want of ['/api/pair/input', '/api/sign/submit', '/api/display/live', '/api/global/shared/', '/tv/go']) assert.ok(paths.includes(want), `extraction misses ${want}`)
    const missing = paths.filter((p) => !NOT_ROUTES.has(p) && !covered(p)).sort()
    assert.deepEqual(missing, [], 'routes without a hostile-input case: add them to GET_ROUTES_SINCE_1411 / POST_ROUTES_SINCE_1411 / AUTH_FAMILY_ROUTES')
  })

  it('every socket message type has a hostile-input case', () => {
    const src = read('server.js')
    const start = src.indexOf('function handleSocketMessage(')
    assert.ok(start > 0, 'handleSocketMessage not found in server.js')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const types = [...new Set([...body.matchAll(/^\s+case '([a-z_-]+)':/gm)].map((m) => m[1]))]
    assert.ok(types.length >= 14, `found ${types.length} socket types in handleSocketMessage`)
    const missing = types.filter((t) => !SOCKET_TYPES.includes(t) && !SOCKET_TYPES_SINCE_1411.includes(t))
    assert.deepEqual(missing, [], 'socket types without a hostile-input case: add them to SOCKET_TYPES_SINCE_1411')
  })
})

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
