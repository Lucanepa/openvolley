import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFrom, apiAuth } from '../lib/apiClient'
import { getCloudApiUrl } from '../utils/backendConfig'
import { profileUpdateColumns, confirmedProfileRow, PROFILE_NOT_SAVED } from '../components/auth/profileWrite'
import { discardUnsentLogs } from '../utils/logger'
import { accessFromRoles, accessChanged, NO_ACCESS, ACCESS_CHANGED_EVENT } from '../lib/access'
import { redeemInvite as apiRedeemInvite } from '../lib/accountApi'
import { clearSavedTeams, refreshSavedTeams } from '../db/savedTeams'

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

// A pending account re-reads its profile this often, so an admin's approval
// (or an invite redeemed on another device) shows without a reload.
export const PENDING_PROFILE_POLL_MS = 60000

// Check if backend proxy is available (for auth operations)
const hasBackend = () => !!getCloudApiUrl('/api/auth/sign-in')

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  // Only show loading if backend is configured (otherwise show sign-in immediately)
  const [loading, setLoading] = useState(hasBackend())
  // Prevent duplicate profile fetches
  const fetchingProfile = useRef(false)

  // Fetch user profile from profiles table
  const fetchProfile = useCallback(async (userId) => {
    console.log('[AuthContext] fetchProfile called with userId:', userId)
    if (!hasBackend() || !userId) {
      console.log('[AuthContext] No backend or userId, setting profile to null')
      setProfile(null)
      return null
    }

    // Prevent duplicate concurrent fetches
    if (fetchingProfile.current) {
      console.log('[AuthContext] Already fetching profile, skipping duplicate request')
      return null
    }

    try {
      fetchingProfile.current = true
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

      setProfile(data)
      if (import.meta.env.DEV) console.log('[AuthContext] Profile set successfully:', data)
      // Cache profile in localStorage for offline auto-fill
      cacheProfile(data)
      return data
    } catch (err) {
      console.error('[AuthContext] Profile fetch error:', err.message, err)
      setProfile(null)
      return null
    } finally {
      fetchingProfile.current = false
    }
  }, [])

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
        setUser(session?.user ?? null)

        if (session?.user && (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          await fetchProfile(session.user.id)
        } else if (!session?.user) {
          setProfile(null)
        }
        setLoading(false)
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
        setUser(prev => (prev?.id === session.user.id ? prev : session.user))
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
      setUser(data.user)
      await fetchProfile(data.user.id)
    }

    return { data, error }
  }, [fetchProfile])

  // Sign up with email/password
  const signUp = useCallback(async (email, password, profileData = {}) => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    const { data, error } = await apiAuth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: profileData.firstName || null,
          last_name: profileData.lastName || null,
          country: profileData.country || 'CHE',
          dob: profileData.dob || null,
          // No roles: the server never takes them from the client. New
          // accounts are pending until an admin approves them or they
          // redeem an invite code.
          sport_type: 'indoor'
        }
      }
    })

    return { data, error }
  }, [])

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
      // Console lines not uploaded yet belong to this account: never upload
      // them under the next one signing in on this device
      discardUnsentLogs()
      // The saved-team cache holds DOBs and licence numbers of this account's
      // teams: never leave it for the next one on a shared tablet
      clearSavedTeams()
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
    setProfile(updatedProfile)
    cacheProfile(updatedProfile)

    return { data: updatedProfile, error: null }
  }, [user])

  // Reset password
  const resetPassword = useCallback(async (email) => {
    if (!hasBackend()) {
      return { error: { message: 'Backend not configured' } }
    }

    const { data, error } = await apiAuth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`
    })

    return { data, error }
  }, [])

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
      discardUnsentLogs()
      clearSavedTeams()

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
  const access = useMemo(() => {
    if (!userId) return NO_ACCESS
    return { ...accessFromRoles(JSON.parse(rolesKey)), known }
  }, [userId, rolesKey, known])

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
    const id = user?.id ?? null
    const prev = previousUserId.current
    previousUserId.current = id
    if (prev !== undefined && prev !== null && prev !== id) clearSavedTeams()
  }, [user])

  // Load the saved teams once the profile says this account may read them.
  useEffect(() => {
    if (!user || !profile || !access.canReadTeams) return
    refreshSavedTeams({ access, userId: user.id }).catch(() => { /* offline-first: keep the cache */ })
  }, [user, profile, access])

  // A pending account re-reads its profile: every minute, on focus and when
  // the connection comes back.
  useEffect(() => {
    if (!user || !access.isPending || !hasBackend()) return
    const refresh = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      fetchProfile(user.id)
    }
    const timer = setInterval(refresh, PENDING_PROFILE_POLL_MS)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [user, access.isPending, fetchProfile])

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
    }
    return result
  }, [user, fetchProfile])

  const value = useMemo(() => ({
    user,
    profile,
    access,
    redeemInvite,
    loading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    signOut,
    updateProfile,
    updateEmail,
    resetPassword,
    fetchProfile,
    getCachedProfile,
    deleteAccount
  }), [user, profile, access, redeemInvite, loading, signIn, signUp, signOut, updateProfile, updateEmail, resetPassword, fetchProfile, getCachedProfile, deleteAccount])

  return (
    <AuthContext.Provider value={value}>
      {children}
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
