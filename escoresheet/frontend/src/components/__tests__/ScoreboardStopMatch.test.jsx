// "Stop the match" > "Impossibility to resume", and a match that is over in
// the database (stopped or forfeited, then opened here: continued, restored,
// taken back):
//  - the stop is one action: its match_stopped event and the match row are
//    written together, a failed write says so and can be tried again (it
//    left the stop blocked until a reload), and no file of every match on
//    the device is downloaded (the encrypted backup of the match end stays);
//  - a match over in the database takes no rally and no point.
//  - "A team forfeits" is a default (FIVB 6.4.1-2): 0:3 with 0:25 in every
//    set, the set already played included; "A team is incomplete" (6.4.3)
//    keeps the team's points and sets.
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import en from '../../i18n/locales/en.json'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { setExtId } from '../../utils/syncIds'

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
  saved = {
    WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    width: window.innerWidth, height: window.innerHeight, createObjectURL: URL.createObjectURL
  }
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
  // a file download goes through an object URL
  URL.createObjectURL = vi.fn(() => 'blob:test')
})
afterEach(() => {
  URL.createObjectURL = saved.createObjectURL
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
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)
const mount = (matchId, props = {}) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} {...props} /></LoggingProvider></AlertProvider></ScaleProvider>)

const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// Set 2 at 3:2 (set 1 won by home), both line-ups in. `stopped`: the match was
// stopped for impossibility to resume on another device (status 'ended', its
// match_stopped event, set 2 left unfinished). `rallyInPlay`: the last event
// is a rally start.
async function setUpMatch({ stopped = false, rallyInPlay = false, seedKey = null } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 1 ? { isCaptain: true } : {}) })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    ...(seedKey ? { seed_key: seedKey } : {}),
    ...(stopped ? { status: 'ended', stoppedReason: 'impossibility_to_resume' } : { status: 'live' })
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: t })
  await db.sets.add({ matchId, index: 2, homePoints: 3, awayPoints: 2, finished: false, startTime: t })
  let seq = 1
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (const setIndex of [1, 2]) {
    for (const team of ['home', 'away']) ev.push({ matchId, setIndex, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex, type: 'set_start', payload: {}, seq: seq++, ts: t })
    const points = setIndex === 1 ? [...Array(20).fill('away'), ...Array(25).fill('home')] : ['away', 'away', 'home', 'home', 'home']
    for (const team of points) {
      ev.push({ matchId, setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex, type: 'point', payload: { team }, seq: seq++, ts: t })
    }
    if (setIndex === 1) ev.push({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 20 }, seq: seq++, ts: t })
  }
  if (stopped) ev.push({ matchId, setIndex: 2, type: 'match_stopped', payload: { reason: 'impossibility_to_resume', setIndex: 2, homePoints: 3, awayPoints: 2 }, seq: seq++, ts: t })
  if (rallyInPlay) ev.push({ matchId, setIndex: 2, type: 'rally_start', payload: {}, seq: seq++, ts: t })
  await db.events.bulkAdd(ev)
  return matchId
}

describe('a match over in the database, opened on the scoring screen', () => {
  it('stopped for impossibility to resume: Start rally records no rally', async () => {
    const matchId = await setUpMatch({ stopped: true })
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(button('Start rally'))
    await settle()
    await settle()
    expect((await ofType('rally_start')).length).toBe(rallies)
  }, 60000)

  it('a rally left in play: Point A records no point', async () => {
    const matchId = await setUpMatch({ stopped: true, rallyInPlay: true })
    mount(matchId)
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const points = (await ofType('point')).length
    fireEvent.click(button('Point A'))
    await settle()
    await settle()
    expect((await ofType('point')).length).toBe(points)
    const set2 = (await db.sets.toArray()).find(s => s.index === 2)
    expect([set2.homePoints, set2.awayPoints]).toEqual([3, 2])
  }, 60000)
})

describe('Stop the match > Impossibility to resume', () => {
  // Through the toolbar's Match menu to the last step ("End match")
  async function openEndMatchStep() {
    await waitFor(() => expect(document.querySelector('.match-toolbar')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const matchButton = await waitFor(() => {
      const b = document.querySelector('.match-toolbar button[title="Match"]')
      expect(b).toBeTruthy()
      return b
    }, { timeout: 5000 })
    fireEvent.click(matchButton)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: en.scoreboard.menu.stopMatch })))
    fireEvent.click(await waitFor(() => { const b = button(en.scoreboard.stopMatch.impossibilityToResume); expect(b).toBeTruthy(); return b }))
    fireEvent.click(await waitFor(() => { const b = button(en.scoreboard.stopMatch.continueToRemarks); expect(b).toBeTruthy(); return b }))
    // the remarks dialog: closed without a remark
    const close = await waitFor(() => { const b = document.querySelector('[data-modal-close]'); expect(b).toBeTruthy(); return b })
    fireEvent.click(close)
    return waitFor(() => { const b = button(en.scoreboard.stopMatch.endMatch); expect(b).toBeTruthy(); return b }, { timeout: 5000 })
  }

  it('ends the match without a winner and opens Match End; no file is downloaded', async () => {
    const matchId = await setUpMatch()
    const onFinishSet = vi.fn()
    mount(matchId, { onFinishSet })
    fireEvent.click(await openEndMatchStep())
    await waitFor(() => expect(onFinishSet).toHaveBeenCalled(), { timeout: 5000 })
    const stops = await ofType('match_stopped')
    expect(stops).toHaveLength(1)
    expect(stops[0].payload).toMatchObject({ reason: 'impossibility_to_resume', setIndex: 2, homePoints: 3, awayPoints: 2 })
    expect(await db.matches.get(matchId)).toMatchObject({ status: 'ended', stoppedReason: 'impossibility_to_resume' })
    // every match on the device, PINs and signatures included, went to Downloads
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  }, 60000)

  it('a failed write is said, nothing of the stop is kept, and End match works on the next tap', async () => {
    const matchId = await setUpMatch()
    const onFinishSet = vi.fn()
    mount(matchId, { onFinishSet })
    const endMatch = await openEndMatchStep()
    // the device's storage is full when the stop is written
    const realUpdate = db.matches.update.bind(db.matches)
    const update = vi.spyOn(db.matches, 'update').mockImplementation((key, changes) => {
      if (changes?.stoppedReason && update.mock.calls.filter(([, c]) => c?.stoppedReason).length === 1) {
        return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
      }
      return realUpdate(key, changes)
    })
    fireEvent.click(endMatch)
    await waitFor(() => expect(screen.getByText(en.scoreboard.storageFull)).toBeTruthy(), { timeout: 5000 })
    expect(onFinishSet).not.toHaveBeenCalled()
    expect(await ofType('match_stopped')).toHaveLength(0)
    expect((await db.matches.get(matchId)).status).toBe('live')

    // once space is free: the same step ends the match
    await settle()
    fireEvent.click(await waitFor(() => { const b = button(en.scoreboard.stopMatch.endMatch); expect(b).toBeTruthy(); return b }))
    await waitFor(() => expect(onFinishSet).toHaveBeenCalled(), { timeout: 5000 })
    expect(await ofType('match_stopped')).toHaveLength(1)
    expect((await db.matches.get(matchId)).status).toBe('ended')
    update.mockRestore()
  }, 60000)
})

describe('Stop the match > a team forfeits', () => {
  const SEED = 'match_1792931096817_stopmatch'
  // Match menu > Stop the match > `option` > the home team > remarks > End match
  async function forfeitHome(option) {
    await waitFor(() => expect(document.querySelector('.match-toolbar')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const matchButton = await waitFor(() => {
      const b = document.querySelector('.match-toolbar button[title="Match"]')
      expect(b).toBeTruthy()
      return b
    }, { timeout: 5000 })
    fireEvent.click(matchButton)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: en.scoreboard.menu.stopMatch })))
    fireEvent.click(await waitFor(() => { const b = button(option); expect(b).toBeTruthy(); return b }))
    fireEvent.click(await waitFor(() => { const b = button('Home VC (A)'); expect(b).toBeTruthy(); return b }))
    fireEvent.click(await waitFor(() => { const b = button(en.scoreboard.stopMatch.continueToRemarks); expect(b).toBeTruthy(); return b }))
    fireEvent.click(await waitFor(() => { const b = document.querySelector('[data-modal-close]'); expect(b).toBeTruthy(); return b }))
    fireEvent.click(await waitFor(() => { const b = button(en.scoreboard.stopMatch.endMatch); expect(b).toBeTruthy(); return b }, { timeout: 5000 }))
  }
  const setRows = async () => (await db.sets.toArray()).sort((a, b) => a.index - b.index)
    .map(s => `${s.index}:${s.homePoints}-${s.awayPoints}${s.finished ? 'F' : ''}`)

  it('a default after home won set 1: 0:3, 0:25 in every set, set 1 included; no point awarded', async () => {
    const matchId = await setUpMatch({ seedKey: SEED })
    const set1 = (await db.sets.toArray()).find(s => s.index === 1)
    const onFinishSet = vi.fn()
    mount(matchId, { onFinishSet })
    const points = (await ofType('point')).length
    await forfeitHome(en.scoreboard.stopMatch.teamForfeits)
    await waitFor(() => expect(onFinishSet).toHaveBeenCalled(), { timeout: 10000 })
    expect(await setRows()).toEqual(['1:0-25F', '2:0-25F', '3:0-25F'])
    // set 1 keeps its end; its own set end stays
    expect((await db.sets.get(set1.id)).endTime).toBe(set1.endTime)
    expect((await ofType('point')).length).toBe(points)
    const [forfait] = await ofType('forfait')
    expect(forfait.payload).toMatchObject({ team: 'home', reason: 'forfeit', scope: 'match', inDefault: true, setIndex: 2 })
    expect(forfait.payload.setsBefore).toEqual(expect.arrayContaining([
      { id: set1.id, index: 1, homePoints: 25, awayPoints: 20, finished: true, endTime: set1.endTime },
      expect.objectContaining({ index: 2, homePoints: 3, awayPoints: 2 })
    ]))
    // the cloud: set 1 corrected by its set id and the match key
    const jobs = (await db.sync_queue.toArray()).filter(j => j.resource === 'set' && j.payload?.external_id === setExtId(SEED, set1.id))
    expect(jobs.map(j => j.payload)).toEqual([{ home_points: 0, away_points: 25, external_id: setExtId(SEED, set1.id), match_id: SEED }])
  }, 60000)

  it('a team incomplete for the match keeps its points and sets (6.4.3)', async () => {
    const matchId = await setUpMatch({ seedKey: SEED })
    const onFinishSet = vi.fn()
    mount(matchId, { onFinishSet })
    await forfeitHome(en.scoreboard.stopMatch.teamIncomplete)
    await waitFor(() => expect(onFinishSet).toHaveBeenCalled(), { timeout: 10000 })
    expect(await setRows()).toEqual(['1:25-20F', '2:3-25F', '3:0-25F', '4:0-25F'])
    const [forfait] = await ofType('forfait')
    expect(forfait.payload).toMatchObject({ team: 'home', reason: 'incomplete', scope: 'match', inDefault: false })
  }, 60000)
})
