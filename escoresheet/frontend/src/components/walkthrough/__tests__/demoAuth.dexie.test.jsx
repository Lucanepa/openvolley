// The simulated sign-in of the walkthrough (DemoAuthScope, db/savedTeams):
// Match setup of the walkthrough's test match sees the demo account, any
// other match the real one; the demo account's saved team never comes from
// (or goes to) a server, and the real account's cache stays as it is.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { db } from '../../../db/db'
import { AuthContext, useAuth } from '../../../contexts/AuthContext'
import DemoAuthScope from '../DemoAuthScope'
import { startWalkthrough, endWalkthrough, resetWalkthroughForTests } from '../walkthroughStore'
import { getSavedTeams, refreshSavedTeams } from '../../../db/savedTeams'
import { DEMO_USER_ID, demoSavedTeamRows } from '../../../domain/walkthroughDemo'

const REAL = { user: null, profile: null, access: { canReadTeams: false }, getCachedProfile: () => null }
let seen = null
function Probe() {
  seen = useAuth()
  return null
}
const mount = (matchId) => render(
  <AuthContext.Provider value={REAL}><DemoAuthScope matchId={matchId}><Probe /></DemoAuthScope></AuthContext.Provider>
)

beforeEach(async () => {
  cleanup()
  resetWalkthroughForTests()
  seen = null
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => resetWalkthroughForTests())

describe('walkthrough demo sign-in', () => {
  it('only on the test match and only while the walkthrough runs', async () => {
    const test = await db.matches.add({ test: true, status: 'scheduled' })
    const official = await db.matches.add({ test: false, status: 'scheduled' })
    const guest = await db.matches.add({ test: false, guest: true, status: 'scheduled' })

    mount(test)
    await new Promise(r => setTimeout(r, 50))
    expect(seen.user).toBeNull() // the walkthrough does not run

    act(() => startWalkthrough({ chapter: 2 }))
    await waitFor(() => expect(seen.user?.id).toBe(DEMO_USER_ID))
    expect(seen.access.canReadTeams).toBe(true)
    expect(seen.access.canScore).toBe(false)

    act(() => endWalkthrough())
    await waitFor(() => expect(seen.user).toBeNull())

    for (const id of [official, guest]) {
      cleanup()
      act(() => startWalkthrough({ chapter: 2 }))
      mount(id)
      await new Promise(r => setTimeout(r, 80))
      expect(seen.user, `match ${id}`).toBeNull()
    }
  })

  it('the demo saved team comes from the demo data: no request, the real cache untouched', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')))
    const saved = globalThis.fetch
    globalThis.fetch = fetchSpy
    try {
      await db.saved_teams_meta.put({ key: 'bundle', userId: 'real-user', version: '1', fetchedAt: new Date().toISOString() })
      await db.saved_teams.put({ id: 't1', name: 'Real team', nameKey: 'real team', competition: null })
      expect(await getSavedTeams({ userId: DEMO_USER_ID })).toEqual(demoSavedTeamRows())
      const res = await refreshSavedTeams({ force: true, access: { canReadTeams: true }, userId: DEMO_USER_ID, online: true })
      expect(res.teams).toEqual(demoSavedTeamRows())
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await getSavedTeams({ userId: 'real-user' })).toHaveLength(1)
    } finally {
      globalThis.fetch = saved
    }
  })
})
