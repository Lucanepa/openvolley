// The device check's card on Home waits while "Your first match" runs (owner
// follow-up 26.11.2026: Home is the walkthrough's first chapter, the card must
// not come over the tour) and comes as usual once the walkthrough has ended.
// In the real app over fake IndexedDB, offline.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { waitFor, cleanup, act } from '@testing-library/react'
import { vi } from 'vitest'
vi.mock('../../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../../../db/db'
import { setToolMode } from '../../../utils/toolMode'
import { CHECK_KEY, CHECK_VERSION, RECOMMENDED, resetDeviceCheckForTests } from '../../../utils/deviceCheck'
import { resetLookForTests } from '../../../utils/lookSettings'
import { offline, online, mountApp, button, sleep } from '../../../__tests__/appMount'
import { resetWalkthroughForTests, startWalkthrough, endWalkthrough } from '../walkthroughStore'

const card = () => document.querySelector('[data-testid="device-check-apply"]')

beforeAll(() => offline())
afterAll(() => online())
beforeEach(async () => {
  cleanup()
  resetWalkthroughForTests()
  localStorage.clear()
  resetLookForTests()
  resetDeviceCheckForTests()
  setToolMode('swiss')
  localStorage.setItem('offlineMode', 'true')
  // a slow device found earlier, its recommendation not answered yet: the card shows on Home
  localStorage.setItem(CHECK_KEY, JSON.stringify({
    v: CHECK_VERSION, at: Date.now(), tier: 'slow', score: 140, workMs: 95, workRunsMs: [95], layoutMs: 45, layoutRunsMs: [45],
    hints: { platform: 'web', cores: 4, memoryGb: 2, dpr: 1, screen: '1280x800', reducedMotion: false },
    recommended: { ...RECOMMENDED.slow }, answer: null
  }))
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('walkthrough: the device check waits', () => {
  it('no card on Home while the walkthrough runs; it comes back when it ends', async () => {
    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    await waitFor(() => expect(card()).toBeTruthy(), { timeout: 15000 })

    act(() => startWalkthrough())
    await waitFor(() => expect(document.querySelector('[data-testid="walkthrough"]')?.dataset.step).toBe('homeNew'))
    await waitFor(() => expect(card()).toBeNull())
    // and it stays away during the Home chapter
    await sleep(500)
    expect(card()).toBeNull()

    act(() => endWalkthrough())
    await waitFor(() => expect(card()).toBeTruthy(), { timeout: 15000 })
  }, 60000)
})
