import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

console.log('🔍 Supabase Client Initialization:')
console.log('  - VITE_SUPABASE_URL:', url ? `${url.substring(0, 20)}...` : '❌ MISSING')
console.log('  - VITE_SUPABASE_ANON_KEY:', key ? `${key.substring(0, 20)}...` : '❌ MISSING')
console.log('  - All env vars:', Object.keys(import.meta.env).filter(k => k.startsWith('VITE_')))

if (!url || !key) {
  console.warn('⚠️ Supabase not configured. Missing environment variables.')
  if (!url) console.warn('  → VITE_SUPABASE_URL is missing')
  if (!key) console.warn('  → VITE_SUPABASE_ANON_KEY is missing')
  console.warn('  → Check GitHub Secrets or .env file')
}

export const supabase = (url && key) ? createClient(url, key) : null

if (supabase) {
  console.log('✅ Supabase client created successfully')
} else {
  console.warn('❌ Supabase client is null - app will run in offline mode')
}


