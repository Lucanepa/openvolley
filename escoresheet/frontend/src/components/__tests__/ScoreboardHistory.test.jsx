// Match menu > History on the real scoring screen (it replaced "Show action
// log"): the row opens the History with its two tabs, and "Corrections" goes
// on to the Manual changes panel. Over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'
import '../../i18n'
import en from '../../i18n/locales/en.json'
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
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// Set 1 at 3:2 with a substitution of home at 1:0 and a time-out of away
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 1 ? { isCaptain: true } : {}) })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, test: false, bestOf: 5, status: 'live',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 3, awayPoints: 2, finished: false, startTime: t })
  let seq = 1
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  ;['home', 'away', 'away', 'home', 'home'].forEach((team, i) => {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
    if (i === 0) {
      const s = seq++
      ev.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: '3', playerIn: '7', position: 'III' }, seq: s, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...LINEUP, III: '7' }, fromSubstitution: true }, seq: s + 0.1, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'timeout', payload: { team: 'away' }, seq: seq++, ts: t })
    }
  })
  await db.events.bulkAdd(ev)
  return matchId
}

async function openMatchMenuRow(name) {
  await waitFor(() => expect(document.querySelector('.match-toolbar')).toBeTruthy(), { timeout: 10000 })
  await settle()
  const matchButton = await waitFor(() => {
    const b = document.querySelector('.match-toolbar button[title="Match"]')
    expect(b).toBeTruthy()
    return b
  }, { timeout: 5000 })
  fireEvent.click(matchButton)
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name })))
}

describe('Match menu > History', () => {
  it('opens the History (both tabs); Corrections opens the Manual changes panel', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await openMatchMenuRow(en.history.menu)
    const history = await waitFor(() => screen.getByTestId('history'))
    const dialog = history.closest('[role="dialog"]')
    expect(within(dialog).getByRole('heading', { name: en.history.title })).toBeInTheDocument()
    // the five points, the substitution and the time-out as rows
    await waitFor(() => expect(dialog.querySelectorAll('[data-history-row="point"]')).toHaveLength(5))
    expect(dialog.querySelectorAll('[data-history-row="substitution"]')).toHaveLength(1)
    expect(dialog.querySelectorAll('[data-history-row="timeout"]')).toHaveLength(1)
    // Set information: the substitution of team A at 1:0, not back yet
    fireEvent.click(within(dialog).getByRole('radio', { name: en.history.tab.setInfo }))
    const subsA = within(dialog).getByTestId('history-subs-A')
    expect([...subsA.querySelectorAll('tbody td')].map(td => td.textContent)).toEqual(['1', '7', '3', '1:0', '–'])
    expect([...within(dialog).getByTestId('history-timeouts').querySelectorAll('tbody td')].map(td => td.textContent)).toEqual(['1', 'B', '0:1'])
    // one tap to the corrections
    fireEvent.click(within(within(dialog).getByTestId('history-footer')).getByRole('button', { name: en.corrections.title }))
    await waitFor(() => expect(screen.queryByTestId('history')).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { name: en.corrections.title })).toBeInTheDocument())
  }, 60000)
})
