import { useCallback, useEffect, useState } from 'react'
import { getSavedTeams, getSavedTeamsMeta, refreshSavedTeams, competitionsOf, SAVED_TEAMS_CHANGED_EVENT } from '../db/savedTeams'

/**
 * The cached saved teams of the signed-in account (Dexie, offline-first).
 * Re-reads when the cache changes; `refresh(force)` asks the server when online.
 * @param {{userId: string|null, access: object, enabled?: boolean, refreshOnMount?: boolean}} opts
 */
export function useSavedTeams({ userId, access, enabled = true, refreshOnMount = false }) {
  const [teams, setTeams] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const [lastStatus, setLastStatus] = useState(null)

  const reload = useCallback(async () => {
    const [rows, m] = await Promise.all([getSavedTeams({ userId }), getSavedTeamsMeta()])
    setTeams(rows)
    setMeta(m && m.userId === userId ? m : null)
    setLoading(false)
  }, [userId])

  const refresh = useCallback(async (force = false) => {
    const res = await refreshSavedTeams({ force, access, userId })
    setLastStatus(res.status)
    await reload()
    return res
  }, [access, userId, reload])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    setLoading(true)
    ;(async () => {
      await reload()
      if (refreshOnMount && alive) await refresh(false)
    })()
    const onChange = () => { if (alive) reload() }
    window.addEventListener(SAVED_TEAMS_CHANGED_EVENT, onChange)
    return () => {
      alive = false
      window.removeEventListener(SAVED_TEAMS_CHANGED_EVENT, onChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId])

  // meta is already limited to this account (reload)
  return { teams, competitions: competitionsOf(teams, meta), meta, loading, lastStatus, refresh, reload }
}
