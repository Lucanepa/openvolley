/**
 * Sign on phone on the LAN / SEA backend (server.js --local, no database;
 * docs/qr-signing-spec.md 8.1): the shared HTTP scenario from the relay host
 * (loopback), the phone page with its headers, no secret in the server
 * output, and from ANOTHER machine: a second --local backend behind a
 * trusted proxy (TRUST_PROXY=cloudflare from loopback) takes the client
 * address from cf-connecting-ip, so this test process speaks as hall devices
 * at documentation addresses (no docker). There: no PIN -> 403, the game PIN
 * of a synced match from the scoring device that holds it -> 201, the same
 * PIN from another device -> 403, the live-session cap per address (not per
 * made-up room), wrong PINs -> 403 and counted until 429. And from a real
 * second machine (a second network namespace, where unprivileged ones are
 * available): a forwarded loopback address never makes a caller the relay
 * host.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { signHttpScenario, signPageCheck } from '../../frontend/electron/__fixtures__/signHttpScenario.mjs'

const GAME_PIN = '987654'
const SEED = `e2e-sign-${randomBytes(3).toString('hex')}`
const CTX = { home: 'A', away: 'B' }
// Hall devices (RFC 5737 documentation addresses)
const SCORER_IP = '192.0.2.10'
const OTHER_IP = '192.0.2.11'
const SPECTATOR_IP = '192.0.2.66'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// A veth pair between this namespace and a second one: unshare -rn needs
// unprivileged user namespaces (off on some CI runners) and iproute2
const NETNS = spawnSync('unshare', ['-rn', 'ip', 'link', 'add', 'v0', 'type', 'veth', 'peer', 'name', 'v1'], { stdio: 'ignore' }).status === 0
  ? false
  : 'no unprivileged network namespaces (unshare -rn) here'
// In a fresh network namespace: the relay at 10.211.0.1 (TRUST_PROXY=cloudflare,
// no TRUST_PROXY_FROM: any peer's cf-connecting-ip is believed), a hall device
// at 10.211.0.2 in a second one, and three starts: from the device without
// and with a forwarded loopback address, and from the relay box itself
const NETNS_SCRIPT = `set -e
ip link set lo up
unshare -n sleep 120 &
PEER=$!
while [ "$(readlink /proc/$PEER/ns/net)" = "$(readlink /proc/self/ns/net)" ]; do sleep 0.05; done
ip link add v0 type veth peer name v1 netns $PEER
ip addr add 10.211.0.1/24 dev v0
ip link set v0 up
nsenter --net=/proc/$PEER/ns/net sh -c 'ip link set lo up && ip addr add 10.211.0.2/24 dev v1 && ip link set v1 up'
TRUST_PROXY=cloudflare PORT=8095 "$OV_NODE" server.js --local > /dev/null 2>&1 &
SRV=$!
START='const [url, fwd] = process.argv.slice(1); const t0 = Date.now()
const go = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(fwd ? { "cf-connecting-ip": fwd } : {}) }, body: JSON.stringify({ slot: "ref1", context: { home: "A", away: "B" } }) })
  .then(async (r) => console.log("RESULT", fwd || "-", r.status, (await r.json()).code || "ok"), () => (Date.now() - t0 < 15000 ? setTimeout(go, 200) : console.log("RESULT", fwd || "-", 0, "unreachable")))
go()'
"$OV_NODE" -e "$START" http://127.0.0.1:8095/api/sign/start "" > /dev/null
nsenter --net=/proc/$PEER/ns/net "$OV_NODE" -e "$START" http://10.211.0.1:8095/api/sign/start ""
nsenter --net=/proc/$PEER/ns/net "$OV_NODE" -e "$START" http://10.211.0.1:8095/api/sign/start 127.0.0.1
"$OV_NODE" -e "$START" http://127.0.0.1:8095/api/sign/start ""
kill $SRV $PEER
`

async function postJson(base, path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A scoreboard socket at `ip` that syncs a match with `gamePin`. */
async function syncRoom(wsUrl, ip, matchId, gamePin) {
  const socket = await openSocket(wsUrl, { headers: { 'cf-connecting-ip': ip } })
  socket.send({
    type: 'sync-match-data',
    matchId,
    match: { id: 1, seed_key: matchId, status: 'live', gamePin, refereePin: '314159', refereeConnectionEnabled: true },
    homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [], awayPlayers: [], sets: [], events: []
  })
  await new Promise((r) => setTimeout(r, 300))
  return socket
}

describe('Sign on phone, backend --local', () => {
  let srv
  before(async () => {
    srv = await bootServer({}, ['--local'])
  })
  after(async () => { await srv?.stop() })

  it('speaks the shared protocol from the relay host', async () => {
    assert.deepEqual(await signHttpScenario({ httpBase: srv.base }), [])
  })

  it('serves the phone page with its headers', async () => {
    assert.deepEqual(await signPageCheck({ httpBase: srv.base, expectBody: 'OpenVolley' }), [])
  })

  it('OV_SIGN_DISABLED is off: the routes are there', async () => {
    const r = await fetch(`${srv.base}/api/sign/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watch: 'A'.repeat(43) }) })
    assert.equal(r.status, 200)
  })

  it('logs no secret, context or stroke', async () => {
    const res = await fetch(`${srv.base}/api/sign/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: 'ref1', context: { ...CTX, name: 'Marker Person' } }) })
    const { token, watch } = await res.json()
    await fetch(`${srv.base}/api/sign/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k: token, pad: { w: 4000, h: 2000 }, strokes: [[0, 1777, 300, 1777]] }) })
    await fetch(`${srv.base}/api/sign/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watch }) })
    const out = srv.output.join('')
    assert.ok(/sign\.start ref=[0-9a-f]{8} slot=ref1 via=lan/.test(out), out.slice(-2000))
    for (const secret of [token, watch, 'Marker Person', '1777']) assert.ok(!out.includes(secret), `server output contains ${secret}`)
  })

  it('another machine needs the game PIN of a match its own scoreboard holds; caps per address; wrong PINs are counted', async () => {
    // the client address comes from the trusted proxy header, as behind a reverse proxy on the relay box
    const remote = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' }, ['--local'])
    const sockets = []
    try {
      sockets.push(await syncRoom(remote.wsUrl, SCORER_IP, SEED, GAME_PIN))
      const start = (pin, { matchKey = SEED, ip = SCORER_IP } = {}) => postJson(remote.base, '/api/sign/start', { slot: 'captain-a', matchKey, context: CTX },
        { 'cf-connecting-ip': ip, ...(pin ? { 'X-OV-Match-Pin': pin } : {}) })

      const none = await start(null)
      assert.equal(none.status, 403)
      assert.equal(none.json.code, 'OV_SIGN_FORBIDDEN')
      assert.equal((await start(GAME_PIN, { matchKey: 'not-on-this-relay' })).json.code, 'OV_SIGN_FORBIDDEN')
      const ok = await start(GAME_PIN)
      assert.equal(ok.status, 201, JSON.stringify(ok))
      assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/)
      // The phone (also another machine) uses the link
      assert.equal((await postJson(remote.base, '/api/sign/open', { k: ok.json.token }, { 'cf-connecting-ip': '192.0.2.200' })).json.state, 'opened')
      // Another device that knows the game PIN is not the room's scoring device
      const other = await start(GAME_PIN, { ip: OTHER_IP })
      assert.equal(other.status, 403)
      assert.equal(other.json.code, 'OV_SIGN_FORBIDDEN')

      // A device with made-up rooms of its own: its live sessions are capped
      // per address, however many rooms it syncs
      for (const n of [1, 2]) sockets.push(await syncRoom(remote.wsUrl, SPECTATOR_IP, `${SEED}-made-up-${n}`, '111111'))
      const fake = (n) => start('111111', { matchKey: `${SEED}-made-up-${n}`, ip: SPECTATOR_IP })
      for (let i = 0; i < 20; i++) assert.equal((await fake(1 + (i % 2))).status, 201)
      for (const n of [1, 2]) {
        const capped = await fake(n)
        assert.equal(capped.status, 429)
        assert.equal(capped.json.code, 'OV_SIGN_RATE_LIMITED')
      }
      // ... and the scoring device and the relay host still start theirs
      assert.equal((await start(GAME_PIN)).status, 201)
      assert.equal((await postJson(remote.base, '/api/sign/start', { slot: 'ref1', context: CTX })).status, 201)

      for (let i = 0; i < 20; i++) {
        const r = await start(String(100000 + i))
        assert.equal(r.status, 403)
        assert.equal(r.json.code, 'OV_SIGN_PIN_INVALID')
      }
      // The 20 wrong ones used the address's PIN budget: now even the right PIN waits
      const blocked = await start(GAME_PIN)
      assert.equal(blocked.status, 429)
      assert.equal(blocked.json.code, 'OV_SIGN_RATE_LIMITED')
    } finally {
      for (const socket of sockets) socket.ws.close()
      await remote.stop()
    }
  })

  it('a hall device that forwards a loopback address is not the relay host (TRUST_PROXY without TRUST_PROXY_FROM)', { skip: NETNS, timeout: 60000 }, async () => {
    const child = spawn('unshare', ['-rn', 'sh', '-c', NETNS_SCRIPT], { cwd: BACKEND_DIR, env: { ...process.env, OV_NODE: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const code = await new Promise((r) => child.on('exit', r))
    const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => l.split(' ').slice(1))
    assert.equal(code, 0, out)
    assert.deepEqual(results, [
      // the hall device, as itself: no PIN, no start
      ['-', '403', 'OV_SIGN_FORBIDDEN'],
      // the same device naming 127.0.0.1: still no start (it was the host before)
      ['127.0.0.1', '403', 'OV_SIGN_FORBIDDEN'],
      // the relay box itself
      ['-', '201', 'ok']
    ], out)
  })
})
