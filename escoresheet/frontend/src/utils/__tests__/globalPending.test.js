import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 2611 review, SR-4: a Global tournament day behind one hall's address spent
// the hall's daily share; the final uploads of the later matches got 429
// until the day ended, were tried 3 times within seconds and then given up,
// and a closed match is never saved again. Now such an upload is kept on the
// device and sent again after the server's Retry-After.
vi.mock('../backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `https://api.test${p}` }))

import { db } from '../../db/db'
import { uploadGlobalFinal } from '../globalCloud'
import { saveGlobalCloud } from '../globalCloudDb'
import { retryGlobalPending, keepGlobalPending, retryWaitMs, isRetryableRefusal, PENDING_MAX_AGE_MS, RETRY_MIN_MS, RETRY_MAX_MS } from '../globalPending'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const HOUR = 3600 * 1000

function backup(match = {}) {
  return {
    version: 1,
    match: { id: 9, status: 'ended', global: true, globalKey: KEY, refereePin: '654321', cloud: true, ...match },
    homeTeam: { name: 'North' },
    awayTeam: { name: 'South' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }],
    events: [{ seq: 1, type: 'point' }]
  }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const refused = (retryAfter) => json(429, { data: null, error: { code: 'OV_GLOBAL_QUOTA' } }, retryAfter ? { 'Retry-After': String(retryAfter) } : {})
const stored = () => json(200, { data: { ok: true }, error: null })

let answer
const calls = []
beforeEach(async () => {
  await db.open()
  await db.global_pending.clear()
  localStorage.clear()
  calls.length = 0
  answer = () => refused(5 * 3600)
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return answer(url, init)
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('the refused final uploads of a Global match are kept and sent again (SR-4)', () => {
  it('a 429 for the hall\'s spent day: the final PDF and backup are kept until the server\'s Retry-After, then sent', async () => {
    const t0 = Date.now()
    const pdfBlob = new Blob(['%PDF-1.4 final'], { type: 'application/pdf' })
    const r = await uploadGlobalFinal({ match: backup({ cloud: false }).match, matchId: 9, pdfBlob, backupData: backup({ cloud: false }) }, { retries: 1, waitMs: 1 })
    expect(r).toEqual({ ok: false, pending: 2 })
    const kept = await db.global_pending.orderBy('id').toArray()
    expect(kept.map((e) => e.id)).toEqual([`${KEY}|backup`, `${KEY}|scoresheet-final`])
    for (const e of kept) {
      expect(e.path).toBe('/api/global/save')
      expect(e.body.key).toBe(KEY)
      expect(e.notBefore - t0).toBeGreaterThanOrEqual(5 * HOUR - 1000)
      expect(e.notBefore - t0).toBeLessThanOrEqual(5 * HOUR + 5000)
    }
    expect(atob(kept[1].body.fileBase64)).toBe('%PDF-1.4 final')
    // not yet: nothing is sent before the Retry-After
    calls.length = 0
    expect(await retryGlobalPending({ now: () => t0 + HOUR })).toEqual({ sent: 0, kept: 0, dropped: 0 })
    expect(calls).toEqual([])
    // the hall's next day: stored, and gone from the device
    answer = () => stored()
    expect(await retryGlobalPending({ now: () => t0 + 6 * HOUR })).toEqual({ sent: 2, kept: 0, dropped: 0 })
    expect(calls.map((c) => [c.url, c.body.kind]).sort()).toEqual([['https://api.test/api/global/save', 'backup'], ['https://api.test/api/global/save', 'scoresheet-final']])
    expect(await db.global_pending.count()).toBe(0)
  })

  it('the closed match\'s cloud copy with its PDF is kept too, once per match; the every-action saves are not', async () => {
    const t0 = Date.now()
    const live = await saveGlobalCloud(backup({ status: 'live' }), { database: db })
    expect(live.ok).toBe(false)
    expect(await db.global_pending.count()).toBe(0)
    const pdfBlob = new Blob(['%PDF-1.4 final'], { type: 'application/pdf' })
    for (let i = 0; i < 2; i++) {
      const r = await saveGlobalCloud(backup(), { pdfBlob, database: db, keepIfRefused: true })
      expect(r.pending).toBe(true)
    }
    const kept = await db.global_pending.toArray()
    expect(kept.map((e) => [e.id, e.path])).toEqual([[`${KEY}|cloud`, '/api/global/cloud/save']])
    expect(kept[0].body.pdf).toBeTruthy()
    answer = () => stored()
    expect(await retryGlobalPending({ now: () => t0 + 6 * HOUR })).toEqual({ sent: 1, kept: 0, dropped: 0 })
  })

  it('a busy server keeps it with a growing wait; a refusal for good (a wrong PIN) and an entry older than 7 days are dropped', async () => {
    const t0 = Date.now()
    await keepGlobalPending({ id: 'k1|cloud', path: '/api/global/cloud/save', body: { key: 'k1', pin: '1234' }, now: t0 })
    await keepGlobalPending({ id: 'k2|backup', path: '/api/global/save', body: { key: 'k2' }, now: t0 })
    await keepGlobalPending({ id: 'k3|backup', path: '/api/global/save', body: { key: 'k3' }, now: t0 - PENDING_MAX_AGE_MS - 1 })
    answer = (url, init) => (JSON.parse(init.body).key === 'k1'
      ? json(503, { data: null, error: { code: 'OV_BUSY' } }, { 'Retry-After': '5' })
      : json(403, { data: null, error: { code: 'OV_GLOBAL_PIN' } }))
    const out = await retryGlobalPending({ now: () => t0 + 2 * RETRY_MIN_MS })
    expect(out).toEqual({ sent: 0, kept: 1, dropped: 2 })
    const left = await db.global_pending.toArray()
    expect(left.map((e) => [e.id, e.attempts])).toEqual([['k1|cloud', 1]])
    expect(left[0].notBefore).toBe(t0 + 2 * RETRY_MIN_MS + RETRY_MIN_MS)
    // offline: nothing is tried
    localStorage.setItem('offlineMode', 'true')
    calls.length = 0
    expect(await retryGlobalPending({ now: () => t0 + 7 * RETRY_MIN_MS })).toEqual({ sent: 0, kept: 0, dropped: 0 })
    expect(calls).toEqual([])
  })

  it('which refusals wait, and how long', () => {
    expect([429, 500, 503, 507, 0, undefined].every(isRetryableRefusal)).toBe(true)
    expect([400, 403, 404, 413, 415].some(isRetryableRefusal)).toBe(false)
    expect(retryWaitMs(3600)).toBe(HOUR)
    expect(retryWaitMs(5)).toBe(RETRY_MIN_MS)
    expect(retryWaitMs(86400)).toBe(RETRY_MAX_MS)
    expect(retryWaitMs(null, 0)).toBe(RETRY_MIN_MS)
    expect(retryWaitMs(null, 3)).toBe(8 * RETRY_MIN_MS)
  })
})
