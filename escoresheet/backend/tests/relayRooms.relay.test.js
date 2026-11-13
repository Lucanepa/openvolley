/**
 * The relay room of a match, from its first sync to the end of its claim
 * (server.js holdRoom, heldRoomOf, releaseRoomClaim, admitWaiting): the
 * stored match, its PINs, the sockets that own it and its open bench requests
 * have one lifecycle, and a tablet's PIN check and the scorer's tablet status
 * take only what a PIN proved.
 *
 *   - an emptied room keeps its claim for the take-over grace: a sync without
 *     the stored game PIN does not own the key, its scorer comes back
 *   - after the grace the claim goes whole: an earlier owner speaks for
 *     nothing, the next owner is not sent the old benches' requests
 *   - a join creates no room (the tablet waits for the match's first sync);
 *     one address's syncs keep at most MAX_ROOMS_PER_ADDRESS rooms
 *   - a socket watches several rooms and leaves one with unsubscribe-match
 *   - validate-pin compares the PIN with the match the tablet names; a PIN
 *     two matches share is refused with a request for the game
 *   - /api/server/connections counts a referee or bench only once it proved
 *     its PIN or token (`proved`)
 *   - after the grace of a match in play its game PIN may reclaim the key
 *     once; a stale take-over is sent none of the benches' requests
 *   - a room no connected socket owns is ended for a new one at a room cap;
 *     rooms the database did not prove count per /56; held claims are
 *     released per address, not oldest-first across all addresses
 *   - DATABASE_URL: a seed key the relay cannot take, and a claim whose
 *     database check fails, are refused; rooms the database did not prove
 *     leave room for official matches
 *
 * The take-over grace of a match in play (10 minutes) is passed by moving the
 * relay's clock ahead (helpers/clockShift.mjs), not waited out.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { bootServer, openSocket, provisionDatabase, sleep, waitUntil, SKIP } from './helpers/e2eServer.js'

// helpers/clockShift.mjs: every SIGUSR2 moves the relay's Date.now() past
// the take-over grace of a match in play (STALE_TAKEOVER_MS, 10 minutes)
const CLOCK_SHIFT = new URL('./helpers/clockShift.mjs', import.meta.url).href
const GRACE_STEP_MS = 11 * 60 * 1000

const GAME_PIN = '515253'
const PINS = { gamePin: GAME_PIN, refereePin: '316271', homeTeamPin: '414243', awayTeamPin: '616263' }
const hex = () => randomBytes(3).toString('hex')

/** A scorer's sync of `room` (its seed key), Dexie id 1, with `pins` (PINS unless given). */
function syncMessage(room, { match = {}, pins = PINS, ...extra } = {}) {
  return {
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: room,
      gameNumber: 801,
      status: 'live',
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      ...pins,
      ...match
    },
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }],
    events: [],
    ...extra
  }
}

async function get(base, path, headers = {}) {
  const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, json }
}

async function post(base, path, body, headers = {}) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

/** Send a ping and wait for its pong: every earlier message of this socket was handled. */
async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}
const errorsOf = (c) => c.messages.filter((m) => m.type === 'error')
const lastError = (c) => errorsOf(c).at(-1)

/** Sync `rooms` from `scorers` (alternating), each kept open by a livescore of `keepers` (32 each). */
async function syncKept(scorers, keepers, rooms, pins = { gamePin: '454545' }) {
  rooms.forEach((room, i) => keepers[Math.floor(i / 32)].send({ type: 'subscribe-match', matchId: room, device: 'livescore' }))
  for (const k of keepers) await settle(k)
  rooms.forEach((room, i) => scorers[i % scorers.length].send(syncMessage(room, { pins })))
  for (const s of scorers) await settle(s)
}

describe('relay rooms on a venue relay (--local)', () => {
  let srv
  const sockets = []
  before(async () => {
    srv = await bootServer({}, ['--local'])
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async () => {
    const c = await openSocket(srv.wsUrl)
    sockets.push(c)
    return c
  }

  // 2026-11 audit: the room was dropped with its stored match and PINs when
  // its last socket left, so the next sync without any PIN owned the key and
  // the scorer coming back with the right game PIN was refused
  it('an emptied room keeps its game PIN for the take-over grace: a sync without it does not own the key, its scorer comes back', async () => {
    const seed = `match_1791300000001_${hex()}`
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    scorer.ws.terminate()
    // the bundle is not kept: its memory is given back at once
    await waitUntil(async () => (await get(srv.base, `/api/match/${seed}`)).status === 404, { what: 'the emptied room' })

    const squatter = await open()
    squatter.send(syncMessage(seed, { pins: {}, homeTeam: { id: 1, name: 'FAKE HOME' } }))
    await settle(squatter)
    assert.equal(lastError(squatter)?.code, 'pins-required', 'a sync without the game PIN is asked for it')
    squatter.send(syncMessage(seed, { pins: { gamePin: '000001' }, homeTeam: { id: 1, name: 'FAKE HOME' } }))
    await settle(squatter)
    assert.equal(lastError(squatter)?.code, 'not-match-owner', 'another game PIN is refused')
    assert.equal((await get(srv.base, `/api/match/${seed}`)).status, 404)

    // a referee tablet that reconnects meanwhile waits for the match ...
    const referee = await open()
    referee.send({ type: 'subscribe-match', matchId: seed, device: 'referee', pin: PINS.refereePin })
    const joined = await referee.waitFor((m) => m.type === 'joined_match')
    assert.equal(joined.waiting, true)
    // ... and gets it with the scorer's first sync after its reconnect
    const back = await open()
    back.send(syncMessage(seed))
    await settle(back)
    assert.deepEqual(errorsOf(back), [], 'the scorer with its game PIN continues the match')
    const full = await referee.waitFor((m) => m.type === 'match-full-data')
    assert.equal(full.access, 'full')
    assert.equal(full.homeTeam.name, 'Home VC')
    assert.equal((await get(srv.base, `/api/match/${seed}`)).json.homeTeam.name, 'Home VC')
    for (const c of [squatter, referee, back]) c.ws.close()
  })

  // be-server-ws-5: join_match / subscribe-match created a room for any id,
  // so idle sockets filled the 500 rooms and no new match got the relay
  it('a join creates no room: tablets wait for the match, and its first sync lets them in', async () => {
    const roomsBefore = (await get(srv.base, '/api/server/status')).json.rooms
    const idle = []
    for (let i = 0; i < 12; i++) {
      const c = await open()
      c.send({ type: 'subscribe-match', matchId: `idle-${i}-${hex()}`, device: 'livescore' })
      c.send({ type: 'join_match', matchId: `idle-join-${i}-${hex()}`, role: 'referee' })
      idle.push(c)
    }
    for (const c of idle) await settle(c)
    // (an earlier test's rooms may still be closing)
    assert.ok((await get(srv.base, '/api/server/status')).json.rooms <= roomsBefore, 'no room for an id the relay does not hold')
    assert.equal(idle.some((c) => errorsOf(c).length > 0), false)

    // one socket waits for at most 32 matches: the oldest is left first
    const many = await open()
    const seeds = Array.from({ length: 34 }, (_, i) => `wait-${i}-${hex()}`)
    for (const id of seeds) many.send({ type: 'subscribe-match', matchId: id, device: 'livescore' })
    await settle(many)
    const first = await open()
    first.send(syncMessage(seeds[0]))
    const last = await open()
    last.send(syncMessage(seeds[33]))
    await settle(first)
    await settle(last)
    await settle(many)
    const fulls = many.messages.filter((m) => m.type === 'match-full-data').map((m) => m.matchId)
    assert.deepEqual(fulls, [seeds[33]], 'let into the match it still waits for, not the oldest it left')
    for (const c of [...idle, many, first, last]) c.ws.close()
  })

  // relay-parity-4: a socket was in one room, so the hall livescore (one
  // socket for every court) followed only the last match it subscribed to
  it('a socket watches several rooms and leaves one with unsubscribe-match', async () => {
    const courtA = `court-a-${hex()}`
    const courtB = `court-b-${hex()}`
    const scorerA = await open()
    const scorerB = await open()
    scorerA.send(syncMessage(courtA, { pins: { gamePin: '111111' } }))
    scorerB.send(syncMessage(courtB, { pins: { gamePin: '222222' } }))
    await settle(scorerA)
    await settle(scorerB)
    const live = await open()
    live.send({ type: 'subscribe-match', matchId: courtA, device: 'livescore' })
    live.send({ type: 'subscribe-match', matchId: courtB, device: 'livescore' })
    await settle(live)
    assert.deepEqual(live.messages.filter((m) => m.type === 'match-full-data').map((m) => m.matchId), [courtA, courtB])
    // one entry per socket and court, but each socket counts once
    const conns = (await get(srv.base, '/api/server/connections')).json
    const ids = conns.clients.map((c) => c.id)
    assert.ok(ids.length > new Set(ids).size, 'the livescore has an entry per court')
    assert.equal(conns.dashboardClients, new Set(ids).size, 'each socket counts once')

    const updates = (from) => live.messages.slice(from).filter((m) => m.type === 'live-state-update').map((m) => m.matchId)
    let mark = live.messages.length
    scorerA.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 7, points_b: 0 } })
    scorerB.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 9, points_b: 0 } })
    await settle(scorerA)
    await settle(scorerB)
    await settle(live)
    assert.deepEqual(updates(mark).sort(), [courtA, courtB].sort(), 'both courts are followed')

    live.send({ type: 'unsubscribe-match', matchId: courtA })
    await settle(live)
    mark = live.messages.length
    scorerA.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 8, points_b: 0 } })
    scorerB.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 10, points_b: 0 } })
    await settle(scorerA)
    await settle(scorerB)
    await settle(live)
    assert.deepEqual(updates(mark), [courtB], 'court A is left, court B still followed')
    for (const c of [scorerA, scorerB, live]) c.ws.close()
  })

  // be-routes-authz-A-5 / fe-secondary-apps-1: the first live match with the
  // PIN answered, so of two matches sharing a referee PIN the second's referee
  // got the first's
  it('validate-pin compares the PIN with the match the tablet names; a PIN two matches share asks for the game', async () => {
    const seedA = `match_1791300000003_${hex()}`
    const seedB = `match_1791300000004_${hex()}`
    const shared = { ...PINS, refereePin: '727272' }
    const scorerA = await open()
    const scorerB = await open()
    scorerA.send(syncMessage(seedA, { pins: { ...shared, gamePin: '313131' }, match: { gameNumber: 901 } }))
    scorerB.send(syncMessage(seedB, { pins: { ...shared, gamePin: '323232' }, match: { gameNumber: 902 } }))
    await settle(scorerA)
    await settle(scorerB)

    const check = (body) => post(srv.base, '/api/match/validate-pin', { pin: shared.refereePin, type: 'referee', ...body })
    const anyMatch = await check({})
    assert.equal(anyMatch.status, 409)
    assert.equal(anyMatch.json.code, 'game-number-required')
    assert.equal(anyMatch.json.token, undefined, 'no match token for an ambiguous PIN')
    const byKey = await check({ matchId: seedB })
    assert.equal(byKey.status, 200)
    assert.equal(byKey.json.match.id, seedB)
    assert.ok(byKey.json.token)
    const byGame = await check({ gameNumber: 901 })
    assert.equal(byGame.status, 200)
    assert.equal(byGame.json.match.id, seedA)
    assert.equal((await check({ matchId: `match_1791300000009_${hex()}` })).status, 404, 'a match the relay does not hold')
    assert.equal((await check({ matchId: seedA, pin: '999999' })).status, 404, 'a wrong PIN for the named match')
    assert.equal((await check({ matchId: { key: seedA } })).status, 400)
    for (const c of [scorerA, scorerB]) c.ws.close()
  })

  // be-dynamic-idor-12 / fe-connect-devices-2: a socket that only named the
  // role was counted as a connected referee or bench on the scorer's status
  it('the tablet status counts a referee or bench only once it proved its PIN or token', async () => {
    const seed = `match_1791300000005_${hex()}`
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    const labelled = await open()
    labelled.send({ type: 'subscribe-match', matchId: seed, device: 'referee' })
    const named = await open()
    named.send({ type: 'join_match', matchId: seed, role: 'referee' })
    const wrongBench = await open()
    wrongBench.send({ type: 'subscribe-match', matchId: seed, device: 'bench', team: 'home', pin: '000002' })
    const referee = await open()
    referee.send({ type: 'join_match', matchId: seed, role: 'referee', pin: PINS.refereePin })
    const bench = await open()
    bench.send({ type: 'subscribe-match', matchId: seed, device: 'bench', team: 'away', pin: PINS.awayTeamPin })
    for (const c of [labelled, named, wrongBench, referee, bench]) await settle(c)
    assert.equal((await named.waitFor((m) => m.type === 'joined_match')).role, 'subscriber', 'a role without its PIN joins as a subscriber')
    assert.equal((await referee.waitFor((m) => m.type === 'joined_match')).role, 'referee')

    const conns = (await get(srv.base, `/api/server/connections?matchId=${seed}`)).json
    assert.equal(conns.referees, 1)
    assert.equal(conns.benches, 1)
    const proved = conns.clients.filter((c) => c.proved)
    assert.deepEqual(proved.map((c) => [c.role, c.team]).sort(), [['bench', 'away'], ['referee', null]])
    assert.deepEqual(conns.clients.filter((c) => !c.proved).map((c) => c.role), ['subscriber', 'subscriber', 'subscriber'])
    for (const c of [scorer, labelled, named, wrongBench, referee, bench]) c.ws.close()
  })
})

describe('relay rooms after the take-over grace of a match in play (--local, the relay\'s clock runs ahead)', () => {
  let srv
  const sockets = []
  let ahead = 0
  before(async () => {
    srv = await bootServer({
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${CLOCK_SHIFT}`].filter(Boolean).join(' '),
      OV_TEST_CLOCK_STEP_MS: String(GRACE_STEP_MS)
    }, ['--local'])
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async () => {
    const c = await openSocket(srv.wsUrl)
    sockets.push(c)
    return c
  }
  /** The relay's clock past the take-over grace of a match in play. */
  async function passGrace() {
    ahead += GRACE_STEP_MS
    process.kill(srv.pid, 'SIGUSR2')
    await waitUntil(() => srv.output.join('').includes(`[test clock] ahead by ${ahead} ms`), { what: 'the relay clock' })
  }

  // gap-crash-sweep-1 (review): a room a bench kept open was taken over after
  // the grace by a socket with any game PIN, and that socket was sent the
  // benches' open requests, line-ups included
  it('a stale take-over of a room a bench keeps open is sent none of the benches\' requests', async () => {
    const seed = `match_1791300000011_${hex()}`
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    const bench = await open()
    bench.send({ type: 'subscribe-match', matchId: seed, device: 'bench', team: 'home', pin: PINS.homeTeamPin })
    await bench.waitFor((m) => m.type === 'match-full-data')
    bench.send({ type: 'bench-request', matchId: seed, team: 'home', request: { id: `lu-${hex()}`, kind: 'lineup', setIndex: 2, lineup: { I: 4, II: 7, III: 9, IV: 11, V: 12, VI: 15 } } })
    await scorer.waitFor((m) => m.type === 'bench-request')
    // the scorer's laptop dies, the bench keeps the room open
    scorer.ws.terminate()
    await bench.waitFor((m) => m.type === 'client_left')
    await passGrace()

    const taker = await open()
    taker.send(syncMessage(seed, { pins: { gamePin: '000009' }, homeTeam: { id: 1, name: 'Other Home' }, sets: [] }))
    await settle(taker)
    assert.deepEqual(errorsOf(taker), [], 'the grace is over: the room is taken over')
    assert.equal(taker.messages.some((m) => m.type === 'bench-request'), false, 'none of the benches\' requests')
    for (const c of [bench, taker]) c.ws.close()
  })

  // be-server-ws-4 (review): after the grace of an emptied room of a match in
  // play its claim went whole: the next sync without any PIN owned the key,
  // and the scorer back with the right game PIN was refused
  it('after the grace of a match in play its game PIN reclaims the key once; a finished match\'s claim goes whole', async () => {
    const seed = `match_1791300000012_${hex()}`
    const done = `match_1791300000013_${hex()}`
    const scorer = await open()
    scorer.send(syncMessage(done, { match: { status: 'ended' } }))
    scorer.send(syncMessage(seed))
    await settle(scorer)
    scorer.ws.terminate()
    for (const key of [seed, done]) {
      await waitUntil(async () => (await get(srv.base, `/api/match/${key}`)).status === 404, { what: 'the emptied room' })
    }
    await passGrace()

    const squatter = await open()
    squatter.send(syncMessage(seed, { pins: {}, homeTeam: { id: 1, name: 'FAKE HOME' } }))
    squatter.send(syncMessage(done, { pins: {}, homeTeam: { id: 1, name: 'FAKE HOME' } }))
    await settle(squatter)
    assert.deepEqual(errorsOf(squatter), [], 'the grace is over: both keys are new')

    const back = await open()
    back.send(syncMessage(seed))
    await settle(back)
    assert.deepEqual(errorsOf(back), [], 'the scorer reclaims its match in play with its game PIN')
    assert.equal((await get(srv.base, `/api/match/${seed}`)).json.homeTeam.name, 'Home VC')
    squatter.send(syncMessage(seed, { pins: {}, homeTeam: { id: 1, name: 'FAKE HOME' } }))
    await settle(squatter)
    assert.equal(lastError(squatter)?.code, 'pins-required', 'the squatter speaks for it no more')

    back.send(syncMessage(done, { match: { status: 'ended' } }))
    await settle(back)
    assert.equal(lastError(back)?.code, 'not-match-owner', 'a finished match\'s claim went whole with its grace')
    assert.equal((await get(srv.base, `/api/match/${done}`)).json.homeTeam.name, 'FAKE HOME')
    for (const c of [squatter, back]) c.ws.close()
  })
})

describe('relay rooms on a cloud relay behind Cloudflare: the end of a claim, rooms per address', () => {
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

  // gap-relay-ws-pins-1 / gap-crash-sweep-1: ownership and bench requests
  // outlived the room; be-server-ws-5: the rooms one address keeps open
  it('after the grace the claim goes whole, and one address keeps 64 rooms', { timeout: 150_000 }, async () => {
    // --- a finished match's room empties (grace: 60 s) ---------------------
    const key = `match_1791300000006_${hex()}`
    const owner = await open('203.0.113.21')
    owner.send(syncMessage(key))
    await settle(owner)
    const bench = await open('203.0.113.22')
    bench.send({ type: 'subscribe-match', matchId: key, device: 'bench', team: 'home', pin: PINS.homeTeamPin })
    await bench.waitFor((m) => m.type === 'match-full-data')
    bench.send({ type: 'bench-request', matchId: key, team: 'home', request: { id: `to-${hex()}`, kind: 'timeout', setIndex: 1 } })
    await owner.waitFor((m) => m.type === 'bench-request')
    owner.send(syncMessage(key, { match: { status: 'ended' } }))
    await settle(owner)
    // the owner goes on to another match, the bench leaves: the room empties
    owner.send(syncMessage(`match_1791300000007_${hex()}`, { pins: { gamePin: '343434' } }))
    await settle(owner)
    bench.ws.close()
    await waitUntil(async () => (await get(srv.base, `/api/match/${key}`)).status === 404, { what: 'the emptied room' })
    const heldAt = Date.now()
    const other = await open('198.51.100.31')
    other.send(syncMessage(key, { pins: { gamePin: '626262' }, homeTeam: { id: 1, name: 'Other Home' } }))
    await settle(other)
    assert.equal(lastError(other)?.code, 'not-match-owner', 'within the grace the key needs its game PIN')

    // --- one address's syncs keep 64 rooms open (a keeper in each) ---------
    const X = '192.0.2.41'
    const scorers = [await open(X), await open(X)]
    const keepers = [await open('192.0.2.42'), await open('192.0.2.42')]
    const rooms = Array.from({ length: 64 }, (_, i) => `cap-${i}-${hex()}`)
    for (let i = 0; i < rooms.length; i++) {
      const s = scorers[i % 2]
      s.send(syncMessage(rooms[i], { pins: { gamePin: '454545' } }))
      await settle(s)
      const k = keepers[Math.floor(i / 32)]
      k.send({ type: 'subscribe-match', matchId: rooms[i], device: 'livescore' })
      await settle(k)
    }
    assert.deepEqual(scorers.flatMap(errorsOf), [])
    for (const s of scorers) s.ws.close()

    // --- the grace is over (and the address's claims per minute again) -----
    await sleep(Math.max(0, heldAt + 63_000 - Date.now()))
    other.send(syncMessage(key, { pins: { gamePin: '626262' }, homeTeam: { id: 1, name: 'Other Home' } }))
    await settle(other)
    assert.equal(errorsOf(other).length, 1, 'after the grace the key is new')
    assert.equal(other.messages.some((m) => m.type === 'bench-request'), false, 'the old benches\' requests went with the claim')
    // the earlier owner speaks for nothing: neither its PIN-less sync, nor its
    // live state, nor delete-match
    owner.send(syncMessage(key, { pins: {} }))
    owner.send({ type: 'live-state-update', matchId: key, liveState: { points_a: 99, points_b: 0 } })
    owner.send({ type: 'delete-match', matchId: key })
    await settle(owner)
    assert.deepEqual(errorsOf(owner).slice(-3).map((m) => m.code), ['pins-required', 'not-match-owner', 'not-match-owner'])
    assert.equal((await get(srv.base, `/api/match/${key}`)).json.homeTeam.name, 'Other Home')

    // a 65th room of the address ends one of its own that its scorers left:
    // it keeps 64 rooms
    const roomsBefore = (await get(srv.base, '/api/server/status')).json.rooms
    const again = await open(X)
    again.send(syncMessage(`cap-64-${hex()}`, { pins: { gamePin: '454545' } }))
    await settle(again)
    assert.deepEqual(errorsOf(again), [], 'a 65th room of one address')
    assert.equal((await get(srv.base, '/api/server/status')).json.rooms, roomsBefore, 'one of its own rooms made room')
    const left = []
    for (const room of rooms) if ((await get(srv.base, `/api/match/${room}`)).status === 404) left.push(room)
    assert.equal(left.length, 1)
  })

  // be-server-ws-5 (review): the per-address cap counted /64s, so the /64s
  // of one IPv6 customer each kept 64 rooms, and watchers kept them for good
  it('rooms the database did not prove count per /56, and an address makes room among its own rooms its scorers left', async () => {
    const sameNet = (i) => `2001:db8:aa00:${i}::1`
    const scorers = [await open(sameNet(1)), await open(sameNet(1))]
    const keepers = [await open('192.0.2.61'), await open('192.0.2.61')]
    const rooms = Array.from({ length: 64 }, (_, i) => `net-${i}-${hex()}`)
    await syncKept(scorers, keepers, rooms)
    assert.deepEqual(scorers.flatMap(errorsOf), [])

    const sibling = await open(sameNet(2))
    const next = `net-64-${hex()}`
    sibling.send(syncMessage(next, { pins: { gamePin: '454545' } }))
    await settle(sibling)
    assert.equal(lastError(sibling)?.code, 'room-limit', 'another /64 of the same /56')
    const elsewhere = await open('2001:db8:ab00:1::1')
    elsewhere.send(syncMessage(`net-x-${hex()}`, { pins: { gamePin: '454545' } }))
    await settle(elsewhere)
    assert.deepEqual(errorsOf(elsewhere), [], 'another /56')

    // its scorers are gone: a room of its own is ended for the new one
    const roomsBefore = (await get(srv.base, '/api/server/status')).json.rooms
    for (const c of scorers) c.ws.close()
    let seen = errorsOf(sibling).length
    await waitUntil(async () => {
      sibling.send(syncMessage(next, { pins: { gamePin: '454545' } }))
      await settle(sibling)
      const accepted = errorsOf(sibling).length === seen
      seen = errorsOf(sibling).length
      return accepted
    }, { what: 'a room for the sibling' })
    assert.equal((await get(srv.base, '/api/server/status')).json.rooms, roomsBefore, 'one of its own rooms made room')
    const ended = []
    for (const room of rooms) if ((await get(srv.base, `/api/match/${room}`)).status === 404) ended.push(room)
    assert.equal(ended.length, 1)

    // the ended room's scorer is back within its grace with its game PIN: it
    // continues, and the room's watcher gets the match again
    const keeper = keepers[Math.floor(rooms.indexOf(ended[0]) / 32)]
    const fulls = () => keeper.messages.filter((m) => m.type === 'match-full-data' && m.matchId === ended[0]).length
    const before = fulls()
    const back = await open(sameNet(1))
    back.send(syncMessage(ended[0], { pins: { gamePin: '454545' } }))
    await settle(back)
    assert.deepEqual(errorsOf(back), [])
    await waitUntil(() => fulls() > before, { what: 'the watcher let back in' })
    for (const c of [...keepers, sibling, elsewhere, back]) c.ws.close()
  })
})

describe('relay rooms and held claims under a flood (cloud relay behind Cloudflare)', () => {
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
  const status = async () => (await get(srv.base, '/api/server/status')).json

  /** 64 rooms from each address of `ips`, left at once: each empties and its claim is held. */
  async function syncAndLeave(ips) {
    for (const ip of ips) {
      const pair = [await open(ip), await open(ip)]
      for (let i = 0; i < 64; i++) pair[i % 2].send(syncMessage(`flood-${hex()}-${i}`, { pins: { gamePin: '454545' } }))
      for (const c of pair) await settle(c)
      assert.deepEqual(pair.flatMap(errorsOf), [], ip)
      for (const c of pair) c.ws.close()
    }
  }

  // be-server-ws-4 / gap-relay-ws-pins-1 (review): held claims were released
  // oldest first across all addresses, so other addresses' churn pushed a
  // scorer's claim out within its grace and a sync without its PIN owned it
  it('the rooms other addresses sync and leave never push a scorer\'s held claim out within its grace', { timeout: 120_000 }, async () => {
    const key = `match_1791300000021_${hex()}`
    const victim = await open('198.51.100.5')
    victim.send(syncMessage(key, { pins: { ...PINS, gamePin: '777777' } }))
    await settle(victim)
    victim.ws.terminate()
    await waitUntil(async () => (await get(srv.base, `/api/match/${key}`)).status === 404, { what: 'the emptied room' })
    const attacker = await open('203.0.113.10')
    const squat = () => syncMessage(key, { pins: {}, homeTeam: { id: 1, name: 'FAKE HOME' } })
    attacker.send(squat())
    await settle(attacker)
    assert.equal(lastError(attacker)?.code, 'pins-required')

    // 32 /64s of one /56, then 33 /56s: 4160 rooms left, 2000 held claims at most
    await syncAndLeave(Array.from({ length: 32 }, (_, b) => `2001:db8:bb00:${b.toString(16)}::1`))
    attacker.send(squat())
    await settle(attacker)
    assert.equal(lastError(attacker)?.code, 'pins-required', 'one /56 keeps its own share')
    await syncAndLeave(Array.from({ length: 33 }, (_, b) => `2001:db8:${(0xc000 + b).toString(16)}::1`))
    const n = errorsOf(attacker).length
    attacker.send(squat())
    await settle(attacker)
    assert.equal(errorsOf(attacker).length, n + 1)
    assert.equal(lastError(attacker)?.code, 'pins-required', 'the addresses holding the most give theirs up first')
    assert.equal((await get(srv.base, `/api/match/${key}`)).status, 404)

    const back = await open('198.51.100.5')
    back.send(syncMessage(key, { pins: { ...PINS, gamePin: '777777' } }))
    await settle(back)
    assert.deepEqual(errorsOf(back), [], 'the scorer back within its grace continues')
    assert.equal((await get(srv.base, `/api/match/${key}`)).json.homeTeam.name, 'Home VC')
    for (const c of [attacker, back]) c.ws.close()
  })

  // be-server-ws-5 (review): rooms kept open by idle watchers kept their slot
  // for good: a few addresses filled the 500 rooms and no new match got one
  it('at MAX_ROOMS the room no connected socket owns whose scorer left first is ended for a new match', { timeout: 120_000 }, async () => {
    const keeperIp = '192.0.2.90'
    const ips = Array.from({ length: 8 }, (_, i) => `192.0.2.${71 + i}`)
    const groups = []
    // (the earlier test's last room is closing)
    await waitUntil(async () => (await status()).rooms === 0, { what: 'no room left' })
    let made = 0
    for (const ip of ips) {
      const count = Math.min(64, 500 - made)
      if (count <= 0) break
      const rooms = Array.from({ length: count }, (_, i) => `full-${ip.split('.')[3]}-${i}-${hex()}`)
      const scorers = [await open(ip), await open(ip)]
      const keepers = []
      for (let k = 0; k < Math.ceil(count / 32); k++) keepers.push(await open(keeperIp))
      await syncKept(scorers, keepers, rooms)
      assert.deepEqual(scorers.flatMap(errorsOf), [], ip)
      groups.push({ rooms, scorers, keepers })
      made += count
    }
    assert.equal((await status()).rooms, 500)

    // the first address's scorers are gone: an outsider's new match gets a room
    const first = groups[0]
    const open0 = (await status()).connections
    for (const c of first.scorers) c.ws.close()
    await waitUntil(async () => (await status()).connections <= open0 - 2, { what: 'the scorers gone' })
    const scorer = await open('198.51.100.77')
    scorer.send(syncMessage(`match_1791300000022_${hex()}`, { pins: { gamePin: '121212' } }))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [], 'a room no socket owns made room')
    assert.equal((await status()).rooms, 500)
    const ended = []
    for (const room of first.rooms) if ((await get(srv.base, `/api/match/${room}`)).status === 404) ended.push(room)
    assert.equal(ended.length, 1, 'one of the rooms whose scorer left')
    for (const g of groups.slice(1)) {
      for (const room of g.rooms.slice(0, 3)) assert.equal((await get(srv.base, `/api/match/${room}`)).status, 200, 'rooms with a connected owner stay')
    }
    for (const c of [scorer, ...groups.flatMap((g) => [...g.scorers, ...g.keepers])]) c.ws.close()
  })
})

describe('relay claims in DATABASE_URL mode', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  const sockets = []
  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-relayrooms-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-relayrooms-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
  })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await sql?.query('ALTER TABLE IF EXISTS matches_off RENAME TO matches').catch(() => {})
    await sql?.end().catch(() => {})
    await srv?.stop()
    if (db) await db.drop()
    for (const d of [storageRoot, statusDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  })
  const open = async (ip) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }

  // be-server-ws-3: a seed key over 128 characters left the room key at the
  // match's public external id, and its NUL made the database check fail,
  // which let the claim through without the game PIN
  it('a seed key the relay cannot take is refused, and a claim whose database check fails is refused', async () => {
    const ext = `match_1791300000008_${hex()}`
    await sql.query("INSERT INTO matches (external_id, status, sport_type, game_pin) VALUES ($1, 'live', 'indoor', $2)", [ext, GAME_PIN])
    const scorer = await open('198.51.100.12')
    scorer.send(syncMessage(ext))
    await settle(scorer)
    assert.deepEqual(errorsOf(scorer), [])
    scorer.ws.terminate()
    await waitUntil(async () => (await get(srv.base, `/api/match/${ext}`)).status === 404, { what: 'the emptied room' })

    const attacker = await open('203.0.113.88')
    for (const seedKey of ['E'.repeat(140) + '\u0000', 'E'.repeat(140), 'match\u0000x']) {
      attacker.send({ type: 'sync-match-data', matchId: ext, match: { seedKey, status: 'live' }, homeTeam: { name: 'FAKE HOME' }, awayTeam: { name: 'FAKE AWAY' }, sets: [], events: [] })
      await settle(attacker)
      assert.equal(lastError(attacker)?.code, 'bad-request', JSON.stringify(seedKey.slice(-3)))
    }
    assert.equal((await get(srv.base, `/api/match/${ext}`)).status, 404, 'the room was not taken')

    // The database cannot answer: the claim is refused (the app syncs again)
    const fresh = `match_1791300000009_${hex()}`
    await sql.query('ALTER TABLE matches RENAME TO matches_off')
    try {
      attacker.send(syncMessage(fresh, { pins: { gamePin: '000003' } }))
      await settle(attacker)
      assert.equal(lastError(attacker)?.code, 'claim-unverified')
      assert.equal((await get(srv.base, `/api/match/${fresh}`)).status, 404)
    } finally {
      await sql.query('ALTER TABLE matches_off RENAME TO matches')
    }
    const n = errorsOf(attacker).length
    attacker.send(syncMessage(fresh, { pins: { gamePin: '000003' } }))
    await settle(attacker)
    assert.equal(errorsOf(attacker).length, n, 'a room the database does not know is the relay\'s own again')

    // the scorer comes back to its match with the game PIN
    const back = await open('198.51.100.12')
    back.send(syncMessage(ext))
    await settle(back)
    assert.deepEqual(errorsOf(back), [])
    assert.equal((await get(srv.base, `/api/match/${ext}`)).json.homeTeam.name, 'Home VC')
  })

  // be-server-ws-5 (review): any key the database does not know was accepted
  // as a new room, so a few addresses filled the 500 rooms and an official
  // match's scorer got 'room-limit'
  it('rooms the database did not prove leave room for official matches', { timeout: 120_000 }, async () => {
    const keepers = []
    const scorers = []
    for (let a = 0; a < 5; a++) {
      const ip = `192.0.2.${101 + a}`
      const pair = [await open(ip), await open(ip)]
      const kept = [await open('192.0.2.120'), await open('192.0.2.120')]
      await syncKept(pair, kept, Array.from({ length: 60 }, (_, i) => `anon-${a}-${i}-${hex()}`))
      scorers.push(...pair)
      keepers.push(...kept)
    }
    // (the earlier test left one room the database does not know)
    assert.ok(scorers.flatMap(errorsOf).every((e) => e.code === 'room-limit'))
    const anon = await open('192.0.2.110')
    anon.send(syncMessage(`anon-x-${hex()}`, { pins: { gamePin: '454545' } }))
    await settle(anon)
    assert.equal(lastError(anon)?.code, 'room-limit', 'the share of rooms the database did not prove is full')

    const ext = `match_1791300000023_${hex()}`
    await sql.query("INSERT INTO matches (external_id, status, sport_type, game_pin) VALUES ($1, 'live', 'indoor', $2)", [ext, '565656'])
    const official = await open('198.51.100.40')
    official.send(syncMessage(ext, { pins: { ...PINS, gamePin: '565656' } }))
    await settle(official)
    assert.deepEqual(errorsOf(official), [], 'an official match still gets a room')
    for (const c of [...scorers, ...keepers, anon, official]) c.ws.close()
  })
})
