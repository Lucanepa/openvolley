import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFrom, apiAuth } from '../lib/apiClient'
import { getCloudApiUrl } from '../utils/backendConfig'
import { profileUpdateColumns, confirmedProfileRow, PROFILE_NOT_SAVED } from '../components/auth/profileWrite'
import { discardUnsentLogs } from '../utils/logger'
import { accessFromRoles, accessChanged, NO_ACCESS, ACCESS_CHANGED_EVENT } from '../lib/access'
import { fetchMe, redeemInvite as apiRedeemInvite } from '../lib/accountApi'
import { clearSavedTeams, refreshSavedTeams } from '../db/savedTeams'
import { clearGameRosters, refreshGameRosters, GAME_ROSTERS_REFRESH_MS } from '../db/gameRosters'
import { clearClubPlayers, refreshClubPlayers } from '../db/clubPlayers'
import i18n from 'i18next'
import PasskeyOfferHost from '../components/auth/PasskeyOfferHost'

const AuthContext = createContext(null)

// Same-tab notice that the signed-in account's profile was cached (the
// 'storage' event only reaches other tabs). useUserMatchLink (hooks/useSyncQueue)
// re-checks the My Matches roles then: they compare the profile name with the
// match officials.
export const PROFILE_CACHED_EVENT = 'ov-profile-cached'
function cacheProfile(profile) {
  try {
    localStorage.setItem('cachedProfile', JSON.stringify(profile))
    window.dispatchEvent(new Event(PROFILE_CACHED_EVENT))
  } catch { /* storage full or blocked: offline auto-fill just has no profile */ }
}

function readCachedProfile() {
  try {
    const cached = localStorage.getItem('cachedProfile')
    return cached ? JSON.parse(cached) : null
  } catch {
    return null
  }
}

// The clubs the account scores for and whether the rule "home games of your
// club only" is on (db/018, GET /api/me), kept per account for offline use.
const CLUBS_CACHE_KEY = 'ov:clubs'
export function readCachedClubs(userId) {
  try {
    const v = JSON.parse(localStorage.getItem(CLUBS_CACHE_KEY) || 'null')
    return v && v.userId === userId ? v : null
  } catch {
    return null
  }
}
function cacheClubs(value) {
  try { localStorage.setItem(CLUBS_CACHE_KEY, JSON.stringify(value)) } catch { /* the online check still applies */ }
}

// A pending account re-reads its profile this often, so an admin's approval
// (or an invite redeemed on another device) shows without a reload.
export const PENDING_PROFILE_POLL_MS = 60000

// The same content as before keeps the same object (owner 2026-11-11: "it
// loads something, stops, loads it again"): every auth event and profile read
// handed out a new object, and each new one re-ran the effects below (roster,
// club and saved-team refreshes → local writes → every list filled again).
function sameJson(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}
export function keepSameUser(prev, next) {
  if (!next) return null
  return prev && prev.id === next.id && sameJson(prev, next) ? prev : next
}
export function keepSameProfile(prev, next) {
  return prev && next && sameJson(prev, next) ? prev : next
}

// /api/me again on a window focus at most this often (each focus of the
// window, e.g. back from a file picker, read it again)
export const ME_FOCUS_REFRESH_MS = 60000

// Check if backend proxy is available (for auth operations)
const hasBackend = () => !!getCloudApiUrl('/api/auth/sign-in')

/**
 * @param {object} props
 * @param {'beach'} [props.app] the OpenBeach manager (manager-beach-main.jsx):
 *   sign-up, password reset and "send a new link" ask for OpenBeach's mails
 *   and sign-up joins OpenBeach. Left out (every other page): as before.
 */
export function AuthProvider({ children, app = null }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  // Only show loading if backend is configured (otherwise show sign-in immediately)
  const [loading, setLoading] = useState(hasBackend())
  // Prevent duplicate profile fetches: a second call while one runs gets
  // the running one's answer (not null, which read as "no profile")
  const fetchingProfile = useRef(null)

  // One read of the profile row (fetchProfile shares a running one)
  const readProfile = useCallback(async (userId) => {
    try {
      console.log('[AuthContext] Fetching profile...')

      // Add timeout to detect hanging queries (15s to allow for cold starts)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Profile query timed out after 15s')), 15000)
      )

      const queryPromise = apiFrom('profiles')
        .select('*')
        .eq('user_id', userId)
        .single()

      const { data, error } = await Promise.race([queryPromise, timeoutPromise])

      if (import.meta.env.DEV) console.log('[AuthContext] Profile query result:', { data, error })

      if (error) {
        console.warn('[AuthContext] Failed to fetch profile:', error.message, error)
        setProfile(null)
        return null
      }

      setProfile(prev => keepSameProfile(prev, data))
      if (import.meta.env.DEV) console.log('[AuthContext] Profile set successfully:', data)
      // Cache profile in localStorage for offline auto-fill
      cacheProfile(data)
      return data
    } catch (err) {
      console.error('[AuthContext] Profile fetch error:', err.message, err)
      setProfile(null)
      return null
    }
  }, [])

  // Fetch user profile from profiles table
  const fetchProfile = useCallback(async (userId) => {
    console.log('[AuthContext] fetchProfile called with userId:', userId)
    if (!hasBackend() || !userId) {
      console.log('[AuthContext] No backend or userId, setting profile to null')
      setProfile(null)
      return null
    }

    // Prevent duplicate concurrent fetches
    if (fetchingProfile.current?.userId === userId) {
      console.log('[AuthContext] Already fetching profile, sharing the running request')
      return fetchingProfile.current.promise
    }
    const promise = readProfile(userId)
    const mine = { userId, promise }
    fetchingProfile.current = mine
    try {
      return await promise
    } finally {
      if (fetchingProfile.current === mine) fetchingProfile.current = null
    }
  }, [readProfile])

  // Initialize auth state
  useEffect(() => {
    if (!hasBackend()) {
      setLoading(false)
      return
    }

    // Timeout to prevent infinite loading state (max 3 seconds)
    const loadingTimeout = setTimeout(() => {
      setLoading(false)
    }, 3000)

    // Listen for auth changes
    const { data: { subscription } } = apiAuth.onAuthStateChange(
      async (event, session) => {
        console.log('[AuthContext] onAuthStateChange:', event, session?.user?.id)
        clearTimeout(loadingTimeout)
        setUser(prev => keepSameUser(prev, session?.user ?? null))

        if (session?.user && (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          await fetchProfile(session.user.id)
        } else if (!session?.user) {
          setProfile(null)
        }
        setLoading(false)
        // A sign-in is a moment the app is in use and online: the update
        // checks listen for it (utils/androidUpdate.js in the Android app,
        // hooks/useDesktopUpdate.js in the desktop app) and throttle
        // themselves. Fired once per sign-in, here only.
        if (event === 'SIGNED_IN' && typeof window !== 'undefined') {
          try { window.dispatchEvent(new CustomEvent('ov-signed-in')) } catch { /* no window events */ }
        }
      }
    )

    // Get initial session. The UI was seeded from the unverified stored session
    // (INITIAL_SESSION); reconcile it with the server's answer. getSession only
    // drops the session when the server rejects the token, never when offline.
    apiAuth.getSession().then(({ data: { session } }) => {
      console.log('[AuthContext] getSession result:', session?.user?.id, session?.unverified ? '(unverified)' : '')
      if (!session) {
        setUser(null)
        setProfile(null)
      } else if (session.user && !session.unverified) {
        // Same account: keep the object, unless the server now says the
        // address is confirmed (the stored copy is from before the link)
        setUser(prev => (prev?.id === session.user.id && !!prev.email_confirmed_at === !!session.user.email_confirmed_at ? prev : session.user))
      }
    }).catch((err) => {
      clearTimeout(loadingTimeout)
      console.error('Failed to get auth session:', err)
      setLoading(false)
    })

    return () => {
      clearTimeout(loadingTimeout)
      subscription?.unsubscribe()
    }
  }, [fetchProfile])

  // Sign in with email/password
  const signIn = useCallback(async (email, password) => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    const { data, error } = await apiAuth.signInWithPassword({
      email,
      password
    })

    if (!error && data?.user) {
      setUser(prev => keepSameUser(prev, data.user))
      await fetchProfile(data.user.id)
    }

    return { data, error }
  }, [fetchProfile])

  // Sign in with a passkey (lib/passkeys.js): no address, no password — the
  // key says whose account it is.
  const signInWithPasskey = useCallback(async () => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }
    const { runPasskeySignIn } = await import('../lib/passkeys')
    const { data, error } = await apiAuth.signInWithPasskey(runPasskeySignIn)
    if (!error && data?.user) {
      setUser(prev => keepSameUser(prev, data.user))
      await fetchProfile(data.user.id)
    }
    return { data, error }
  }, [fetchProfile])

  // Sign up with email/password
  // `requests` (db/025): what the account asks for at sign-up, [{ kind, club_id?, team_id? }]
  const signUp = useCallback(async (email, password, profileData = {}, { requests } = {}) => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    const { data, error } = await apiAuth.signUp({
      email,
      password,
      options: {
        lang: i18n.language,
        ...(app ? { app } : {}),
        ...(Array.isArray(requests) && requests.length ? { requests } : {}),
        data: {
          first_name: profileData.firstName || null,
          last_name: profileData.lastName || null,
          country: profileData.country || 'CHE',
          dob: profileData.dob || null,
          // No roles: the server never takes them from the client. New
          // accounts are pending until an admin approves them or they
          // redeem an invite code.
          sport_type: app === 'beach' ? 'beach' : 'indoor'
        }
      }
    })

    return { data, error }
  }, [app])

  // Sign out
  const signOut = useCallback(async () => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    const { error } = await apiAuth.signOut()
    if (!error) {
      setUser(null)
      setProfile(null)
      localStorage.removeItem('cachedProfile')
      localStorage.removeItem(CLUBS_CACHE_KEY)
      // Console lines not uploaded yet belong to this account: never upload
      // them under the next one signing in on this device
      discardUnsentLogs()
      // The saved-team cache holds DOBs and licence numbers of this account's
      // teams: never leave it for the next one on a shared tablet
      clearSavedTeams()
      // the rosters teams sent (db/023) too, and the clubs' licence lists (db/024)
      clearGameRosters()
      clearClubPlayers()
    }

    return { error }
  }, [])

  // Update profile
  const updateProfile = useCallback(async (updates) => {
    if (!hasBackend() || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    // roles/user_id are never writable (the backend strips them and scopes the
    // row to the caller), so only the editable columns are sent.
    const columns = profileUpdateColumns(updates)
    const { data, error } = await apiFrom('profiles')
      .update(columns)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error) return { data, error }

    // Success only when the backend returns the written row with the new
    // values. Anything else (no row, an unchanged row) was not saved and must
    // not be shown as saved.
    const updatedProfile = confirmedProfileRow(columns, data)
    if (!updatedProfile) {
      console.warn('[AuthContext] Profile save not confirmed by the backend')
      return { data: null, error: { message: 'Your profile was not saved. Please reload the app and try again.', code: PROFILE_NOT_SAVED } }
    }
    setProfile(prev => keepSameProfile(prev, updatedProfile))
    cacheProfile(updatedProfile)

    return { data: updatedProfile, error: null }
  }, [user])

  // Reset password
  const resetPassword = useCallback(async (email) => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    // The email's language follows the app's (the server maps de-CH to de)
    const { data, error, status } = await apiAuth.resetPasswordForEmail(email, { lang: i18n.language, ...(app ? { app } : {}) })

    return { data, error, status }
  }, [app])

  // Re-reads the signed-in user from the server (after the address was
  // confirmed on another page or device). Returns the fresh user or null.
  const refreshUser = useCallback(async () => {
    if (!hasBackend()) return null
    try {
      const { data } = await apiAuth.getSession()
      const fresh = data?.session && !data.session.unverified ? data.session.user : null
      if (fresh) setUser(prev => (prev?.id === fresh.id ? keepSameUser(prev, fresh) : prev))
      return fresh ?? null
    } catch {
      return null
    }
  }, [])

  // A fresh confirmation link for the signed-in, unconfirmed account
  const resendConfirmation = useCallback(async () => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }
    return app ? apiAuth.resendConfirmation(i18n.language, app) : apiAuth.resendConfirmation(i18n.language)
  }, [app])

  // Update email - sends confirmation to new email
  const updateEmail = useCallback(async (newEmail) => {
    if (!hasBackend() || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    const { data, error } = await apiAuth.updateUser({
      email: newEmail
    })

    return { data, error }
  }, [user])

  // Get cached profile for offline use
  const getCachedProfile = useCallback(() => {
    const cached = localStorage.getItem('cachedProfile')
    return cached ? JSON.parse(cached) : null
  }, [])

  // Delete account
  const deleteAccount = useCallback(async () => {
    if (!hasBackend() || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    try {
      const { error } = await apiAuth.deleteUser()

      if (error) {
        console.error('Delete user error:', error)
        return { error }
      }

      // Clear local state
      setUser(null)
      setProfile(null)
      localStorage.removeItem('cachedProfile')
      localStorage.removeItem(CLUBS_CACHE_KEY)
      discardUnsentLogs()
      clearSavedTeams()
      clearGameRosters()
      clearClubPlayers()

      return { error: null }
    } catch (err) {
      console.error('Delete account error:', err)
      return { error: { message: err.message } }
    }
  }, [user])

  // What this account may do (spec section 1). From the loaded profile, or
  // the cached one of the same account when offline. The server enforces
  // every rule; the UI only hides what the account cannot do.
  // `known` is false while neither a profile nor a cached one is at hand
  // (first load on a new device): the UI then shows no "pending" state yet.
  const userId = user?.id ?? null
  const accessSource = useMemo(() => {
    if (!userId) return null
    if (profile) return profile
    const cached = readCachedProfile()
    return cached && (!cached.user_id || cached.user_id === userId) ? cached : null
  }, [userId, profile])
  const rolesKey = JSON.stringify(accessSource?.roles ?? [])
  const known = !!accessSource
  // db/018: the account's clubs (from /api/me, else the cache of this account)
  const [clubsState, setClubsState] = useState(null)
  // bumped to load the clubs again (an invite code that carries a club)
  const [clubsReload, setClubsReload] = useState(0)
  // The account whose first /api/me of this page load answered (or failed,
  // or took over 5 s): until then the manager console does not decide its
  // tabs from the cache, so My club / My teams do not pop in later
  const [meDoneFor, setMeDoneFor] = useState(null)
  const meLoaded = !!userId && meDoneFor === userId
  const clubsSource = clubsState?.userId === userId ? clubsState : (userId ? readCachedClubs(userId) : null)
  const clubsKey = JSON.stringify(clubsSource ? [clubsSource.clubs, clubsSource.clubRule, clubsSource.managedClubs || [], clubsSource.managedTeams || [], clubsSource.requests || []] : null)
  const access = useMemo(() => {
    if (!userId) return NO_ACCESS
    const c = JSON.parse(clubsKey)
    // db/020: managedClubs, the clubs the account manages (the manager's My club tab)
    // db/023: managedTeams, the teams it acts for (the manager's My teams tab)
    // db/025: requests, what it asked for at sign-up and is still open
    return { ...accessFromRoles(JSON.parse(rolesKey)), known, clubs: c ? c[0] : [], clubRule: c ? c[1] === true : false, managedClubs: c ? c[2] : [], managedTeams: c ? (c[3] || []) : [], requests: c ? (c[4] || []) : [], clubsKnown: !!c }
  }, [userId, rolesKey, known, clubsKey])

  // Load the clubs once signed in, and again on focus and when back online
  // (an admin may have added one meanwhile)
  useEffect(() => {
    if (!userId || !hasBackend()) return
    let gone = false
    const settle = () => { if (!gone) setMeDoneFor(userId) }
    const fallback = setTimeout(settle, 5000)
    let lastLoad = 0
    const load = () => {
      lastLoad = Date.now()
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        settle()
        return
      }
      // never throws into the effect (a failing request keeps the cache)
      Promise.resolve().then(() => fetchMe()).then((res) => {
        settle()
        if (gone || res?.error || !res?.data) return
        const value = {
          userId,
          clubs: Array.isArray(res.data.clubs) ? res.data.clubs : [],
          clubRule: res.data.clubRule === true,
          managedClubs: Array.isArray(res.data.managedClubs) ? res.data.managedClubs : [],
          managedTeams: Array.isArray(res.data.managedTeams) ? res.data.managedTeams : [],
          requests: Array.isArray(res.data.requests) ? res.data.requests : []
        }
        cacheClubs(value)
        // the same answer again (a focus) changes nothing on screen
        setClubsState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(value) ? prev : value))
      }).catch(() => { settle() /* offline-first: keep the cache */ })
    }
    // a focus reads it again only when the last read is a minute old
    const onFocus = () => { if (Date.now() - lastLoad >= ME_FOCUS_REFRESH_MS) load() }
    load()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', load)
    return () => {
      gone = true
      clearTimeout(fallback)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', load)
    }
  }, [userId, clubsReload])

  // Tell the rest of the app (sync queue, saved-team cache) when the access
  // changed, e.g. a pending account was approved.
  const previousAccess = useRef(null)
  useEffect(() => {
    const prev = previousAccess.current
    previousAccess.current = access
    if (prev && accessChanged(prev, access)) {
      try { window.dispatchEvent(new CustomEvent(ACCESS_CHANGED_EVENT, { detail: access })) } catch { /* no window */ }
    }
  }, [access])

  // Another account (or none) on this device: drop the saved-team cache.
  const previousUserId = useRef(undefined)
  useEffect(() => {
    const id = userId
    const prev = previousUserId.current
    previousUserId.current = id
    if (prev !== undefined && prev !== null && prev !== id) {
      clearSavedTeams()
      clearGameRosters()
      clearClubPlayers()
    }
  }, [userId])

  // The refreshes below run per account and per access, not per profile
  // object: a re-read profile with the same roles changes nothing they read
  const hasProfile = !!profile

  // db/023, offline first: download the rosters teams sent for the coming
  // home games while there is a connection (sign-in, every 15 minutes, back
  // online), so Match Setup offers them in a hall without internet. db/024:
  // the licence lists of the account's clubs the same way ("Add from club").
  useEffect(() => {
    if (!userId || !hasProfile || !access.canScore || access.isPending || !hasBackend()) return
    const refresh = () => {
      refreshGameRosters({ access, userId }).catch(() => { /* keep the cache */ })
      refreshClubPlayers({ access, userId }).catch(() => { /* keep the cache */ })
    }
    refresh()
    const timer = setInterval(refresh, GAME_ROSTERS_REFRESH_MS)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', refresh)
    }
  }, [userId, hasProfile, access])

  // Load the saved teams once the profile says this account may read them.
  useEffect(() => {
    if (!userId || !hasProfile || !access.canReadTeams) return
    refreshSavedTeams({ access, userId }).catch(() => { /* offline-first: keep the cache */ })
  }, [userId, hasProfile, access])

  // A pending account re-reads its profile: every minute, on focus and when
  // the connection comes back.
  useEffect(() => {
    if (!userId || !access.isPending || !hasBackend()) return
    const refresh = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      fetchProfile(userId)
    }
    // db/025: a part of its sign-up request approved without a role (a team or
    // a club to manage) shows through /api/me, read again with the profile (on
    // focus and back online it is read anyway)
    const timer = setInterval(() => { refresh(); setClubsReload((n) => n + 1) }, PENDING_PROFILE_POLL_MS)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [userId, access.isPending, fetchProfile])

  // Redeem a club invite code. On success the new roles apply at once (the
  // profile is then re-read from the server).
  const redeemInvite = useCallback(async (code) => {
    if (!hasBackend() || !user) return { data: null, error: { message: 'Not authenticated', status: 401 }, status: 401 }
    const result = await apiRedeemInvite(code)
    if (!result.error && Array.isArray(result.data?.roles)) {
      setProfile(prev => {
        const next = { ...(prev || readCachedProfile() || { user_id: user.id }), roles: result.data.roles }
        cacheProfile(next)
        return next
      })
      fetchProfile(user.id)
      // a code may carry a club (db/018): the clubs come again from /api/me
      setClubsReload((n) => n + 1)
    }
    return result
  }, [user, fetchProfile])

  const value = useMemo(() => ({
    user,
    profile,
    access,
    meLoaded,
    redeemInvite,
    loading,
    isAuthenticated: !!user,
    signIn,
    signInWithPasskey,
    signUp,
    signOut,
    updateProfile,
    updateEmail,
    resetPassword,
    resendConfirmation,
    refreshUser,
    fetchProfile,
    getCachedProfile,
    deleteAccount
  }), [user, profile, access, meLoaded, redeemInvite, loading, signIn, signInWithPasskey, signUp, signOut, updateProfile, updateEmail, resetPassword, resendConfirmation, refreshUser, fetchProfile, getCachedProfile, deleteAccount])

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/* the offer to set up a passkey after a password sign-in (LoginModal) */}
      <PasskeyOfferHost />
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export { AuthContext }
