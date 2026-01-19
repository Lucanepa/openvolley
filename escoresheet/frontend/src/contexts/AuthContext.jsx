import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  // Only show loading if supabase is configured (otherwise show sign-in immediately)
  const [loading, setLoading] = useState(!!supabase)
  // Prevent duplicate profile fetches
  const fetchingProfile = useRef(false)

  // Fetch user profile from profiles table
  const fetchProfile = useCallback(async (userId) => {
    console.log('[AuthContext] fetchProfile called with userId:', userId)
    if (!supabase || !userId) {
      console.log('[AuthContext] No supabase or userId, setting profile to null')
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
      console.log('[AuthContext] Fetching profile from Supabase...')

      // Add timeout to detect hanging queries (15s to allow for Supabase cold starts)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Profile query timed out after 15s')), 15000)
      )

      const queryPromise = supabase
        .from('profiles')
        .select('*')
        .eq('user_id', userId)
        .single()

      const { data, error } = await Promise.race([queryPromise, timeoutPromise])

      console.log('[AuthContext] Profile query result:', { data, error })

      if (error) {
        console.warn('[AuthContext] Failed to fetch profile:', error.message, error)
        setProfile(null)
        return null
      }

      setProfile(data)
      console.log('[AuthContext] Profile set successfully:', data)
      // Cache profile in localStorage for offline auto-fill
      localStorage.setItem('cachedProfile', JSON.stringify(data))
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
    if (!supabase) {
      setLoading(false)
      return
    }

    // Timeout to prevent infinite loading state (max 3 seconds)
    const loadingTimeout = setTimeout(() => {
      setLoading(false)
    }, 3000)

    // Listen for auth changes FIRST (this is the reliable way to get auth state)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('[AuthContext] onAuthStateChange:', event, session?.user?.id)
        clearTimeout(loadingTimeout)
        setUser(session?.user ?? null)

        // Only fetch profile on events where we know auth is fully ready
        // SIGNED_IN fires during session recovery before token refresh - skip it here
        // (signIn function calls fetchProfile directly for fresh sign-ins)
        if (session?.user && (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          await fetchProfile(session.user.id)
        } else if (!session?.user) {
          setProfile(null)
        }
        setLoading(false)
      }
    )

    // Get initial session (triggers onAuthStateChange with INITIAL_SESSION event)
    supabase.auth.getSession().then(({ data: { session } }) => {
      console.log('[AuthContext] getSession result:', session?.user?.id)
      // Don't call fetchProfile here - let onAuthStateChange handle it
      // This prevents duplicate fetches
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
    if (!supabase) {
      return { error: { message: 'Supabase not configured' } }
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (!error && data?.user) {
      await fetchProfile(data.user.id)
    }

    return { data, error }
  }, [fetchProfile])

  // Sign up with email/password
  const signUp = useCallback(async (email, password, profileData = {}) => {
    if (!supabase) {
      return { error: { message: 'Supabase not configured' } }
    }

    // Pass profile data in user metadata - the database trigger will read it
    const { data, error } = await supabase.auth.signUp({
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
    if (!supabase) {
      return { error: { message: 'Supabase not configured' } }
    }

    const { error } = await supabase.auth.signOut()
    if (!error) {
      setUser(null)
      setProfile(null)
      localStorage.removeItem('cachedProfile')
    }

    return { error }
  }, [])

  // Update profile
  const updateProfile = useCallback(async (updates) => {
    if (!supabase || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({
        first_name: updates.firstName,
        last_name: updates.lastName,
        country: updates.country,
        dob: updates.dob,
        roles: updates.roles,
        sport_type: 'indoor'
      })
      .eq('user_id', user.id)
      .select()
      .single()

    if (!error && data) {
      setProfile(data)
      localStorage.setItem('cachedProfile', JSON.stringify(data))
    }

    return { data, error }
  }, [user])

  // Reset password
  const resetPassword = useCallback(async (email) => {
    if (!supabase) {
      return { error: { message: 'Supabase not configured' } }
    }

    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`
    })

    return { data, error }
  }, [])

  // Update email - sends confirmation to new email
  const updateEmail = useCallback(async (newEmail) => {
    if (!supabase || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    const { data, error } = await supabase.auth.updateUser({
      email: newEmail
    })

    return { data, error }
  }, [user])

  // Get cached profile for offline use
  const getCachedProfile = useCallback(() => {
    const cached = localStorage.getItem('cachedProfile')
    return cached ? JSON.parse(cached) : null
  }, [])

  // Delete account - requires RPC function in database
  const deleteAccount = useCallback(async () => {
    if (!supabase || !user) {
      return { error: { message: 'Not authenticated' } }
    }

    try {
      // Call the delete_user RPC function which deletes the auth user
      // This function must be created in Supabase with SECURITY DEFINER
      const { error: rpcError } = await supabase.rpc('delete_user')

      if (rpcError) {
        console.error('Delete user RPC error:', rpcError)
        return { error: rpcError }
      }

      // Clear local state
      setUser(null)
      setProfile(null)
      localStorage.removeItem('cachedProfile')

      return { error: null }
    } catch (err) {
      console.error('Delete account error:', err)
      return { error: { message: err.message } }
    }
  }, [user])

  const value = {
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
  }

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
