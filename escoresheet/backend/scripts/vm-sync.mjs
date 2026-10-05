#!/usr/bin/env node
/**
 * VolleyManager -> public.svrz_games sync, one run (replaces the Supabase Edge
 * Function "vm-sync"; the daily schedule lives in server.js via scheduleVmSync).
 *
 * Usage:
 *   DATABASE_URL=postgres://... VM_USERNAME=... VM_PASSWORD=... node scripts/vm-sync.mjs [options]
 *
 * Window (Europe/Zurich calendar days, inclusive):
 *   (default)                 today -1 .. today +14  (VM_SYNC_DAYS_BACK / VM_SYNC_DAYS_AHEAD)
 *   --date YYYY-MM-DD         one day
 *   --from YYYY-MM-DD --to YYYY-MM-DD
 *   --days-back N --days-ahead N
 *
 * Other options:
 *   --dry-run   log in and fetch + transform, but do not touch the database
 *               (DATABASE_URL not needed)
 *   --json      print the result as JSON on stdout; it includes datetimeSamples
 *               (raw VM startingDateTime values) and offsetlessDatetimes, to see
 *               whether VM sends Z/offsets or Zurich wall-clock times
 *   --help
 *
 * On hetzner:
 *   docker exec ov-backend node scripts/vm-sync.mjs --from 2026-10-01 --to 2026-10-31
 *
 * Exit codes: 0 success, 1 failed, 2 usage/config error,
 *             3 skipped (another run holds the lock), 4 partial (some games not written/fetched).
 * The password, cookies and CSRF token are never printed.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runVmSync, resolveWindow, windowFromEnv, isYmd } from '../lib/vmSync.js'

const USAGE = 'Usage: node scripts/vm-sync.mjs [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD | --days-back N --days-ahead N] [--dry-run] [--json]\n' +
  'Needs VM_USERNAME, VM_PASSWORD and (unless --dry-run) DATABASE_URL.'

export const EXIT = { success: 0, failed: 1, usage: 2, skipped: 3, partial: 4 }

export function parseArgs(argv) {
  const opts = { window: {}, dryRun: false, json: false, help: false }
  const takeValue = (i, flag) => {
    const v = argv[i + 1]
    if (v == null || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    let inline = null
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq) }
    const val = () => inline ?? takeValue(i++, a)
    switch (a) {
      case '--date': opts.window.date = val(); break
      case '--from': opts.window.from = val(); break
      case '--to': opts.window.to = val(); break
      case '--days-back': opts.window.daysBack = val(); break
      case '--days-ahead': opts.window.daysAhead = val(); break
      case '--dry-run': opts.dryRun = true; break
      case '--json': opts.json = true; break
      case '--help': case '-h': opts.help = true; break
      default: throw new Error(`Unknown argument ${argv[i]}`)
    }
  }
  const w = opts.window
  const hasRange = w.from != null || w.to != null
  const hasRel = w.daysBack != null || w.daysAhead != null
  if ([w.date != null, hasRange, hasRel].filter(Boolean).length > 1) {
    throw new Error('Use only one of --date, --from/--to, --days-back/--days-ahead')
  }
  if (hasRange && (w.from == null || w.to == null)) throw new Error('--from and --to go together')
  for (const k of ['date', 'from', 'to']) {
    if (w[k] != null && !isYmd(w[k])) throw new Error(`--${k} must be a YYYY-MM-DD date`)
  }
  for (const k of ['daysBack', 'daysAhead']) {
    if (w[k] == null) continue
    if (!/^\d+$/.test(w[k])) throw new Error(`--${k === 'daysBack' ? 'days-back' : 'days-ahead'} must be a non-negative integer`)
    w[k] = Number(w[k])
  }
  return opts
}

/**
 * @param {string[]} argv
 * @param {object} env
 * @param {object} [deps]  test seams: fetch, createPool(url) -> pool, baseUrl, http
 */
export async function main(argv = process.argv.slice(2), env = process.env, { fetch: fetchImpl = globalThis.fetch, createPool, baseUrl, http } = {}) {
  let opts
  let window
  try {
    opts = parseArgs(argv)
    if (opts.help) {
      console.log(USAGE)
      return EXIT.success
    }
    window = Object.keys(opts.window).length ? opts.window : windowFromEnv(env)
    resolveWindow(window) // validate before connecting anywhere
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    return EXIT.usage
  }

  const missing = ['VM_USERNAME', 'VM_PASSWORD', ...(opts.dryRun ? [] : ['DATABASE_URL'])].filter((k) => !env[k])
  if (missing.length) {
    console.error(`Missing environment: ${missing.join(', ')}`)
    return EXIT.usage
  }

  let pool = null
  if (!opts.dryRun) {
    if (createPool) {
      pool = await createPool(env.DATABASE_URL)
    } else {
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, application_name: 'vm-sync' })
    }
    pool.on?.('error', (err) => console.error('vm-sync: pg pool error:', err.message))
  }

  const logger = opts.json
    ? { log: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) }
    : console
  let result
  try {
    result = await runVmSync({
      pool,
      fetch: fetchImpl,
      window,
      logger,
      dryRun: opts.dryRun,
      ...(baseUrl ? { baseUrl } : {}),
      ...(http ? { http } : {}),
      credentials: { username: env.VM_USERNAME, password: env.VM_PASSWORD }
    })
  } finally {
    if (pool && !createPool) await pool.end().catch(() => {})
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2))
  return EXIT[result.status] ?? EXIT.failed
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}
if (isMainModule()) {
  main().then((code) => { process.exitCode = code }, (err) => {
    console.error('vm-sync:', err?.message || err)
    process.exitCode = EXIT.failed
  })
}
