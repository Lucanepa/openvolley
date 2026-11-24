#!/usr/bin/env node
/**
 * Operator CLI, read-only: what the Global cloud copies (public.global_matches,
 * db/046, lib/globalMatches.js) really cost, to size the write budget everyone
 * shares (OV_GLOBAL_CLOUD_WRITE_MB_DAY, default 1024) before a deploy (2611
 * review, GLOBAL-CLOUD-WRITE-BUDGET-SIZING). The server charges every save
 * the whole row as Postgres stores it (pg_column_size of the bundle and the
 * summary, the PDF when the save carries one) plus WAL_ROW_BYTES; one network
 * (an IPv6 /48, an IPv4 /24) may use a quarter of a day. This script reads
 * the table and Postgres's own counters, never a key, a PIN or an address:
 *
 *   copies          rows, those with a PDF, those with an organizer code
 *   row             the average and the 95th percentile of a row's stored
 *                   size (bundle + summary, compressed), the average PDF
 *   saves           inserts and updates of the table since Postgres last
 *                   reset its statistics (pg_stat_user_tables), and per copy
 *   perMatch        the estimated charge of one match: saves x (row + 2 KiB)
 *                   + its PDF
 *   days            copies created per day in the last --days days (default
 *                   30): the busiest day and the average
 *   budget          the matches a day the given budget (--write-mb-day,
 *                   default OV_GLOBAL_CLOUD_WRITE_MB_DAY or 1024) serves in
 *                   all and per network, and the budget the busiest day
 *                   needs twice over (`suggestedWriteMbDay`)
 *
 * An estimate: the counters include the share and delete calls and the PIN
 * counts, and a copy saved on two devices counts twice. Read it beside the
 * server's "[Global cloud] refusing a save" lines.
 *
 * Usage (DATABASE_URL: ov_app, as in the backend container, or the owner;
 * ov_readonly's views leave out the bundle and the PDF it measures):
 *   node scripts/global-cloud-usage.mjs [--days <n>] [--write-mb-day <n>]
 * On the VPS:
 *   sudo docker compose --project-directory /opt/openvolley exec ov-backend node scripts/global-cloud-usage.mjs
 * Prints one JSON object. Exit codes: 0 done, 1 error, 2 usage.
 */
import pg from 'pg'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: node scripts/global-cloud-usage.mjs [--days <n>] [--write-mb-day <n>]'
const MiB = 1024 * 1024
// lib/globalMatches.js WAL_ROW_BYTES and QUOTA_DEFAULTS.writtenNetShare (kept in step by the test)
export const WAL_ROW_BYTES = 2048
export const NET_SHARE = 0.25

export function parseArgs(argv, env = process.env) {
  const out = { days: 30, writeMbDay: Number(env.OV_GLOBAL_CLOUD_WRITE_MB_DAY) > 0 ? Number(env.OV_GLOBAL_CLOUD_WRITE_MB_DAY) : 1024, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new TypeError(`${a} needs a value`)
      return Number(argv[++i])
    }
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--days') out.days = next()
    else if (a === '--write-mb-day') out.writeMbDay = next()
    else throw new TypeError(`unknown argument ${a}`)
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 400) throw new TypeError('--days must be a whole number from 1 to 400')
  if (!(out.writeMbDay > 0)) throw new TypeError('--write-mb-day must be a positive number')
  return out
}

const num = (v) => (v == null ? 0 : Number(v) || 0)

/** The usage report (one read-only transaction). */
export async function usage(pool, { days = 30, writeMbDay = 1024 } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const { rows: [t] } = await client.query(`
      SELECT count(*)::bigint AS copies,
             count(*) FILTER (WHERE pdf IS NOT NULL)::bigint AS with_pdf,
             count(*) FILTER (WHERE organizer_hash IS NOT NULL)::bigint AS with_organizer,
             coalesce(avg(pg_column_size(bundle) + pg_column_size(summary)), 0)::float8 AS row_avg,
             coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY pg_column_size(bundle) + pg_column_size(summary)), 0)::float8 AS row_p95,
             coalesce(avg(pg_column_size(pdf)) FILTER (WHERE pdf IS NOT NULL), 0)::float8 AS pdf_avg
        FROM public.global_matches`)
    const { rows: [s] } = await client.query(`
      SELECT n_tup_ins::bigint AS inserts, n_tup_upd::bigint AS updates,
             (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS since
        FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = 'global_matches'`)
    const { rows: perDay } = await client.query(`
      SELECT date_trunc('day', created_at) AS day, count(*)::bigint AS n
        FROM public.global_matches
       WHERE created_at > now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY 1`, [days])
    await client.query('COMMIT')
    const inserts = num(s?.inserts)
    const updates = num(s?.updates)
    const savesPerCopy = inserts > 0 ? (inserts + updates) / inserts : null
    const rowAvg = num(t.row_avg)
    const pdfAvg = num(t.pdf_avg)
    const perMatch = savesPerCopy != null ? Math.round(savesPerCopy * (rowAvg + WAL_ROW_BYTES) + pdfAvg) : null
    const counts = perDay.map((r) => num(r.n))
    const busiest = counts.length ? Math.max(...counts) : 0
    const budgetBytes = writeMbDay * MiB
    return {
      copies: { total: num(t.copies), withPdf: num(t.with_pdf), withOrganizer: num(t.with_organizer) },
      row: { avgBytes: Math.round(rowAvg), p95Bytes: Math.round(num(t.row_p95)), pdfAvgBytes: Math.round(pdfAvg) },
      saves: { inserts, updates, perCopy: savesPerCopy != null ? Math.round(savesPerCopy * 10) / 10 : null, since: s?.since ? new Date(s.since).toISOString() : null },
      perMatch: { bytes: perMatch, mb: perMatch != null ? Math.round(perMatch / MiB * 100) / 100 : null },
      days: { window: days, busiest, average: counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / days * 10) / 10 : 0 },
      budget: {
        writeMbDay,
        matchesPerDay: perMatch ? Math.floor(budgetBytes / perMatch) : null,
        matchesPerDayPerNetwork: perMatch ? Math.floor(budgetBytes * NET_SHARE / perMatch) : null,
        suggestedWriteMbDay: perMatch && busiest ? Math.max(writeMbDay, Math.ceil(busiest * perMatch * 2 / MiB)) : writeMbDay
      }
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
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
    console.log(JSON.stringify(await usage(pool, a)))
    return 0
  } catch (e) {
    console.error('global-cloud-usage failed:', e?.message || e)
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code })
