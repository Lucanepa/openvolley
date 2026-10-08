// Laptop run of 2026-10-08 (OV-11): the libero reminder's Continue closed the
// reminder, then read the sets and opened the set start-time dialog 39 ms
// later: one frame with no dialog (the backdrop went and came back). The
// reminder now gives way to the start-time dialog in one change.
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
const dialogs = () => [...document.querySelectorAll('[role=dialog]')]

describe('Scoreboard: the libero reminder before the first rally', () => {
  it('Continue gives way to the start-time dialog in one change', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, libero: n === 7 ? 'libero1' : '' },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}` }
    ]))
    const t = new Date(Date.now() - 60000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 2, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 3, ts: t }
    ])

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('Start set')).toBeTruthy())
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(button('Continue')).toBeTruthy())
    expect(dialogs()).toHaveLength(1)

    // what each committed change shows: how many dialogs are open
    const states = []
    const observer = new MutationObserver(() => { states.push(dialogs().length) })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(button('Continue'))
    await waitFor(() => expect(document.body.textContent).toMatch(/start time/i))
    await new Promise(r => setTimeout(r, 300))
    observer.disconnect()

    expect(states.at(-1)).toBe(1)
    // never a change with no dialog between the reminder and the start time
    expect(states.filter(n => n === 0)).toEqual([])
    cleanup()
  })
})
