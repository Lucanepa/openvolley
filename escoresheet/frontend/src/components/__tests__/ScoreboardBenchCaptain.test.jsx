// The captain on the scoring screen's bench (tablet / desktop layout): the
// number circled, as on the paper scoresheet and the phone layout, instead of
// a separate small "C" after it that made the chip wider and pushed the number
// aside. The ring follows the chip's state (the accent; amber-brown once
// substituted out; the libero colour on a libero-captain) and is named for
// screen readers.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB). Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, waitFor, cleanup, within } from '@testing-library/react'
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

// As in ScoreboardSet5CourtSwitch.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
  window.innerWidth = 1280
  window.innerHeight = 800
})
afterEach(() => {
  window.innerWidth = saved.width
  window.innerHeight = saved.height
})
afterAll(() => {
  cleanup()
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

// Set 1 under way at 1:1, team A (home) on the left. Home: 1-9, #7 its
// libero; away: 1-12. Players 1-6 start for both, so 8 and 9 (home) and 7-12
// (away) sit on the bench. `captains` names each team's captain; `homeSub`
// [out, in] substitutes a home player.
async function setUpMatch({ captains, homeSub = null }) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (let n = 1; n <= 9; n++) players.push({ teamId: home, number: n, lastName: `P${n}`, firstName: 'X', libero: n === 7 ? 'libero1' : '', isCaptain: n === captains.home })
  for (let n = 1; n <= 12; n++) players.push({ teamId: away, number: n, lastName: `P${n}`, firstName: 'X', libero: '', isCaptain: n === captains.away })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
  for (const [i, team] of ['home', 'away'].entries()) {
    await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
    await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
  }
  if (homeSub) {
    const [out, inn] = homeSub
    const position = Object.keys(lineup).find(p => lineup[p] === String(out))
    await db.events.add({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: out, playerIn: inn, position }, seq: seq++, ts: at(2) })
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...lineup, [position]: String(inn) }, fromSubstitution: true }, seq: seq++, ts: at(2) })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const chip = (team, number, libero = false) => document.querySelector(`[data-bench-player="${number}"][data-team="${team}"][data-is-libero="${libero}"]`)
const ringOf = (el) => el.querySelector('[data-testid="bench-captain-ring"]')
// a separate "C" mark: any element inside the chip that reads just "C"
const hasCMark = (el) => [...el.querySelectorAll('*')].some(e => e.textContent.trim() === 'C')

describe('Scoreboard bench: the captain\'s number circled', () => {
  it('rings the captain\'s number on the bench (one and two digits), with no "C" and no ring on the others', async () => {
    const matchId = await setUpMatch({ captains: { home: 8, away: 12 } })
    mount(matchId)
    await waitFor(() => expect(chip('away', 12)).toBeTruthy(), { timeout: 10000 })

    for (const [team, number] of [['home', 8], ['away', 12]]) {
      const el = chip(team, number)
      const ring = ringOf(el)
      expect(ring).toBeTruthy()
      // the number alone: no separate "C" beside it
      expect(el.textContent).toBe(String(number))
      expect(hasCMark(el)).toBe(false)
      // the ring sits round the number itself, laid over it (it takes no room)
      expect(ring.parentElement.firstChild.textContent).toBe(String(number))
      expect(ring.textContent).toBe('')
      expect(ring.style.position).toBe('absolute')
      expect(ring.style.borderStyle).toBe('solid')
      expect(ring.style.borderWidth).toBe('2px')
      expect(ring.style.borderColor).toBe('var(--accent)')
      // not only seen: named for screen readers, and on hover
      expect(within(el).getByRole('img', { name: 'captain' })).toBe(ring)
      expect(ring.parentElement.getAttribute('title')).toBe('captain')
    }
    // two digits get the taller ring
    expect(ringOf(chip('away', 12)).style.height).toBe('1.5em')
    expect(ringOf(chip('home', 8)).style.height).toBe('1.35em')

    // everyone else on the bench: the number only, no ring
    for (const [team, number] of [['home', 9], ['away', 7], ['away', 10], ['away', 11]]) {
      const el = chip(team, number)
      expect(el).toBeTruthy()
      expect(ringOf(el)).toBeNull()
      expect(el.textContent).toBe(String(number))
    }
    expect(ringOf(chip('home', 7, true))).toBeNull()
    expect(document.querySelectorAll('[data-testid="bench-captain-ring"]')).toHaveLength(2)
  }, 30000)

  it('a libero-captain: the number ringed in the libero colour, next to its L1 tag', async () => {
    const matchId = await setUpMatch({ captains: { home: 7, away: 1 } })
    mount(matchId)
    await waitFor(() => expect(chip('home', 7, true)).toBeTruthy(), { timeout: 10000 })
    const el = chip('home', 7, true)
    const ring = ringOf(el)
    expect(ring).toBeTruthy()
    expect(el.textContent).toBe('7L1')
    expect(hasCMark(el)).toBe(false)
    expect(ring.parentElement.firstChild.textContent).toBe('7')
    expect(ring.style.borderColor).toBe('rgb(29, 78, 216)')
    expect(ring.parentElement.nextElementSibling.textContent.trim()).toBe('L1')
    // the away captain plays: nobody on the away bench is ringed
    expect(ringOf(chip('away', 7))).toBeNull()
  }, 30000)

  it('a captain substituted out: the ring in the amber-brown of the chip', async () => {
    const matchId = await setUpMatch({ captains: { home: 1, away: 12 }, homeSub: [1, 8] })
    mount(matchId)
    await waitFor(() => expect(chip('home', 1)).toBeTruthy(), { timeout: 10000 })
    const el = chip('home', 1)
    const ring = ringOf(el)
    expect(ring).toBeTruthy()
    expect(ring.style.borderColor).toBe('rgb(180, 83, 9)')
    expect(ring.parentElement.firstChild.textContent).toBe('1')
    expect(hasCMark(el)).toBe(false)
    // #8 came in for the captain: on court, not on the bench
    expect(chip('home', 8)).toBeNull()
  }, 30000)
})
