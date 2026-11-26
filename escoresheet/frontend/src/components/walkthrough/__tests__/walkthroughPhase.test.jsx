// The walkthrough's phase belongs to the step it shows (owner follow-up
// 26.11.2026): the render that shows a new step says "preparing", never the
// last step's "ready" until its own screen and control are there. data-phase
// is what automation reads (run.mjs, the video recorder); it acted on the
// old step's "ready" for a moment.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useLayoutEffect } from 'react'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import '../../../i18n'
import { db } from '../../../db/db'
import Walkthrough from '../Walkthrough'
import { useWalkthrough, startWalkthrough, nextStep, previousStep, resetWalkthroughForTests } from '../walkthroughStore'

// Home's controls, as the Home steps point at them
const Home = () => (
  <div>
    <button type="button" data-testid="header-help">?</button>
    <button type="button" data-help-id="home-official-button">New match</button>
    <button type="button" data-help-id="home-test-button">Test match</button>
    <button type="button" data-help-id="home-easy-button">Easy match</button>
    <button type="button" data-help-id="home-restore-button">Restore match</button>
    <button type="button" data-testid="home-options">Options</button>
  </div>
)
const appCtx = {
  db,
  isPhone: () => false,
  page: () => 'home',
  matchId: () => null,
  goHome: () => {},
  createTestMatch: async () => {},
  showSetup: async () => {},
  showScoreboard: async () => {},
  restoreTestRosters: async () => {}
}

// What the page shows in every commit that changes the step (a layout effect
// runs after the commit's DOM changes, before any effect could fix them up)
let commits = []
function Probe() {
  const wt = useWalkthrough()
  useLayoutEffect(() => {
    const el = document.querySelector('[data-testid="walkthrough"]')
    commits.push({ step: el?.dataset.step ?? null, phase: el?.dataset.phase ?? null, at: wt.step })
  })
  return null
}
const card = () => document.querySelector('[data-testid="walkthrough"]')

beforeEach(() => {
  cleanup()
  resetWalkthroughForTests()
  commits = []
})
afterEach(() => {
  cleanup()
  resetWalkthroughForTests()
})

describe('walkthrough phase', () => {
  it('a new step is "preparing" in the render that shows it, then "ready"', async () => {
    render(<><Home /><Walkthrough appCtx={appCtx} /><Probe /></>)
    act(() => startWalkthrough())
    await waitFor(() => expect(card()?.dataset).toMatchObject({ step: 'homeNew', phase: 'ready' }))

    commits = []
    act(() => nextStep())
    expect(commits[0]).toEqual({ step: 'homeTest', phase: 'preparing', at: 1 })
    await waitFor(() => expect(card()?.dataset).toMatchObject({ step: 'homeTest', phase: 'ready' }))

    // Back too
    commits = []
    act(() => previousStep())
    expect(commits[0]).toEqual({ step: 'homeNew', phase: 'preparing', at: 0 })
    await waitFor(() => expect(card()?.dataset).toMatchObject({ step: 'homeNew', phase: 'ready' }))
  })
})
