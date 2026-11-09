/**
 * Bench requests (lib/benchRequests.js): the same wire scenario against every
 * relay runtime:
 *   - backend/server.js --local        tests/benchRequests.relay.test.js (node:test)
 *   - the LAN relays (frontend/server.js, the Electron relay) and the Tauri
 *     relay (OV_TAURI_RELAY_BIN)       frontend/src/utils/__tests__/lanRelayProtocol.test.js (vitest)
 *
 * A scorer syncs a match; home bench, away bench, referee and a livescore
 * subscribe. Then:
 *   - a bench sends only for its own team (its PIN, its connection on);
 *     the referee PIN, the game PIN or a wrong team send nothing
 *   - a line-up goes to the scoreboard only: never to the other bench, the
 *     referee or the livescore (FIVB 7.3)
 *   - the answer goes to that team's bench only; accepted locks the set's line-up
 *   - time-out / substitution requests are noted to the referee
 *     (bench-request-info), and cleared there when answered
 *   - a scorer that reconnects gets the open requests again; a bench that
 *     reconnects its team's requests (bench-request-state)
 *   - a set that is over drops its requests; a bench whose connection the
 *     scorer switched off is refused; malformed requests are refused
 *   - only the scoreboard answers; more than 30 requests a minute are refused
 *
 * Plain node:assert. The caller passes `openClient(url)` ({ ws, send,
 * waitFor, messages, raw }, resolving after 'connected').
 */
import assert from 'node:assert/strict'

export const BENCH_CONTRACT_PINS = Object.freeze({
  gamePin: '402719',
  refereePin: '513820',
  homeTeamPin: '624931',
  awayTeamPin: '735042',
  homeTeamUploadPin: '846153',
  awayTeamUploadPin: '957264'
})
const PIN_VALUES = Object.values(BENCH_CONTRACT_PINS)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LINEUP = { I: 4, II: 5, III: 6, IV: 7, V: 8, VI: 9 }
const LINEUP_TEXT = /"lineup":\{"I":4/
const isBench = (m) => typeof m?.type === 'string' && m.type.startsWith('bench-')

/**
 * @param {{ wsUrl: string, openClient: (url: string) => Promise<any>, tag?: string }} opts
 */
export async function runBenchRequestContract ({ wsUrl, openClient, tag = 'relay' }) {
  const seed = `bench-req-${tag}-${Date.now().toString(36)}`
  const P = BENCH_CONTRACT_PINS
  const clients = []
  const open = async () => {
    const c = await openClient(wsUrl)
    clients.push(c)
    return c
  }
  // Every message this client sent before has been handled by the relay
  const settle = async (c) => {
    const before = c.messages.filter((m) => m.type === 'pong').length
    c.send({ type: 'ping' })
    await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > before)
  }
  const match = (over = {}) => ({
    id: 1,
    seed_key: seed,
    status: 'live',
    gameNumber: 7301,
    scheduledAt: '2026-11-09T18:00:00.000Z',
    refereeConnectionEnabled: true,
    homeTeamConnectionEnabled: true,
    awayTeamConnectionEnabled: true,
    ...P,
    ...over
  })
  const sync = (c, over = {}, sets = [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }]) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: match(over),
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ id: n, teamId: 1, number: n })),
    awayPlayers: [1, 2, 3, 12, 13, 14, 15].map((n) => ({ id: 100 + n, teamId: 2, number: n })),
    sets,
    events: [],
    _timestamp: Date.now()
  })
  const subscribe = (c, pin, device, team) => c.send({ type: 'subscribe-match', matchId: seed, ...(pin ? { pin } : {}), ...(device ? { device } : {}), ...(team ? { team } : {}) })
  const request = (c, team, req) => c.send({ type: 'bench-request', matchId: seed, team, request: req })
  const refusedWith = (c, id, reason) => c.waitFor((m) => m.type === 'error' && m.code === 'bench-request-refused' && (id == null || m.id === id) && (reason == null || m.reason === reason))
  let n = 0
  const rid = (p) => `${p}-${tag}-${++n}`

  try {
    const scorer = await open()
    sync(scorer)
    await settle(scorer)

    const home = await open()
    const away = await open()
    const referee = await open()
    const livescore = await open()
    const gameDevice = await open()
    subscribe(home, P.homeTeamPin, 'bench', 'home')
    subscribe(away, P.awayTeamPin, 'bench', 'away')
    subscribe(referee, P.refereePin, 'referee')
    subscribe(livescore, null, 'livescore')
    subscribe(gameDevice, P.gamePin)
    for (const c of [home, away, referee, livescore, gameDevice]) {
      await c.waitFor((m) => m.type === 'match-full-data')
      await settle(c)
    }
    // A bench (re)subscribing learns its team's requests (none yet)
    const homeState = await home.waitFor((m) => m.type === 'bench-request-state')
    assert.equal(homeState.team, 'home', `${tag}: state for the home bench`)
    assert.deepEqual(homeState.requests, [], `${tag}: nothing yet`)

    // --- who may send ------------------------------------------------------
    const wrongTeam = rid('wt')
    request(home, 'away', { id: wrongTeam, kind: 'timeout', setIndex: 1 })
    await refusedWith(home, wrongTeam, 'not-this-bench')
    const refAsBench = rid('rb')
    request(referee, 'home', { id: refAsBench, kind: 'timeout', setIndex: 1 })
    await refusedWith(referee, refAsBench, 'not-this-bench')
    const gameAsBench = rid('gb')
    request(gameDevice, 'home', { id: gameAsBench, kind: 'timeout', setIndex: 1 })
    await refusedWith(gameDevice, gameAsBench, 'not-this-bench')
    const anon = rid('an')
    request(livescore, 'home', { id: anon, kind: 'timeout', setIndex: 1 })
    await refusedWith(livescore, anon, 'not-this-bench')
    // malformed: a duplicate number, no six, an unknown kind, a bad id
    const dup = rid('dup')
    request(home, 'home', { id: dup, kind: 'lineup', setIndex: 1, lineup: { ...LINEUP, II: 4 } })
    await refusedWith(home, dup, 'bad-lineup')
    const five = rid('five')
    request(home, 'home', { id: five, kind: 'lineup', setIndex: 1, lineup: { I: 4, II: 5, III: 6, IV: 7, V: 8 } })
    await refusedWith(home, five, 'bad-lineup')
    const gcOff = rid('gco')
    request(home, 'home', { id: gcOff, kind: 'lineup', setIndex: 1, lineup: LINEUP, gameCaptain: 11 })
    await refusedWith(home, gcOff, 'bad-captain')
    const kind = rid('kind')
    request(home, 'home', { id: kind, kind: 'challenge', setIndex: 1 })
    await refusedWith(home, kind, 'bad-kind')
    request(home, 'home', { id: 'not ok!', kind: 'timeout', setIndex: 1 })
    await refusedWith(home, null, 'bad-id')
    await settle(scorer)
    assert.equal(scorer.messages.filter(isBench).length, 0, `${tag}: nothing refused reached the scorer`)

    // --- a line-up: scorer only, declined then accepted ---------------------
    const lu1 = rid('lu')
    request(home, 'home', { id: lu1, kind: 'lineup', setIndex: 1, lineup: LINEUP, gameCaptain: 7 })
    const ack1 = await home.waitFor((m) => m.type === 'bench-request-ack' && m.id === lu1)
    assert.equal(ack1.delivered, 1, `${tag}: delivered to the one scoreboard`)
    assert.equal(ack1.status, 'pending')
    const got1 = await scorer.waitFor((m) => m.type === 'bench-request' && m.request?.id === lu1)
    assert.equal(got1.team, 'home')
    assert.deepEqual(got1.request.lineup, LINEUP)
    assert.equal(got1.request.gameCaptain, 7)
    assert.equal(got1.status, 'pending')
    scorer.send({ type: 'bench-response', matchId: seed, team: 'home', id: lu1, status: 'declined', reason: 'No 9 is not on the scoresheet' })
    const dec = await home.waitFor((m) => m.type === 'bench-response' && m.id === lu1)
    assert.equal(dec.status, 'declined')
    assert.equal(dec.reason, 'No 9 is not on the scoresheet')
    // a re-send replaces the open one; then accepted
    const lu2 = rid('lu')
    request(home, 'home', { id: lu2, kind: 'lineup', setIndex: 1, lineup: LINEUP })
    await scorer.waitFor((m) => m.type === 'bench-request' && m.request?.id === lu2)
    const lu3 = rid('lu')
    request(home, 'home', { id: lu3, kind: 'lineup', setIndex: 1, lineup: { ...LINEUP, VI: 10 } })
    const ack3 = await home.waitFor((m) => m.type === 'bench-request-ack' && m.id === lu3)
    assert.deepEqual(ack3.superseded, [lu2], `${tag}: the newer line-up replaces the open one`)
    await scorer.waitFor((m) => m.type === 'bench-request' && m.request?.id === lu3)
    scorer.send({ type: 'bench-response', matchId: seed, team: 'home', id: lu3, status: 'accepted' })
    const acc = await home.waitFor((m) => m.type === 'bench-response' && m.id === lu3)
    assert.equal(acc.status, 'accepted')
    // locked once accepted
    const lu4 = rid('lu')
    request(home, 'home', { id: lu4, kind: 'lineup', setIndex: 1, lineup: LINEUP })
    await refusedWith(home, lu4, 'lineup-locked')
    // an answer to a request that is no longer open
    scorer.send({ type: 'bench-response', matchId: seed, team: 'home', id: lu3, status: 'declined' })
    await refusedWith(scorer, lu3, 'unknown-request')
    // only the scoreboard answers
    home.send({ type: 'bench-response', matchId: seed, team: 'home', id: lu3, status: 'accepted' })
    await home.waitFor((m) => m.type === 'error' && m.code === 'not-match-owner')

    // nobody else saw any of it
    for (const [c, who] of [[away, 'away bench'], [referee, 'referee'], [livescore, 'livescore'], [gameDevice, 'game-PIN device']]) {
      await settle(c)
      assert.equal(c.messages.filter((m) => isBench(m) && m.type !== 'bench-request-state').length, 0, `${tag}: no bench message reached the ${who}`)
      assert.ok(!c.raw.some((t) => LINEUP_TEXT.test(t) && t.includes('bench-')), `${tag}: the line-up never reached the ${who}`)
    }

    // --- a time-out request: scorer + referee note, never the other bench ---
    const to1 = rid('to')
    request(away, 'away', { id: to1, kind: 'timeout', setIndex: 1 })
    await away.waitFor((m) => m.type === 'bench-request-ack' && m.id === to1)
    await scorer.waitFor((m) => m.type === 'bench-request' && m.request?.id === to1 && m.team === 'away')
    const info = await referee.waitFor((m) => m.type === 'bench-request-info' && m.id === to1)
    assert.equal(info.kind, 'timeout')
    assert.equal(info.team, 'away')
    assert.equal(info.status, 'pending')
    scorer.send({ type: 'bench-response', matchId: seed, team: 'away', id: to1, status: 'seen' })
    const seen = await away.waitFor((m) => m.type === 'bench-response' && m.id === to1 && m.status === 'seen')
    assert.equal(seen.kind, 'timeout')

    // --- the scorer reconnects: it gets the open requests again --------------
    scorer.ws.close()
    await sleep(150)
    const scorer2 = await open()
    sync(scorer2)
    const replay = await scorer2.waitFor((m) => m.type === 'bench-request' && m.request?.id === to1)
    assert.equal(replay.replay, true)
    assert.equal(replay.status, 'seen')
    assert.ok(!scorer2.messages.some((m) => m.type === 'bench-request' && m.request?.id === lu3), `${tag}: an answered request is not replayed`)

    // --- the bench reconnects: its team's requests --------------------------
    const away2 = await open()
    subscribe(away2, P.awayTeamPin, 'bench', 'away')
    const st = await away2.waitFor((m) => m.type === 'bench-request-state')
    assert.equal(st.team, 'away')
    assert.deepEqual(st.requests.map((r) => [r.id, r.kind, r.status]), [[to1, 'timeout', 'seen']])
    const home2 = await open()
    subscribe(home2, P.homeTeamPin, 'bench', 'home')
    const st2 = await home2.waitFor((m) => m.type === 'bench-request-state')
    assert.ok(st2.requests.some((r) => r.id === lu3 && r.status === 'accepted'), `${tag}: the accepted line-up is still known to its bench`)
    assert.ok(!st2.requests.some((r) => r.id === to1), `${tag}: never the other team's`)
    // a referee that (re)subscribes learns the open time-out request
    const referee2 = await open()
    subscribe(referee2, P.refereePin, 'referee')
    await referee2.waitFor((m) => m.type === 'bench-request-info' && m.id === to1 && m.status === 'seen')

    scorer2.send({ type: 'bench-response', matchId: seed, team: 'away', id: to1, status: 'accepted' })
    await away2.waitFor((m) => m.type === 'bench-response' && m.id === to1 && m.status === 'accepted')
    await away.waitFor((m) => m.type === 'bench-response' && m.id === to1 && m.status === 'accepted')
    await referee.waitFor((m) => m.type === 'bench-request-info' && m.id === to1 && m.status === 'accepted')

    // --- a prepared double substitution, then cancelled ---------------------
    const sub1 = rid('sub')
    request(away2, 'away', { id: sub1, kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 12 }, { out: 2, in: 13 }] })
    const gotSub = await scorer2.waitFor((m) => m.type === 'bench-request' && m.request?.id === sub1)
    assert.deepEqual(gotSub.request.pairs, [{ out: 1, in: 12 }, { out: 2, in: 13 }])
    const subInfo = await referee.waitFor((m) => m.type === 'bench-request-info' && m.id === sub1)
    assert.deepEqual(subInfo.pairs, [{ out: 1, in: 12 }, { out: 2, in: 13 }])
    const badPairs = rid('bp')
    request(away2, 'away', { id: badPairs, kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 12 }, { out: 3, in: 12 }] })
    await refusedWith(away2, badPairs, 'bad-pairs')
    const cancel = rid('cx')
    request(away2, 'away', { id: cancel, kind: 'cancel', setIndex: 1, cancelId: sub1 })
    const cAck = await away2.waitFor((m) => m.type === 'bench-request-ack' && m.id === cancel)
    assert.equal(cAck.status, 'cancelled')
    await scorer2.waitFor((m) => m.type === 'bench-request' && m.request?.kind === 'cancel' && m.request?.cancelId === sub1)
    await referee.waitFor((m) => m.type === 'bench-request-info' && m.id === sub1 && m.status === 'cancelled')
    scorer2.send({ type: 'bench-response', matchId: seed, team: 'away', id: sub1, status: 'accepted' })
    await refusedWith(scorer2, sub1, 'unknown-request')

    // --- the set is over: its requests are gone ------------------------------
    const to2 = rid('to')
    request(home2, 'home', { id: to2, kind: 'timeout', setIndex: 1 })
    await scorer2.waitFor((m) => m.type === 'bench-request' && m.request?.id === to2)
    sync(scorer2, {}, [{ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true }, { id: 2, index: 2, homePoints: 0, awayPoints: 0, finished: false }])
    await settle(scorer2)
    const home3 = await open()
    subscribe(home3, P.homeTeamPin, 'bench', 'home')
    const st3 = await home3.waitFor((m) => m.type === 'bench-request-state')
    assert.deepEqual(st3.requests, [], `${tag}: set 1's requests went with set 1`)

    // --- the scorer switches the away bench off ------------------------------
    sync(scorer2, { awayTeamConnectionEnabled: false }, [{ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true }, { id: 2, index: 2, homePoints: 0, awayPoints: 0, finished: false }])
    await settle(scorer2)
    const off = rid('off')
    request(away2, 'away', { id: off, kind: 'timeout', setIndex: 2 })
    await refusedWith(away2, off, 'not-this-bench')

    // no PIN ever left the relay in a bench message
    for (const c of clients) {
      for (const t of c.raw) if (t.includes('"bench-')) assert.ok(!PIN_VALUES.some((p) => t.includes(p)), `${tag}: a bench message carried a PIN`)
    }

    // --- 30 a minute per socket ----------------------------------------------
    const flood = await open()
    subscribe(flood, P.homeTeamPin, 'bench', 'home')
    await flood.waitFor((m) => m.type === 'bench-request-state')
    for (let i = 0; i < 31; i++) request(flood, 'home', { id: `fl-${tag}-${i}`, kind: 'timeout', setIndex: 2 })
    await refusedWith(flood, `fl-${tag}-30`, 'rate-limited')
    assert.equal(flood.messages.filter((m) => m.type === 'bench-request-ack').length, 30)
  } finally {
    for (const c of clients) {
      try { c.ws.close() } catch { /* gone */ }
    }
  }
}
