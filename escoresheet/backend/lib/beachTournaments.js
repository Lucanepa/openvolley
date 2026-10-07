/**
 * beachTournaments — OpenBeach tournaments on the server: tournaments,
 * courts, draws, entries, the double-elimination bracket, the schedule,
 * manual results and the final ranking
 * (~/ov-ops/openbeach-separation-tournaments-PLAN.md section 3, phase T1;
 * docs/beach-tournaments-spec.md; db/014_beach_tournaments.sql).
 *
 * Who may do what (the beach roles of lib/access.js; never the app the client
 * says it is):
 *   read     the global admin, a beach:competition_manager, a beach:scorer.
 *            A tournament in 'draft' only for its editors; 'archived' is not
 *            listed for scorers.
 *   create   beach:competition_manager or the global admin
 *   edit     the global admin, or a beach:competition_manager who created
 *            the tournament or is one of its co-managers
 * The public projection (publicTournament) shows names and countries only,
 * never licence numbers, dates of birth, emails or account ids (decision D9),
 * and only for tournaments marked public and no longer in draft.
 *
 * Every handler returns { status, body } and never throws (a database error
 * is 503 OV_DB_UNAVAILABLE). Every write is audit-logged with app 'beach'.
 *
 * Results: a manual result (or a walkover, retirement, forfeit) finishes a
 * tournament match; the whole draw is then recomputed from its results (who
 * plays which match, 'ready' when both teams are known, the final ranks), so
 * entering or withdrawing a result is idempotent. A result whose dependent
 * matches have already been called, started or ended cannot be changed or
 * withdrawn (409 OV_BRACKET_LOCKED): the bracket is never rewritten under a
 * running match.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { accessForSport } from './access.js'
import { DE_MAX_TEAMS, DE_MIN_TEAMS, boardSizeFor, doubleElimination, drawWarnings, entryOfSource } from './beachBracket.js'
import { daysBetween, minutesOf, scheduleMatches, slotIssues } from './beachSchedule.js'
import { fold, importHash, normalizeImport, planImport } from './beachImport.js'

export const TOURNAMENT_STATUSES = Object.freeze(['draft', 'published', 'live', 'finished', 'archived'])
export const DRAW_GENDERS = Object.freeze(['men', 'women', 'mixed'])
export const ENTRY_STATUSES = Object.freeze(['registered', 'withdrawn', 'replaced', 'dq'])
export const RESULT_KINDS = Object.freeze(['played', 'retired', 'forfeit', 'walkover'])
// statuses of a tournament match that has not begun (its slot and teams may still move)
const OPEN_STATUSES = ['scheduled', 'ready']
// statuses that lock a match's teams (called, running or ended, or linked to a scored match)
const LOCKED_STATUSES = ['called', 'in_progress', 'finished', 'walkover']
const PUBLIC_STATUSES = ['published', 'live', 'finished', 'archived']
const LISTED_FOR_READERS = ['published', 'live', 'finished']

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COUNTRY_RE = /^[A-Z]{3}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const day = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : (v ?? null))
const hhmm = (v) => (typeof v === 'string' ? v.slice(0, 5) : v ?? null)

const FORBIDDEN = () => fail(403, 'OV_FORBIDDEN', 'You do not have access to this')
const METHOD_NOT_ALLOWED = () => fail(405, 'OV_METHOD_NOT_ALLOWED', 'Method not allowed')
const LOCKED = (details) => fail(409, 'OV_BRACKET_LOCKED', 'A match that depends on this one has already begun', details)
const STARTED = () => fail(409, 'OV_DRAW_STARTED', 'Matches of this draw have already begun')

function validDay (s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Optional text: { value } (undefined = absent, null = cleared) or { error }. */
function text (raw, max, { required = false, min = 1 } = {}) {
  if (raw === undefined) return required ? { error: 'required' } : { value: undefined }
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return required ? { error: 'required' } : { value: null }
  if (typeof raw !== 'string') return { error: 'must be text' }
  const s = raw.trim()
  if (s.length < min) return { error: `at least ${min} characters` }
  if (s.length > max) return { error: `at most ${max} characters` }
  return { value: s }
}
const bool = (raw) => (raw === undefined ? { value: undefined } : typeof raw === 'boolean' ? { value: raw } : { error: 'true or false' })
const intIn = (raw, min, max, { nullable = false } = {}) => {
  if (raw === undefined) return { value: undefined }
  if (raw === null && nullable) return { value: null }
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: `an integer from ${min} to ${max}` }
}
const oneOf = (raw, list) => (raw === undefined ? { value: undefined } : list.includes(raw) ? { value: raw } : { error: list.join(', ') })

/** Collects field values or the first error as a 400 answer. */
function fields () {
  const out = {}
  let error = null
  return {
    out,
    get error () { return error },
    set (name, r) {
      if (error) return
      if (r.error) error = invalid(`${name}: ${r.error}`)
      else if (r.value !== undefined) out[name] = r.value
    }
  }
}

/** A URL slug from a title: 'Züri Open 2026' -> 'zuri-open-2026'. */
export function slugify (title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/g, '')
}

/** A player snapshot { first, last, licence, country } from a body value; { value } or { error }. */
function playerField (raw) {
  if (!isPlainObject(raw)) return { error: 'an object with first, last, licence, country' }
  const last = text(raw.last, 80, { required: true })
  if (last.error) return { error: `last: ${last.error}` }
  const first = text(raw.first, 80)
  if (first.error) return { error: `first: ${first.error}` }
  const licence = text(raw.licence, 40)
  if (licence.error) return { error: `licence: ${licence.error}` }
  let country = null
  if (raw.country != null && raw.country !== '') {
    if (typeof raw.country !== 'string' || !COUNTRY_RE.test(raw.country.trim().toUpperCase())) return { error: "country: 3 letters like 'SUI'" }
    country = raw.country.trim().toUpperCase()
  }
  return { value: { first: first.value ?? '', last: last.value, licence: licence.value ?? null, country } }
}

/** The default name of a pair: 'Muster/Beispiel'. */
const pairName = (p1, p2) => [p1?.last, p2?.last].filter(Boolean).join('/').slice(0, 120) || 'Pair'

/**
 * Beach scoring (21/21/15, best of 3, two points clear): null when `sets`
 * fits a result won by side `winner` (1 or 2), else the reason.
 * Retired and forfeit results take the sets played so far (may be none).
 */
export function setsError (sets, winner, kind, points = [21, 21, 15]) {
  if (kind === 'walkover') return sets == null || (Array.isArray(sets) && sets.length === 0) ? null : 'a walkover has no sets'
  if (sets == null) return kind === 'played' ? 'the sets are required' : null
  if (!Array.isArray(sets) || sets.length > 3) return 'at most 3 sets'
  let won = [0, 0]
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i]
    if (!Array.isArray(s) || s.length !== 2 || !s.every((x) => Number.isInteger(x) && x >= 0 && x <= 99)) return `set ${i + 1}: two scores`
    if (kind !== 'played') continue
    const target = points[i] ?? points[points.length - 1]
    const [a, b] = s
    const hi = Math.max(a, b)
    const lo = Math.min(a, b)
    if (hi < target || hi - lo < 2 || (hi > target && hi - lo !== 2)) return `set ${i + 1}: ${a}:${b} is not a finished set`
    won = a > b ? [won[0] + 1, won[1]] : [won[0], won[1] + 1]
    if ((won[0] === 2 || won[1] === 2) && i < sets.length - 1) return 'the match was over after the second set'
  }
  if (kind === 'played') {
    if (won[winner - 1] !== 2) return 'the winner must win two sets'
  }
  return null
}

/** The CSV of a draw's final ranking (MyBeach order: rank, team, players, licences, countries). */
export function rankingCsv (rows) {
  const q = (v) => {
    const s = v == null ? '' : String(v)
    return /[",;\n\r]|^[=+\-@\t]/.test(s) ? `"${s.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""')}"` : s
  }
  const head = ['Rank', 'Seed', 'Team', 'Player 1 last name', 'Player 1 first name', 'Player 1 licence', 'Player 1 country',
    'Player 2 last name', 'Player 2 first name', 'Player 2 licence', 'Player 2 country']
  const lines = [head.join(';')]
  for (const r of rows) {
    lines.push([r.final_rank, r.seed, r.name, r.player1?.last, r.player1?.first, r.player1?.licence, r.player1?.country,
      r.player2?.last, r.player2?.first, r.player2?.licence, r.player2?.country].map(q).join(';'))
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * @param {{ pool: import('pg').Pool, accounts: { audit: Function }, logger?: object, now?: () => number }} o
 */
export function createBeachTournaments ({ pool, accounts, logger = console, now = () => Date.now() } = {}) {
  const log = logger

  async function withTx (fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
      throw err
    } finally {
      client.release()
    }
  }
  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      if (err?.code === '23505' && /beach_tournaments_slug_key/.test(err.constraint || err.message || '')) {
        return fail(409, 'OV_SLUG_TAKEN', 'This web address is already taken')
      }
      if (err?.code === '23505' && /beach_courts_tournament_id_number_key/.test(err.constraint || '')) return invalid('courts: one number per court')
      // generate locks the tournament row, so this is a safety net: a retry gets the next free numbers
      if (err?.code === '23505' && /beach_tmatches_tournament_id_game_n_key/.test(err.constraint || '')) {
        return fail(409, 'OV_CONFLICT', 'Another change of this tournament came first; try again')
      }
      if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') return invalid(String(err.message || '').slice(0, 200))
      log.error?.(`[beach] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }
  const abort = (result) => Object.assign(new Error('abort'), { __result: result })
  const audit = (client, actorId, action, details) => accounts.audit(client, { actorId, action, details, app: 'beach' })

  // ------------------------------------------------------------------ access
  const flagsOf = (access) => accessForSport(access, 'beach')
  /** The tournament row (locked when `forUpdate`) and whether the caller edits it. */
  async function tournamentFor (client, id, user, access, { forUpdate = false } = {}) {
    if (!isUuid(id)) return null
    const { rows } = await client.query(
      `SELECT t.*, EXISTS (SELECT 1 FROM public.beach_tournament_managers m WHERE m.tournament_id = t.id AND m.user_id = $2) AS co
         FROM public.beach_tournaments t WHERE t.id = $1 ${forUpdate ? 'FOR UPDATE OF t' : ''}`, [id, user.id])
    const t = rows[0]
    if (!t) return null
    const f = flagsOf(access)
    t.can_edit = !!access?.isAdmin || (f.canManageTeams && (t.created_by === user.id || t.co === true))
    t.can_read = t.can_edit || (f.canReadTeams && t.status !== 'draft')
    return t
  }
  /** Loads and checks the tournament: 404 when it is unknown or unreadable, 403 when it may not be changed. */
  async function requireTournament (client, id, user, access, { edit = false, forUpdate = false } = {}) {
    const t = await tournamentFor(client, id, user, access, { forUpdate })
    if (!t || !t.can_read) throw abort(notFound())
    if (edit && !t.can_edit) throw abort(FORBIDDEN())
    return t
  }
  /** The tournament id of a draw / entry / tournament match (or null). */
  async function tournamentIdOf (client, kind, id) {
    if (!isUuid(id)) return null
    const sql = {
      draw: 'SELECT tournament_id FROM public.beach_draws WHERE id = $1',
      entry: 'SELECT d.tournament_id FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id WHERE e.id = $1',
      tmatch: 'SELECT tournament_id FROM public.beach_tmatches WHERE id = $1'
    }[kind]
    const { rows } = await client.query(sql, [id])
    return rows[0]?.tournament_id ?? null
  }
  async function requireVia (client, kind, id, user, access, opts) {
    const tid = await tournamentIdOf(client, kind, id)
    if (!tid) throw abort(notFound())
    return requireTournament(client, tid, user, access, opts)
  }

  // ------------------------------------------------------------------ shapes
  const tournamentOut = (t) => ({
    id: t.id,
    slug: t.slug,
    title: t.title,
    venue: t.venue ?? null,
    city: t.city ?? null,
    plus_code: t.plus_code ?? null,
    starts_on: day(t.starts_on),
    ends_on: day(t.ends_on),
    day_start: hhmm(t.day_start),
    day_end: hhmm(t.day_end),
    status: t.status,
    public: t.public === true,
    source: t.source,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    can_edit: t.can_edit === true
  })
  const drawOut = (d) => ({
    id: d.id,
    tournament_id: d.tournament_id,
    gender: d.gender,
    category: d.category,
    format: d.format,
    board_size: d.board_size ?? null,
    scoring: d.scoring,
    slot_minutes: d.slot_minutes,
    rest_minutes: d.rest_minutes,
    registration_end: iso(d.registration_end),
    coaching_allowed: d.coaching_allowed === true,
    sv_tournament_id: d.sv_tournament_id ?? null,
    status: d.status,
    created_at: iso(d.created_at)
  })
  const entryOut = (e) => ({
    id: e.id,
    draw_id: e.draw_id,
    seed: e.seed ?? null,
    team_id: e.team_id ?? null,
    name: e.name,
    player1: e.player1 || {},
    player2: e.player2 || {},
    sv_team_id: e.sv_team_id ?? null,
    wildcard: e.wildcard === true,
    late: e.late === true,
    status: e.status,
    final_rank: e.final_rank ?? null
  })
  const withoutLicence = (p) => ({ first: p?.first || '', last: p?.last || '', country: p?.country ?? null })
  const withoutLicences = (e) => ({ ...e, player1: withoutLicence(e.player1), player2: withoutLicence(e.player2) })
  const tmatchOut = (m) => ({
    id: m.id,
    draw_id: m.draw_id,
    game_n: m.game_n,
    code: m.code,
    phase: m.phase,
    round: m.round,
    position: m.position,
    wave: m.wave,
    source1: m.source1,
    source2: m.source2,
    entry1_id: m.entry1_id ?? null,
    entry2_id: m.entry2_id ?? null,
    winner_rank: m.winner_rank ?? null,
    loser_rank: m.loser_rank ?? null,
    court_id: m.court_id ?? null,
    scheduled_at: iso(m.scheduled_at),
    duration_min: m.duration_min ?? null,
    status: m.status,
    match_id: m.match_id ?? null,
    winner_entry_id: m.winner_entry_id ?? null,
    result: m.result ?? null,
    sets: m.sets ?? null,
    referee: m.referee ?? null,
    scorer: m.scorer ?? null
  })

  // ------------------------------------------------------------------ tournaments
  async function listTournaments ({ user, access }) {
    return guarded('list', async () => {
      const f = flagsOf(access)
      const { rows } = await pool.query(
        `SELECT t.*, ($2::boolean OR ($3::boolean AND (t.created_by = $1 OR EXISTS (
                  SELECT 1 FROM public.beach_tournament_managers m WHERE m.tournament_id = t.id AND m.user_id = $1)))) AS can_edit,
                (SELECT count(*)::int FROM public.beach_draws d WHERE d.tournament_id = t.id) AS draws
           FROM public.beach_tournaments t
          WHERE $2::boolean
             OR ($3::boolean AND (t.created_by = $1 OR EXISTS (
                  SELECT 1 FROM public.beach_tournament_managers m WHERE m.tournament_id = t.id AND m.user_id = $1)))
             OR t.status = ANY($4::text[])
          ORDER BY t.starts_on DESC, t.title
          LIMIT 300`,
        [user.id, !!access?.isAdmin, f.canManageTeams, LISTED_FOR_READERS])
      return ok({ tournaments: rows.map((t) => ({ ...tournamentOut(t), draws: t.draws })) })
    })
  }

  function tournamentFields (body, { partial }) {
    const f = fields()
    if (!isPlainObject(body)) return { error: invalid('body: must be an object') }
    f.set('title', text(body.title, 160, { required: !partial || has(body, 'title') }))
    if (has(body, 'slug') && body.slug !== null && body.slug !== '') {
      const s = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
      f.set('slug', SLUG_RE.test(s) && s.length >= 3 && s.length <= 80 ? { value: s } : { error: "3 to 80 of a-z, 0-9 and '-'" })
    }
    f.set('venue', text(body.venue, 160))
    f.set('city', text(body.city, 120))
    f.set('plus_code', text(body.plus_code, 40))
    for (const k of ['starts_on', 'ends_on']) {
      if (!partial || has(body, k)) f.set(k, validDay(body[k]) ? { value: body[k] } : { error: 'YYYY-MM-DD' })
    }
    for (const k of ['day_start', 'day_end']) {
      if (has(body, k)) f.set(k, minutesOf(body[k]) != null ? { value: String(body[k]).slice(0, 5) } : { error: 'HH:MM' })
    }
    f.set('public', bool(body.public))
    if (partial) f.set('status', oneOf(body.status, TOURNAMENT_STATUSES))
    // where it came from: typed in, or the Excel/CSV upload (T2); 'swissvolley' is the server's (T5)
    else f.set('source', oneOf(body.source, ['manual', 'xlsx']))
    if (f.error) return { error: f.error }
    return { out: f.out }
  }
  const datesError = (t) => {
    if (t.starts_on && t.ends_on) {
      if (t.ends_on < t.starts_on) return invalid('ends_on: on or after starts_on')
      if (daysBetween(t.starts_on, t.ends_on).length > 15) return invalid('ends_on: at most 14 days after starts_on')
    }
    if (t.day_start && t.day_end && minutesOf(t.day_end) <= minutesOf(t.day_start)) return invalid('day_end: after day_start')
    return null
  }

  async function createTournament ({ user, access, body }) {
    if (!flagsOf(access).canManageTeams) return FORBIDDEN()
    const { out, error } = tournamentFields(body, { partial: false })
    if (error) return error
    const de = datesError(out)
    if (de) return de
    let courts = 0
    if (has(body, 'courts')) {
      const c = intIn(body.courts, 0, 40)
      if (c.error) return invalid(`courts: ${c.error}`)
      courts = c.value
    }
    return guarded('create', () => withTx(async (client) => {
      let slug = out.slug
      if (!slug) {
        const base = slugify(`${out.title} ${out.starts_on.slice(0, 4)}`) || `tournament-${out.starts_on}`
        slug = base.length >= 3 ? base : `${base}-cup`
        const { rows } = await client.query("SELECT slug FROM public.beach_tournaments WHERE slug = $1 OR slug LIKE $1 || '-%'", [slug])
        const taken = new Set(rows.map((r) => r.slug))
        for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
      }
      const cols = ['slug', 'created_by', ...Object.keys(out).filter((k) => k !== 'slug')]
      const vals = [slug, user.id, ...cols.slice(2).map((k) => out[k])]
      const { rows: [t] } = await client.query(
        `INSERT INTO public.beach_tournaments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals)
      for (let n = 1; n <= courts; n++) {
        await client.query('INSERT INTO public.beach_courts (tournament_id, number) VALUES ($1, $2)', [t.id, n])
      }
      await audit(client, user.id, 'tournament.create', { tournament_id: t.id, slug: t.slug, title: t.title })
      return ok({ tournament: tournamentOut({ ...t, can_edit: true }) }, 201)
    }))
  }

  async function getTournament ({ user, access, id }) {
    return guarded('get', async () => {
      const t = await requireTournament(pool, id, user, access)
      const [courts, draws, entries, tmatches, managers] = await Promise.all([
        pool.query('SELECT * FROM public.beach_courts WHERE tournament_id = $1 ORDER BY number', [t.id]),
        pool.query('SELECT * FROM public.beach_draws WHERE tournament_id = $1 ORDER BY created_at, id', [t.id]),
        pool.query(`SELECT e.* FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id
                     WHERE d.tournament_id = $1 ORDER BY e.draw_id, e.seed NULLS LAST, e.created_at, e.id`, [t.id]),
        pool.query('SELECT * FROM public.beach_tmatches WHERE tournament_id = $1 ORDER BY game_n', [t.id]),
        t.can_edit
          ? pool.query(`SELECT u.id, u.email, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS name,
                               (u.id = $2) AS creator
                          FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id
                         WHERE u.id = $2 OR u.id IN (SELECT user_id FROM public.beach_tournament_managers WHERE tournament_id = $1)
                         ORDER BY (u.id = $2) DESC, u.email`, [t.id, t.created_by])
          : { rows: [] }
      ])
      return ok({
        tournament: tournamentOut(t),
        managers: managers.rows.map((m) => ({ id: m.id, email: m.email, name: m.name ?? null, creator: m.creator === true })),
        courts: courts.rows.map((c) => ({ id: c.id, number: c.number, name: c.name ?? null, active: c.active, flex: c.flex })),
        draws: draws.rows.map(drawOut),
        // licences only for editors (section 2: "ranking with licences: editors")
        entries: entries.rows.map((e) => (t.can_edit ? entryOut(e) : withoutLicences(entryOut(e)))),
        matches: tmatches.rows.map(tmatchOut)
      })
    })
  }

  async function updateTournament ({ user, access, id, body }) {
    const { out, error } = tournamentFields(body, { partial: true })
    if (error) return error
    return guarded('update', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const merged = { starts_on: day(t.starts_on), ends_on: day(t.ends_on), day_start: hhmm(t.day_start), day_end: hhmm(t.day_end), ...out }
      const de = datesError(merged)
      if (de) throw abort(de)
      const keys = Object.keys(out)
      if (!keys.length) return ok({ tournament: tournamentOut(t) })
      const { rows: [u] } = await client.query(
        `UPDATE public.beach_tournaments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [t.id, ...keys.map((k) => out[k])])
      await audit(client, user.id, 'tournament.update', { tournament_id: t.id, fields: keys, ...(out.status ? { status: out.status } : {}) })
      return ok({ tournament: tournamentOut({ ...u, can_edit: true }) })
    }))
  }

  async function deleteTournament ({ user, access, id }) {
    return guarded('delete', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const { rows } = await client.query(
        'SELECT 1 FROM public.beach_tmatches WHERE tournament_id = $1 AND (match_id IS NOT NULL OR status = ANY($2::text[])) LIMIT 1',
        [t.id, LOCKED_STATUSES])
      if (rows.length) throw abort(STARTED())
      await client.query('DELETE FROM public.beach_tournaments WHERE id = $1', [t.id])
      await audit(client, user.id, 'tournament.delete', { tournament_id: t.id, slug: t.slug, title: t.title })
      return ok({ id: t.id })
    }))
  }

  async function addManager ({ user, access, id, body }) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || email.length > 254) return invalid('email: an email address')
    return guarded('add-manager', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      // Only a beach competition manager (or the global admin) can be a co-manager;
      // anything else is the same 404, so the answer says nothing about other accounts.
      const { rows: [u] } = await client.query(
        `SELECT u.id FROM auth.users u JOIN public.profiles p ON p.user_id = u.id
          WHERE lower(u.email) = $1
            AND EXISTS (SELECT 1 FROM unnest(coalesce(p.roles, '{}'::text[])) r(role)
                         WHERE lower(trim(r.role)) IN ('beach:competition_manager', 'admin', 'super_admin'))`, [email])
      if (!u) throw abort(notFound('no OpenBeach competition manager with this email'))
      if (u.id !== t.created_by) {
        await client.query(
          'INSERT INTO public.beach_tournament_managers (tournament_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [t.id, u.id, user.id])
      }
      await audit(client, user.id, 'tournament.managers', { tournament_id: t.id, added: u.id })
      return ok({ id: u.id })
    }))
  }

  async function removeManager ({ user, access, id, userId }) {
    return guarded('remove-manager', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const r = await client.query('DELETE FROM public.beach_tournament_managers WHERE tournament_id = $1 AND user_id = $2', [t.id, userId])
      if (!r.rowCount) throw abort(notFound())
      await audit(client, user.id, 'tournament.managers', { tournament_id: t.id, removed: userId })
      return ok({ id: userId })
    }))
  }

  /** PUT courts: the full list [{ number, name, active, flex }]; courts left out are removed (their matches lose the court). */
  async function putCourts ({ user, access, id, body }) {
    const list = body?.courts
    if (!Array.isArray(list) || list.length > 40) return invalid('courts: a list of at most 40 courts')
    const courts = []
    for (const [i, c] of list.entries()) {
      if (!isPlainObject(c)) return invalid(`courts[${i}]: an object`)
      const f = fields()
      f.set('number', intIn(c.number, 1, 99))
      f.set('name', text(c.name, 60))
      f.set('active', bool(c.active))
      f.set('flex', bool(c.flex))
      if (f.error) return f.error
      if (f.out.number === undefined) return invalid(`courts[${i}].number: required`)
      courts.push(f.out)
    }
    if (new Set(courts.map((c) => c.number)).size !== courts.length) return invalid('courts: one number per court')
    return guarded('courts', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const numbers = courts.map((c) => c.number)
      await client.query('DELETE FROM public.beach_courts WHERE tournament_id = $1 AND NOT (number = ANY($2::int[]))', [t.id, numbers])
      for (const c of courts) {
        await client.query(
          `INSERT INTO public.beach_courts (tournament_id, number, name, active, flex) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tournament_id, number) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, flex = EXCLUDED.flex`,
          [t.id, c.number, c.name ?? null, c.active ?? true, c.flex ?? false])
      }
      await audit(client, user.id, 'tournament.update', { tournament_id: t.id, fields: ['courts'], courts: numbers.length })
      const { rows } = await client.query('SELECT * FROM public.beach_courts WHERE tournament_id = $1 ORDER BY number', [t.id])
      return ok({ courts: rows.map((c) => ({ id: c.id, number: c.number, name: c.name ?? null, active: c.active, flex: c.flex })) })
    }))
  }

  // ------------------------------------------------------------------ draws
  function drawFields (body, { partial }) {
    if (!isPlainObject(body)) return { error: invalid('body: must be an object') }
    const f = fields()
    if (!partial || has(body, 'gender')) f.set('gender', oneOf(body.gender ?? null, DRAW_GENDERS))
    f.set('category', text(body.category, 20, { required: !partial || has(body, 'category') }))
    if (has(body, 'format') && body.format !== 'DE') f.set('format', { error: 'DE (double elimination) only in this version' })
    if (has(body, 'board_size')) f.set('board_size', body.board_size === null ? { value: null } : oneOf(body.board_size, [8, 16, 32]))
    f.set('slot_minutes', intIn(body.slot_minutes, 10, 240))
    f.set('rest_minutes', intIn(body.rest_minutes, 0, 240))
    f.set('coaching_allowed', bool(body.coaching_allowed))
    if (has(body, 'registration_end')) {
      const v = body.registration_end
      f.set('registration_end', v === null || v === '' ? { value: null }
        : typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? { value: new Date(v).toISOString() } : { error: 'an ISO date-time or null' })
    }
    if (f.error) return { error: f.error }
    return { out: f.out }
  }

  async function createDraw ({ user, access, id, body }) {
    const { out, error } = drawFields(body, { partial: false })
    if (error) return error
    return guarded('create-draw', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const cols = Object.keys(out)
      const { rows: [d] } = await client.query(
        `INSERT INTO public.beach_draws (tournament_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [t.id, ...cols.map((k) => out[k])])
      await audit(client, user.id, 'tournament.draw', { tournament_id: t.id, draw_id: d.id, op: 'create', category: d.category, gender: d.gender })
      return ok({ draw: drawOut(d) }, 201)
    }))
  }

  async function lockDraw (client, drawId) {
    const { rows: [d] } = await client.query('SELECT * FROM public.beach_draws WHERE id = $1 FOR UPDATE', [drawId])
    if (!d) throw abort(notFound())
    return d
  }
  async function drawStarted (client, drawId) {
    const { rows } = await client.query(
      'SELECT 1 FROM public.beach_tmatches WHERE draw_id = $1 AND (match_id IS NOT NULL OR status = ANY($2::text[])) LIMIT 1',
      [drawId, LOCKED_STATUSES])
    return rows.length > 0
  }

  async function updateDraw ({ user, access, id, body }) {
    const { out, error } = drawFields(body, { partial: true })
    if (error) return error
    return guarded('update-draw', () => withTx(async (client) => {
      await requireVia(client, 'draw', id, user, access, { edit: true })
      const d = await lockDraw(client, id)
      const keys = Object.keys(out)
      if (!keys.length) return ok({ draw: drawOut(d) })
      // the category, gender and board of a drawn bracket stay (regenerate first)
      if (d.status !== 'entries' && d.status !== 'seeded' && keys.some((k) => ['gender', 'board_size'].includes(k))) {
        throw abort(fail(409, 'OV_DRAW_DRAWN', 'Reset the bracket first'))
      }
      const { rows: [u] } = await client.query(
        `UPDATE public.beach_draws SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => out[k])])
      await audit(client, user.id, 'tournament.draw', { tournament_id: d.tournament_id, draw_id: id, op: 'update', fields: keys })
      return ok({ draw: drawOut(u) })
    }))
  }

  async function deleteDraw ({ user, access, id }) {
    return guarded('delete-draw', () => withTx(async (client) => {
      await requireVia(client, 'draw', id, user, access, { edit: true })
      const d = await lockDraw(client, id)
      if (await drawStarted(client, id)) throw abort(STARTED())
      await client.query('DELETE FROM public.beach_draws WHERE id = $1', [id])
      await audit(client, user.id, 'tournament.draw', { tournament_id: d.tournament_id, draw_id: id, op: 'delete', category: d.category, gender: d.gender })
      return ok({ id })
    }))
  }

  // ------------------------------------------------------------------ entries
  /** The snapshot of a saved beach pair: { team, player1, player2 } or null. */
  async function savedPair (client, teamId) {
    const { rows: [team] } = await client.query(
      `SELECT ct.id, ct.name FROM public.competition_teams ct JOIN public.competitions c ON c.id = ct.competition_id
        WHERE ct.id = $1 AND c.sport = 'beach'`, [teamId])
    if (!team) return null
    const { rows: players } = await client.query(
      `SELECT first_name, last_name, license_number, country FROM public.competition_players
        WHERE team_id = $1 ORDER BY number NULLS LAST, sort_order, last_name LIMIT 2`, [teamId])
    const snap = (p) => (p ? { first: p.first_name || '', last: p.last_name, licence: p.license_number ?? null, country: p.country ?? null } : {})
    return { team, player1: snap(players[0]), player2: snap(players[1]) }
  }

  function entryFields (body, { partial }) {
    if (!isPlainObject(body)) return { error: invalid('body: must be an object') }
    const f = fields()
    if (!partial) {
      if (body.team_id != null && !isUuid(body.team_id)) f.set('team_id', { error: 'a saved pair id' })
      else if (body.team_id != null) f.set('team_id', { value: body.team_id.toLowerCase() })
    } else if (has(body, 'team_id')) f.set('team_id', { error: 'cannot be changed' })
    f.set('name', text(body.name, 120))
    for (const k of ['player1', 'player2']) if (has(body, k)) f.set(k, playerField(body[k]))
    f.set('seed', intIn(body.seed, 1, 128, { nullable: true }))
    f.set('wildcard', bool(body.wildcard))
    f.set('late', bool(body.late))
    if (partial) f.set('status', oneOf(body.status, ENTRY_STATUSES))
    if (f.error) return { error: f.error }
    if (!partial && !f.out.team_id && !(f.out.player1 && f.out.player2)) return { error: invalid('team_id, or player1 and player2') }
    return { out: f.out }
  }

  async function createEntry ({ user, access, id, body }) {
    const { out, error } = entryFields(body, { partial: false })
    if (error) return error
    return guarded('create-entry', () => withTx(async (client) => {
      await requireVia(client, 'draw', id, user, access, { edit: true })
      const d = await lockDraw(client, id)
      if (!['entries', 'seeded'].includes(d.status)) throw abort(fail(409, 'OV_DRAW_DRAWN', 'Reset the bracket first'))
      const row = { ...out }
      if (out.team_id) {
        const pair = await savedPair(client, out.team_id)
        if (!pair) throw abort(invalid('team_id: not a saved beach pair'))
        const dup = await client.query("SELECT 1 FROM public.beach_entries WHERE draw_id = $1 AND team_id = $2 AND status = 'registered'", [id, out.team_id])
        if (dup.rows.length) throw abort(fail(409, 'OV_ENTRY_EXISTS', 'This pair is already entered'))
        row.player1 = out.player1 ?? pair.player1
        row.player2 = out.player2 ?? pair.player2
        row.name = out.name ?? pair.team.name
      }
      row.name = row.name ?? pairName(row.player1, row.player2)
      if (row.seed != null) {
        const taken = await client.query('SELECT 1 FROM public.beach_entries WHERE draw_id = $1 AND seed = $2', [id, row.seed])
        if (taken.rows.length) throw abort(invalid('seed: already taken'))
      }
      const cols = Object.keys(row)
      const vals = cols.map((k) => (k === 'player1' || k === 'player2' ? JSON.stringify(row[k]) : row[k]))
      const { rows: [e] } = await client.query(
        `INSERT INTO public.beach_entries (draw_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [id, ...vals])
      await audit(client, user.id, 'tournament.entry', { tournament_id: d.tournament_id, draw_id: id, entry_id: e.id, op: 'create', name: e.name })
      return ok({ entry: entryOut(e) }, 201)
    }))
  }

  async function updateEntry ({ user, access, id, body }) {
    const { out, error } = entryFields(body, { partial: true })
    if (error) return error
    return guarded('update-entry', () => withTx(async (client) => {
      await requireVia(client, 'entry', id, user, access, { edit: true })
      const { rows: [cur] } = await client.query('SELECT * FROM public.beach_entries WHERE id = $1', [id])
      const d = await lockDraw(client, cur.draw_id)
      const keys = Object.keys(out)
      if (!keys.length) return ok({ entry: entryOut(cur) })
      // once drawn: names may be corrected; seeds and withdrawals go through a new draw
      if (!['entries', 'seeded'].includes(d.status) && keys.some((k) => ['seed', 'status'].includes(k))) {
        throw abort(fail(409, 'OV_DRAW_DRAWN', 'Reset the bracket first'))
      }
      if (out.seed != null) {
        const taken = await client.query('SELECT 1 FROM public.beach_entries WHERE draw_id = $1 AND seed = $2 AND id <> $3', [cur.draw_id, out.seed, id])
        if (taken.rows.length) throw abort(invalid('seed: already taken'))
      }
      // a pair that is no longer registered gives up its seed
      if (out.status && out.status !== 'registered' && !keys.includes('seed')) {
        out.seed = null
        keys.push('seed')
      }
      const vals = keys.map((k) => (k === 'player1' || k === 'player2' ? JSON.stringify(out[k]) : out[k]))
      const { rows: [e] } = await client.query(
        `UPDATE public.beach_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals])
      await audit(client, user.id, 'tournament.entry', { tournament_id: d.tournament_id, draw_id: d.id, entry_id: id, op: 'update', fields: keys })
      return ok({ entry: entryOut(e) })
    }))
  }

  async function deleteEntry ({ user, access, id }) {
    return guarded('delete-entry', () => withTx(async (client) => {
      await requireVia(client, 'entry', id, user, access, { edit: true })
      const { rows: [cur] } = await client.query('SELECT * FROM public.beach_entries WHERE id = $1', [id])
      const d = await lockDraw(client, cur.draw_id)
      if (!['entries', 'seeded'].includes(d.status)) throw abort(fail(409, 'OV_DRAW_DRAWN', 'Reset the bracket first'))
      await client.query('DELETE FROM public.beach_entries WHERE id = $1', [id])
      await audit(client, user.id, 'tournament.entry', { tournament_id: d.tournament_id, draw_id: d.id, entry_id: id, op: 'delete', name: cur.name })
      return ok({ id })
    }))
  }

  /** PUT seeds { order: [entryId, ...] }: seeds 1..n in this order; the other registered entries lose their seed. */
  async function putSeeds ({ user, access, id, body }) {
    const order = body?.order
    if (!Array.isArray(order) || order.length > 128 || !order.every(isUuid) || new Set(order).size !== order.length) {
      return invalid('order: entry ids, each once')
    }
    return guarded('seeds', () => withTx(async (client) => {
      await requireVia(client, 'draw', id, user, access, { edit: true })
      const d = await lockDraw(client, id)
      if (!['entries', 'seeded'].includes(d.status)) throw abort(fail(409, 'OV_DRAW_DRAWN', 'Reset the bracket first'))
      const { rows } = await client.query("SELECT id FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered'", [id])
      const known = new Set(rows.map((r) => r.id))
      const ids = order.map((x) => x.toLowerCase())
      if (!ids.every((x) => known.has(x))) throw abort(invalid('order: registered entries of this draw only'))
      await client.query('UPDATE public.beach_entries SET seed = NULL WHERE draw_id = $1', [id])
      for (const [i, eid] of ids.entries()) await client.query('UPDATE public.beach_entries SET seed = $2 WHERE id = $1', [eid, i + 1])
      await client.query("UPDATE public.beach_draws SET status = 'seeded' WHERE id = $1 AND status = 'entries'", [id])
      await audit(client, user.id, 'tournament.entry', { tournament_id: d.tournament_id, draw_id: id, op: 'seeds', count: ids.length })
      return ok({ seeded: ids.length })
    }))
  }

  // ------------------------------------------------------------------ the bracket
  /**
   * POST generate { dryRun?, board_size? }: the double-elimination bracket of
   * the draw's registered entries in seed order (unseeded ones after, by entry
   * time). dryRun answers the bracket and the warnings and writes nothing.
   * Writing replaces the draw's matches (only before any of them began),
   * freezes the seeds and refreshes the pairs' player snapshots from the
   * saved pairs. Game numbers continue after the tournament's other draws.
   */
  async function generate ({ user, access, id, body }) {
    const dryRun = body?.dryRun === true
    let boardSize
    if (body?.board_size != null) {
      if (![8, 16, 32].includes(body.board_size)) return invalid('board_size: 8, 16 or 32')
      boardSize = body.board_size
    }
    return guarded('generate', () => withTx(async (client) => {
      // the tournament row first: game numbers continue after its other draws,
      // so two draws of one tournament are generated one after the other
      const t = await requireVia(client, 'draw', id, user, access, { edit: true, forUpdate: true })
      const d = await lockDraw(client, id)
      if (await drawStarted(client, id)) throw abort(STARTED())
      const { rows: entries } = await client.query(
        "SELECT * FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered' ORDER BY seed NULLS LAST, created_at, id", [id])
      const n = entries.length
      if (n < DE_MIN_TEAMS || n > DE_MAX_TEAMS) throw abort(fail(409, 'OV_DRAW_SIZE', `A double elimination needs ${DE_MIN_TEAMS} to ${DE_MAX_TEAMS} pairs`, { teams: n }))
      if (boardSize != null && boardSize < n) throw abort(invalid(`board_size: too small for ${n} pairs`))
      // board_size on the draw is the manager's choice (PATCH or this body),
      // never the size a previous generate derived; a stored choice that no
      // longer fits (late pairs) gives way to the smallest board that does
      const chosen = boardSize ?? (d.board_size != null && d.board_size >= n ? d.board_size : null)
      const size = chosen ?? boardSizeFor(n)
      const bracket = doubleElimination(n, { boardSize: size })
      const { rows: [{ courts }] } = await client.query('SELECT count(*)::int AS courts FROM public.beach_courts WHERE tournament_id = $1 AND active', [t.id])
      const warnings = drawWarnings({ teams: n, category: d.category, courts, boardSize: size })
      const { rows: [{ base }] } = await client.query(
        'SELECT coalesce(max(game_n), 0)::int AS base FROM public.beach_tmatches WHERE tournament_id = $1 AND draw_id <> $2', [t.id, id])
      const seeds = entries.map((e, i) => ({ id: e.id, seed: i + 1, name: e.name }))
      const preview = {
        board_size: size,
        teams: n,
        warnings,
        seeds,
        matches: bracket.matches.map((m) => ({ ...m, game_n: base + m.n }))
      }
      if (dryRun) return ok(preview)

      await writeBracket(client, { t, d, entries, matches: preview.matches, chosen })
      await audit(client, user.id, 'tournament.draw', { tournament_id: t.id, draw_id: id, op: 'generate', teams: n, board_size: size })
      return ok(preview)
    }))
  }

  /**
   * Writes a draw's bracket (inside the caller's transaction, the tournament
   * and the draw locked; generate and the import): replaces the draw's
   * matches with `matches` (doubleElimination's, with their game numbers),
   * seeds `entries` (the registered pairs) 1..n in their order, refreshes
   * their player snapshots from the saved pairs, stores `chosen` (the board
   * the manager chose, or null) and recomputes the draw.
   */
  async function writeBracket (client, { t, d, entries, matches, chosen }) {
    await client.query('DELETE FROM public.beach_tmatches WHERE draw_id = $1', [d.id])
    // only registered pairs keep a seed (a withdrawn one must not hold 1..n)
    await client.query("UPDATE public.beach_entries SET seed = NULL WHERE draw_id = $1 AND status <> 'registered' AND seed IS NOT NULL", [d.id])
    for (const [i, e] of entries.entries()) {
      let snap = {}
      if (e.team_id) {
        const pair = await savedPair(client, e.team_id)
        if (pair) snap = { player1: pair.player1, player2: pair.player2 }
      }
      await client.query(
        `UPDATE public.beach_entries SET seed = $2, final_rank = NULL,
                player1 = coalesce($3::jsonb, player1), player2 = coalesce($4::jsonb, player2) WHERE id = $1`,
        [e.id, i + 1, snap.player1 ? JSON.stringify(snap.player1) : null, snap.player2 ? JSON.stringify(snap.player2) : null])
    }
    for (const m of matches) {
      await client.query(
        `INSERT INTO public.beach_tmatches (tournament_id, draw_id, game_n, code, phase, round, position, wave,
                                            source1, source2, winner_rank, loser_rank, duration_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [t.id, d.id, m.game_n, m.code, m.phase, m.round, m.position, m.wave, m.source1, m.source2, m.winner_rank, m.loser_rank, d.slot_minutes])
    }
    await client.query("UPDATE public.beach_draws SET status = 'drawn', board_size = $2 WHERE id = $1", [d.id, chosen])
    await recompute(client, d.id)
  }

  // ------------------------------------------------------------------ import (T2)
  /**
   * POST /api/beach/tournaments/:id/import[?dryRun=1] { entries?, matches?, hash? }
   * (plan 3.4, phase T2; lib/beachImport.js). With dryRun the answer is the
   * plan (per row OK / warning / error, the diff) and its hash, and nothing
   * is written. Without it the plan is made again with the tournament and
   * its draws locked and applied only when its hash is the one the preview
   * showed (409 OV_IMPORT_CHANGED { preview } otherwise: the file or the
   * tournament changed meanwhile) and no row has an error (400
   * OV_IMPORT_INVALID { preview }). Editors only.
   */
  async function importTournament ({ user, access, id, body, query }) {
    const dryRun = ['1', 'true'].includes(String(query?.get?.('dryRun') ?? '').toLowerCase())
    const input = normalizeImport(body)
    if (input.error) return invalid(input.error)
    const hash = body.hash
    if (!dryRun && (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) return invalid('hash: the hash of the preview (?dryRun=1)')
    return guarded('import', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: !dryRun })
      const plan = planImport(await importState(client, t, input, { lock: !dryRun }), input)
      const preview = { ...plan, hash: importHash(plan) }
      if (dryRun) return ok(preview)
      if (preview.hash !== hash) throw abort(fail(409, 'OV_IMPORT_CHANGED', 'The tournament or the file changed since the preview', { preview }))
      if (plan.summary.errors) throw abort(fail(400, 'OV_IMPORT_INVALID', 'Some rows have errors', { preview }))
      if (plan.can_apply) await applyImport(client, t, plan, user)
      return ok({ applied: plan.summary, hash: preview.hash })
    }))
  }

  /** The tournament as lib/beachImport.js planImport() reads it (ordered lists; locked for the apply). */
  async function importState (client, t, input, { lock }) {
    const forUpdate = lock ? ' FOR UPDATE' : ''
    const { rows: draws } = await client.query(
      `SELECT id, category, gender, status, board_size, slot_minutes, rest_minutes FROM public.beach_draws
        WHERE tournament_id = $1 ORDER BY created_at, id${forUpdate}`, [t.id])
    const { rows: entries } = await client.query(
      `SELECT e.id, e.draw_id, e.seed, e.team_id, e.name, e.player1, e.player2, e.wildcard, e.status
         FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id
        WHERE d.tournament_id = $1 ORDER BY e.created_at, e.id`, [t.id])
    const { rows: courts } = await client.query('SELECT id, number FROM public.beach_courts WHERE tournament_id = $1 ORDER BY number', [t.id])
    const { rows: matches } = await client.query(
      `SELECT id, draw_id, game_n, code, phase, source1, source2, entry1_id, entry2_id, court_id, scheduled_at,
              duration_min, status, match_id, referee, scorer
         FROM public.beach_tmatches WHERE tournament_id = $1 ORDER BY game_n${forUpdate}`, [t.id])
    // saved beach pairs (db/009) with a licence of the file: a new pair with
    // exactly their two licences is linked to them
    const licences = [...new Set(input.entries.flatMap((r) => [r.p1?.licence, r.p2?.licence]).map(fold).filter(Boolean))]
    let savedPairs = []
    if (licences.length) {
      const { rows } = await client.query(
        `SELECT ct.id, ct.name, c.season, array_agg(cp.license_number ORDER BY cp.license_number) AS licences
           FROM public.competition_teams ct
           JOIN public.competitions c ON c.id = ct.competition_id AND c.sport = 'beach'
           JOIN public.competition_players cp ON cp.team_id = ct.id
          WHERE ct.id IN (SELECT team_id FROM public.competition_players
                           WHERE lower(regexp_replace(coalesce(license_number, ''), '[^a-zA-Z0-9]', '', 'g')) = ANY($1::text[]))
          GROUP BY ct.id, ct.name, c.season
         HAVING count(*) = 2 AND count(cp.license_number) = 2
          ORDER BY ct.id`, [licences])
      savedPairs = rows
    }
    return { tournament: { id: t.id, ...tournamentClock(t) }, draws, entries, courts, matches, savedPairs }
  }

  /** Applies a plan of planImport() (inside the caller's transaction, the tournament locked). */
  async function applyImport (client, t, plan, user) {
    const conflict = () => abort(fail(409, 'OV_CONFLICT', 'Another change of this tournament came first; try again'))
    for (const c of plan.courts) {
      await client.query('INSERT INTO public.beach_courts (tournament_id, number) VALUES ($1, $2)', [t.id, c.number])
    }
    const drawIdOf = new Map(plan.draws.filter((d) => d.draw_id).map((d) => [d.key, d.draw_id]))
    for (const d of plan.draws) {
      if (d.op !== 'new') continue
      const { rows: [row] } = await client.query(
        'INSERT INTO public.beach_draws (tournament_id, category, gender) VALUES ($1, $2, $3) RETURNING id', [t.id, d.category, d.gender])
      drawIdOf.set(d.key, row.id)
    }
    const json = (k, v) => (k === 'player1' || k === 'player2' ? JSON.stringify(v) : v)
    const touched = new Set()
    for (const e of plan.entries) {
      const drawId = drawIdOf.get(e.key)
      touched.add(drawId)
      if (e.op === 'new') {
        const v = e.values
        await client.query(
          `INSERT INTO public.beach_entries (draw_id, name, seed, wildcard, team_id, player1, player2)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [drawId, v.name, v.seed, v.wildcard, v.team_id, JSON.stringify(v.player1), JSON.stringify(v.player2)])
      } else if (e.op === 'removed') {
        await client.query("UPDATE public.beach_entries SET status = 'withdrawn', seed = NULL WHERE id = $1", [e.entry_id])
      } else if (e.op === 'changed') {
        const keys = e.changes.map((c) => c.field)
        await client.query(
          `UPDATE public.beach_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [e.entry_id, ...e.changes.map((c) => json(c.field, c.to))])
      }
    }
    for (const drawId of touched) {
      await client.query(
        `UPDATE public.beach_draws SET status = 'seeded' WHERE id = $1 AND status = 'entries'
            AND EXISTS (SELECT 1 FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered' AND seed IS NOT NULL)`, [drawId])
    }
    // the brackets of the Matches sheet, in the plan's order (its game numbers)
    for (const d of plan.draws) {
      if (!d.bracket) continue
      const draw = await lockDraw(client, drawIdOf.get(d.key))
      const { rows: entries } = await client.query(
        "SELECT * FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered' ORDER BY seed NULLS LAST, created_at, id", [draw.id])
      if (entries.length !== d.bracket.teams || entries.some((e, i) => e.seed !== i + 1)) throw conflict()
      const bracket = doubleElimination(entries.length, { boardSize: d.bracket.board_size })
      const matches = bracket.matches.map((m) => ({ ...m, game_n: d.bracket.first_game - 1 + m.n }))
      const chosen = draw.board_size != null && draw.board_size >= entries.length ? draw.board_size : null
      await writeBracket(client, { t, d: draw, entries, matches, chosen })
    }
    if (plan.matches.length) {
      const { rows: games } = await client.query('SELECT id, game_n FROM public.beach_tmatches WHERE tournament_id = $1', [t.id])
      const { rows: courts } = await client.query('SELECT id, number FROM public.beach_courts WHERE tournament_id = $1', [t.id])
      const gameId = new Map(games.map((g) => [g.game_n, g.id]))
      const courtId = new Map(courts.map((c) => [c.number, c.id]))
      for (const m of plan.matches) {
        const id = gameId.get(m.game_n)
        if (!id) throw conflict()
        const set = {}
        if (m.set.court != null) set.court_id = courtId.get(m.set.court)
        if (m.set.scheduled_at) set.scheduled_at = m.set.scheduled_at
        if (m.set.referee) set.referee = m.set.referee
        if (m.set.scorer) set.scorer = m.set.scorer
        const keys = Object.keys(set)
        if (!keys.length) continue
        await client.query(
          `UPDATE public.beach_tmatches SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => set[k])])
      }
    }
    const s = plan.summary
    await audit(client, user.id, 'tournament.import', {
      tournament_id: t.id,
      title: t.title,
      draws_new: s.draws_new,
      entries_new: s.entries_new,
      entries_changed: s.entries_changed,
      entries_removed: s.entries_removed,
      brackets: s.brackets,
      matches_changed: s.matches_changed,
      courts_new: s.courts_new
    })
  }

  /** DELETE bracket: back to entries (only before any match began). */
  async function resetBracket ({ user, access, id }) {
    return guarded('reset', () => withTx(async (client) => {
      const t = await requireVia(client, 'draw', id, user, access, { edit: true })
      await lockDraw(client, id)
      if (await drawStarted(client, id)) throw abort(STARTED())
      await client.query('DELETE FROM public.beach_tmatches WHERE draw_id = $1', [id])
      await client.query('UPDATE public.beach_entries SET final_rank = NULL WHERE draw_id = $1', [id])
      await client.query("UPDATE public.beach_draws SET status = 'seeded' WHERE id = $1", [id])
      await audit(client, user.id, 'tournament.draw', { tournament_id: t.id, draw_id: id, op: 'reset' })
      return ok({ id })
    }))
  }

  /**
   * Recompute a draw from its results (inside the caller's transaction, the
   * draw locked): the teams of every match, 'ready' / 'scheduled' for the
   * matches that have not begun, the final ranks, the draw's status.
   * Returns the codes whose teams would change although they have begun
   * (the caller refuses then).
   */
  async function recompute (client, drawId, { check = false } = {}) {
    const { rows: entries } = await client.query("SELECT id, seed FROM public.beach_entries WHERE draw_id = $1 AND seed IS NOT NULL AND status = 'registered'", [drawId])
    const { rows: list } = await client.query('SELECT * FROM public.beach_tmatches WHERE draw_id = $1 ORDER BY game_n FOR UPDATE', [drawId])
    const seeds = new Map(entries.map((e) => [e.seed, e.id]))
    const results = new Map()
    const conflicts = []
    const updates = []
    for (const m of list) {
      const e1 = entryOfSource(m.source1, { seeds, results })
      const e2 = entryOfSource(m.source2, { seeds, results })
      const begun = LOCKED_STATUSES.includes(m.status) || m.match_id != null
      if (begun && (e1 !== m.entry1_id || e2 !== m.entry2_id)) conflicts.push(m.code)
      if ((m.status === 'finished' || m.status === 'walkover') && m.winner_entry_id && e1 && e2) {
        const winner = m.winner_entry_id === e1 || m.winner_entry_id === e2 ? m.winner_entry_id : null
        if (winner) results.set(m.code, { winner, loser: winner === e1 ? e2 : e1 })
      }
      const status = OPEN_STATUSES.includes(m.status) ? (e1 && e2 ? 'ready' : 'scheduled') : m.status
      if (e1 !== m.entry1_id || e2 !== m.entry2_id || status !== m.status) updates.push({ id: m.id, e1, e2, status })
    }
    if (check) return conflicts
    for (const u of updates) {
      await client.query('UPDATE public.beach_tmatches SET entry1_id = $2, entry2_id = $3, status = $4 WHERE id = $1', [u.id, u.e1, u.e2, u.status])
    }
    // final ranks
    await client.query('UPDATE public.beach_entries SET final_rank = NULL WHERE draw_id = $1 AND final_rank IS NOT NULL', [drawId])
    for (const m of list) {
      const r = results.get(m.code)
      if (!r) continue
      if (m.winner_rank) await client.query('UPDATE public.beach_entries SET final_rank = $2 WHERE id = $1', [r.winner, m.winner_rank])
      if (m.loser_rank) await client.query('UPDATE public.beach_entries SET final_rank = $2 WHERE id = $1', [r.loser, m.loser_rank])
    }
    // done only when every match has a result (the 3rd place too, not just the
    // final): the ranking is complete only then
    const status = list.length === 0 ? null : list.every((m) => results.has(m.code)) ? 'done' : results.size > 0 ? 'playing' : 'drawn'
    if (status) await client.query('UPDATE public.beach_draws SET status = $2 WHERE id = $1 AND status <> $2', [drawId, status])
    return conflicts
  }

  /** The matches that use this match's winner or loser and have already begun. */
  function lockedDependents (list, code) {
    const refs = new Set([`winner:${code}`, `loser:${code}`])
    return list.filter((m) => (refs.has(m.source1) || refs.has(m.source2)) && (LOCKED_STATUSES.includes(m.status) || m.match_id != null))
      .map((m) => m.code)
  }

  /** Whether the stored result differs from `expect` (only the keys given are compared). */
  function changedSince (m, expect) {
    const cur = { winner_entry_id: m.winner_entry_id ?? null, result: m.result ?? null, sets: m.sets ?? null }
    if (has(expect, 'winner_entry_id') && (expect.winner_entry_id?.toLowerCase() ?? null) !== cur.winner_entry_id) return true
    if (has(expect, 'result') && expect.result !== cur.result) return true
    if (has(expect, 'sets') && JSON.stringify(expect.sets ?? null) !== JSON.stringify(cur.sets)) return true
    return false
  }

  /**
   * POST result { winner: 1|2, result: played|retired|forfeit|walkover, sets?, expect? }
   * (1 = entry1). A new result or a correction; refused when a match that
   * uses this one's winner or loser has begun. `expect` { winner_entry_id,
   * result, sets } is the result the caller's screen showed (all null for a
   * first entry): 409 OV_RESULT_CHANGED when the stored one differs.
   */
  async function enterResult ({ user, access, id, body }) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const winner = body.winner
    if (winner !== 1 && winner !== 2) return invalid('winner: 1 or 2')
    const kind = body.result ?? 'played'
    if (!RESULT_KINDS.includes(kind)) return invalid(`result: ${RESULT_KINDS.join(', ')}`)
    const expect = body.expect
    if (expect !== undefined) {
      if (!isPlainObject(expect)) return invalid('expect: an object { winner_entry_id, result, sets }')
      if (has(expect, 'winner_entry_id') && expect.winner_entry_id !== null && !isUuid(expect.winner_entry_id)) return invalid('expect.winner_entry_id: an entry id or null')
      if (has(expect, 'result') && expect.result !== null && !RESULT_KINDS.includes(expect.result)) return invalid(`expect.result: ${RESULT_KINDS.join(', ')} or null`)
      if (has(expect, 'sets') && expect.sets !== null && !Array.isArray(expect.sets)) return invalid('expect.sets: a list or null')
    }
    return guarded('result', () => withTx(async (client) => {
      const t = await requireVia(client, 'tmatch', id, user, access, { edit: true })
      const { rows: [m0] } = await client.query('SELECT draw_id FROM public.beach_tmatches WHERE id = $1', [id])
      const d = await lockDraw(client, m0.draw_id)
      const err = setsError(body.sets ?? null, winner, kind, Array.isArray(d.scoring?.points) ? d.scoring.points : undefined)
      if (err) throw abort(invalid(`sets: ${err}`))
      const { rows: list } = await client.query('SELECT * FROM public.beach_tmatches WHERE draw_id = $1 ORDER BY game_n FOR UPDATE', [d.id])
      const m = list.find((x) => x.id === id)
      if (!m.entry1_id || !m.entry2_id) throw abort(fail(409, 'OV_MATCH_NOT_READY', 'Both teams of this match are not known yet'))
      if (m.match_id) throw abort(fail(409, 'OV_MATCH_LINKED', 'This match is scored on a court tablet'))
      // the result the caller last saw (optional): someone else's result
      // entered meanwhile is never overwritten silently
      if (expect !== undefined && changedSince(m, expect)) {
        throw abort(fail(409, 'OV_RESULT_CHANGED', 'The result of this match was changed meanwhile', { match: tmatchOut(m) }))
      }
      const winnerId = winner === 1 ? m.entry1_id : m.entry2_id
      const wasEnded = m.status === 'finished' || m.status === 'walkover'
      if (wasEnded && m.winner_entry_id !== winnerId) {
        const locked = lockedDependents(list, m.code)
        if (locked.length) throw abort(LOCKED({ matches: locked }))
      }
      const sets = kind === 'walkover' ? null : (body.sets ?? null)
      await client.query(
        `UPDATE public.beach_tmatches SET status = $2, result = $3, winner_entry_id = $4, sets = $5::jsonb WHERE id = $1`,
        [id, kind === 'walkover' ? 'walkover' : 'finished', kind, winnerId, sets ? JSON.stringify(sets) : null])
      const conflicts = await recompute(client, d.id, { check: true })
      if (conflicts.length) throw abort(LOCKED({ matches: conflicts }))
      await recompute(client, d.id)
      await audit(client, user.id, 'tournament.result', {
        tournament_id: t.id, draw_id: d.id, tmatch_id: id, game_n: m.game_n, code: m.code, result: kind, winner, sets, corrected: wasEnded
      })
      const { rows: [u] } = await client.query('SELECT * FROM public.beach_tmatches WHERE id = $1', [id])
      return ok({ match: tmatchOut(u) })
    }))
  }

  /** DELETE result: the match is open again (refused when a dependent match has begun). */
  async function withdrawResult ({ user, access, id }) {
    return guarded('withdraw', () => withTx(async (client) => {
      const t = await requireVia(client, 'tmatch', id, user, access, { edit: true })
      const { rows: [m0] } = await client.query('SELECT draw_id FROM public.beach_tmatches WHERE id = $1', [id])
      const d = await lockDraw(client, m0.draw_id)
      const { rows: list } = await client.query('SELECT * FROM public.beach_tmatches WHERE draw_id = $1 ORDER BY game_n FOR UPDATE', [d.id])
      const m = list.find((x) => x.id === id)
      if (m.status !== 'finished' && m.status !== 'walkover') throw abort(fail(409, 'OV_NO_RESULT', 'This match has no result'))
      if (m.match_id) throw abort(fail(409, 'OV_MATCH_LINKED', 'This match is scored on a court tablet'))
      const locked = lockedDependents(list, m.code)
      if (locked.length) throw abort(LOCKED({ matches: locked }))
      await client.query("UPDATE public.beach_tmatches SET status = 'ready', result = NULL, winner_entry_id = NULL, sets = NULL WHERE id = $1", [id])
      await recompute(client, d.id)
      await audit(client, user.id, 'tournament.result', { tournament_id: t.id, draw_id: d.id, tmatch_id: id, game_n: m.game_n, code: m.code, withdrawn: true })
      const { rows: [u] } = await client.query('SELECT * FROM public.beach_tmatches WHERE id = $1', [id])
      return ok({ match: tmatchOut(u) })
    }))
  }

  /** PATCH a tournament match: { court_id, scheduled_at, duration_min, referee, scorer } (slot moves only before it begins). */
  async function updateTmatch ({ user, access, id, body }) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const f = fields()
    if (has(body, 'court_id')) f.set('court_id', body.court_id === null ? { value: null } : isUuid(body.court_id) ? { value: body.court_id.toLowerCase() } : { error: 'a court id or null' })
    if (has(body, 'scheduled_at')) {
      const v = body.scheduled_at
      f.set('scheduled_at', v === null ? { value: null } : typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? { value: new Date(v).toISOString() } : { error: 'an ISO date-time or null' })
    }
    f.set('duration_min', intIn(body.duration_min, 10, 240))
    f.set('referee', text(body.referee, 120))
    f.set('scorer', text(body.scorer, 120))
    if (body.force !== undefined && typeof body.force !== 'boolean') return invalid('force: true or false')
    if (f.error) return f.error
    const keys = Object.keys(f.out)
    const force = body.force === true
    return guarded('update-tmatch', () => withTx(async (client) => {
      // the tournament row is locked so two moves cannot both take the same free slot
      const t = await requireVia(client, 'tmatch', id, user, access, { edit: true, forUpdate: true })
      const { rows: [m] } = await client.query('SELECT * FROM public.beach_tmatches WHERE id = $1 FOR UPDATE', [id])
      if (!keys.length) return ok({ match: tmatchOut(m) })
      const slotKeys = keys.filter((k) => ['court_id', 'scheduled_at', 'duration_min'].includes(k))
      if (slotKeys.length && !['scheduled', 'ready', 'called'].includes(m.status)) throw abort(fail(409, 'OV_MATCH_BEGUN', 'This match has already begun'))
      if (f.out.court_id) {
        const c = await client.query('SELECT 1 FROM public.beach_courts WHERE id = $1 AND tournament_id = $2', [f.out.court_id, t.id])
        if (!c.rows.length) throw abort(invalid('court_id: a court of this tournament'))
      }
      // only a slot being set is checked (clearing a court or a time never is)
      const placing = !!f.out.court_id || !!f.out.scheduled_at || f.out.duration_min !== undefined
      if (placing && !force) {
        const conflicts = await slotConflicts(client, t, { ...m, ...f.out })
        if (conflicts.length) {
          throw abort(fail(409, 'OV_SLOT_CONFLICT', 'This slot clashes with the schedule; send force: true to keep it anyway', { conflicts }))
        }
      }
      const { rows: [u] } = await client.query(
        `UPDATE public.beach_tmatches SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => f.out[k])])
      await audit(client, user.id, 'tournament.schedule', { tournament_id: t.id, tmatch_id: id, game_n: m.game_n, fields: keys, ...(force && slotKeys.length ? { forced: true } : {}) })
      return ok({ match: tmatchOut(u) })
    }))
  }

  /**
   * What a slot (court, start, duration) of tournament match `m` clashes
   * with: [{ reason, game_n?, code? }], reason one of
   *   court            another match on the same court at the same time
   *   days             not on a day of the tournament
   *   hours            outside the play hours (day_start .. day_end, Zurich)
   *   before_source    before a match it waits for has ended plus the rest
   *   after_dependent  a match that waits for this one starts before it has ended plus the rest
   * Only matches that have a start time count. The same rules as
   * lib/beachSchedule.js, so a hand move cannot put a pair on two courts at once.
   */
  async function slotConflicts (client, t, m) {
    if (!m.scheduled_at) return []
    const { rows: [d] } = await client.query('SELECT slot_minutes, rest_minutes FROM public.beach_draws WHERE id = $1', [m.draw_id])
    const { rows: others } = await client.query(
      `SELECT x.id, x.draw_id, x.code, x.game_n, x.court_id, x.scheduled_at, x.source1, x.source2,
              coalesce(x.duration_min, dd.slot_minutes) AS dur
         FROM public.beach_tmatches x JOIN public.beach_draws dd ON dd.id = x.draw_id
        WHERE x.tournament_id = $1 AND x.id <> $2 AND x.scheduled_at IS NOT NULL AND x.status <> 'cancelled'
        ORDER BY x.game_n`, [t.id, m.id])
    return slotIssues({
      match: m,
      others,
      tournament: tournamentClock(t),
      slotMinutes: d?.slot_minutes || 50,
      restMinutes: d?.rest_minutes || 0
    })
  }
  /** The days and play hours of a tournament row, as slotIssues() and the import read them. */
  const tournamentClock = (t) => ({ starts_on: day(t.starts_on), ends_on: day(t.ends_on), day_start: hhmm(t.day_start), day_end: hhmm(t.day_end) })

  // ------------------------------------------------------------------ schedule
  /**
   * POST schedule { dryRun?, day_start?, day_end? }: schedules every match of
   * the drawn draws that has not begun over the active courts and the
   * tournament's days (lib/beachSchedule.js). Begun matches keep their slot.
   * During the tournament (now on one of its days) no match is put before
   * now. A re-plan places every match that has not begun again: a slot moved
   * by hand (PATCH tmatches/:id) is not kept unless the match has begun.
   */
  async function schedule ({ user, access, id, body }) {
    const b = isPlainObject(body) ? body : {}
    for (const k of ['day_start', 'day_end']) if (b[k] != null && minutesOf(b[k]) == null) return invalid(`${k}: HH:MM`)
    const dryRun = b.dryRun === true
    return guarded('schedule', () => withTx(async (client) => {
      const t = await requireTournament(client, id, user, access, { edit: true, forUpdate: true })
      const dayStart = b.day_start ? String(b.day_start).slice(0, 5) : hhmm(t.day_start)
      const dayEnd = b.day_end ? String(b.day_end).slice(0, 5) : hhmm(t.day_end)
      if (minutesOf(dayEnd) <= minutesOf(dayStart)) throw abort(invalid('day_end: after day_start'))
      const { rows: courts } = await client.query('SELECT id, number FROM public.beach_courts WHERE tournament_id = $1 AND active ORDER BY number', [t.id])
      if (!courts.length) throw abort(fail(409, 'OV_NO_COURTS', 'Add a court first'))
      const { rows: draws } = await client.query(
        "SELECT id, slot_minutes, rest_minutes FROM public.beach_draws WHERE tournament_id = $1 AND status IN ('drawn', 'playing', 'done') ORDER BY created_at, id", [t.id])
      const { rows: list } = await client.query(
        'SELECT * FROM public.beach_tmatches WHERE tournament_id = $1 ORDER BY game_n FOR UPDATE', [t.id])
      const matches = list.map((m) => ({
        id: m.id,
        draw_id: m.draw_id,
        code: m.code,
        game_n: m.game_n,
        wave: m.wave,
        source1: m.source1,
        source2: m.source2,
        fixed: OPEN_STATUSES.includes(m.status) && m.match_id == null ? null : { court_id: m.court_id, scheduled_at: iso(m.scheduled_at), duration_min: m.duration_min }
      }))
      // during the tournament nothing that has not begun goes before now
      const r = scheduleMatches({
        matches, draws, courts, days: daysBetween(day(t.starts_on), day(t.ends_on)), dayStart, dayEnd, notBefore: new Date(now()).toISOString()
      })
      if (!dryRun) {
        for (const s of r.slots) {
          await client.query('UPDATE public.beach_tmatches SET court_id = $2, scheduled_at = $3, duration_min = $4 WHERE id = $1', [s.id, s.court_id, s.scheduled_at, s.duration_min])
        }
        if (r.unplaced.length) {
          await client.query('UPDATE public.beach_tmatches SET court_id = NULL, scheduled_at = NULL WHERE id = ANY($1::uuid[])', [r.unplaced])
        }
        if (dayStart !== hhmm(t.day_start) || dayEnd !== hhmm(t.day_end)) {
          await client.query('UPDATE public.beach_tournaments SET day_start = $2, day_end = $3 WHERE id = $1', [t.id, dayStart, dayEnd])
        }
        await audit(client, user.id, 'tournament.schedule', { tournament_id: t.id, op: 'generate', placed: r.slots.length, unplaced: r.unplaced.length })
      }
      return ok({ slots: r.slots, unplaced: r.unplaced, warnings: r.warnings, day_start: dayStart, day_end: dayEnd })
    }))
  }

  // ------------------------------------------------------------------ ranking
  /** GET ranking of a draw (managers: with licences, for MyBeach) and its CSV text. */
  async function ranking ({ user, access, id }) {
    return guarded('ranking', async () => {
      const t = await requireVia(pool, 'draw', id, user, access, { edit: true })
      const { rows: [d] } = await pool.query('SELECT * FROM public.beach_draws WHERE id = $1', [id])
      const { rows } = await pool.query(
        "SELECT * FROM public.beach_entries WHERE draw_id = $1 AND status = 'registered' ORDER BY final_rank NULLS LAST, seed NULLS LAST, name", [id])
      const entries = rows.map(entryOut)
      return ok({
        tournament: { id: t.id, slug: t.slug, title: t.title },
        draw: drawOut(d),
        complete: d.status === 'done',
        ranking: entries,
        csv: rankingCsv(entries)
      })
    })
  }

  // ------------------------------------------------------------------ public (decision D9)
  const publicCache = new Map() // slug -> { at, result }
  const PUBLIC_TTL_MS = 15000
  /** GET /api/public/beach/t/:slug: names and countries only; public tournaments that are not drafts. */
  async function publicTournament ({ slug }) {
    const s = typeof slug === 'string' ? slug.toLowerCase() : ''
    if (!SLUG_RE.test(s) || s.length > 80) return notFound()
    const hit = publicCache.get(s)
    if (hit && now() - hit.at < PUBLIC_TTL_MS) return hit.result
    const result = await guarded('public', async () => {
      const { rows: [t] } = await pool.query(
        'SELECT * FROM public.beach_tournaments WHERE slug = $1 AND public AND status = ANY($2::text[])', [s, PUBLIC_STATUSES])
      if (!t) return notFound()
      const [courts, draws, entries, tmatches] = await Promise.all([
        pool.query('SELECT id, number, name FROM public.beach_courts WHERE tournament_id = $1 AND active ORDER BY number', [t.id]),
        pool.query('SELECT * FROM public.beach_draws WHERE tournament_id = $1 ORDER BY created_at, id', [t.id]),
        pool.query(`SELECT e.id, e.draw_id, e.seed, e.name, e.player1, e.player2, e.status, e.final_rank
                      FROM public.beach_entries e JOIN public.beach_draws d ON d.id = e.draw_id
                     WHERE d.tournament_id = $1 AND e.status = 'registered' ORDER BY e.draw_id, e.seed NULLS LAST, e.name`, [t.id]),
        pool.query('SELECT * FROM public.beach_tmatches WHERE tournament_id = $1 ORDER BY game_n', [t.id])
      ])
      const courtNo = new Map(courts.rows.map((c) => [c.id, c.number]))
      const person = (p) => ({ first: p?.first || '', last: p?.last || '', country: p?.country ?? null })
      return ok({
        tournament: {
          slug: t.slug, title: t.title, venue: t.venue ?? null, city: t.city ?? null,
          starts_on: day(t.starts_on), ends_on: day(t.ends_on), status: t.status
        },
        courts: courts.rows.map((c) => ({ number: c.number, name: c.name ?? null })),
        draws: draws.rows.map((d) => ({ id: d.id, category: d.category, gender: d.gender, format: d.format, status: d.status })),
        entries: entries.rows.map((e) => ({
          id: e.id, draw_id: e.draw_id, seed: e.seed ?? null, name: e.name, players: [person(e.player1), person(e.player2)], final_rank: e.final_rank ?? null
        })),
        matches: tmatches.rows.map((m) => ({
          draw_id: m.draw_id, game_n: m.game_n, code: m.code, phase: m.phase, round: m.round,
          entry1_id: m.entry1_id ?? null, entry2_id: m.entry2_id ?? null,
          court: m.court_id ? courtNo.get(m.court_id) ?? null : null,
          scheduled_at: iso(m.scheduled_at), status: m.status,
          winner_entry_id: m.winner_entry_id ?? null, result: m.result ?? null, sets: m.sets ?? null
        }))
      })
    })
    if (result.status === 200 || result.status === 404) {
      if (publicCache.size > 500) publicCache.clear()
      publicCache.set(s, { at: now(), result })
    }
    return result
  }

  // ------------------------------------------------------------------ routing
  const ID = '([0-9a-fA-F-]{36})'
  const routes = [
    ['GET', /^\/api\/beach\/tournaments$/, (m, c) => listTournaments(c)],
    ['POST', /^\/api\/beach\/tournaments$/, (m, c) => createTournament(c)],
    ['GET', new RegExp(`^/api/beach/tournaments/${ID}$`), (m, c) => getTournament({ ...c, id: m[1] })],
    ['PATCH', new RegExp(`^/api/beach/tournaments/${ID}$`), (m, c) => updateTournament({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/tournaments/${ID}$`), (m, c) => deleteTournament({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/tournaments/${ID}/managers$`), (m, c) => addManager({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/tournaments/${ID}/managers/${ID}$`), (m, c) => removeManager({ ...c, id: m[1], userId: m[2] })],
    ['PUT', new RegExp(`^/api/beach/tournaments/${ID}/courts$`), (m, c) => putCourts({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/tournaments/${ID}/draws$`), (m, c) => createDraw({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/tournaments/${ID}/schedule$`), (m, c) => schedule({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/tournaments/${ID}/import$`), (m, c) => importTournament({ ...c, id: m[1] })],
    ['PATCH', new RegExp(`^/api/beach/draws/${ID}$`), (m, c) => updateDraw({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/draws/${ID}$`), (m, c) => deleteDraw({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/draws/${ID}/entries$`), (m, c) => createEntry({ ...c, id: m[1] })],
    ['PUT', new RegExp(`^/api/beach/draws/${ID}/seeds$`), (m, c) => putSeeds({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/draws/${ID}/generate$`), (m, c) => generate({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/draws/${ID}/bracket$`), (m, c) => resetBracket({ ...c, id: m[1] })],
    ['GET', new RegExp(`^/api/beach/draws/${ID}/ranking$`), (m, c) => ranking({ ...c, id: m[1] })],
    ['PATCH', new RegExp(`^/api/beach/entries/${ID}$`), (m, c) => updateEntry({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/entries/${ID}$`), (m, c) => deleteEntry({ ...c, id: m[1] })],
    ['PATCH', new RegExp(`^/api/beach/tmatches/${ID}$`), (m, c) => updateTmatch({ ...c, id: m[1] })],
    ['POST', new RegExp(`^/api/beach/tmatches/${ID}/result$`), (m, c) => enterResult({ ...c, id: m[1] })],
    ['DELETE', new RegExp(`^/api/beach/tmatches/${ID}/result$`), (m, c) => withdrawResult({ ...c, id: m[1] })]
  ]

  /**
   * Route an authenticated /api/beach/* call. The caller (lib/manageApi.js)
   * has already checked that the account may read beach data at all.
   */
  async function route ({ method, pathname, query, body, user, access }) {
    let pathKnown = false
    for (const [m, re, handler] of routes) {
      const match = re.exec(pathname)
      if (!match) continue
      pathKnown = true
      if (m !== method) continue
      const ids = match.map((v, i) => (i > 0 && typeof v === 'string' ? v.toLowerCase() : v))
      if (ids.slice(1).some((v) => !isUuid(v))) return notFound()
      return handler(ids, { user, access, body, query })
    }
    return pathKnown ? METHOD_NOT_ALLOWED() : notFound()
  }

  return {
    route,
    publicTournament,
    listTournaments,
    createTournament,
    getTournament,
    updateTournament,
    deleteTournament,
    generate,
    schedule,
    importTournament,
    enterResult,
    withdrawResult,
    ranking
  }
}
