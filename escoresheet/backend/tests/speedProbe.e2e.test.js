// GET /health/speed: the internet speed probe of the scorer app's start check
// (frontend utils/internetCheck.js, lib/speedProbe.js). A fixed 256 KiB of
// incompressible bytes, never cached, readable from the app's origins, and
// limited per address.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { bootServer } from './helpers/e2eServer.js'
import { SPEED_PROBE_BYTES, SPEED_PROBE_RATE_LIMIT_MAX } from '../lib/speedProbe.js'

describe('GET /health/speed', () => {
  let cloud
  before(async () => {
    cloud = await bootServer({ IS_CLOUD: '1' }, ['--local'])
  })
  after(async () => {
    await cloud?.stop()
  })

  it('answers 256 KiB of incompressible bytes, never cached, to the app origin', async () => {
    const res = await fetch(`${cloud.base}/health/speed?t=1`, { headers: { Origin: 'https://app.openvolley.app' } })
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(res.status, 200)
    assert.equal(body.length, SPEED_PROBE_BYTES)
    assert.equal(SPEED_PROBE_BYTES, 256 * 1024)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('content-length'), String(SPEED_PROBE_BYTES))
    assert.match(res.headers.get('cache-control'), /no-store/)
    assert.match(res.headers.get('cache-control'), /no-transform/)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.openvolley.app')
    // random bytes: gzip cannot shrink them (a proxy's compression changes nothing)
    assert.ok(gzipSync(body).length > SPEED_PROBE_BYTES * 0.99)
    // the same bytes for the life of the process (made once)
    const again = Buffer.from(await (await fetch(`${cloud.base}/health/speed?t=2`)).arrayBuffer())
    assert.ok(again.equals(body))
  })

  it('HEAD has the headers and no body; other methods are refused', async () => {
    const head = await fetch(`${cloud.base}/health/speed`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(SPEED_PROBE_BYTES))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const post = await fetch(`${cloud.base}/health/speed`, { method: 'POST', body: 'x' })
    await post.arrayBuffer()
    assert.equal(post.status, 405)
  })

  it('an address gets at most SPEED_PROBE_RATE_LIMIT_MAX probes a minute, then 429', async () => {
    const own = await bootServer({}, ['--local'])
    try {
      const statuses = []
      for (let i = 0; i <= SPEED_PROBE_RATE_LIMIT_MAX; i++) {
        const res = await fetch(`${own.base}/health/speed?t=${i}`)
        await res.arrayBuffer()
        statuses.push(res.status)
      }
      assert.deepEqual(statuses.slice(0, SPEED_PROBE_RATE_LIMIT_MAX), Array(SPEED_PROBE_RATE_LIMIT_MAX).fill(200))
      assert.equal(statuses[SPEED_PROBE_RATE_LIMIT_MAX], 429)
      // the liveness check is not part of that budget
      assert.equal((await fetch(`${own.base}/health/live`)).status, 200)
    } finally {
      await own.stop()
    }
  })
})
