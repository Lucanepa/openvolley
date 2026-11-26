// Drives the whole walkthrough in the real app (App over fake IndexedDB):
// every step's screen comes and its control is found ("ready"), with the
// card's Next and, for "Skip to set 5", its button. Shared by the tablet and
// the phone test.
import { fireEvent } from '@testing-library/react'
import { STEPS } from '../walkthroughSteps'

export const card = () => document.querySelector('[data-testid="walkthrough"]')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A plain wait with a readable failure (no DOM dump)
async function until(test, what, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (test()) return
    if (Date.now() > end) {
      const c = card()
      throw new Error(`${what}: timed out (card at ${c?.dataset.step} ${c?.dataset.phase}, page dialogs: ${[...document.querySelectorAll('[role=dialog]')].map(d => (d.querySelector('h1,h2,h3')?.textContent || '?').trim().slice(0, 40)).join(' | ')})`)
    }
    await sleep(100)
  }
}

/** Walk from step `from` to the end; returns [{ id, phase }] per step. */
export async function walkAll({ from = 0, onStep = null, log = false } = {}) {
  const seen = []
  for (let i = from; i < STEPS.length; i++) {
    const step = STEPS[i]
    const t0 = Date.now()
    await until(() => card()?.dataset.step === step.id && ['ready', 'missing', 'error'].includes(card().dataset.phase), `step ${step.id}`, 120000)
    seen.push({ id: step.id, phase: card().dataset.phase })
    if (log) console.log(`[walk] ${step.id} ${card().dataset.phase} ${Date.now() - t0} ms`)
    onStep?.(step)
    if (step.action === 'fastForward') {
      fireEvent.click(document.querySelector('[data-testid="walkthrough-fast-forward"]'))
      await until(() => card()?.dataset.step !== step.id, 'skip to set 5', 300000)
      continue
    }
    fireEvent.click(document.querySelector('[data-testid="walkthrough-next"]'))
  }
  await until(() => !card(), 'the end', 10000)
  return seen
}
