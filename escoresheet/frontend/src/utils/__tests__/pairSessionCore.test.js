// @vitest-environment node
/**
 * Pair a phone (electron/pairSessionCore.cjs, docs/phone-keyboard-spec.md):
 * the shared vectors (also run by the backend copy and pair.rs), the secrets
 * and the code, the logging rule, the long-polls on both sides, the 6 h life
 * and the timers' lifecycle.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const core = require('../../../electron/pairSessionCore.cjs')
const vectors = require('../../../electron/__fixtures__/pair-vectors.json')
const { runPairVectors } = require('../../../electron/__fixtures__/pairVectorRunner.cjs')

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const ctx = { home: 'A', away: 'B' }
const make = (o = {}) => core.createPairSessions({ sha256, log: () => {}, ...o })

afterEach(() => { vi.useRealTimers() })

describe('pairSessionCore', () => {
  it('agrees with every shared vector', async () => {
    expect(await runPairVectors(core, vectors, sha256)).toEqual([])
  })

  it('needs an injected SHA-256', () => {
    expect(() => core.createPairSessions({})).toThrow(/sha256/)
  })

  it('hands out three different 256-bit secrets and an 8-symbol code', () => {
    const s = make()
    const r = s.start({ context: ctx }, { owner: 'local' })
    expect(r.status).toBe(201)
    for (const k of ['token', 'watch']) expect(r.body[k]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.body.token).not.toBe(r.body.watch)
    expect(r.body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    const j = s.join({ k: r.body.token }, { ipKey: 'ip' })
    expect(j.body.phone).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set([r.body.token, r.body.watch, j.body.phone]).size).toBe(3)
    s.dispose()
  })

  it('the code uses all 40 bits of its 5 bytes', () => {
    expect(core.codeFromBytes([0, 0, 0, 0, 0])).toBe('AAAAAAAA')
    expect(core.codeFromBytes([255, 255, 255, 255, 255])).toBe('99999999')
    const seen = new Set()
    for (let i = 0; i < 200; i++) seen.add(core.codeFromBytes(randomBytes(5)))
    expect(seen.size).toBe(200)
  })

  it('logs one line per transition with the ref only: never a secret, the code, the context or any text', async () => {
    const lines = []
    const s = make({ log: (l) => lines.push(l) })
    const r = s.start({ context: { home: 'Secret Club', away: 'B' } }, { owner: 'local' })
    const { phone } = s.join({ code: r.body.code }, { ipKey: 'ip' }).body
    s.focus({ watch: r.body.watch, field: { id: 'f', label: 'Private label', text: 'Private text' } })
    s.input({ phone, n: 1, field: 'f', text: 'Typed words' }, { ipKey: 'ip' })
    s.close({ watch: r.body.watch })
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['pair.start', 'pair.join', 'pair.close'])
    for (const l of lines) {
      expect(l).toMatch(/^pair\.(start|join|close) ref=[0-9a-f]{8} via=lan$/)
      for (const secret of [r.body.token, r.body.watch, r.body.code, phone, 'Secret', 'Private', 'Typed']) expect(l).not.toContain(secret)
    }
    s.dispose()
  })

  it('a held device wait wakes on the join and on each input; a held phone poll wakes on a new focus', async () => {
    const s = make()
    const { body: { token, watch } } = s.start({ context: ctx }, { owner: 'local' })
    const w1 = s.wait({ watch, knownState: 'pending', after: 0, knownPhone: false })
    expect(s.stats().waiters).toBe(1)
    const { body: { phone } } = s.join({ k: token }, { ipKey: 'ip' })
    expect((await w1).body).toMatchObject({ state: 'paired', phone: { connected: true } })

    const p1 = s.poll({ phone, known: 0 }, { ipKey: 'ip' })
    s.focus({ watch, field: { id: 'ov-remarks', kind: 'multiline', text: 'Old' } })
    expect((await p1).body).toMatchObject({ v: 1, field: { id: 'ov-remarks', text: 'Old' } })

    const w2 = s.wait({ watch, knownState: 'paired', after: 0, knownPhone: true })
    s.input({ phone, n: 1, field: 'ov-remarks', text: 'Old and new' }, { ipKey: 'ip' })
    expect((await w2).body.inputs).toEqual([{ seq: 1, n: 1, field: 'ov-remarks', text: 'Old and new' }])
    s.dispose()
  })

  it('a newer wait answers the older one, unpairing answers both sides', async () => {
    const s = make()
    const { body: { token, watch } } = s.start({ context: ctx }, { owner: 'local' })
    const { body: { phone } } = s.join({ k: token }, { ipKey: 'ip' })
    const a = s.wait({ watch, knownState: 'paired', after: 0, knownPhone: true })
    const b = s.wait({ watch, knownState: 'paired', after: 0, knownPhone: true })
    expect((await a).body.state).toBe('paired')
    const p = s.poll({ phone, known: 0 }, { ipKey: 'ip' })
    s.close({ watch })
    expect((await b).body).toEqual({ ok: true, state: 'closed' })
    expect((await p).body).toEqual({ ok: true, state: 'closed' })
    expect(s.stats().waiters).toBe(0)
    s.dispose()
  })

  it('a pairing whose scoring device keeps calling lives 6 hours, then expires', () => {
    let clock = 0
    const s = make({ now: () => clock })
    const { body: { token, watch } } = s.start({ context: ctx }, { owner: 'local' })
    const { body: { phone } } = s.join({ k: token }, { ipKey: 'ip' })
    for (clock = 60000; clock < core.MAX_LIFE_MS; clock += 4 * 60000) {
      expect(s.focus({ watch, field: null }).status).toBe(200)
    }
    clock = core.MAX_LIFE_MS - 1
    expect(s.focus({ watch, field: null }).status).toBe(200)
    clock = core.MAX_LIFE_MS
    expect(s.focus({ watch, field: null }).body.code).toBe('OV_PAIR_EXPIRED')
    expect(s.input({ phone, n: 1, field: 'f', text: 'x' }, { ipKey: 'ip' }).body.code).toBe('OV_PAIR_EXPIRED')
    s.dispose()
  })

  it('a held device wait keeps the pairing alive past the idle limit', async () => {
    vi.useFakeTimers()
    let clock = 0
    const s = make({ now: () => clock })
    const { body: { watch } } = s.start({ context: ctx }, { owner: 'local' })
    for (let i = 0; i < 20; i++) {
      const w = s.wait({ watch, knownState: 'pending', after: 0, knownPhone: false })
      clock += 25000
      await vi.advanceTimersByTimeAsync(25000)
      expect((await w).body.state).toBe('pending')
    }
    // 500 s: past the 5-minute idle limit, within the 10-minute join time
    expect(s.stats().sessions).toBe(1)
    s.dispose()
  })

  it('an aborted wait is dropped, and the sweeper exists only after a start and stops on dispose', async () => {
    const s = make()
    expect(s.stats().sweeper).toBe(false)
    const { body: { watch } } = s.start({ context: ctx }, { owner: 'local' })
    expect(s.stats().sweeper).toBe(true)
    const ac = new AbortController()
    const w = s.wait({ watch, knownState: 'pending', after: 0, knownPhone: false }, { signal: ac.signal })
    ac.abort()
    expect((await w).status).toBe(499)
    expect(s.stats().waiters).toBe(0)
    s.dispose()
    expect(s.stats()).toEqual({ sessions: 0, tombstones: 0, waiters: 0, sweeper: false })
  })

  it('paths and body caps', () => {
    expect(core.pairEndpointOf('/api/pair/input')).toBe('input')
    expect(core.pairEndpointOf('/api/pair/other')).toBeNull()
    expect(core.pairEndpointOf('/api/sign/start')).toBeNull()
    expect(core.pairBodyLimit('input')).toBe(64 * 1024)
    expect(core.pairBodyLimit('focus')).toBe(64 * 1024)
    expect(core.pairBodyLimit('join')).toBe(4 * 1024)
    expect(core.isPairPagePath('/pair')).toBe(true)
    expect(core.isPairPagePath('/pair/pair.js')).toBe(true)
    expect(core.isPairPagePath('/pairing')).toBe(false)
    // 8000 code points of the widest UTF-8 fit the body cap
    expect(Buffer.byteLength(JSON.stringify({ phone: 'x'.repeat(43), n: 1, field: 'f', text: '\u{1F44D}'.repeat(8000) }))).toBeLessThan(core.TEXT_BODY_MAX)
  })
})
