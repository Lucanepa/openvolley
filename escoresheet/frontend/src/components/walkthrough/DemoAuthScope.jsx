import { useContext, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AuthContext } from '../../contexts/AuthContext'
import { db } from '../../db/db'
import { DEMO_ACCESS, DEMO_USER } from '../../domain/walkthroughDemo'
import { useWalkthrough } from './walkthroughStore'

/**
 * Match setup of the walkthrough's test match, as an account sees it (owner
 * 24.11.2026: the signed-in roster ways are simulated): "Load saved team"
 * and "Add from club" show, with the demo account's saved team and club list
 * (domain/walkthroughDemo.js). Only while the walkthrough runs and only on a
 * test match; any other match, and Match setup outside the walkthrough, get
 * the real account (or none). The demo account reaches no server: its saved
 * teams come from the demo data (db/savedTeams.js), its club list is a
 * device row, and a test match sends nothing (domain/matchKind isLocalOnly).
 */
export default function DemoAuthScope({ matchId, children }) {
  const outer = useContext(AuthContext)
  const { active } = useWalkthrough()
  const isTestMatch = useLiveQuery(async () => {
    if (!active || matchId == null) return false
    const m = await db.matches.get(matchId)
    return !!m && m.test === true && m.easy !== true && m.global !== true && m.guest !== true
  }, [active, matchId], false)
  const demo = active && isTestMatch === true
  const value = useMemo(() => (demo && outer
    ? { ...outer, user: DEMO_USER, profile: null, getCachedProfile: () => null, access: DEMO_ACCESS, isAuthenticated: true }
    : outer), [demo, outer])
  if (!outer) return children
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
