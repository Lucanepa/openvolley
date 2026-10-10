// The team colours in the live state the scorer sends.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), its cloud live-state write recorded. No relay socket.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

const upserts = vi.hoisted(() => [])
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
        if (key === 'upsert') return (row) => { upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
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

// See ScoreboardSet5CourtSwitch.test.jsx: under jsdom + fake-indexeddb an
// action can lose Dexie's transaction zone part-way (PrematureCommitError);
// only that error is let through.
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
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  upserts.length = 0
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(async () => {
  cleanup()
  // The last point's live-state write still logs after the test has its row,
  // and the unmount logs too: let that out before the worker closes (with
  // vitest 4.1.11 a full run failed on "Closing rpc while onUserConsoleLog
  // was pending")
  await settle()
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

// A best-of-5 match in set 1, team A the AWAY team; `colours` the teams'
// own colours, the match itself without any (as a test match)
async function setUpMatch(colours) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', ...(colours ? { color: colours.home } : {}) })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', ...(colours ? { color: colours.away } : {}) })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    seed_key: 'match_live_colours_test', externalId: '11111111-2222-4333-8444-555555555556',
    firstServe: 'away', coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: true, coinTossServeB: false
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 3, awayPoints: 2, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const liveState = () => upserts.filter(u => u.table === 'match_live_state').at(-1)?.row

async function scorePoint() {
  await waitFor(() => { if (!button('Start set') && !button('Start rally')) throw new Error('not ready') }, { timeout: 10000 })
  await settle()
  if (button('Start set')) {
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy())
    fireEvent.click(button('Confirm'))
  } else {
    fireEvent.click(button('Start rally'))
  }
  await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button('Point A'))
  await waitFor(() => expect(liveState()).toBeTruthy(), { timeout: 15000 })
  return liveState()
}

// The live state the referee, the bench and the livescore read had the team
// colours of the match record only: a test match keeps its colours on the
// teams (and Manual Adjustments edits only the team), so those screens got
// none, and without any colour team A got red even when it is the away
// (blue) team. It now sends what the scorer's court shows.
describe('Scoreboard: the live state carries the colours the scorer\'s court shows', () => {
  it('colours only on the teams (a test match): team A (away) sends the away team\'s colour', async () => {
    const matchId = await setUpMatch({ home: '#22c55e', away: '#a855f7' })
    mount(matchId)
    const state = await scorePoint()
    expect(state.team_a_color).toBe('#a855f7')
    expect(state.team_b_color).toBe('#22c55e')
  }, 60000)

  it('no colour anywhere: team A (away) sends the away blue the court shows, not red', async () => {
    const matchId = await setUpMatch(null)
    mount(matchId)
    const state = await scorePoint()
    expect(state.team_a_color).toBe('#3b82f6')
    expect(state.team_b_color).toBe('#ef4444')
  }, 60000)
})
