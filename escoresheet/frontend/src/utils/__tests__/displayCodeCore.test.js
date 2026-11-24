// @vitest-environment node
/**
 * Scoreboard codes (electron/displayCodeCore.cjs, docs/scoreboard-code-spec.md):
 * the shared vectors (also run by the backend copy and display_code.rs), the
 * hash-only table, the logging rule, the end callbacks and the sweeper.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const core = require('../../../electron/displayCodeCore.cjs')
const vectors = require('../../../electron/__fixtures__/display-code-vectors.json')
const { runDisplayCodeVectors } = require('../../../electron/__fixtures__/displayCodeVectorRunner.cjs')

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')

describe('displayCodeCore', () => {
  it('agrees with every shared vector', () => {
    expect(runDisplayCodeVectors(core, vectors, sha256)).toEqual([])
  })

  it('needs an injected SHA-256', () => {
    expect(() => core.createDisplayCodes({})).toThrow(/sha256/)
  })

  it('keeps no code: not in its log lines, its stats or its answers', () => {
    const lines = []
    const codes = core.createDisplayCodes({ sha256, log: (l) => lines.push(l), timers: { setInterval: () => null, clearInterval: () => {} } })
    codes.set({ room: 'room-secret-key', code: 'ABCD2345', owner: 'o' })
    codes.resolve('abcd-2345', { ipKey: 'a' })
    const http = codes.http('lookup', { contentType: 'application/json', text: '{"code":"ABCD2345"}', ipKey: 'a' })
    codes.set({ room: 'room-secret-key', code: 'WXYZ6789', owner: 'o' })
    codes.revoke('room-secret-key')
    expect(lines).toEqual([
      expect.stringMatching(/^display\.set ref=[0-9a-f]{8} via=lan$/),
      expect.stringMatching(/^display\.replace ref=[0-9a-f]{8} via=lan$/),
      expect.stringMatching(/^display\.set ref=[0-9a-f]{8} via=lan$/),
      expect.stringMatching(/^display\.revoke ref=[0-9a-f]{8} via=lan$/)
    ])
    const all = JSON.stringify([lines, codes.stats(), http])
    for (const secret of ['ABCD2345', 'ABCD-2345', 'WXYZ6789', 'room-secret-key'.replace('room-', 'x')]) expect(all).not.toContain(secret)
    expect(lines.join(' ')).not.toContain('room-secret-key')
  })

  it('starts one unref\'d sweeper with the first code and clears it on dispose', () => {
    const started = []
    const cleared = []
    const timers = { setInterval: (fn, ms) => { const t = { fn, ms, unref () { this.unrefd = true } }; started.push(t); return t }, clearInterval: (t) => cleared.push(t) }
    const codes = core.createDisplayCodes({ sha256, log: () => {}, timers })
    expect(started).toHaveLength(0)
    codes.set({ room: 'r1', code: 'ABCD2345' })
    codes.set({ room: 'r2', code: 'WXYZ6789' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ ms: core.SWEEP_MS, unrefd: true })
    codes.dispose()
    expect(cleared).toEqual([started[0]])
    expect(codes.stats()).toEqual({ codes: 0, tombstones: 0, sweeper: false })
  })

  it('a throwing onEnd or log never breaks the table', () => {
    const codes = core.createDisplayCodes({ sha256, log: () => { throw new Error('log') }, onEnd: () => { throw new Error('end') }, timers: { setInterval: () => null, clearInterval: () => {} } })
    expect(codes.set({ room: 'r1', code: 'ABCD2345' }).ok).toBe(true)
    expect(codes.revoke('r1')).toBe(true)
    expect(codes.resolve('ABCD2345').reason).toBe('ended')
  })

  it('a summary that throws answers the live endpoint with an empty match', () => {
    const codes = core.createDisplayCodes({ sha256, log: () => {}, timers: { setInterval: () => null, clearInterval: () => {} } })
    codes.set({ room: 'r1', code: 'ABCD2345' })
    const r = codes.http('live', { contentType: 'application/json', text: '{"code":"ABCD2345"}', summaryOf: () => { throw new Error('x') } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, matchId: 'r1', match: null, liveState: null })
  })

  it('the private columns are the backend\'s (publicColumns LIVE_STATE_PRIVATE_COLUMNS)', async () => {
    const { LIVE_STATE_PRIVATE_COLUMNS } = await import('../../../../backend/lib/publicColumns.js')
    expect([...core.LIVE_STATE_PRIVATE_COLUMNS].sort()).toEqual([...LIVE_STATE_PRIVATE_COLUMNS].sort())
  })
})
