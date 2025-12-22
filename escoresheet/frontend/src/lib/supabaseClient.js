import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

console.log('[Supabase] URL:', url ? 'set' : 'missing', 'Key:', key ? 'set' : 'missing')

export const supabase = (url && key) ? createClient(url, key) : null

console.log('[Supabase] Client initialized:', !!supabase)


