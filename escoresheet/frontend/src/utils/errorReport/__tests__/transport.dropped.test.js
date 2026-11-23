/**
 * A report the server's rate limit dropped is not lost (audit SEC-19): a 202
 * with `dropped` keeps what it did not take or refuse in the queue and sends
 * it again later, at most DROPPED_MAX_AGE_MS after it happened. Before, a
 * 202 counted as taken and the report was deleted, so while anyone kept the
 * server's budget used up, every device's reports were gone for good.
 *
 * Review ET-5: the beacon on every screen-off or app switch then sent the
 * queue without a Bearer and deleted it whatever the server answered, so a
 * report a 202 kept was lost at the next screen-off. Now what a beacon sent
 * stays queued until a fetch confirms it.
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

  it('202 dropped, then the screen goes off: the report is still queued, and a fetch sends it again with the session (ET-5)', async () => {
    const store = memoryStore()
    const timers = []
    const beacons = []
    const fetches = []
    let answerWith = answer(202, { accepted: [], rejected: [], dropped: 1 })
    const t = createTransport({
      store, url: () => 'x', now: () => NOW, authHeader: () => ({ Authorization: 'Bearer tok' }),
      setTimer: (fn, ms) => { timers.push(ms); return 0 },
      beacon: (u, body) => { beacons.push(body); return true },
      fetchImpl: async (u, init) => { fetches.push(init); return answerWith }
    })
    t.enqueue({ uid: 'a', level: 'warn', client_ts: at(1000) })
    await t.flush()
    expect(t.queue().map((e) => e.uid)).toEqual(['a'])
    t.flushOnExit()
    expect(beacons).toHaveLength(1)
    expect(t.queue().map((e) => e.uid)).toEqual(['a'])
    expect(timers.at(-1)).toBe(60 * 1000)
    // hidden again before anything else ran: not beaconed a second time
    t.flushOnExit()
    expect(beacons).toHaveLength(1)
    // a new report goes by the next beacon, the old one waits for the fetch
    t.enqueue({ uid: 'b', level: 'warn', client_ts: at(500) })
    t.flushOnExit()
    expect(beacons).toHaveLength(2)
    expect(JSON.parse(await beacons[1].text()).events.map((e) => e.uid)).toEqual(['b'])
    // back: the fetch sends both with the Bearer, and a 200 takes them
    answerWith = answer(200, { accepted: ['a', 'b'], rejected: [] })
    await t.flush()
    expect(fetches.at(-1).headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(fetches.at(-1).body).events.map((e) => e.uid)).toEqual(['a', 'b'])
    expect(t.queue()).toHaveLength(0)
  })

  it('what a 202 kept goes behind the rest of the queue, so it does not hold up the others', async () => {
    const store = memoryStore()
    const t = createTransport({
      store, url: () => 'x', now: () => NOW, setTimer: () => 1,
      fetchImpl: async () => answer(202, { accepted: ['a'], rejected: [], dropped: 1 })
    })
    for (let i = 0; i < 25; i++) t.enqueue({ uid: i === 0 ? 'a' : i === 1 ? 'b' : `r${i}`, level: 'warn', client_ts: at(1000) })
    await t.flush()
    const q = t.queue().map((e) => e.uid)
    expect(q).toHaveLength(24)
    expect(q.slice(0, 5)).toEqual(['r20', 'r21', 'r22', 'r23', 'r24'])
    expect(q.at(-1)).toBe('r19')
    expect(q.indexOf('b')).toBe(5)
  })
})
