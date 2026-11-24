// The bench player's action menu offers only the substitutions the rules
// allow (the starter-substitute pairing, FIVB 15.6.2), as the court player's
// menu does: a bench player who never played may come in for a starter, not
// for a substitute (only the starter that substitute replaced may come back
// for him). Such a court player is not offered (owner 17.11: no "Not allowed"
// list); an illegal substitution request is recorded from the team's Improper
// request dialog: rejected, a delay on the delay ladder (16.1.3, 16.2).
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
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

// As in ScoreboardInterruptionFlows.test.jsx: under jsdom + fake-indexeddb a
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
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)

// Set 1 at 3:3, both line-ups 1-6, 12 players a team (no libero). #9 of the
// home team came in for the starter #5 (position V), and rallies were played
// since: #9 may go out again, but only for #5
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 12; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 3, awayPoints: 3, finished: false, startTime: t })
  let seq = 1
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'away']) {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
  }
  const subAt = seq++
  ev.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', position: 'V', playerOut: 5, playerIn: 9, isExceptional: false }, seq: subAt, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...lineup, V: '9' }, fromSubstitution: true }, seq: subAt + 0.1, ts: t })
  for (const team of ['away', 'home', 'away', 'home']) {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
  }
  await db.events.bulkAdd(ev)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const benchChip = (number) => document.querySelector(`[data-bench-player="${number}"][data-team="home"][data-is-libero="false"]`)
const benchMenu = () => document.querySelector('[data-bench-player-action-menu]')

// The screen is up, then bench #12's menu with its substitution list open
async function openBenchSubstitutions(matchId) {
  mount(matchId)
  await waitFor(() => expect(document.querySelector('.court-player[data-team="home"][data-player-number="9"]')).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
  await waitFor(() => expect(benchChip(12)).toBeTruthy())
  fireEvent.click(benchChip(12))
  await waitFor(() => expect(benchMenu()).toBeTruthy())
  fireEvent.click(button('Substitution', benchMenu()))
  await waitFor(() => expect(substitutionChips().length).toBeGreaterThan(0))
}

// The court players offered as chips under "Substitution" (numbers only)
const substitutionChips = () => [...benchMenu().querySelectorAll('button')]
  .map(b => b.textContent.trim())
  .filter(text => /^\d+$/.test(text))

describe('Scoreboard: the bench menu keeps the starter-substitute pairing (FIVB 15.6.2)', () => {
  it('a bench player who never played is not offered for a substitute on court, and the menu has no "Not allowed" list (owner 17.11)', async () => {
    const matchId = await setUpMatch()
    await openBenchSubstitutions(matchId)
    // #12 may come in for the starters, not for #9 (who came in for #5)
    expect(substitutionChips()).toEqual(['1', '2', '3', '4', '6'])
    expect(benchMenu().textContent).not.toContain('Not allowed')
    expect(screen.queryByTestId('bench-menu-illegal-toggle')).toBeNull()
    expect(screen.queryByTestId('bench-menu-illegal-9')).toBeNull()
  }, 60000)

  it('the team\'s Improper request records an illegal substitution request: rejected, a delay warning, no improper request', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Improper request'))
    const dialog = await waitFor(() => screen.getByTestId('team-sanction-confirm'))
    expect(dialog.textContent).toContain('What did the team request?')
    // an improper request until the scorer says otherwise
    expect(screen.getByTestId('ir-kind-improper').getAttribute('aria-pressed')).toBe('true')
    expect(dialog.textContent).toContain('Record an improper request for')
    fireEvent.click(screen.getByTestId('ir-kind-illegal'))
    await waitFor(() => expect(screen.getByTestId('ir-kind-illegal').getAttribute('aria-pressed')).toBe('true'))
    expect(dialog.textContent).toContain('Requesting an illegal substitution is a delay: the request is rejected.')
    expect(dialog.textContent).toContain('FIVB 15.10.4 · 16.1.3')
    expect(dialog.textContent).toContain('Record a delay warning for')
    await settle()
    fireEvent.click(button('Yes', dialog))
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })
    const sanction = (await ofType('sanction'))[0].payload
    expect(sanction.type).toBe('delay_warning')
    const match = await db.matches.get(matchId)
    expect(match.sanctions?.improperRequestHome).toBeFalsy()
    expect(match.sanctions?.improperRequestAway).toBeFalsy()
    expect(match.sanctions?.[sanction.team === 'home' ? 'delayWarningHome' : 'delayWarningAway']).toBe(true)
    // nothing else: #9 stays on court
    expect(await ofType('substitution')).toHaveLength(1)
  }, 60000)

  it('the same choice after a delay warning is a delay penalty (16.2)', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    // the first illegal request: a delay warning
    fireEvent.click(button('Improper request'))
    let dialog = await waitFor(() => screen.getByTestId('team-sanction-confirm'))
    fireEvent.click(screen.getByTestId('ir-kind-illegal'))
    await settle()
    fireEvent.click(button('Yes', dialog))
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })
    const team = (await ofType('sanction'))[0].payload.team
    await waitFor(() => expect(screen.queryByTestId('team-sanction-confirm')).toBeNull())
    await settle()
    // the same team again (its Improper request button is the first one still there)
    fireEvent.click(button('Improper request'))
    dialog = await waitFor(() => screen.getByTestId('team-sanction-confirm'))
    fireEvent.click(screen.getByTestId('ir-kind-illegal'))
    await waitFor(() => expect(dialog.textContent).toContain('Record a delay penalty for'))
    expect(dialog.textContent).toContain('The team already has a delay warning, so this delay is a penalty.')
    await settle()
    fireEvent.click(button('Yes', dialog))
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(2), { timeout: 5000 })
    expect((await ofType('sanction'))[1].payload).toMatchObject({ team, type: 'delay_penalty' })
  }, 60000)

  it('"Improper request" in that dialog still records the improper request', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Improper request'))
    const dialog = await waitFor(() => screen.getByTestId('team-sanction-confirm'))
    fireEvent.click(screen.getByTestId('ir-kind-illegal'))
    fireEvent.click(screen.getByTestId('ir-kind-improper'))
    await waitFor(() => expect(dialog.textContent).toContain('Record an improper request for'))
    await settle()
    fireEvent.click(button('Yes', dialog))
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('sanction'))[0].payload.type).toBe('improper_request')
  }, 60000)

  it('a legal pair from the same list is still recorded: #12 in for the starter #4', async () => {
    const matchId = await setUpMatch()
    await openBenchSubstitutions(matchId)
    fireEvent.click(button('4', benchMenu()))
    const confirm = () => [...document.querySelectorAll('[role="dialog"]')].find(d => button('Yes', d))
    await waitFor(() => expect(confirm()).toBeTruthy())
    await settle()
    fireEvent.click(button('Yes', confirm()))
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(2), { timeout: 5000 })
    const last = (await ofType('substitution')).at(-1).payload
    expect(String(last.playerOut)).toBe('4')
    expect(String(last.playerIn)).toBe('12')
    expect(!!last.isExceptional).toBe(false)
    expect(await ofType('sanction')).toHaveLength(0)
  }, 60000)
})
