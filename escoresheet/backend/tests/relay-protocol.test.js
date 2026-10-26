/**
 * Contract test for the backend WebSocket relay: same client-facing protocol as
 * the LAN relays (frontend/electron/lanRelayCore.cjs). Boots server.js in local
 * mode (no Supabase, no PocketBase) on a random port.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PINS = {
  refereePin: '314159',
  homeTeamPin: '271828',
  awayTeamPin: '161803',
  homeTeamUploadPin: '141421',
  awayTeamUploadPin: '173205',
  gamePin: '987654'
}
const containsPin = (text) => Object.values(PINS).some((pin) => text.includes(pin))

function makeMatch(overrides = {}) {
  return {
    id: 7,
    gameNumber: 4242,
    status: 'live',
    refereeConnectionEnabled: true,
    homeTeamConnectionEnabled: true,
    awayTeamConnectionEnabled: false,
    ...PINS,
    ...overrides
  }
}

function syncMessage(match = makeMatch(), extra = {}) {
  return {
    type: 'sync-match-data',
    matchId: match.id, // numeric Dexie id: the relay must key rooms by String()
    match,
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 3, awayPoints: 1 }],
    events: [],
    _timestamp: Date.now(),
    ...extra
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function openClient(url, headers = null) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined)
    const client = { ws, messages: [], raw: [] }
    client.send = (m) => ws.send(JSON.stringify(m))
    client.waitFor = (pred, timeoutMs = 3000) => new Promise((ok, fail) => {
      const found = client.messages.find(pred)
      if (found) return ok(found)
      const timer = setTimeout(() => fail(new Error('timed out waiting for message')), timeoutMs)
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
    ws.on('message', (data) => {
      client.raw.push(data.toString())
      client.messages.push(JSON.parse(data.toString()))
    })
    ws.once('open', () => client.waitFor((m) => m.type === 'connected').then(() => res(client), rej))
    ws.once('error', rej)
  })
}

describe('backend WebSocket relay protocol', () => {
  let child
  let port

  before(async () => {
    port = await freePort()
    const env = { ...process.env, PORT: String(port) }
    for (const k of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'POCKETBASE_URL', 'IS_CLOUD', 'TRUST_PROXY']) delete env[k]
    child = spawn(process.execPath, ['server.js', '--local'], { cwd: BACKEND_DIR, env, stdio: 'ignore' })
    const start = Date.now()
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
      } catch { /* not up yet */ }
      if (Date.now() - start > 10000) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(() => {
    child?.kill('SIGKILL')
  })

  it('speaks the shared protocol and only trusts the proven scoreboard', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const scoreboard = await openClient(wsUrl)
    const referee = await openClient(wsUrl)
    const attacker = await openClient(wsUrl)

    scoreboard.send(syncMessage())
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')

    // String subscriber id and numeric scoreboard id share one room, and a late
    // subscriber gets a PIN-free snapshot: the bundle with the referee PIN.
    referee.send({ type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    const full = await referee.waitFor((m) => m.type === 'match-full-data')
    assert.equal(full.matchId, '7')
    assert.equal(full.match.id, 7)
    assert.equal(full.access, 'full')

    scoreboard.send(syncMessage(makeMatch(), { events: [{ id: 1 }] }))
    const update = await referee.waitFor((m) => m.type === 'match-data-update')
    assert.equal(update.matchId, '7')
    assert.equal(update.data, undefined) // flat, like every relay
    assert.equal(update.events.length, 1)

    scoreboard.send({ type: 'match-action', matchId: 7, action: 'timeout', data: { team: 'home' }, timestamp: Date.now() })
    const action = await referee.waitFor((m) => m.type === 'match-action')
    assert.deepEqual(action.data, { team: 'home' })

    scoreboard.send({ type: 'live-state-update', matchId: 7, liveState: { points_a: 5 } })
    const live = await referee.waitFor((m) => m.type === 'live-state-update')
    assert.deepEqual(live.liveState, { points_a: 5 })

    // A socket cannot self-grant the scoreboard role
    attacker.send({ type: 'join_match', matchId: '7', role: 'scoreboard' })
    await attacker.waitFor((m) => m.type === 'joined_match' && m.role === 'subscriber')
    attacker.send({ type: 'clear-all-matches' })
    await attacker.waitFor((m) => m.type === 'error' && m.code === 'not-scoreboard')
    attacker.send({ type: 'delete-match', matchId: '7' })
    attacker.send({ type: 'match-action', matchId: '7', action: 'timeout', data: { team: 'away' } })
    await attacker.waitFor((m) => m.type === 'error' && m.code === 'not-match-owner')

    // Syncing an invented match makes it the scoreboard of THAT match only
    const intruder = await openClient(wsUrl)
    intruder.send(syncMessage(makeMatch({ id: 99, gamePin: '000099' })))
    intruder.send(syncMessage(makeMatch({ gamePin: '000000' })))
    await intruder.waitFor((m) => m.type === 'error' && m.code === 'not-match-owner')
    intruder.send({ type: 'clear-all-matches' })
    intruder.send({ type: 'ping' })
    await intruder.waitFor((m) => m.type === 'pong')

    const res = await fetch(`http://127.0.0.1:${port}/api/match/7`)
    assert.equal(res.status, 200, 'match 7 survives the foreign clear-all')
    const text = await res.text()
    assert.equal(containsPin(text), false)

    const validate = await fetch(`http://127.0.0.1:${port}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PINS.refereePin, type: 'referee' })
    })
    assert.equal(validate.status, 200)
    assert.equal(containsPin(await validate.text()), false)

    assert.equal(containsPin(referee.raw.join('') + attacker.raw.join('')), false)
    assert.equal(referee.messages.filter((m) => m.type === 'match-action').length, 1)

    // The live-state rides along with later syncs (also as data.liveState for
    // the LedBox bridge) and reaches a subscriber that joins mid-match
    scoreboard.send(syncMessage(makeMatch(), { events: [{ id: 1 }, { id: 2 }] }))
    const withLive = await referee.waitFor((m) => m.type === 'match-data-update' && m.events.length === 2)
    assert.deepEqual(withLive.liveState, { points_a: 5 })
    assert.deepEqual(withLive.data, { liveState: { points_a: 5 } })
    const bridge = await openClient(wsUrl)
    bridge.send({ type: 'subscribe-match', matchId: '7' })
    const bridgeFull = await bridge.waitFor((m) => m.type === 'match-full-data')
    assert.deepEqual(bridgeFull.data, { liveState: { points_a: 5 } })
    assert.equal(containsPin(bridge.raw.join('')), false)

    // The real scoreboard can delete; the room is told before it goes away
    scoreboard.send({ type: 'delete-match', matchId: 7 })
    await referee.waitFor((m) => m.type === 'match-deleted' && m.matchId === '7')

    for (const c of [scoreboard, referee, attacker, intruder, bridge]) c.ws.close()
  })

  it('keys rooms by the seed_key, keeps PINs a proven scoreboard leaves out and labels tablets', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seedA = 'match_1791215210058_aaaaaa'
    const seedB = 'match_1791215210059_bbbbbb'
    const courtA = await openClient(wsUrl)
    const courtB = await openClient(wsUrl)
    const referee = await openClient(wsUrl)

    // Both scorers' first match is Dexie id 1: no clash any more
    courtA.send(syncMessage(makeMatch({ id: 1, seed_key: seedA, gamePin: '111111' })))
    courtB.send(syncMessage(makeMatch({ id: 1, seed_key: seedB, gamePin: '222222', refereePin: '424242' })))
    courtB.send({ type: 'ping' })
    await courtB.waitFor((m) => m.type === 'pong')
    assert.equal(courtB.messages.some((m) => m.type === 'error'), false)

    // The tablet knows the seed key (cloud PIN check / QR code)
    referee.send({ type: 'subscribe-match', matchId: seedA, device: 'referee', pin: PINS.refereePin })
    const full = await referee.waitFor((m) => m.type === 'match-full-data')
    assert.equal(full.matchId, seedA)
    assert.equal(full.match.seed_key, seedA)

    // The scoreboard's Dexie id stays an alias on its own socket
    courtA.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 3 } })
    const live = await referee.waitFor((m) => m.type === 'live-state-update')
    assert.equal(live.matchId, seedA)
    courtB.send({ type: 'live-state-update', matchId: 1, liveState: { points_a: 9 } })
    courtB.send({ type: 'ping' })
    await courtB.waitFor((m) => m.type === 'pong' && courtB.messages.filter((x) => x.type === 'pong').length === 2)

    // PINs only when they change: a sync without them keeps the stored ones
    const { refereePin, homeTeamPin, awayTeamPin, homeTeamUploadPin, awayTeamUploadPin, gamePin, ...noPins } = makeMatch({ id: 1, seed_key: seedA })
    courtA.send(syncMessage({ ...noPins }, { events: [{ id: 5 }] }))
    await referee.waitFor((m) => m.type === 'match-data-update' && m.events.length === 1)
    const validate = await fetch(`http://127.0.0.1:${port}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PINS.refereePin, type: 'referee' })
    })
    assert.equal(validate.status, 200)
    assert.equal((await validate.json()).match.id, seedA)
    assert.equal(referee.messages.filter((m) => m.type === 'live-state-update').length, 1)
    assert.equal(containsPin(referee.raw.join('')), false)

    // Tablet status for the scorer: who watches this match, as what
    const conns = await (await fetch(`http://127.0.0.1:${port}/api/server/connections?matchId=${seedA}`)).json()
    assert.equal(conns.referees, 1)
    assert.equal(conns.clients[0].role, 'referee')
    assert.equal(conns.matchSubscriptions[seedA], 1) // the scoreboard is not a watcher

    // A socket that never proved the match cannot leave the game PIN out: it
    // is asked for it (nothing compared, nothing counted)
    const intruder = await openClient(wsUrl)
    intruder.send(syncMessage({ ...noPins }))
    await intruder.waitFor((m) => m.type === 'error' && m.code === 'pins-required' && m.matchId === seedA)

    courtA.send({ type: 'delete-match', matchId: 1 })
    await referee.waitFor((m) => m.type === 'match-deleted' && m.matchId === seedA)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/match/${seedB}`)).status, 200)

    // The relay lost the match while courtA's socket stayed open: its usual
    // PIN-less sync must not recreate it without PINs (claimable by anyone)
    courtA.send(syncMessage({ ...noPins }))
    await courtA.waitFor((m) => m.type === 'error' && m.code === 'pins-required' && m.matchId === seedA)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/match/${seedA}`)).status, 404)
    // Resent with the PINs, the room is back and PIN-protected
    courtA.send(syncMessage(makeMatch({ id: 1, seed_key: seedA, gamePin: '111111' })))
    courtA.send({ type: 'ping' })
    await courtA.waitFor((m) => m.type === 'pong' && courtA.messages.filter((x) => x.type === 'pong').length >= 1)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/match/${seedA}`)).status, 200)
    const revalidate = await fetch(`http://127.0.0.1:${port}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PINS.refereePin, type: 'referee' })
    })
    assert.equal(revalidate.status, 200)

    for (const c of [courtA, courtB, referee, intruder]) c.ws.close()
  })

  it('anonymous subscribers and GET /api/match/:id get no dates of birth, officials or signatures', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seed = 'match_1791215210060_privac'
    const DOBS = ['2001-04-17', '1975-08-09', '1982-11-23']
    const SIG = 'data:image/png;base64,SIGNATUREBYTES'
    const leaks = (text) => DOBS.some((d) => text.includes(d)) || text.includes(SIG) || text.includes('NZL') ||
      /"officials"|"signatures"|ignature"|"pendingHomeRoster"|"manual_changes"|"approval"/.test(text)
    const match = makeMatch({
      id: 41,
      seed_key: seed,
      gamePin: '414141',
      officials: [{ role: '1st referee', lastName: 'Ref', country: 'NZL', dob: DOBS[2] }],
      bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: DOBS[1] }],
      players_home: [{ number: 7, lastName: 'Player', dob: DOBS[0] }],
      homeCoachSignature: SIG,
      awayCaptainSignature: SIG,
      signatures: { home_coach: SIG },
      approval: { approved: true, by: 'Ref' },
      pendingHomeRoster: { players: [{ number: 3, dob: DOBS[0] }] },
      manual_changes: [{ field: 'score' }]
    })
    const scoreboard = await openClient(wsUrl)
    const livescore = await openClient(wsUrl)
    const subscriber = await openClient(wsUrl)
    scoreboard.send(syncMessage(match, {
      homePlayers: [{ id: 1, number: 7, lastName: 'Player', dob: DOBS[0], country: 'NZL', isCaptain: true }]
    }))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')

    // Without a PIN (livescore): the public summary. With the referee PIN: the
    // bundle, still without personal data.
    livescore.send({ type: 'subscribe-match', matchId: seed, role: 'livescore' })
    subscriber.send({ type: 'subscribe-match', matchId: seed, pin: PINS.refereePin })
    const full = await subscriber.waitFor((m) => m.type === 'match-full-data')
    const summary = await livescore.waitFor((m) => m.type === 'match-full-data')
    assert.equal(summary.access, 'summary')
    assert.deepEqual(summary.homePlayers, [])
    assert.equal(summary.match.bench_home, undefined)
    // What the tablets render stays
    assert.deepEqual(full.homePlayers[0], { id: 1, number: 7, lastName: 'Player', isCaptain: true })
    assert.deepEqual(full.match.bench_home[0], { role: 'Coach', firstName: 'Cora', lastName: 'Coach' })
    assert.equal(full.match.status, 'live')

    scoreboard.send(syncMessage(match, { events: [{ id: 9 }], homePlayers: [{ number: 7, dob: DOBS[0] }] }))
    await subscriber.waitFor((m) => m.type === 'match-data-update')
    await livescore.waitFor((m) => m.type === 'match-data-update')

    const viaHttp = await (await fetch(`http://127.0.0.1:${port}/api/match/${seed}`, { headers: { 'X-OV-Match-Pin': PINS.refereePin } })).text()
    const validate = await (await fetch(`http://127.0.0.1:${port}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PINS.refereePin, type: 'referee' })
    })).text()
    for (const [what, text] of [['subscriber', subscriber.raw.join('')], ['livescore', livescore.raw.join('')],
      ['GET /api/match/:id', viaHttp], ['validate-pin', validate]]) {
      assert.equal(leaks(text), false, `${what} leaks personal data: ${text.slice(0, 400)}`)
      assert.equal(containsPin(text), false, what)
    }
    assert.match(viaHttp, /"lastName":"Player"/)

    scoreboard.send({ type: 'delete-match', matchId: 41 })
    await subscriber.waitFor((m) => m.type === 'match-deleted')
    for (const c of [scoreboard, livescore, subscriber]) c.ws.close()
  })

  it('a scorer\'s PIN-less syncs are never failures: asked for the PINs, a venue NAT is not locked out', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seed = 'match_1791215210077_cccccc'
    const strip = (m) => {
      const { refereePin, homeTeamPin, awayTeamPin, homeTeamUploadPin, awayTeamUploadPin, gamePin, ...rest } = m
      return rest
    }
    const full = makeMatch({ id: 1, seed_key: seed, gamePin: '777777' })

    const fresh = await openClient(wsUrl)
    fresh.send(syncMessage(full))
    fresh.send({ type: 'ping' })
    await fresh.waitFor((m) => m.type === 'pong')
    assert.equal(fresh.messages.some((m) => m.type === 'error'), false)

    // A second socket of the same scorer (reconnect, another view) syncing
    // without PINs, over and over: asked for them each time, never refused
    // as an owner mismatch nor rate limited (more than the failure limit)
    const second = await openClient(wsUrl)
    for (let i = 0; i < 8; i++) second.send(syncMessage(strip(full)))
    second.send({ type: 'ping' })
    await second.waitFor((m) => m.type === 'pong')
    const errors = second.messages.filter((m) => m.type === 'error')
    assert.equal(errors.length, 8)
    assert.ok(errors.every((m) => m.code === 'pins-required'))
    // With its PINs it proves the match at once
    second.send(syncMessage(full, { events: [{ id: 9 }] }))
    second.send({ type: 'ping' })
    await second.waitFor((m) => m.type === 'pong' && second.messages.filter((x) => x.type === 'pong').length === 2)
    assert.equal(second.messages.filter((m) => m.type === 'error').length, 8)

    // Wrong PINs from other sockets behind the same address use up their own
    // socket's limit, not the whole venue's: another scorer still proves its match
    for (let s = 0; s < 2; s++) {
      const guesser = await openClient(wsUrl)
      for (let i = 0; i < 5; i++) guesser.send(syncMessage({ ...full, gamePin: String(200000 + s * 10 + i) }))
      guesser.send({ type: 'ping' })
      await guesser.waitFor((m) => m.type === 'pong')
      guesser.ws.close()
    }
    const third = await openClient(wsUrl)
    third.send(syncMessage(full))
    third.send({ type: 'ping' })
    await third.waitFor((m) => m.type === 'pong')
    assert.equal(third.messages.some((m) => m.type === 'error'), false)

    for (const c of [fresh, second, third]) c.ws.close()
  })

  // National peak load test 2026-10-26: the scorer's undo snapshots
  // (stateSnapshot on every point, stateBefore on rally starts, rotations,
  // substitutions) were about 90% of a bundle, 2.4 MB at the end of a 5-set
  // match. The relay kept them parsed per match and sent them whole to every
  // tablet twice per rally; no subscriber reads them. Older scorers still
  // send them.
  it('stores and relays the events without the scorer\'s undo snapshots', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seed = 'match_1791215210060_snapsh'
    const match = makeMatch({ id: 43, seed_key: seed, gamePin: '434343' })
    const snap = { pointsA: 3, pointsB: 2, lineupA: { I: 1, II: 2 }, marker: 'SNAPSHOT-BYTES' }
    const events = [
      { id: 1, seq: 1, setIndex: 1, type: 'rally_start', payload: {}, ts: '2026-11-29T10:00:00.000Z', stateBefore: snap },
      { id: 2, seq: 2, setIndex: 1, type: 'point', payload: { team: 'home' }, ts: '2026-11-29T10:00:20.000Z', stateSnapshot: snap },
      { id: 3, seq: 3, setIndex: 1, type: 'timeout', payload: { team: 'away' }, ts: '2026-11-29T10:01:00.000Z' }
    ]
    const thin = events.map(({ stateBefore, stateSnapshot, ...rest }) => rest)
    const scoreboard = await openClient(wsUrl)
    const referee = await openClient(wsUrl)
    scoreboard.send(syncMessage(match, { events }))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')
    referee.send({ type: 'subscribe-match', matchId: seed, pin: PINS.refereePin })
    const full = await referee.waitFor((m) => m.type === 'match-full-data')
    assert.equal(full.access, 'full')
    assert.deepEqual(full.events, thin)
    scoreboard.send(syncMessage(match, { events: [...events, { id: 4, seq: 4, setIndex: 1, type: 'point', payload: { team: 'away' }, ts: '2026-11-29T10:01:30.000Z', stateSnapshot: snap }] }))
    const update = await referee.waitFor((m) => m.type === 'match-data-update')
    assert.deepEqual(update.events.map((e) => e.id), [1, 2, 3, 4])
    const viaHttp = await (await fetch(`http://127.0.0.1:${port}/api/match/${seed}`, { headers: { 'X-OV-Match-Pin': PINS.refereePin } })).json()
    assert.deepEqual(viaHttp.events.slice(0, 3), thin)
    for (const text of [referee.raw.join(''), JSON.stringify(viaHttp)]) assert.equal(text.includes('SNAPSHOT-BYTES'), false)
    scoreboard.send({ type: 'delete-match', matchId: 43 })
    await referee.waitFor((m) => m.type === 'match-deleted')
    for (const c of [scoreboard, referee]) c.ws.close()
  })

  // National peak load test 2026-10-26: every role socket that received a
  // bundle kept its own zlib deflate context (about 150 KB in the production
  // image; 1,000 tablets 224 MB of RSS against 76 MB without), and each bundle
  // was deflated once per tablet. A scorer's compressed upload is still
  // accepted (older scorers send whole bundles).
  it('takes compressed syncs, sends the tablets plain frames', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seed = 'match_1791215210060_deflat'
    const match = makeMatch({ id: 44, seed_key: seed, gamePin: '444444' })
    const events = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, seq: i + 1, setIndex: 1, type: 'point', payload: { team: i % 2 ? 'home' : 'away', note: 'same text every time '.repeat(10) }, ts: '2026-11-29T10:00:00.000Z' }))
    const scoreboard = await openClient(wsUrl)
    const referee = await openClient(wsUrl)
    assert.equal(scoreboard.ws.extensions, 'permessage-deflate', 'compressed uploads are negotiated')
    scoreboard.send(syncMessage(match, { events }))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')
    const before = referee.ws._socket.bytesRead
    referee.send({ type: 'subscribe-match', matchId: seed, pin: PINS.refereePin })
    const full = await referee.waitFor((m) => m.type === 'match-full-data')
    assert.equal(full.events.length, 200)
    const text = referee.raw[referee.raw.length - 1]
    assert.ok(referee.ws._socket.bytesRead - before >= Buffer.byteLength(text), 'the bundle arrived as a plain frame')
    scoreboard.send({ type: 'delete-match', matchId: 44 })
    await referee.waitFor((m) => m.type === 'match-deleted')
    for (const c of [scoreboard, referee]) c.ws.close()
  })

  // A tablet that stopped reading (a dead Wi-Fi link the heartbeat has not
  // caught yet) kept every bundle queued in the backend's memory; the live
  // hub drops such sockets, the role sockets did not.
  it('drops a tablet whose unsent bundles pile up', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const seed = 'match_1791215210060_stalls'
    const match = makeMatch({ id: 45, seed_key: seed, gamePin: '454545' })
    const big = 'b'.repeat(1024 * 1024)
    const scoreboard = await openClient(wsUrl)
    const referee = await openClient(wsUrl)
    scoreboard.send(syncMessage(match))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')
    referee.send({ type: 'subscribe-match', matchId: seed, pin: PINS.refereePin })
    await referee.waitFor((m) => m.type === 'match-full-data')
    const closed = new Promise((resolve) => referee.ws.once('close', () => resolve(true)))
    // the tablet stops reading; the scorer goes on (30 bundles of 1 MB)
    referee.ws._socket.pause()
    for (let i = 0; i < 30; i++) {
      scoreboard.send(syncMessage(match, { events: [{ id: i + 1, seq: i + 1, setIndex: 1, type: 'remark', payload: { text: big }, ts: '2026-11-29T10:00:00.000Z' }] }))
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong' && !m.seen && (m.seen = true))
    }
    referee.ws._socket.resume()
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 5000))])
    assert.equal(outcome, true, 'the stalled tablet was dropped (it reconnects and gets the latest bundle)')
    assert.ok(referee.messages.filter((m) => m.type === 'match-data-update').length < 30)
    scoreboard.send({ type: 'delete-match', matchId: 45 })
    scoreboard.ws.close()
  })

  it('GET /api/match/list: every published scheduled/live match, referee connection or not, public fields only', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const courtA = await openClient(wsUrl)
    const beach = await openClient(wsUrl)
    const rehearsal = await openClient(wsUrl)
    const done = await openClient(wsUrl)
    // Referee connection off: the default for a new match
    courtA.send(syncMessage(makeMatch({ id: 1, seed_key: 'list-court-a', gamePin: '515151', status: 'scheduled', refereeConnectionEnabled: false, scheduledAt: '2026-10-05T17:00:00.000Z' })))
    // openbeach: team1Team / team2Team
    const beachSync = syncMessage(makeMatch({ id: 1, seed_key: 'list-beach', gamePin: '525252', scheduledAt: '2026-10-05T19:00:00.000Z' }))
    delete beachSync.homeTeam
    delete beachSync.awayTeam
    beach.send({ ...beachSync, team1Team: { id: 1, name: 'Muster / Meier', color: '#e2001a' }, team2Team: { id: 2, name: 'Rossi / Bianchi' } })
    // A rehearsal match (no game PIN) is listed by a venue relay
    rehearsal.send(syncMessage({ id: 1, seedKey: 'list-test', test: true, status: 'live' }))
    done.send(syncMessage(makeMatch({ id: 1, seed_key: 'list-final', gamePin: '535353', status: 'final' })))
    for (const c of [courtA, beach, rehearsal, done]) {
      c.send({ type: 'ping' })
      await c.waitFor((m) => m.type === 'pong')
      assert.equal(c.messages.some((m) => m.type === 'error'), false)
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/match/list`)
    assert.equal(res.status, 200)
    const text = await res.text()
    const mine = JSON.parse(text).matches.filter((m) => String(m.id).startsWith('list-'))
    assert.deepEqual(mine.map((m) => m.id), ['list-beach', 'list-court-a', 'list-test'])
    assert.deepEqual(mine[1], {
      id: 'list-court-a',
      gameNumber: 4242,
      homeTeam: 'Home VC',
      awayTeam: 'Away VC',
      scheduledAt: '2026-10-05T17:00:00.000Z',
      dateTime: mine[1].dateTime,
      status: 'scheduled',
      sportType: 'indoor',
      test: false,
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: false
    })
    assert.equal(mine[0].homeTeam, 'Muster / Meier')
    assert.equal(mine[0].awayTeam, 'Rossi / Bianchi')
    assert.equal(mine[0].sportType, 'beach')
    assert.equal(mine[2].sportType, 'indoor')
    assert.equal(mine[2].test, true)
    assert.equal(containsPin(text), false)
    assert.ok(!/dob|lastName|officials|ignature/.test(text))

    // ?finished=1 (the livescore): the finished match too, same row shape
    const all = await fetch(`http://127.0.0.1:${port}/api/match/list?finished=1`)
    const allText = await all.text()
    const allMine = JSON.parse(allText).matches.filter((m) => String(m.id).startsWith('list-'))
    assert.deepEqual(allMine.map((m) => m.id).sort(), ['list-beach', 'list-court-a', 'list-final', 'list-test'])
    const final = allMine.find((m) => m.id === 'list-final')
    assert.equal(final.status, 'final')
    assert.deepEqual(Object.keys(final).sort(), Object.keys(mine[1]).sort())
    assert.equal(containsPin(allText), false)
    assert.ok(!/dob|lastName|officials|ignature/.test(allText))

    // A livescore viewer (no PIN) follows it: the summary, then live states
    const viewer = await openClient(wsUrl)
    viewer.send({ type: 'subscribe-match', matchId: 'list-court-a', device: 'livescore' })
    const first = await viewer.waitFor((m) => m.type === 'match-full-data')
    assert.equal(first.access, 'summary')
    assert.deepEqual(first.homePlayers, [])
    courtA.send({ type: 'live-state-update', matchId: 'list-court-a', liveState: { points_a: 4, points_b: 2, serving_team: 'right', timeouts_b: 1 } })
    const live = await viewer.waitFor((m) => m.type === 'live-state-update')
    assert.deepEqual(live.liveState, { points_a: 4, points_b: 2, serving_team: 'right', timeouts_b: 1 })
    const seen = JSON.stringify(viewer.messages)
    assert.equal(containsPin(seen), false)
    assert.ok(!/dob|lastName|officials|ignature/.test(seen))
    viewer.ws.close()

    // The beach teams also name the public summary an anonymous display gets
    const display = await openClient(wsUrl)
    display.send({ type: 'subscribe-match', matchId: 'list-beach' })
    const summary = await display.waitFor((m) => m.type === 'match-full-data')
    assert.equal(summary.access, 'summary')
    assert.deepEqual(summary.homeTeam, { name: 'Muster / Meier', color: '#e2001a' })
    assert.deepEqual(summary.awayTeam, { name: 'Rossi / Bianchi' })

    for (const c of [courtA, beach, rehearsal, done, display]) c.ws.close()
  })

  it('refuses a frame nested too deeply, so nothing read back from it can end the backend', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const httpBase = `http://127.0.0.1:${port}`
    const anyone = await openClient(wsUrl)
    // JSON.parse takes this, JSON.stringify throws RangeError on it (20 KB).
    // The relay used to store it, and the next GET /api/match/:id threw in the
    // request handler, which ended the process.
    const deep = '['.repeat(10000) + ']'.repeat(10000)
    anyone.ws.send(`{"type":"sync-match-data","matchId":"deep-1","match":{"id":"deep-1","seed_key":"deep-1","status":"live","gamePin":"481516","deep":${deep}},"sets":[],"events":[]}`)
    anyone.ws.send(`{"type":"live-state-update","matchId":"deep-1","liveState":{"deep":${deep}}}`)
    anyone.send({ type: 'ping' })
    await anyone.waitFor((m) => m.type === 'pong')
    for (const headers of [{ 'X-OV-Match-Pin': '481516' }, {}]) {
      assert.equal((await fetch(`${httpBase}/api/match/deep-1`, { headers })).status, 404)
    }
    assert.equal((await fetch(`${httpBase}/api/match/list`)).status, 200)
    assert.equal((await fetch(`${httpBase}/health`)).status, 200)
    assert.deepEqual(anyone.messages.filter((m) => m.type === 'error').map((m) => m.code), ['bad-request', 'bad-request'])
    anyone.ws.close()
  })

  it('stops game-PIN guessing without revealing a hit', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const scoreboard = await openClient(wsUrl)
    scoreboard.send(syncMessage(makeMatch({ id: 31, gamePin: '313131' })))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')

    const guesser = await openClient(wsUrl)
    for (let i = 0; i < 5; i++) guesser.send(syncMessage(makeMatch({ id: 31, gamePin: String(100000 + i) })))
    guesser.send(syncMessage(makeMatch({ id: 31, gamePin: '313131' }))) // the right one
    guesser.send({ type: 'ping' })
    await guesser.waitFor((m) => m.type === 'pong')
    const errors = guesser.messages.filter((m) => m.type === 'error')
    assert.equal(errors.length, 6)
    // (an earlier test's failure from this IP may count toward the limit too)
    assert.ok(errors.filter((m) => m.code === 'not-match-owner').length <= 5)
    // The right PIN is refused exactly like a wrong one once over the limit
    assert.deepEqual(errors.at(-1), { type: 'error', code: 'rate-limited', message: errors.at(-1).message, matchId: '31' })

    // The proven scoreboard keeps syncing
    scoreboard.send(syncMessage(makeMatch({ id: 31, gamePin: '313131' })))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong' && scoreboard.messages.length > 2)
    assert.equal(scoreboard.messages.some((m) => m.type === 'error'), false)

    for (const c of [scoreboard, guesser]) c.ws.close()
  })
})

describe('backend relay in cloud mode (IS_CLOUD)', () => {
  let child
  let port

  before(async () => {
    port = await freePort()
    const env = { ...process.env, PORT: String(port), IS_CLOUD: '1' }
    for (const k of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'POCKETBASE_URL', 'TRUST_PROXY']) delete env[k]
    child = spawn(process.execPath, ['server.js', '--local'], { cwd: BACKEND_DIR, env, stdio: 'ignore' })
    const start = Date.now()
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
      } catch { /* not up yet */ }
      if (Date.now() - start > 10000) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(() => {
    child?.kill('SIGKILL')
  })

  it('a test (rehearsal) match is neither listed nor fanned out live: it belongs to the venue relay', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const rehearsal = await openClient(wsUrl)
    const official = await openClient(wsUrl)
    const hidden = await openClient(wsUrl)
    rehearsal.send(syncMessage({ id: 1, seedKey: 'cloud-test', test: true, status: 'live', refereeConnectionEnabled: true }))
    official.send(syncMessage(makeMatch({ id: 1, seed_key: 'cloud-real', gamePin: '545454', refereeConnectionEnabled: true })))
    // Referee connection off: only its own venue's public address sees it on
    // the cloud (cloudListsMatch), and loopback is no venue
    hidden.send(syncMessage(makeMatch({ id: 1, seed_key: 'cloud-off', gamePin: '565656', refereeConnectionEnabled: false })))
    for (const c of [rehearsal, official, hidden]) {
      c.send({ type: 'ping' })
      await c.waitFor((m) => m.type === 'pong')
    }
    const list = await (await fetch(`http://127.0.0.1:${port}/api/match/list`)).json()
    assert.deepEqual(list.matches.map((m) => m.id), ['cloud-real'])
    hidden.ws.close()

    const display = await openClient(wsUrl)
    display.send({ type: 'subscribe-match', matchId: 'cloud-test' })
    display.send({ type: 'subscribe-match', matchId: 'cloud-real' })
    await display.waitFor((m) => m.type === 'match-full-data' && m.matchId === 'cloud-real')
    rehearsal.send({ type: 'live-state-update', matchId: 'cloud-test', liveState: { points_a: 1 } })
    official.send({ type: 'live-state-update', matchId: 'cloud-real', liveState: { points_a: 2 } })
    const live = await display.waitFor((m) => m.type === 'live-state-update')
    assert.equal(live.matchId, 'cloud-real')
    display.send({ type: 'ping' })
    await display.waitFor((m) => m.type === 'pong')
    assert.equal(display.messages.some((m) => m.type === 'live-state-update' && m.matchId === 'cloud-test'), false)

    for (const c of [rehearsal, official, display]) c.ws.close()
  })
})

describe('backend relay in cloud mode behind Cloudflare: a hall behind one address', () => {
  let child
  let port
  const HALL = { 'cf-connecting-ip': '203.0.113.77' }

  before(async () => {
    port = await freePort()
    const env = { ...process.env, PORT: String(port), IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }
    for (const k of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'POCKETBASE_URL', 'TRUST_PROXY_FROM']) delete env[k]
    child = spawn(process.execPath, ['server.js', '--local'], { cwd: BACKEND_DIR, env, stdio: 'ignore' })
    const start = Date.now()
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
      } catch { /* not up yet */ }
      if (Date.now() - start > 10000) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(() => {
    child?.kill('SIGKILL')
  })

  // National peak load test 2026-10-26 (literal halls): a hall's 32 matches
  // behind one public address (a school network, mobile CGNAT). From the 21st
  // on the scorers could not own their match (too-many-matches), so their
  // referee and bench tablets got no bundle for the whole set, and the
  // address's 200 relay reads a minute (tablet status polls, referee and bench
  // fetches) ran out at about 12 matches.
  it('one public address carries a hall of 32 matches: their rooms and their relay reads', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`
    const scorers = []
    for (let i = 0; i < 32; i++) {
      const c = await openClient(wsUrl, HALL)
      c.send(syncMessage(makeMatch({ id: 1, seed_key: `hall-${i}`, gamePin: String(600000 + i), refereeConnectionEnabled: true })))
      scorers.push(c)
    }
    for (const c of scorers) {
      c.send({ type: 'ping' })
      await c.waitFor((m) => m.type === 'pong')
    }
    assert.deepEqual(scorers.flatMap((c) => c.messages.filter((m) => m.type === 'error').map((m) => m.code)), [])
    const list = await (await fetch(`http://127.0.0.1:${port}/api/match/list`, { headers: HALL })).json()
    assert.equal(list.matches.filter((m) => m.id.startsWith('hall-')).length, 32)
    // a minute of the hall's relay reads (32 matches: the scorers' tablet
    // status every 10 s, referee and bench fetches)
    const codes = []
    for (let i = 0; i < 600; i++) codes.push((await fetch(`http://127.0.0.1:${port}/api/server/connections?matchId=hall-${i % 32}`, { headers: HALL })).status)
    assert.equal(codes.filter((c) => c === 429).length, 0)
    for (const c of scorers) c.ws.close()
  })
})
