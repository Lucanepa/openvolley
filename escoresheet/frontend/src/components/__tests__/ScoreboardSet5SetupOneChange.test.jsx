// Laptop run of 2026-10-08 (OV-12): "Confirm set 5 setup" during the interval
// removed the interval countdown first (f25591) and showed the court with the
// line-up buttons 90 ms later (f25593): the action wrote the set 5 coin toss
// and closed the setup with its data (deferUi), but the countdown was ended
// after the action had returned, before its data was on screen. Both now go
// in one change.
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
// the interval countdown ("2:29"): a leaf element with only the time
const countdown = () => [...document.querySelectorAll('div, span')].some(e => e.children.length === 0 && /^\d+:\d\d$/.test(e.textContent.trim()))

describe('Scoreboard: confirming the set 5 setup during the interval', () => {
  it('the countdown and the setup go in one change', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const players = []
    for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
    await db.players.bulkAdd(players)
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
      set5FirstServe: 'A', set5LeftTeam: 'A'
    })
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    // set 4 ended 30 s ago: the interval runs
    const end4 = new Date(Date.now() - 30000).toISOString()
    for (const index of [1, 2, 3, 4]) {
      const homeWins = index % 2 === 1
      await db.sets.add({ matchId, index, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: index === 4 ? end4 : t })
    }
    await db.sets.add({ matchId, index: 5, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(countdown()).toBe(true), { timeout: 5000 })

    // what each committed change shows: the setup buttons, the countdown
    const states = []
    const observer = new MutationObserver(() => {
      states.push({ setup: !!button('Confirm set 5 setup'), countdown: countdown() })
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(button('Confirm set 5 setup'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'set5_coin_toss' }).count()).toBe(1))
    await new Promise(r => setTimeout(r, 500))
    observer.disconnect()

    expect(states.at(-1)).toEqual({ setup: false, countdown: false })
    // never the setup without its countdown (or the other way round)
    expect(states.filter(st => st.setup !== st.countdown)).toEqual([])
    cleanup()
  }, 30000)
})
