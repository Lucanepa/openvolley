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
 *   storeFile({ userId, matchOwner, body })  POST /api/storage/upload of a file of a
 *                                            match in the 'scoresheets' bucket
 *                                            (server.js, isMatchScoresheetFile):
 *     storePdf                               a PDF: stored only for a match the caller
 *                                            may write, and recorded for it (db/033)
 *     storeBeachJson                         an OpenBeach JSON with a seed: written only
 *                                            by an account that may write the seed's match
 *   removeFiles({ userId, admin, body })     POST /api/storage/remove in that bucket:
 *                                            a closed match's PDF stays
 *   recordOldPdfs({ apply })                 operator step after db/033
 *                                            (scripts/scoresheet-records.mjs): the PDF
 *                                            of each match closed before it, recorded
 *
 * Where the scorer apps put the files ('scoresheets' bucket; OpenVolley:
 * frontend/src/utils/scoresheetUploader.js, OpenBeach:
 * utils_beach/scoresheetUploader_beach.js):
 *   indoor  {day}/game{g}_k{32 hex}.pdf      g = game_n, else external_id (path-safe)
 *   beach   beach/{day}/game{n}_{seed}.pdf   seed = the match's external_id (path-safe)
 *   older files have no random part:  {day}/game{g}.pdf, beach/{day}/game{n}.pdf
 * {day} is the UTC day of scheduled_at (without one, the app's day of the upload).
 * The JSON files beside them have the same shape. No other path is uploaded
 * to the bucket (server.js, isScoresheetUploadPath): a file at a day
 * folder's name, or a folder at a scoresheet's name (a file below it), would
 * refuse every later upload there (lib/storage.js 409 OV_STORAGE_CONFLICT);
 * scripts/scoresheet-paths.mjs removes such entries made before.
 *
 * Whose PDF it is (db/033 public.match_scoresheets): game numbers, external
 * ids and days are public, so any scorer could store a file under a match's
 * name. A PDF is stored only for a match its uploader may write (pgQuery
 * assertMatchWritable: the creator, an editor, an admin): the match the app
 * names (match_external_id, newer apps), else the one its path names (older
 * apps, OpenBeach; a beach name is the one match's whose external id is its
 * seed). After the close it is stored once per approval: the approval's PDF
 * (the app queues it with the approval, which closes the match, so it comes
 * before or after the close), unless one was stored since the last reopen:
 * recorded, or for a match closed before db/033 without a record the file
 * the tab serves by its name (below). It may come from the match's creator,
 * the closing account, an editor it had at the close or one an admin added
 * (the admin console's "Add editor": a deliberate grant) at any time, and
 * from an account that became an editor by the game PIN after the close
 * only within LATE_EDITOR_WINDOW_MS of the close: a shared tablet sends it
 * under the next account signed in there, which takes the match over with
 * the game PIN. So within that window whoever proves the game PIN can store
 * the first PDF of a closed match that has none yet; later the PIN gives no
 * say over the sheet (409 OV_MATCH_CLOSED), and an admin adds the account
 * or stores the PDF. The same bytes
 * again (a resent job) are accepted, and that same file may be replaced by
 * its uploader or the closing account for CLOSED_REPLACE_GRACE_MS (a
 * corrected approval's PDF sent right after an older one still queued); any
 * other file is not (409 OV_MATCH_CLOSED) until an admin reopens the match,
 * and a closed match's PDF is not removed. The tab and the final mail use
 * only the files recorded for the match, the newest first.
 *
 * Files stored before db/033 have no record. A record stays when its match
 * is deleted (match_id NULL; the app's sync queue deletes open and test
 * matches), so a file stored for one match never becomes another's by its
 * name. recordOldPdfs (scripts/scoresheet-records.mjs, a deploy step after
 * db/033) records for each match closed before db/033 the file the names
 * give it, and from then on its record holds it like any later match's PDF.
 * A match still without a record is found by the names as before (no
 * scheduled day: the days it was closed, updated and created; more than one
 * file: the newest), but only files without a record whose storage owner
 * created the match, closed it, or was its editor before the close or by
 * an admin's grant (a game PIN proved after the close never makes a file
 * the served sheet); a closed one served so is logged. That also covers a PDF stored since
 * db/033 whose record is gone (a database restored from an older dump) or
 * was never written (an older backend put back): the step records those too. Such a
 * file of a closed match stays its own: an upload for another match of the
 * same name neither replaces nor takes it, and it is not removed (409
 * OV_MATCH_CLOSED). A closed match without such a file but with a file of
 * its name that an editor added by the game PIN after the close stored
 * after it was added and within LATE_EDITOR_WINDOW_MS of the close (a
 * shared tablet's approval PDF from before db/033) is not served that file,
 * but no other file is stored for it (admins excepted) until an operator
 * records one; that editor's files of any other time hold nothing.
 *
 * A beach name has no secret part (an indoor name has its device's random
 * part), so another beach scorer could create a match's file paths first and
 * have the real upload refused (lib/storage.js: a new name is its first
 * writer's). An OpenBeach JSON of a seed whose match is in the cloud is
 * therefore written only by an account that may write that match, and the
 * match's own names (beach seed, indoor random part) are written by such an
 * account over a file another account created first: the match's accounts
 * keep it, the others lose it (storage adopt).
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

/** A day folder's name and a scoresheet file's name in the 'scoresheets' bucket (isScoresheetUploadPath). */
export const SCORESHEET_DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const SCORESHEET_FILE_RE = /^game.+\.(?:pdf|json)$/

/**
 * A path the scorer apps upload to the 'scoresheets' bucket, of their
 * current and older versions: {day}/game….{pdf|json} (OpenVolley; OpenBeach
 * before beach/) or beach/{day}/game….{pdf|json} (OpenBeach). Files are then
 * only ever at those depths and folders only above them, so no upload makes
 * a scoresheet's path a folder or a day's folder a file (server.js answers
 * any other path 400).
 */
export function isScoresheetUploadPath (p) {
  const segs = typeof p === 'string' ? parseStoragePath(p) : null
  if (!segs) return false
  const [day, name] = segs.length === 3 && segs[0] === 'beach' ? segs.slice(1) : segs.length === 2 ? segs : []
  return SCORESHEET_DAY_RE.test(day ?? '') && SCORESHEET_FILE_RE.test(name ?? '')
}

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

// OpenBeach's JSON files beside the PDF: game{n}_{seed}.json (its coin toss
// copy) and game{n}_{seed}_final.json (the approval's); game{n}_final.json is
// the older name without a seed
const BEACH_JSON_RE = /^game([^_]*)_(?!final\.json$)(.+?)(?:_final)?\.json$/

/**
 * The parts of an OpenBeach JSON path with a seed (beach/{day}/game{n}_{seed}[_final].json),
 * as pdfPathParts; null for any other path. Indoor JSON names carry a random
 * part (nobody can create one's path first) and are not tied to a match.
 */
export function beachJsonPathParts (p) {
  const segs = typeof p === 'string' ? parseStoragePath(p) : null
  if (!segs || segs.length !== 3 || segs[0] !== 'beach') return null
  const r = BEACH_JSON_RE.exec(segs[2])
  if (!r) return null
  return { key: segs.join('/'), folder: segs.slice(0, 2).join('/'), day: segs[1], name: segs[2], sport: 'beach', game: r[1], seed: r[2] }
}

/** A 'scoresheets' upload path that belongs to a match: a PDF, or an OpenBeach JSON with a seed (storeFile). */
export const isMatchScoresheetFile = (p) => isScoresheetPdf(p) || beachJsonPathParts(p) !== null

const MATCH_CLOSED = () => fail(409, 'OV_MATCH_CLOSED', 'This match is closed: its scoresheet stays as it was stored')
// An upload that names no match (older apps, OpenBeach) whose path fits no
// match: the match's insert may still be on its way (it goes in the score's
// lane). 503, retryable: those apps park a refusal (4xx) for an hour, and
// the final mail would go out without the PDF in the meantime.
const MATCH_NOT_IN_CLOUD = () => ({ status: 503, body: { data: null, error: { message: 'No match of this scoresheet is in the cloud yet', code: 'OV_MATCH_NOT_FOUND', retryable: true } } })
/**
 * After the close, its uploader or the closing account may still replace the
 * approval's PDF (the file stored since the match's last reopen) at the same
 * path for this long after the close, or after that file's first store when
 * it came later (a replacement never moves it): an app sends every queued
 * approval file in turn, and after a reopen and a new approval an older app
 * or OpenBeach may send the first approval's PDF just before the corrected one.
 */
export const CLOSED_REPLACE_GRACE_MS = 10 * 60 * 1000
/**
 * An account that becomes an editor of a match after its close by the game
 * PIN (a shared tablet's next account, whose queue sends the approval's PDF)
 * stores that first PDF only this long after the close, and a file of such
 * an account without a record counts as the approval's only when it was
 * stored after the account was added and this long after the close at most
 * (owner decision: enough for a shared tablet's queue). Later the game PIN
 * gives no say over the closed match's sheet. An editor an admin adds is not
 * bound by it (sheetWritersOf). A file stored within it is replaced as any
 * uploader's (CLOSED_REPLACE_GRACE_MS), also past its end.
 */
export const LATE_EDITOR_WINDOW_MS = 6 * 60 * 60 * 1000

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

  /**
   * The PDF files of the folders, one listing per folder, each with
   * `recorded`: it has a db/033 record, and `match`: the id of the match it is
   * recorded for (null without a record, or when that match was deleted). A
   * listing is null when the storage cannot be read. `q`: a transaction's client.
   */
  function folderReader (q = pool) {
    const seen = new Map()
    return (folder) => {
      if (!seen.has(folder)) seen.set(folder, readFolder(folder, q))
      return seen.get(folder)
    }
  }

  async function readFolder (folder, q) {
    let files
    try {
      files = (await storage.listFilesTrusted({ bucket: SCORESHEETS_BUCKET, path: folder })).filter((f) => f.name.endsWith('.pdf'))
    } catch (err) {
      // a folder name the storage refuses (never one built here) or an I/O error
      log.warn?.(`[scoresheets] list failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      return null
    }
    const keys = files.map((f) => `${folder}/${f.name}`)
    let recordedFor = new Map()
    if (keys.length) {
      try {
        const { rows } = await q.query('SELECT path, match_id::text AS match_id FROM public.match_scoresheets WHERE path = ANY($1::text[])', [keys])
        recordedFor = new Map(rows.map((r) => [r.path, r.match_id]))
      } catch (err) {
        // a database without db/033: no file is recorded
        if (err?.code !== '42P01') throw err
      }
    }
    return files.map((f, i) => ({ ...f, folder, recorded: recordedFor.has(keys[i]), match: recordedFor.get(keys[i]) ?? null }))
  }

  // A closed match without a recorded PDF whose PDF is found by its name
  // (closed before db/033, and recordOldPdfs could not record it: a file the
  // names give to two closed matches): logged once per match and process
  const byNameLogged = new Set()
  function noteByName (matchId, what) {
    if (byNameLogged.has(matchId)) return
    if (byNameLogged.size >= 1000) byNameLogged.clear()
    byNameLogged.add(matchId)
    log.warn?.(`[scoresheets] closed match ${matchId} has no recorded PDF: ${what} by its file name (scripts/scoresheet-records.mjs records it when it can)`)
  }
  const servedByName = (m, located) => {
    if (located.byName && m.closed_at) noteByName(m.id, 'served')
    return located
  }

  /**
   * The PDFs of match row `m`, best first: { files: [{ folder, name, mtimeMs }] },
   * with unknown: true when there is none and the storage could not be read.
   * `recorded`: the files stored for it (db/033), newest first; a match with
   * none (files stored before db/033) by the names (byName: true), but only
   * a file without any record (one recorded for a match, also a deleted
   * one, is that match's) whose storage owner is one of its `writers` (Set
   * of user ids: sheetWritersOf); with `since` (ms) only one stored after
   * that time. `late` (lateEditorsOf, never for serving): also a file of an
   * editor added by the game PIN after the close, stored after it was added
   * and at most LATE_EDITOR_WINDOW_MS after the close.
   */
  async function locate (m, read, recorded, writers, { since = null, late = null } = {}) {
    if (recorded?.length) return { files: recorded }
    const { folders, rank } = pdfLocator(m)
    const lists = await Promise.all(folders.map(read))
    let unknown = lists.some((l) => l === null)
    const named = lists.filter(Boolean).flat()
      .filter((e) => rank(e.name) && !e.recorded && (since === null || e.mtimeMs > since))
    const lateUntil = late?.size && m.closed_at ? new Date(m.closed_at).getTime() + LATE_EDITOR_WINDOW_MS : null
    const lateFile = (e, owners) => lateUntil !== null && e.mtimeMs <= lateUntil && owners.some((o) => late.has(o) && late.get(o) <= e.mtimeMs)
    const allowed = await Promise.all(named.map(async (e) => {
      try {
        const owners = await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path: `${e.folder}/${e.name}` })
        return owners.some((o) => writers?.has(o)) || lateFile(e, owners)
      } catch (err) {
        log.warn?.(`[scoresheets] owner record unreadable: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
        unknown = true
        return false
      }
    }))
    const file = bestPdf(named.filter((_, i) => allowed[i]), rank)
    return file ? { files: [file], byName: true } : { files: [], unknown }
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

  /**
   * The accounts that created, edit or closed the matches `ids`: Map(id -> Set
   * of user ids). `atClose`: of a closed match only the editors it had when
   * it closed and those an admin added (granted_via 'admin'). `q`: a
   * transaction's client.
   */
  async function writersOf (ids, q = pool, { atClose = false } = {}) {
    if (!ids.length) return new Map()
    const { rows } = await q.query(
      `SELECT m.id::text AS id, m.created_by::text AS created_by, m.closed_by::text AS closed_by,
              ARRAY(SELECT e.user_id::text FROM public.match_editors e WHERE e.match_id = m.id
                       ${atClose ? "AND (m.closed_at IS NULL OR e.created_at <= m.closed_at OR e.granted_via = 'admin')" : ''}) AS editors
         FROM public.matches m WHERE m.id = ANY($1::uuid[])`, [ids])
    return new Map(rows.map((r) => [r.id, new Set([r.created_by, r.closed_by, ...(r.editors || [])].filter(Boolean))]))
  }

  /**
   * Whose files the names give a match without a record (locate), and who
   * may store a closed match's first PDF at any time (storePdf): its
   * creator, the closing account, the editors it had at the close and those
   * an admin added (a deliberate grant: the admin console's "Add editor",
   * accounts.addMatchEditor). An account that proves the game PIN after the
   * close becomes an editor (a shared tablet's next account sends the
   * approval's PDF so), but its older files of the match's name are not the
   * closed match's sheet for that.
   */
  const sheetWritersOf = (ids, q = pool) => writersOf(ids, q, { atClose: true })

  /**
   * The editors the closed matches `ids` got after the close by the game PIN
   * (not an admin's grant: sheetWritersOf) and at most LATE_EDITOR_WINDOW_MS
   * after it (a shared tablet's next account): Map(id -> Map(user id -> when
   * it was added, ms)). A file such an editor stored after it was added,
   * also within the window, can be the approval's PDF (locate `late`): not
   * served, but no other file takes its place. `q`: a transaction's client.
   */
  async function lateEditorsOf (ids, q = pool) {
    if (!ids.length) return new Map()
    const { rows } = await q.query(
      `SELECT e.match_id::text AS id, e.user_id::text AS user_id, e.created_at
         FROM public.match_editors e JOIN public.matches m ON m.id = e.match_id
        WHERE e.match_id = ANY($1::uuid[]) AND e.created_at > m.closed_at AND e.granted_via <> 'admin'
          AND e.created_at <= m.closed_at + make_interval(secs => $2)`, [ids, LATE_EDITOR_WINDOW_MS / 1000])
    const out = new Map()
    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, new Map())
      out.get(r.id).set(r.user_id, new Date(r.created_at).getTime())
    }
    return out
  }

  /** locate() for one match row, its records and writers read first. */
  async function locateOne (m) {
    const recorded = (await recordedPdfs([m.id]))?.get(m.id)
    if (recorded?.length) return { files: recorded }
    const writers = (await sheetWritersOf([m.id])).get(m.id)
    return servedByName(m, await locate(m, folderReader(), null, writers))
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
      const writers = await sheetWritersOf(rows.filter((r) => !recorded?.get(r.id)?.length).map((r) => r.id))
      const read = folderReader()
      const located = await Promise.all(rows.map(async (r) =>
        servedByName(r, await locate({ ...r, sport: sportOut(r.is_beach) }, read, recorded?.get(r.id), writers.get(r.id)))))
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
  // pdfLocator has the last word on a row that is used. fitsNameSql: also a row
  // without an external id (an old one, served by its game number);
  // pathSql: a match an upload can be for (assertMatchWritable needs one).
  const BEACH_SEED_SQL = "regexp_replace(m.external_id, '[^A-Za-z0-9_-]', '-', 'g')"
  function fitsNameSql (parts, p) {
    let fits
    if (parts.sport === 'beach') {
      fits = "m.sport_type IS NOT DISTINCT FROM 'beach' AND " +
        (parts.seed !== null ? `${BEACH_SEED_SQL} = ${p(parts.seed)}` : `m.game_n::text = ${p(parts.game)}`)
    } else {
      const g = p(parts.game)
      fits = `m.sport_type IS DISTINCT FROM 'beach' AND (m.game_n::text = ${g} OR left(regexp_replace(btrim(m.external_id), '[^A-Za-z0-9-]', '-', 'g'), 64) = ${g})`
    }
    return `m.test IS NOT TRUE AND ${fits}`
  }
  const pathSql = (parts, p) => `m.external_id IS NOT NULL AND ${fitsNameSql(parts, p)}`
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
   * under the name do not push the caller's out of the candidates; then a
   * closed one still without its approval's PDF (none recorded since its
   * last reopen, and none on disk by its name: a match closed before db/033
   * has it there). An older app sends the PDF of the approval that closed
   * the match, so it can come after the game was entered again in a new
   * match: that one is open, or has its own PDF. Then one an admin has not
   * released (release-game: a duplicate, its game entered again in a newer
   * match), the newer one first. A PDF of such a name is stored under its
   * own random path, recorded for the match found here.
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
        `SELECT ${ROW_COLUMNS}, m.closed_by::text AS closed_by, ${own} AS own, ${ofDay} AS of_day, r.at AS reopened_at,
                (m.closed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.match_scoresheets o
                   WHERE o.match_id = m.id AND (r.at IS NULL OR o.stored_at > r.at))) AS none_recorded
           FROM public.matches m
           LEFT JOIN LATERAL (SELECT max(a.at) AS at FROM public.audit_log a
                               WHERE a.action = 'match.reopen' AND a.match_id = m.id) r ON true
          WHERE ${where} ORDER BY own DESC, of_day DESC, m.official_game_exempt IS NOT TRUE DESC,
                m.scheduled_at DESC NULLS LAST, m.created_at DESC NULLS LAST, m.id LIMIT 20`, values)
      const fits = rows.map(matchRow).filter((m) => pdfLocator(m).rank(parts.name))
      const closed = fits.filter((m) => m.none_recorded)
      // (the files on disk storePdf holds it by: its accounts' at the close,
      // and a late editor's from the window after the close)
      const ids = closed.map((m) => m.id)
      const writers = await sheetWritersOf(ids, client)
      const late = await lateEditorsOf(ids, client)
      const read = folderReader(client)
      const waiting = new Set((await Promise.all(closed.map(async (m) => {
        const { files, unknown } = await locate(m, read, null, writers.get(m.id), { since: m.reopened_at ? new Date(m.reopened_at).getTime() : null, late: late.get(m.id) })
        return files.length || unknown ? null : m.id
      }))).filter(Boolean))
      // ties keep the SQL order (sort is stable)
      const order = (m) => [m.own, m.of_day, waiting.has(m.id)].map(Number)
      candidates = fits.sort((a, b) => {
        const [x, y] = [order(a), order(b)]
        return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2])
      })
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
   * A closed match with no PDF recorded since its last reopen: the file the
   * manager's tab serves for it by its name (a match closed before db/033
   * that recordOldPdfs has not recorded has its approval's PDF on disk
   * without a record), if that file was stored since the reopen. `writers`:
   * sheetWritersOf; `late`: lateEditorsOf (locate). { key, mtimeMs, owners }
   * or null; { unknown: true } when the storage could not be read.
   */
  async function unrecordedApprovalPdf (m, writers, reopenedAt, read, late = null) {
    const since = reopenedAt ? new Date(reopenedAt).getTime() : null
    const { files: [f], unknown } = await locate(m, read, null, writers, { since, late })
    if (!f) return unknown ? { unknown: true } : null
    noteByName(m.id, 'its PDF held')
    const key = `${f.folder}/${f.name}`
    return { key, mtimeMs: f.mtimeMs, owners: await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path: key }) }
  }

  /**
   * Whether the file on disk at the path `parts` (one without a record) is
   * the PDF the Scoresheets tab serves by its name (locate) for a closed match
   * (other than `exceptId`, when given) that has no PDF recorded (closed
   * before db/033): a file of a match its name and day fit (also one without
   * an external id: an old row), whose creator, an editor (of any time: this
   * only protects) or the closing account owns the file. Such a file stays
   * that match's, whatever other match of the same name an upload or a
   * remove is for. `q`: a transaction's client, or the pool.
   */
  async function oldPdfOfClosedMatch (q, read, parts, exceptId) {
    // no owner record: no file, or one the tab serves for no match
    const owners = await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path: parts.key })
    if (!owners.length) return false
    const files = await read(parts.folder)
    if (files === null) throw new Refused(unavailable())
    const f = files.find((x) => x.name === parts.name)
    // no file, or a recorded one (its match's, also a deleted one's)
    if (!f || f.recorded) return false
    const { values, p } = sqlParams()
    const o = p(owners)
    const { rows } = await q.query(
      `SELECT ${ROW_COLUMNS} FROM public.matches m
        WHERE ${fitsNameSql(parts, p)} AND m.closed_at IS NOT NULL AND ${ofDaySql(parts, p)}
          ${exceptId ? `AND m.id <> ${p(exceptId)}::uuid` : ''}
          AND NOT EXISTS (SELECT 1 FROM public.match_scoresheets s WHERE s.match_id = m.id)
          AND (m.created_by::text = ANY(${o}::text[]) OR m.closed_by::text = ANY(${o}::text[])
               OR EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id::text = ANY(${o}::text[])))
        LIMIT 20`, values)
    const hit = rows.find((r) => pdfLocator(matchRow(r)).rank(parts.name) > 0)
    if (hit) noteByName(hit.id, 'its PDF held')
    return !!hit
  }

  /** The answer to a refusal thrown in a store's transaction, or 503 for anything else. */
  function storeFailed (err) {
    if (err instanceof Refused) return err.result
    // assertMatchWritable's refusals (PgQueryError: status and code)
    if (typeof err?.status === 'number' && typeof err?.code === 'string') return fail(err.status, err.code, err.message || 'Request refused')
    log.error?.(`[scoresheets] store failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
    return unavailable()
  }

  /**
   * POST /api/storage/upload of a PDF in the 'scoresheets' bucket (server.js,
   * after its check that the caller scores the path's sport): { status, body }
   * as lib/storage.js handle(). The PDF ('%PDF-', else 415) is stored for the
   * match body.match_external_id names, or the match its path names, when
   * the caller may write that match (403 OV_NOT_MATCH_OWNER / OV_SCORER_REQUIRED;
   * OV_MATCH_NOT_FOUND while the match is not in the cloud: 404 for the
   * match the app names, which the app retries, 503 for a path no match
   * fits), and recorded for it. The match's own name (a beach seed, an
   * indoor random part) is the caller's to write even when another account
   * created that file first; the match's accounts keep it, the others lose
   * it. A closed match: see the header (409 OV_MATCH_CLOSED). One store per
   * match at a time (an advisory lock; the match row is held FOR SHARE, so
   * it cannot close in between).
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
          `SELECT m.closed_at IS NOT NULL AS closed, m.closed_by::text AS closed_by, r.at AS reopened_at,
                  x.match_id::text AS path_match, x.stored_by::text AS path_stored_by,
                  coalesce(x.match_id = m.id AND (r.at IS NULL OR x.stored_at > r.at), false) AS path_of_approval,
                  coalesce(x.sha256 = $3, false) AS same_bytes,
                  coalesce(greatest(m.closed_at, x.first_stored_at) > now() - make_interval(secs => $4), false) AS in_grace,
                  coalesce(m.closed_at > now() - make_interval(secs => $5), false) AS in_late_window,
                  EXISTS (SELECT 1 FROM public.match_scoresheets o
                           WHERE o.match_id = m.id AND (r.at IS NULL OR o.stored_at > r.at) AND o.path <> $2) AS other_of_approval
             FROM public.matches m
             LEFT JOIN public.match_scoresheets x ON x.path = $2
             LEFT JOIN LATERAL (SELECT max(a.at) AS at FROM public.audit_log a
                                 WHERE a.action = 'match.reopen' AND a.match_id = m.id) r ON true
            WHERE m.id = $1`, [m.id, parts.key, sha256, CLOSED_REPLACE_GRACE_MS / 1000, LATE_EDITOR_WINDOW_MS / 1000])
        // A beach name is its seed's match's (namedMatch, pathMatch): a file
        // recorded for a match made to fit the seed before that one was in
        // the cloud goes to it
        if (s.path_match && s.path_match !== m.id && !(parts.sport === 'beach' && parts.seed !== null)) {
          throw new Refused(fail(409, 'OV_STORAGE_CONFLICT', 'This file is stored for another match'))
        }
        const read = folderReader(client)
        // A file without a record at this path can be the PDF of a closed
        // match without a record: it stays that one's (oldPdfOfClosedMatch),
        // as if recorded for it (a beach seed is one match's, see above)
        if (!s.path_match && matchOwner?.admin !== true && !(parts.sport === 'beach' && parts.seed !== null) &&
            await oldPdfOfClosedMatch(client, read, parts, m.id)) throw new Refused(MATCH_CLOSED())
        const writers = (await writersOf([m.id], client)).get(m.id) ?? new Set()
        // first_stored_at of a file from before db/033 taken as the approval's: its own time
        let firstStoredAt = null
        if (s.closed && matchOwner?.admin !== true) {
          // The approval's PDF, once: the first one stored since the last
          // reopen, from any account that may write the match: its creator,
          // the closing account, an editor it had at the close or one an
          // admin added, or within LATE_EDITOR_WINDOW_MS of the close an
          // editor added since by the game PIN (the closing tablet may send
          // it under the next account signed in there). A resent job is
          // answered as stored; that same file is replaced only within the
          // grace, by its uploader or the closing account.
          if (s.path_of_approval && s.same_bytes) return ok({ path: parts.key, id: objectId(SCORESHEETS_BUCKET, parts.key), fullPath: `${SCORESHEETS_BUCKET}/${parts.key}` })
          const sheetWriters = (await sheetWritersOf([m.id], client)).get(m.id) ?? new Set()
          if (s.other_of_approval) throw new Refused(MATCH_CLOSED())
          let held = null
          if (s.path_of_approval) {
            held = { sameBytes: s.same_bytes, inGrace: s.in_grace, by: [s.path_stored_by] }
          } else {
            // the first store (the caller writes the match: when none of
            // these, an editor added after the close by the game PIN)
            if (!sheetWriters.has(userId) && !s.in_late_window) throw new Refused(MATCH_CLOSED())
            // none recorded: a match closed before db/033 has its PDF on disk all the same
            const old = await unrecordedApprovalPdf(m, sheetWriters, s.reopened_at, read)
            if (old?.unknown) throw new Refused(unavailable())
            if (old) {
              if (old.key !== parts.key) throw new Refused(MATCH_CLOSED())
              const bytes = await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path: old.key })
              const { rows: [g] } = await client.query(
                `SELECT greatest(closed_at, to_timestamp($2::double precision / 1000)) > now() - make_interval(secs => $3) AS in_grace
                   FROM public.matches WHERE id = $1`, [m.id, old.mtimeMs, CLOSED_REPLACE_GRACE_MS / 1000])
              held = { sameBytes: createHash('sha256').update(bytes).digest('hex') === sha256, inGrace: g.in_grace === true, by: old.owners }
              firstStoredAt = new Date(old.mtimeMs)
            } else {
              // only a file an editor added by the game PIN after the close
              // stored within the window (a shared tablet's approval PDF, locate `late`):
              // not the match's sheet (never served or recorded for it), and
              // no other file takes its place either (an operator records
              // it, README). Its files of any other time hold nothing.
              const late = await unrecordedApprovalPdf(m, sheetWriters, s.reopened_at, read, (await lateEditorsOf([m.id], client)).get(m.id))
              if (late?.unknown) throw new Refused(unavailable())
              if (late) throw new Refused(MATCH_CLOSED())
            }
          }
          if (held && !held.sameBytes && !(held.inGrace && (userId === s.closed_by || held.by.includes(userId)))) throw new Refused(MATCH_CLOSED())
        }
        // The match's own name (rank 2: its beach seed, an indoor random part)
        // is the caller's to write, also over a file another account created
        // there first; owners who are none of the match's accounts lose it
        const own = pdfLocator(m).rank(parts.name) === 2
        const r = await storage.handle('upload', { ...body, bucket: SCORESHEETS_BUCKET }, { userId, ...(own ? { adopt: (owners) => owners.filter((o) => writers.has(o)) } : {}) })
        if (r.status !== 200) return r
        // first_stored_at: the first store of the approval, kept by a replacement
        await client.query(
          `INSERT INTO public.match_scoresheets (path, match_id, stored_by, sha256, size, first_stored_at) VALUES ($1, $2, $3, $4, $5, coalesce($7::timestamptz, now()))
           ON CONFLICT (path) DO UPDATE SET match_id = EXCLUDED.match_id, stored_by = EXCLUDED.stored_by, sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
             stored_at = now(), first_stored_at = CASE WHEN $6::boolean THEN match_scoresheets.first_stored_at ELSE EXCLUDED.first_stored_at END`,
          [r.body.data.path, m.id, isUuid(userId) ? userId : null, sha256, data.length, s.path_of_approval, firstStoredAt])
        return r
      })
    } catch (err) {
      // (a file stored but not recorded, its record failed: the app sends it again)
      return storeFailed(err)
    }
  }

  /**
   * POST /api/storage/upload of an OpenBeach JSON file with a seed
   * (beachJsonPathParts; server.js, after its check that the caller scores
   * beach). A beach name has no secret part, so the path of a match's files
   * is public: the file of the seed's match is stored only by an account
   * that may write that match (403 OV_NOT_MATCH_OWNER), which takes the path
   * over from an account that created it first and is none of the match's.
   * While no match of the seed is in the cloud (OpenBeach's coin toss copy
   * can come before the match's insert) it is stored as before: the seed is
   * not public until then. Not recorded and no rule after the close: only
   * its uploaders read it.
   */
  async function storeBeachJson ({ userId, matchOwner, body } = {}) {
    const parts = beachJsonPathParts(body?.path)
    if (!parts) return invalid('path: not a scoresheet file of a match')
    if (!db?.withTransaction || !db?.assertMatchWritable) return unavailable()
    const upload = { ...body, bucket: SCORESHEETS_BUCKET }
    try {
      return await db.withTransaction(async (client) => {
        const m = await seededBeachMatch(client, parts)
        if (!m) return storage.handle('upload', upload, { userId })
        await db.assertMatchWritable(client, m.external_id, matchOwner)
        const writers = (await writersOf([m.id], client)).get(m.id) ?? new Set()
        return storage.handle('upload', upload, { userId, adopt: (owners) => owners.filter((o) => writers.has(o)) })
      })
    } catch (err) {
      return storeFailed(err)
    }
  }

  /** POST /api/storage/upload of a file that belongs to a match (isMatchScoresheetFile): storePdf or storeBeachJson. */
  const storeFile = (o = {}) => (isScoresheetPdf(o.body?.path) ? storePdf(o) : storeBeachJson(o))

  /**
   * POST /api/storage/remove in the 'scoresheets' bucket (server.js):
   * lib/storage.js removes the caller's own objects. A PDF of a closed match
   * (one recorded for it, or for a closed match without a record the file
   * the names give it: oldPdfOfClosedMatch) stays: 409 OV_MATCH_CLOSED for
   * all the paths, admins excepted. The record of a removed PDF goes with it.
   */
  async function removeFiles ({ userId, admin = false, body } = {}) {
    const pdfs = Array.isArray(body?.paths) ? body.paths.slice(0, 100).map(pdfPathParts).filter(Boolean) : []
    if (pdfs.length && !admin) {
      try {
        const { rows } = await pool.query(
          `SELECT s.path, m.closed_at IS NOT NULL AS closed FROM public.match_scoresheets s JOIN public.matches m ON m.id = s.match_id
            WHERE s.path = ANY($1::text[])`, [pdfs.map((p) => p.key)])
        if (rows.some((r) => r.closed)) return MATCH_CLOSED()
        // a recorded file is its match's alone; one without a record is a
        // closed match's only as the file its name gives it (stored before db/033)
        const recorded = new Set(rows.map((r) => r.path))
        const read = folderReader()
        for (const parts of pdfs) {
          if (!recorded.has(parts.key) && await oldPdfOfClosedMatch(pool, read, parts, null)) return MATCH_CLOSED()
        }
      } catch (err) {
        if (err instanceof Refused) return err.result
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
   * Deploy step after db/033 (scripts/scoresheet-records.mjs, never over
   * HTTP): each closed match without a recorded PDF (closed before db/033;
   * or its record is gone with a database restored from an older dump, or
   * an older backend put back stored it) gets a record of the file the
   * Scoresheets tab serves for it by its name (locate), with that file's
   * time as stored_at and first_stored_at. Its PDF is then held by the
   * record as every later match's: the closed-match rules of storePdf and
   * removeFiles, no other match's names reach it, and an account deletion no
   * longer hides it. A file the names serve for another of these matches too
   * is left to the names (shared; logged when served). A match whose only
   * file of its name is one an editor added by the game PIN after the close
   * stored within LATE_EDITOR_WINDOW_MS of it (a shared tablet's, locate
   * `late`) is counted (lateEditor) and left: such a file is not served
   * (sheetWritersOf), an operator records it by hand once the scorer is
   * confirmed. Such an editor's file of any other time counts as none.
   * Idempotent: a match with a record and a recorded path are left alone.
   * `apply` false: counts only. { matches, recorded, shared, none, lateEditor, unknown }
   */
  async function recordOldPdfs ({ apply = false } = {}) {
    const { rows } = await pool.query(
      `SELECT ${ROW_COLUMNS} FROM public.matches m
        WHERE m.closed_at IS NOT NULL AND m.test IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM public.match_scoresheets s WHERE s.match_id = m.id)
        ORDER BY m.closed_at, m.id`)
    const matches = rows.map(matchRow)
    const writers = await sheetWritersOf(matches.map((m) => m.id))
    const read = folderReader()
    const out = { matches: matches.length, recorded: 0, shared: 0, none: 0, lateEditor: 0, unknown: 0 }
    const found = []
    const without = []
    for (const m of matches) {
      const { files: [f], unknown } = await locate(m, read, null, writers.get(m.id))
      if (f) found.push({ m, key: `${f.folder}/${f.name}`, mtimeMs: f.mtimeMs })
      else if (unknown) out.unknown++
      else without.push(m)
    }
    const late = await lateEditorsOf(without.map((m) => m.id))
    for (const m of without) {
      const { files: [f], unknown } = await locate(m, read, null, writers.get(m.id), { late: late.get(m.id) })
      out[f ? 'lateEditor' : unknown ? 'unknown' : 'none']++
    }
    const servedFor = new Map()
    for (const x of found) servedFor.set(x.key, (servedFor.get(x.key) ?? 0) + 1)
    for (const x of found) {
      if (servedFor.get(x.key) > 1) {
        out.shared++
        continue
      }
      if (!apply) {
        out.recorded++
        continue
      }
      let data
      let owners
      try {
        data = await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path: x.key })
        owners = await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path: x.key })
      } catch (err) {
        // removed in the meantime, or unreadable
        log.warn?.(`[scoresheets] old PDF unreadable: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
        out.unknown++
        continue
      }
      const by = owners.find((o) => writers.get(x.m.id)?.has(o)) ?? null
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ov.scoresheet:${x.m.id}`])
        const r = await client.query(
          `INSERT INTO public.match_scoresheets (path, match_id, stored_by, sha256, size, stored_at, first_stored_at)
           SELECT $1, $2::uuid, (SELECT u.id FROM auth.users u WHERE u.id = $3::uuid), $4, $5, t.at, t.at
             FROM (SELECT to_timestamp($6::double precision / 1000) AS at) t
            WHERE NOT EXISTS (SELECT 1 FROM public.match_scoresheets s WHERE s.match_id = $2::uuid)
           ON CONFLICT (path) DO NOTHING`,
          [x.key, x.m.id, isUuid(by) ? by : null, createHash('sha256').update(data).digest('hex'), data.length, x.mtimeMs])
        await client.query('COMMIT')
        out.recorded += r.rowCount
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }
    return out
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

  return { list, readPdf, sportOf, createViewLink, readViewLink, latestPdf, storeFile, storePdf, storeBeachJson, removeFiles, recordOldPdfs }
}
