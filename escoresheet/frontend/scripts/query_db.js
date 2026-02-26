import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Error: VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not found in environment.')
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function query(table, select = '*', filter = null) {
    let q = supabase.from(table).select(select)

    if (filter) {
        // Basic filter implementation: "column:value"
        const [column, value] = filter.split(':')
        q = q.eq(column, value)
    }

    const { data, error } = await q

    if (error) {
        console.error('Query Error:', error)
        process.exit(1)
    }

    console.log(JSON.stringify(data, null, 2))
}

const args = process.argv.slice(2)
const table = args[0]
const select = args[1] || '*'
const filter = args[2] || null

if (!table) {
    console.log('Usage: node scripts/query_db.js <table> [select] [filter]')
    process.exit(0)
}

query(table, select, filter)
