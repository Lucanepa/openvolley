// Continuous play (Options › Point entry, owner 22.11.2026): no Start rally,
// Point A and Point B always on screen, a point needs a hold of about 2 s,
// and "Decision change / Replay" can also record a replayed rally.
//  - a held point writes the rally_start and the point in one action, and
//    Undo takes the two back; a short tap gives nothing ("Hold to give the
//    point")
//  - the dialog: three options, none chosen, short ("Replay", "Rally
//    replayed", owner 23.11.2026); "Rally replayed" records only the replay
//    (score and serve stay; time-outs closed until the next point, with no
//    "Replay pending" line); the other two as before
//  - after a replay the dialog offers "Point A" / "Point B" / "Rally
//    replayed": a point takes the replay's place (with its rally_start, a
//    side-out rotates), one Undo brings the replay back (owner 23.11.2026)
//  - Start rally's gates hold for the point that opens its rally: Start set
//    first, no player sent off on court
//  - the scoring keys hold too; Enter starts only the set
//  - switched during a rally: the point writes only the point
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with pointer presses and keys. Network is off.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { POINT_HOLD_MS, resetHoldsForTests } from '../../hooks/useHoldToConfirm'
import { RALLY_MODE_KEY } from '../../utils/rallyMode'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardRallyFlow.test.jsx: under jsdom + fake-indexeddb a scorer
// action can lose Dexie's transaction zone part-way and end with
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
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  resetHoldsForTests()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  localStorage.removeItem('displayMode')
  localStorage.setItem(RALLY_MODE_KEY, 'continuous')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem('keybindingsEnabled')
  localStorage.removeItem(RALLY_MODE_KEY)
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
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(GHOST_CLICK_MS + 150)
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const holdButton = (letter) => screen.queryByRole('button', { name: new RegExp(`^Point ${letter}, hold for ${POINT_HOLD_MS / 1000} seconds$`) })
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const labelOf = (radio) => radio.querySelector('[data-decision-label]').textContent.trim()
// What a decision option gives, on its card: { score: 'home:away', serve }
const outcomeOf = (option) => {
  const el = screen.getByTestId(`decision-outcome-${option}`)
  return { score: el.querySelector('[data-score]').getAttribute('data-score'), serve: el.getAttribute('data-serve') }
}
const currentScore = () => screen.getByTestId('decision-current').querySelector('[data-score]').getAttribute('data-score')
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const AWAY_LINEUP = { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }
const INK = 'data:image/png;base64,AAAA'

// A press of `ms` on the button, as a finger: down, (hold), up
async function press(el, ms) {
  const at = el.getBoundingClientRect()
  const where = { pointerId: 1, pointerType: 'touch', button: 0, clientX: at.left + 5, clientY: at.top + 5 }
  fireEvent.pointerDown(el, where)
  await wait(ms)
  fireEvent.pointerUp(el, where)
}
const hold = (el) => press(el, POINT_HOLD_MS + 200)

// Set 1 under way at 1:0 (home served and scored), both line-ups in,
// signed; optional extra events after the point
async function matchAfterOnePoint(extra = []) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (let n = 1; n <= 8; n++) players.push({ teamId: home, number: n, lastName: `H${n}`, firstName: 'X', isCaptain: n === 4 })
  for (let n = 11; n <= 18; n++) players.push({ teamId: away, number: n, lastName: `A${n}`, firstName: 'X', isCaptain: n === 14 })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, seed_key: 'seed-continuous-1',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
  })
  const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const setId = await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: ts })
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: 3, ts },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } }, seq: 6, ts },
    ...extra.map((e, i) => ({ matchId, setIndex: 1, ts, seq: 7 + i, ...e }))
  ])
  return { matchId, setId }
}

describe('continuous play: Point A and Point B, held', () => {
  it('no Start rally; a short tap gives nothing, a hold gives the point with its rally_start, Undo takes both back', async () => {
    const { matchId, setId } = await matchAfterOnePoint()
    mount(matchId)
    await waitFor(() => expect(holdButton('B')).toBeTruthy(), { timeout: 15000 })
    expect(button('Start rally')).toBeFalsy()
    expect(holdButton('A').textContent).toContain('Hold')
    expect(holdButton('A').className).toContain('hold-hint')
    await settle()

    // a tap: nothing, and the screen says to hold
    await press(holdButton('B'), 150)
    await waitFor(() => expect(screen.getByTestId('rally-tap-notice').textContent).toBe('Hold to give the point'), { timeout: 5000 })
    await wait(300)
    expect(await ofType('point')).toHaveLength(1)
    expect(await ofType('rally_start')).toHaveLength(1)

    // a hold: the rally's start, then its point, in that order
    await hold(holdButton('B'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    const [start, point] = (await events()).filter(e => e.type === 'rally_start' || e.type === 'point').slice(-2)
    expect(start).toMatchObject({ type: 'rally_start', payload: { continuous: true } })
    expect(point).toMatchObject({ type: 'point', payload: { team: 'away' } })
    expect(point.seq).toBeGreaterThan(start.seq)
    expect((await db.sets.get(setId)).awayPoints).toBe(1)
    // still the point buttons, no Start rally
    await waitFor(() => expect(holdButton('A')).toBeTruthy(), { timeout: 5000 })
    expect(button('Start rally')).toBeFalsy()

    // Undo: the point and its rally_start; the older rally's start stays
    await settle()
    fireEvent.click(button('Undo'))
    await waitFor(() => expect(dialog(/undo/i)).toBeTruthy(), { timeout: 5000 })
    fireEvent.click([...dialog(/undo/i).querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('rally_start')).map(e => e.seq)).toEqual([5])
    await waitFor(async () => expect((await db.sets.get(setId)).awayPoints).toBe(0), { timeout: 5000 })
  }, 60000)

  it('the scoring keys hold too (A / L); Enter starts no rally between rallies', async () => {
    localStorage.setItem('keybindingsEnabled', 'true')
    const { matchId } = await matchAfterOnePoint()
    mount(matchId)
    await waitFor(() => expect(holdButton('A')).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.keyDown(window, { key: 'Enter' })
    await wait(400)
    expect(await ofType('rally_start')).toHaveLength(1)
    // a short press of the key: nothing
    fireEvent.keyDown(window, { key: 'a' })
    await wait(300)
    fireEvent.keyUp(window, { key: 'a' })
    await wait(POINT_HOLD_MS)
    expect(await ofType('point')).toHaveLength(1)
    // held: the point (the key's repeats ignored)
    fireEvent.keyDown(window, { key: 'a' })
    await wait(500)
    fireEvent.keyDown(window, { key: 'a', repeat: true })
    await wait(POINT_HOLD_MS - 300)
    fireEvent.keyUp(window, { key: 'a' })
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    expect((await ofType('point')).pop().payload.team).toBe('home')
    expect(await ofType('rally_start')).toHaveLength(2)
  }, 60000)
})

describe('continuous play: Decision change / Replay', () => {
  it('three options, none chosen; "Rally replayed" records only the replay and closes the time-outs until the next point, with no line saying so', async () => {
    const { matchId, setId } = await matchAfterOnePoint()
    mount(matchId)
    await waitFor(() => expect(screen.getByTestId('decision-replay-button')).toBeTruthy(), { timeout: 15000 })
    expect(screen.getByTestId('decision-replay-button').textContent).toBe('Decision change / Replay')
    await settle()
    fireEvent.click(screen.getByTestId('decision-replay-button'))
    await waitFor(() => expect(dialog(/Decision change \/ Replay/)).toBeTruthy(), { timeout: 5000 })
    const radios = [...dialog(/Decision change \/ Replay/).querySelectorAll('[role="radio"]')]
    expect(radios.map(r => r.getAttribute('data-decision-option'))).toEqual(['swap', 'replay', 'record_replay'])
    expect(radios.map(labelOf)).toEqual(['Assign to other team', 'Replay', 'Rally replayed'])
    expect(radios.every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)
    // nothing chosen, and each option already shows the score and serve it
    // gives (owner 23.11.2026); "Rally replayed" keeps both
    expect(currentScore()).toBe('1:0')
    expect(outcomeOf('swap')).toEqual({ score: '0:1', serve: 'away' })
    expect(outcomeOf('replay')).toEqual({ score: '0:0', serve: 'home' })
    expect(outcomeOf('record_replay')).toEqual({ score: '1:0', serve: 'home' })
    const confirm = () => [...dialog(/Decision change \/ Replay/).querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm')
    expect(confirm().disabled).toBe(true)
    // Enter does nothing while nothing is chosen
    fireEvent.keyDown(window, { key: 'Enter' })
    await wait(300)
    expect(dialog(/Decision change \/ Replay/)).toBeTruthy()

    fireEvent.click(radios[2])
    await waitFor(() => expect(confirm().disabled).toBe(false), { timeout: 5000 })
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(confirm())
    await waitFor(async () => expect(await ofType('replay')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('replay'))[0].payload).toEqual({ reason: 'continuous' })
    expect(await ofType('rally_start')).toHaveLength(1)
    expect(await ofType('point')).toHaveLength(1)
    const set = await db.sets.get(setId)
    expect([set.homePoints, set.awayPoints]).toEqual([1, 0])
    // replay pending: no regular time-out or substitution until the next
    // point, and no "Replay pending" line under the boxes (owner 23.11.2026)
    await waitFor(() => expect(screen.queryByTestId('timeout-tap-hint-left')).toBeNull(), { timeout: 5000 })
    expect(screen.queryByTestId('timeout-tap-hint-right')).toBeNull()
    expect(screen.queryByTestId('request-block-left')).toBeNull()
    expect(screen.queryByTestId('request-block-right')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Replay pending/)

    // the next point completes the replayed rally: time-outs open again
    await settle()
    await hold(holdButton('A'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    await waitFor(() => expect(screen.getByTestId('timeout-tap-hint-left')).toBeTruthy(), { timeout: 5000 })
  }, 60000)

  it('after "Rally replayed": Point B gives that rally to B (its rally_start, a side-out rotation), "Rally replayed" again records a second replay, one Undo brings the replay back', async () => {
    // 1:0, home served and scored; the rally since was replayed
    const { matchId, setId } = await matchAfterOnePoint([{ type: 'replay', payload: { reason: 'continuous' } }])
    mount(matchId)
    await waitFor(() => expect(screen.getByTestId('decision-replay-button')).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(screen.queryByTestId('timeout-tap-hint-left')).toBeNull(), { timeout: 5000 })
    await settle()
    const open = async () => {
      fireEvent.click(screen.getByTestId('decision-replay-button'))
      await waitFor(() => expect(dialog(/Decision change \/ Replay/)).toBeTruthy(), { timeout: 5000 })
      return [...dialog(/Decision change \/ Replay/).querySelectorAll('[role="radio"]')]
    }
    const confirm = () => [...dialog(/Decision change \/ Replay/).querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm')

    // "Rally replayed" again: the rally played since was replayed too
    let radios = await open()
    expect(screen.getByTestId('decision-last-replay').textContent).toBe('The last rally was replayed')
    expect(radios.map(r => r.getAttribute('data-decision-option'))).toEqual(['point_home', 'point_away', 'record_replay'])
    expect(radios.map(labelOf)).toEqual(['Point A', 'Point B', 'Rally replayed'])
    expect(radios.every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(confirm().disabled).toBe(true)
    expect(currentScore()).toBe('1:0')
    expect(outcomeOf('point_home')).toEqual({ score: '2:0', serve: 'home' })
    expect(outcomeOf('point_away')).toEqual({ score: '1:1', serve: 'away' })
    expect(outcomeOf('record_replay')).toEqual({ score: '1:0', serve: 'home' })
    fireEvent.click(radios[2])
    await waitFor(() => expect(confirm().disabled).toBe(false), { timeout: 5000 })
    await settle()
    fireEvent.click(confirm())
    await waitFor(async () => expect(await ofType('replay')).toHaveLength(2), { timeout: 5000 })
    await waitFor(() => expect(dialog(/Decision change \/ Replay/)).toBeFalsy(), { timeout: 5000 })
    const replay = (await ofType('replay')).at(-1)
    await settle()

    // Point B: the replayed rally to B
    radios = await open()
    expect(outcomeOf('point_away')).toEqual({ score: '1:1', serve: 'away' })
    fireEvent.click(radios[1])
    await waitFor(() => expect(radios[1].getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    await settle()
    fireEvent.click(confirm())
    await waitFor(async () => expect((await ofType('point')).at(-1)._replacedReplay).toBeTruthy(), { timeout: 5000 })
    expect(await ofType('point')).toHaveLength(2)
    expect((await ofType('replay')).map(e => e.id)).not.toContain(replay.id)
    expect(await ofType('replay')).toHaveLength(1)
    const [start, point] = (await events()).filter(e => e.type === 'rally_start' || e.type === 'point').slice(-2)
    expect(start).toMatchObject({ type: 'rally_start', payload: { continuous: true } })
    expect(point).toMatchObject({ type: 'point', payload: { team: 'away' } })
    expect(start.seq).toBeGreaterThan(replay.seq)
    expect(point._replacedReplay).toMatchObject({ id: replay.id, seq: replay.seq })
    const set = await db.sets.get(setId)
    expect([set.homePoints, set.awayPoints]).toEqual([1, 1])
    // a side-out: away rotated
    expect((await ofType('lineup')).filter(e => e.payload.team === 'away').at(-1).payload.lineup).toMatchObject({ I: '12', VI: '11' })
    // the replay pending is over
    await waitFor(() => expect(screen.getByTestId('timeout-tap-hint-left')).toBeTruthy(), { timeout: 5000 })

    // one Undo: the point and the rally_start it wrote go, the replay comes back
    await settle()
    fireEvent.click(button('Undo'))
    await waitFor(() => expect(dialog(/undo/i)).toBeTruthy(), { timeout: 5000 })
    fireEvent.click([...dialog(/undo/i).querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('replay')).map(e => e.id)).toContain(replay.id)
    expect((await ofType('rally_start')).map(e => e.seq)).toEqual([5])
    await waitFor(async () => {
      const after = await db.sets.get(setId)
      expect([after.homePoints, after.awayPoints]).toEqual([1, 0])
    }, { timeout: 5000 })
    expect((await ofType('lineup')).filter(e => e.payload.team === 'away').at(-1).payload.lineup).toEqual(AWAY_LINEUP)
    await waitFor(() => expect(screen.queryByTestId('timeout-tap-hint-left')).toBeNull(), { timeout: 5000 })
  }, 90000)

  it('"Assign to other team" and "Replay" work as before; the replay preview serves the rally\'s server after a side-out', async () => {
    // away won the second rally on home's serve (a side-out): 1:1
    const { matchId, setId } = await matchAfterOnePoint([
      { type: 'rally_start', payload: { continuous: true } },
      { type: 'point', payload: { team: 'away', score: { home: 1, away: 1 } } },
      { type: 'lineup', payload: { team: 'away', lineup: { ...AWAY_LINEUP, I: '12', II: '13', III: '14', IV: '15', V: '16', VI: '11' } }, seq: 8.1 }
    ])
    await db.sets.update(setId, { awayPoints: 1 })
    mount(matchId)
    await waitFor(() => expect(screen.getByTestId('decision-replay-button')).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(screen.getByTestId('decision-replay-button'))
    await waitFor(() => expect(dialog(/Decision change \/ Replay/)).toBeTruthy(), { timeout: 5000 })
    const radio = (option) => dialog(/Decision change \/ Replay/).querySelector(`[data-decision-option="${option}"]`)
    // home served the replayed rally: home serves it again (the preview said away)
    expect(outcomeOf('replay')).toEqual({ score: '1:0', serve: 'home' })
    expect(outcomeOf('swap')).toEqual({ score: '2:0', serve: 'home' })
    fireEvent.click(radio('replay'))
    await waitFor(() => expect(radio('replay').getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    fireEvent.click(radio('swap'))
    await waitFor(() => expect(radio('swap').getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    fireEvent.click([...dialog(/Decision change \/ Replay/).querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => {
      const set = await db.sets.get(setId)
      expect([set.homePoints, set.awayPoints]).toEqual([2, 0])
    }, { timeout: 5000 })
    expect((await ofType('point')).map(p => p.payload.team)).toEqual(['home', 'home'])
    expect(await ofType('replay')).toHaveLength(0)
  }, 60000)
})

describe("continuous play: Start rally's gates", () => {
  it('the first rally of a set starts with Start set: no point buttons, no Decision change / Replay before', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const players = []
    for (let n = 1; n <= 8; n++) players.push({ teamId: home, number: n, lastName: `H${n}`, firstName: 'X' })
    for (let n = 11; n <= 18; n++) players.push({ teamId: away, number: n, lastName: `A${n}`, firstName: 'X' })
    await db.players.bulkAdd(players)
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
      homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
    })
    const ts = new Date().toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: null })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: 3, ts }
    ])
    mount(matchId)
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 15000 })
    expect(holdButton('A')).toBeNull()
    expect(screen.getByTestId('decision-replay-button').disabled).toBe(true)
  }, 60000)

  it('a player on court expelled in this set: the hold gives no point (his substitution first)', async () => {
    const { matchId } = await matchAfterOnePoint([
      { type: 'sanction', payload: { team: 'home', type: 'expulsion', playerNumber: 3 } }
    ])
    mount(matchId)
    await waitFor(() => expect(holdButton('A')).toBeTruthy(), { timeout: 15000 })
    await settle()
    await hold(holdButton('A'))
    await waitFor(() => expect(document.body.textContent).toMatch(/#3 is expelled or disqualified and still on court/), { timeout: 5000 })
    await wait(300)
    expect(await ofType('point')).toHaveLength(1)
    expect(await ofType('rally_start')).toHaveLength(1)
  }, 60000)

  it('switched to continuous play during a rally: the point writes only the point', async () => {
    const { matchId } = await matchAfterOnePoint([{ type: 'rally_start', payload: {} }])
    mount(matchId)
    await waitFor(() => expect(holdButton('A')).toBeTruthy(), { timeout: 15000 })
    await settle()
    await hold(holdButton('A'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    expect(await ofType('rally_start')).toHaveLength(2)
  }, 60000)
})
