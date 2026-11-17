/**
 * Scoreboard displays ('display-presence' { matchId, present, settingsUrl }):
 * the same wire scenario against every relay runtime
 * (docs/scoreboard-display-spec.md).
 *   - backend/server.js --local        tests/displayPresence.relay.test.js (node:test)
 *   - server.js, the Vite dev plugin and the Tauri relay (OV_TAURI_RELAY_BIN):
 *     frontend/src/utils/__tests__/lanRelayProtocol.test.js (vitest)
 *
 * Checked:
 *   - the scorer's first accepted sync is answered with display-presence:
 *     false before any display, the display's page when one follows already
 *     (it subscribed before the scorer, waiting for the room)
 *   - a display subscribing tells the scorer (present, settingsUrl), once:
 *     the same subscription again sends nothing, another page sends it
 *   - a settingsUrl that is not a private-LAN http(s) URL is never passed on
 *     (null), the display still counts as present
 *   - the display unsubscribing or closing tells the scorer false
 *   - only the scorer hears it: no referee, bench or livescore socket, not the
 *     display itself, no other room; nothing in it but type, matchId,
 *     present, settingsUrl (no PIN, no device id, no address)
 *
 * Plain node:assert. The caller passes `openClient(url)` ({ ws, send,
 * waitFor, messages, raw }, resolving after 'connected').
 */
import assert from 'node:assert/strict'

const PINS = Object.freeze({ gamePin: '483920', refereePin: '594031', homeTeamPin: '605142', awayTeamPin: '716253' })
const DEVICE = { id: '7e2f9c74-6f31-4d9a-8c5e-3b4a5f6e7d8c', platform: 'web', claim: 'display-claim-a' }
export const BOARD_URL = 'http://172.24.1.1:8890/#settings'
const CABLE_URL = 'http://192.168.5.1:8890/#settings'

/** Settings pages a relay must refuse (passed on as null), and ones it keeps as given. */
export const SETTINGS_URL_CASES = Object.freeze({
  refused: [
    'https://example.com/settings',
    'http://8.8.8.8/',
    'http://127.0.0.1:8890/',
    'http://localhost:8890/',
    'http://169.254.10.1/',
    'http://172.32.0.1/',
    'http://user:pass@172.24.1.1:8890/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://192.168.1.1/',
    'http://board.local/',
    'http://[::1]/',
    'http://[fc::1]/',
    ` ${BOARD_URL}`,
    `http://10.0.0.1/${'a'.repeat(300)}`,
    42,
    { href: BOARD_URL }
  ],
  kept: [
    [BOARD_URL, BOARD_URL],
    [CABLE_URL, CABLE_URL],
    ['https://10.1.2.3/settings', 'https://10.1.2.3/settings'],
    ['http://[fd12:3456::1]:8890/', 'http://[fd12:3456::1]:8890/']
  ]
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isDisplay = (m) => m?.type === 'display-presence'

/**
 * @param {{ wsUrl: string, openClient: (url: string) => Promise<any>, tag?: string }} opts
 */
export async function runDisplayPresenceContract ({ wsUrl, openClient, tag = 'relay' }) {
  const clients = []
  const open = async () => {
    const c = await openClient(wsUrl)
    clients.push(c)
    return c
  }
  const settle = async (c) => {
    const before = c.messages.filter((m) => m.type === 'pong').length
    c.send({ type: 'ping' })
    await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > before)
  }
  const close = async (c) => {
    const closed = new Promise((r) => c.ws.once('close', r))
    c.ws.terminate()
    await closed
    await sleep(300)
  }
  const displaysOf = (c, room) => c.messages.filter((m) => isDisplay(m) && m.matchId === room).map((m) => [m.present, m.settingsUrl])
  const sync = (c, room, { test = false } = {}) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: room,
      status: 'live',
      gameNumber: 7601,
      scheduledAt: '2026-11-17T18:00:00.000Z',
      refereeConnectionEnabled: !test,
      homeTeamConnectionEnabled: !test,
      awayTeamConnectionEnabled: !test,
      ...(test ? { test: true } : PINS)
    },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }],
    events: [],
    device: DEVICE,
    _timestamp: Date.now()
  })
  const subscribe = (c, room, extra = {}) => c.send({ type: 'subscribe-match', matchId: room, ...extra })
  // until the scorer has heard `n` display-presence messages of the room
  const told = async (c, room, n) => {
    await c.waitFor(() => displaysOf(c, room).length >= n, 5000)
    await settle(c)
  }

  try {
    const seed = `display-${tag}-${Date.now().toString(36)}`

    // --- a scorer with no display: told false on its first sync, once -------
    const scorer = await open()
    sync(scorer, seed)
    await told(scorer, seed, 1)
    assert.deepEqual(displaysOf(scorer, seed), [[false, null]], `${tag}: no display yet`)
    sync(scorer, seed)
    await settle(scorer)
    assert.deepEqual(displaysOf(scorer, seed), [[false, null]], `${tag}: a further sync tells nothing`)

    // --- the board subscribes: the scorer hears it, with the page ------------
    const board = await open()
    subscribe(board, seed, { device: 'display', settingsUrl: BOARD_URL })
    await told(scorer, seed, 2)
    assert.deepEqual(displaysOf(scorer, seed), [[false, null], [true, BOARD_URL]], `${tag}: the board follows`)
    // the same subscription again (a reconnect's re-subscribe): nothing
    subscribe(board, seed, { device: 'display', settingsUrl: BOARD_URL })
    await settle(board)
    await settle(scorer)
    assert.equal(displaysOf(scorer, seed).length, 2, `${tag}: a repeat is not sent`)
    // another page (the cable address): sent
    subscribe(board, seed, { device: 'display', settingsUrl: CABLE_URL })
    await told(scorer, seed, 3)
    assert.deepEqual(displaysOf(scorer, seed).at(-1), [true, CABLE_URL], `${tag}: the new page`)

    // --- watchers never hear it; the board neither -------------------------
    const referee = await open()
    subscribe(referee, seed, { device: 'referee', pin: PINS.refereePin })
    const livescore = await open()
    subscribe(livescore, seed, { device: 'livescore' })
    await settle(referee)
    await settle(livescore)

    // --- a page that is not on the hall's LAN: never passed on -------------
    const rogue = await open()
    subscribe(rogue, seed, { device: 'display', settingsUrl: 'https://example.com/phish' })
    await settle(rogue)
    await settle(scorer)
    assert.deepEqual(displaysOf(scorer, seed).length, 3, `${tag}: a refused page changes nothing (the board's page stays)`)
    await close(rogue)
    await settle(scorer)
    assert.deepEqual(displaysOf(scorer, seed).length, 3, `${tag}: one of two displays leaving changes nothing`)

    // --- the board unsubscribes: false ---------------------------------------
    const before = displaysOf(scorer, seed).length
    board.send({ type: 'unsubscribe-match', matchId: seed })
    await told(scorer, seed, before + 1)
    assert.deepEqual(displaysOf(scorer, seed).at(-1), [false, null], `${tag}: the board left`)

    // --- a display with a refused page: present, no page --------------------
    const odd = await open()
    subscribe(odd, seed, { device: 'display', settingsUrl: 'http://8.8.8.8/settings' })
    await told(scorer, seed, before + 2)
    assert.deepEqual(displaysOf(scorer, seed).at(-1), [true, null], `${tag}: a display, no usable page`)
    // …and it closing: false
    await close(odd)
    await told(scorer, seed, before + 3)
    assert.deepEqual(displaysOf(scorer, seed).at(-1), [false, null], `${tag}: the display closed`)

    // --- a display that was there before the scorer -------------------------
    const seed2 = `display2-${tag}-${Date.now().toString(36)}`
    const early = await open()
    subscribe(early, seed2, { device: 'display', settingsUrl: BOARD_URL })
    await settle(early)
    const scorer2 = await open()
    sync(scorer2, seed2, { test: true })
    await told(scorer2, seed2, 1)
    assert.deepEqual(displaysOf(scorer2, seed2), [[true, BOARD_URL]], `${tag}: told on its first sync (test match)`)
    // a second scorer socket (a reconnect) is told on its own first sync
    const again = await open()
    sync(again, seed2, { test: true })
    await told(again, seed2, 1)
    assert.deepEqual(displaysOf(again, seed2), [[true, BOARD_URL]], `${tag}: a new scorer socket is told`)
    await settle(scorer2)
    assert.deepEqual(displaysOf(scorer2, seed2), [[true, BOARD_URL]], `${tag}: the other scorer socket is not told again`)

    // --- only scorer sockets, only their room, only these keys --------------
    for (const c of [board, referee, livescore, early]) {
      assert.deepEqual(c.messages.filter(isDisplay), [], `${tag}: a non-scorer is never told`)
    }
    assert.deepEqual(displaysOf(scorer, seed2), [], `${tag}: another room's displays are not sent`)
    for (const c of [scorer, scorer2, again]) {
      for (const text of c.raw.filter((t) => t.includes('"display-presence"'))) {
        assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['matchId', 'present', 'settingsUrl', 'type'], `${tag}: ${text}`)
        assert.ok(!Object.values(PINS).some((p) => text.includes(p)), `${tag}: no PIN in ${text}`)
        assert.ok(!text.includes(DEVICE.id) && !text.includes('example.com') && !text.includes('8.8.8.8'), `${tag}: nothing refused or private in ${text}`)
      }
    }
  } finally {
    for (const c of clients) { try { c.ws.terminate() } catch { /* gone */ } }
  }
}
