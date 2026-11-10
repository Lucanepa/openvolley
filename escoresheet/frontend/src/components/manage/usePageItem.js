import { useRef } from 'react'
import { usePanelData } from './common'

/**
 * The thing a panel's page shows (an account, an official game, a match;
 * owner 2026-11-10: "make sure every page there gets their own page"): what
 * the panel's lists already hold (`found`), else `lookup(id)`, a wider read
 * made only then. That is a page opened from a link or a bookmark, or a thing
 * that left the filtered list after a change made on its page (an approved
 * account is no longer pending, a reopened match no longer closed). The
 * console has no read of one account or one match, so the lookups read a
 * wider list and pick the one.
 *
 * `ready`: the panel's lists have loaded (the lookup waits for them).
 * `lookup(id)` resolves to { data: thing | null, error }.
 * While a read runs, the last version seen of the same thing stays on the
 * page, so a save does not flash "not found".
 * Returns { item, loading, error }.
 */
export function usePageItem(id, { found = null, ready = false, lookup, enabled = true, deps = [] }) {
  const wanted = !!id && enabled && ready && !found
  const wide = usePanelData(async () => {
    const res = await lookup(id)
    return res?.error ? res : { data: { id, item: res?.data ?? null }, error: null }
  }, [id, ...deps], { enabled: wanted })
  const looked = wide.data?.id === id ? wide.data.item : undefined
  const fresh = found || looked || null
  const last = useRef(null)
  if (fresh) last.current = { id, item: fresh }
  const waiting = !!id && (!ready || (wanted && !wide.error && (wide.loading || looked === undefined)))
  const item = fresh || (waiting && last.current?.id === id ? last.current.item : null)
  return { item, loading: waiting, error: wanted ? wide.error : null }
}
