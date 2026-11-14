// A roster a team uploaded before the coin toss, still on a match that runs
// (a device restored it from the server's copy): "Continue match" opens the
// match, and nothing sends the scorer back to Match Setup. Before the coin
// toss the pending roster still opens Match Setup. Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep } from './appMount'
import { seedMatch, ago, MIN, offlineDevice } from './selfCheckFixtures'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
  sessionStorage.clear()
})

const PENDING = { players: [{ number: 4, firstName: 'Anna', lastName: 'Muster', dob: '14/03/2008' }], bench: [], timestamp: '2026-11-09T17:00:00Z' }
const matchSetupShown = () => !!document.querySelector('[data-help-id="setup-match-info-card"]')

describe('a pending uploaded roster', () => {
  it('does not send a running match back to Match Setup', async () => {
    await seedMatch({ at: ago(5 * MIN), pendingHomeRoster: PENDING })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy(), { timeout: 15000 })
      fireEvent.click(button('Continue match'))
      await sleep(1500)
      expect(matchSetupShown()).toBe(false)
      expect(button('Continue match')).toBeFalsy()
    } finally {
      onLine.mockRestore()
    }
  }, 60000)

  it('still opens Match Setup before the coin toss', async () => {
    await seedMatch({ at: ago(5 * MIN), status: 'setup', pendingHomeRoster: PENDING })
    await db.sets.clear()
    await db.events.clear()
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match') || button('Continue setup') || document.querySelector('[data-testid="continue-card"] button')).toBeTruthy(), { timeout: 15000 })
      fireEvent.click(button('Continue match') || button('Continue setup') || document.querySelector('[data-testid="continue-card"] button'))
      await waitFor(() => expect(matchSetupShown()).toBe(true), { timeout: 15000 })
    } finally {
      onLine.mockRestore()
    }
  }, 60000)
})
