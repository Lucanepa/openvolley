import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFrom, apiAuth } from '../lib/apiClient'
import { getCloudApiUrl } from '../utils/backendConfig'
import { profileUpdateColumns, confirmedProfileRow, PROFILE_NOT_SAVED } from '../components/auth/profileWrite'
import { discardUnsentLogs } from '../utils/logger'

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
          roles: profileData.roles || ['scorer'],
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

      return { error: null }
    } catch (err) {
      console.error('Delete account error:', err)
      return { error: { message: err.message } }
    }
  }, [user])

  const value = useMemo(() => ({
    user,
    profile,
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
  }), [user, profile, loading, signIn, signUp, signOut, updateProfile, updateEmail, resetPassword, fetchProfile, getCachedProfile, deleteAccount])

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
