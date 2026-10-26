// A double tap on the rally buttons: one tap, one action.
//
// Start rally and Point A | Point B replace each other in the same place
// (.rally-stack-layer): the second tap of a double tap (a finger bouncing, a
// tablet registering one tap twice) landed on the button that had just
// replaced the first one. Stress test of 3.0.3 (2026-10-25), real pointer
// and touch taps 40 to 250 ms apart, every attempt: a double tap on Start
// rally gave the rally to the team under the finger, a triple tap on Point B
// gave its rally two points, a double tap on Point left a new rally running.
// For GHOST_CLICK_MS after the buttons change, a tap on them is now taken as
// the end of the tap that changed them.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB); the second tap lands the moment the new button is on screen.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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

// As in ScoreboardStaleTaps.test.jsx: under jsdom + fake-indexeddb a scorer
// action can lose Dexie's transaction zone part-way and end with
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
afterAll(() => {
  cleanup()
  setViewport(saved.width, saved.height)
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

// The next tap of a double tap: as soon as `text` is on screen (the commit
// that drew it, before anything else runs), tap it
function tapAsSoonAsShown(text, root = () => document) {
  return new Promise((resolve) => {
    const tryTap = () => {
      const el = button(text, root())
      if (!el) return false
      fireEvent.click(el)
      resolve()
      return true
    }
    if (tryTap()) return
    const observer = new MutationObserver(() => { if (tryTap()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  })
}

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
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
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const score = async () => {
  const set = (await db.sets.toArray())[0]
  return [set.homePoints, set.awayPoints]
}

describe('Scoreboard: a double tap on the rally buttons', () => {
  it('desktop: a double tap on Start rally starts the rally and scores no point', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const points = (await ofType('point')).length
    fireEvent.click(button('Start rally'))
    // the second tap lands on Point B, drawn where Start rally was
    await tapAsSoonAsShown('Point B')
    await settle()
    expect((await ofType('point')).length).toBe(points)
    expect(await score()).toEqual([1, 1])
    expect(button('Point A')).toBeTruthy()

    // a deliberate tap a moment later is a point as usual
    fireEvent.click(button('Point B'))
    await waitFor(async () => expect((await ofType('point')).length).toBe(points + 1), { timeout: 5000 })
    expect(await score()).toEqual([1, 2])
  }, 60000)

  it('desktop: a triple tap on Point gives its rally one point and starts no rally', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Point B')).toBeTruthy(), { timeout: 5000 })
    await settle()
    const points = (await ofType('point')).length
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(button('Point B'))
    // second tap: on Start rally, drawn where Point B was
    await tapAsSoonAsShown('Start rally')
    await wait(60)
    // third tap: on whatever is there now
    const third = button('Point B') || button('Start rally')
    if (third) fireEvent.click(third)
    await settle()
    expect((await ofType('point')).length).toBe(points + 1)
    expect((await ofType('rally_start')).length).toBe(rallies)
    expect(await score()).toEqual([1, 2])
    expect(button('Start rally')).toBeTruthy()

    // the next rally is started and scored as usual
    fireEvent.click(button('Start rally'))
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Point A'))
    await waitFor(async () => expect((await ofType('point')).length).toBe(points + 2), { timeout: 5000 })
    expect(await score()).toEqual([2, 2])
  }, 60000)

  it('phone: a double tap on Start rally scores no point', async () => {
    setViewport(390, 844)
    mount(await setUpMatch())
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    const phone = () => screen.getByTestId('phone-scoreboard')
    const view = within(phone())
    await waitFor(() => expect(view.queryByRole('button', { name: 'Start rally' })).toBeTruthy(), { timeout: 10000 })
    await settle()
    const points = (await ofType('point')).length
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await tapAsSoonAsShown('Point A', phone)
    await settle()
    expect((await ofType('point')).length).toBe(points)
    expect(await score()).toEqual([1, 1])
  }, 60000)
})

// review of #37: with the device storage full a refused tap was said to the
// scorer ("storage full"), and its promise then ended as an unhandled
// rejection (an AbortError), reported again as an app error at every tap
describe('Scoreboard: a refused rally tap', () => {
  it('says why and leaves no unhandled rejection behind', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const unhandled = []
    const listener = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    // the next write transaction fails as Dexie does on a full storage
    const full = Object.assign(new Error('QuotaExceededError'), { name: 'AbortError', inner: Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) })
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(full))
    try {
      fireEvent.click(button('Start rally'))
      await waitFor(() => expect(document.body.textContent).toMatch(/storage/i), { timeout: 5000 })
      await wait(300)
      expect(unhandled).toEqual([])
      expect((await ofType('rally_start')).length).toBe(2)
    } finally {
      transaction.mockRestore()
      process.removeListener('unhandledRejection', listener)
    }
  }, 60000)
})

// Keys do not bounce: a keyboard scorer pressing Enter at the whistle and A a
// moment later lost the point, with only a console line (review of #37)
describe('Scoreboard: the rally keys right after the buttons changed', () => {
  // the next key press: KEY_GAP_MS after `text` is on screen (a quick
  // scorer), well inside the buttons' double-tap window
  const KEY_GAP_MS = 60
  function pressSoonAfterShown(text, key) {
    return new Promise((resolve) => {
      const shown = () => {
        if (!button(text)) return false
        setTimeout(() => { fireEvent.keyDown(window, { key }); resolve() }, KEY_GAP_MS)
        return true
      }
      if (shown()) return
      const observer = new MutationObserver(() => { if (shown()) observer.disconnect() })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    })
  }

  it('Enter then A in quick succession: the rally starts and A scores it; Enter right after starts the next one', async () => {
    localStorage.setItem('keybindingsEnabled', 'true')
    try {
      setViewport(1280, 800)
      mount(await setUpMatch())
      await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
      await settle()
      const points = (await ofType('point')).length
      const rallies = (await ofType('rally_start')).length
      fireEvent.keyDown(window, { key: 'Enter' })
      await pressSoonAfterShown('Point A', 'a')
      await waitFor(async () => expect((await ofType('point')).length).toBe(points + 1), { timeout: 5000 })
      expect(await score()).toEqual([2, 1])
      expect((await ofType('rally_start')).length).toBe(rallies + 1)

      await pressSoonAfterShown('Start rally', 'Enter')
      await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 2), { timeout: 5000 })
    } finally {
      localStorage.removeItem('keybindingsEnabled')
    }
  }, 60000)
})
