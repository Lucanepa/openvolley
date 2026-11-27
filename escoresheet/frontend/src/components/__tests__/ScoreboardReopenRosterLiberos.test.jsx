// "Edit home roster" during the match (ReopenRosterModal) and the team's
// liberos (owner 27.11.2026): a team's only libero is Libero 1. The L1 set to
// none, the L2 left becomes L1 while no recorded event refers to the team's
// liberos (domain/liberoChoices liberosInRecord); once the record names them
// (the record refers to L1 / L2: liberoType), L1 / L2 stay as recorded and
// the dialog says so in one line.
// The real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. Invented names only.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'

vi.mock('../../lib/apiClient', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } }))
  }
})

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

// As in scoreboardContinuation.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
beforeAll(async () => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  window.innerWidth = 1280
  window.innerHeight = 800
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  localStorage.removeItem('displayMode')
  await db.open()
})
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(GHOST_CLICK_MS + 150)
const INK = 'data:image/png;base64,AAAA'
const findButton = (re, root = document) => [...root.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const playersOf = async (teamId) => db.players.where('teamId').equals(teamId).toArray()
const mark = (players, n) => players.find(p => Number(p.number) === n)?.libero

// Set 1 at 1:0, home serving. Home: #1-#8 and the liberos #9 (L1) and #10
// (L2) on the bench; `extraEvents` after the first point
async function setUpMatch({ extraEvents = [] } = {}) {
  const homeId = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const awayId = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const liberos = { 9: 'libero1', 10: 'libero2' }
  await db.players.bulkAdd([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({ teamId: homeId, number: n, name: `H${n} X`, firstName: 'X', lastName: `H${n}`, libero: liberos[n] || '' })),
    ...[21, 22, 23, 24, 25, 26, 27, 28].map(n => ({ teamId: awayId, number: n, name: `A${n} X`, firstName: 'X', lastName: `A${n}`, libero: '' }))
  ])
  const matchId = await db.matches.add({
    homeTeamId: homeId, awayTeamId: awayId, status: 'live', test: true, bestOf: 5, seed_key: 'match_1799999999999_reopenliberos',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK,
    bench_home: [], bench_away: []
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  const add = (e) => db.events.add({ matchId, setIndex: 1, seq: seq++, ts: t, ...e })
  await add({ type: 'coin_toss', payload: {} })
  await add({ type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true } })
  await add({ type: 'lineup', payload: { team: 'away', lineup: { I: '21', II: '22', III: '23', IV: '24', V: '25', VI: '26' }, isInitial: true } })
  await add({ type: 'set_start', payload: {} })
  await add({ type: 'rally_start', payload: {} })
  await add({ type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } } })
  for (const e of extraEvents) {
    const base = seq++
    await db.events.add({ matchId, setIndex: 1, seq: base, ts: t, type: e.type, payload: e.payload })
    if (e.lineup) await db.events.add({ matchId, setIndex: 1, seq: base + 0.1, ts: t, type: 'lineup', payload: e.lineup })
  }
  return { matchId, homeId }
}

async function openHomeRosterEditor () {
  await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
  await settle()
  const matchButton = findButton(/^Match$/) || [...document.querySelectorAll('button')].find(b => /^Match$/.test(b.getAttribute('aria-label') || b.title || ''))
  fireEvent.click(matchButton)
  const editItem = () => [...document.querySelectorAll('button,[role="menuitem"]')].find(b => /Edit home roster/.test(b.textContent))
  await waitFor(() => expect(editItem()).toBeTruthy(), { timeout: 5000 })
  fireEvent.click(editItem())
  await waitFor(() => expect(dialog(/Reopen roster/) && findButton(/^Reopen$/, dialog(/Reopen roster/))).toBeTruthy(), { timeout: 5000 })
  fireEvent.click(findButton(/^Reopen$/, dialog(/Reopen roster/)))
  await waitFor(() => expect(screen.getAllByLabelText('Player number').length).toBeGreaterThanOrEqual(10), { timeout: 5000 })
}
const editor = () => dialog(/Edit roster/)
const liberoOf = (n) => {
  const row = within(editor()).getAllByRole('listitem').find(r => within(r).queryByLabelText('Player number')?.value === String(n))
  return within(row).getByLabelText('Libero')
}
async function saveEditor (homeId, check) {
  fireEvent.click(findButton(/^Save changes$/))
  await waitFor(async () => check(await playersOf(homeId)), { timeout: 5000 })
  await waitFor(() => expect(findButton(/^Save changes$/)).toBeFalsy(), { timeout: 5000 })
}

describe('Edit roster during the match: the liberos', () => {
  it('no libero recorded yet: the L1 set to none, the L2 becomes L1 (no line)', async () => {
    const { matchId, homeId } = await setUpMatch()
    const view = mount(matchId)
    await openHomeRosterEditor()
    expect(liberoOf(9)).toHaveValue('libero1')
    expect(liberoOf(10)).toHaveValue('libero2')
    fireEvent.change(liberoOf(9), { target: { value: '' } })
    await waitFor(() => expect(liberoOf(10)).toHaveValue('libero1'))
    expect(screen.queryByTestId('libero-slots-kept')).toBeNull()
    await saveEditor(homeId, (players) => {
      expect(mark(players, 9)).toBe('')
      expect(mark(players, 10)).toBe('libero1')
    })
    view.unmount()
  }, 60000)

  it('the L2 already replaced a player: L1 / L2 stay as recorded, and the dialog says so', async () => {
    const { matchId, homeId } = await setUpMatch({
      extraEvents: [{
        type: 'libero_entry',
        payload: { team: 'home', position: 'V', playerOut: 5, liberoIn: 10, liberoType: 'libero2' },
        lineup: { team: 'home', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '10', VI: '6' }, liberoSubstitution: { position: 'V', liberoNumber: 10, playerNumber: 5, liberoType: 'libero2' } }
      }]
    })
    const view = mount(matchId)
    await openHomeRosterEditor()
    fireEvent.change(liberoOf(9), { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId('libero-slots-kept')).toBeTruthy())
    expect(screen.getByTestId('libero-slots-kept').textContent).toMatch(/The liberos keep L1 and L2: the match record already refers to them/)
    expect(liberoOf(10)).toHaveValue('libero2')
    await saveEditor(homeId, (players) => {
      expect(mark(players, 9)).toBe('')
      expect(mark(players, 10)).toBe('libero2')
    })
    view.unmount()
  }, 60000)
})
