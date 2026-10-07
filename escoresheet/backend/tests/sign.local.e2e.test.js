/**
 * Sign on phone on the LAN / SEA backend (server.js --local, no database;
 * docs/qr-signing-spec.md 8.1): the shared HTTP scenario from the relay host
 * (loopback), the phone page with its headers, no secret in the server
 * output, and from ANOTHER machine (a throwaway node:22-slim container on the
 * docker bridge, when docker is there): no PIN -> 403, the game PIN of a
 * synced match -> 201, wrong PINs -> 403 and counted until 429.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { bootServer, openSocket } from './helpers/e2eServer.js'
import { signHttpScenario, signPageCheck } from '../../frontend/electron/__fixtures__/signHttpScenario.mjs'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GAME_PIN = '987654'
const SEED = `e2e-sign-${randomBytes(3).toString('hex')}`
const CTX = { home: 'A', away: 'B' }

const dockerOk = spawnSync('docker', ['image', 'inspect', 'node:22-slim'], { stdio: 'ignore' }).status === 0

/**
 * This backend inside a throwaway container (node:22-slim, --rm, unique name,
 * the backend directory mounted read-only, a random host port on loopback):
 * the test process is then ANOTHER machine to it, not the relay host.
 */
async function bootInContainer() {
  const name = `ov-sign-remote-${process.pid}-${randomBytes(3).toString('hex')}`
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-v', `${BACKEND_DIR}:/app:ro`, '-w', '/app', '-e', 'PORT=8080',
    '-p', '127.0.0.1::8080', 'node:22-slim', 'node', 'server.js', '--local'], { encoding: 'utf8' })
  const stop = () => { try { execFileSync('docker', ['stop', '-t', '2', name], { stdio: 'ignore' }) } catch { /* gone */ } }
  process.once('exit', stop)
  try {
    const port = execFileSync('docker', ['port', name, '8080/tcp'], { encoding: 'utf8' }).trim().split('\n')[0].split(':').pop()
    const base = `http://127.0.0.1:${port}`
    const t0 = Date.now()
    for (;;) {
      try { if ((await fetch(`${base}/health/live`)).ok) break } catch { /* starting */ }
      if (Date.now() - t0 > 30000) throw new Error('backend in the container did not start')
      await new Promise((r) => setTimeout(r, 200))
    }
    return { base, wsUrl: `ws://127.0.0.1:${port}`, stop }
  } catch (err) {
    stop()
    throw err
  }
}

async function postJson(base, path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
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

  it('another machine needs the game PIN of a synced match, and wrong PINs are counted', { skip: dockerOk ? false : 'docker with node:22-slim needed' }, async () => {
    const remote = await bootInContainer()
    try {
      const scorer = await openSocket(remote.wsUrl)
      scorer.send({
        type: 'sync-match-data',
        matchId: SEED,
        match: { id: 1, seed_key: SEED, status: 'live', gamePin: GAME_PIN, refereePin: '314159', refereeConnectionEnabled: true },
        homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [], awayPlayers: [], sets: [], events: []
      })
      await new Promise((r) => setTimeout(r, 300))
      const start = (pin, matchKey = SEED) => postJson(remote.base, '/api/sign/start', { slot: 'captain-a', matchKey, context: CTX }, pin ? { 'X-OV-Match-Pin': pin } : {})

      const none = await start(null)
      assert.equal(none.status, 403)
      assert.equal(none.json.code, 'OV_SIGN_FORBIDDEN')
      assert.equal((await start(GAME_PIN, 'not-on-this-relay')).json.code, 'OV_SIGN_FORBIDDEN')
      const ok = await start(GAME_PIN)
      assert.equal(ok.status, 201, JSON.stringify(ok))
      assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/)
      // The phone (also another machine) uses the link
      assert.equal((await postJson(remote.base, '/api/sign/open', { k: ok.json.token })).json.state, 'opened')
      for (let i = 0; i < 20; i++) {
        const r = await start(String(100000 + i))
        assert.equal(r.status, 403)
        assert.equal(r.json.code, 'OV_SIGN_PIN_INVALID')
      }
      // The 20 wrong ones used the IP's PIN budget: now even the right PIN waits
      const blocked = await start(GAME_PIN)
      assert.equal(blocked.status, 429)
      assert.equal(blocked.json.code, 'OV_SIGN_RATE_LIMITED')
      scorer.ws.close()
    } finally {
      remote.stop()
    }
  })
})
