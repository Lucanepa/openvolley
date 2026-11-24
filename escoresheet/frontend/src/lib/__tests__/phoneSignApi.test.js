/**
 * lib/phoneSignApi.js: what the scoring device sends (docs/qr-signing-spec.md
 * 4.2, 5.2): the cloud start with the session, the LAN start with the game PIN
 * only off the relay host, the token in the link's fragment only, and results
 * instead of throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiClient', () => ({ authorizationHeader: () => ({ Authorization: 'Bearer SESSION' }) }))
import { startPhoneSign, waitPhoneSign, closePhoneSign, phoneSignUrl } from '../phoneSignApi'

const okStart = { ok: true, token: 'T'.repeat(43), watch: 'W'.repeat(43), expiresAt: 600000, ttlSeconds: 600, path: '/sign' }
const json = (status, body) => ({ ok: status < 300, status, json: async () => body })

let calls
const fetchImpl = (answer) => vi.fn(async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) })
  return typeof answer === 'function' ? answer(url, init) : answer
})
const setHost = (hostname) => Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, hostname } })

beforeEach(() => { calls = [] })

describe('phoneSignApi', () => {
  it('cloud start: the session, the slot and context; the handle keeps both secrets', async () => {
    const f = fetchImpl(json(201, okStart))
    const r = await startPhoneSign({ transport: 'cloud', apiBase: 'https://backend.test', phoneBase: 'https://backend.test', slot: 'ref1', matchKey: 'seed-1', context: { home: 'A', away: 'B' }, gamePin: '987654', fetchImpl: f })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://backend.test/api/sign/start')
    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer SESSION' })
    expect(calls[0].init.headers['X-OV-Match-Pin']).toBeUndefined() // the PIN never goes to the cloud
    expect(calls[0].body).toEqual({ slot: 'ref1', matchKey: 'seed-1', context: { home: 'A', away: 'B' } })
    expect(r.handle).toMatchObject({ transport: 'cloud', token: okStart.token, watch: okStart.watch, ttlSeconds: 600 })
    expect(phoneSignUrl(r.handle)).toBe(`https://backend.test/sign#k=${okStart.token}`)
  })

  it('LAN start: no session; the game PIN only from another device than the relay host', async () => {
    const f = fetchImpl(json(201, okStart))
    setHost('localhost')
    await startPhoneSign({ transport: 'lan', apiBase: 'http://localhost:5173', phoneBase: 'http://192.168.1.10:5173', slot: 'scorer', context: {}, gamePin: '987654', fetchImpl: f })
    expect(calls[0].init.headers.Authorization).toBeUndefined()
    expect(calls[0].init.headers['X-OV-Match-Pin']).toBeUndefined()
    setHost('192.168.1.10')
    await startPhoneSign({ transport: 'lan', apiBase: 'http://192.168.1.10:5173', phoneBase: 'http://192.168.1.10:5173', slot: 'scorer', context: {}, gamePin: '987654', fetchImpl: f })
    expect(calls[1].init.headers['X-OV-Match-Pin']).toBe('987654')
    setHost('localhost')
  })

  it('LAN start from a loopback page the relay does not count as itself: once more with the game PIN', async () => {
    setHost('localhost')
    const f = fetchImpl((url, init) => (init.headers['X-OV-Match-Pin'] ? json(201, okStart) : json(403, { ok: false, code: 'OV_SIGN_FORBIDDEN' })))
    const r = await startPhoneSign({ transport: 'lan', apiBase: 'http://localhost:8080', phoneBase: 'http://192.168.1.10:8080', slot: 'scorer', matchKey: 'seed-1', context: {}, gamePin: '987654', fetchImpl: f })
    expect(r.ok).toBe(true)
    expect(calls.map((c) => c.init.headers['X-OV-Match-Pin'])).toEqual([undefined, '987654'])
    // Without a PIN, or refused for another reason: no second request
    calls = []
    await startPhoneSign({ transport: 'lan', apiBase: 'http://localhost:8080', phoneBase: 'x', slot: 'scorer', context: {}, gamePin: null, fetchImpl: f })
    await startPhoneSign({ transport: 'lan', apiBase: 'http://localhost:8080', phoneBase: 'x', slot: 'scorer', context: {}, gamePin: '987654', fetchImpl: fetchImpl(json(429, { ok: false, code: 'OV_SIGN_RATE_LIMITED' })) })
    expect(calls).toHaveLength(2)
  })

  it('errors are results: codes, an old relay (404 without JSON), the network', async () => {
    expect(await startPhoneSign({ transport: 'cloud', apiBase: 'x', slot: 's', context: {}, fetchImpl: fetchImpl(json(403, { ok: false, code: 'OV_SIGN_FORBIDDEN' })) }))
      .toEqual({ ok: false, status: 403, code: 'OV_SIGN_FORBIDDEN' })
    const old = fetchImpl({ ok: false, status: 404, json: async () => { throw new Error('html') } })
    expect(await startPhoneSign({ transport: 'lan', apiBase: 'x', slot: 's', context: {}, fetchImpl: old })).toMatchObject({ ok: false, code: 'OV_SIGN_UNSUPPORTED' })
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    expect(await startPhoneSign({ transport: 'lan', apiBase: 'x', slot: 's', context: {}, fetchImpl: down })).toMatchObject({ ok: false, network: true, code: 'OV_SIGN_NETWORK' })
  })

  it('wait and close send only the watch secret; an aborted wait says so', async () => {
    const handle = { apiBase: 'https://backend.test', watch: 'W'.repeat(43), token: 'T'.repeat(43) }
    const f = fetchImpl(json(200, { ok: true, state: 'opened' }))
    expect(await waitPhoneSign(handle, 'pending', { fetchImpl: f })).toMatchObject({ ok: true, state: 'opened' })
    expect(calls[0]).toMatchObject({ url: 'https://backend.test/api/sign/wait', body: { watch: handle.watch, known: 'pending' } })
    await closePhoneSign(handle, { keepalive: true, fetchImpl: f })
    expect(calls[1]).toMatchObject({ url: 'https://backend.test/api/sign/close', body: { watch: handle.watch } })
    expect(calls[1].init.keepalive).toBe(true)
    for (const c of calls) expect(JSON.stringify(c.body)).not.toContain(handle.token)

    const ac = new AbortController()
    const hang = vi.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const p = waitPhoneSign(handle, 'pending', { signal: ac.signal, fetchImpl: hang })
    ac.abort()
    expect(await p).toMatchObject({ ok: false, code: 'OV_SIGN_ABORTED' })
  })
})
