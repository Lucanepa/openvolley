/**
 * retention — the end of the match records (privacy policy section 16, db/042).
 *
 * A match is kept for its season and the `retention_years` seasons after it
 * (public.app_settings, db/042; default DEFAULT_RETENTION_YEARS), then the
 * daily sweep removes it with everything that belongs to it:
 *
 *   matches                 the row, as an admin delete (ov.allow_closed): its
 *                           sets, events, live state, approvals, event
 *                           history, closures, final-mail records, editors and
 *                           scoring device go by ON DELETE CASCADE, its
 *                           activity log by the db/016 trigger; db/043 keeps
 *                           its external_id (deleted_matches) so an app that
 *                           still holds the match does not send it back
 *   scoresheet files        the day folders ({day}/, beach/{day}/) of the
 *                           'scoresheets' bucket from before the cutoff day,
 *                           PDFs and the JSON files beside them, with their
 *                           public.match_scoresheets rows
 *   svrz_games              VolleyManager's assignments (referees' names and
 *                           dates of birth) of games before the cutoff day,
 *                           and svrz_games_removed of the same days
 *
 * The season of a match is matches.official_season (db/034), else the season
 * of coalesce(scheduled_at, created_at) (the same rule, lib/officialGame.js).
 * Season S runs from 1 July S to 30 June S+1; with N retention years its
 * records are removed from 1 July S+N+1 (cutoffDay: the first day kept).
 *
 *   createRetention({ pool, storage, audit, log })
 *     .settings()               { years } from app_settings, or { years: null }
 *                               when db/042 has not run (the sweep then does
 *                               nothing)
 *     .sweep({ now, dryRun })   one run: { years, cutoffDay, expiredSeason,
 *                               matches, scoresheetFolders, scoresheetFiles,
 *                               scoresheetRecords, svrzGames, svrzRemoved }
 *                               (with dryRun: what it would remove); a run that
 *                               removed anything is in the audit log
 *                               (retention.sweep, the counts only)
 *
 * Runs as the backend role (ov_app): the closed-match guards (db/007, db/039)
 * yield to ov.allow_closed inside its own transactions, as for the admin
 * reopen. Matches go in batches (BATCH per transaction, MAX_MATCHES_PER_RUN
 * per run, the rest the next day) so no transaction holds many rows or runs
 * into the 10 s statement timeout. The audit log is not swept (insert-only
 * for ov_app, roles.sql); scripts/redact-person.mjs is the request path for
 * one person.
 */

import { SEASON_SQL, seasonOf } from './officialGame.js'
import { SCORESHEET_DAY_RE } from './scoresheets.js'

export const DEFAULT_RETENTION_YEARS = 2
export const MIN_RETENTION_YEARS = 1
export const MAX_RETENTION_YEARS = 30
export const BATCH = 100
export const MAX_MATCHES_PER_RUN = 2000
const BUCKET = 'scoresheets'

/** The newest season that is past retention at `now` with `years` retention years (null: no valid input). */
export function expiredSeason (now, years) {
  const s = seasonOf(now)
  if (s == null || !Number.isInteger(years) || years < MIN_RETENTION_YEARS) return null
  return s - years - 1
}

/** The first day kept ('YYYY-07-01', a calendar day): the day after the expired seasons. */
export function cutoffDay (now, years) {
  const s = expiredSeason(now, years)
  return s == null ? null : `${s + 1}-07-01`
}

/** The season of a match row in SQL (alias `m`). */
export const MATCH_SEASON_SQL = `coalesce(m.official_season, ${SEASON_SQL('coalesce(m.scheduled_at, m.created_at)')})`

export function createRetention ({ pool, storage = null, audit = null, log = console } = {}) {
  if (!pool) throw new Error('createRetention: pool is required')

  async function settings () {
    try {
      const { rows: [r] } = await pool.query('SELECT retention_years FROM public.app_settings WHERE id')
      const years = Number(r?.retention_years ?? DEFAULT_RETENTION_YEARS)
      return { years: Number.isInteger(years) && years >= MIN_RETENTION_YEARS && years <= MAX_RETENTION_YEARS ? years : DEFAULT_RETENTION_YEARS }
    } catch (err) {
      // 42703 / 42P01: db/042 (or 021) not applied yet: no sweep rather than a guess
      if (err?.code === '42703' || err?.code === '42P01') return { years: null }
      throw err
    }
  }

  async function withTx (fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Expired matches, BATCH per transaction, as an admin delete. */
  async function sweepMatches (season, dryRun) {
    if (dryRun) {
      const { rows: [r] } = await pool.query(
        `SELECT count(*)::int AS n FROM public.matches m WHERE ${MATCH_SEASON_SQL} <= $1`, [season])
      return Math.min(r.n, MAX_MATCHES_PER_RUN)
    }
    let removed = 0
    while (removed < MAX_MATCHES_PER_RUN) {
      const n = await withTx(async (client) => {
        await client.query("SELECT set_config('ov.allow_closed', 'on', true)")
        const { rowCount } = await client.query(
          `DELETE FROM public.matches WHERE id IN (
             SELECT m.id FROM public.matches m WHERE ${MATCH_SEASON_SQL} <= $1
              ORDER BY m.id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
          [season, Math.min(BATCH, MAX_MATCHES_PER_RUN - removed)])
        return rowCount
      })
      removed += n
      if (n === 0) break
    }
    return removed
  }

  /** The day folders of the scoresheets bucket from before `day` (indoor and beach). */
  async function expiredFolders (day) {
    if (!storage?.listFoldersTrusted) return []
    const out = []
    for (const prefix of ['', 'beach']) {
      const names = await storage.listFoldersTrusted({ bucket: BUCKET, path: prefix })
      for (const name of names) {
        if (SCORESHEET_DAY_RE.test(name) && name < day) out.push(prefix ? `${prefix}/${name}` : name)
      }
    }
    return out.sort()
  }

  async function sweepScoresheets (day, dryRun) {
    const result = { scoresheetFolders: 0, scoresheetFiles: 0, scoresheetRecords: 0 }
    let folders = []
    try {
      folders = await expiredFolders(day)
    } catch (err) {
      // no storage root (no sentinel), or unreadable: the database part still runs
      log.warn?.(`[Retention] scoresheet folders not read: ${err?.code || err?.message}`)
    }
    for (const folder of folders) {
      result.scoresheetFolders++
      if (dryRun) {
        result.scoresheetFiles += (await storage.listFilesTrusted({ bucket: BUCKET, path: folder })).length
        continue
      }
      const r = await storage.removeTrusted({ bucket: BUCKET, path: folder })
      result.scoresheetFiles += r.objectsRemoved
    }
    // The records of the removed files, and of any PDF of those days whose
    // file was gone already (a removed match keeps none: match_id NULL)
    const like = (f) => f.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
    const patterns = folders.map(like)
    if (patterns.length) {
      const sql = dryRun
        ? 'SELECT count(*)::int AS n FROM public.match_scoresheets WHERE path LIKE ANY($1::text[])'
        : 'DELETE FROM public.match_scoresheets WHERE path LIKE ANY($1::text[])'
      const r = await pool.query(sql, [patterns])
      result.scoresheetRecords = dryRun ? r.rows[0].n : r.rowCount
    }
    return result
  }

  /** VolleyManager's rows of games before `day` (datetime is its ISO text; without one, the row's own time). */
  async function sweepSvrz (day, dryRun) {
    const where = `coalesce(nullif(datetime, ''), created_at::text) < $1`
    const run = async (table) => {
      try {
        if (dryRun) return (await pool.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, [day])).rows[0].n
        return (await pool.query(`DELETE FROM public.${table} WHERE ${where}`, [day])).rowCount
      } catch (err) {
        if (err?.code === '42P01' || err?.code === '42703') return 0
        throw err
      }
    }
    return { svrzGames: await run('svrz_games'), svrzRemoved: await run('svrz_games_removed') }
  }

  async function sweep ({ now = new Date(), dryRun = false } = {}) {
    const { years } = await settings()
    if (years == null) return { years: null, skipped: 'db/042 not applied' }
    const season = expiredSeason(now, years)
    const day = cutoffDay(now, years)
    const matches = await sweepMatches(season, dryRun)
    const files = await sweepScoresheets(day, dryRun)
    const svrz = await sweepSvrz(day, dryRun)
    const result = { years, cutoffDay: day, expiredSeason: season, dryRun, matches, ...files, ...svrz }
    const removed = matches + files.scoresheetFiles + files.scoresheetRecords + svrz.svrzGames + svrz.svrzRemoved
    if (!dryRun && removed > 0 && audit) {
      try {
        await audit(pool, { action: 'retention.sweep', details: result })
      } catch (err) {
        log.warn?.(`[Retention] audit failed: ${err?.code || err?.message}`)
      }
    }
    return result
  }

  return { settings, sweep }
}
