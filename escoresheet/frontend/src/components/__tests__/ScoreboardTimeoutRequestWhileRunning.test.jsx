// The time-out counters stay open while a time-out runs (a consecutive
// time-out): the request dialog used to replace the running time-out, and
// Cancel then dropped it (the countdown was gone, the referee's ran on). And
// undoing the time-out while it ran kept its countdown on screen.
// The real scoring screen over the app's Dexie database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
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
afterEach(() => cleanup())
afterAll(() => {
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ghost = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))

async function seed() {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}` },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}` }
  ]))
  const t = new Date(Date.now() - 300000).toISOString()
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: true,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 2, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 3, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts: t },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts: t },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 6, ts: t }
  ])
  render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
  await waitFor(() => expect(button('Start rally')).toBeTruthy())
  return matchId
}

async function startTimeout(side) {
  fireEvent.click(document.querySelector(`[data-help-id="scoreboard-timeout-${side}"]`))
  await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
  fireEvent.click(button('Confirm time-out'))
  await waitFor(() => expect(button('Stop timeout')).toBeTruthy())
  await ghost()
}

describe('Scoreboard: a time-out request while a time-out runs', () => {
  it('Cancel keeps the running time-out and its countdown', async () => {
    const matchId = await seed()
    await startTimeout('left')
    // the other team's counter opens its request over the running time-out
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-right"]'))
    await waitFor(() => expect(document.querySelector('[data-testid="timeout-request-text"]')).toBeTruthy())
    fireEvent.click(button('Cancel'))
    await waitFor(() => expect(document.querySelector('[data-testid="timeout-request-text"]')).toBeFalsy())
    // the running time-out is back, still counting
    await waitFor(() => expect(button('Stop timeout')).toBeTruthy())
    expect(document.body.textContent).toMatch(/Time-out — Home/)
    const timeouts = await db.events.where({ matchId }).and(e => e.type === 'timeout').toArray()
    expect(timeouts).toHaveLength(1)
  })
})

describe('Scoreboard: undoing a time-out while it runs', () => {
  it('stops its countdown', async () => {
    const matchId = await seed()
    await startTimeout('left')
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    fireEvent.click(button('Yes'))
    await waitFor(async () => {
      const timeouts = await db.events.where({ matchId }).and(e => e.type === 'timeout').toArray()
      expect(timeouts).toHaveLength(0)
    })
    await waitFor(() => expect(button('Stop timeout')).toBeFalsy())
    expect(document.body.textContent).not.toMatch(/Time-out — Home/)
  })
})
