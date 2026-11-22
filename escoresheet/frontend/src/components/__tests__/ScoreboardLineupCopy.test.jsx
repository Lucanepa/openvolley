// "Last set's line-up" (owner 2026-11-22): the line-up dialog fills the six
// with the STARTING line-up of the previous set, or of any earlier set, as a
// pre-fill only: the six are checked as if typed (a player out of the match
// is flagged), Undo last edit puts back what was there, nothing is saved
// before Confirm, and the game-captain choice (with "Keep as game captain")
// works on the copied six. The real scoring screen over the app's Dexie
// database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let saved
beforeAll(() => {
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => cleanup())
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const dialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('input[aria-label="Player at position I"]')) || null
const box = (pos) => dialog().querySelector(`input[aria-label="Player at position ${pos}"]`)
const six = () => ['I', 'II', 'III', 'IV', 'V', 'VI'].map(p => box(p).value)
const copyButton = (setIndex) => dialog().querySelector(`[data-testid="lineup-copy"] [data-copy-set="${setIndex}"]`)
const button = (text) => [...dialog().querySelectorAll('button')].find(b => b.textContent.trim().endsWith(text))
const lu = (a) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p, i) => [p, String(a[i])]))

// A match in set `current` (the earlier sets finished): per earlier set the
// home team's starting six, then in set 1 a point, a rotation and a
// substitution (#3 out, #9 in) with their line-up rows; `extra` events after.
async function openLineupInSet({ current, starts, captain = 1, match = {}, extra = [] }) {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === captain },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', ...match
  })
  const t = new Date(Date.now() - 3600000).toISOString()
  let seq = 1
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (let i = 1; i < current; i++) {
    await db.sets.add({ matchId, index: i, homePoints: 25, awayPoints: 20, finished: true })
    ev.push({ matchId, setIndex: i, type: 'lineup', payload: { team: 'home', lineup: lu(starts[i - 1]), isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: i, type: 'lineup', payload: { team: 'away', lineup: lu([1, 2, 3, 4, 5, 6]), isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: i, type: 'set_start', payload: {}, seq: seq++, ts: t })
    const p = seq++
    ev.push({ matchId, setIndex: i, type: 'point', payload: { team: 'home' }, seq: p, ts: t })
    const s = starts[i - 1]
    ev.push({ matchId, setIndex: i, type: 'lineup', payload: { team: 'home', lineup: lu([s[1], s[2], s[3], s[4], s[5], s[0]]), fromRotation: true }, seq: p + 0.1, ts: t })
    if (i === 1) {
      const q = seq++
      ev.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 9 }, seq: q, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: lu([2, 9, 4, 5, 6, 1]), fromSubstitution: true }, seq: q + 0.1, ts: t })
    }
    ev.push({ matchId, setIndex: i, type: 'set_end', payload: { team: 'home' }, seq: seq++, ts: t })
  }
  for (const e of extra) ev.push({ matchId, ts: t, seq: seq++, ...e })
  await db.sets.add({ matchId, index: current, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.bulkAdd(ev)

  render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
  const open = () => [...document.querySelectorAll('button')].find(b => /^Line-?upA/.test(b.textContent.trim()))
  await waitFor(() => expect(open()).toBeTruthy(), { timeout: 10000 })
  fireEvent.click(open())
  await waitFor(() => expect(dialog()).toBeTruthy())
  // the dialog reads the match's events itself (a live query)
  if (current > 1) await waitFor(() => expect(dialog().querySelector('[data-testid="lineup-copy"]')).toBeTruthy())
  else await sleep(300)
  return matchId
}

describe("Line-up dialog: the last set's line-up", () => {
  it("set 2: copies set 1's STARTING six (not the six at its end); Undo last edit takes it back", async () => {
    await openLineupInSet({ current: 2, starts: [[1, 2, 3, 4, 5, 6]] })
    const last = copyButton(1)
    expect(last.textContent).toContain("Last set's line-up")
    // only one earlier set: no other buttons
    expect(dialog().querySelectorAll('[data-testid="lineup-copy"] [data-copy-set]')).toHaveLength(1)
    expect(six()).toEqual(['', '', '', '', '', ''])
    fireEvent.click(last)
    await waitFor(() => expect(six()).toEqual(['1', '2', '3', '4', '5', '6']))
    fireEvent.click(button('Undo last edit'))
    await waitFor(() => expect(six()).toEqual(['', '', '', '', '', '']))
  })

  it('set 3: the last set first, set 1 beside it; each fills its own starting six', async () => {
    await openLineupInSet({ current: 3, starts: [[1, 2, 3, 4, 5, 6], [7, 8, 10, 11, 2, 4]] })
    const buttons = [...dialog().querySelectorAll('[data-testid="lineup-copy"] [data-copy-set]')]
    expect(buttons.map(b => b.dataset.copySet)).toEqual(['2', '1'])
    expect(buttons[1].textContent.trim()).toBe('Set 1')
    expect(buttons[1].getAttribute('aria-label')).toBe('Starting line-up of set 1')
    fireEvent.click(buttons[0])
    await waitFor(() => expect(six()).toEqual(['7', '8', '10', '11', '2', '4']))
    fireEvent.click(copyButton(1))
    await waitFor(() => expect(six()).toEqual(['1', '2', '3', '4', '5', '6']))
    // one Undo per copy
    fireEvent.click(button('Undo last edit'))
    await waitFor(() => expect(six()).toEqual(['7', '8', '10', '11', '2', '4']))
  })

  it('a player who may not play now is flagged as if typed, and nothing is saved', async () => {
    const matchId = await openLineupInSet({
      current: 2,
      starts: [[1, 2, 3, 4, 5, 6]],
      extra: [{ setIndex: 1, type: 'sanction', payload: { team: 'home', playerNumber: 5, type: 'disqualification' } }]
    })
    fireEvent.click(copyButton(1))
    await waitFor(() => expect(six()).toEqual(['1', '2', '3', '4', '5', '6']))
    expect(box('V').getAttribute('aria-invalid')).toBe('true')
    expect(dialog().textContent).toContain('Disqualified')
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await sleep(500)
    expect(dialog()).toBeTruthy()
    expect((await db.events.where({ matchId, type: 'lineup' }).toArray()).filter(e => e.setIndex === 2)).toHaveLength(0)
  })

  it('the game captain on the copied six: the kept one is chosen, Confirm designates him', async () => {
    // captain #11 is not in set 1's six; "Keep as game captain" on for #4
    const matchId = await openLineupInSet({ current: 2, starts: [[1, 2, 3, 4, 5, 6]], captain: 11, match: { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 4 } })
    fireEvent.click(copyButton(1))
    await waitFor(() => expect(dialog().querySelector('.lineup-gcapt')).toBeTruthy())
    expect(dialog().querySelector('[aria-label="Game captain: player 4"]').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect((await db.events.where({ matchId, type: 'lineup' }).toArray()).filter(e => e.setIndex === 2)).toHaveLength(1), { timeout: 5000 })
    const saved = (await db.events.where({ matchId, type: 'lineup' }).toArray()).find(e => e.setIndex === 2)
    expect(Object.fromEntries(Object.entries(saved.payload.lineup).map(([k, v]) => [k, String(v)]))).toEqual(lu([1, 2, 3, 4, 5, 6]))
    await waitFor(async () => expect(await db.events.where({ matchId, type: 'court_captain_designation' }).count()).toBe(1))
    const [d] = await db.events.where({ matchId, type: 'court_captain_designation' }).toArray()
    expect(d.payload).toMatchObject({ team: 'home', playerNumber: 4, fromLineup: true, keep: true })
    await sleep(500)
  })

  it('set 1: nothing to copy', async () => {
    await openLineupInSet({ current: 1, starts: [] })
    expect(dialog().querySelector('[data-testid="lineup-copy"]')).toBeNull()
  })
})
