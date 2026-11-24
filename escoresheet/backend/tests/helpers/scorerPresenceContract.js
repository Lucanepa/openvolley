/**
 * Scorer presence ('scorer-presence' { matchId, present, timestamp }): the
 * same wire scenario against every relay runtime. Present: an open socket of
 * the room holds the match's claim (proved it with an accepted sync); the
 * referee and bench tablets warn when it stays false.
 *   - backend/server.js --local        tests/scorerPresence.relay.test.js (node:test)
 *   - the LAN relays and the Tauri relay: to be run from
 *     frontend/src/utils/__tests__/lanRelayProtocol.test.js (vitest), as the
 *     bench and venue contracts are
 *
 * Checked:
 *   - a tablet that subscribes before the scorer is told false (the room
 *     key, nothing else: no PIN, no device id); the presence is the last
 *     answer to a subscription, a flip comes after the sync's match data
 *   - the scorer's first accepted sync tells it true, once: further syncs and
 *     live states send nothing, the scorer itself is never told
 *   - a tablet subscribing while the scorer is in is told true
 *   - a second scoreboard socket proving the match (a reconnect, another
 *     device taking it over) sends nothing, nor does the first one closing
 *   - the last scorer socket closing tells every tablet false, once; the
 *     scorer back tells them true
 *   - a test match (no PINs) the same
 *
 * Plain node:assert. The caller passes `openClient(url)` ({ ws, send,
 * waitFor, messages, raw }, resolving after 'connected').
 */
import assert from 'node:assert/strict'

export const PRESENCE_CONTRACT_PINS = Object.freeze({
  gamePin: '481526',
  refereePin: '592637',
  homeTeamPin: '603748',
  awayTeamPin: '714859'
})
const PIN_VALUES = Object.values(PRESENCE_CONTRACT_PINS)
// Two scoring devices (db/019 ids; on a venue relay with a claim of the match)
const DEVICE_A = { id: '5c0e7a52-4d1f-4b7e-9a3c-1f2e3d4c5b6a', platform: 'web', claim: 'presence-claim-a' }
const DEVICE_B = { id: '6d1f8b63-5e20-4c8f-8b4d-2a3f4e5d6c7b', platform: 'android', claim: 'presence-claim-b' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isPresence = (m) => m?.type === 'scorer-presence'

/**
 * @param {{ wsUrl: string, openClient: (url: string) => Promise<any>, tag?: string }} opts
 */
export async function runScorerPresenceContract ({ wsUrl, openClient, tag = 'relay' }) {
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
  // A socket the relay has seen close: its close handled before what follows
  const close = async (c) => {
    const closed = new Promise((r) => c.ws.once('close', r))
    c.ws.terminate()
    await closed
    await sleep(300)
  }
  const presenceOf = (c, room) => c.messages.filter((m) => isPresence(m) && m.matchId === room).map((m) => m.present)
  const sync = (c, room, { test = false, device = null, gameNumber = 7401 } = {}) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: room,
      status: 'live',
      gameNumber,
      scheduledAt: '2026-11-15T18:00:00.000Z',
      refereeConnectionEnabled: !test,
      homeTeamConnectionEnabled: !test,
      awayTeamConnectionEnabled: !test,
      ...(test ? { test: true } : PRESENCE_CONTRACT_PINS)
    },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }],
    events: [],
    ...(device ? { device } : {}),
    _timestamp: Date.now()
  })
  const subscribe = (c, room, extra = {}) => c.send({ type: 'subscribe-match', matchId: room, ...extra })

  try {
    // --- an official match (game PIN) ---------------------------------------
    const seed = `presence-${tag}-${Date.now().toString(36)}`
    const referee = await open()
    const bench = await open()
    subscribe(referee, seed, { device: 'referee', pin: PRESENCE_CONTRACT_PINS.refereePin })
    subscribe(bench, seed, { device: 'bench', team: 'home', pin: PRESENCE_CONTRACT_PINS.homeTeamPin })
    for (const c of [referee, bench]) {
      const first = await c.waitFor((m) => isPresence(m))
      assert.equal(first.matchId, seed, `${tag}: named by the room key`)
      assert.equal(first.present, false, `${tag}: no scorer before its first sync`)
      assert.equal(typeof first.timestamp, 'number', `${tag}: ms since epoch`)
      assert.ok(Math.abs(first.timestamp - Date.now()) < 60000, `${tag}: the relay's clock`)
      await settle(c)
    }

    const scorer = await open()
    sync(scorer, seed, { device: DEVICE_A })
    await settle(scorer)
    for (const c of [referee, bench]) {
      const told = await c.waitFor((m) => isPresence(m) && m.present === true)
      await settle(c)
      assert.deepEqual(presenceOf(c, seed), [false, true], `${tag}: the scorer's first sync, once`)
      const snapshot = c.messages.findIndex((m) => m.type === 'match-full-data' || m.type === 'match-data-update')
      assert.ok(snapshot >= 0 && snapshot < c.messages.indexOf(told), `${tag}: after the match data`)
    }

    // further syncs and live states change nothing
    sync(scorer, seed, { device: DEVICE_A })
    scorer.send({ type: 'live-state-update', matchId: 1, liveState: { setIndex: 1, homePoints: 1, awayPoints: 0 } })
    sync(scorer, seed, { device: DEVICE_A })
    await settle(scorer)
    for (const c of [referee, bench]) {
      await settle(c)
      assert.deepEqual(presenceOf(c, seed), [false, true], `${tag}: no repeat on further syncs`)
    }

    // a tablet that subscribes while the scorer is in
    const livescore = await open()
    subscribe(livescore, seed, { device: 'livescore' })
    const late = await livescore.waitFor((m) => isPresence(m))
    assert.equal(late.present, true, `${tag}: a late subscriber is told the scorer is in`)
    await settle(livescore)
    // the last answer to the subscription: after the snapshot (and what else it sends)
    const answers = livescore.messages.filter((m) => m.type !== 'pong' && m.type !== 'connected')
    assert.ok(answers.some((m) => m.type === 'match-full-data'), `${tag}: the snapshot`)
    assert.equal(answers.at(-1), late, `${tag}: presence is the last answer, got ${JSON.stringify(answers.map((m) => m.type))}`)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true], `${tag}: the others are not told again`)

    // another device takes the match over (its game PIN): the new socket is
    // in before the old one is out, nothing is sent in between
    const takeover = await open()
    sync(takeover, seed, { device: DEVICE_B })
    await settle(takeover)
    for (const c of [referee, bench, livescore]) await settle(c)
    assert.deepEqual(presenceOf(referee, seed), [false, true], `${tag}: a take-over is no flip`)
    await close(scorer)
    for (const c of [referee, bench, livescore]) await settle(c)
    assert.deepEqual(presenceOf(referee, seed), [false, true], `${tag}: the old scorer closing is no flip either`)
    assert.deepEqual(presenceOf(livescore, seed), [true], `${tag}: nor to the late one`)

    // the last scorer socket closing: false, once
    await close(takeover)
    for (const c of [referee, bench, livescore]) {
      await c.waitFor((m) => isPresence(m) && m.present === false && c.messages.filter(isPresence).length > (c === livescore ? 1 : 2), 5000)
      await settle(c)
    }
    assert.deepEqual(presenceOf(referee, seed), [false, true, false], `${tag}: the scorer gone`)
    assert.deepEqual(presenceOf(bench, seed), [false, true, false], `${tag}: the bench told too`)
    assert.deepEqual(presenceOf(livescore, seed), [true, false], `${tag}: the livescore told too`)

    // the scorer back (its game PIN): true again
    const back = await open()
    sync(back, seed, { device: DEVICE_B })
    await settle(back)
    for (const c of [referee, bench, livescore]) {
      await c.waitFor((m) => isPresence(m) && c.messages.filter(isPresence).at(-1)?.present === true)
      await settle(c)
    }
    assert.deepEqual(presenceOf(referee, seed), [false, true, false, true], `${tag}: the scorer back`)
    for (const c of [scorer, takeover, back]) {
      assert.deepEqual(c.messages.filter(isPresence), [], `${tag}: a scorer is never told its own presence`)
    }
    // the room key, `present` and the relay's clock, nothing else (no PIN, device or address)
    for (const c of [referee, bench, livescore]) {
      for (const text of c.raw.filter((t) => t.includes('"scorer-presence"'))) {
        assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['matchId', 'present', 'timestamp', 'type'], `${tag}: ${text}`)
        assert.ok(!PIN_VALUES.some((p) => text.includes(p)), `${tag}: no PIN in ${text}`)
        assert.ok(!text.includes(DEVICE_A.id) && !text.includes(DEVICE_B.id), `${tag}: no device id in ${text}`)
      }
    }

    // --- a test match (no PINs): the same --------------------------------------
    const testSeed = `presence-test-${tag}-${Date.now().toString(36)}`
    const watcher = await open()
    subscribe(watcher, testSeed, { device: 'livescore' })
    await watcher.waitFor((m) => isPresence(m) && m.matchId === testSeed)
    const testScorer = await open()
    sync(testScorer, testSeed, { test: true, gameNumber: 7402 })
    await settle(testScorer)
    await watcher.waitFor((m) => isPresence(m) && m.matchId === testSeed && m.present === true)
    sync(testScorer, testSeed, { test: true, gameNumber: 7402 })
    await settle(testScorer)
    await settle(watcher)
    assert.deepEqual(presenceOf(watcher, testSeed), [false, true], `${tag}: test match, the scorer in, once`)
    await close(testScorer)
    await watcher.waitFor((m) => isPresence(m) && m.matchId === testSeed && presenceOf(watcher, testSeed).length > 2, 5000)
    await settle(watcher)
    assert.deepEqual(presenceOf(watcher, testSeed), [false, true, false], `${tag}: test match, the scorer gone`)
    assert.deepEqual(presenceOf(watcher, seed), [], `${tag}: another room's presence is not sent`)
  } finally {
    for (const c of clients) { try { c.ws.terminate() } catch { /* gone */ } }
  }
}
