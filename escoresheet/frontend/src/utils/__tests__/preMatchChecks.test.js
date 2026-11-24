// Coin toss connection checks in offline mode: every offline coin toss showed
// "Some checks reported issues" with a red cross (owner, 2026-10-21). The
// cloud checks, and the relay ones when the relay is the cloud's, are skipped
// ("Offline mode: not checked") and are not issues; a venue relay is still
// checked.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runConnectionChecks, checksOutcome, isCloudBackend, readOfflineMode } from '../preMatchChecks'

const t = (key, fallback) => fallback ?? key

// apiFrom stand-in: a query chain that answers `result` (or throws `error`)
function api({ result = { data: { status: 'live' }, error: null }, fail = false } = {}) {
  const calls = []
  const apiFrom = (table) => {
    calls.push(table)
    if (fail) throw new Error('Failed to fetch')
    const chain = {
      select: () => chain, limit: () => Promise.resolve({ data: [], error: null }),
      eq: () => chain, maybeSingle: () => Promise.resolve(result)
    }
    return chain
  }
  return { apiFrom, calls }
}

const okFetch = vi.fn(async (url) => ({
  ok: true,
  json: async () => (url.endsWith('/api/server/connections') ? { clients: [{ matchId: '7' }] } : {})
}))
const downFetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
const base = { t, matchId: 7, seedKey: 'match_7', localMatch: { refereeConnectionEnabled: true } }

afterEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('preMatchChecks', () => {
  it('online: all four run and pass', async () => {
    const { apiFrom } = api()
    const checks = await runConnectionChecks({ ...base, backendUrl: 'https://backend.openvolley.app', apiFrom, fetchFn: okFetch })
    expect(Object.values(checks).map(c => c.status)).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(checksOutcome(checks)).toBe('ok')
  })

  it('online with the cloud down: issues, as before', async () => {
    const { apiFrom } = api({ fail: true })
    const checks = await runConnectionChecks({ ...base, backendUrl: 'https://backend.openvolley.app', apiFrom, fetchFn: downFetch })
    expect(checks.websocket.status).toBe('fail')
    expect(checks.supabase.status).toBe('fail')
    expect(checksOutcome(checks)).toBe('fail')
  })

  it('offline mode with the cloud relay: nothing is called, all skipped as offline, no issue', async () => {
    const { apiFrom, calls } = api({ fail: true })
    const updates = []
    const checks = await runConnectionChecks({
      ...base, offlineMode: true, backendUrl: 'https://backend.openvolley.app', apiFrom, fetchFn: downFetch,
      onUpdate: c => updates.push(Object.values(c).map(x => x.status))
    })
    expect(calls).toEqual([])
    expect(downFetch).not.toHaveBeenCalled()
    for (const check of Object.values(checks)) {
      expect(check.status).toBe('skip')
      expect(check.offline).toBe(true)
      expect(check.note).toBe('Offline mode: not checked')
    }
    expect(updates[0]).toEqual(['pending', 'pending', 'pending', 'pending'])
    expect(checksOutcome(checks)).toBe('offline')
  })

  it('offline mode with a venue / desktop relay: the relay is still checked, a real problem still shows', async () => {
    const { apiFrom, calls } = api()
    const up = await runConnectionChecks({ ...base, offlineMode: true, backendUrl: 'http://192.168.1.20:5173', apiFrom, fetchFn: okFetch })
    expect(calls).toEqual([])
    expect(up.websocket.status).toBe('pass')
    expect(up.devices.status).toBe('pass')
    expect(up.supabase).toMatchObject({ status: 'skip', offline: true })
    expect(up.matchData).toMatchObject({ status: 'skip', offline: true })
    expect(checksOutcome(up)).toBe('offline')

    const down = await runConnectionChecks({ ...base, offlineMode: true, backendUrl: 'http://192.168.1.20:5173', apiFrom, fetchFn: downFetch })
    expect(down.websocket.status).toBe('fail')
    expect(down.websocket.note).toBeUndefined()
    expect(checksOutcome(down)).toBe('fail')
  })

  it('a check still pending at the time-out fails', async () => {
    const { apiFrom } = api()
    const never = () => new Promise(() => {})
    const checks = await runConnectionChecks({ ...base, backendUrl: 'http://127.0.0.1:5173', apiFrom, fetchFn: never, timeoutMs: 20 })
    expect(checks.websocket.status).toBe('fail')
    expect(checks.supabase.status).toBe('pass')
  })

  it('a test match and no backend skip without the offline note', async () => {
    const { apiFrom } = api()
    const checks = await runConnectionChecks({ ...base, isTest: true, backendUrl: null, apiFrom, fetchFn: okFetch })
    expect(Object.values(checks).every(c => c.status === 'skip' && !c.offline && !c.note)).toBe(true)
    expect(checksOutcome(checks)).toBe('ok')
  })

  it('outcomes: a warning is not an issue', () => {
    expect(checksOutcome({ a: { status: 'warn' }, b: { status: 'skip', offline: true } })).toBe('warn')
    expect(checksOutcome({ a: { status: 'fail' }, b: { status: 'skip', offline: true } })).toBe('fail')
    expect(checksOutcome({})).toBe('ok')
  })

  it('isCloudBackend / readOfflineMode', () => {
    expect(isCloudBackend('https://backend.openvolley.app')).toBe(true)
    expect(isCloudBackend('http://192.168.1.20:5173')).toBe(false)
    expect(isCloudBackend('http://localhost:5173')).toBe(false)
    expect(isCloudBackend('not a url')).toBe(false)
    expect(isCloudBackend(null)).toBe(false)
    expect(readOfflineMode()).toBe(false)
    localStorage.setItem('offlineMode', 'true')
    expect(readOfflineMode()).toBe(true)
  })
})
