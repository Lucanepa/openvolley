// Diagnostics mode: the switch, redaction, jump detection, the reload-reason
// wrapper, the recorder's line format and the sinks' caps.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { diagnosticsSwitch, setDiagnosticsOption, diagnosticsOptionOn, DIAG_STORAGE_KEY, DIAG_SESSION_KEY } from '../switch'
import { sanitizeDiagData, redactDiagText } from '../redact'
import { createJumpDetector } from '../jumps'
import { reloadWithReason, takeReloadReason, RELOAD_REASON_KEY } from '../reload'
import { diag, noteAction, startRecorder, stopRecorder, flushDiagnostics, stashAndFlush, takePending, diagActive, PENDING_KEY } from '../recorder'
import { ringSink, tauriSink } from '../sinks'
import { countCommit, flushCommitCounts } from '../commits'

function memoryStorage() {
  let store = {}
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { store = {} }
  }
}
const winAt = (href, extra = {}) => ({ location: { href }, ...extra })
const memorySink = () => {
  const lines = []
  return { lines, write: vi.fn(async (batch) => { lines.push(...batch) }) }
}
const parsed = (sink) => sink.lines.map(l => JSON.parse(l))

describe('diagnostics switch', () => {
  let local, session
  beforeEach(() => { local = memoryStorage(); session = memoryStorage() })

  it('is off by default', () => {
    expect(diagnosticsSwitch({ win: winAt('http://localhost:5173/'), local, session })).toEqual({ on: false, source: null })
  })

  it('follows the Options switch, persisted on this device', () => {
    setDiagnosticsOption(true, local)
    expect(local.getItem(DIAG_STORAGE_KEY)).toBe('1')
    expect(diagnosticsOptionOn(local)).toBe(true)
    expect(diagnosticsSwitch({ win: winAt('http://localhost:5173/'), local, session })).toEqual({ on: true, source: 'options' })
    setDiagnosticsOption(false, local)
    expect(local.getItem(DIAG_STORAGE_KEY)).toBe(null)
    expect(diagnosticsSwitch({ win: winAt('http://localhost:5173/'), local, session }).on).toBe(false)
  })

  it('is on with the desktop app\'s OPENVOLLEY_DIAGNOSTICS=1 (window.__OV_DIAGNOSTICS__)', () => {
    expect(diagnosticsSwitch({ win: winAt('http://localhost:5173/', { __OV_DIAGNOSTICS__: 'env' }), local, session })).toEqual({ on: true, source: 'env' })
  })

  it('?diag=1 switches this tab on until ?diag=0, which wins over everything', () => {
    expect(diagnosticsSwitch({ win: winAt('http://x/?match=3&diag=1'), local, session })).toEqual({ on: true, source: 'url' })
    expect(session.getItem(DIAG_SESSION_KEY)).toBe('1')
    // a reload without the parameter (this tab)
    expect(diagnosticsSwitch({ win: winAt('http://x/'), local, session })).toEqual({ on: true, source: 'url' })
    setDiagnosticsOption(true, local)
    const off = diagnosticsSwitch({ win: winAt('http://x/?diag=0', { __OV_DIAGNOSTICS__: 'env' }), local, session })
    expect(off).toEqual({ on: false, source: 'url' })
    expect(session.getItem(DIAG_SESSION_KEY)).toBe(null)
  })

  it('never throws on blocked storage', () => {
    const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    expect(diagnosticsSwitch({ win: winAt('http://x/?diag=1'), local: blocked, session: blocked })).toEqual({ on: true, source: 'url' })
    expect(() => setDiagnosticsOption(true, blocked)).not.toThrow()
  })
})

describe('diagnostics redaction', () => {
  it('drops secret keys at any depth', () => {
    const out = sanitizeDiagData({ key: 'point', gamePin: '123456', nested: { password: 'x', access_token: 'y', signature: 'z', ok: 1 }, list: [{ pin: '1' }, { w: 2 }] })
    expect(out).toEqual({ key: 'point', nested: { ok: 1 }, list: [{}, { w: 2 }] })
  })

  it('redacts PINs and long numbers in text, grouped ones too', () => {
    expect(redactDiagText('PIN 771234')).not.toMatch(/771234/)
    expect(redactDiagText('Code: 4821')).not.toMatch(/4821/)
    expect(redactDiagText('connect with 771 234')).not.toMatch(/771 ?234/)
    expect(redactDiagText('Time-out 2 of 2')).toBe('Time-out 2 of 2')
  })

  it('strips URL queries, data URLs and JWTs, and caps strings', () => {
    expect(redactDiagText('http://192.168.1.20:5173/referee/?match=7&pin=123456')).toBe('http://192.168.1.20:5173/referee/')
    expect(redactDiagText('/bench/?pin=1234#x')).toBe('/bench/')
    expect(redactDiagText('data:image/png;base64,AAAA')).toBe('[redacted]')
    // a JWT-shaped string, built here so no token sits in the source
    expect(redactDiagText(['header0123456', 'payload0123456', 'signature0123'].join('.'))).toBe('[redacted]')
    expect(redactDiagText('x'.repeat(500))).toHaveLength(120)
  })

  it('keeps numbers, booleans and null; drops functions and deep nesting', () => {
    expect(sanitizeDiagData({ w: 1400.5, on: false, n: null, nan: NaN, fn: () => 1, deep: { a: { b: { c: { d: 1 } } } } }))
      .toEqual({ w: 1400.5, on: false, n: null, nan: null, deep: { a: { b: {} } } })
  })
})

describe('diagnostics jump detection', () => {
  it('flags a size that changes and comes back within 500 ms', () => {
    const j = createJumpDetector()
    expect(j.observe('court', 800, 400, 0)).toBe(null)
    expect(j.observe('court', 820, 410, 1000)).toBe(null)
    const jump = j.observe('court', 800, 400, 1180)
    expect(jump).toEqual({ key: 'court', size: [800, 400], via: [[820, 410]], ms: 180 })
  })

  it('sees a jump through several sizes and ignores sub-pixel noise', () => {
    const j = createJumpDetector()
    j.observe('rally', 300, 100, 0)
    expect(j.observe('rally', 300.3, 100.2, 10)).toBe(null)
    j.observe('rally', 310, 104, 100)
    j.observe('rally', 320, 108, 150)
    expect(j.observe('rally', 300.2, 100, 400)).toEqual({ key: 'rally', size: [300.2, 100], via: [[310, 104], [320, 108]], ms: 300 })
  })

  it('does not flag a size that comes back later than the window, or a steady resize', () => {
    const j = createJumpDetector({ windowMs: 500 })
    j.observe('scoreboard', 1000, 600, 0)
    j.observe('scoreboard', 1100, 600, 100)
    expect(j.observe('scoreboard', 1000, 600, 700)).toBe(null)
    const k = createJumpDetector()
    for (let i = 0; i < 20; i++) expect(k.observe('root', 1000 + i * 10, 700, i * 16)).toBe(null)
  })

  it('keeps boxes apart', () => {
    const j = createJumpDetector()
    j.observe('a', 10, 10, 0)
    j.observe('b', 20, 20, 0)
    j.observe('a', 11, 10, 50)
    expect(j.observe('b', 10, 10, 60)).toBe(null)
    expect(j.observe('a', 10, 10, 70)?.key).toBe('a')
  })
})

describe('diagnostics recorder', () => {
  afterEach(async () => { await stopRecorder() })

  it('records nothing while off', async () => {
    expect(diagActive()).toBe(false)
    diag('geo.box', { w: 1 })
    expect(noteAction('ui.click', {})).toBe(0)
    await flushDiagnostics()
  })

  it('writes one redacted JSON line per call with time, session, sequence and action', async () => {
    const sink = memorySink()
    let wall = Date.parse('2026-10-08T12:00:00.000Z')
    let mono = 100
    startRecorder({ sink, sessionId: 'abc123', now: () => wall, perf: () => mono, storage: memoryStorage() })
    diag('page.load', { nav: 'reload' })
    mono = 250.06
    wall += 150
    expect(noteAction('ui.click', { id: 'point-left', pin: '123456' })).toBe(1)
    diag('geo.jump', { el: 'court#3', ms: 120 })
    await flushDiagnostics()
    const lines = parsed(sink)
    expect(lines).toEqual([
      { ts: '2026-10-08T12:00:00.000Z', m: 100, sid: 'abc123', seq: 1, src: 'page', k: 'page.load', a: 0, d: { nav: 'reload' } },
      { ts: '2026-10-08T12:00:00.150Z', m: 250.1, sid: 'abc123', seq: 2, src: 'page', k: 'ui.click', a: 1, d: { id: 'point-left' } },
      { ts: '2026-10-08T12:00:00.150Z', m: 250.1, sid: 'abc123', seq: 3, src: 'page', k: 'geo.jump', a: 1, d: { el: 'court#3', ms: 120 } }
    ])
  })

  it('keeps unwritten lines for the next load of the tab on pagehide', async () => {
    const storage = memoryStorage()
    // the page is gone before the write lands
    const gone = { write: () => Promise.reject(new Error('page gone')) }
    startRecorder({ sink: gone, sessionId: 's1', storage })
    diag('page.hide', { persisted: false })
    stashAndFlush()
    const stashed = JSON.parse(storage.getItem(PENDING_KEY))
    expect(stashed).toHaveLength(1)
    expect(JSON.parse(stashed[0]).k).toBe('page.hide')
    // the next load writes them first
    const sink = memorySink()
    startRecorder({ sink, sessionId: 's2', storage })
    await new Promise(r => setTimeout(r, 0))
    expect(parsed(sink).map(l => [l.sid, l.k])).toEqual([['s1', 'page.hide']])
    expect(takePending(storage)).toEqual([])
  })

  it('counts React commits per user action', async () => {
    const sink = memorySink()
    startRecorder({ sink, sessionId: 'c', storage: memoryStorage() })
    noteAction('ui.click', { id: 'point-left' })
    countCommit('scoreboard', 4)
    countCommit('scoreboard', 6)
    noteAction('ui.click', { id: 'point-right' })
    countCommit('scoreboard', 3)
    flushCommitCounts()
    await flushDiagnostics()
    const commits = parsed(sink).filter(l => l.k === 'react.commits').map(l => l.d)
    expect(commits).toEqual([
      { id: 'scoreboard', a: 1, commits: 2, ms: 10, maxMs: 6 },
      { id: 'scoreboard', a: 2, commits: 1, ms: 3, maxMs: 3 }
    ])
  })
})

describe('diagnostics reload wrapper', () => {
  afterEach(async () => { await stopRecorder() })
  const fakeWin = () => ({ location: { reload: vi.fn(), replace: vi.fn(), assign: vi.fn(), href: 'http://x/' } })

  it('only reloads while diagnostics is off', () => {
    const win = fakeWin()
    const storage = memoryStorage()
    reloadWithReason('sw-update', { how: 'replace', url: 'http://x/?cache_bust=1', win, storage })
    expect(win.location.replace).toHaveBeenCalledWith('http://x/?cache_bust=1')
    expect(storage.getItem(RELOAD_REASON_KEY)).toBe(null)
  })

  it('logs the reason, keeps it for the next load, then reloads', async () => {
    const sink = memorySink()
    const storage = memoryStorage()
    startRecorder({ sink, sessionId: 'r', storage })
    const win = fakeWin()
    reloadWithReason('clear-cache', { how: 'replace', url: 'http://x/?match=1&pin=123456', win, storage })
    expect(win.location.replace).toHaveBeenCalledWith('http://x/?match=1&pin=123456')
    reloadWithReason('backup-restored', { win, storage })
    expect(win.location.reload).toHaveBeenCalledTimes(1)
    reloadWithReason('open-view', { how: 'assign', url: '/referee/', win, storage })
    expect(win.location.assign).toHaveBeenCalledWith('/referee/')
    reloadWithReason('back', { how: 'href', url: '/scoresheet/', win, storage })
    expect(win.location.href).toBe('/scoresheet/')
    await flushDiagnostics()
    const lines = parsed(sink).filter(l => l.k === 'page.reload_request')
    expect(lines.map(l => l.d)).toEqual([
      { reason: 'clear-cache', how: 'replace', url: 'http://x/' },
      { reason: 'backup-restored', how: 'reload', url: null },
      { reason: 'open-view', how: 'assign', url: '/referee/' },
      { reason: 'back', how: 'href', url: '/scoresheet/' }
    ])
    const prev = takeReloadReason(storage, Date.now() + 40)
    expect(prev.reason).toBe('back')
    expect(prev.how).toBe('href')
    expect(prev.agoMs).toBeGreaterThanOrEqual(0)
    expect(takeReloadReason(storage)).toBe(null)
  })
})

describe('diagnostics sinks', () => {
  it('the ring buffer keeps the newest lines up to its cap and exports them in order', async () => {
    let t = 1000
    const ring = ringSink({ name: `ov-diag-ring-${Math.random()}`, maxRows: 5, now: () => t })
    for (let i = 1; i <= 8; i++) await ring.write([`{"n":${i}}`])
    await ring.prune()
    expect(await ring.count()).toBe(5)
    expect(await ring.exportText()).toBe(['{"n":4}', '{"n":5}', '{"n":6}', '{"n":7}', '{"n":8}'].join('\n') + '\n')
    // older than the age limit: gone
    t += 8 * 24 * 3600 * 1000
    await ring.write(['{"n":9}'])
    await ring.prune()
    expect(await ring.exportText()).toBe('{"n":9}\n')
    await ring.clear()
    expect(await ring.exportText()).toBe('')
    ring.db.close()
  })

  it('the desktop sink appends through diagnostics_append in chunks of 500', async () => {
    const invoke = vi.fn(async () => 1)
    const sink = tauriSink(invoke)
    const lines = Array.from({ length: 1201 }, (_, i) => `{"n":${i}}`)
    await sink.write(lines)
    expect(invoke.mock.calls.map(([cmd, args]) => [cmd, args.lines.length])).toEqual([
      ['diagnostics_append', 500], ['diagnostics_append', 500], ['diagnostics_append', 201]
    ])
    await sink.setNative(true)
    expect(invoke).toHaveBeenLastCalledWith('diagnostics_native', { on: true })
  })
})
