// The interaction log on the real app database (Dexie 4 on fake-indexeddb):
// export by match, retention, and the debug logger folded into it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/db'
import {
  log, setGameContext, getLogsForMatch, pruneInteractionLogs, migrateDebugLogs, LEGACY_DEBUG_KEY,
  exportLogsAsNDJSON, trimDebugData
} from '../comprehensiveLogger'
import { debugLogger } from '../debugLogger'
import { diagnosticLogQuery } from '../activity/logQuery'

const row = (id, ts, extra = {}) => ({ id, ts, timestamp: new Date(ts).toISOString(), category: 'ui', type: 'click', component: 'X', action: 'a', payload: {}, target: null, gameNumber: null, matchId: null, sessionId: 's', ...extra })

describe('interaction log', () => {
  beforeEach(async () => {
    await db.open()
    await db.interaction_logs.clear()
    localStorage.removeItem(LEGACY_DEBUG_KEY)
  })

  it('finds the entries of a match by id, game number or the time it was open', async () => {
    const t0 = Date.parse('2026-10-07T10:00:00Z')
    await db.interaction_logs.bulkAdd([
      row('a', t0 + 1000, { matchId: 7, gameNumber: 12 }),
      row('b', t0 + 2000, { gameNumber: 12 }), // legacy: game number only
      row('c', t0 + 3000), // before the context was set
      row('d', t0 + 4000, { matchId: 8, gameNumber: 13 }), // another match, same time
      row('e', t0 - 3600_000), // long before
      row('f', t0 + 5000, { matchId: 7, target: { type: 'password' } }) // never exported
    ])
    const got = await getLogsForMatch({ matchId: 7, gameN: 12, from: new Date(t0).toISOString(), to: t0 + 10_000 })
    expect(got.map(e => e.id)).toEqual(['a', 'b', 'c'])
    const ndjson = await exportLogsAsNDJSON(diagnosticLogQuery(7, { gameNumber: 12, createdAt: new Date(t0).toISOString(), closedAt: t0 + 10_000 }))
    expect(ndjson.split('\n').map(l => JSON.parse(l).id)).toEqual(['a', 'b', 'c'])
  })

  it('an entry stored with a PIN in its clicked text (before 2.4.0) is exported without it', async () => {
    const t0 = Date.parse('2026-10-07T10:00:00Z')
    await db.interaction_logs.add(row('p', t0 + 1000, {
      matchId: 7,
      target: { tagName: 'div', textContent: 'Game PIN 771234', ariaLabel: null, href: 'https://openvolley.app/r?pin=482913' }
    }))
    const ndjson = await exportLogsAsNDJSON({ matchId: 7 })
    expect(ndjson).not.toContain('771234')
    expect(ndjson).not.toContain('482913')
    expect(JSON.parse(ndjson).target.textContent).toBe('Game PIN [digits]')
  })

  it('tags new entries with the open match', async () => {
    setGameContext(21, 99)
    const e = log('ui', 'click', 'Test', 'x')
    expect(e).toMatchObject({ gameNumber: 21, matchId: 99 })
    setGameContext(null, null)
  })

  it('prunes rows older than 30 days, then the oldest beyond the cap', async () => {
    const now = Date.parse('2026-10-07T10:00:00Z')
    await db.interaction_logs.bulkAdd([
      row('old', now - 31 * 24 * 3600_000),
      row('r1', now - 3000), row('r2', now - 2000), row('r3', now - 1000)
    ])
    const removed = await pruneInteractionLogs({ now, maxRows: 2 })
    expect(removed).toBe(2)
    expect((await db.interaction_logs.orderBy('ts').toArray()).map(r => r.id)).toEqual(['r2', 'r3'])
  })

  it('moves the old localStorage debug log into the table once', async () => {
    localStorage.setItem(LEGACY_DEBUG_KEY, JSON.stringify([
      { id: '1', timestamp: '2026-10-01T10:00:00.000Z', action: 'POINT_AWARDED', data: { team: 'home' } },
      { id: '2', timestamp: '2026-10-01T10:00:01.000Z', action: 'UNDO_SELECTED', data: { stateSnapshot: 'x'.repeat(30000) } }
    ]))
    expect(await migrateDebugLogs()).toBe(2)
    expect(localStorage.getItem(LEGACY_DEBUG_KEY)).toBeNull()
    const rows = await db.interaction_logs.where('category').equals('debug').toArray()
    expect(rows.map(r => r.type).sort()).toEqual(['POINT_AWARDED', 'UNDO_SELECTED'])
    expect(rows.find(r => r.type === 'UNDO_SELECTED').payload).toEqual({ stateSnapshotDropped: true })
    expect(await migrateDebugLogs()).toBe(0)
  })

  it('debugLogger writes into the interaction log, never localStorage', () => {
    const e = debugLogger.log('EVENT_CREATED', { type: 'point', stateSnapshot: { big: 'y'.repeat(25000) } })
    expect(e).toBeUndefined()
    expect(localStorage.getItem(LEGACY_DEBUG_KEY)).toBeNull()
    expect(debugLogger.getLogs().at(-1)).toMatchObject({ action: 'EVENT_CREATED', data: { type: 'point', stateSnapshotDropped: true } })
    expect(trimDebugData({ stateSnapshot: { small: 1 } })).toEqual({ stateSnapshot: { small: 1 } })
  })
})
