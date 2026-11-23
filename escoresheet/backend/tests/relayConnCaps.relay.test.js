/**
 * Admission of role sockets on the cloud relay (server.js admitRoleSocket,
 * audit 2611 SEC-04): idle sockets of one IPv6 /56 (or ten IPv4 addresses)
 * held all MAX_CONNECTIONS slots, and every later scorer, referee and bench
 * socket was refused with 1013.
 *
 *   - sockets that proved nothing count per IPv6 /56 (and /48, IPv4 /24): a
 *     /56 holds at most what one address may, a new one pushes its oldest out
 *   - at the cap, the oldest socket that proved nothing makes room (one in no
 *     room first): a scorer and a PIN-proved referee are admitted, and kept
 *     however many sockets come after them; only when every socket proved
 *     something is a new one refused
 *   - while the relay is under load, a socket in no room that proved nothing
 *     is closed after OV_ROLE_IDLE_MS; one in a room and a proved one stay
 *
 * Boots server.js as a cloud relay (IS_CLOUD, TRUST_PROXY, --local) with a
 * small OV_MAX_CONNECTIONS.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { bootServer, sleep, waitUntil } from './helpers/e2eServer.js'

const PIN = '314159'

/** A socket from `ip`: { ok, ws, messages, closed } once it was greeted or closed. */
function open(url, ip) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'cf-connecting-ip': ip } })
    const s = { ws, ip, messages: [], closed: null, ok: false }
    s.send = (m) => ws.send(JSON.stringify(m))
    let done = false
    const fin = () => { if (!done) { done = true; resolve(s) } }
    ws.on('message', (d) => {
      try { s.messages.push(JSON.parse(d.toString())) } catch { /* ignore */ }
      if (s.messages[0]?.type === 'connected') s.ok = true
      fin()
    })
    ws.on('close', (code, reason) => { s.closed = { code, reason: reason.toString() }; fin() })
    ws.on('error', () => fin())
  })
}
const isOpen = (s) => s.ok && s.closed === null && s.ws.readyState === WebSocket.OPEN
const v6In56 = (i) => `2001:db8:77:${(0x1000 + i).toString(16)}::1` // 256 /64s of 2001:db8:77:1000::/56

function scorerSync(seed) {
  return {
    type: 'sync-match-data',
    matchId: seed,
    match: { id: 1, seed_key: seed, status: 'live', gamePin: '987654', refereePin: PIN, refereeConnectionEnabled: true },
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: [],
    _timestamp: Date.now()
  }
}
const until = (s, pred, what) => waitUntil(() => s.messages.find(pred), { timeoutMs: 5000, what })

describe('role sockets: who may hold the relay\'s slots (cloud)', () => {
  let srv
  const all = []
  const connect = async (ip) => {
    const s = await open(srv.wsUrl, ip)
    all.push(s)
    return s
  }
  before(async () => {
    srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare', OV_MAX_CONNECTIONS: '300', OV_ROLE_IDLE_MS: '1500' }, ['--local'])
  })
  after(async () => {
    for (const s of all) { try { s.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const closeAll = async () => {
    for (const s of all.splice(0)) { try { s.ws.terminate() } catch { /* gone */ } }
    await sleep(300)
  }

  it('one IPv6 /56 holds at most what one address may: a new socket of it pushes its oldest idle one out', async () => {
    const net = []
    for (let i = 0; i < 200; i++) net.push(await connect(v6In56(i)))
    assert.equal(net.filter(isOpen).length, 200)
    const more = await connect(v6In56(200))
    assert.equal(isOpen(more), true, 'the /56 newcomer is admitted')
    await waitUntil(() => net[0].closed, { timeoutMs: 3000, what: 'the oldest of the /56 pushed out' })
    assert.equal(net[0].closed.code, 1013)
    assert.equal([...net, more].filter(isOpen).length, 200, 'still 200 of the /56')
    // another network is not affected
    const other = await connect('2001:db8:999::5')
    assert.equal(isOpen(other), true)
    await closeAll()
  })

  it('at the cap a scorer and a PIN-proved referee get in, and keep their slots', async () => {
    // the cap (300) filled by idle sockets of two /56s and IPv4 addresses
    for (let i = 0; i < 200; i++) await connect(v6In56(i))
    for (let i = 0; i < 100; i++) await connect(`2001:db8:78:${(0x1000 + i).toString(16)}::1`)
    assert.equal(all.filter(isOpen).length, 300)
    const scorer = await connect('198.51.100.70')
    assert.equal(isOpen(scorer), true, 'the scorer at the cap')
    scorer.send(scorerSync('seed-caps'))
    await until(scorer, (m) => m.type === 'display-presence', 'the scorer proved the match')
    const referee = await connect('198.51.100.71')
    assert.equal(isOpen(referee), true, 'the referee at the cap')
    referee.send({ type: 'subscribe-match', matchId: 'seed-caps', role: 'referee', pin: PIN })
    const full = await until(referee, (m) => m.type === 'match-full-data', 'the referee\'s bundle')
    assert.equal(full.access, 'full')
    // the idle sockets keep coming: they push each other out, never the scorer or the referee
    for (let i = 0; i < 320; i++) await connect(`203.0.113.${(i % 250) + 1}`)
    await sleep(200)
    assert.equal(isOpen(scorer), true, 'the scorer kept its slot')
    assert.equal(isOpen(referee), true, 'the referee kept its slot')
    assert.ok(all.filter(isOpen).length <= 300)
    await closeAll()
  })

  it('under load an idle socket that proved nothing is closed after the idle time; one in a room and a proved one stay', async () => {
    const idle = []
    for (let i = 0; i < 160; i++) idle.push(await connect(`2001:db8:79:${(0x1000 + i).toString(16)}::1`))
    const scorer = await connect('198.51.100.80')
    scorer.send(scorerSync('seed-idle'))
    await until(scorer, (m) => m.type === 'display-presence', 'the scorer proved the match')
    const viewer = await connect('198.51.100.81')
    viewer.send({ type: 'subscribe-match', matchId: 'seed-idle', role: 'subscriber' })
    await until(viewer, (m) => m.type === 'match-full-data', 'the viewer\'s summary')
    await waitUntil(() => idle.every((s) => s.closed), { timeoutMs: 8000, what: 'the idle sockets closed' })
    assert.equal(idle[0].closed.code, 1013)
    assert.equal(isOpen(scorer), true)
    assert.equal(isOpen(viewer), true)
    // not under load (2 sockets): an idle socket stays
    const quiet = await connect('198.51.100.82')
    await sleep(3500)
    assert.equal(isOpen(quiet), true, 'an idle socket of a relay that is not under load stays')
    await closeAll()
  })
})

describe('role sockets: a relay full of proved sockets refuses a new one', () => {
  let srv
  const all = []
  before(async () => { srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare', OV_MAX_CONNECTIONS: '3' }, ['--local']) })
  after(async () => {
    for (const s of all) { try { s.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })

  it('three scorers hold the three slots: the fourth socket is refused with 1013', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await open(srv.wsUrl, `198.51.100.${90 + i}`)
      all.push(s)
      s.send(scorerSync(`seed-full-${i}`))
      await until(s, (m) => m.type === 'display-presence', `scorer ${i}`)
    }
    const late = await open(srv.wsUrl, '198.51.100.99')
    all.push(late)
    await waitUntil(() => late.closed, { timeoutMs: 3000, what: 'refused' })
    assert.equal(late.closed.code, 1013)
    assert.equal(all.slice(0, 3).every(isOpen), true)
  })
})
