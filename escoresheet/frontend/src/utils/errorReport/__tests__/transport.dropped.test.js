/**
 * A report the server's rate limit dropped is not lost (audit SEC-19): a 202
 * with `dropped` keeps what it did not take or refuse in the queue and sends
 * it again later, at most DROPPED_MAX_AGE_MS after it happened. Before, a
 * 202 counted as taken and the report was deleted, so while anyone kept the
 * server's budget used up, every device's reports were gone for good.
 */
import { describe, it, expect } from 'vitest'
import { createTransport, DROPPED_MAX_AGE_MS } from '../transport'

function memoryStore() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const NOW = Date.parse('2026-11-23T12:00:00Z')
const at = (ms) => new Date(NOW - ms).toISOString()
const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data, error: null }) })

describe('error reports: a rate limit keeps them for later', () => {
  it('202 dropped: what was not taken or refused stays queued and a retry is planned', async () => {
    const store = memoryStore()
    const timers = []
    const t = createTransport({
      store, url: () => 'https://backend.example/api/errors', now: () => NOW,
      setTimer: (fn, ms) => { timers.push(ms); return 0 },
      fetchImpl: async () => answer(202, { accepted: [], rejected: [{ uid: 'bad', code: 'OV_ERROR_INVALID' }], dropped: 2 })
    })
    t.enqueue({ uid: 'a', level: 'warn', client_ts: at(1000) })
    t.enqueue({ uid: 'b', level: 'warn', client_ts: at(1000) })
    t.enqueue({ uid: 'bad', level: 'warn', client_ts: at(1000) })
    expect(await t.flush()).toEqual({ sent: 0 })
    expect(t.queue().map((e) => e.uid)).toEqual(['a', 'b'])
    expect(timers.at(-1)).toBe(60 * 1000)
  })

  it('the retry sends them again, and a 200 takes them', async () => {
    const store = memoryStore()
    let first = true
    const bodies = []
    const t = createTransport({
      store, url: () => 'x', now: () => NOW, setTimer: () => 1,
      fetchImpl: async (u, init) => {
        bodies.push(JSON.parse(init.body).events.map((e) => e.uid))
        if (first) { first = false; return answer(202, { accepted: [], rejected: [], dropped: 1 }) }
        return answer(200, { accepted: ['a'], rejected: [] })
      }
    })
    t.enqueue({ uid: 'a', level: 'error', client_ts: at(0) })
    await t.flush()
    expect(t.queue()).toHaveLength(1)
    await t.flush()
    expect(bodies).toEqual([['a'], ['a']])
    expect(t.queue()).toHaveLength(0)
  })

  it('a dropped report older than a day is let go', async () => {
    const store = memoryStore()
    const t = createTransport({ store, url: () => 'x', now: () => NOW, setTimer: () => 1, fetchImpl: async () => answer(202, { accepted: [], rejected: [], dropped: 2 }) })
    t.enqueue({ uid: 'old', level: 'warn', client_ts: at(DROPPED_MAX_AGE_MS + 1000) })
    t.enqueue({ uid: 'new', level: 'warn', client_ts: at(60 * 1000) })
    await t.flush()
    expect(t.queue().map((e) => e.uid)).toEqual(['new'])
  })

  it('a 202 without anything dropped (or an older server\'s body) counts as taken', async () => {
    const store = memoryStore()
    const t = createTransport({ store, url: () => 'x', now: () => NOW, setTimer: () => 1, fetchImpl: async () => ({ ok: true, status: 202 }) })
    t.enqueue({ uid: 'a', level: 'warn', client_ts: at(0) })
    expect(await t.flush()).toEqual({ sent: 1 })
    expect(t.queue()).toHaveLength(0)
  })
})
