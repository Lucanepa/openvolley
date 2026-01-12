import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing env vars')
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function checkColumns(table) {
    const { data, error } = await supabase.from(table).select('*').limit(1)
    if (error) {
        console.error(`Error querying ${table}:`, error.message)
        return
    }
    if (data && data.length > 0) {
        console.log(`\nColumns for table '${table}':`)
        console.log(Object.keys(data[0]).join('\n'))
    } else {
        console.log(`\nTable '${table}' is empty or not found.`)
    }
}

async function run() {
    await checkColumns('matches')
    await checkColumns('sets')
    await checkColumns('events')
    await checkColumns('match_live_state')
}

run()
