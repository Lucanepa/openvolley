// Laptop run of 2026-10-08 (OV-4): confirming a starting line-up closed the
// dialog 33-81 ms before the line-up showed on the court: the modal wrote the
// line-up event outside any action and closed itself after the write. The
// save is one scorer action now, and the dialog closes with its data.
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

describe('Scoreboard: confirming a starting line-up', () => {
  it('the dialog closes with the line-up on the court, in one change', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
    ]))
    const toss = new Date(Date.now() - 60000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: toss })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    const open = () => [...document.querySelectorAll('button')].find(b => /^LineupA/.test(b.textContent.trim()))
    await waitFor(() => expect(open()).toBeTruthy(), { timeout: 8000 })
    fireEvent.click(open())
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeTruthy())
    const dialog = () => document.querySelector('[role=dialog]')
    const chip = (text) => [...dialog().querySelectorAll('*')].filter(e => e.textContent.replace(/\s+/g, '') === text).pop()
    for (const n of ['C1', '2', '3', '4', '5', '6']) { fireEvent.click(chip(n)); await new Promise(r => setTimeout(r, 30)) }

    // what each committed change shows: the line-up dialog, the line-up saved
    const states = []
    const observer = new MutationObserver(() => {
      states.push({ dialog: !!dialog(), saved: !open() })
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'lineup' }).count()).toBe(1))
    await new Promise(r => setTimeout(r, 500))
    observer.disconnect()

    expect(states.at(-1)).toMatchObject({ dialog: false, saved: true })
    // never the dialog gone with the court still empty, or the other way round
    expect(states.filter(st => st.dialog === st.saved)).toEqual([])
    cleanup()
  }, 30000)
})
