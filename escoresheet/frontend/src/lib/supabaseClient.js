import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

console.log('[Supabase DEBUG] ========== INIT ==========')
console.log('[Supabase DEBUG] VITE_SUPABASE_URL:', url ? `${url.substring(0, 30)}...` : 'MISSING!')
console.log('[Supabase DEBUG] VITE_SUPABASE_ANON_KEY:', key ? `${key.substring(0, 20)}...` : 'MISSING!')
console.log('[Supabase DEBUG] Both env vars present:', !!(url && key))

export const supabase = (url && key) ? createClient(url, key) : null

console.log('[Supabase DEBUG] Client created:', !!supabase)
if (!supabase) {
  console.error('[Supabase DEBUG] FAILED TO CREATE CLIENT - check environment variables!')
}
console.log('[Supabase DEBUG] ========== DONE ==========')


