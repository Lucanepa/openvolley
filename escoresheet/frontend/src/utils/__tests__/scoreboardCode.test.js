/**
 * The scorer's scoreboard code (utils/scoreboardCode.js,
 * docs/scoreboard-code-spec.md): made on this device, kept per match, told to
 * the relay on the scorer socket (and again after each first sync), renewed,
 * revoked; the same code alphabet and bit packing as the relays' core.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { boardPageUrl, codeFromBytes, createScoreboardCodes, displayScoreboardCode, newScoreboardCode, CODE_ALPHABET, MAX_LIFE_MS } from '../scoreboardCode'

const require = createRequire(import.meta.url)
const core = require('../../../electron/displayCodeCore.cjs')
const vectors = require('../../../electron/__fixtures__/display-code-vectors.json')

function fakeTable() {
  const rows = new Map()
  return {
    rows,
    get: async (id) => rows.get(id),
    put: async (row) => { rows.set(row.matchId, { ...row }) },
    delete: async (id) => { rows.delete(id) },
    toArray: async () => [...rows.values()],
    where: (index) => ({ equals: (v) => ({ first: async () => [...rows.values()].find((r) => r[index] === v) }) })
  }
}
function fakeRelay({ open = true } = {}) {
  const listeners = new Set()
  return {
    url: 'wss://backend.openvolley.app',
    sent: [],
    open,
    isOpen() { return this.open },
    send(m) { if (!this.open) return false; this.sent.push(m); return true },
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(m) { for (const fn of listeners) fn(m, null) }
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
let n = 0
const seq = () => Uint8Array.from([n, n + 1, n + 2, n + 3, n++ + 4])

describe('scoreboard code', () => {
  it('packs the bytes as the relays do, in their alphabet', () => {
    expect(CODE_ALPHABET).toBe(core.CODE_ALPHABET)
    for (const v of vectors.fromBytes) expect(codeFromBytes(Uint8Array.from(v.in))).toBe(v.out)
    const code = newScoreboardCode()
    expect(core.normalizeCode(code)).toBe(code)
    expect(displayScoreboardCode('ABCD2345')).toBe('ABCD-2345')
    expect(MAX_LIFE_MS).toBe(core.MAX_LIFE_MS)
  })

  it('the board page: the cloud livescore site, or the hall relay\'s LAN address; the code in the fragment only', () => {
    expect(boardPageUrl('ABCD2345', { relayUrl: 'wss://backend.openvolley.app' })).toBe('https://livescore.openvolley.app/board#ABCD2345')
    expect(boardPageUrl('ABCD2345', { relayUrl: 'ws://192.168.1.20:8080', relayStatus: { urls: { livescoreIP: 'http://192.168.1.20:5173/livescore/' } } })).toBe('http://192.168.1.20:5173/livescore/board#ABCD2345')
    expect(boardPageUrl('ABCD2345', { relayUrl: 'ws://127.0.0.1:8080', relayStatus: { localIP: '10.0.0.5', port: 5173 } })).toBe('http://10.0.0.5:5173/livescore/board#ABCD2345')
    expect(boardPageUrl('ABCD2345', { relayUrl: 'ws://127.0.0.1:8080' })).toBeNull()
  })

  it('makes a code once per match, keeps it, and tells the relay', async () => {
    const table = fakeTable()
    const relay = fakeRelay()
    let now = 1000
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => now, random: seq })
    const s = await codes.ensure({ matchId: 7, relayKey: 'seed-7' })
    expect(s).toMatchObject({ relayKey: 'seed-7', issuedAt: 1000, endsAt: 1000 + MAX_LIFE_MS, relay: 'waiting' })
    expect(table.rows.get(7)).toEqual({ matchId: 7, relayKey: 'seed-7', code: s.code, issuedAt: 1000 })
    expect(relay.sent).toEqual([{ type: 'display-code-set', matchId: 'seed-7', code: s.code, issuedAt: 1000 }])
    relay.emit({ type: 'display-code-state', matchId: 'seed-7', active: true, endsAt: 1000 + MAX_LIFE_MS })
    expect(codes.get(7).relay).toBe('active')
    // opened again: the same code, nothing sent again
    now = 5000
    const again = await codes.ensure({ matchId: 7, relayKey: 'seed-7' })
    expect(again.code).toBe(s.code)
    expect(relay.sent).toHaveLength(1)
  })

  it('a stored code is told again after each first sync (display-presence), e.g. after an app restart', async () => {
    const table = fakeTable()
    await table.put({ matchId: 3, relayKey: 'seed-3', code: 'ABCD2345', issuedAt: 100 })
    const relay = fakeRelay()
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => 2000 })
    relay.emit({ type: 'display-presence', matchId: 'seed-3', present: true, settingsUrl: null })
    await flush()
    expect(relay.sent).toEqual([{ type: 'display-code-set', matchId: 'seed-3', code: 'ABCD2345', issuedAt: 100 }])
    expect(codes.get(3)).toMatchObject({ code: 'ABCD2345', following: true, relay: 'waiting' })
    // a room without a code: nothing
    relay.emit({ type: 'display-presence', matchId: 'other', present: false })
    await flush()
    expect(relay.sent).toHaveLength(1)
  })

  it('a code older than 12 hours is replaced, and one that has run out is never told', async () => {
    const table = fakeTable()
    await table.put({ matchId: 3, relayKey: 'seed-3', code: 'ABCD2345', issuedAt: 0 })
    const relay = fakeRelay()
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => MAX_LIFE_MS, random: seq })
    relay.emit({ type: 'display-presence', matchId: 'seed-3', present: false })
    await flush()
    expect(relay.sent).toEqual([])
    const s = await codes.ensure({ matchId: 3, relayKey: 'seed-3' })
    expect(s.code).not.toBe('ABCD2345')
    expect(s.issuedAt).toBe(MAX_LIFE_MS)
  })

  it('New code replaces it on the relay; Stop sharing revokes and forgets it', async () => {
    const table = fakeTable()
    const relay = fakeRelay()
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => 10, random: seq })
    const first = await codes.ensure({ matchId: 1, relayKey: 'k' })
    const second = await codes.renew({ matchId: 1, relayKey: 'k' })
    expect(second.code).not.toBe(first.code)
    expect(relay.sent.at(-1)).toEqual({ type: 'display-code-set', matchId: 'k', code: second.code, issuedAt: 10 })
    await codes.stop({ matchId: 1, relayKey: 'k' })
    expect(relay.sent.at(-1)).toEqual({ type: 'display-code-set', matchId: 'k', code: null })
    expect(table.rows.has(1)).toBe(false)
    expect(codes.get(1)).toBeNull()
  })

  it('answers from the relay: not the owner yet waits, taken makes a new code, expired asks for one', async () => {
    const table = fakeTable()
    const relay = fakeRelay()
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => 10, random: seq })
    const first = await codes.ensure({ matchId: 1, relayKey: 'k' })
    relay.emit({ type: 'display-code-state', matchId: 'k', active: false, reason: 'not-match-owner' })
    expect(codes.get(1).relay).toBe('waiting')
    relay.emit({ type: 'display-code-state', matchId: 'k', active: false, reason: 'taken' })
    await flush()
    await flush()
    expect(codes.get(1).code).not.toBe(first.code)
    relay.emit({ type: 'display-code-state', matchId: 'k', active: false, reason: 'expired' })
    expect(codes.get(1)).toMatchObject({ relay: 'refused', reason: 'expired' })
  })

  it('offline: the code is kept and shown as waiting for the connection', async () => {
    const table = fakeTable()
    const relay = fakeRelay({ open: false })
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => 10, random: seq })
    const s = await codes.ensure({ matchId: 1, relayKey: 'k' })
    expect(s.relay).toBe('offline')
    expect(relay.sent).toEqual([])
    expect(table.rows.get(1).code).toBe(s.code)
  })

  it('never logs the code', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => vi.spyOn(console, k))
    const table = fakeTable()
    const relay = fakeRelay()
    const codes = createScoreboardCodes({ relay, table: () => table, now: () => 10, random: seq })
    const s = await codes.ensure({ matchId: 1, relayKey: 'k' })
    await codes.renew({ matchId: 1, relayKey: 'k' })
    await codes.stop({ matchId: 1 })
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(s.code)
      spy.mockRestore()
    }
  })
})
