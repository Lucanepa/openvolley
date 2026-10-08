// The live state during the break between two sets. set_interval_active was
// true on the set end's own push and on the set 5 setup's pushes
// (duringInterval) only: any other push in the break (a line-up entered for
// the next set, a sanction, an undo) said the break was over, and the
// livescore left its break view (found while porting an OpenBeach check,
// 2026-10-09). Every push while the scorer's interval runs now keeps it,
// with the set end's start time.
// The real scoring screen over the app's Dexie database (fake IndexedDB), its
// cloud live-state writes recorded.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

const upserts = vi.hoisted(() => [])
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
        if (key === 'upsert') return (row) => { upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let saved
beforeAll(() => {
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  upserts.length = 0
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const countdownText = () => [...document.querySelectorAll('div, span')]
  .find(e => e.children.length === 0 && /^\d+:\d\d$/.test(e.textContent.trim()))?.textContent.trim() ?? null
const liveStates = (type) => upserts.filter(u => u.table === 'match_live_state' && u.row.last_event_type === type).map(u => u.row)

describe('Scoreboard: the live state keeps the break between sets', () => {
  it('a line-up entered for set 2 during the interval: its push keeps the break, from set 1\'s end', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
    ]))
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      seed_key: 'match_break_live_state', externalId: '11111111-2222-4333-8444-555555555558',
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false
    })
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    // set 1 ended 30 s ago (its set_end confirmed then): the interval runs
    const end1 = new Date(Date.now() - 30000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: end1 })
    await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
    await db.events.add({ matchId, setIndex: 1, type: 'set_end', payload: { setIndex: 1, winner: 'home' }, seq: 2, ts: end1 })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(countdownText()).toBeTruthy(), { timeout: 10000 })
    await settle()

    // team A's line-up for set 2, entered during the interval
    const open = () => [...document.querySelectorAll('button')].find(b => /^LineupA/.test(b.textContent.trim()))
    await waitFor(() => expect(open()).toBeTruthy(), { timeout: 10000 })
    fireEvent.click(open())
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeTruthy())
    const dialog = () => document.querySelector('[role=dialog]')
    const chip = (text) => [...dialog().querySelectorAll('*')].filter(e => e.textContent.replace(/\s+/g, '') === text).pop()
    for (const n of ['C1', '2', '3', '4', '5', '6']) { fireEvent.click(chip(n)); await new Promise(r => setTimeout(r, 30)) }
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'lineup' }).count()).toBe(1))

    await waitFor(() => expect(liveStates('lineup').length).toBeGreaterThan(0), { timeout: 10000 })
    const state = liveStates('lineup').at(-1)
    expect(state).toMatchObject({ set_interval_active: true, match_status: 'interval', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, sets_won_b: 0 })
    expect(Math.abs(Date.parse(state.set_interval_started_at) - Date.parse(end1))).toBeLessThan(2000)
    // the scorer's own interval runs on
    expect(countdownText()).toBeTruthy()
    cleanup()
  }, 60000)
})
