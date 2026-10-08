// Laptop run of 2026-10-08 (OV-7): after a set interval was ended early with
// "End set interval", the next interval reused the old interval's start time,
// so it ended itself at once (or showed the old interval's time: 2:44 then
// 2:14). Each interval runs its own clock from the previous set's end.
// The real scoring screen over the app's Dexie database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'

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
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const countdown = (re) => [...document.querySelectorAll('div, span')].filter(e => e.children.length === 0 && re.test(e.textContent.trim())).map(e => e.textContent.trim())

describe('Scoreboard: the set interval clock', () => {
  it('an interval ended early does not shorten the next one', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, name: `H${n}` }, { teamId: away, number: n, name: `A${n}` }
    ]))
    // set 1 ended 178 s ago: 2 s of the 1-2 interval are left
    const end1 = new Date(Date.now() - 178000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 15, finished: true, startTime: new Date(Date.now() - 1800000).toISOString(), endTime: end1 })
    const set2 = await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 1, ts: end1 },
      { matchId, setIndex: 1, type: 'set_end', payload: {}, seq: 2, ts: end1 }
    ])

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 8000 })
    fireEvent.click(button('End set interval'))
    await waitFor(() => expect(button('End set interval')).toBeFalsy())

    // set 2 is played and won by the away team, then the 2-3 interval begins
    await db.events.add({ matchId, setIndex: 2, type: 'set_start', payload: {}, seq: 3, ts: new Date().toISOString() })
    await sleep(2500) // longer than the 1-2 interval had left
    const end2 = new Date().toISOString()
    await db.transaction('rw', db.sets, db.events, async () => {
      await db.sets.update(set2, { homePoints: 18, awayPoints: 25, finished: true, startTime: end1, endTime: end2 })
      await db.sets.add({ matchId, index: 3, homePoints: 0, awayPoints: 0, finished: false })
      await db.events.add({ matchId, setIndex: 2, type: 'set_end', payload: {}, seq: 4, ts: end2 })
    })

    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 8000 })
    await sleep(600)
    // still running, with the full 3 minutes (not the old interval's 2 s)
    expect(button('End set interval')).toBeTruthy()
    expect(countdown(/^\d+(:\d\d)?$/)).toEqual(expect.arrayContaining([expect.stringMatching(/^(3:00|2:5\d)$/)]))
    cleanup()
  }, 30000)
})

describe('Scoreboard: the set interval starts at the set end', () => {
  it('counts from the set end event, not from the set end time rounded down to the minute', async () => {
    cleanup()
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, name: `H${n}` }, { teamId: away, number: n, name: `A${n}` }
    ]))
    // confirmed 10 s ago; the set row keeps the minute (here 55 s earlier)
    const confirmedAt = new Date(Date.now() - 10000).toISOString()
    const roundedEnd = new Date(Date.now() - 55000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 15, finished: true, startTime: roundedEnd, endTime: roundedEnd })
    await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 1, ts: roundedEnd },
      { matchId, setIndex: 1, type: 'set_end', payload: { endTime: roundedEnd }, seq: 2, ts: confirmedAt }
    ])

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(countdown(/^\d:\d\d$/).length).toBeGreaterThan(0), { timeout: 8000 })
    // 180 - 10 s: 2:50 (not 180 - 55 s: 2:05)
    expect(countdown(/^\d:\d\d$/)).toEqual(expect.arrayContaining([expect.stringMatching(/^2:(4[89]|50)$/)]))
    cleanup()
  }, 30000)
})
