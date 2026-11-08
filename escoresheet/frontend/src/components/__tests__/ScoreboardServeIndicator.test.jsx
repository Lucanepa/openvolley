// Point Hub board, 2026-11-08: the SERVE number box was small in the corner of
// the score row, with empty space below it beside 1R down to the court. The
// box now fills its side of the score row and of the 1R row (renderServeSide,
// styles.css .serve-side); a side's Game captain button sits in the same cell,
// in its outer bottom corner, so the box stands beside or above it and never
// over it. (jsdom has no layout: this checks the cells and what is in them;
// the sizes were measured in Chrome and WebKit on the dev server.)
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

describe('Scoreboard: the SERVE indicator', () => {
  it('fills its side down to the court, beside that side\'s Game captain button', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    // the away captain (#7) is not in the line-up: the away side shows a Game captain button
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 7 }
    ]))
    const t = new Date(Date.now() - 300000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
      officials: [{ role: '1st referee', firstName: 'Claudia', lastName: 'Moser' }]
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
    const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 2, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 3, ts: t },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts: t }
    ])

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    const sides = () => [...document.querySelectorAll('.serve-side')]
    await waitFor(() => expect(sides()).toHaveLength(2))
    await waitFor(() => expect(document.querySelector('.serve-side__chip')).toBeTruthy())
    const [left, right] = sides()

    // both cells run from the score row down through the 1R row
    expect(left.style.gridRow).toBe('1 / 3')
    expect(right.style.gridRow).toBe('1 / 3')
    expect(left.parentElement.textContent).toContain('1R: Claudia Moser')

    // home serves on the left: its server's number, in a box that scales with itself
    const leftIndicator = left.querySelector('.serve-side__indicator')
    expect(leftIndicator.style.visibility).toBe('visible')
    expect(leftIndicator.textContent).toBe('SERVE1')
    expect(leftIndicator.querySelector('[style*="container-type"]')).toBeTruthy()
    expect(right.querySelector('.serve-side__indicator').style.visibility).toBe('hidden')

    // the away side's Game captain button is in the away cell, next to the
    // (hidden) indicator, and stays usable
    const grid = right.querySelector('.serve-side__grid')
    expect(grid.classList.contains('serve-side__grid--chip')).toBe(true)
    expect(grid.dataset.side).toBe('right')
    expect(left.querySelector('.serve-side__chip')).toBeNull()
    const chip = grid.querySelector('.serve-side__chip')
    expect(chip.textContent).toBe('Game captain')
    fireEvent.click(chip)
    await waitFor(() => expect([...document.querySelectorAll('[role=dialog]')].some(d => d.textContent.includes('Game captain'))).toBe(true))
    cleanup()
  })
})
