// Undoing the set 5 setup's confirmation (its set5_coin_toss event). Found
// by a check (2026-10-09): the undo took the event back but the setup panel
// stayed hidden until a reload (set5SetupConfirmed was only reset at the
// previous set's end), the interval countdown the confirmation had ended
// stayed ended, and the tablets kept "interval over". Now the panel comes
// back, the countdown runs on from the set end's time, and the undo's live
// state keeps the interval for the referee and the livescore.
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
// the interval countdown ("2:29"): a leaf element with only the time
const countdownText = () => [...document.querySelectorAll('div, span')]
  .find(e => e.children.length === 0 && /^\d+:\d\d$/.test(e.textContent.trim()))?.textContent.trim() ?? null
const seconds = (mmss) => { const [m, s] = mmss.split(':').map(Number); return m * 60 + s }
const liveStates = (type) => upserts.filter(u => u.table === 'match_live_state' && u.row.last_event_type === type).map(u => u.row)

describe('Scoreboard: undoing the set 5 setup confirmation', () => {
  it('the setup panel comes back, the countdown runs on from the set end, the live state keeps the interval', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const players = []
    for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
    await db.players.bulkAdd(players)
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      seed_key: 'match_set5_setup_undo', externalId: '11111111-2222-4333-8444-555555555555',
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
      set5FirstServe: 'A', set5LeftTeam: 'A'
    })
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    // set 4 ended 30 s ago (its set_end confirmed then): the interval runs
    const end4 = new Date(Date.now() - 30000).toISOString()
    for (const index of [1, 2, 3, 4]) {
      const homeWins = index % 2 === 1
      await db.sets.add({ matchId, index, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: index === 4 ? end4 : t })
    }
    await db.sets.add({ matchId, index: 5, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
    await db.events.add({ matchId, setIndex: 4, type: 'set_end', payload: { setIndex: 4, winner: 'away' }, seq: 2, ts: end4 })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(countdownText()).toBeTruthy())
    await settle()

    fireEvent.click(button('Confirm set 5 setup'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'set5_coin_toss' }).count()).toBe(1))
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeFalsy())
    await waitFor(() => expect(countdownText()).toBeNull())
    await settle()

    fireEvent.click(button('Undo'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'set5_coin_toss' }).count()).toBe(0))

    // the setup panel is back without a reload
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeTruthy(), { timeout: 5000 })
    // the countdown runs on from set 4's end (3:00 less the ~30 s gone)
    await waitFor(() => expect(countdownText()).toBeTruthy(), { timeout: 5000 })
    const left = seconds(countdownText())
    expect(left).toBeGreaterThan(120)
    expect(left).toBeLessThanOrEqual(150)

    // the referee and the livescore: the undo's live state keeps the interval,
    // started at set 4's end
    await waitFor(() => expect(liveStates('undo').length).toBeGreaterThan(0), { timeout: 10000 })
    const state = liveStates('undo').at(-1)
    expect(state.set_interval_active).toBe(true)
    expect(state.match_status).toBe('interval')
    expect(Math.abs(Date.parse(state.set_interval_started_at) - Date.parse(end4))).toBeLessThan(2000)
    expect(state.current_set).toBe(5)

    // and it can be confirmed again
    await settle()
    fireEvent.click(button('Confirm set 5 setup'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'set5_coin_toss' }).count()).toBe(1))
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeFalsy())
    cleanup()
  }, 60000)
})
