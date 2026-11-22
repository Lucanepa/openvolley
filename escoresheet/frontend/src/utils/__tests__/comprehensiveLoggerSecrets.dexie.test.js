// The entries of a password or PIN field in the interaction log (performance
// pass, 22.11), on the app's real database (Dexie 4 on fake-indexeddb):
// - they never go into IndexedDB (before, they were stored and then purged
//   at the next start by a walk over the whole table, up to 50,000 rows,
//   which the first scorer actions after a start waited for);
// - the support timeline still says the field was used, before and after a
//   flush, as when they were stored;
// - the purge of what an older version stored runs once per app version
//   (at every start when the storage is blocked).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const TZ = 'Europe/Zurich'
const field = (extra = {}) => ({ tagName: 'input', id: null, className: 'w-full', name: null, type: 'text', role: null, ariaLabel: null, textContent: null, href: null, path: 'form > input.w-full', dataAttributes: {}, ...extra })
const button = (text) => ({ tagName: 'button', id: null, className: 'inline-flex', name: null, type: 'button', role: null, ariaLabel: null, textContent: text, href: null, path: 'div > button.inline-flex', dataAttributes: {} })
const PIN = field({ type: 'password', ariaLabel: 'Approval PIN' })
const storedRow = (id, ts, target) => ({ id, ts, timestamp: new Date(ts).toISOString(), category: 'ui', type: 'keydown', component: 'X', action: 'keydown', payload: { key: '[REDACTED]' }, target, gameNumber: null, matchId: null, sessionId: 'old' })

// A fresh logger (its state is module-level) on the same database
let logger = null
async function freshLogger() {
  if (logger) logger.shutdownLogger()
  vi.resetModules()
  const { db } = await import('../../db/db')
  await db.open()
  logger = await import('../comprehensiveLogger')
  const report = await import('../diagnosticsReport')
  return { db, logger, report }
}
const settle = () => new Promise(r => setTimeout(r, 50))
// The start's purge (and the flag it writes) runs after init: done before a
// test goes on, so it never lands in the next test
async function started(l) {
  await vi.waitFor(() => expect(localStorage.getItem(l.SECRETS_PURGED_KEY)).toBe('0.0.0-test'))
  await settle()
}
// The test setup's localStorage is a plain object: its keys through key(i)
const storageKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))

beforeEach(async () => {
  localStorage.clear()
  const { db } = await import('../../db/db')
  await db.open()
  await db.interaction_logs.clear()
})
afterEach(async () => {
  logger?.shutdownLogger()
  logger = null
  vi.restoreAllMocks()
  vi.useRealTimers()
  await settle()
})

describe('a password or PIN field in the interaction log', () => {
  async function session() {
    const env = await freshLogger()
    const { logger: l } = env
    vi.useFakeTimers({ toFake: ['Date'] })
    let at = Date.parse('2026-11-22T19:30:00Z')
    const step = (ms) => vi.setSystemTime(at += ms)
    step(0)
    l.initComprehensiveLogger(null, null)
    await started(l)
    step(900)
    l.logUI('click', 'MatchEnd', 'click', { button: 0, clientX: 10, clientY: 20 }, button('Approve'))
    step(1500)
    l.logUI('click', 'MatchEnd', 'click', { button: 0, clientX: 10, clientY: 60 }, PIN)
    for (let i = 0; i < 6; i++) {
      step(180)
      l.logUI('keydown', 'MatchEnd', 'keydown', { key: '[REDACTED]', code: '[REDACTED]' }, PIN)
      l.logUI('input', 'MatchEnd', 'input', { inputType: 'insertText', value: '[REDACTED]', valueLength: null }, PIN)
    }
    step(1200)
    l.logUI('click', 'MatchEnd', 'click', { button: 0, clientX: 10, clientY: 90 }, button('Confirm'))
    const now = at + 1000
    const lines = async () => env.report.buildTimeline({ interaction: await l.getRecentLogs({ from: now - 60000, to: now }), now, timeZone: TZ }).lines
    return { ...env, lines }
  }

  it('the support timeline says the same before and after the log is flushed', async () => {
    const { db, logger: l, lines } = await session()
    const before = await lines()
    expect(before.join('\n')).toContain('typed into a password or PIN field: not recorded')
    l.shutdownLogger() // flushes the buffer into IndexedDB
    await vi.waitFor(async () => expect(await db.interaction_logs.count()).toBeGreaterThan(0))
    await settle()
    expect(await lines()).toEqual(before)
  })

  it('is never stored in IndexedDB, nor in the emergency copy of a page closing', async () => {
    const { db, logger: l } = await session()
    window.dispatchEvent(new Event('beforeunload'))
    const emergency = storageKeys().filter(k => k.startsWith('comprehensive_logs_emergency_'))
    expect(emergency).toHaveLength(1)
    const copy = JSON.parse(localStorage.getItem(emergency[0]))
    expect(copy.some(e => e.type === 'click')).toBe(true)
    expect(copy.filter(l.isSecretEntry)).toEqual([])

    l.shutdownLogger()
    await vi.waitFor(async () => expect(await db.interaction_logs.count()).toBeGreaterThan(0))
    await settle()
    const rows = await db.interaction_logs.toArray()
    expect(rows.filter(r => r.type === 'click')).toHaveLength(2) // Approve, Confirm
    expect(rows.filter(l.isSecretEntry)).toEqual([])
    // and no export has them (as before)
    expect((await l.getLogsForMatch({ from: 0, to: Date.now() + 1000 })).filter(e => e.target?.type === 'password')).toEqual([])
  })
})

describe('the purge of entries an older version stored', () => {
  const ts = Date.parse('2026-11-20T18:00:00Z')

  it('runs at the first start of a version, not at the next ones', async () => {
    const { db } = await freshLogger()
    await db.interaction_logs.bulkAdd([storedRow('old-pin', ts, PIN), storedRow('old-tap', ts + 1, button('OK'))])
    logger.initComprehensiveLogger(null, null)
    await started(logger)
    expect(await db.interaction_logs.get('old-pin')).toBeUndefined()
    expect(await db.interaction_logs.get('old-tap')).toBeTruthy()

    // the next start of the same version: no walk over the table
    await db.interaction_logs.add(storedRow('planted', ts + 2, PIN))
    const walk = vi.spyOn(db.interaction_logs, 'filter')
    const next = await freshLogger()
    const walkAgain = vi.spyOn(next.db.interaction_logs, 'filter')
    logger.initComprehensiveLogger(null, null)
    await settle()
    await settle()
    expect(walk).not.toHaveBeenCalled()
    expect(walkAgain).not.toHaveBeenCalled()
    expect(await next.db.interaction_logs.get('planted')).toBeTruthy()

    // another version: once more
    localStorage.setItem(logger.SECRETS_PURGED_KEY, '26.11.4')
    const upgraded = await freshLogger()
    logger.initComprehensiveLogger(null, null)
    await started(logger)
    expect(await upgraded.db.interaction_logs.get('planted')).toBeUndefined()
  })

  it('storage blocked: at every start, as before', async () => {
    const { db } = await freshLogger()
    await db.interaction_logs.add(storedRow('old-pin', ts, PIN))
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked (test)') })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked (test)') })
    logger.initComprehensiveLogger(null, null)
    await vi.waitFor(async () => expect(await db.interaction_logs.get('old-pin')).toBeUndefined())

    await db.interaction_logs.add(storedRow('again', ts + 1, PIN))
    const next = await freshLogger()
    logger.initComprehensiveLogger(null, null)
    await vi.waitFor(async () => expect(await next.db.interaction_logs.get('again')).toBeUndefined())
    await settle()
  })
})
