// @vitest-environment node
/**
 * Relay core limits the desktop (Tauri) relay shares: a socket's message
 * budget, a client that stops reading, stored events without undo snapshots,
 * the connections list, validate-pin's PIN format and the claim compare.
 */
import { describe, it, expect } from 'vitest'
import { createLanRelay } from '../../../lanRelayCore.js'

function fakeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    terminated: false,
    sent: [],
    send(text) { this.sent.push(JSON.parse(text)) },
    terminate() { this.terminated = true },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) },
  }
}
function connect(relay, ip = '192.168.1.50') {
  const ws = fakeSocket()
  relay.addClient(ws, { ip })
  return ws
}
const msg = (relay, ws, m) => relay.handleMessage(ws, JSON.stringify(m))
const match = (o = {}) => ({
  id: 1, seed_key: 'seed-court-9', status: 'live', gamePin: '111111',
  refereeConnectionEnabled: true, refereePin: '222222', ...o,
})
const sync = (m = match(), extra = {}) => ({ type: 'sync-match-data', matchId: m.id, match: m, homeTeam: { name: 'Lakeside' }, awayTeam: { name: 'Hillview' }, ...extra })

describe('relay core limits', () => {
  it('refuses the messages of a LAN socket over its budget, not those of the relay host', () => {
    const relay = createLanRelay({ messagesPerMinute: 3 })
    const lan = connect(relay)
    for (let i = 0; i < 4; i++) msg(relay, lan, { type: 'ping' })
    expect(lan.sent.filter((m) => m.type === 'pong')).toHaveLength(3)
    expect(lan.last('error').code).toBe('rate-limited')
    const host = connect(relay, '127.0.0.1')
    for (let i = 0; i < 5; i++) msg(relay, host, { type: 'ping' })
    expect(host.sent.filter((m) => m.type === 'pong')).toHaveLength(5)
    relay.close()
  })

  it('ends a socket that stopped reading instead of buffering for it', () => {
    const relay = createLanRelay()
    const ws = connect(relay)
    ws.bufferedAmount = 64 * 1024 * 1024
    msg(relay, ws, { type: 'ping' })
    expect(ws.terminated).toBe(true)
    expect(ws.last('pong')).toBeUndefined()
    relay.close()
  })

  it('stores events without the undo snapshots', () => {
    const relay = createLanRelay()
    const scorer = connect(relay, '127.0.0.1')
    msg(relay, scorer, sync(match(), { events: [{ type: 'point', stateSnapshot: { a: 1 }, stateBefore: { b: 2 } }] }))
    const ref = connect(relay, '192.168.1.61')
    msg(relay, ref, { type: 'subscribe-match', matchId: 'seed-court-9', pin: '222222' })
    expect(ref.last('match-full-data').events).toEqual([{ type: 'point' }])
    relay.close()
  })

  it('lists the tablets only for the relay host or with a PIN of the match', () => {
    const relay = createLanRelay()
    msg(relay, connect(relay, '127.0.0.1'), sync())
    const ref = connect(relay, '192.168.1.60')
    msg(relay, ref, { type: 'subscribe-match', matchId: 'seed-court-9', device: 'referee' })
    const lan = relay.getConnections('seed-court-9', { local: false, ip: '192.168.1.70' })
    expect(lan.dashboardClients).toBe(1)
    expect(lan.clients).toEqual([])
    const wrong = relay.getConnections('seed-court-9', { local: false, pin: '999999', ip: '192.168.1.70' })
    expect(wrong.clients).toEqual([])
    const withPin = relay.getConnections('seed-court-9', { local: false, pin: '222222', ip: '192.168.1.70' })
    expect(withPin.clients[0]).toMatchObject({ ip: '192.168.1.60', role: 'referee' })
    expect(relay.getConnections(null, { local: true }).clients[0].ip).toBe('192.168.1.60')
    relay.close()
  })

  it('validate-pin takes six digits only', () => {
    const relay = createLanRelay()
    msg(relay, connect(relay, '127.0.0.1'), sync(match({ refereePin: 'ab12cd' })))
    expect(relay.validatePin({ pin: 'ab12cd', type: 'referee' }).status).toBe(400)
    msg(relay, connect(relay, '127.0.0.1'), sync(match({ id: 2, seed_key: 'seed-court-8' })))
    expect(relay.validatePin({ pin: '222222', type: 'referee' }).status).toBe(200)
    relay.close()
  })

  it('compares no game-number PIN once the match budget is spent, from any address', async () => {
    const relay = createLanRelay({ matchPinFailureLimit: 2 })
    msg(relay, connect(relay, '127.0.0.1'), sync(match({ gameNumber: '4242' })))
    for (const ip of ['192.168.1.61', '192.168.1.62']) {
      expect((await relay.findByGameNumber('4242', { pin: '999999', ip })).body.access).toBe('summary')
    }
    const fresh = await relay.findByGameNumber('4242', { pin: '111111', ip: '192.168.1.63' })
    expect(fresh.body.access).toBe('summary')
    expect(fresh.body.match.gamePin).toBeUndefined()
    relay.close()
  })
})
