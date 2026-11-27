// The Rosters chapter as the scorer (and the first-match video) goes through
// it, in the real app: the demo saved team is picked and loads straight in
// (no "Choose the players" in between), then "Add from club" still has the
// club's players the saved team does not have to tick, and "Choose players"
// offers them unticked (owner follow-up 26.11.2026).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { render, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
vi.mock('../../../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../../../db/db'
import { setToolMode } from '../../../utils/toolMode'
import { offline, online, mountApp, button, sleep } from '../../../__tests__/appMount'
import { resetWalkthroughForTests, startWalkthrough, endWalkthrough } from '../walkthroughStore'
import { card } from './walkthroughWalk'
import { UiHost } from '../../../ui/UiHost.jsx'

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
  localStorage.setItem('offlineMode', 'true')
  await Promise.all(db.tables.map(t => t.clear()))
})

async function until(test, what, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > end) throw new Error(`${what}: timed out (card at ${card()?.dataset.step} ${card()?.dataset.phase})`)
    await sleep(100)
  }
}
const readyAt = (id) => until(() => card()?.dataset.step === id && card()?.dataset.phase === 'ready', `step ${id}`)
const next = () => fireEvent.click(document.querySelector('[data-testid="walkthrough-next"]'))
const rosterNames = () => [...document.querySelectorAll('input')].map(i => i.value)

describe('walkthrough: the Rosters chapter, tapped', () => {
  it('the saved team loads straight in; the club and the pool still have players to tick', async () => {
    mountApp()
    // the app's confirms ("Replace the roster?"), as main.jsx mounts them beside App
    render(<div className="ov-kit ov-kit-host"><UiHost /></div>)
    await waitFor(() => expect(button('Restore match')).toBeTruthy())
    act(() => startWalkthrough({ chapter: 2 }))
    for (const id of ['rosterType', 'rosterPdf']) {
      await readyAt(id)
      next()
    }
    // Photo: shown and explained, its buttons take no tap (no camera in the walkthrough)
    await readyAt('rosterPhoto')
    expect(document.querySelector('[data-testid="roster-import-home"]').dataset.mode).toBe('photo')
    const camera = document.querySelector('[data-testid="roster-photo-camera-home"]')
    const opened = vi.spyOn(camera, 'click').mockImplementation(() => {})
    fireEvent.click(document.querySelector('[data-testid="roster-photo-take-home"]'))
    expect(opened).not.toHaveBeenCalled()
    expect(card()?.dataset.step).toBe('rosterPhoto')
    next()
    for (const id of ['rosterRemote', 'rosterUploaded', 'rosterSaved']) {
      await readyAt(id)
      next()
    }
    await readyAt('rosterSavedPick')
    const row = document.querySelector('[data-testid="saved-team-row"]')
    fireEvent.click(row.querySelector('[role="button"]') || row)
    // the app asks before it replaces the roster
    await until(() => !!button('Replace'), 'the replace question')
    fireEvent.click(button('Replace'))
    await readyAt('rosterClub')
    await sleep(300)
    expect(document.querySelector('[data-testid="player-pool-apply"]')).toBeNull()
    expect(rosterNames()).toContain('Tanner')
    next()

    await readyAt('rosterClubPick')
    const rows = [...document.querySelectorAll('[data-testid="club-picker-row"]')]
    const free = rows.filter(r => !r.querySelector('input[type="checkbox"]').disabled)
    expect(free.map(r => r.textContent.match(/Lauener|Pfister|Mosimann/)?.[0])).toEqual(['Lauener', 'Pfister', 'Mosimann'])
    expect(rows.indexOf(free[0])).toBe(0)
    next()

    await readyAt('rosterChoose')
    next()
    await readyAt('rosterChooseList')
    const pool = [...document.querySelectorAll('[data-testid="player-pool-row"]')]
    expect(pool.filter(c => c.checked)).toHaveLength(12)
    expect(pool.filter(c => !c.checked)).toHaveLength(3)
    act(() => endWalkthrough())
  }, 180000)
})
