import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * A function whose identity never changes and that always calls the newest
 * `fn` this component rendered. For callback props of a memoized child (App's
 * callbacks to the scoring screen): a new closure on every render no longer
 * re-renders the child, and the child never calls a stale one.
 *
 * The ref follows `fn` in an insertion effect, which runs in the commit before
 * every layout and passive effect of the tree: a child's passive effect runs
 * before its parent's, so a ref set in the parent's useEffect could still hold
 * the previous closure when the child calls it (the Scoreboard's "already
 * finished" effect calls onFinishSet). Not for calls during render.
 */
export function useLatestCallback(fn) {
  const ref = useRef(fn)
  useInsertionEffect(() => {
    ref.current = fn
  })
  return useCallback((...args) => ref.current(...args), [])
}

export default useLatestCallback
