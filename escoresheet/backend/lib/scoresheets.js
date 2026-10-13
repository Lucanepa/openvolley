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
 *   readViewLink({ token, name })            that PDF, inline, by its link: { status, file }
 *                                            or 404. The browser's own PDF viewer opens
 *                                            the link in a tab (no Authorization header
 *                                            there), shows the file name and saves under
 *                                            it (owner 2026-10-13: a blob: URL saved as
 *                                            "<uuid>.pdf"). The token is the capability:
 *                                            32 random bytes, kept in this process only,
 *                                            gone after the TTL or a restart.
 *
 * Where the scorer apps put the files ('scoresheets' bucket; OpenVolley:
 * frontend/src/utils/scoresheetUploader.js, OpenBeach:
 * utils_beach/scoresheetUploader_beach.js):
 *   indoor  {day}/game{g}_k{32 hex}.pdf      g = game_n, else external_id (path-safe)
 *   beach   beach/{day}/game{n}_{seed}.pdf   seed = the match's external_id (path-safe)
 *   older files have no random part:  {day}/game{g}.pdf, beach/{day}/game{n}.pdf
 * {day} is the UTC day of scheduled_at; a match without one was filed under
 * the day of the upload, so the days it was closed, updated and created are
 * tried. More than one file (another device, a re-approval): the newest.
 *
 * This is the only code that reads scoresheets past the uploader-only rule
 * (README "Who can read a scoresheet"); every read is in the audit log.
 */

import { randomBytes } from 'node:crypto'
import { appParam, fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'

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
export function downloadName ({ game_n: gameN, external_id: externalId, sport, league, home_name: home, away_name: away, scheduled_at: scheduledAt }, folderDay) {
  const game = filePart(gameN ?? (sport === 'beach' ? null : externalId), 20)
  const who = game ? `game${game}` : `${filePart(home) || 'Home'}_vs_${filePart(away) || 'Away'}`
  const when = scheduledAt ? new Date(scheduledAt) : null
  const day = when && !Number.isNaN(when.getTime()) ? zurichDayFmt.format(when) : folderDay
  return `${[who, filePart(league), day].filter(Boolean).join('_').slice(0, 116)}.pdf`
}

/** The seed part of an OpenBeach file name (scoresheetUploader_beach.js scoresheetStoragePath). */
const cleanSeed = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '-')

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
    const seed = m.external_id ? `_${cleanSeed(m.external_id)}.pdf` : null
    const legacy = m.game_n != null ? `game${m.game_n}.pdf` : null
    return { folders, rank: (name) => (seed && name.startsWith('game') && name.endsWith(seed) ? 2 : name === legacy ? 1 : 0) }
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

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {ReturnType<import('./storage.js').createStorage>} o.storage
 * @param {ReturnType<import('./accounts.js').createAccounts>} o.accounts  its audit()
 */
export function createScoresheets ({ pool, storage, accounts, logger = console, now = () => Date.now() } = {}) {
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

  /** The best PDF of match row `m`: { file } (null when there is none), or { file: null, unknown: true }. */
  async function locate (m, read) {
    const { folders, rank } = pdfLocator(m)
    const lists = await Promise.all(folders.map(read))
    if (lists.some((l) => l === null)) {
      const file = bestPdf(lists.filter(Boolean).flat(), rank)
      return file ? { file } : { file: null, unknown: true }
    }
    return { file: bestPdf(lists.flat(), rank) }
  }

  const ROW_COLUMNS = `m.id, m.external_id, m.game_n, m.status, m.scheduled_at, m.closed_at, m.updated_at, m.created_at,
                (m.sport_type IS NOT DISTINCT FROM 'beach') AS is_beach`

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
        where.push(`((m.home_team->>'name') ILIKE ${pat} OR (m.away_team->>'name') ILIKE ${pat})`)
      }
      const { rows } = await pool.query(
        `SELECT ${ROW_COLUMNS},
                m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, m.match_info->>'league' AS league,
                nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS scorer_name
           FROM public.matches m
           LEFT JOIN public.profiles p ON p.user_id = m.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY coalesce(m.scheduled_at, m.created_at) DESC NULLS LAST, m.id
          LIMIT ${lim}`, values)
      const read = folderReader()
      const located = await Promise.all(rows.map((r) => locate({ ...r, sport: sportOut(r.is_beach) }, read)))
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
          sport: sportOut(r.is_beach),
          pdf: located[i].unknown ? null : !!located[i].file,
          pdf_updated_at: located[i].file ? new Date(located[i].file.mtimeMs).toISOString() : null
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
    try {
      const { rows: [r] } = await pool.query(
        `SELECT ${ROW_COLUMNS}, m.test, m.match_info->>'league' AS league,
                m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name
           FROM public.matches m WHERE m.id = $1`, [matchId])
      if (!r || r.test === true) return notFound()
      m = { ...r, sport: sportOut(r.is_beach) }
    } catch (err) {
      log.error?.(`[scoresheets] read failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
    const { file, unknown } = await locate(m, folderReader())
    if (!file) return unknown ? unavailable() : NO_PDF()
    let data
    try {
      data = await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path: `${file.folder}/${file.name}` })
    } catch (err) {
      if (err?.code === 'OV_STORAGE_NOT_FOUND') return NO_PDF()
      log.warn?.(`[scoresheets] read failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      return unavailable()
    }
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

  return { list, readPdf, sportOf, createViewLink, readViewLink }
}
