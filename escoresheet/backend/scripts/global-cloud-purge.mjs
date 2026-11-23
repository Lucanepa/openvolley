#!/usr/bin/env node
/**
 * Operator CLI: remove the Global cloud copies (public.global_matches, db/046,
 * lib/globalMatches.js) that were CREATED in a time window, e.g. the junk a
 * flood of anonymous saves left while the table filled (audit 2026-11-23
 * GCS-R4). The running server evicts such copies itself only while it
 * remembers which network created them (memory only, no addresses stored); a
 * table that a flood filled before a restart stays full (507 OV_GLOBAL_FULL
 * for every new copy) until they expire 180 days after their last save, or
 * until this script removes them.
 *
 * Usage (DATABASE_URL: the owner or ov_app):
 *   node scripts/global-cloud-purge.mjs --from <time> --to <time> [filters] [--delete]
 *     --from, --to     created_at window, [from, to), ISO 8601 (2026-11-23T14:00Z)
 *     --max-kb <n>     only copies of at most n KB (stored_bytes; a flood's are small)
 *     --no-pdf         only copies without a PDF (a finished match has one)
 *     --no-organizer   only copies without an organizer code
 *     --saved-within <minutes>  only copies whose last save came at most that
 *                      long after their first (a real match saves for an hour)
 *     --delete         remove them; without it the script only counts
 *
 * Prints one JSON line: { matched, bytes, deleted, oldest, newest }. The
 * alert the server sends when the table passes half full or is full says
 * when it happened; look at the window first (without --delete). On the VPS:
 *   sudo docker compose --project-directory /opt/openvolley exec ov-backend node scripts/global-cloud-purge.mjs --from ... --to ...
 *
 * The running server recounts the table within a minute (usageTtlMs). Exit
 * codes: 0 done, 1 error, 2 usage.
 */
import pg from 'pg'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: node scripts/global-cloud-purge.mjs --from <ISO time> --to <ISO time> [--max-kb <n>] [--no-pdf] [--no-organizer] [--saved-within <minutes>] [--delete]'
const STORED_SQL = 'coalesce(stored_bytes, pg_column_size(bundle) + pg_column_size(summary) + coalesce(octet_length(pdf), 0))'

export function parseArgs(argv) {
  const out = { from: null, to: null, maxKb: null, noPdf: false, noOrganizer: false, savedWithinMin: null, del: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new TypeError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--from') out.from = next()
    else if (a === '--to') out.to = next()
    else if (a === '--max-kb') out.maxKb = Number(next())
    else if (a === '--saved-within') out.savedWithinMin = Number(next())
    else if (a === '--no-pdf') out.noPdf = true
    else if (a === '--no-organizer') out.noOrganizer = true
    else if (a === '--delete') out.del = true
    else throw new TypeError(`unknown argument ${a}`)
  }
  if (out.help) return out
  const from = Date.parse(out.from ?? '')
  const to = Date.parse(out.to ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new TypeError('--from and --to must be ISO times')
  if (!(to > from)) throw new TypeError('--to must be after --from')
  if (out.maxKb !== null && !(out.maxKb > 0)) throw new TypeError('--max-kb must be a positive number')
  if (out.savedWithinMin !== null && !(out.savedWithinMin >= 0)) throw new TypeError('--saved-within must be minutes (0 or more)')
  out.from = new Date(from).toISOString()
  out.to = new Date(to).toISOString()
  return out
}

/** The WHERE clause and parameters of the copies the arguments name. */
export function selection(a) {
  const where = ['created_at >= $1', 'created_at < $2']
  const params = [a.from, a.to]
  if (a.maxKb !== null) { params.push(Math.round(a.maxKb * 1024)); where.push(`${STORED_SQL} <= $${params.length}`) }
  if (a.noPdf) where.push('pdf IS NULL')
  if (a.noOrganizer) where.push('organizer_hash IS NULL')
  if (a.savedWithinMin !== null) { params.push(a.savedWithinMin * 60); where.push(`updated_at <= created_at + make_interval(secs => $${params.length})`) }
  return { where: where.join(' AND '), params }
}

export async function purge(pool, a) {
  const { where, params } = selection(a)
  const { rows: [c] } = await pool.query(
    `SELECT count(*)::bigint AS n, coalesce(sum(${STORED_SQL}), 0)::bigint AS bytes, min(created_at) AS oldest, max(created_at) AS newest FROM public.global_matches WHERE ${where}`, params)
  let deleted = 0
  if (a.del && Number(c.n) > 0) {
    const r = await pool.query(`DELETE FROM public.global_matches WHERE ${where}`, params)
    deleted = r.rowCount || 0
  }
  return { matched: Number(c.n), bytes: Number(c.bytes), deleted, oldest: c.oldest ? new Date(c.oldest).toISOString() : null, newest: c.newest ? new Date(c.newest).toISOString() : null }
}

async function main() {
  let a
  try {
    a = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`)
    return 2
  }
  if (a.help) { console.log(USAGE); return 0 }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); return 2 }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    console.log(JSON.stringify(await purge(pool, a)))
    return 0
  } catch (e) {
    console.error('global-cloud-purge failed:', e?.message || e)
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code })
