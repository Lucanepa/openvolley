// The coach and captain signatures on the scoring screen (owner 2026-10-31):
// the coin toss no longer waits for them, so the teams sign during the
// warm-up. Until the match starts, each team with one missing shows a
// flashing "Missing signature" that opens its roster to sign, and Start set
// in set 1 stops at "Signatures missing" instead of starting the match. A
// test match (placeholders) and a started match show nothing.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'
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
const setViewport = (width, height) => {
  window.innerWidth = width
  window.innerHeight = height
}
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
})
afterEach(() => {
  setViewport(saved.width, saved.height)
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
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)
const INK = 'data:image/png;base64,AAAA'
const ALL_SIGNED = { homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK }

// Set 1 after the coin toss, team A (home) on the left, both line-ups in;
// `started`: 1:1 already. The home team has a coach and a captain (#4).
async function setUpMatch({ signatures = {}, test = false, started = false } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, lastName: `Last${n}`, firstName: 'X', isCaptain: n === 4 })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }],
    bench_away: [],
    ...signatures
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: started ? 1 : 0, awayPoints: started ? 1 : 0, finished: false, startTime: started ? t : null })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  if (started) {
    await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
    const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
    for (const [i, team] of ['home', 'away'].entries()) {
      await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
      await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
    }
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: the coach and captain signatures before the first serve', () => {
  it('nothing signed: both teams flash, Start set stops at "Signatures missing"', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    const left = await screen.findByTestId('missing-signature-left')
    expect(left.textContent).toContain('Missing signatures')
    expect(left.textContent).toContain('Coach · Captain')
    expect(screen.getByTestId('missing-signature-right')).toBeTruthy()
    await settle()

    fireEvent.click(button('Start set'))
    const modal = await screen.findByTestId('signatures-missing-modal', {}, { timeout: 5000 })
    expect(modal.textContent).toContain('A · HOM')
    expect(modal.textContent).toContain('B · AWY')
    expect(modal.textContent).toContain('Still to sign: Coach, Captain')
    await wait(500)
    expect(await ofType('set_start')).toHaveLength(0)
    expect(screen.queryByText('Set start time')).toBeNull()

    // a team's Sign opens its roster with the coach and captain buttons
    fireEvent.click(within(modal).getAllByRole('button').find(b => b.textContent.includes('A · HOM')))
    const dialog = await screen.findByTestId('pre-match-sign-dialog')
    expect(dialog.dataset.team).toBe('home')
    expect(screen.getByTestId('pre-match-sign-coach').textContent).toContain('Carla Coach')
    expect(screen.getByTestId('pre-match-sign-captain').textContent).toContain('#4 X Last4')
    expect(screen.queryByTestId('signatures-missing-modal')).toBeNull()
  }, 60000)

  it('a team that has signed stops flashing; the other keeps its role still missing', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch({ signatures: { homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK } })
    mount(matchId)
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    const right = await screen.findByTestId('missing-signature-right')
    expect(right.textContent).toContain('Missing signature')
    expect(right.textContent).not.toContain('Missing signatures')
    expect(right.textContent).toContain('Captain')
    expect(screen.queryByTestId('missing-signature-left')).toBeNull()

    // the captain signs (as the pad saves it): the button goes, Start set starts the set
    await db.matches.update(matchId, { awayCaptainSignature: INK })
    await waitFor(() => expect(screen.queryByTestId('missing-signature-right')).toBeNull(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByTestId('signatures-missing-modal')).toBeNull()
  }, 60000)

  it('all four signed: no button, Start set opens the set start time', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch({ signatures: ALL_SIGNED }))
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    await settle()
    expect(screen.queryByTestId('missing-signature-left')).toBeNull()
    expect(screen.queryByTestId('missing-signature-right')).toBeNull()
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByTestId('signatures-missing-modal')).toBeNull()
  }, 60000)

  it('a test match never asks: no button, Start set goes on', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch({ test: true }))
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    await settle()
    expect(screen.queryByTestId('missing-signature-left')).toBeNull()
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
  }, 60000)

  it('a started match shows nothing, signed or not (an older match)', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch({ started: true }))
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    expect(screen.queryByTestId('missing-signature-left')).toBeNull()
    expect(screen.queryByTestId('missing-signature-right')).toBeNull()
  }, 60000)

  it('phone layout: the flashing buttons under the court open the team roster', async () => {
    setViewport(390, 844)
    mount(await setUpMatch({ signatures: { awayCoachSignature: INK, awayCaptainSignature: INK } }))
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    const left = await screen.findByTestId('phone-missing-signature-left')
    expect(left.textContent).toContain('A · HOM')
    expect(screen.queryByTestId('phone-missing-signature-right')).toBeNull()
    await settle()
    fireEvent.click(left)
    const dialog = await screen.findByTestId('pre-match-sign-dialog')
    expect(dialog.dataset.team).toBe('home')
  }, 60000)
})
