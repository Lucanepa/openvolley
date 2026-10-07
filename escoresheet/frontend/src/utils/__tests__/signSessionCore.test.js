// @vitest-environment node
/**
 * The Sign on phone core (electron/signSessionCore.cjs, docs/qr-signing-spec.md
 * section 4): the shared vectors (also run by the backend copy and sign.rs),
 * the secrets, the long-poll and the lifecycle of its timers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const core = require('../../../electron/signSessionCore.cjs')
const vectors = require('../../../electron/__fixtures__/sign-vectors.json')
const { runSignVectors } = require('../../../electron/__fixtures__/signVectorRunner.cjs')

const ctx = { home: 'A', away: 'B' }
const ink = { pad: { w: 4000, h: 2000 }, strokes: [[0, 1000, 300, 1000]] }

afterEach(() => { vi.useRealTimers() })

describe('signSessionCore', () => {
  it('agrees with every shared vector', async () => {
    expect(await runSignVectors(core, vectors)).toEqual([])
  })

  it('its SHA-256 is the standard one, over UTF-8', () => {
    for (const text of ['', 'abc', 'A'.repeat(43), 'Zürich \u{1F600}', 'x'.repeat(1000), randomBytes(32).toString('base64url')]) {
      expect(core.sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })

  it('base64url without padding, 43 characters for 32 bytes', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n)
      expect(core.base64url(b)).toBe(b.toString('base64url'))
    }
    expect(core.base64url(new Uint8Array(32))).toHaveLength(43)
  })

  it('hands out two different 256-bit secrets and keeps only their hashes', () => {
    const lines = []
    const s = core.createSignSessions({ log: (l) => lines.push(l) })
    const r = s.start({ slot: 'ref1', context: { ...ctx, name: 'Secret Person' } }, { owner: 'local' })
    expect(r.status).toBe(201)
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.body.watch).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.body.token).not.toBe(r.body.watch)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^sign\.start ref=[0-9a-f]{8} slot=ref1 via=lan$/)
    expect(lines[0]).not.toContain(r.body.token)
    expect(lines[0]).not.toContain('Secret')
    s.dispose()
  })

  it('injected randomness and hashing are used', () => {
    let n = 0
    const s = core.createSignSessions({
      randomBytes: (k) => new Uint8Array(k).fill(++n),
      sha256: (t) => createHash('sha256').update(t).digest('hex'),
      log: () => {},
    })
    const r = s.start({ slot: 'ref1', context: ctx }, { owner: 'local' })
    expect(r.body.token).toBe(Buffer.alloc(32, 1).toString('base64url'))
    expect(r.body.watch).toBe(Buffer.alloc(32, 2).toString('base64url'))
    s.dispose()
  })

  it('a held wait wakes on open and on submit, and a newer wait answers the older one', async () => {
    const s = core.createSignSessions({ log: () => {} })
    const { body: { token, watch } } = s.start({ slot: 'captain-a', context: ctx }, { owner: 'local' })
    const w1 = s.wait({ watch, known: 'pending' })
    expect(s.stats().waiters).toBe(1)
    s.open({ k: token }, { ipKey: 'ip' })
    expect((await w1).body.state).toBe('opened')

    const w2 = s.wait({ watch, known: 'opened' })
    const w3 = s.wait({ watch, known: 'opened' })
    expect((await w2).body.state).toBe('opened') // answered by the newer wait
    expect(s.stats().waiters).toBe(1)
    s.submit({ k: token, ...ink }, { ipKey: 'ip' })
    const r3 = await w3
    expect(r3.body).toMatchObject({ state: 'signed', pad: ink.pad, strokes: ink.strokes })
    expect(s.stats().waiters).toBe(0)
    s.dispose()
  })

  it('close wakes the waiter with "closed"', async () => {
    const s = core.createSignSessions({ log: () => {} })
    const { body: { watch } } = s.start({ slot: 'scorer', context: ctx }, { owner: 'local' })
    const w = s.wait({ watch, known: 'pending' })
    s.close({ watch })
    expect((await w).body).toEqual({ ok: true, state: 'closed' })
    s.dispose()
  })

  it('a wait holds 25 s at most, and ends with "expired" when the link runs out first', async () => {
    vi.useFakeTimers()
    let clock = 0
    const s = core.createSignSessions({ now: () => clock, log: () => {} })
    const { body: { watch } } = s.start({ slot: 'scorer', context: ctx }, { owner: 'local' })
    let answer = null
    s.wait({ watch, known: 'pending' }).then((r) => { answer = r })
    await vi.advanceTimersByTimeAsync(24999)
    expect(answer).toBeNull()
    clock = 25000
    await vi.advanceTimersByTimeAsync(1)
    expect(answer.body.state).toBe('pending')

    clock = 590000
    answer = null
    s.wait({ watch, known: 'pending' }).then((r) => { answer = r })
    clock = 600000
    await vi.advanceTimersByTimeAsync(10000) // the hold is cut to the link's end
    expect(answer.body.state).toBe('expired')
    s.dispose()
  })

  it('an aborted wait is dropped', async () => {
    const s = core.createSignSessions({ log: () => {} })
    const { body: { watch } } = s.start({ slot: 'scorer', context: ctx }, { owner: 'local' })
    const ac = new AbortController()
    const w = s.wait({ watch, known: 'pending' }, { signal: ac.signal })
    expect(s.stats().waiters).toBe(1)
    ac.abort()
    expect((await w).status).toBe(499)
    expect(s.stats().waiters).toBe(0)
    s.dispose()
  })

  it('too many held waits answer busy', async () => {
    const s = core.createSignSessions({ caps: { waiters: 1 }, log: () => {} })
    const a = s.start({ slot: 'scorer', context: ctx }, { owner: 'local' }).body
    const b = s.start({ slot: 'ref1', context: ctx }, { owner: 'local' }).body
    const held = s.wait({ watch: a.watch, known: 'pending' })
    const r = await s.wait({ watch: b.watch, known: 'pending' })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('OV_SIGN_BUSY')
    s.dispose()
    expect((await held).body.code).toBe('OV_SIGN_UNAVAILABLE')
  })

  it('creates no timer until the first start, and dispose leaves none (no vite build hang)', () => {
    const made = []
    const cleared = []
    const timers = {
      setTimeout: (fn, ms) => { const t = { kind: 'timeout', ms, unref() { this.unrefd = true } }; made.push(t); return t },
      clearTimeout: (t) => cleared.push(t),
      setInterval: (fn, ms) => { const t = { kind: 'interval', ms, unref() { this.unrefd = true } }; made.push(t); return t },
      clearInterval: (t) => cleared.push(t),
    }
    const s = core.createSignSessions({ timers, log: () => {} })
    expect(made).toHaveLength(0)
    expect(s.stats().sweeper).toBe(false)
    s.start({ slot: 'scorer', context: ctx }, { owner: 'local' })
    s.start({ slot: 'ref1', context: ctx }, { owner: 'local' })
    const intervals = made.filter((t) => t.kind === 'interval')
    expect(intervals).toHaveLength(1)
    expect(intervals[0].unrefd).toBe(true)
    expect(intervals[0].ms).toBe(core.SWEEP_MS)
    s.dispose()
    expect(cleared).toContain(intervals[0])
    expect(s.stats()).toEqual({ sessions: 0, tombstones: 0, waiters: 0, sweeper: false })
  })

  it('the sweeper forgets ended sessions and their tombstones', () => {
    let clock = 0
    const s = core.createSignSessions({ now: () => clock, log: () => {} })
    s.start({ slot: 'scorer', context: ctx }, { owner: 'local' })
    clock = 600000
    s.sweep()
    expect(s.stats()).toMatchObject({ sessions: 0, tombstones: 1 })
    clock = 660000
    s.sweep()
    expect(s.stats()).toMatchObject({ sessions: 0, tombstones: 0 })
    s.dispose()
  })

  it('cloud caps are the cloud ones', () => {
    const s = core.createSignSessions({ via: 'cloud', log: () => {} })
    expect(s.caps).toEqual(core.CLOUD_CAPS)
    expect(core.createSignSessions({ log: () => {} }).caps).toEqual(core.LAN_CAPS)
  })

  it('names the endpoints, their body caps and the page paths', () => {
    expect(core.signEndpointOf('/api/sign/start')).toBe('start')
    expect(core.signEndpointOf('/api/sign/start/x')).toBeNull()
    expect(core.signEndpointOf('/api/sign/delete')).toBeNull()
    expect(core.signBodyLimit('submit')).toBe(65536)
    expect(core.signBodyLimit('open')).toBe(4096)
    expect(core.isSignPagePath('/sign')).toBe(true)
    expect(core.isSignPagePath('/sign/sign.js')).toBe(true)
    expect(core.isSignPagePath('/signature')).toBe(false)
    expect(core.SIGN_PAGE_HEADERS['Content-Security-Policy']).toContain("script-src 'self'")
  })
})
