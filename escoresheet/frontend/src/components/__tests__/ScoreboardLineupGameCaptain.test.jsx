// Owner's request of 2026-10-20 (commit c654261a): the line-up dialog asks
// for a game captain only when the six are entered without the team captain
// (FIVB 5.1.2: while the team captain is on court, he is the game captain),
// and never in an easy match. With the captain in the six nothing is chosen
// or saved. The real scoring screen over the app's Dexie database (fake
// IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
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
afterEach(() => cleanup())
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const dialog = () => document.querySelector('[role=dialog]')
const picker = () => dialog()?.querySelector('.lineup-gcapt') || null
const chip = (text) => [...dialog().querySelectorAll('*')].filter(e => e.textContent.replace(/\s+/g, '') === text).pop()
const confirmButton = () => [...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm')

// A live set without line-ups; captain #1 on both rosters of players 1-8
async function openLineupA({ easy = false, match = {} } = {}) {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: true, ...(easy ? { easy: true } : {}),
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
    ...match
  })
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: new Date(Date.now() - 60000).toISOString() })

  render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
  const open = () => [...document.querySelectorAll('button')].find(b => /^Line-?upA/.test(b.textContent.trim()))
  await waitFor(() => expect(open()).toBeTruthy())
  fireEvent.click(open())
  await waitFor(() => expect(dialog()).toBeTruthy())
  return matchId
}

// Enters the numbers one by one; what the picker showed after each
async function enter(numbers) {
  const shown = []
  for (const n of numbers) {
    fireEvent.click(chip(n))
    await sleep(30)
    shown.push(!!picker())
  }
  return shown
}

async function confirmAndWait(matchId) {
  fireEvent.click(confirmButton())
  await waitFor(async () => expect(await db.events.where({ matchId, type: 'lineup' }).count()).toBe(1))
  await sleep(500)
}

describe('Line-up dialog: the game-captain choice', () => {
  it('captain in the six: never asked, and Confirm designates no one', async () => {
    const matchId = await openLineupA()
    const shown = await enter(['C1', '2', '3', '4', '5', '6'])
    expect(shown).toEqual([false, false, false, false, false, false])
    await confirmAndWait(matchId)
    expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(0)
    const match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain ?? null).toBeNull()
    expect(match.homeRememberedCourtCaptain ?? null).toBeNull()
  })

  it('captain not in the six: asked once all six are entered, and the choice is game captain', async () => {
    const matchId = await openLineupA()
    const shown = await enter(['2', '3', '4', '5', '6', '7'])
    expect(shown).toEqual([false, false, false, false, false, true])
    const choices = [...picker().querySelectorAll('.lineup-gcapt__choice:not(.lineup-gcapt__choice--none)')].map(b => b.textContent.trim())
    expect(choices).toEqual(['2', '3', '4', '5', '6', '7'])
    fireEvent.click(picker().querySelector('[aria-label="Game captain: player 4"]'))
    await sleep(30)
    await confirmAndWait(matchId)
    const designations = await db.events.where({ matchId, type: 'court_captain_designation' }).toArray()
    expect(designations).toHaveLength(1)
    expect(designations[0].payload).toMatchObject({ team: 'home', playerNumber: 4, fromLineup: true })
    expect((await db.matches.get(matchId)).homeCourtCaptain).toBe(4)
  })

  it('in an easy match: never asked, even with the captain off court', async () => {
    const matchId = await openLineupA({ easy: true })
    const shown = await enter(['2', '3', '4', '5', '6', '7'])
    expect(shown).toEqual([false, false, false, false, false, false])
    await confirmAndWait(matchId)
    expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(0)
  })

  // the designation is part of the line-up save: one that fails rolls the
  // line-up back and the dialog says so (it was caught, and the line-up and
  // the captain's match row were stored without the designation event)
  it('a game captain that cannot be saved: nothing is stored and the dialog says so', async () => {
    const matchId = await openLineupA()
    await enter(['2', '3', '4', '5', '6', '7'])
    fireEvent.click(picker().querySelector('[aria-label="Game captain: player 4"]'))
    await sleep(30)
    const add = db.events.add.bind(db.events)
    vi.spyOn(db.events, 'add').mockImplementation((row, ...rest) => {
      if (row?.type === 'court_captain_designation') return Promise.reject(new Error('write failed (test)'))
      return add(row, ...rest)
    })
    fireEvent.click(confirmButton())
    await waitFor(() => expect(dialog().textContent).toMatch(/Save failed/))
    vi.mocked(db.events.add).mockRestore()
    expect(await db.events.where({ matchId, type: 'lineup' }).count()).toBe(0)
    expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(0)
    expect((await db.matches.get(matchId)).homeCourtCaptain ?? null).toBeNull()
  })
})

// "Keep as game captain" on (domain/gameCaptainKeep.js): a new set whose six
// leave the team captain out but hold the kept player has him as the game
// captain without asking (chosen in the picker already); None asks with the
// Game captain dialog instead
describe('Line-up dialog: the kept game captain', () => {
  const gcDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('[data-testid="game-captain-keep"]')) || null

  it('the kept player among the six: chosen already, Confirm designates him (keep), no question after', async () => {
    const matchId = await openLineupA({ match: { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 4 } })
    await enter(['2', '3', '4', '5', '6', '7'])
    const kept = picker().querySelector('[aria-label="Game captain: player 4"]')
    expect(kept.getAttribute('aria-pressed')).toBe('true')
    expect(picker().textContent).toContain('#4 kept as game captain')
    await confirmAndWait(matchId)
    const designations = await db.events.where({ matchId, type: 'court_captain_designation' }).toArray()
    expect(designations).toHaveLength(1)
    expect(designations[0].payload).toMatchObject({ team: 'home', playerNumber: 4, fromLineup: true, keep: true })
    expect((await db.matches.get(matchId)).homeCourtCaptain).toBe(4)
    expect(gcDialog()).toBeNull()
  })

  it('the kept player not among the six: nothing chosen, as without the switch', async () => {
    const matchId = await openLineupA({ match: { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 8 } })
    await enter(['2', '3', '4', '5', '6', '7'])
    expect(picker().querySelector('[aria-pressed="true"]').textContent.trim()).toBe('None')
    await confirmAndWait(matchId)
    expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(0)
    // asked after the save, the switch shown on
    await waitFor(() => expect(gcDialog()).toBeTruthy())
    expect(gcDialog().querySelector('[data-testid="game-captain-keep-switch"]').getAttribute('aria-checked')).toBe('true')
  })

  it('None instead of the kept player: no designation, the Game captain dialog asks', async () => {
    const matchId = await openLineupA({ match: { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 4 } })
    await enter(['2', '3', '4', '5', '6', '7'])
    fireEvent.click(picker().querySelector('.lineup-gcapt__choice--none'))
    await sleep(30)
    expect(picker().querySelector('[aria-label="Game captain: player 4"]').getAttribute('aria-pressed')).toBe('false')
    await confirmAndWait(matchId)
    expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(0)
    await waitFor(() => expect(gcDialog()).toBeTruthy())
  })
})
