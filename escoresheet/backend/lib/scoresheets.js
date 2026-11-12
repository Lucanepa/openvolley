/**
 * scoresheets — the stored scoresheet PDFs behind the manager's Scoresheets
 * tab: admins and competition managers, each in its own sport. lib/manageApi.js
 * checks the role (the sport of ?app= for the list, the sport of the MATCH for
 * a file); this module answers.
 *
 *   list({ app, state, q, limit })           that sport's non-test matches, each
 *                                            with `pdf`: a stored PDF was found
 *                                            (true / false; null = storage unreadable)
 *   readPdf({ actorId, matchId, download })  the newest stored PDF of a match,
 *                                            as { status, file }; audited first
 *                                            (scoresheet.read): no entry, no file
 *   sportOf(matchId)                         { sport } | { sport: null } | { error }
 *   createViewLink({ actorId, matchId })     reads the PDF as readPdf (same check before,
 *                                            same audit entry) and keeps it for
 *                                            VIEW_LINK_TTL_MS under a random token:
 *                                            { path: /api/scoresheet-view/<token>/<file name>,
 *                                            expires_at }
 *   latestPdf(m)                             the newest stored PDF of match row m, for
 *                                            trusted server code (the final scoresheet
 *                                            mail, lib/finalMail.js): { data, filename,
 *                                            mtimeMs }, null (none), or { unknown: true }
 *   readViewLink({ token, name })            that PDF, inline, by its link: { status, file }
 *                                            or 404. The browser's own PDF viewer opens
 *                                            the link in a tab (no Authorization header
 *                                            there), shows the file name and saves under
 *                                            it (owner 2026-10-13: a blob: URL saved as
 *                                            "<uuid>.pdf"). The token is the capability:
 *                                            32 random bytes, kept in this process only,
 *                                            gone after the TTL or a restart.
 *   storePdf({ userId, matchOwner, body })   POST /api/storage/upload of a PDF in the
 *                                            'scoresheets' bucket (server.js): stored
 *                                            only for a match the caller may write,
 *                                            and recorded for it (db/033)
 *   removeFiles({ userId, admin, body })     POST /api/storage/remove in that bucket:
 *                                            a closed match's PDF stays
 *
 * Where the scorer apps put the files ('scoresheets' bucket; OpenVolley:
 * frontend/src/utils/scoresheetUploader.js, OpenBeach:
 * utils_beach/scoresheetUploader_beach.js):
 *   indoor  {day}/game{g}_k{32 hex}.pdf      g = game_n, else external_id (path-safe)
 *   beach   beach/{day}/game{n}_{seed}.pdf   seed = the match's external_id (path-safe)
 *   older files have no random part:  {day}/game{g}.pdf, beach/{day}/game{n}.pdf
 * {day} is the UTC day of scheduled_at (without one, the app's day of the upload).
 *
 * Whose PDF it is (db/033 public.match_scoresheets): game numbers, external
 * ids and days are public, so any scorer could store a file under a match's
 * name. A PDF is stored only for a match its uploader may write (pgQuery
 * assertMatchWritable: the creator, an editor, an admin): the match the app
 * names (match_external_id, newer apps), else the one its path names (older
 * apps, OpenBeach; a beach name is the one match's whose external id is its
 * seed). After the close only the closing account (or an admin) stores it,
 * and once per approval: the approval's PDF (the app queues it with the
 * approval, which closes the match, so it comes before or after the close),
 * unless one was stored since the last reopen. The same bytes again (a
 * resent job) are accepted, and that same file may be replaced for
 * CLOSED_REPLACE_GRACE_MS (a corrected approval's PDF sent right after an
 * older one still queued); any other file is not (409 OV_MATCH_CLOSED) until
 * an admin reopens the match, and a closed match's PDF is not removed. The
 * tab and the final mail use only the files recorded for the match, the
 * newest first. A match without any (stored before db/033) is found by the
 * names as before (no scheduled day: the days it was closed, updated and
 * created; more than one file: the newest), but only files whose storage
 * owner created, edits or closed the match.
 *
 * This is the only code that reads scoresheets past the uploader-only rule
 * (README "Who can read a scoresheet"); every read is in the audit log.
 */

import { createHash, randomBytes } from 'node:crypto'
import { appParam, fail, invalid, isUuid, notFound, ok, sheetScorerSql, unavailable } from './accounts.js'
import { StorageError, decodeBase64, objectId, parseStoragePath } from './storage.js'

export const SCORESHEETS_BUCKET = 'scoresheets'
const STATES = ['closed', 'open', 'all']
const NO_PDF = () => fail(404, 'OV_SCORESHEET_NOT_FOUND', 'No scoresheet PDF is stored for this match')
/** How long a view link opens its PDF (the manager's tab keeps it for as long). */
export const VIEW_LINK_TTL_MS = 10 * 60 * 1000
/** At most this many PDFs kept for view links (the oldest goes first). */
export const VIEW_LINK_MAX = 50
const VIEW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** The game part of an OpenVolley file name (frontend scoresheet_pdf/utils/scoresheetStorage.ts cleanGame). */
export function cleanGame (v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64)
  return /[A-Za-z0-9]/.test(s) ? s : null
}

// ä -> ae etc. before the accents go (frontend sheetFormat.ts sanitizeFilenamePart)
const TRANSLITERATION = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }

/** A part of a download's file name: ASCII letters, digits and `-` only. */
export function filePart (value, max = 30) {
  const s = value === null || value === undefined ? '' : String(value)
  return s.replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATION[c]).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '')
}

const zurichDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * The download's file name, as the app names a scoresheet it saves
 * (frontend scoresheet_pdf/utils/sheetFormat.ts buildScoresheetFilename):
 * `game<n>_<league>_<YYYY-MM-DD>.pdf`, the league left out when there is none,
 * `<Home>_vs_<Away>` instead of `game<n>` without a game number; the day is the
 * match's day in Zurich (else the day the file was stored under).
 */
/** "1L D" -> "1LD": a code (every word at most 3 characters) loses its spaces. */
export function compactLeagueCode (raw) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim()
  const words = s.split(/\s+/).filter(Boolean)
  return words.length > 1 && words.every((w) => w.length <= 3) ? words.join('') : s
}

export function downloadName ({ game_n: gameN, external_id: externalId, sport, league, home_name: home, away_name: away, scheduled_at: scheduledAt }, folderDay) {
  const game = filePart(gameN ?? (sport === 'beach' ? null : externalId), 20)
  const who = game ? `game${game}` : `${filePart(home) || 'Home'}_vs_${filePart(away) || 'Away'}`
  const when = scheduledAt ? new Date(scheduledAt) : null
  const day = when && !Number.isNaN(when.getTime()) ? zurichDayFmt.format(when) : folderDay
  // an indoor league code loses its spaces, as in the app (sheetFormat.ts
  // compactLeagueCode): "1L D" -> 1LD; a name keeps its words apart (owner 2026-10-13)
  const lg = sport === 'beach' ? league : compactLeagueCode(league)
  return `${[who, filePart(lg), day].filter(Boolean).join('_').slice(0, 116)}.pdf`
}

/** The seed part of an OpenBeach file name (scoresheetUploader_beach.js scoresheetStoragePath). */
const cleanSeed = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '-')

const BEACH_PDF_RE = /^game([^_]*)(?:_(.+))?\.pdf$/

/**
 * The parts of an OpenBeach PDF name game{n}[_{seed}].pdf: { game, seed }
 * (seed null without one), else null. OpenBeach writes the game number (or
 * 'unknown') as n, never a '_', so the seed is all after the first '_': one
 * name, one seed (a seed is itself made of '_'-joined parts, and the tail of
 * one would otherwise fit too).
 */
export function beachPdfName (name) {
  const r = typeof name === 'string' ? BEACH_PDF_RE.exec(name) : null
  return r ? { game: r[1], seed: r[2] ?? null } : null
}

function utcDay (v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Where a match's PDF can be: the folders to look in and rank(name), which is
 * 2 for a file of this match, 1 for an older file without the random part
 * (it may be another match's of the same number), 0 for any other file.
 * @param {{ sport: string, game_n?: number|null, external_id?: string|null,
 *   scheduled_at?: unknown, closed_at?: unknown, updated_at?: unknown, created_at?: unknown }} m
 */
export function pdfLocator (m) {
  const beach = m.sport === 'beach'
  const days = m.scheduled_at
    ? [utcDay(m.scheduled_at)]
    : [utcDay(m.closed_at), utcDay(m.updated_at), utcDay(m.created_at)]
  const folders = [...new Set(days.filter(Boolean))].map((d) => (beach ? `beach/${d}` : d))
  if (beach) {
    const seed = m.external_id ? cleanSeed(m.external_id) : null
    const legacy = m.game_n != null ? String(m.game_n) : null
    const rank = (name) => {
      const b = beachPdfName(name)
      if (!b) return 0
      if (b.seed !== null) return seed !== null && b.seed === seed ? 2 : 0
      return b.game === legacy ? 1 : 0
    }
    return { folders, rank }
  }
  const games = [...new Set([cleanGame(m.game_n), cleanGame(m.external_id)].filter(Boolean))]
  const keyed = games.map((g) => new RegExp(`^game${g}_k[0-9a-f]{32}\\.pdf$`))
  const legacy = games.map((g) => `game${g}.pdf`)
  return { folders, rank: (name) => (keyed.some((re) => re.test(name)) ? 2 : legacy.includes(name) ? 1 : 0) }
}

/** The best file of `entries` ([{ folder, name, mtimeMs }]) for rank(): highest rank, then newest. */
export function bestPdf (entries, rank) {
  let best = null
  let bestRank = 0
  for (const e of entries) {
    const r = rank(e.name)
    if (!r) continue
    if (!best || r > bestRank || (r === bestRank && e.mtimeMs > best.mtimeMs)) {
      best = e
      bestRank = r
    }
  }
  return best
}

/** A path of the 'scoresheets' bucket that names a PDF: stored for a match only (storePdf). */
export const isScoresheetPdf = (p) => typeof p === 'string' && /\.pdf$/i.test(p)

const INDOOR_PDF_RE = /^game([A-Za-z0-9-]+?)(?:_k[0-9a-f]{32})?\.pdf$/

/**
 * The parts of a match's PDF path, as the apps write it ({day}/game{g}[_k{hex}].pdf,
 * beach/{day}/game{n}[_{seed}].pdf): { key (the path as lib/storage.js keeps it),
 * folder, day (its last segment), name, sport, game (the game part), seed
 * (beach: the seed, or null) }; null for any other path.
 */
export function pdfPathParts (p) {
  const segs = typeof p === 'string' ? parseStoragePath(p) : null
  if (!segs) return null
  const beach = segs.length === 3 && segs[0] === 'beach'
  const name = segs[segs.length - 1]
  if (!beach && (segs.length !== 2 || segs[0] === 'beach')) return null
  const indoor = beach ? null : INDOOR_PDF_RE.exec(name)
  const b = beach ? beachPdfName(name) : null
  if (!indoor && !b) return null
  return {
    key: segs.join('/'),
    folder: segs.slice(0, -1).join('/'),
    day: segs[segs.length - 2],
    name,
    sport: beach ? 'beach' : 'indoor',
    game: indoor ? indoor[1] : b.game,
    seed: b ? b.seed : null
  }
}

const MATCH_CLOSED = () => fail(409, 'OV_MATCH_CLOSED', 'This match is closed: its scoresheet stays as it was stored')
// An upload that names no match (older apps, OpenBeach) whose path fits no
// match: the match's insert may still be on its way (it goes in the score's
// lane). 503, retryable: those apps park a refusal (4xx) for an hour, and
// the final mail would go out without the PDF in the meantime.
const MATCH_NOT_IN_CLOUD = () => ({ status: 503, body: { data: null, error: { message: 'No match of this scoresheet is in the cloud yet', code: 'OV_MATCH_NOT_FOUND', retryable: true } } })
/**
 * After the close, the closing account may still replace the approval's PDF
 * (the file stored since the match's last reopen) at the same path for this
 * long after the close, or after that file's first store when it came later
 * (a replacement never moves it): an app sends every queued approval file in
 * turn, and after a reopen and a new approval an older app or OpenBeach may
 * send the first approval's PDF just before the corrected one.
 */
export const CLOSED_REPLACE_GRACE_MS = 10 * 60 * 1000

/** An answer for the caller, thrown out of a transaction (which then rolls back). */
class Refused extends Error {
  constructor (result) {
    super('refused')
    this.result = result
  }
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {ReturnType<import('./pgQuery.js').createPgQuery>} [o.db]  withTransaction, assertMatchWritable (storePdf)
 * @param {ReturnType<import('./storage.js').createStorage>} o.storage
 * @param {ReturnType<import('./accounts.js').createAccounts>} o.accounts  its audit()
 */
export function createScoresheets ({ pool, db = null, storage, accounts, logger = console, now = () => Date.now() } = {}) {
  const log = logger
  /** token -> { file, expires } (insertion order = age) */
  const viewLinks = new Map()
  const pruneViewLinks = () => {
    const t = now()
    for (const [k, v] of viewLinks) if (v.expires <= t) viewLinks.delete(k)
    while (viewLinks.size >= VIEW_LINK_MAX) viewLinks.delete(viewLinks.keys().next().value)
  }
  const sportOut = (isBeach) => (isBeach === true ? 'beach' : 'indoor')

  /** The PDF files of the folders, one listing per folder; null when the storage cannot be read. */
  function folderReader () {
    const seen = new Map()
    return (folder) => {
      if (!seen.has(folder)) {
        seen.set(folder, storage.listFilesTrusted({ bucket: SCORESHEETS_BUCKET, path: folder })
          .then((files) => files.filter((f) => f.name.endsWith('.pdf')).map((f) => ({ ...f, folder })))
          .catch((err) => {
            // a folder name the storage refuses (never one built here) or an I/O error
            log.warn?.(`[scoresheets] list failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
            return null
          }))
      }
      return seen.get(folder)
    }
  }

  /**
   * The PDFs of match row `m`, best first: { files: [{ folder, name, mtimeMs }] },
   * with unknown: true when there is none and the storage could not be read.
   * `recorded`: the files stored for it (db/033), newest first; a match with
   * none (files stored before db/033) by the names, but only a file whose
   * storage owner is one of its `writers` (Set of user ids).
   */
  async function locate (m, read, recorded, writers) {
    if (recorded?.length) return { files: recorded }
    const { folders, rank } = pdfLocator(m)
    const lists = await Promise.all(folders.map(read))
    let unknown = lists.some((l) => l === null)
    const named = lists.filter(Boolean).flat().filter((e) => rank(e.name))
    const allowed = await Promise.all(named.map(async (e) => {
      try {
        const owners = await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path: `${e.folder}/${e.name}` })
        return owners.some((o) => writers?.has(o))
      } catch (err) {
        log.warn?.(`[scoresheets] owner record unreadable: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
        unknown = true
        return false
      }
    }))
    const file = bestPdf(named.filter((_, i) => allowed[i]), rank)
    return file ? { files: [file] } : { files: [], unknown }
  }

  /**
   * The PDFs stored for the matches `ids` (db/033): Map(id -> [{ folder, name,
   * mtimeMs }], newest first). null on a database without db/033 (every match
   * is then found by the names).
   */
  async function recordedPdfs (ids) {
    try {
      const { rows } = await pool.query(
        `SELECT match_id::text AS match_id, path, stored_at FROM public.match_scoresheets
          WHERE match_id = ANY($1::uuid[]) ORDER BY stored_at DESC, path`, [ids])
      const out = new Map()
      for (const r of rows) {
        const cut = r.path.lastIndexOf('/')
        if (!out.has(r.match_id)) out.set(r.match_id, [])
        out.get(r.match_id).push({ folder: r.path.slice(0, cut), name: r.path.slice(cut + 1), mtimeMs: new Date(r.stored_at).getTime() })
      }
      return out
    } catch (err) {
      if (err?.code !== '42P01') throw err
      log.warn?.('[scoresheets] public.match_scoresheets is missing (run db/033_match_scoresheets.sql): PDFs found by their names only')
      return null
    }
  }

  /** The accounts that created, edit or closed the matches `ids`: Map(id -> Set of user ids). */
  async function writersOf (ids) {
    if (!ids.length) return new Map()
    const { rows } = await pool.query(
      `SELECT m.id::text AS id, m.created_by::text AS created_by, m.closed_by::text AS closed_by,
              ARRAY(SELECT e.user_id::text FROM public.match_editors e WHERE e.match_id = m.id) AS editors
         FROM public.matches m WHERE m.id = ANY($1::uuid[])`, [ids])
    return new Map(rows.map((r) => [r.id, new Set([r.created_by, r.closed_by, ...(r.editors || [])].filter(Boolean))]))
  }

  /** locate() for one match row, its records and writers read first. */
  async function locateOne (m) {
    const recorded = (await recordedPdfs([m.id]))?.get(m.id)
    const writers = recorded?.length ? null : (await writersOf([m.id])).get(m.id)
    return locate(m, folderReader(), recorded, writers)
  }

  const ROW_COLUMNS = `m.id, m.external_id, m.game_n, m.status, m.scheduled_at, m.closed_at, m.updated_at, m.created_at,
                (m.sport_type IS NOT DISTINCT FROM 'beach') AS is_beach`
  // The team names by the match's sport, as lib/approvals.js reads them: an
  // indoor match's home_team / away_team, a beach match's team1_data /
  // team2_data (OpenBeach leaves home_team / away_team empty).
  const nameSql = (side) => `CASE WHEN m.sport_type IS NOT DISTINCT FROM 'beach' THEN m.${side === 'home' ? 'team1_data' : 'team2_data'}->>'name' ` +
    `ELSE m.${side === 'home' ? 'home_team' : 'away_team'}->>'name' END`
  const NAME_COLUMNS = `${nameSql('home')} AS home_name, ${nameSql('away')} AS away_name`

  /** GET /api/scoresheets?app=indoor|beach&state=closed|open|all&q=&limit= */
  async function list ({ app, state = 'all', q = '', limit } = {}) {
    const given = appParam(app)
    if (given === null) return invalid('app: indoor or beach')
    const a = given ?? 'indoor'
    const st = state || 'all'
    if (!STATES.includes(st)) return invalid('state: closed, open or all')
    if (typeof q !== 'string' || q.length > 80) return invalid('q: at most 80 characters')
    const lim = limit == null || limit === '' ? 100 : Number(limit)
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) return invalid('limit: 1 to 500')
    try {
      const values = []
      const p = (v) => { values.push(v); return '$' + values.length }
      const where = ['m.test IS NOT TRUE']
      where.push(a === 'beach' ? "m.sport_type IS NOT DISTINCT FROM 'beach'" : "m.sport_type IS DISTINCT FROM 'beach'")
      if (st === 'closed') where.push('m.closed_at IS NOT NULL')
      if (st === 'open') where.push('m.closed_at IS NULL')
      const term = q.trim()
      if (/^\d{1,9}$/.test(term)) where.push(`m.game_n = ${p(Number(term))}`)
      else if (term) {
        const pat = p('%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%')
        where.push(`((${nameSql('home')}) ILIKE ${pat} OR (${nameSql('away')}) ILIKE ${pat})`)
      }
      const { rows } = await pool.query(
        `SELECT ${ROW_COLUMNS},
                ${NAME_COLUMNS}, m.match_info->>'league' AS league,
                nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS scorer_name,
                ${sheetScorerSql('m')} AS sheet_scorer_name
           FROM public.matches m
           LEFT JOIN public.profiles p ON p.user_id = m.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY coalesce(m.scheduled_at, m.created_at) DESC NULLS LAST, m.id
          LIMIT ${lim}`, values)
      const recorded = await recordedPdfs(rows.map((r) => r.id))
      const writers = await writersOf(rows.filter((r) => !recorded?.get(r.id)?.length).map((r) => r.id))
      const read = folderReader()
      const located = await Promise.all(rows.map((r) => locate({ ...r, sport: sportOut(r.is_beach) }, read, recorded?.get(r.id), writers.get(r.id))))
      const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
      return ok({
        matches: rows.map((r, i) => ({
          id: r.id,
          external_id: r.external_id ?? null,
          game_n: r.game_n ?? null,
          status: r.status ?? null,
          scheduled_at: iso(r.scheduled_at),
          closed_at: iso(r.closed_at),
          home_name: r.home_name ?? null,
          away_name: r.away_name ?? null,
          league: r.league ?? null,
          scorer_name: r.scorer_name ?? null,
          sheet_scorer_name: r.sheet_scorer_name ?? null,
          sport: sportOut(r.is_beach),
          pdf: located[i].files.length ? true : located[i].unknown ? null : false,
          pdf_updated_at: located[i].files.length ? new Date(located[i].files[0].mtimeMs).toISOString() : null
        }))
      })
    } catch (err) {
      log.error?.(`[scoresheets] list failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /** The sport of a match, for the role check of GET /api/scoresheets/:id/pdf. */
  async function sportOf (matchId) {
    if (!isUuid(matchId)) return { sport: null }
    try {
      const { rows: [r] } = await pool.query("SELECT (sport_type IS NOT DISTINCT FROM 'beach') AS is_beach FROM public.matches WHERE id = $1", [matchId])
      return { sport: r ? sportOut(r.is_beach) : null }
    } catch (err) {
      log.error?.(`[scoresheets] sport-of failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return { error: unavailable() }
    }
  }

  /**
   * GET /api/scoresheets/:id/pdf[?download=1]: { status: 200, file: { data,
   * contentType, filename, disposition } }, or an error result (404
   * OV_SCORESHEET_NOT_FOUND when no PDF is stored).
   */
  async function readPdf ({ actorId, matchId, download = false } = {}) {
    if (!isUuid(matchId)) return notFound()
    let m
    let located
    try {
      const { rows: [r] } = await pool.query(
        `SELECT ${ROW_COLUMNS}, m.test, m.match_info->>'league' AS league, ${NAME_COLUMNS}
           FROM public.matches m WHERE m.id = $1`, [matchId])
      if (!r || r.test === true) return notFound()
      m = { ...r, sport: sportOut(r.is_beach) }
      located = await locateOne(m)
    } catch (err) {
      log.error?.(`[scoresheets] read failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
    let file = null
    let data
    for (const f of located.files) {
      try {
        data = await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path: `${f.folder}/${f.name}` })
        file = f
        break
      } catch (err) {
        // a recorded file removed outside the API: the next one
        if (err?.code === 'OV_STORAGE_NOT_FOUND') continue
        log.warn?.(`[scoresheets] read failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
        return unavailable()
      }
    }
    if (!file) return located.unknown ? unavailable() : NO_PDF()
    // The read is on record before the file leaves (the file name keeps its
    // random part out of the log: it stays the uploader's)
    try {
      await accounts.audit(null, {
        actorId,
        action: 'scoresheet.read',
        matchId: m.id,
        details: { game_n: m.game_n ?? null, external_id: m.external_id ?? null, download: !!download, stored_at: new Date(file.mtimeMs).toISOString() }
      })
    } catch (err) {
      log.error?.(`[scoresheets] audit failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
    return {
      status: 200,
      file: {
        data,
        contentType: 'application/pdf',
        filename: downloadName(m, file.folder.split('/').pop()),
        disposition: download ? 'attachment' : 'inline'
      }
    }
  }

  /**
   * The newest stored PDF of match row `m` ({ sport, game_n, external_id,
   * scheduled_at, closed_at, updated_at, created_at, home_name, away_name,
   * league }), read past the uploader-only rule for trusted server code: the
   * final scoresheet mail (lib/finalMail.js), which audits its own sending.
   * { data, filename, mtimeMs }, null when there is none, { unknown: true }
   * when the storage could not be read. Never throws.
   */
  async function latestPdf (m) {
    try {
      const { files, unknown } = await locateOne(m)
      for (const file of files) {
        try {
          const data = await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path: `${file.folder}/${file.name}` })
          return { data, filename: downloadName(m, file.folder.split('/').pop()), mtimeMs: file.mtimeMs }
        } catch (err) {
          if (err?.code !== 'OV_STORAGE_NOT_FOUND') throw err
        }
      }
      return unknown ? { unknown: true } : null
    } catch (err) {
      log.warn?.(`[scoresheets] latest PDF failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      return { unknown: true }
    }
  }

  // ------------------------------------------------------------------ storing
  // The matches a PDF's name can belong to, in SQL: not test matches, the
  // path's sport; an indoor name by its game part (the game number or the
  // path-safe external id, cleanGame), a beach name by its seed (the
  // path-safe external id, cleanSeed) or, without one, by its game number.
  // pdfLocator has the last word on a row that is used.
  const BEACH_SEED_SQL = "regexp_replace(m.external_id, '[^A-Za-z0-9_-]', '-', 'g')"
  function pathSql (parts, p) {
    let fits
    if (parts.sport === 'beach') {
      fits = "m.sport_type IS NOT DISTINCT FROM 'beach' AND " +
        (parts.seed !== null ? `${BEACH_SEED_SQL} = ${p(parts.seed)}` : `m.game_n::text = ${p(parts.game)}`)
    } else {
      const g = p(parts.game)
      fits = `m.sport_type IS DISTINCT FROM 'beach' AND (m.game_n::text = ${g} OR left(regexp_replace(btrim(m.external_id), '[^A-Za-z0-9-]', '-', 'g'), 64) = ${g})`
    }
    return `m.test IS NOT TRUE AND m.external_id IS NOT NULL AND ${fits}`
  }
  // SQL: the path's folder is one of the match's (pdfLocator: the scheduled
  // UTC day, else the days it was closed, updated and created)
  const utcDaySql = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
  function ofDaySql (parts, p) {
    const day = p(parts.day)
    return `coalesce(CASE WHEN m.scheduled_at IS NOT NULL THEN ${utcDaySql('m.scheduled_at')} = ${day} ` +
      `ELSE ${day} IN (${utcDaySql('m.closed_at')}, ${utcDaySql('m.updated_at')}, ${utcDaySql('m.created_at')}) END, false)`
  }
  const sqlParams = () => {
    const values = []
    return { values, p: (v) => { values.push(v); return '$' + values.length } }
  }
  const matchRow = (r) => ({ ...r, sport: sportOut(r.is_beach) })

  /**
   * The one match a beach name with a seed is of: the one whose external id
   * is the seed, else (several clean to it) the oldest. null when there is none.
   */
  async function seededBeachMatch (client, parts) {
    const { values, p } = sqlParams()
    const where = pathSql(parts, p)
    const { rows: [r] } = await client.query(
      `SELECT ${ROW_COLUMNS}, m.closed_by::text AS closed_by FROM public.matches m
        WHERE ${where} ORDER BY (m.external_id = ${p(parts.seed)}) DESC, m.created_at, m.id LIMIT 1`, values)
    return r ? matchRow(r) : null
  }

  /** The match `externalId` the app names, if the caller may write it and the path is its PDF's. */
  async function namedMatch (client, externalId, parts, matchOwner) {
    const w = await db.assertMatchWritable(client, externalId, matchOwner)
    const { rows: [r] } = await client.query(`SELECT ${ROW_COLUMNS}, m.closed_by::text AS closed_by FROM public.matches m WHERE m.id = $1`, [w.id])
    const m = matchRow(r)
    const notIts = () => new Refused(invalid('path: not the scoresheet PDF of this match'))
    if (m.sport !== parts.sport || !pdfLocator(m).rank(parts.name)) throw notIts()
    // a beach name is one match's (its seed); a match made to fit it too is not that one
    if (parts.sport === 'beach' && parts.seed !== null) {
      const owner = await seededBeachMatch(client, parts)
      if (owner && owner.id !== m.id) throw notIts()
    }
    return m
  }

  /**
   * The match the path names (older apps, OpenBeach), for a caller that may
   * write it. A beach name with a seed is one match's (seededBeachMatch). Any
   * other name can be several matches' (game numbers repeat; an external id
   * can be made to clean to a game number): the caller's own ones first
   * (creator or editor), then the path's day, so that matches others add
   * under the name do not push the caller's out of the candidates. A PDF of
   * such a name is stored under its own random path, recorded for the match
   * found here.
   */
  async function pathMatch (client, parts, matchOwner) {
    let candidates
    if (parts.sport === 'beach' && parts.seed !== null) {
      const m = await seededBeachMatch(client, parts)
      candidates = m && pdfLocator(m).rank(parts.name) ? [m] : []
    } else {
      const { values, p } = sqlParams()
      const where = pathSql(parts, p)
      const ofDay = ofDaySql(parts, p)
      const u = p(isUuid(matchOwner?.userId) ? matchOwner.userId : null)
      const own = `(coalesce(m.created_by = ${u}::uuid, false) OR EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = ${u}::uuid))`
      const { rows } = await client.query(
        `SELECT ${ROW_COLUMNS}, m.closed_by::text AS closed_by FROM public.matches m
          WHERE ${where} ORDER BY ${own} DESC, ${ofDay} DESC, m.scheduled_at DESC NULLS LAST, m.id LIMIT 20`, values)
      candidates = rows.map(matchRow).filter((m) => pdfLocator(m).rank(parts.name))
    }
    if (!candidates.length) throw new Refused(MATCH_NOT_IN_CLOUD())
    let refusal = null
    for (const m of candidates) {
      try {
        await db.assertMatchWritable(client, m.external_id, matchOwner)
        return m
      } catch (err) {
        if (err?.status !== 403) throw err
        refusal ??= err
      }
    }
    throw refusal
  }

  /**
   * POST /api/storage/upload of a PDF in the 'scoresheets' bucket (server.js,
   * after its check that the caller scores the path's sport): { status, body }
   * as lib/storage.js handle(). The PDF ('%PDF-', else 415) is stored for the
   * match body.match_external_id names, or the match its path names, when
   * the caller may write that match (403 OV_NOT_MATCH_OWNER / OV_SCORER_REQUIRED;
   * OV_MATCH_NOT_FOUND while the match is not in the cloud: 404 for the
   * match the app names, which the app retries, 503 for a path no match
   * fits), and recorded for it. A closed match: see the header (409
   * OV_MATCH_CLOSED). One store per match at a time (an advisory lock; the
   * match row is held FOR SHARE, so it cannot close in between).
   * @param {{ userId: string, matchOwner: { userId: string, admin?: boolean }, body: object }} o
   */
  async function storePdf ({ userId, matchOwner, body } = {}) {
    const parts = pdfPathParts(body?.path)
    if (!parts) return invalid('path: not the scoresheet PDF of a match')
    const named = body.match_external_id ?? null
    if (named !== null && (typeof named !== 'string' || !named || named.length > 200)) return invalid('match_external_id')
    let data
    try {
      data = decodeBase64(body.fileBase64)
    } catch (err) {
      if (err instanceof StorageError) return fail(err.status, err.code, err.message)
      throw err
    }
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(415, 'OV_STORAGE_CONTENT_TYPE', 'Not a PDF file')
    if (!db?.withTransaction || !db?.assertMatchWritable) return unavailable()
    const sha256 = createHash('sha256').update(data).digest('hex')
    try {
      return await db.withTransaction(async (client) => {
        const m = named ? await namedMatch(client, named, parts, matchOwner) : await pathMatch(client, parts, matchOwner)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ov.scoresheet:${m.id}`])
        // The approval's PDFs: the match's files stored since its last reopen
        // (audit_log match.reopen; all of them when it was never reopened),
        // before the close or after it
        const { rows: [s] } = await client.query(
          `SELECT m.closed_at IS NOT NULL AS closed, m.closed_by::text AS closed_by,
                  x.match_id::text AS path_match,
                  coalesce(x.match_id = m.id AND (r.at IS NULL OR x.stored_at > r.at), false) AS path_of_approval,
                  coalesce(x.sha256 = $3, false) AS same_bytes,
                  coalesce(greatest(m.closed_at, x.first_stored_at) > now() - make_interval(secs => $4), false) AS in_grace,
                  EXISTS (SELECT 1 FROM public.match_scoresheets o
                           WHERE o.match_id = m.id AND (r.at IS NULL OR o.stored_at > r.at) AND o.path <> $2) AS other_of_approval
             FROM public.matches m
             LEFT JOIN public.match_scoresheets x ON x.path = $2
             LEFT JOIN LATERAL (SELECT max(a.at) AS at FROM public.audit_log a
                                 WHERE a.action = 'match.reopen' AND a.match_id = m.id) r ON true
            WHERE m.id = $1`, [m.id, parts.key, sha256, CLOSED_REPLACE_GRACE_MS / 1000])
        if (s.path_match && s.path_match !== m.id) throw new Refused(fail(409, 'OV_STORAGE_CONFLICT', 'This file is stored for another match'))
        if (s.closed && matchOwner?.admin !== true) {
          // the closing account's PDF of the approval, once; a resent job is
          // answered as stored; that same file replaced only within the grace
          if (s.closed_by !== userId || s.other_of_approval) throw new Refused(MATCH_CLOSED())
          if (s.path_of_approval && s.same_bytes) return ok({ path: parts.key, id: objectId(SCORESHEETS_BUCKET, parts.key), fullPath: `${SCORESHEETS_BUCKET}/${parts.key}` })
          if (s.path_of_approval && !s.in_grace) throw new Refused(MATCH_CLOSED())
        }
        const r = await storage.handle('upload', { ...body, bucket: SCORESHEETS_BUCKET }, { userId })
        if (r.status !== 200) return r
        // first_stored_at: the first store of the approval, kept by a replacement
        await client.query(
          `INSERT INTO public.match_scoresheets (path, match_id, stored_by, sha256, size) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (path) DO UPDATE SET stored_by = EXCLUDED.stored_by, sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
             stored_at = now(), first_stored_at = CASE WHEN $6::boolean THEN match_scoresheets.first_stored_at ELSE now() END`,
          [r.body.data.path, m.id, isUuid(userId) ? userId : null, sha256, data.length, s.path_of_approval])
        return r
      })
    } catch (err) {
      if (err instanceof Refused) return err.result
      // assertMatchWritable's refusals (PgQueryError: status and code)
      if (typeof err?.status === 'number' && typeof err?.code === 'string') return fail(err.status, err.code, err.message || 'Request refused')
      // a file stored but not recorded (its record failed) is not served: the app sends it again
      log.error?.(`[scoresheets] store failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /**
   * POST /api/storage/remove in the 'scoresheets' bucket (server.js):
   * lib/storage.js removes the caller's own objects. A PDF of a closed match
   * (one recorded for it, or named for it in its day's folder) stays: 409
   * OV_MATCH_CLOSED for all the paths, admins excepted. The record of a
   * removed PDF goes with it.
   */
  async function removeFiles ({ userId, admin = false, body } = {}) {
    const pdfs = Array.isArray(body?.paths) ? body.paths.slice(0, 100).map(pdfPathParts).filter(Boolean) : []
    if (pdfs.length && !admin) {
      try {
        const { rows } = await pool.query(
          `SELECT 1 FROM public.match_scoresheets s JOIN public.matches m ON m.id = s.match_id
            WHERE s.path = ANY($1::text[]) AND m.closed_at IS NOT NULL LIMIT 1`, [pdfs.map((p) => p.key)])
        let closed = rows.length > 0
        // a file without a record: any closed match its name and folder fit (no cut-off, so
        // that other matches under the same name cannot hide that one)
        for (const parts of pdfs) {
          if (closed) break
          const { values, p } = sqlParams()
          const { rows: hit } = await pool.query(
            `SELECT 1 FROM public.matches m
              WHERE ${pathSql(parts, p)} AND m.closed_at IS NOT NULL AND ${ofDaySql(parts, p)} LIMIT 1`, values)
          closed = hit.length > 0
        }
        if (closed) return MATCH_CLOSED()
      } catch (err) {
        log.error?.(`[scoresheets] remove check failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
        return unavailable()
      }
    }
    const r = await storage.handle('remove', body, { userId })
    const gone = r.status === 200 && Array.isArray(r.body.data) ? r.body.data.map((x) => x.name).filter(isScoresheetPdf) : []
    if (gone.length) {
      try {
        await pool.query('DELETE FROM public.match_scoresheets WHERE path = ANY($1::text[])', [gone])
      } catch (err) {
        // left behind: the readers skip a recorded file that is gone
        log.warn?.(`[scoresheets] record of a removed PDF kept: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      }
    }
    return r
  }

  /**
   * POST /api/scoresheets/:id/view: the PDF behind a short-lived link for the
   * browser's viewer. The read is checked and audited exactly as GET .../pdf.
   */
  async function createViewLink ({ actorId, matchId } = {}) {
    const r = await readPdf({ actorId, matchId, download: false })
    if (r.status !== 200 || !r.file) return r
    pruneViewLinks()
    const token = randomBytes(32).toString('base64url')
    const expires = now() + VIEW_LINK_TTL_MS
    viewLinks.set(token, { file: r.file, expires })
    return ok({
      path: `/api/scoresheet-view/${token}/${encodeURIComponent(r.file.filename)}`,
      filename: r.file.filename,
      expires_at: new Date(expires).toISOString()
    })
  }

  /** GET /api/scoresheet-view/:token/:name: the PDF of a live link, inline; else 404. */
  function readViewLink ({ token, name } = {}) {
    if (typeof token !== 'string' || !VIEW_TOKEN_RE.test(token)) return notFound()
    const v = viewLinks.get(token)
    if (!v) return notFound()
    if (v.expires <= now()) {
      viewLinks.delete(token)
      return notFound()
    }
    // the name is part of the link: a link with another name is not this file's
    if (name !== v.file.filename) return notFound()
    return { status: 200, file: { ...v.file, disposition: 'inline' } }
  }

  return { list, readPdf, sportOf, createViewLink, readViewLink, latestPdf, storePdf, removeFiles }
}
