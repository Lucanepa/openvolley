import { useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { diag } from '../diagnostics/recorder'

// An action's screen changes (the dialogs it opens or closes) wait for the
// live query result that shows its data. If no re-read including the commit
// has even started after this long, the query does not read what the action
// wrote: they are applied anyway.
export const COMMIT_FLUSH_FALLBACK_MS = 300
// A re-read that has started is waited for, on a busy tablet too, up to this
// long after the commit.
export const COMMIT_FLUSH_MAX_WAIT_MS = 3000

/**
 * useLiveQuery that lets an action show its data and its screen changes in
 * the same render.
 *
 * A scorer action writes in ONE Dexie transaction (useScorerActions), so the
 * live query emits once, after the commit. The dialogs it opens or closes are
 * React state: set right after the commit they would render before the live
 * query has re-read the data (the dialog over the old score, then the score).
 * Instead the action hands them to `commits.afterCommit(gen, apply)`, and they
 * are applied in the very callback that delivers the first query result that
 * includes the commit, so React batches both into one render.
 *
 * How a result is known to include a commit: the action takes `nextGen()` as
 * the last step INSIDE its transaction. The querier reads the generation
 * before it opens its own read transaction. A read transaction opened after a
 * readwrite one over the same tables only runs once that one has committed
 * (IndexedDB orders them), so a result read at generation >= gen sees the
 * action's writes. The querier must therefore read in one explicit
 * db.transaction('r', ...) (no torn read across the action's commit, and no
 * cached / optimistic results: Dexie's cache skips explicit transactions).
 *
 * @param {() => Promise<any>} querier
 * @param {any[]} deps
 * @param {any} [initialValue] the result until the first emit (e.g. read
 *   before the screen opened: utils/preload)
 * @returns {[any, { nextGen: () => number, afterCommit: (gen: number, apply: () => void) => void }]}
 */
export function useActionLiveQuery(querier, deps, initialValue) {
  const [state, setState] = useState(() => ({ value: initialValue, error: null }))
  const querierRef = useRef(querier)
  querierRef.current = querier
  const genRef = useRef(0) // last generation taken by an action
  const startedGenRef = useRef(0) // newest generation a started re-read includes
  const shownGenRef = useRef(0) // newest generation delivered to the screen
  const pendingRef = useRef([])
  const timerRef = useRef(null)

  const commits = useMemo(() => {
    const flush = (upToGen) => {
      const due = pendingRef.current.filter(p => p.gen <= upToGen)
      if (due.length === 0) return
      pendingRef.current = pendingRef.current.filter(p => p.gen > upToGen)
      for (const p of due) {
        try { p.apply() } catch (err) { console.error('[useActionLiveQuery] apply failed', err) }
      }
    }
    // Safety net only: normally the query result applies the changes. A
    // re-read that includes the commit is waited for (the main thread of a
    // busy tablet can hold it back for long); none started: apply now.
    const watch = (since) => {
      clearTimeout(timerRef.current)
      const elapsed = Date.now() - since
      timerRef.current = setTimeout(() => {
        if (pendingRef.current.length === 0) return
        const newest = Math.max(...pendingRef.current.map(p => p.gen))
        if (startedGenRef.current >= newest && Date.now() - since < COMMIT_FLUSH_MAX_WAIT_MS) {
          watch(since)
          return
        }
        console.warn('[action] no live query result for the commit: screen change applied anyway')
        diag('lq.fallback', { gen: genRef.current, ms: Date.now() - since })
        flush(genRef.current)
      }, Math.max(50, COMMIT_FLUSH_FALLBACK_MS - elapsed))
    }
    return {
      flush,
      nextGen: () => ++genRef.current,
      /** Apply `apply` with the first result that includes generation `gen` (0: now). */
      afterCommit: (gen, apply) => {
        if (!gen || shownGenRef.current >= gen) { apply(); return }
        pendingRef.current.push({ gen, apply })
        watch(Date.now())
      }
    }
  }, [])

  useEffect(() => {
    let alive = true
    const subscription = liveQuery(async () => {
      const gen = genRef.current
      if (gen > startedGenRef.current) startedGenRef.current = gen
      const value = await querierRef.current()
      return { value, gen }
    }).subscribe({
      next: ({ value, gen }) => {
        if (!alive) return
        if (gen > shownGenRef.current) shownGenRef.current = gen
        diag('lq.emit', { gen, shown: shownGenRef.current, waiting: pendingRef.current.length })
        // Same callback, same React batch: the data and the action's dialogs
        setState({ value, error: null })
        commits.flush(shownGenRef.current)
      },
      error: (error) => { if (alive) setState(s => ({ value: s.value, error })) }
    })
    return () => {
      alive = false
      subscription.unsubscribe()
    }
  }, deps)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  if (state.error) throw state.error
  return [state.value, commits]
}
