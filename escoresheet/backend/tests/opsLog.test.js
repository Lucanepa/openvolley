import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { newRequestId, formatDbRejection, createLogLimiter, createConnectionSummary } from '../lib/opsLog.js'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('newRequestId', () => {
  it('is 12 hex chars and differs per call', () => {
    const a = newRequestId()
    assert.match(a, /^[0-9a-f]{12}$/)
    assert.notEqual(a, newRequestId())
  })
})

describe('formatDbRejection', () => {
  it('prints status, code, table, action and request id', () => {
    assert.equal(
      formatDbRejection({ reqId: 'abc123', status: 400, code: 'OV_UNSCOPED_EXTERNAL_ID', table: 'events', action: 'upsert' }),
      '[DB] rejected req=abc123 status=400 code=OV_UNSCOPED_EXTERNAL_ID table=events action=upsert'
    )
  })

  it('uses - for unknown fields (rejected before the body was parsed)', () => {
    assert.equal(
      formatDbRejection({ reqId: 'r1', status: 429, code: 'OV_RATE_LIMITED' }),
      '[DB] rejected req=r1 status=429 code=OV_RATE_LIMITED table=- action=-'
    )
  })

  it('cannot be used for log injection or to smuggle values', () => {
    const line = formatDbRejection({
      reqId: 'r1\nFAKE',
      status: '401; rm',
      code: 'x"\n[DB] ok game_pin=123456',
      table: 'matches\r\nadmin',
      action: 'insert\t'
    })
    assert.equal(line.includes('\n'), false)
    assert.equal(line.includes('\r'), false)
    assert.equal(line.includes(' game_pin='), false)
    assert.match(line, /status=0 /)
  })
})

describe('createLogLimiter', () => {
  it('passes max lines per key and window, then reports the suppressed count per key', () => {
    let t = 0
    const out = []
    const log = createLogLimiter({ max: 2, windowMs: 1000, write: (l) => out.push(l), now: () => t })
    log('a', 'X'); log('b', 'X'); log('c', 'X'); log('d', 'X')
    assert.deepEqual(out, ['a', 'b'])
    t = 1500
    log('e', 'X')
    assert.deepEqual(out, ['a', 'b', '[log] suppressed in the last 2s: X=2', 'e'])
  })

  it('a flood of one code does not suppress another code', () => {
    let t = 0
    const out = []
    const log = createLogLimiter({ max: 2, windowMs: 60_000, write: (l) => out.push(l), now: () => t })
    for (let i = 0; i < 100; i++) log(`401 #${i}`, 'missing_token')
    log('scope', 'OV_UNSCOPED_EXTERNAL_ID')
    log('old', 'OV_CLIENT_TOO_OLD')
    assert.deepEqual(out, ['401 #0', '401 #1', 'scope', 'old'])
    t = 60_000
    assert.equal(log.flush(), '[log] suppressed in the last 60s: missing_token=98')
  })

  it('flush() reports a burst followed by quiet, once, and only after the window', () => {
    let t = 0
    const out = []
    const log = createLogLimiter({ max: 1, windowMs: 1000, write: (l) => out.push(l), now: () => t })
    log('a', 'A'); log('b', 'A'); log('c', 'B'); log('d', 'B'); log('e', 'B')
    t = 500
    assert.equal(log.flush(), null)
    t = 1000
    assert.equal(log.flush(), '[log] suppressed in the last 1s: A=1, B=2')
    t = 5000
    assert.equal(log.flush(), null)
    assert.deepEqual(out, ['a', 'c', '[log] suppressed in the last 1s: A=1, B=2'])
  })

  it('caps the number of keys; extra keys share "other"', () => {
    const out = []
    const log = createLogLimiter({ max: 1, maxKeys: 2, windowMs: 1000, write: (l) => out.push(l), now: () => 0 })
    log('1', 'k1'); log('2', 'k2'); log('3', 'k3'); log('4', 'k4')
    assert.deepEqual(out, ['1', '2', '3'])
  })

  it('prints no suppression note when nothing was dropped', () => {
    let t = 0
    const out = []
    const log = createLogLimiter({ max: 5, windowMs: 1000, write: (l) => out.push(l), now: () => t })
    log('a'); t = 5000; log('b')
    assert.deepEqual(out, ['a', 'b'])
    t = 10_000
    assert.equal(log.flush(), null)
  })
})

describe('createConnectionSummary', () => {
  it('turns a burst of socket churn into one line per interval', () => {
    let t = 0
    const out = []
    const s = createConnectionSummary({ label: '[WS]', intervalMs: 60_000, write: (l) => out.push(l), now: () => t })
    for (let i = 0; i < 500; i++) {
      s.count('sockets opened'); s.setGauge('open', 3)
      s.count('sockets closed'); s.setGauge('open', 2)
      t += 100
    }
    assert.equal(out.length, 0)
    t = 60_000
    s.flush()
    assert.deepEqual(out, ['[WS] last 60s: 500 sockets opened, 500 sockets closed, open now 2'])
  })

  it('flushes from count() once the interval elapsed, and stays silent when idle', () => {
    let t = 0
    const out = []
    const s = createConnectionSummary({ intervalMs: 1000, write: (l) => out.push(l), now: () => t })
    s.count('x')
    t = 1000
    s.count('x')
    assert.deepEqual(out, ['[WS] last 1s: 2 x'])
    t = 5000
    assert.equal(s.flush(), null)
    assert.equal(out.length, 1)
    assert.deepEqual(s.snapshot(), {})
  })
})

describe('server.js logging (source)', () => {
  const src = readFileSync(join(HERE, '..', 'server.js'), 'utf8')

  it('logs every rejected /api/db path with the value-free formatter', () => {
    const start = src.indexOf("if (url.pathname === '/api/db' && req.method === 'POST')")
    const end = src.indexOf('// Removed with the Supabase proxy', start)
    assert.ok(start > 0 && end > start)
    const handler = src.slice(start, end)
    for (const code of ['OV_RATE_LIMITED', 'OV_INVALID_REQUEST', 'OV_UNFILTERED_WRITE', 'missing_token', 'invalid_token']) {
      assert.ok(handler.includes(`'${code}'`), `no rejection log for ${code}`)
    }
    assert.match(handler, /if \(r\.status >= 400\) logRejected\(r\.status, r\.body\?\.error\?\.code\)/)
    // never the request body, filters or error details in the rejection line
    // (the Authorization header is only tested for presence)
    assert.doesNotMatch(handler, /logRejected\([^)]*(request|params|details|p\.data|p\.filters)/)
    assert.doesNotMatch(handler, /logRejected\([^)]*headers\.authorization\s*[,)]/)
  })

  it('does not log one line per relay socket by default (no client IPs either)', () => {
    assert.doesNotMatch(src, /console\.log\(`✅ Client connected[^`]*from \$\{ip\}/)
    assert.match(src, /if \(LOG_EACH_CONNECTION\) console\.log\(`✅ Client connected/)
    assert.match(src, /if \(LOG_EACH_CONNECTION\) console\.log\(`❌ Client disconnected/)
  })
})
