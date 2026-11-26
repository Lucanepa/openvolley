// The whole "Your first match" on a phone (393 x 852, the phone scoring
// layout): Home's card starts it, every step finds its control, the phone's
// own controls (phone-sub-*, the action grid) included.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../../../db/db'
import { setToolMode } from '../../../utils/toolMode'
import { offline, online, mountApp, button } from '../../../__tests__/appMount'
import { resetWalkthroughForTests, getWalkthrough } from '../walkthroughStore'
import { STEPS } from '../walkthroughSteps'
import { walkAll } from './walkthroughWalk'

let saved
beforeAll(() => {
  offline()
  saved = { w: window.innerWidth, h: window.innerHeight }
  window.innerWidth = 393
  window.innerHeight = 852
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

describe('walkthrough: phone', () => {
  it('every step finds its control on the phone, from Home\'s card to the match end', async () => {
    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    // Home's one-time card starts the tour
    await waitFor(() => expect(document.querySelector('[data-testid="home-tour-start"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-testid="home-tour-start"]'))

    let phoneScoring = false
    const seen = await walkAll({
      log: true,
      onStep: (step) => {
        if (step.id === 'set1Requests') phoneScoring = !!document.querySelector('[data-testid="phone-scoreboard"]')
      }
    })
    expect(seen.filter(s => s.phase !== 'ready')).toEqual([])
    expect(seen.map(s => s.id)).toEqual(STEPS.map(s => s.id))
    expect(phoneScoring).toBe(true)
    const sets = await db.sets.where('matchId').equals(getWalkthrough().matchId).toArray()
    expect(sets.filter(s => s.finished)).toHaveLength(5)
    // the card is gone from Home for good
    expect(document.querySelector('[data-testid="home-tour-card"]')).toBeNull()
  }, 900000)
})
