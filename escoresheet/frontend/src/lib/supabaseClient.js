import { createClient } from '@supabase/supabase-js'

/**
 * Supabase client — REALTIME ONLY.
 *
 * All database, storage, and auth operations go through the backend proxy
 * (see apiClient.js). This client exists solely for Realtime channel
 * subscriptions (postgres_changes) which require a direct WebSocket
 * connection to Supabase.
 *
 * The anon key is used here (read-only listeners).
 * The service_role key stays server-side in the backend.
 */
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = (url && key) ? createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
}) : null
