// A libero declared unable, then a player re-designated as libero (FIVB 19.4).
// Both confirmations wrote the event and the remark, then built the activity
// log line from `scoreStr`, a name 039585d5 (remarks as "Set 3, 14:28, B 15:5,
// ...") took away: a ReferenceError every time, the action rolled back as a
// whole and the scorer got "That was not saved". Neither could be recorded.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
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

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)
const clickText = (text) => {
  const el = [...document.querySelectorAll('button, [role=menuitem]')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)
  if (!el) throw new Error(`no "${text}" to tap`)
  fireEvent.click(el)
}

// Set 1 under way at 3:1, team A (home) on the left with one libero (#7) on
// the bench, #8 and #9 on the bench too
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) {
    for (let n = 1; n <= 9; n++) {
      players.push({ teamId, number: n, lastName: `P${n}`, firstName: 'X', libero: teamId === home && n === 7 ? 'libero1' : '' })
    }
  }
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 3, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
  for (const [i, team] of ['home', 'away', 'home', 'home'].entries()) {
    await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
    await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
  }
  return { matchId, home }
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: a libero declared unable, then a player re-designated', () => {
  it('both are recorded, with their remarks, and the player becomes the libero', async () => {
    const { matchId, home } = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy())
    await settle()

    // the libero on team A's bench: its action menu, Unable to play, Declared unable
    const libero = document.querySelector('[data-bench-player="7"][data-is-libero="true"]')
    expect(libero).toBeTruthy()
    fireEvent.click(libero)
    await waitFor(() => expect(button('Unable to play')).toBeTruthy())
    clickText('Unable to play')
    await waitFor(() => expect(button('Declared unable')).toBeTruthy())
    clickText('Declared unable')
    await waitFor(() => expect(button('Confirm')).toBeTruthy())
    await settle()
    clickText('Confirm')

    await waitFor(async () => expect(await ofType('libero_unable')).toHaveLength(1))
    const [unable] = await ofType('libero_unable')
    expect(unable.payload).toMatchObject({ team: 'home', liberoNumber: 7, reason: 'declared' })
    expect(unable.payload.autoRemark).toMatch(/A 3:1.*Libero #7 declared unable to play/)
    await waitFor(async () => expect((await db.matches.get(matchId)).remarks).toMatch(/Libero #7 declared unable to play/))

    // the team has no libero left: the dialog asks for a re-designation
    await waitFor(() => expect(button('Yes, redesignate')).toBeTruthy())
    await settle()
    clickText('Yes, redesignate')
    await waitFor(() => expect(button('#8')).toBeTruthy())
    await settle()
    clickText('#8')

    await waitFor(async () => expect(await ofType('libero_redesignation')).toHaveLength(1))
    const [redesignation] = await ofType('libero_redesignation')
    expect(redesignation.payload).toMatchObject({ team: 'home', unableLiberoNumber: 7, newLiberoNumber: 8 })
    await waitFor(async () => {
      const players = await db.players.where('teamId').equals(home).toArray()
      expect(players.find(p => p.number === 7).libero).toBe('unable')
      expect(players.find(p => p.number === 8).libero).toBe('redesignated')
    })
    expect((await db.matches.get(matchId)).remarks).toMatch(/#8 re-designated as Libero \(replacing #7\)/)
    // no failure shown to the scorer
    expect(document.body.textContent).not.toMatch(/That was not saved/)
  }, 60000)
})
