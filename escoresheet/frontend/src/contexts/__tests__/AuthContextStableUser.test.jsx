import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

// The same account in every auth event and the same profile on every read
// keep their objects (owner 2026-11-11: "it loads something, stops, loads it
// again"): a new object per event re-ran the roster, club and saved-team
// refreshes, whose local writes filled every list again.
const auth = vi.hoisted(() => ({ onChange: null, profile: null }))

vi.mock('../../lib/apiClient', () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
    // a fresh copy per read, as the network gives
    single: async () => ({ data: auth.profile ? JSON.parse(JSON.stringify(auth.profile)) : null, error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
  }
  return {
    apiFrom: () => query,
    apiAuth: {
      onAuthStateChange: (cb) => {
        auth.onChange = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      // the stored session, not checked by the server (offline): the UI keeps
      // the account the events gave
      getSession: async () => ({ data: { session: { user: { id: 'u1' }, unverified: true } } }),
    },
  }
})
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (path) => `https://example.test${path}` }))
vi.mock('../../lib/accountApi', () => ({ fetchMe: vi.fn(async () => ({ data: { clubs: [] }, error: null })), redeemInvite: vi.fn() }))
const refresh = vi.hoisted(() => ({ savedTeams: vi.fn(async () => {}), rosters: vi.fn(async () => {}), club: vi.fn(async () => {}) }))
vi.mock('../../db/savedTeams', () => ({ clearSavedTeams: vi.fn(async () => {}), refreshSavedTeams: refresh.savedTeams }))
vi.mock('../../db/gameRosters', () => ({ clearGameRosters: vi.fn(async () => {}), refreshGameRosters: refresh.rosters, GAME_ROSTERS_REFRESH_MS: 900000 }))
vi.mock('../../db/clubPlayers', () => ({ clearClubPlayers: vi.fn(async () => {}), refreshClubPlayers: refresh.club }))

import { AuthProvider, useAuth, keepSameUser, keepSameProfile, ME_FOCUS_REFRESH_MS } from '../AuthContext'
import { fetchMe } from '../../lib/accountApi'

describe('keepSameUser / keepSameProfile', () => {
  it('keep the previous object when the content is the same', () => {
    const a = { id: 'u1', email: 'a@b.c' }
    expect(keepSameUser(a, { id: 'u1', email: 'a@b.c' })).toBe(a)
    const changed = { id: 'u1', email: 'a@b.c', email_confirmed_at: '2026-11-11' }
    expect(keepSameUser(a, changed)).toBe(changed)
    const other = { id: 'u2', email: 'a@b.c' }
    expect(keepSameUser(a, other)).toBe(other)
    expect(keepSameUser(a, null)).toBeNull()
    const p = { user_id: 'u1', roles: ['scorer'] }
    expect(keepSameProfile(p, { user_id: 'u1', roles: ['scorer'] })).toBe(p)
  })
})

describe('AuthProvider on repeated events of the same account', () => {
  afterEach(() => {
    auth.onChange = null
    auth.profile = null
    vi.clearAllMocks()
  })

  it('keeps the user and profile objects and does not refresh the caches again', async () => {
    auth.profile = { user_id: 'u1', roles: ['scorer'], first_name: 'A' }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen = { users: new Set(), profiles: new Set() }
    function Probe() {
      const { user, profile } = useAuth()
      if (user) seen.users.add(user)
      if (profile) seen.profiles.add(profile)
      return null
    }
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { await auth.onChange('INITIAL_SESSION', { user: { id: 'u1', email: 'a@b.c' } }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const rostersAfterFirst = refresh.rosters.mock.calls.length
    const savedAfterFirst = refresh.savedTeams.mock.calls.length
    expect(rostersAfterFirst).toBeGreaterThan(0)
    expect(savedAfterFirst).toBeGreaterThan(0)

    // a token refresh: the same account, a new object, the profile read again
    await act(async () => { await auth.onChange('TOKEN_REFRESHED', { user: { id: 'u1', email: 'a@b.c' } }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(seen.users.size).toBe(1)
    expect(seen.profiles.size).toBe(1)
    expect(refresh.rosters.mock.calls.length).toBe(rostersAfterFirst)
    expect(refresh.savedTeams.mock.calls.length).toBe(savedAfterFirst)
    log.mockRestore()
  })

  it('reads /api/me again on a window focus at most once a minute', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    render(<AuthProvider><div /></AuthProvider>)
    await act(async () => { await auth.onChange('SIGNED_IN', { user: { id: 'u1' } }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const first = fetchMe.mock.calls.length
    expect(first).toBe(1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(fetchMe.mock.calls.length).toBe(first)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ME_FOCUS_REFRESH_MS + 1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(fetchMe.mock.calls.length).toBe(first + 1)
    clock.mockRestore()
    log.mockRestore()
  })
})
