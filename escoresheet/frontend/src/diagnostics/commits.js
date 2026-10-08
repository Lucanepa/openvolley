/**
 * React commits per user action, for one component (the scoreboard):
 *
 *   function Scoreboard() { useDiagCommits('scoreboard'); ... }
 *
 * One `react.commits` line when the next user action starts (or after
 * QUIET_MS without commits): { id, a, commits, ms, maxMs }, where ms is the
 * time from the start of a render of the component to its layout effects
 * (render + commit of its subtree). React's <Profiler> reports nothing in a
 * production build, so this is what the installed app has.
 *
 * Zero cost while diagnostics is off: the flag is fixed before the first
 * render (installDiagnostics) and never changes in a page's life, so the
 * hook is either always or never called for a component.
 */
import { useLayoutEffect } from 'react'
import { diag, sinceAction } from './recorder'

export const QUIET_MS = 1500
let profiling = false
let counts = null
let quietTimer = null

/** installDiagnostics only, before the first render. */
export function setCommitProfiling(on) {
  profiling = !!on
}

function report() {
  if (quietTimer) {
    clearTimeout(quietTimer)
    quietTimer = null
  }
  if (!counts) return
  const c = counts
  counts = null
  diag('react.commits', c)
}

/** One commit of `id` that took `ms` (exported for tests). */
export function countCommit(id, ms) {
  const { a } = sinceAction()
  if (counts && (counts.a !== a || counts.id !== id)) report()
  if (!counts) counts = { id, a, commits: 0, ms: 0, maxMs: 0 }
  const d = Math.round(ms * 10) / 10
  counts.commits++
  counts.ms = Math.round((counts.ms + d) * 10) / 10
  counts.maxMs = Math.max(counts.maxMs, d)
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = setTimeout(report, QUIET_MS)
}

export function flushCommitCounts() {
  report()
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function useCommitCounter(id) {
  const start = now()
  useLayoutEffect(() => { countCommit(id, now() - start) })
}

export function useDiagCommits(id) {
  // `profiling` never changes after the first render (see above)
  if (profiling) useCommitCounter(id)
}
