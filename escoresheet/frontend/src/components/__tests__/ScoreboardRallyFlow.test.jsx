// The rally and set flow of the scoring screen, read from the events in the
// database, not from what a set happens to contain:
//  - a penalty point before the first serve does not end a set's first-rally
//    phase (Start set: signatures, libero reminder, set start time, set_start)
//  - Start set (its key too) waits for both starting line-ups
//  - a side-out point is stored and queued with the line-up after its rotation
//  - a remark saved while the ball is in play does not end the rally
//  - a set end whose write failed can be confirmed again
//  - Reopen set forgets the set ends of the sets it deleted
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps and keys. Network is off.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
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

// As in ScoreboardAccidentalRallyStart.test.jsx: under jsdom + fake-indexeddb
// a scorer action can lose Dexie's transaction zone part-way and end with
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem('keybindingsEnabled')
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

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const findButton = (re) => [...document.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const INK = 'data:image/png;base64,AAAA'

async function teams({ away = [1, 2, 3, 4, 5, 6, 7, 8] } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const awayId = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (let n = 1; n <= 8; n++) players.push({ teamId: home, number: n, lastName: `H${n}`, firstName: 'X', isCaptain: n === 4 })
  for (const n of away) players.push({ teamId: awayId, number: n, lastName: `A${n}`, firstName: 'X', isCaptain: n === away[3] })
  await db.players.bulkAdd(players)
  return { home, away: awayId }
}

async function scorePointA() {
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
  await wait(GHOST_CLICK_MS + 600)
  fireEvent.click(button('Start rally'))
  await waitFor(() => expect(findButton(/^Point A/)).toBeTruthy(), { timeout: 5000 })
  await wait(GHOST_CLICK_MS + 600)
  fireEvent.click(findButton(/^Point A/))
}

describe('the first rally of a set', () => {
  // Official set 1, both line-ups in, no signature yet; the home team was
  // given a delay penalty before the first serve (its point to away)
  async function penaltyBeforeFirstServe() {
    const t = await teams()
    const matchId = await db.matches.add({
      homeTeamId: t.home, awayTeamId: t.away, status: 'live', test: false, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
      bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Coach' }], bench_away: []
    })
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const setId = await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 1, finished: false, startTime: null })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LINEUP, isInitial: true }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'delay_penalty' }, seq: 4, ts },
      { matchId, setIndex: 1, type: 'point', payload: { team: 'away', score: { home: 0, away: 1 }, penaltySeq: 4 }, seq: 5, ts }
    ])
    return { matchId, setId }
  }

  it('a penalty point before the first serve: Start set still asks for the signatures, no rally starts', async () => {
    const { matchId, setId } = await penaltyBeforeFirstServe()
    mount(matchId)
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 15000 })
    expect(button('Start rally')).toBeFalsy()
    await settle()
    fireEvent.click(button('Start set'))
    await screen.findByTestId('signatures-missing-modal', {}, { timeout: 5000 })
    expect(await ofType('rally_start')).toHaveLength(0)
    expect((await db.sets.get(setId)).startTime ?? null).toBeNull()
  }, 60000)

  it('Enter (keyboard scoring) does not start a set without its line-ups', async () => {
    localStorage.setItem('keybindingsEnabled', 'true')
    const t = await teams()
    const matchId = await db.matches.add({
      homeTeamId: t.home, awayTeamId: t.away, status: 'live', test: false, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
      homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: null })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: new Date().toISOString() })
    mount(matchId)
    await waitFor(() => expect([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start set')).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(document.body.textContent).toMatch(/Enter both starting line-ups first/), { timeout: 5000 })
    await wait(500)
    expect(screen.queryByText(/Set 1 start time/)).toBeNull()
    expect(await ofType('set_start')).toHaveLength(0)
    expect(await ofType('rally_start')).toHaveLength(0)
  }, 60000)
})

describe('a side-out point', () => {
  it('is stored and queued with the line-up after its rotation and the new server', async () => {
    const t = await teams({ away: [11, 12, 13, 14, 15, 16, 17, 18] })
    const matchId = await db.matches.add({
      homeTeamId: t.home, awayTeamId: t.away, status: 'live', test: false, bestOf: 5, seed_key: 'seed-rally-flow-1',
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
      homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
    })
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: ts })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }, isInitial: true }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts },
      { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts },
      { matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } }, seq: 6, ts }
    ])
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(findButton(/^Point B/)).toBeTruthy(), { timeout: 5000 })
    await wait(GHOST_CLICK_MS + 600)
    fireEvent.click(findButton(/^Point B/))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    await wait(500)
    const point = (await ofType('point')).sort((a, b) => b.seq - a.seq)[0]
    const rotation = (await ofType('lineup')).find(e => e.payload?.team === 'away' && Math.floor(e.seq) === point.seq)
    expect(rotation.payload.lineup.I).toBe('12')
    const job = (await db.sync_queue.toArray()).find(j => j.resource === 'event' && j.payload?.type === 'point' && j.payload?.seq === point.seq)
    expect(job.payload.serve_team).toBe('away')
    expect(job.payload.serve_player).toBe(12)
    expect(Number(job.payload.state_snapshot.serverNumber)).toBe(12)
    expect(Number(point.stateSnapshot.serverNumber)).toBe(12)
  }, 60000)
})

// A test match in set 1 at 24:0, rally not in play; set 2 and later as asked
async function setAt24(matchId, index, startSeq, ts) {
  let seq = startSeq
  const rows = []
  for (const team of ['home', 'away']) rows.push({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts })
  rows.push({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts })
  for (let h = 1; h <= 24; h++) {
    rows.push({ matchId, setIndex: index, type: 'rally_start', payload: {}, seq: seq++, ts })
    rows.push({ matchId, setIndex: index, type: 'point', payload: { team: 'home', score: { home: h, away: 0 } }, seq: seq++, ts })
  }
  await db.events.bulkAdd(rows)
  return seq
}
async function testMatch() {
  const t = await teams()
  return db.matches.add({
    homeTeamId: t.home, awayTeamId: t.away, status: 'live', test: true, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
  })
}

describe('a remark while the ball is in play', () => {
  it('leaves the rally in play: the Point buttons stay', async () => {
    const matchId = await testMatch()
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: ts })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LINEUP, isInitial: true }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts },
      { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts },
      { matchId, setIndex: 1, type: 'remark', payload: { text: 'Set 1 started 3 min late' }, seq: 6, ts }
    ])
    mount(matchId)
    await waitFor(() => expect(findButton(/^Point A/)).toBeTruthy(), { timeout: 15000 })
    expect(button('Start set')).toBeFalsy()
    expect(button('Start rally')).toBeFalsy()
  }, 60000)
})

describe('the set end', () => {
  it('a failed set end write says so and can be confirmed again', async () => {
    const matchId = await testMatch()
    const ts = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const setId = await db.sets.add({ matchId, index: 1, homePoints: 24, awayPoints: 0, finished: false, startTime: ts })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts })
    await setAt24(matchId, 1, 2, ts)
    const add = db.events.add.bind(db.events)
    let failures = 0
    vi.spyOn(db.events, 'add').mockImplementation((row, ...rest) => {
      if (row?.type === 'set_end' && failures === 0) { failures++; return Dexie.Promise.reject(new Error('write failed (test)')) }
      return add(row, ...rest)
    })
    mount(matchId)
    await scorePointA()
    await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 8000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(() => expect(document.body.textContent).toMatch(/The set end was not saved/), { timeout: 8000 })
    expect(failures).toBe(1)
    expect(document.body.textContent).not.toMatch(/Data saved locally/)
    // the dialog is back; Confirm now ends the set
    await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 8000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(async () => expect(await ofType('set_end')).toHaveLength(1), { timeout: 10000 })
    await waitFor(async () => expect(!!(await db.sets.get(setId)).finished).toBe(true), { timeout: 10000 })
  }, 90000)
})

describe('Reopen set', () => {
  const setsOf = async (matchId) => (await db.sets.where('matchId').equals(matchId).toArray()).sort((a, b) => a.index - b.index).map(s => `${s.index}:${s.homePoints}-${s.awayPoints}${s.finished ? 'F' : ''}`)
  const closeExtras = async () => {
    for (let i = 0; i < 5; i++) {
      const proceed = findButton(/^(Continue|Proceed|OK|Close)$/)
      if (!proceed) break
      fireEvent.click(proceed); await wait(400)
    }
  }

  it('of an earlier set: the later set it deleted, played again, can be ended', async () => {
    const matchId = await testMatch()
    const t1 = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    const t1e = new Date(Date.now() - 65 * 60 * 1000).toISOString()
    const t2 = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 0, finished: true, startTime: t1, endTime: t1e })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t1 })
    let seq = await setAt24(matchId, 1, 2, t1)
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t1 },
      { matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 25, away: 0 } }, seq: seq++, ts: t1 },
      { matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', teamLabel: 'A', setIndex: 1, homePoints: 25, awayPoints: 0, startTime: t1, endTime: t1e }, seq: seq++, ts: t1e }
    ])
    await db.sets.add({ matchId, index: 2, homePoints: 24, awayPoints: 0, finished: false, startTime: t2 })
    await setAt24(matchId, 2, seq, t2)
    mount(matchId)

    // set 2 ended on this screen
    await scorePointA()
    await waitFor(() => expect(dialog(/Set 2 end/)).toBeTruthy(), { timeout: 8000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(async () => expect((await setsOf(matchId)).some(s => s.startsWith('3:'))).toBe(true), { timeout: 10000 })
    await wait(2500)
    await closeExtras()

    // Match > Corrections > Reopen set 1
    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Match' || b.title === 'Match'))
    const item = () => [...document.querySelectorAll('button,[role="menuitem"]')].find(b => b.textContent.trim() === 'Corrections')
    await waitFor(() => expect(item()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(item())
    await waitFor(() => expect(findButton(/^Reopen set$/)).toBeTruthy(), { timeout: 5000 })
    fireEvent.click([...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Reopen set' && !b.disabled)[0])
    await waitFor(() => expect(dialog(/Reopen Set 1\?/)).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(findButton(/^Yes, reopen$/))
    await waitFor(async () => expect(await setsOf(matchId)).toEqual(['1:25-0']), { timeout: 8000 })

    // set 1 ended again: a new set 2
    await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 8000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(async () => expect(await setsOf(matchId)).toEqual(['1:25-0F', '2:0-0']), { timeout: 10000 })
    await wait(2500)
    await closeExtras()

    // the new set 2 played to 24:0, its 25th point here: it ends
    const set2 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 2)
    const next = Math.max(...(await db.events.toArray()).map(e => e.seq || 0)) + 1
    const t = new Date().toISOString()
    const existing2 = (await db.events.toArray()).filter(e => e.setIndex === 2)
    if (!existing2.some(e => e.type === 'lineup')) {
      await setAt24(matchId, 2, next, t)
    } else {
      let s2 = next
      const rows = []
      for (let h = 1; h <= 24; h++) {
        rows.push({ matchId, setIndex: 2, type: 'rally_start', payload: {}, seq: s2++, ts: t })
        rows.push({ matchId, setIndex: 2, type: 'point', payload: { team: 'home', score: { home: h, away: 0 } }, seq: s2++, ts: t })
      }
      await db.events.bulkAdd(rows)
    }
    await db.sets.update(set2.id, { homePoints: 24, startTime: set2.startTime || t })
    await wait(1500)
    await scorePointA()
    await waitFor(() => expect(dialog(/Set 2 end/)).toBeTruthy(), { timeout: 8000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(async () => expect((await ofType('set_end')).filter(e => e.setIndex === 2)).toHaveLength(1), { timeout: 10000 })
  }, 150000)
})

describe('the remarks box', () => {
  async function liveMatch() {
    const matchId = await testMatch()
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: ts })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LINEUP, isInitial: true }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts }
    ])
    return matchId
  }
  const openRemarks = async () => {
    fireEvent.click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Match' || b.title === 'Match'))
    const item = () => [...document.querySelectorAll('button,[role="menuitem"]')].find(b => b.textContent.trim() === 'Open remarks recording')
    await waitFor(() => expect(item()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(item())
    await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy(), { timeout: 5000 })
  }
  const closeButton = () => [...dialog(/Remarks recording/).querySelectorAll('button')].find(b => /close/i.test(b.getAttribute('aria-label') || b.title || b.textContent))

  it('a failed save is shown, and the dialog stays open with the text typed', async () => {
    const matchId = await liveMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await openRemarks()
    const update = db.matches.update.bind(db.matches)
    vi.spyOn(db.matches, 'update').mockImplementation((id, changes, ...rest) => {
      if (changes && 'remarks' in changes) return Dexie.Promise.reject(new Error('write failed (test)'))
      return update(id, changes, ...rest)
    })
    const box = document.querySelector('textarea')
    fireEvent.change(box, { target: { value: 'Match stopped: the hall lights failed' } })
    fireEvent.click(closeButton())
    await waitFor(() => expect(document.body.textContent).toMatch(/That was not saved/), { timeout: 5000 })
    await wait(300)
    expect(dialog(/Remarks recording/)).toBeTruthy()
    expect(document.querySelector('textarea').value).toBe('Match stopped: the hall lights failed')
    expect((await db.matches.get(matchId)).remarks ?? '').toBe('')

    // saved once the write works: remarks and their event, the dialog closes
    vi.restoreAllMocks()
    fireEvent.click(closeButton())
    await waitFor(async () => expect((await db.matches.get(matchId)).remarks).toBe('Match stopped: the hall lights failed'), { timeout: 5000 })
    await waitFor(() => expect(dialog(/Remarks recording/)).toBeFalsy(), { timeout: 5000 })
    expect(await ofType('remark')).toHaveLength(1)
  }, 60000)
})

describe('a bench player\'s injury', () => {
  async function liveMatch() {
    const matchId = await testMatch()
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: ts })
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LINEUP, isInitial: true }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts }
    ])
    return matchId
  }
  const openInjury = async () => {
    const bench = () => document.querySelector('[data-bench-player="7"][data-team="home"]')
    await waitFor(() => expect(bench()).toBeTruthy(), { timeout: 15000 })
    fireEvent.click(bench())
    const item = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Injury')
    await waitFor(() => expect(item()).toBeTruthy(), { timeout: 5000 })
    return item()
  }

  it('a double tap writes one remark line and one event', async () => {
    const matchId = await liveMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    const injury = await openInjury()
    fireEvent.click(injury)
    fireEvent.click(injury)
    await waitFor(async () => expect(await ofType('bench_injury')).toHaveLength(1), { timeout: 5000 })
    await wait(800)
    expect(await ofType('bench_injury')).toHaveLength(1)
    expect(((await db.matches.get(matchId)).remarks || '').split('\n').filter(l => /injured \(bench\)/.test(l))).toHaveLength(1)
  }, 60000)

  it('a failed write stores nothing and says so', async () => {
    const matchId = await liveMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    const injury = await openInjury()
    const add = db.events.add.bind(db.events)
    vi.spyOn(db.events, 'add').mockImplementation((row, ...rest) => {
      if (row?.type === 'bench_injury') return Dexie.Promise.reject(new Error('write failed (test)'))
      return add(row, ...rest)
    })
    fireEvent.click(injury)
    await waitFor(() => expect(document.body.textContent).toMatch(/That was not saved/), { timeout: 5000 })
    expect((await db.matches.get(matchId)).remarks || '').not.toMatch(/injured/)
  }, 60000)
})
