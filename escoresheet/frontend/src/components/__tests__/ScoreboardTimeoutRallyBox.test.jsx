// Laptop run of 2026-10-08 (OV-6): the time-out countdown replaced the rally
// buttons in the rally box, and the countdown block is not as tall as them
// (192 -> 188 px at 1400 x 860): the court moved 2 px for the whole time-out
// and back. The rally buttons now stay in the box, hidden, under the
// countdown, so the box keeps their size. (jsdom has no layout: this checks
// that the countdown is drawn over the kept buttons; the heights were
// measured in Chrome on the dev server.)
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
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const hidden = (el) => {
  for (let e = el; e; e = e.parentElement) if (e.style?.visibility === 'hidden') return true
  return false
}

describe('Scoreboard: the time-out countdown in the rally box', () => {
  it('is drawn over the rally buttons, which keep the box size', async () => {
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
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 8000 })
    const rally = document.querySelector('.rally-controls')
    expect(rally.contains(button('Start rally'))).toBe(true)

    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
    fireEvent.click(button('Confirm time-out'))
    await waitFor(() => expect(button('Stop timeout')).toBeTruthy(), { timeout: 5000 })

    const box = document.querySelector('.rally-controls')
    expect(box.contains(button('Stop timeout'))).toBe(true)
    expect(hidden(button('Stop timeout'))).toBe(false)
    // the rally buttons are still in the box (they give it its size), hidden
    // and out of reach under the countdown
    const start = [...box.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start rally')
    const undo = box.querySelector('[data-help-id="scoreboard-undo"]')
    expect(start).toBeTruthy()
    expect(undo).toBeTruthy()
    expect(hidden(start)).toBe(true)
    expect(start.closest('[inert]')).toBeTruthy()

    // the time-out ends: the buttons are back, in reach (after the confirm's
    // ghost-click guard)
    await new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
    fireEvent.click(button('Stop timeout'))
    await waitFor(() => expect(button('Stop timeout')).toBeFalsy(), { timeout: 5000 })
    const back = [...document.querySelectorAll('.rally-controls button')].find(b => b.textContent.trim() === 'Start rally')
    expect(back).toBeTruthy()
    expect(hidden(back)).toBe(false)
    expect(back.closest('[inert]')).toBeFalsy()
    cleanup()
  }, 30000)
})
