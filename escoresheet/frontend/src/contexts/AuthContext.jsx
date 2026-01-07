import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  // Only show loading if supabase is configured (otherwise show sign-in immediately)
  const [loading, setLoading] = useState(!!supabase)

  // Fetch user profile from profiles table
  const fetchProfile = useCallback(async (userId) => {
    if (!supabase || !userId) {
      setProfile(null)
      return null
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (error) {
      console.warn('Failed to fetch profile:', error.message)
      setProfile(null)
      return null
    }

    setProfile(data)
    // Cache profile in localStorage for offline auto-fill
    localStorage.setItem('cachedProfile', JSON.stringify(data))
    return data
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

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(loadingTimeout)
      setUser(session?.user ?? null)
      if (session?.user) {
        fetchProfile(session.user.id)
      }
      setLoading(false)
    }).catch((err) => {
      clearTimeout(loadingTimeout)
      console.error('Failed to get auth session:', err)
      setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setUser(session?.user ?? null)
        if (session?.user) {
          await fetchProfile(session.user.id)
        } else {
          setProfile(null)
        }
      }
    )

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
          roles: profileData.roles || ['scorer']
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
        roles: updates.roles
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
