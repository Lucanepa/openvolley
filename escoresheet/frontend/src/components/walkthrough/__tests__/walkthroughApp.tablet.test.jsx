// The whole "Your first match" on the tablet layout, in the real app: the
// "?" panel starts it, every step finds its control on its screen, "Skip to
// set 5" reaches a valid deciding set, and the walkthrough ends at Match End.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../../../db/db'
import { recomputeMatch } from '../../../domain/recompute'
import { setToolMode } from '../../../utils/toolMode'
import { offline, online, mountApp, button } from '../../../__tests__/appMount'
import { resetWalkthroughForTests, getWalkthrough } from '../walkthroughStore'
import { STEPS } from '../walkthroughSteps'
import { DEMO_USER_ID } from '../../../domain/walkthroughDemo'
import { walkAll, card } from './walkthroughWalk'

let saved
beforeAll(() => {
  offline()
  saved = { w: window.innerWidth, h: window.innerHeight }
  window.innerWidth = 1280
  window.innerHeight = 800
})
afterAll(() => {
  window.innerWidth = saved.w
  window.innerHeight = saved.h
  online()
})
beforeEach(async () => {
  cleanup()
  resetWalkthroughForTests()
  localStorage.clear()
  setToolMode('swiss')
  // no start-up connection check over Home (a first start asks it; the scorer answers it)
  localStorage.setItem('offlineMode', 'true')
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('walkthrough: tablet', () => {
  it('every step finds its control, from Home to the match end', async () => {
    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    // the "?" panel's "Your first match"
    fireEvent.click(document.querySelector('[data-testid="header-help"]'))
    await waitFor(() => expect(document.querySelector('[data-testid="help-walkthrough-start"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-testid="help-walkthrough-start"]'))

    let demoSeen = false
    const seen = await walkAll({
      log: true,
      onStep: (step) => {
        // the simulated signed-in ways show in the roster editor
        if (step.id === 'rosterSaved') demoSeen = !!document.querySelector('[data-testid="load-saved-team-home"]')
      }
    })
    expect(seen.filter(s => s.phase !== 'ready')).toEqual([])
    expect(seen.map(s => s.id)).toEqual(STEPS.map(s => s.id))
    expect(demoSeen).toBe(true)

    // the deciding set was reached through the app's own set ends, the log consistent
    const matchId = getWalkthrough().matchId
    const match = await db.matches.get(matchId)
    expect(match.test).toBe(true)
    const sets = (await db.sets.where('matchId').equals(matchId).toArray()).sort((a, b) => a.index - b.index)
    expect(sets.map(s => s.index)).toEqual([1, 2, 3, 4, 5])
    expect(sets.every(s => s.finished)).toBe(true)
    const won = (team) => sets.slice(0, 4).filter(s => (team === 'home' ? s.homePoints > s.awayPoints : s.awayPoints > s.homePoints)).length
    expect([won('home'), won('away')]).toEqual([2, 2])
    expect(match.set5CourtSwitched).toBe(true)
    const events = await db.events.where('matchId').equals(matchId).toArray()
    expect(events.filter(e => e.type === 'set_end')).toHaveLength(5)
    const players = {
      home: await db.players.where('teamId').equals(match.homeTeamId).toArray(),
      away: await db.players.where('teamId').equals(match.awayTeamId).toArray()
    }
    const rc = recomputeMatch(events, { match, players, matchId })
    expect(rc.issues.map(i => i.text)).toEqual([])
    // the demo data went with the end of the walkthrough
    expect(await db.club_players.where('userId').equals(DEMO_USER_ID).count()).toBe(0)
    expect(card()).toBeNull()
  }, 900000)
})
