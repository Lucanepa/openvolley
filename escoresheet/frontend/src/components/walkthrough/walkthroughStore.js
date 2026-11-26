// The "Your first match" walkthrough's state (owner plan 24.11.2026, Phase 2):
// whether it runs, which step it shows, and the test match it runs on. A
// small store outside React, read with useSyncExternalStore, because three
// places that are no parent of each other ask it: the engine (Walkthrough.jsx),
// App (the demo sign-in around Match setup) and the help panel / Home card
// that start it. Nothing is kept across a reload: a walkthrough stopped by
// one leaves only its test match, and its demo data goes at the next start
// (demoData.removeDemoData).
import { useSyncExternalStore } from 'react'
import { STEPS, CHAPTERS, firstStepOfChapter } from './walkthroughSteps'

const IDLE = Object.freeze({ active: false, step: 0, matchId: null, run: 0 })

let state = IDLE
const listeners = new Set()

function set(next) {
  state = Object.freeze({ ...state, ...next })
  for (const l of [...listeners]) l()
}

export function getWalkthrough() {
  return state
}

export function subscribeWalkthrough(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The store in a component (re-renders on every change). */
export function useWalkthrough() {
  return useSyncExternalStore(subscribeWalkthrough, getWalkthrough, getWalkthrough)
}

/**
 * True while the walkthrough runs: the demo data (signed-in roster ways)
 * shows only then, and only on its test match (DemoAuthScope, demoData).
 */
export function walkthroughActive() {
  return state.active === true
}

/** Start at a chapter (0: Home, the whole walkthrough). */
export function startWalkthrough({ chapter = 0 } = {}) {
  const c = Math.max(0, Math.min(CHAPTERS.length - 1, Number(chapter) || 0))
  set({ active: true, step: firstStepOfChapter(c), run: state.run + 1 })
}

export function goToStep(index) {
  if (!state.active) return
  if (index >= STEPS.length) { endWalkthrough(); return }
  set({ step: Math.max(0, index) })
}

export function nextStep() {
  goToStep(state.step + 1)
}

export function previousStep() {
  goToStep(Math.max(0, state.step - 1))
}

/** The first step of the next chapter (the end after the last chapter). */
export function skipChapter() {
  const chapter = STEPS[state.step]?.chapter ?? 0
  if (chapter >= CHAPTERS.length - 1) { endWalkthrough(); return }
  goToStep(firstStepOfChapter(chapter + 1))
}

export function goToChapter(chapter) {
  goToStep(firstStepOfChapter(chapter))
}

/**
 * Is this the walkthrough's own test match, while it runs? (The coin toss
 * leaves its signatures empty: the tour's "Captain and coach sign here" step
 * then matches the screen, owner follow-up 26.11.2026.)
 */
export function isWalkthroughMatch(matchId) {
  return state.active === true && state.matchId != null && matchId != null && state.matchId === matchId
}

/** The test match the walkthrough made (its prepare steps use it again). */
export function setWalkthroughMatch(matchId) {
  set({ matchId: matchId ?? null })
}

export function endWalkthrough() {
  set({ active: false })
}

/** Tests only: back to the start state. */
export function resetWalkthroughForTests() {
  state = IDLE
  for (const l of [...listeners]) l()
}
