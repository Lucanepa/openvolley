// Laptop run of 2026-10-08 (OB-4, checked in OpenVolley at the same size):
// the last action line under the rally buttons is one line with an ellipsis
// (maxWidth 100%), but its wrapper was as wide as the text: with a long team
// name the line ran past both window edges ("AST ACTION: Point for ...",
// Chrome on the dev server at 1400 x 853: right edge 1411 px). The wrapper
// takes the rally column's width now, so the line ends in the ellipsis.
// jsdom has no layout: this checks the wrapper's width on the real scoring
// screen; the widths were measured in Chrome.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
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

describe('Scoreboard: the last action line', () => {
  it('is held to the rally column with a long team name (ellipsis, not overflow)', async () => {
    const home = await db.teams.add({ name: 'Volleyballclub Kantonsschule Wiedikon-Zürich Damen Erste Mannschaft' })
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
    const line = () => [...document.querySelectorAll('.rally-controls div[title]')].find(e => e.textContent.startsWith('Last action:'))
    await waitFor(() => expect(line()).toBeTruthy())
    expect(line().textContent).toContain('Wiedikon-Zürich')
    expect(line().style.whiteSpace).toBe('nowrap')
    expect(line().style.textOverflow).toBe('ellipsis')
    expect(line().style.maxWidth).toBe('100%')
    // its wrapper is as wide as the rally column, not as the text
    expect(line().parentElement.style.width).toBe('100%')
    expect(line().parentElement.style.minWidth).toBe('0px')
    cleanup()
  })
})
