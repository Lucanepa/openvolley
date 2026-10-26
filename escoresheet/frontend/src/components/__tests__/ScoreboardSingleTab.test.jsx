// One scoring tab per match, after a reload too.
//
// The scoreboard marks its tab in localStorage ('scoresheet-active-<match>')
// and answers a new tab's question on a BroadcastChannel. The mark is cleared
// only when the screen unmounts, which a reload, a closed tab or a crash never
// does, so after any reload the tab found a mark left by its old page, claimed
// it after a 200 ms probe and returned before setting up its answers: it
// never answered again, and a later tab opened the same live match as well.
// Both scored; both showed "Set 1 end" and the second Confirm wrote a set_end
// into set 2 (and once a second set 2), on the server too (stress test
// 2026-10-25). The tab now holds a Web Lock for its life (the browser frees
// it on reload, close or crash); without Web Locks every tab answers, and a
// set end confirmed elsewhere closes the dialog and is not written again.
//
// Two "tabs": two scoring screens of the same match on one page, sharing
// localStorage, the BroadcastChannel and (lock path) one lock manager, over
// the app's real Dexie database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
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
  delete navigator.locks
  localStorage.clear()
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  delete navigator.locks
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

// The browser's lock manager (navigator.locks), exclusive locks only: what
// the screen uses of it
function fakeLockManager() {
  const held = new Set()
  const waiting = new Map()
  const grantNext = (name) => {
    const queue = waiting.get(name) || []
    const next = queue.shift()
    if (next) next()
  }
  return {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {} }
      return new Promise((resolve, reject) => {
        const grant = () => {
          held.add(name)
          Promise.resolve()
            .then(() => callback({ name, mode: 'exclusive' }))
            .then(resolve, reject)
            .finally(() => { held.delete(name); grantNext(name) })
        }
        if (!held.has(name)) { grant(); return }
        if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return }
        const queue = waiting.get(name) || []
        waiting.set(name, queue)
        queue.push(grant)
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(grant)
          if (at >= 0) { queue.splice(at, 1); reject(new DOMException('aborted', 'AbortError')) }
        })
      })
    }
  }
}

// Set 1 at `home`:`away`, no rally in play, team A (home) on the left
async function setUpMatch({ home: homePoints = 1, away: awayPoints = 1 } = {}) {
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
  await db.sets.add({ matchId, index: 1, homePoints, awayPoints, finished: false, startTime: t })
  let seq = 1
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const events = [
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t }
  ]
  // the away points first, then the home run (no side-out rotation to follow)
  for (let k = 0; k < homePoints + awayPoints; k++) {
    events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    events.push({ matchId, setIndex: 1, type: 'point', payload: { team: k < awayPoints ? 'away' : 'home' }, seq: seq++, ts: t })
  }
  await db.events.bulkAdd(events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const blocked = (tab) => /Scoresheet already open/.test(tab.container.textContent)
const scoring = (tab) => !!button('Start rally', tab.container)

// What a reload, a closed tab or a crash leaves: the mark of a page now gone
const leaveStaleMark = (matchId) => localStorage.setItem(`scoresheet-active-${matchId}`, 'page-before-reload')

describe('Scoreboard: one scoring tab per match', () => {
  it('Web Locks: after a reload a second tab is blocked, and takes over once the first one is closed', async () => {
    setViewport(1280, 800)
    Object.defineProperty(navigator, 'locks', { value: fakeLockManager(), configurable: true })
    const matchId = await setUpMatch()
    leaveStaleMark(matchId)
    const a = mount(matchId)
    await waitFor(() => expect(scoring(a)).toBe(true), { timeout: 10000 })
    await wait(500)
    const b = mount(matchId)
    await waitFor(() => expect(blocked(b)).toBe(true), { timeout: 5000 })
    await wait(500)
    expect(blocked(a)).toBe(false)
    expect(scoring(a)).toBe(true)

    // the first tab closed: the browser frees its lock, the second one scores
    a.unmount()
    await waitFor(() => expect(scoring(b)).toBe(true), { timeout: 10000 })
    expect(blocked(b)).toBe(false)
  }, 60000)

  it('without Web Locks: after a reload a second tab is blocked', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch()
    leaveStaleMark(matchId)
    const a = mount(matchId)
    await waitFor(() => expect(scoring(a)).toBe(true), { timeout: 10000 })
    // past the reloaded tab's probe of the old mark
    await wait(500)
    const b = mount(matchId)
    await waitFor(() => expect(blocked(b)).toBe(true), { timeout: 5000 })
    await wait(500)
    expect(blocked(a)).toBe(false)
    expect(scoring(a)).toBe(true)
  }, 60000)

  it('a set end confirmed in another tab closes the Set end dialog and is not written again', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch({ home: 25, away: 22 })
    mount(matchId)
    const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => /Set 1 end/.test(d.textContent))
    await waitFor(() => expect(dialog()).toBeTruthy(), { timeout: 10000 })

    // the other tab confirms it: set 1 finished, its set_end, set 2
    const last = (await db.events.toArray()).reduce((m, e) => Math.max(m, e.seq), 0)
    const set1 = await db.sets.where({ matchId, index: 1 }).first()
    const now = new Date().toISOString()
    await db.transaction('rw', db.sets, db.events, async () => {
      await db.events.add({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', teamLabel: 'A', setIndex: 1, homePoints: 25, awayPoints: 22, endTime: now }, seq: last + 1, ts: now })
      await db.sets.update(set1.id, { finished: true, endTime: now })
      await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    })

    // this tab's dialog: gone; still open, its Confirm is what the scorer taps
    await waitFor(() => expect(dialog()).toBeFalsy(), { timeout: 3000 }).catch(() => {})
    if (dialog()) {
      await wait(GHOST_CLICK_MS)
      fireEvent.click(button('Confirm', dialog()))
      await wait(1500)
    }
    const setEnds = (await db.events.toArray()).filter(e => e.type === 'set_end')
    expect(setEnds).toHaveLength(1)
    expect((await db.sets.where({ matchId }).toArray()).filter(s => s.index === 2)).toHaveLength(1)
    expect(dialog()).toBeFalsy()
  }, 60000)
})
