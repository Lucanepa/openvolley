// The size gate over a running time-out (stress test 2026-10-25): a laptop
// zoomed in once (Ctrl +, 1366 x 768 at 110 % = 1242 x 582) or a window
// lower than 600 px got "please use a tablet or larger screen" IN PLACE of
// the scoring screen, which unmounted it. Zoomed back, the scoring screen
// came back without its time-out countdown: "Start rally" in the middle of
// the time-out. The gate now goes over the scoring screen, which stays
// mounted under it with its countdown and dialogs.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep } from './appMount'
import { GHOST_CLICK_MS } from '../hooks/useConfirmAction'

let saved
beforeAll(() => {
  offline()
  saved = { width: window.innerWidth, height: window.innerHeight }
})
afterAll(() => {
  online()
  window.innerWidth = saved.width
  window.innerHeight = saved.height
})

const resize = (width, height) => {
  window.innerWidth = width
  window.innerHeight = height
  window.dispatchEvent(new Event('resize'))
}
const gateShown = () => document.body.textContent.includes('please use a tablet or larger screen')
const gate = () => document.querySelector('[data-testid="size-gate"]')

// An official match in set 1 at 1:0, live: the app opens its scoring screen
async function seedLiveMatch() {
  const start = new Date(Date.now() - 3600000).toISOString()
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', createdAt: start, matchInfoConfirmedAt: start, test: true,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
  })
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: start })
  const lineup = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 1, ts: start },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 2, ts: start },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 3, ts: start },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 4, ts: start },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 5, ts: start }
  ])
  return matchId
}

describe('App: the size gate over the scoring screen', () => {
  it('a laptop zoomed in during a time-out: the gate goes over it, the countdown is still there after', async () => {
    resize(1366, 768)
    await seedLiveMatch()
    mountApp()
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })

    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
    await sleep(GHOST_CLICK_MS)
    fireEvent.click(button('Confirm time-out'))
    await waitFor(() => expect(button('Stop timeout')).toBeTruthy())
    const stop = button('Stop timeout')

    // Ctrl + : 110 %
    resize(1242, 582)
    await waitFor(() => expect(gateShown()).toBe(true))
    // the scoring screen is still there, under the gate
    expect(stop.isConnected).toBe(true)
    // a dialog (no scoring key acts under it)
    expect(gate().getAttribute('aria-modal')).toBe('true')
    expect(gate().textContent).toContain('Current: 1242 × 582 px')

    // back to 100 % (window not maximised)
    resize(1366, 640)
    await waitFor(() => expect(gateShown()).toBe(false))
    await sleep(300)
    expect(stop.isConnected).toBe(true)
    expect(button('Stop timeout')).toBe(stop)
    // the rally buttons stay out of reach under the countdown
    expect(button('Start rally').closest('[inert]')).toBeTruthy()
  }, 60000)
})
