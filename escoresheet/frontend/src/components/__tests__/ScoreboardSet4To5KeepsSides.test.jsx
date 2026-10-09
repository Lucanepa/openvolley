// From the end of set 4 to the set 5 setup the teams stay where set 4 ended
// (owner, 2026-10-09: "keep the teams where they were in set 4, in case we
// swap"). After sets 1-3 the teams change courts by the rule; after set 4
// they do not: the break and set 5 until its setup is confirmed show set 4's
// sides, a "Swap A/B" (a coin toss correction, it only re-labels the teams:
// 279752b2) in set 4 or in the break moves nobody, and the set 5 setup
// ("Switch sides", "Switch serve", Confirm) decides. Best-of-3: the same from
// the end of set 2 to the deciding set.
//
// Mismatches this found (each case below failed before its fix):
//  - the set end proposed a set 5 side left from an earlier end of set 4
//    (undone, or the set reopened) before set 4's own: after a "Switch sides"
//    in set 4 since, the teams changed courts into the break
//  - a match without a saved set 5 side in the break (restored by PIN, an
//    older match): the court showed set 4's sides, but "Switch sides" wrote
//    A left (no move when A was already there) and Confirm logged A left
//    (and the first server A, not the one the court showed)
//  - the set end's live state (referee, bench, livescore) took such a left-
//    over set 5 side too, until the setup's own push
//
// The real scoring screen (and the real Manual adjustments page for the swap)
// over the app's Dexie database (fake IndexedDB), its cloud live-state writes
// recorded. No relay socket.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'

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
import ManualAdjustments from '../ManualAdjustments'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { getSideAForSet } from '../../domain/rules'

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
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  upserts.length = 0
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
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
// a button by its text (the set 5 setup's "Switch sides" starts with ⇄)
const button = (text) => [...document.querySelectorAll('button')]
  .find(b => (text instanceof RegExp ? text.test(b.textContent.trim()) : b.textContent.trim().replace(/^⇄/, '') === text) && !b.disabled)
// a button whose text starts so (Manual adjustments: "Save changes (1)")
const buttonStarting = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)
const CONFIRM_SETUP = /^Confirm set \d setup$/
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)

// The scoring screen's team columns: "A-HOM" / "B-AWA" (letter, short name)
const homeOnLeftOnScreen = () => {
  const text = document.body.textContent
  const home = text.search(/[AB]-HOM/)
  const away = text.search(/[AB]-AWA/)
  if (home < 0 || away < 0) throw new Error('team columns not shown yet')
  return home < away
}
// The team the court has on the left in a set, as the match row says
const leftTeam = (m, set) => {
  const a = m.coinTossTeamA || 'home'
  return getSideAForSet(set, m) === 'left' ? a : (a === 'home' ? 'away' : 'home')
}
const liveStates = (type) => upserts.filter(u => u.table === 'match_live_state' && u.row.last_event_type === type).map(u => u.row)
// The home team's side in a live state row (its side_a is its own Team A's)
const homeLeftInLiveState = (row) => (row.side_a === 'left') === (row.team_a_name === 'Home VC')

const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// A match, team A home, home serving first. `won` the finished sets'
// winners, the current set (the next index; best-of-3 after 1:1: 5) at
// `points` [home, away] without its start. `extra`: match fields.
async function setUpMatch(won, points, extra = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWA' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, homeName: 'Home VC', awayName: 'Away VC', homeShortName: 'HOM', awayShortName: 'AWA',
    status: 'live', test: false, bestOf: 5,
    seed_key: 'match_set4_to_5', externalId: '11111111-2222-4333-8444-555555555555',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    ...extra
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  for (const [i, winner] of won.entries()) {
    const homeWins = winner === 'home'
    await db.sets.add({ matchId, index: i + 1, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: t })
  }
  const index = won.length + 1
  await db.sets.add({ matchId, index, homePoints: points[0], awayPoints: points[1], finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
  }
  return matchId
}

// The break before set 5 as a restore by PIN (or an older match) leaves it:
// sets 1-4 played, set 4 ended 30 s ago, set 5's row without its start and
// without a saved set 5 side
async function setUpBreak(extra = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWA' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, homeName: 'Home VC', awayName: 'Away VC', homeShortName: 'HOM', awayShortName: 'AWA',
    status: 'live', test: false, bestOf: 5, seed_key: 'match_set4_to_5_break',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    ...extra
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const end4 = new Date(Date.now() - 30000).toISOString()
  for (const index of [1, 2, 3, 4]) {
    const homeWins = index % 2 === 1
    await db.sets.add({ matchId, index, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: index === 4 ? end4 : t })
  }
  await db.sets.add({ matchId, index: 5, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
  await db.events.add({ matchId, setIndex: 4, type: 'set_end', payload: { setIndex: 4, winner: 'away' }, seq: 2, ts: end4 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// "Swap A/B" on the Manual adjustments page's Teams tab, saved
async function swapAB(matchId) {
  render(<AlertProvider><ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} /></AlertProvider>)
  const teamsTab = await screen.findByRole('radio', { name: 'Teams' }, { timeout: 10000 }).catch(() => screen.findByRole('button', { name: 'Teams' }))
  fireEvent.click(teamsTab)
  await waitFor(() => expect(buttonStarting('Swap A/B')).toBeTruthy(), { timeout: 10000 })
  const before = (await db.matches.get(matchId)).coinTossTeamA
  fireEvent.click(buttonStarting('Swap A/B'))
  await waitFor(() => expect(buttonStarting('Save changes')).toBeTruthy())
  fireEvent.click(buttonStarting('Save changes'))
  await waitFor(async () => expect((await db.matches.get(matchId)).coinTossTeamA).not.toBe(before), { timeout: 10000 })
  cleanup()
}

// Start the set, `label` scores its last point, the set end is confirmed:
// the break before set 5 (its setup panel), and the set end's live state
async function endSet(label) {
  await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button('Start set'))
  await waitFor(() => expect(button('Confirm')).toBeTruthy())
  fireEvent.click(button('Confirm'))
  await waitFor(() => expect(button(label)).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button(label))
  await waitFor(() => expect(document.body.textContent).toMatch(/Set \d end/))
  await settle()
  await waitFor(() => expect(button('Confirm')).toBeTruthy())
  fireEvent.click(button('Confirm'))
  await waitFor(() => expect(liveStates('set_end').length).toBeGreaterThan(0), { timeout: 15000 })
  await waitFor(() => expect(button(CONFIRM_SETUP)).toBeTruthy(), { timeout: 15000 })
  await settle()
  return liveStates('set_end').at(-1)
}

// The set 5 setup's "Switch sides": the teams change courts on the screen
async function setupSwitchSides(matchId) {
  const before = homeOnLeftOnScreen()
  fireEvent.click(button('Switch sides'))
  await waitFor(() => expect(homeOnLeftOnScreen()).toBe(!before))
  expect(leftTeam(await db.matches.get(matchId), 5) === 'home').toBe(!before)
  await settle()
}

// Confirm the set 5 setup: its event says which team is on the left, the
// panel goes, the court keeps the teams where the setup had them
async function confirmSetup(matchId, { homeLeft }) {
  fireEvent.click(button(CONFIRM_SETUP))
  await waitFor(async () => expect(await ofType('set5_coin_toss')).toHaveLength(1))
  await waitFor(() => expect(button(CONFIRM_SETUP)).toBeFalsy())
  const m = await db.matches.get(matchId)
  const toss = (await ofType('set5_coin_toss'))[0].payload
  expect(toss.leftTeamKey).toBe(homeLeft ? 'home' : 'away')
  expect(m.set5LeftTeam).toBe(toss.leftTeam)
  expect(m.set5CourtSwitched).toBeFalsy()
  expect(leftTeam(m, 5)).toBe(homeLeft ? 'home' : 'away')
  expect(homeOnLeftOnScreen()).toBe(homeLeft)
  await settle()
}

// Set 5 under way as confirmed: its line-ups and start, the leading team at
// 7, then (mounted again) the 8th point asks for the change of courts, which
// moves the teams
async function changeAt8(matchId, { homeLeft }) {
  cleanup()
  const t = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  let seq = Math.ceil(Math.max(...(await events()).map(e => e.seq || 0))) + 1
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 5, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
  }
  await db.events.add({ matchId, setIndex: 5, type: 'set_start', payload: {}, seq: seq++, ts: t })
  for (let i = 0; i < 7; i++) {
    const ts = new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
    await db.events.add({ matchId, setIndex: 5, type: 'rally_start', payload: {}, seq: seq++, ts })
    await db.events.add({ matchId, setIndex: 5, type: 'point', payload: { team: 'home' }, seq: seq++, ts })
  }
  const set5 = (await db.sets.toArray()).find(s => s.index === 5)
  await db.sets.update(set5.id, { homePoints: 7, awayPoints: 0, startTime: t })

  mount(matchId)
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
  expect(homeOnLeftOnScreen()).toBe(homeLeft)
  await settle()
  fireEvent.click(button('Start rally'))
  const homeLabel = (await db.matches.get(matchId)).coinTossTeamA === 'home' ? 'Point A' : 'Point B'
  await waitFor(() => expect(button(homeLabel)).toBeTruthy())
  await settle()
  fireEvent.click(button(homeLabel))
  await waitFor(() => expect(button('Switch courts')).toBeTruthy(), { timeout: 10000 })
  fireEvent.click(button('Switch courts'))
  await waitFor(async () => expect((await db.matches.get(matchId)).set5CourtSwitched).toBe(true))
  await waitFor(() => expect(homeOnLeftOnScreen()).toBe(!homeLeft))
  expect(leftTeam(await db.matches.get(matchId), 5)).toBe(homeLeft ? 'away' : 'home')
  cleanup()
}

describe('Set 4 -> set 5: the teams stay where set 4 ended until the set 5 setup is confirmed', () => {
  it('no saved set 4 side (home, A, on the right): break and setup on set 4\'s sides, "Switch sides" moves, confirmed as chosen, change at 8', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24])
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false), { timeout: 20000 })
    const state = await endSet('Point B')

    // the break: set 4's sides, here and in the live state (referee, livescore)
    expect(state.current_set).toBe(5)
    expect(homeLeftInLiveState(state)).toBe(false)
    const m = await db.matches.get(matchId)
    expect(m.set5LeftTeam).toBe('B')
    expect(m.set5CourtSwitched).toBe(false)
    expect(homeOnLeftOnScreen()).toBe(false)
    // the setup's push to the tablets too
    await waitFor(() => expect(liveStates('manual_set5_setup').length).toBeGreaterThan(0))
    expect(homeLeftInLiveState(liveStates('manual_set5_setup').at(-1))).toBe(false)

    // "Switch sides" moves them, twice back again, once more: home left
    await setupSwitchSides(matchId)
    await setupSwitchSides(matchId)
    await setupSwitchSides(matchId)
    await waitFor(() => expect(homeLeftInLiveState(liveStates('manual_set5_setup').at(-1))).toBe(true))

    await confirmSetup(matchId, { homeLeft: true })
    await changeAt8(matchId, { homeLeft: true })
  }, 150000)

  it('a saved set 4 side (home, A, on the left after a "Switch sides" in set 4): break, setup and set 5 keep it', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24], { setLeftTeamOverrides: { 4: 'A' } })
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(true), { timeout: 20000 })
    const state = await endSet('Point B')

    expect(homeLeftInLiveState(state)).toBe(true)
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('A')
    expect(homeOnLeftOnScreen()).toBe(true)

    await confirmSetup(matchId, { homeLeft: true })
    await changeAt8(matchId, { homeLeft: true })
  }, 150000)

  it('a set 5 setup left from an earlier end of set 4 (undone) and a "Switch sides" in set 4 since: the break keeps set 4\'s sides', async () => {
    // set 4 ended once with home (A) on the right (setup: B left), was
    // reopened, the teams changed courts (home left) and it ends again
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24], { setLeftTeamOverrides: { 4: 'A' }, set5LeftTeam: 'B', set5FirstServe: 'A' })
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(true), { timeout: 20000 })
    const state = await endSet('Point B')

    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('A')
    expect(homeOnLeftOnScreen()).toBe(true)
    // the tablets too: the set end's push and the setup's after it
    expect(state.current_set).toBe(5)
    expect(homeLeftInLiveState(state)).toBe(true)
    await waitFor(() => expect(homeLeftInLiveState(liveStates('manual_set5_setup').at(-1))).toBe(true))
    // the server of set 4's last rally (away, B), not the old setup's choice
    expect((await db.matches.get(matchId)).set5FirstServe).toBe('B')

    await confirmSetup(matchId, { homeLeft: true })
  }, 150000)

  it('"Swap A/B" in set 4: nobody moves, the break and set 5 keep set 4\'s sides (home on the right, now B)', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24])
    await swapAB(matchId)
    expect((await db.matches.get(matchId)).coinTossTeamA).toBe('away')
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false), { timeout: 20000 })
    expect(document.body.textContent).toMatch(/B-HOM/)
    // away (A now) wins set 4
    const state = await endSet('Point A')

    expect(homeLeftInLiveState(state)).toBe(false)
    const m = await db.matches.get(matchId)
    expect(m.set5LeftTeam).toBe('A') // away, A now, on the left
    expect(leftTeam(m, 5)).toBe('away')
    expect(homeOnLeftOnScreen()).toBe(false)

    await confirmSetup(matchId, { homeLeft: false })
    await changeAt8(matchId, { homeLeft: false })
  }, 150000)

  it('"Swap A/B" in the break: nobody moves; then "Switch sides" moves and the confirmed sides start set 5', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24])
    mount(matchId)
    await endSet('Point B')
    expect(homeOnLeftOnScreen()).toBe(false)
    cleanup()

    await swapAB(matchId)
    const m = await db.matches.get(matchId)
    expect(m.coinTossTeamA).toBe('away')
    // set 4 home left? no: away (A now) was and stays on the left, in set 5 too
    expect(leftTeam(m, 4)).toBe('away')
    expect(leftTeam(m, 5)).toBe('away')

    mount(matchId)
    await waitFor(() => expect(button(CONFIRM_SETUP)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false))
    expect(document.body.textContent).toMatch(/B-HOM/)
    await settle()

    await setupSwitchSides(matchId)
    await confirmSetup(matchId, { homeLeft: true })
    await changeAt8(matchId, { homeLeft: true })
  }, 150000)

  it('restored in the break without a set 5 side, A on the left in set 4: the court shows it, "Switch sides" moves the teams', async () => {
    const matchId = await setUpBreak({ setLeftTeamOverrides: { 4: 'A' } })
    mount(matchId)
    await waitFor(() => expect(button(CONFIRM_SETUP)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(true))
    await settle()

    await setupSwitchSides(matchId)
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('B')
    await confirmSetup(matchId, { homeLeft: false })

    // undoing the confirmation brings the setup back with the sides chosen,
    // nobody moves; "Switch sides" still moves, Confirm again
    fireEvent.click(button('Undo'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect(await ofType('set5_coin_toss')).toHaveLength(0))
    await waitFor(() => expect(button(CONFIRM_SETUP)).toBeTruthy(), { timeout: 5000 })
    expect(homeOnLeftOnScreen()).toBe(false)
    expect(leftTeam(await db.matches.get(matchId), 5)).toBe('away')
    await settle()
    await setupSwitchSides(matchId)
    await confirmSetup(matchId, { homeLeft: true })
  }, 90000)

  it('restored in the break without a set 5 side (set 4: home, A, on the right): Confirm starts set 5 as shown, the side and server written', async () => {
    const matchId = await setUpBreak()
    mount(matchId)
    await waitFor(() => expect(button(CONFIRM_SETUP)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false))
    await settle()

    await confirmSetup(matchId, { homeLeft: false })
    const m = await db.matches.get(matchId)
    expect(m.set5LeftTeam).toBe('B')
    // the server the court showed (set 1's, home: A)
    expect(m.set5FirstServe).toBe('A')
    expect((await ofType('set5_coin_toss'))[0].payload.firstServeTeamKey).toBe('home')
  }, 90000)
})

describe('Best-of-3: set 2 -> the deciding set keeps set 2\'s sides', () => {
  it('a saved set 2 side (home, A, on the left): the break and the setup keep it, "Switch sides" moves, confirmed as chosen', async () => {
    const matchId = await setUpMatch(['home'], [20, 24], { bestOf: 3, setLeftTeamOverrides: { 2: 'A' } })
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(true), { timeout: 20000 })
    const state = await endSet('Point B')

    expect(state.current_set).toBe(5)
    expect(homeLeftInLiveState(state)).toBe(true)
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('A')
    expect(homeOnLeftOnScreen()).toBe(true)

    await setupSwitchSides(matchId)
    await confirmSetup(matchId, { homeLeft: false })
  }, 150000)

  it('no saved side (home, A, on the right in set 2): the break keeps it', async () => {
    const matchId = await setUpMatch(['home'], [20, 24], { bestOf: 3 })
    mount(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false), { timeout: 20000 })
    const state = await endSet('Point B')
    expect(homeLeftInLiveState(state)).toBe(false)
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('B')
    expect(homeOnLeftOnScreen()).toBe(false)
    await confirmSetup(matchId, { homeLeft: false })
  }, 150000)
})

describe('The phone layout in the break before set 5', () => {
  // the phone's team cards: the left one first
  const homeOnLeftOnPhone = () => {
    const text = within(screen.getByTestId('phone-scoreboard')).getAllByText(/^[AB] · (HOM|AWA)$/).map(e => e.textContent)
    return text[0].includes('HOM')
  }

  it('shows set 4\'s sides (A on the left there), its "Switch sides" moves the teams, Confirm starts set 5 as shown', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    const matchId = await setUpBreak({ setLeftTeamOverrides: { 4: 'A' } })
    mount(matchId)
    await waitFor(() => expect(screen.getByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(button('Switch sides')).toBeTruthy())
    await waitFor(() => expect(homeOnLeftOnPhone()).toBe(true))
    await settle()

    fireEvent.click(button('Switch sides'))
    await waitFor(() => expect(homeOnLeftOnPhone()).toBe(false))
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('B')
    await settle()

    fireEvent.click(button(CONFIRM_SETUP))
    await waitFor(async () => expect(await ofType('set5_coin_toss')).toHaveLength(1))
    expect((await ofType('set5_coin_toss'))[0].payload.leftTeamKey).toBe('away')
    await waitFor(() => expect(button('Switch sides')).toBeFalsy())
    expect(homeOnLeftOnPhone()).toBe(false)
  }, 90000)
})
