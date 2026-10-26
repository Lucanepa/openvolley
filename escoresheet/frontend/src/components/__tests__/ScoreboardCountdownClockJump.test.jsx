// The scorer's own countdowns when the device clock is set back (stress test
// 2026-10-25): an hour back in the middle of a time-out and the countdown
// read 3624, and 3589 35 s later. They counted Date.now() against the
// wall-clock start; they now run on the monotonic clock (utils/countdownClock).
// The real scoring screen over the app's Dexie database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
// The time-out countdown under "Time-out — <team>"
const timeoutCountdown = () => {
  const title = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^Time-out — /.test(d.textContent.trim()))
  const value = title?.nextElementSibling?.textContent.trim()
  return value != null && /^\d+$/.test(value) ? Number(value) : null
}

async function setUpMatch() {
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
  return matchId
}

describe('Scoreboard: its countdowns with the device clock set back', () => {
  it('the time-out counts on from 30 when the clock goes back an hour', async () => {
    const matchId = await setUpMatch()
    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })

    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
    await wait(GHOST_CLICK_MS)
    fireEvent.click(button('Confirm time-out'))
    await waitFor(() => expect(timeoutCountdown()).toBe(30))

    // the device clock is set back one hour (an NTP or manual correction)
    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3600 * 1000)
    try {
      await wait(1300)
      const shown = timeoutCountdown()
      expect(shown).toBeLessThanOrEqual(29)
      expect(shown).toBeGreaterThanOrEqual(28)
      expect(button('Stop timeout')).toBeTruthy()
    } finally {
      clock.mockRestore()
    }
  }, 60000)

  it('the interval between sets counts on when the clock goes back an hour', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, name: `H${n}` }, { teamId: away, number: n, name: `A${n}` }
    ]))
    // set 1 ended 30 s ago: 2:30 of the interval are left
    const end1 = new Date(Date.now() - 30000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 15, finished: true, startTime: new Date(Date.now() - 1800000).toISOString(), endTime: end1 })
    await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 1, ts: end1 },
      { matchId, setIndex: 1, type: 'set_end', payload: {}, seq: 2, ts: end1 }
    ])
    const interval = () => [...document.querySelectorAll('div, span')]
      .filter(e => e.children.length === 0 && /^\d+:\d\d$/.test(e.textContent.trim()))
      .map(e => e.textContent.trim().split(':').reduce((m, sec) => Number(m) * 60 + Number(sec)))[0] ?? null

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(interval()).toBeGreaterThan(0))
    const before = interval()
    expect(before).toBeLessThanOrEqual(150)

    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3600 * 1000)
    try {
      await wait(1300)
      const shown = interval()
      expect(shown).toBeLessThanOrEqual(before)
      expect(shown).toBeGreaterThanOrEqual(before - 2)
      expect(button('End set interval')).toBeTruthy()
    } finally {
      clock.mockRestore()
    }
  }, 60000)
})
