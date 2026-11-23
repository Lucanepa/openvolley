/**
 * Scoreboard displays on the cloud relay (IS_CLOUD): a display counts for a
 * room, and its settings page reaches the room's scorer, only once it proved
 * the room: by the room's scoreboard code, or a PIN or match token of the
 * match. Room keys are public on the cloud (/api/match/list, the public API):
 * any socket naming itself a display set the scorer's "Scoreboard settings"
 * to a LAN page of its choice (audit 2611 SEC-45). A display behind the same
 * public address as the room's scorer counts too: Point Hub on "OpenVolley
 * online" follows the hall's cloud match with no PIN or code (review of the
 * SEC-45 fix). A venue relay keeps the LAN rule
 * (tests/displayPresence.relay.test.js, the shared contract).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootServer, openSocket, sleep } from './helpers/e2eServer.js'

const PINS = Object.freeze({ gamePin: '483920', refereePin: '594031', homeTeamPin: '605142', awayTeamPin: '716253' })
const BOARD_URL = 'http://172.24.1.1:8890/#settings'
const ROUTER_URL = 'http://192.168.1.1/cgi-bin/luci/admin/system/reboot'

describe('display presence: the cloud relay asks the display to prove the room', () => {
  let srv
  const sockets = []
  before(async () => { srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }, ['--local']) })
  after(async () => {
    for (const c of sockets) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  let ipSeq = 10
  const open = async (ip = `203.0.113.${ipSeq++}`) => {
    const c = await openSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    sockets.push(c)
    return c
  }
  const settle = async (c) => {
    const n = c.messages.filter((m) => m.type === 'pong').length
    c.send({ type: 'ping' })
    await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 5000, 'pong')
  }
  const displaysOf = (c, room) => c.messages.filter((m) => m.type === 'display-presence' && m.matchId === room).map((m) => [m.present, m.settingsUrl])
  const sync = (c, room) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: { id: 1, seed_key: room, status: 'live', gameNumber: 7611, refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true, ...PINS },
    homeTeam: { id: 1, name: 'VBC Musterdorf' },
    awayTeam: { id: 2, name: 'Volley Beispiel' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }],
    events: [],
    _timestamp: Date.now()
  })
  // a few round trips of every socket: whatever the relay would send has arrived
  const quiet = async (...cs) => {
    await sleep(100)
    for (const c of cs) await settle(c)
  }

  it('a display without code, PIN or token is not announced and its page goes nowhere', async () => {
    const room = `proof-anon-${Date.now().toString(36)}`
    const scorer = await open()
    sync(scorer, room)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000, 'first display-presence')
    const fake = await open()
    fake.send({ type: 'subscribe-match', matchId: room, role: 'subscriber', device: 'display', settingsUrl: ROUTER_URL })
    // a wrong PIN proves nothing either
    const wrong = await open()
    wrong.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: ROUTER_URL, pin: '000000' })
    await wrong.waitFor((m) => m.type === 'error' && m.code === 'pin-invalid', 5000, 'pin-invalid')
    await quiet(fake, wrong, scorer)
    assert.deepEqual(displaysOf(scorer, room), [[false, null]])
    assert.ok(!scorer.raw.some((t) => t.includes('192.168.1.1')), 'the page reached the scorer')
  })

  it('a display with a PIN of the match counts, with its page; one that subscribed before the scorer too', async () => {
    const room = `proof-pin-${Date.now().toString(36)}`
    const early = await open()
    early.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: BOARD_URL, pin: PINS.refereePin })
    await early.waitFor((m) => m.type === 'joined_match' && m.waiting === true, 5000, 'waiting')
    const scorer = await open()
    sync(scorer, room)
    await scorer.waitFor(() => displaysOf(scorer, room).length >= 1, 5000, 'display-presence')
    assert.deepEqual(displaysOf(scorer, room), [[true, BOARD_URL]], 'the waiting display with the PIN is announced on the first sync')
    early.ws.terminate()
    await scorer.waitFor(() => displaysOf(scorer, room).length >= 2, 5000, 'display gone')
    assert.deepEqual(displaysOf(scorer, room).at(-1), [false, null])
    const board = await open()
    board.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: BOARD_URL, pin: PINS.homeTeamPin })
    await scorer.waitFor(() => displaysOf(scorer, room).length >= 3, 5000, 'display back')
    assert.deepEqual(displaysOf(scorer, room).at(-1), [true, BOARD_URL])
  })

  it('a display behind the scorer\'s public address counts without code or PIN (Point Hub following the hall\'s cloud match)', async () => {
    const room = `proof-hall-${Date.now().toString(36)}`
    const hallIp = '198.51.100.140'
    const scorer = await open(hallIp)
    sync(scorer, room)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000, 'first display-presence')
    // Point Hub's auto-follow: subscribe-match {matchId, device, settingsUrl}, nothing else
    const board = await open(hallIp)
    board.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: BOARD_URL })
    await scorer.waitFor(() => displaysOf(scorer, room).length >= 2, 5000, 'display-presence')
    assert.deepEqual(displaysOf(scorer, room), [[false, null], [true, BOARD_URL]])
    // the same message from another address still counts nothing (its page goes nowhere)
    const fake = await open('198.51.100.141')
    fake.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: ROUTER_URL })
    await quiet(fake, scorer)
    assert.deepEqual(displaysOf(scorer, room).at(-1), [true, BOARD_URL])
    assert.ok(!scorer.raw.some((t) => t.includes('192.168.1.1')), 'the page reached the scorer')
  })

  it('a display that follows by the room\'s scoreboard code counts, with its page', async () => {
    const room = `proof-code-${Date.now().toString(36)}`
    const scorer = await open()
    sync(scorer, room)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000, 'first display-presence')
    scorer.send({ type: 'display-code-set', matchId: room, code: 'QRST4567', issuedAt: Date.now() })
    await scorer.waitFor((m) => m.type === 'display-code-state' && m.active === true, 5000, 'display-code-state')
    const board = await open()
    board.send({ type: 'subscribe-match', code: 'QRST4567', device: 'display', settingsUrl: BOARD_URL })
    await board.waitFor((m) => m.type === 'display-code' && m.ok === true, 5000, 'display-code')
    await scorer.waitFor(() => displaysOf(scorer, room).length >= 2, 5000, 'display-presence')
    assert.deepEqual(displaysOf(scorer, room), [[false, null], [true, BOARD_URL]])
    // a PIN-less display in the same room changes nothing (the board's page stays)
    const fake = await open()
    fake.send({ type: 'subscribe-match', matchId: room, device: 'display', settingsUrl: ROUTER_URL })
    await quiet(fake, scorer)
    assert.deepEqual(displaysOf(scorer, room).at(-1), [true, BOARD_URL])
    assert.equal(displaysOf(scorer, room).length, 2)
  })
})
