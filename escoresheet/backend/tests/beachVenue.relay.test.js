/**
 * Venue mode (openbeach phase 2): the Node relay in --local mode (no database)
 * serves several beach courts at once. Two simulated beach scorers claim two
 * matches next to an indoor one; the contract (tests/helpers/beachVenueContract.js)
 * checks the match list, the referee bundles with players, the PIN rules per
 * court and sport, and that no PIN ever reaches a subscriber. The same
 * contract runs against the LAN relays and the Tauri relay in
 * frontend/src/utils/__tests__/lanRelayProtocol.test.js.
 */
import { describe, it, before, after } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { runBeachVenueContract } from './helpers/beachVenueContract.js'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function freePort () {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function openClient (url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
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

describe('venue mode: the --local relay serves several beach courts', () => {
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

  it('two beach scorers on two courts: both listed, referees get teams with players, no PIN reaches anyone', async () => {
    await runBeachVenueContract({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, openClient, tag: 'node-local' })
  })
})
