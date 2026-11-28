import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  measureInternet, internetVerdict, median,
  SLOW_RTT_MS, SLOW_MBPS, TOTAL_BUDGET_MS, RTT_TIMEOUT_MS, DOWNLOAD_BYTES
} from '../internetCheck'

// The start check's "Internet" row (owner 28.11.2026): round trip = median of
// 3 small requests to the backend, plus one fixed 256 KiB download from the
// backend, at most ~2.5 s, nothing when offline, no download with data saver.

const BASE = 'https://backend.example.openvolley.app'

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

/**
 * A fake network on the fake clock. rtt: per /health/live call, a delay in ms,
 * 'fail' (no route: TypeError) or 'hang' (no answer). download: the
 * /health/speed answer: time to its headers, then `chunk` bytes every
 * `chunkMs` until `bytes`.
 */
function fakeNet({ rtt = [40, 40, 40], download = {} } = {}) {
  const dl = { status: 200, type: 'application/octet-stream', ttfb: 40, chunk: 64 * 1024, chunkMs: 20, bytes: DOWNLOAD_BYTES, ...download }
  const calls = []
  let rttCalls = 0
  const fetchImpl = vi.fn((url, options = {}) => {
    calls.push({ url, options })
    const { signal } = options
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      if (url.includes('/health/live?')) {
        const step = rtt[rttCalls++] ?? 40
        if (step === 'fail') { setTimeout(() => reject(new TypeError('Failed to fetch')), 5); return }
        if (step === 'hang') return
        setTimeout(() => resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => new ArrayBuffer(16)
        }), step)
        return
      }
      if (url.includes('/health/speed?')) {
        if (dl.ttfb === 'hang') return
        let sent = 0
        setTimeout(() => resolve({
          ok: dl.status >= 200 && dl.status < 300,
          status: dl.status,
          headers: new Headers({ 'content-type': dl.type }),
          arrayBuffer: async () => new ArrayBuffer(dl.bytes),
          body: {
            cancel: () => Promise.resolve(),
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () => {
                if (sent >= dl.bytes) return Promise.resolve({ done: true, value: undefined })
                return new Promise((ok, fail) => {
                  if (signal?.aborted) { fail(abortError()); return }
                  setTimeout(() => {
                    const n = Math.min(dl.chunk, dl.bytes - sent)
                    sent += n
                    ok({ done: false, value: new Uint8Array(n) })
                  }, dl.chunkMs)
                })
              }
            })
          }
        }), dl.ttfb)
        return
      }
      reject(new TypeError(`unexpected ${url}`))
    })
  })
  return { fetchImpl, calls }
}

async function run(net, options = {}) {
  const promise = measureInternet({ baseUrl: BASE, fetchImpl: net.fetchImpl, now: () => Date.now(), online: true, saveData: false, ...options })
  await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS + 1000)
  return promise
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('median and verdict', () => {
  it('median of 3 leaves out the one slow first request', () => {
    expect(median([120, 40, 38])).toBe(40)
    expect(median([40, 1500])).toBe(770)
    expect(median([])).toBeNull()
  })

  it('slow above SLOW_RTT_MS or below SLOW_MBPS, a number not measured does not count', () => {
    expect(internetVerdict({ rttMs: 40, mbps: 24 })).toBe('good')
    expect(internetVerdict({ rttMs: SLOW_RTT_MS + 1, mbps: 24 })).toBe('slow')
    expect(internetVerdict({ rttMs: 40, mbps: SLOW_MBPS - 0.1 })).toBe('slow')
    expect(internetVerdict({ rttMs: 40, mbps: null })).toBe('good')
  })
})

describe('measureInternet', () => {
  it('a good line: median round trip of 3, one 256 KiB download, numbers and verdict', async () => {
    const net = fakeNet({ rtt: [120, 40, 38] })
    const r = await run(net)
    expect(r.status).toBe('good')
    expect(r.rttMs).toBe(40)
    expect(r.samples).toEqual([120, 40, 38])
    // 256 KiB in 80 ms from its first byte: 26.2 Mbit/s
    expect(r.bytes).toBe(DOWNLOAD_BYTES)
    expect(r.mbps).toBe(26)
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual(['/health/live', '/health/live', '/health/live', '/health/speed'])
  })

  it('every request is cache-busted, never cached and carries no credentials', async () => {
    const net = fakeNet()
    await run(net)
    const urls = net.calls.map((c) => c.url)
    expect(new Set(urls).size).toBe(urls.length)
    for (const { url, options } of net.calls) {
      expect(url.startsWith(`${BASE}/health/`)).toBe(true)
      expect(new URL(url).searchParams.get('t')).toBeTruthy()
      expect(options.cache).toBe('no-store')
      expect(options.credentials).toBe('omit')
      expect(options.headers).toBeUndefined()
    }
  })

  it('a long round trip reads slow', async () => {
    const r = await run(fakeNet({ rtt: [450, 420, 430] }))
    expect(r.status).toBe('slow')
    expect(r.rttMs).toBe(430)
  })

  it('a thin line reads slow: the download stops at its budget and is measured on what arrived', async () => {
    // 8 KiB every 100 ms: about 0.6 Mbit/s
    const r = await run(fakeNet({ download: { chunk: 8 * 1024, chunkMs: 100 } }))
    expect(r.status).toBe('slow')
    expect(r.bytes).toBeLessThan(DOWNLOAD_BYTES)
    expect(r.mbps).toBeGreaterThan(0.4)
    expect(r.mbps).toBeLessThan(SLOW_MBPS)
    expect(r.durationMs).toBeLessThanOrEqual(TOTAL_BUDGET_MS)
  })

  it('offline: nothing is sent', async () => {
    const net = fakeNet()
    const r = await run(net, { online: false })
    expect(r.status).toBe('offline')
    expect(net.fetchImpl).not.toHaveBeenCalled()
  })

  it('no route to the server: offline after the first request', async () => {
    const net = fakeNet({ rtt: ['fail', 40, 40] })
    const r = await run(net)
    expect(r.status).toBe('offline')
    expect(net.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no answer within RTT_TIMEOUT_MS: slow, with the time waited, and no download', async () => {
    const net = fakeNet({ rtt: ['hang'] })
    const r = await run(net)
    expect(r.status).toBe('slow')
    expect(r.rttMs).toBeNull()
    expect(r.noAnswerMs).toBe(RTT_TIMEOUT_MS)
    expect(net.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a later round trip with no answer counts with the full time waited', async () => {
    const r = await run(fakeNet({ rtt: [40, 'hang'] }))
    expect(r.samples).toEqual([40, RTT_TIMEOUT_MS])
    expect(r.status).toBe('slow')
  })

  it('data saver on: the round trips only, no download', async () => {
    const net = fakeNet()
    const r = await run(net, { saveData: true })
    expect(r.status).toBe('good')
    expect(r.saveData).toBe(true)
    expect(r.mbps).toBeNull()
    expect(net.calls.every((c) => c.url.includes('/health/live?'))).toBe(true)
    expect(net.fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('a server without the probe (404) or over its limit: the round trip alone decides', async () => {
    for (const status of [404, 429]) {
      const r = await run(fakeNet({ download: { status, type: 'application/json' } }))
      expect(r.status).toBe('good')
      expect(r.rttMs).toBe(40)
      expect(r.mbps).toBeNull()
    }
  })

  it('an answer that is not the probe (a page\'s index.html) gives no number', async () => {
    const r = await run(fakeNet({ download: { type: 'text/html', bytes: 2000 } }))
    expect(r.mbps).toBeNull()
  })

  it('never runs past TOTAL_BUDGET_MS, also on a line where everything is slow', async () => {
    const r = await run(fakeNet({ rtt: [1400, 1400, 1400], download: { ttfb: 300, chunk: 4 * 1024, chunkMs: 200 } }))
    expect(r.status).toBe('slow')
    expect(r.durationMs).toBeLessThanOrEqual(TOTAL_BUDGET_MS)
  })

  it('no cloud server here: not measured, nothing sent', async () => {
    const net = fakeNet()
    const r = await run(net, { baseUrl: null })
    expect(r.status).toBe('not_checked')
    expect(net.fetchImpl).not.toHaveBeenCalled()
  })

  it('the dialog closed (signal aborted): stops at once and sends nothing more', async () => {
    const net = fakeNet({ rtt: [200, 200, 200] })
    const controller = new AbortController()
    const promise = measureInternet({ baseUrl: BASE, fetchImpl: net.fetchImpl, now: () => Date.now(), online: true, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(3000)
    const r = await promise
    expect(r.status).toBe('not_checked')
    expect(net.fetchImpl).toHaveBeenCalledTimes(1)
  })
})
