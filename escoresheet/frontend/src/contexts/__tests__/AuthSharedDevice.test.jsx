// What one account leaves on a shared scoring device (club laptop, hall
// tablet) for the next person: the real AuthProvider over a stubbed
// lib/apiClient, as AuthContextSignedIn.test.jsx does. Made-up people only.
//
// Only the Sign out button removed the cached profile (names, date of birth,
// roles) and the clubs; a session that expired, that the server refused, or
// that lapsed while the app was closed left them, and Match Setup prefilled
// the next scorer from them. A profile read still on the way at sign-out or
// at an account change put the previous account's profile back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ onChange: null, profileReads: [], me: null, stored: null, signOut: null }))

vi.mock('../../lib/apiClient', () => {
  const makeQuery = () => {
    const q = {
      userId: null,
      select: () => q,
      eq: (_col, value) => { q.userId = value; return q },
      maybeSingle: async () => ({ data: null, error: null }),
      // each profile read waits until the test answers it
      single: () => new Promise((resolve) => { h.profileReads.push({ userId: q.userId, resolve }) }),
      then: (resolve) => resolve({ data: [], error: null })
    }
    return q
  }
  return {
    apiFrom: () => makeQuery(),
    apiAuth: {
      onAuthStateChange: (cb) => {
        h.onChange = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      // the stored session, not yet checked by the server (a slow or absent network)
      getSession: async () => ({ data: { session: h.stored ? { ...h.stored, unverified: true } : null } }),
      signOut: (...a) => h.signOut(...a),
      signInWithPassword: async ({ email }) => ({ data: { user: { id: email === 'b@example.test' ? 'user-B' : 'user-A', email } }, error: null }),
      deleteUser: async () => ({ data: null, error: null })
    }
  }
})
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: (path) => `https://example.test${path}` }))
const caches = vi.hoisted(() => ({ savedTeams: vi.fn(async () => {}), rosters: vi.fn(async () => {}), club: vi.fn(async () => {}) }))
vi.mock('../../db/savedTeams', () => ({ clearSavedTeams: caches.savedTeams, refreshSavedTeams: vi.fn(async () => {}) }))
vi.mock('../../db/gameRosters', () => ({ clearGameRosters: caches.rosters, refreshGameRosters: vi.fn(async () => {}), GAME_ROSTERS_REFRESH_MS: 600000 }))
vi.mock('../../db/clubPlayers', () => ({ clearClubPlayers: caches.club, refreshClubPlayers: vi.fn(async () => {}) }))
vi.mock('../../lib/accountApi', () => ({
  fetchMe: vi.fn(async () => h.me || { data: null, error: { message: 'offline' } }),
  redeemInvite: vi.fn(async () => ({ data: null, error: null }))
}))
vi.mock('../../components/auth/PasskeyOfferHost', () => ({ default: () => null }))

import { AuthProvider, useAuth } from '../AuthContext'
import { rememberApprovalEmail, recallApprovalEmail } from '../../domain/accountApproval'

const profileA = { user_id: 'user-A', first_name: 'Anna', last_name: 'Admin', dob: '1990-02-03', country: 'CHE', roles: ['admin', 'scorer'] }
const profileB = { user_id: 'user-B', first_name: 'Ben', last_name: 'Beginner', dob: '2008-05-06', country: 'CHE', roles: [] }
const sessionA = { access_token: 'tok-A', user: { id: 'user-A' } }

// What the device keeps for account A (localStorage)
function leaveDataOfA() {
  localStorage.setItem('cachedProfile', JSON.stringify(profileA))
  localStorage.setItem('ov:clubs', JSON.stringify({ userId: 'user-A', clubs: [{ id: 'c1', name: 'VBC Example' }], clubRule: true }))
  localStorage.setItem('ov:todayGames', JSON.stringify({ userId: 'user-A', day: '2026-11-14', data: { games: [{ game_number: '930001', referee_1_first_name: 'Rita' }] } }))
  rememberApprovalEmail('Ref Rita', 'rita@example.test')
}
const accountKeys = () => ['cachedProfile', 'ov:clubs', 'ov:todayGames', 'ov.approvalEmails'].filter((k) => localStorage.getItem(k) !== null)

let ctx = null
function Probe() { ctx = useAuth(); return null }

let cachesDelete
beforeEach(() => {
  localStorage.clear()
  h.onChange = null
  h.profileReads.length = 0
  h.me = null
  h.stored = sessionA
  h.signOut = async () => ({ error: null })
  ctx = null
  caches.savedTeams.mockClear(); caches.rosters.mockClear(); caches.club.mockClear()
  cachesDelete = vi.fn(async () => true)
  globalThis.caches = { delete: cachesDelete }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  delete globalThis.caches
  vi.restoreAllMocks()
})

const answerProfileRead = async (index, data) => {
  await act(async () => { h.profileReads[index].resolve({ data, error: null }); await Promise.resolve() })
}
// The page starts with A's stored session; A's profile read is on the way.
// `seeded`: the auth listener's run, done once that read answered.
async function startSignedInAsA() {
  render(<AuthProvider><Probe /></AuthProvider>)
  let seeded
  await act(async () => { seeded = h.onChange('INITIAL_SESSION', h.stored); await Promise.resolve() })
  return { seeded }
}

describe('AuthProvider on a shared device: a session that ends', () => {
  it('ended by expiry or by the server (no Sign out button): the account\'s data goes with it', async () => {
    h.me = { data: { clubs: [{ id: 'c1', name: 'VBC Example', teams: ['VBC Example H1'] }], clubRule: true, managedClubs: ['c1'], managedTeams: [] }, error: null }
    const { seeded } = await startSignedInAsA()
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    await vi.waitFor(() => expect(localStorage.getItem('ov:clubs')).toContain('VBC Example'))
    leaveDataOfA()
    expect(ctx.getCachedProfile()).toMatchObject({ first_name: 'Anna' })
    caches.savedTeams.mockClear()

    // lib/apiClient.js announces an expired or rejected token like this
    await act(async () => { h.stored = null; await h.onChange('SIGNED_OUT', null) })
    expect(ctx.user).toBeNull()
    expect(ctx.profile).toBeNull()
    expect(accountKeys()).toEqual([])
    expect(recallApprovalEmail('Ref Rita')).toBe('')
    expect(caches.savedTeams).toHaveBeenCalled()
    expect(caches.rosters).toHaveBeenCalled()
    expect(caches.club).toHaveBeenCalled()
    // the service worker's old copies of API answers too
    expect(cachesDelete).toHaveBeenCalledWith('api-cache')
    // Match Setup prefills the scorer from it: nothing for a signed-out device
    expect(ctx.getCachedProfile()).toBeNull()
  })

  it('lapsed while the app was closed: at start the data of another account goes, the signed-in one keeps its own', async () => {
    leaveDataOfA()
    h.stored = null
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { await h.onChange('INITIAL_SESSION', null) })
    expect(accountKeys().filter((k) => k !== 'ov.approvalEmails')).toEqual([])
    expect(caches.savedTeams).toHaveBeenCalledWith({ keepUserId: null })
    expect(caches.rosters).toHaveBeenCalledWith({ keepUserId: null })
    expect(caches.club).toHaveBeenCalledWith({ keepUserId: null })
    expect(cachesDelete).toHaveBeenCalledWith('api-cache')
  })

  it('at start signed in as A: A\'s own copies stay', async () => {
    leaveDataOfA()
    await startSignedInAsA()
    expect(accountKeys()).toEqual(['cachedProfile', 'ov:clubs', 'ov:todayGames', 'ov.approvalEmails'])
    expect(caches.savedTeams).toHaveBeenCalledWith({ keepUserId: 'user-A' })
    expect(ctx.getCachedProfile()).toMatchObject({ user_id: 'user-A' })
  })

  it('Sign out clears the device before the server answers', async () => {
    await startSignedInAsA()
    await answerProfileRead(0, profileA)
    leaveDataOfA()
    h.signOut = () => new Promise(() => {}) // the hall network: no answer
    act(() => { ctx.signOut() })
    expect(ctx.user).toBeNull()
    expect(ctx.profile).toBeNull()
    expect(accountKeys()).toEqual([])
    expect(caches.savedTeams).toHaveBeenCalled()
  })

  it('another account signing in drops the previous one\'s data', async () => {
    const { seeded } = await startSignedInAsA()
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    leaveDataOfA()
    caches.savedTeams.mockClear()
    // another tab signed in as B (the storage event)
    await act(async () => { await h.onChange('SIGNED_IN', { access_token: 'tok-B', user: { id: 'user-B' } }) })
    expect(ctx.user?.id).toBe('user-B')
    expect(accountKeys()).toEqual([])
    expect(caches.savedTeams).toHaveBeenCalledWith({ keepUserId: 'user-B' })
  })

  it('deleting the account clears every copy, the approval addresses and today\'s games too', async () => {
    const { seeded } = await startSignedInAsA()
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    leaveDataOfA()
    await act(async () => { await ctx.deleteAccount() })
    expect(ctx.user).toBeNull()
    expect(accountKeys()).toEqual([])
  })
})

// fe-auth-client-7, delta-fe-manage-3: a team or club manager link opened on
// the device and not redeemed is never left for whoever signs in next
describe('AuthProvider on a shared device: a kept team link', () => {
  const LINK = 'ov:pendingTeamLink'
  const keepLink = () => localStorage.setItem(LINK, JSON.stringify({ code: 'ABCD-EFGH-JKMN', at: Date.now(), kind: 'club' }))

  it('stays through the start of the page, signed out or in (sign-up, the email confirmation)', async () => {
    keepLink()
    h.stored = null
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { await h.onChange('INITIAL_SESSION', null) })
    expect(localStorage.getItem(LINK)).not.toBeNull()
    // signing in after it (a new account) keeps it for the question
    await act(async () => { await h.onChange('SIGNED_IN', sessionA) })
    expect(localStorage.getItem(LINK)).not.toBeNull()
  })

  it('goes with Sign out, a session that ends and another account signing in', async () => {
    const { seeded } = await startSignedInAsA()
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    keepLink()
    await act(async () => { await ctx.signOut() })
    expect(localStorage.getItem(LINK)).toBeNull()

    await act(async () => { await h.onChange('SIGNED_IN', sessionA) })
    keepLink()
    await act(async () => { h.stored = null; await h.onChange('SIGNED_OUT', null) })
    expect(localStorage.getItem(LINK)).toBeNull()

    await act(async () => { await h.onChange('SIGNED_IN', sessionA) })
    keepLink()
    await act(async () => { await h.onChange('SIGNED_IN', { access_token: 'tok-B', user: { id: 'user-B' } }) })
    expect(localStorage.getItem(LINK)).toBeNull()
  })
})

describe('AuthProvider: a profile read that answers late', () => {
  it('after Sign out it is dropped: nobody\'s profile in state or on disk', async () => {
    const { seeded } = await startSignedInAsA()
    expect(h.profileReads).toHaveLength(1) // A's read is on the way (slow network)

    await act(async () => { await ctx.signOut(); h.stored = null; await h.onChange('SIGNED_OUT', null) })
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    expect(ctx.user).toBeNull()
    expect(ctx.profile).toBeNull()
    expect(localStorage.getItem('cachedProfile')).toBeNull()
  })

  it('after another account signed in it is dropped: B runs on B\'s profile and roles', async () => {
    const { seeded } = await startSignedInAsA()
    await act(async () => { await ctx.signOut(); h.stored = null; await h.onChange('SIGNED_OUT', null) })

    let signedIn
    await act(async () => { signedIn = ctx.signIn('b@example.test', 'pw'); await Promise.resolve() })
    expect(h.profileReads.map((r) => r.userId)).toEqual(['user-A', 'user-B'])
    await answerProfileRead(1, profileB)
    await act(async () => { await signedIn })
    // A's answer arrives last
    await answerProfileRead(0, profileA)
    await act(async () => { await seeded })
    expect(ctx.user?.id).toBe('user-B')
    expect(ctx.profile).toMatchObject({ user_id: 'user-B', first_name: 'Ben' })
    expect(ctx.access.isAdmin).toBe(false)
    expect(JSON.parse(localStorage.getItem('cachedProfile'))).toMatchObject({ user_id: 'user-B' })
    expect(ctx.getCachedProfile()).toMatchObject({ user_id: 'user-B' })
  })
})
