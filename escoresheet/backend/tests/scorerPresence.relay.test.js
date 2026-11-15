/**
 * Scorer presence through the --local relay (backend/server.js): the wire
 * contract every relay runtime passes (tests/helpers/scorerPresenceContract.js),
 * and what only this relay has:
 *   - join_match (its own join) is answered with the presence too, last
 *   - the presence is the last answer to subscribe-match, after the bench's
 *     requests (bench-request-state)
 *   - the scorer's socket leaving the room (leave_match, unsubscribe-match,
 *     a sync of another match) tells the room false; its next sync true
 *   - a socket that syncs under its Dexie id is named by the room key
 *   - a take-over by another device: scorer-moved to the old one, no flip
 *   - delete-match: match-deleted only, no presence
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { runScorerPresenceContract, PRESENCE_CONTRACT_PINS } from './helpers/scorerPresenceContract.js'

const hex = () => randomBytes(3).toString('hex')
const isPresence = (m) => m?.type === 'scorer-presence'

/** A scorer's sync of `room` (its seed key) under Dexie id 1. */
function syncMessage(room) {
  return {
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: room,
      gameNumber: 7501,
      status: 'live',
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      ...PRESENCE_CONTRACT_PINS
    },
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0, finished: false }],
    events: []
  }
}

/** Send a ping and wait for its pong: every earlier message of this socket was handled. */
async function settle(c) {
  const n = c.messages.filter((m) => m.type === 'pong').length
  c.send({ type: 'ping' })
  await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > n, 8000, 'pong')
}
const presenceOf = (c, room) => c.messages.filter((m) => isPresence(m) && m.matchId === room).map((m) => m.present)
const answersOf = (c) => c.messages.filter((m) => m.type !== 'pong' && m.type !== 'connected')

describe('scorer presence: the --local relay', () => {
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

  it('the shared contract: subscribe before the scorer, its sync, close, late subscriber, take-over, test match', async () => {
    await runScorerPresenceContract({ wsUrl: srv.wsUrl, openClient: (url) => openSocket(url), tag: 'node-local' })
  })

  it('join_match and subscribe-match: the presence is the last answer, named by the room key', async () => {
    const seed = `presence_join_${hex()}`
    const early = await open()
    early.send({ type: 'join_match', matchId: seed, role: 'referee' })
    await settle(early)
    assert.deepEqual(answersOf(early).map((m) => m.type), ['joined_match', 'scorer-presence'])
    assert.deepEqual(presenceOf(early, seed), [false])

    // the scorer syncs under its Dexie id: the tablets know the seed key
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    await settle(early)
    assert.deepEqual(presenceOf(early, seed), [false, true])
    assert.equal(answersOf(early).at(-1).type, 'scorer-presence', 'after the admitted snapshot')
    assert.equal(scorer.messages.filter(isPresence).length, 0)

    const joined = await open()
    joined.send({ type: 'join_match', matchId: seed, role: 'livescore' })
    await settle(joined)
    assert.deepEqual(answersOf(joined).map((m) => m.type), ['joined_match', 'match-full-data', 'scorer-presence'])
    assert.deepEqual(presenceOf(joined, seed), [true])

    const bench = await open()
    bench.send({ type: 'subscribe-match', matchId: seed, device: 'bench', team: 'home', pin: PRESENCE_CONTRACT_PINS.homeTeamPin })
    await settle(bench)
    const types = answersOf(bench).map((m) => m.type)
    assert.ok(types.includes('bench-request-state'), JSON.stringify(types))
    assert.equal(types.at(-1), 'scorer-presence', `the last answer: ${JSON.stringify(types)}`)
    assert.deepEqual(presenceOf(bench, seed), [true])
  })

  it('the scorer leaving the room tells it false (leave_match, unsubscribe-match, another match); back in, true', async () => {
    const seed = `presence_leave_${hex()}`
    const other = `presence_other_${hex()}`
    const referee = await open()
    referee.send({ type: 'subscribe-match', matchId: seed, device: 'referee' })
    await settle(referee)
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true])

    scorer.send({ type: 'leave_match', matchId: seed })
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true, false], 'leave_match')
    scorer.send(syncMessage(seed))
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true, false, true], 'back in')

    scorer.send({ type: 'unsubscribe-match', matchId: seed })
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed).slice(4), [false], 'unsubscribe-match')
    scorer.send(syncMessage(seed))
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed).slice(4), [false, true])

    // the scorer moves on to another match: its old room has no scorer
    scorer.send(syncMessage(other))
    await settle(scorer)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed).slice(4), [false, true, false], 'another match')
    assert.deepEqual(presenceOf(referee, other), [], 'not subscribed to the other room')
    assert.equal(scorer.messages.filter(isPresence).length, 0)
  })

  // venueScorerAfter takes the room from the old device's sockets within
  // the new device's sync: no false in between
  it('a take-over by another device: the old scorer is told scorer-moved, the tablets nothing', async () => {
    const seed = `presence_takeover_${hex()}`
    const referee = await open()
    referee.send({ type: 'subscribe-match', matchId: seed, device: 'referee' })
    await settle(referee)
    const laptop = await open()
    laptop.send({ ...syncMessage(seed), device: { id: '7e2a9c74-6f31-4d90-8c5e-3b4a5f6e7d8c', claim: 'presence-laptop' } })
    await settle(laptop)
    const phone = await open()
    phone.send({ ...syncMessage(seed), device: { id: '8f3bad85-7042-4ea1-9d6f-4c5b6a7f8e9d', claim: 'presence-phone' } })
    await settle(phone)
    await laptop.waitFor((m) => m.type === 'scorer-moved' && m.matchId === seed)
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true], 'no flip at the take-over')
    laptop.ws.terminate()
    await new Promise((r) => setTimeout(r, 300))
    await settle(referee)
    assert.deepEqual(presenceOf(referee, seed), [false, true], 'nor when the old scorer closes')
    phone.ws.terminate()
    await referee.waitFor((m) => isPresence(m) && presenceOf(referee, seed).length === 3)
    assert.deepEqual(presenceOf(referee, seed), [false, true, false])
  })

  it('delete-match: match-deleted only, no presence', async () => {
    const seed = `presence_delete_${hex()}`
    const livescore = await open()
    livescore.send({ type: 'subscribe-match', matchId: seed, device: 'livescore' })
    await settle(livescore)
    const scorer = await open()
    scorer.send(syncMessage(seed))
    await settle(scorer)
    await settle(livescore)
    assert.deepEqual(presenceOf(livescore, seed), [false, true])
    scorer.send({ type: 'delete-match', matchId: 1 })
    await settle(scorer)
    await livescore.waitFor((m) => m.type === 'match-deleted' && m.matchId === seed)
    scorer.ws.terminate()
    await new Promise((r) => setTimeout(r, 300))
    await settle(livescore)
    assert.deepEqual(presenceOf(livescore, seed), [false, true], 'nothing after match-deleted')
  })
})
