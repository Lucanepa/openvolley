/**
 * savedTeams — the competition manager's saved teams (docs/scorer-accounts-spec.md
 * 4.7 and 5.5, db/007): competitions, their teams, and each team's players
 * and officials, for MatchSetup's "Load saved team".
 *
 * Personal data (dates of birth, licence numbers): served only through
 * /api/saved-teams*, never on the /api/db allowlist, never anonymous, never in
 * a public projection. Who may read (approved scorers, competition managers,
 * admins) and write (competition managers, admins) is decided by the server.
 * Owner decision 1: competition managers and admins read every saved team of
 * the sport; an account that only reads them (an indoor scorer) gets those of
 * its own matches in the current season (getBundle `scope`): its clubs'
 * teams, the teams they meet at home in the schedule, and the teams of the
 * matches it created or edits; never an archived competition.
 *
 * Deleting a competition or a team, and replacing a team's roster, write an
 * audit entry (who, the ids, the name, the counts; never a person). A
 * competition that still has teams, or a team that still has people, is
 * deleted only with its name typed as `confirm` (400 OV_CONFIRM_NAME).
 *
 * Every handler returns { status, body } and never throws (a database error
 * is 503 OV_DB_UNAVAILABLE, retryable).
 *
 * Sports (docs/beach-saved-teams-spec.md, db/009): a competition is 'indoor'
 * or 'beach', fixed at creation; a team's sport is its competition's. GET
 * without ?sport= answers indoor only and POST without sport creates indoor,
 * so a 2.1.0 client never sees a beach row. A beach team is a pair (players
 * numbered 1 and 2, no libero/captain/active flags, an optional country) with
 * at most one Coach.
 */

import { randomUUID } from 'node:crypto'
import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf } from './officialGame.js'

export const STAFF_ROLES = Object.freeze(['Coach', 'Assistant Coach 1', 'Assistant Coach 2', 'Physiotherapist', 'Medic'])
export const GENDERS = Object.freeze(['men', 'women', 'mixed'])
export const MAX_PLAYERS = 40
export const MAX_STAFF = 10
export const SPORTS = Object.freeze(['indoor', 'beach'])
export const BEACH_MAX_PLAYERS = 2
export const BEACH_MAX_STAFF = 1

const SEASON_RE = /^(\d{4})\/(\d{2})$/
const BEACH_SEASON_RE = /^\d{4}$/
const COUNTRY_RE = /^[A-Z]{3}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function validDate (s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Optional text: undefined (absent) stays undefined, null/'' become null,
 * else trimmed with at most `max` characters. Returns { value } or { error }.
 */
function optText (raw, max, { required = false, min = 1 } = {}) {
  if (raw === undefined) return required ? { error: 'required' } : { value: undefined }
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return required ? { error: 'required' } : { value: null }
  if (typeof raw !== 'string') return { error: 'must be text' }
  const s = raw.trim()
  if (s.length < min) return { error: `at least ${min} characters` }
  if (s.length > max) return { error: `at most ${max} characters` }
  return { value: s }
}

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

/** The season of a competition of `sport`: indoor '2026/27' (consecutive years), beach '2026'. */
function seasonField (raw, sport) {
  const s = typeof raw === 'string' ? raw.trim() : null
  if (sport === 'beach') {
    if (s === null || !BEACH_SEASON_RE.test(s) || Number(s) < 2000 || Number(s) > 2100) return { error: "like '2026'" }
    return { value: s }
  }
  const m = s === null ? null : SEASON_RE.exec(s)
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) return { error: "like '2026/27'" }
  return { value: s }
}

function competitionFields (body, { partial, sport = 'indoor' }) {
  const f = fields()
  f.set('name', optText(body.name, 120, { required: !partial || has(body, 'name') }))
  if (!partial || has(body, 'season')) f.set('season', seasonField(body.season, sport))
  if (has(body, 'gender')) {
    if (body.gender === null || body.gender === '') f.set('gender', { value: null })
    else if (!GENDERS.includes(body.gender)) f.set('gender', { error: 'men, women, mixed or null' })
    else f.set('gender', { value: body.gender })
  }
  if (has(body, 'category')) f.set('category', optText(body.category, 60))
  if (has(body, 'vm_leagues')) {
    const v = body.vm_leagues
    if (v === null) f.set('vm_leagues', { value: [] })
    else if (sport === 'beach') {
      // VolleyManager leagues are indoor only
      if (Array.isArray(v) && v.length === 0) f.set('vm_leagues', { value: [] })
      else f.set('vm_leagues', { error: 'not for beach' })
    }
    else if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= 60)) {
      f.set('vm_leagues', { error: 'at most 20 league names of at most 60 characters' })
    } else f.set('vm_leagues', { value: [...new Set(v.map((x) => x.trim()))] })
  }
  if (partial && has(body, 'archived')) {
    if (typeof body.archived !== 'boolean') f.set('archived', { error: 'true or false' })
    else f.set('archived', { value: body.archived })
  }
  return f
}

function teamFields (body, { partial }) {
  const f = fields()
  if (!partial) {
    if (!isUuid(body.competition_id)) f.set('competition_id', { error: 'a competition id' })
    else f.set('competition_id', { value: body.competition_id })
  } else if (has(body, 'competition_id')) {
    f.set('competition_id', { error: 'cannot be changed' })
  }
  f.set('name', optText(body.name, 120, { required: !partial || has(body, 'name') }))
  if (has(body, 'short_name')) f.set('short_name', optText(body.short_name, 20))
  if (has(body, 'club')) f.set('club', optText(body.club, 120))
  if (has(body, 'svrz_team_name')) f.set('svrz_team_name', optText(body.svrz_team_name, 200))
  if (has(body, 'color')) {
    if (body.color === null || body.color === '') f.set('color', { value: null })
    else if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) f.set('color', { error: "like '#e2001a'" })
    else f.set('color', { value: body.color.toLowerCase() })
  }
  return f
}

/** The roster body's shape: null when fine, else the 400 answer. */
function rosterShapeError (body) {
  if (!isPlainObject(body)) return invalid('body: must be an object')
  if (!Array.isArray(body.players)) return invalid('players: an array')
  if (!Array.isArray(body.staff)) return invalid('staff: an array')
  return null
}

/**
 * The PUT roster body, validated for a team of `sport` ('indoor' when absent,
 * the 2.1.0 rules). Returns { players, staff } or { error } (a 400 answer).
 */
export function validateRoster (body, { sport = 'indoor' } = {}) {
  const shape = rosterShapeError(body)
  if (shape) return { error: shape }
  const { players, staff } = body
  const beach = sport === 'beach'
  if (beach) {
    if (players.length > BEACH_MAX_PLAYERS) return { error: invalid(`players: at most ${BEACH_MAX_PLAYERS} in beach`) }
    if (staff.length > BEACH_MAX_STAFF) return { error: invalid(`staff: at most ${BEACH_MAX_STAFF} (the coach) in beach`) }
  }
  if (players.length > MAX_PLAYERS) return { error: invalid(`players: at most ${MAX_PLAYERS}`) }
  if (staff.length > MAX_STAFF) return { error: invalid(`staff: at most ${MAX_STAFF}`) }
  const ids = new Set()
  const person = (raw, label, i) => {
    if (!isPlainObject(raw)) return { error: invalid(`${label}[${i}]: must be an object`) }
    const out = {}
    if (raw.id != null && raw.id !== '') {
      if (!isUuid(raw.id)) return { error: invalid(`${label}[${i}].id: a uuid or absent`) }
      if (ids.has(raw.id.toLowerCase())) return { error: invalid(`${label}[${i}].id: used twice`) }
      ids.add(raw.id.toLowerCase())
      out.id = raw.id.toLowerCase()
    }
    const first = optText(raw.first_name ?? null, 80)
    if (first.error) return { error: invalid(`${label}[${i}].first_name: ${first.error}`) }
    out.first_name = first.value ?? ''
    const last = optText(raw.last_name, 80, { required: true })
    if (last.error) return { error: invalid(`${label}[${i}].last_name: ${last.error}`) }
    out.last_name = last.value
    if (raw.dob == null || raw.dob === '') out.dob = null
    else if (!validDate(raw.dob)) return { error: invalid(`${label}[${i}].dob: YYYY-MM-DD or null`) }
    else out.dob = raw.dob
    const lic = optText(raw.license_number ?? null, 40)
    if (lic.error) return { error: invalid(`${label}[${i}].license_number: ${lic.error}`) }
    out.license_number = lic.value ?? null
    out.sort_order = i
    return { value: out }
  }
  if (beach) return validateBeachRoster(players, staff, person)
  const outPlayers = []
  const numbers = new Set()
  let captains = 0
  for (let i = 0; i < players.length; i++) {
    const r = person(players[i], 'players', i)
    if (r.error) return r
    const raw = players[i]
    const p = r.value
    if (raw.number == null || raw.number === '') p.number = null
    else if (!Number.isInteger(Number(raw.number)) || Number(raw.number) < 0 || Number(raw.number) > 99) {
      return { error: invalid(`players[${i}].number: 0 to 99 or null`) }
    } else p.number = Number(raw.number)
    for (const k of ['is_libero', 'is_captain', 'active']) {
      if (raw[k] != null && typeof raw[k] !== 'boolean') return { error: invalid(`players[${i}].${k}: true or false`) }
    }
    p.is_libero = raw.is_libero === true
    p.is_captain = raw.is_captain === true
    p.active = raw.active !== false
    if (raw.country != null && raw.country !== '') return { error: invalid(`players[${i}].country: only for beach`) }
    p.country = null
    if (p.active) {
      if (p.number != null) {
        if (numbers.has(p.number)) return { error: invalid(`players[${i}].number: ${p.number} is used twice`) }
        numbers.add(p.number)
      }
      if (p.is_captain && ++captains > 1) return { error: invalid(`players[${i}].is_captain: only one captain`) }
    }
    outPlayers.push(p)
  }
  const outStaff = []
  for (let i = 0; i < staff.length; i++) {
    const r = person(staff[i], 'staff', i)
    if (r.error) return r
    if (!STAFF_ROLES.includes(staff[i].role)) return { error: invalid(`staff[${i}].role: one of ${STAFF_ROLES.join(', ')}`) }
    outStaff.push({ ...r.value, role: staff[i].role })
  }
  return { players: outPlayers, staff: outStaff }
}

/** Beach: a pair numbered 1 and 2 (no libero, captain or inactive player), staff = at most one Coach. */
function validateBeachRoster (players, staff, person) {
  const outPlayers = []
  const numbers = new Set()
  for (let i = 0; i < players.length; i++) {
    const r = person(players[i], 'players', i)
    if (r.error) return r
    const raw = players[i]
    const p = r.value
    const n = typeof raw.number === 'string' && raw.number.trim() !== '' ? Number(raw.number) : raw.number
    if (n !== 1 && n !== 2) return { error: invalid(`players[${i}].number: 1 or 2`) }
    if (numbers.has(n)) return { error: invalid(`players[${i}].number: ${n} is used twice`) }
    numbers.add(n)
    p.number = n
    for (const k of ['is_libero', 'is_captain']) {
      if (raw[k] != null && typeof raw[k] !== 'boolean') return { error: invalid(`players[${i}].${k}: true or false`) }
      if (raw[k] === true) return { error: invalid(`players[${i}].${k}: not in beach`) }
    }
    if (raw.active != null && typeof raw.active !== 'boolean') return { error: invalid(`players[${i}].active: true or false`) }
    if (raw.active === false) return { error: invalid(`players[${i}].active: not in beach`) }
    if (raw.country == null || (typeof raw.country === 'string' && raw.country.trim() === '')) p.country = null
    else {
      const c = String(raw.country).trim().toUpperCase()
      if (!COUNTRY_RE.test(c)) return { error: invalid(`players[${i}].country: 3 letters like 'CHE'`) }
      p.country = c
    }
    p.is_libero = false
    p.is_captain = false
    p.active = true
    outPlayers.push(p)
  }
  const outStaff = []
  for (let i = 0; i < staff.length; i++) {
    const r = person(staff[i], 'staff', i)
    if (r.error) return r
    if (staff[i].role !== 'Coach') return { error: invalid(`staff[${i}].role: Coach only in beach`) }
    outStaff.push({ ...r.value, role: 'Coach' })
  }
  return { players: outPlayers, staff: outStaff }
}

const COMPETITION_COLS = 'id, name, season, gender, category, vm_leagues, archived, updated_at, sport'
const TEAM_COLS = 'id, competition_id, name, short_name, club, color, svrz_team_name, updated_at'
// A team row with its competition's sport (t = competition_teams, c = competitions)
const TEAM_SELECT = `${TEAM_COLS.split(', ').map((c) => 't.' + c).join(', ')}, c.sport`
const sportOut = (v) => (v === 'beach' ? 'beach' : 'indoor')
const competitionOut = (r) => ({
  id: r.id,
  name: r.name,
  season: r.season,
  gender: r.gender ?? null,
  category: r.category ?? null,
  vm_leagues: r.vm_leagues ?? [],
  archived: r.archived === true,
  updated_at: iso(r.updated_at),
  sport: sportOut(r.sport)
})
const teamOut = (r) => ({
  id: r.id,
  competition_id: r.competition_id,
  name: r.name,
  short_name: r.short_name ?? null,
  club: r.club ?? null,
  color: r.color ?? null,
  svrz_team_name: r.svrz_team_name ?? null,
  updated_at: iso(r.updated_at),
  sport: sportOut(r.sport),
  players: r.players ?? [],
  staff: r.staff ?? []
})

// players / staff of team `alias` as JSON arrays, in sort order (dob as YYYY-MM-DD)
const ROSTER_SQL = (alias) => `
  coalesce((SELECT json_agg(json_build_object('id', p.id, 'number', p.number, 'first_name', p.first_name,
            'last_name', p.last_name, 'dob', p.dob, 'license_number', p.license_number, 'is_libero', p.is_libero,
            'is_captain', p.is_captain, 'active', p.active, 'sort_order', p.sort_order, 'country', p.country) ORDER BY p.sort_order, p.id)
       FROM public.competition_players p WHERE p.team_id = ${alias}.id), '[]'::json) AS players,
  coalesce((SELECT json_agg(json_build_object('id', s.id, 'role', s.role, 'first_name', s.first_name,
            'last_name', s.last_name, 'dob', s.dob, 'license_number', s.license_number, 'sort_order', s.sort_order) ORDER BY s.sort_order, s.id)
       FROM public.competition_staff s WHERE s.team_id = ${alias}.id), '[]'::json) AS staff`

// A delete of a competition with teams or a team with people: its name typed as ?confirm=
export const CONFIRM_NAME = (what) => fail(400, 'OV_CONFIRM_NAME', `Type the ${what}'s name to delete it with everything in it`)
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()
const latest = (rows) => rows.reduce((max, r) => {
  const v = iso(r.updated_at)
  return v && (!max || v > max) ? v : max
}, null)

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {(client: any, entry: object) => Promise<void>} [o.audit]  lib/accounts.js audit (throws); without
 *   it (tests of this module alone) nothing is audited
 */
export function createSavedTeams ({ pool, audit = null, logger = console, clock = () => new Date() } = {}) {
  const log = logger
  const auditOf = (client, entry) => (audit ? audit(client, entry) : null)

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

  const abort = (result) => Object.assign(new Error('abort'), { __result: result })
  const duplicate = () => fail(409, 'OV_DUPLICATE', 'A team with this name already exists in this competition')

  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      if (err?.code === '23505' && err.constraint === 'competition_teams_name_uidx') return duplicate()
      if (err?.code === '23514' || err?.code === '22001' || err?.code === '22P02') {
        // A CHECK the validation above should already have caught
        return invalid(`${err.constraint || 'value'}: not allowed`)
      }
      log.error?.(`[savedTeams] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  async function teamById (db, id) {
    const { rows: [t] } = await db.query(`SELECT ${TEAM_SELECT}, ${ROSTER_SQL('t')}
      FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id WHERE t.id = $1`, [id])
    return t ? teamOut(t) : null
  }

  /**
   * The indoor teams of `userId`'s own matches in the current season (owner
   * decision 1), with their rosters: the teams of its clubs (account_clubs),
   * the teams they meet at home in the schedule (svrz_games from the season's
   * start) and the teams of the official games of the matches it created or
   * edits this season; of competitions of the current season that are not
   * archived. A saved team is one of these by its VolleyManager name, else by
   * its name when it has none (as lib/teams.js squadId).
   */
  async function ownTeams (userId) {
    if (!isUuid(userId)) return []
    const year = seasonOf(clock())
    const label = `${year}/${String((year + 1) % 100).padStart(2, '0')}`
    const { rows } = await pool.query(
      `WITH mine AS (
         SELECT DISTINCT lower(btrim(ct.team_name)) AS k
           FROM public.account_clubs ac JOIN public.club_teams ct ON ct.club_id = ac.club_id
          WHERE ac.user_id = $1),
       own_games AS (
         SELECT DISTINCT m.game_n::text AS n FROM public.matches m
          WHERE m.game_n IS NOT NULL AND m.test IS NOT TRUE AND m.created_at >= $3::timestamptz
            AND (m.created_by = $1 OR EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = $1))),
       games AS (
         SELECT g.team_home, g.team_away FROM public.svrz_games g
          WHERE g.datetime >= $2 AND (lower(btrim(g.team_home)) IN (SELECT k FROM mine) OR g.game_number IN (SELECT n FROM own_games))),
       names AS (
         SELECT k FROM mine
         UNION SELECT lower(btrim(team_home)) FROM games WHERE team_home IS NOT NULL
         UNION SELECT lower(btrim(team_away)) FROM games WHERE team_away IS NOT NULL)
       SELECT ${TEAM_SELECT}, ${ROSTER_SQL('t')}
         FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE c.sport = 'indoor' AND c.season = $4 AND NOT c.archived
          AND (lower(btrim(t.svrz_team_name)) IN (SELECT k FROM names)
               OR (coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) IN (SELECT k FROM names)))
        ORDER BY lower(t.name), t.id`,
      [userId, `${year}-07-01`, `${year}-07-01T00:00:00Z`, label])
    return rows
  }

  /**
   * GET /api/saved-teams?sport=indoor|beach|all (absent or '' = indoor, for 2.1.0 clients).
   * `sports`: what 'all' covers (the sports the caller may read; default both).
   * `scope` { userId, sports }: the sports in which the caller only reads (an
   * indoor scorer, owner decision 1): there the teams of its own matches in
   * the current season (ownTeams; indoor only) and their competitions. The
   * other sports answer every competition and team. `version`: the newest
   * updated_at of what the answer holds ('0' for nothing).
   */
  async function getBundle ({ sport, sports = SPORTS, scope = null } = {}) {
    if (sport === undefined || sport === null || sport === '') sport = 'indoor'
    if (sport !== 'all' && !SPORTS.includes(sport)) return invalid('sport: indoor, beach or all')
    const readable = SPORTS.filter((s) => Array.isArray(sports) && sports.includes(s))
    const wanted = sport === 'all' ? readable : [sport]
    const scoped = (s) => s === 'indoor' && Array.isArray(scope?.sports) && scope.sports.includes(s)
    const full = wanted.filter((s) => !scoped(s))
    return guarded('bundle', async () => {
      const { rows: comps } = full.length
        ? await pool.query(`SELECT ${COMPETITION_COLS} FROM public.competitions WHERE sport = ANY($1::text[])
            ORDER BY season DESC, lower(name), id`, [full])
        : { rows: [] }
      const { rows: teams } = full.length
        ? await pool.query(`SELECT ${TEAM_SELECT}, ${ROSTER_SQL('t')}
            FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
           WHERE c.sport = ANY($1::text[]) ORDER BY lower(t.name), t.id`, [full])
        : { rows: [] }
      if (wanted.some(scoped)) {
        const own = await ownTeams(scope.userId)
        const ids = [...new Set(own.map((t) => t.competition_id))]
        if (ids.length) {
          comps.push(...(await pool.query(`SELECT ${COMPETITION_COLS} FROM public.competitions WHERE id = ANY($1::uuid[])
            ORDER BY season DESC, lower(name), id`, [ids])).rows)
        }
        teams.push(...own)
        if (full.length) {
          // 'all' with one sport of each kind: one order again
          const text = (v) => String(v ?? '').toLowerCase()
          comps.sort((a, b) => text(b.season).localeCompare(text(a.season)) || text(a.name).localeCompare(text(b.name)) || text(a.id).localeCompare(text(b.id)))
          teams.sort((a, b) => text(a.name).localeCompare(text(b.name)) || text(a.id).localeCompare(text(b.id)))
        }
      }
      return ok({
        version: latest([...comps, ...teams]) ?? '0',
        fetched_at: new Date().toISOString(),
        sport,
        competitions: comps.map(competitionOut),
        teams: teams.map(teamOut)
      })
    })
  }

  /** `client`: inside the caller's transaction (lib/teams.js putSquad). */
  async function createCompetition ({ actorId, body, client = null } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const sport = body.sport == null ? 'indoor' : body.sport
    if (!SPORTS.includes(sport)) return invalid('sport: indoor or beach')
    const f = competitionFields(body, { partial: false, sport })
    if (f.error) return f.error
    return guarded('create-competition', async () => {
      const v = f.out
      const { rows: [r] } = await (client || pool).query(
        `INSERT INTO public.competitions (name, season, gender, category, vm_leagues, created_by, sport)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7) RETURNING ${COMPETITION_COLS}`,
        [v.name, v.season, v.gender ?? null, v.category ?? null, v.vm_leagues ?? [], isUuid(actorId) ? actorId : null, sport])
      return ok({ competition: competitionOut(r) }, 201)
    })
  }

  async function updateCompetition ({ id, body } = {}) {
    // The sport is fixed at creation (checked first: it answers even for an unknown id)
    if (isPlainObject(body) && has(body, 'sport')) return invalid('sport: cannot be changed')
    if (!isUuid(id)) return notFound()
    if (!isPlainObject(body)) return invalid('body: must be an object')
    let sport = 'indoor'
    if (Object.keys(body).length) {
      // season and vm_leagues follow the rules of the competition's own sport
      const found = await guarded('update-competition', async () => {
        const { rows: [c] } = await pool.query('SELECT sport FROM public.competitions WHERE id = $1', [id])
        return c ? { sport: c.sport } : notFound()
      })
      if (found.status) return found
      sport = found.sport
    }
    const f = competitionFields(body, { partial: true, sport })
    if (f.error) return f.error
    return guarded('update-competition', async () => {
      const entries = Object.entries(f.out)
      const sets = entries.map(([k], i) => `${k} = $${i + 2}${k === 'vm_leagues' ? '::text[]' : ''}`)
      // An empty PATCH still bumps updated_at (the trigger), so it answers the current row
      const sql = `UPDATE public.competitions SET ${sets.length ? sets.join(', ') : 'name = name'} WHERE id = $1 RETURNING ${COMPETITION_COLS}`
      const { rows: [r] } = await pool.query(sql, [id, ...entries.map(([, v]) => v)])
      return r ? ok({ competition: competitionOut(r) }) : notFound()
    })
  }

  /**
   * DELETE /api/saved-teams/competitions/:id[?confirm=<name>]: the competition
   * with its teams, players and officials (ON DELETE CASCADE). One that still
   * has teams only with its name as `confirm` (fe-manage-2: every club's squad
   * of a league goes with it). Audited (the name and the counts).
   */
  async function deleteCompetition ({ id, actorId = null, confirm = null } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete-competition', () => withTx(async (client) => {
      const { rows: [c] } = await client.query(
        `SELECT c.id, c.name, c.season, c.sport,
                (SELECT count(*)::int FROM public.competition_teams t WHERE t.competition_id = c.id) AS teams,
                (SELECT count(*)::int FROM public.competition_players p JOIN public.competition_teams t ON t.id = p.team_id WHERE t.competition_id = c.id) AS players,
                (SELECT count(*)::int FROM public.competition_staff s JOIN public.competition_teams t ON t.id = s.team_id WHERE t.competition_id = c.id) AS staff
           FROM public.competitions c WHERE c.id = $1 FOR UPDATE`, [id])
      if (!c) throw abort(notFound())
      if (c.teams > 0 && !sameName(confirm, c.name)) throw abort(CONFIRM_NAME('competition'))
      await client.query('DELETE FROM public.competitions WHERE id = $1', [id])
      await auditOf(client, {
        actorId,
        action: 'saved_teams.competition_delete',
        details: { competition_id: id, name: c.name, season: c.season, teams: c.teams, players: c.players, staff: c.staff },
        ...(sportOut(c.sport) === 'beach' ? { app: 'beach' } : {})
      })
      return ok({ deleted: true })
    }))
  }

  /** `client`: inside the caller's transaction (lib/teams.js putSquad). */
  async function createTeam ({ actorId, body, client = null } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const f = teamFields(body, { partial: false })
    if (f.error) return f.error
    const db = client || pool
    return guarded('create-team', async () => {
      const v = f.out
      const { rows: [c] } = await db.query('SELECT id, sport FROM public.competitions WHERE id = $1', [v.competition_id])
      if (!c) return notFound('competition_id: no such competition')
      const { rows: [r] } = await db.query(
        `INSERT INTO public.competition_teams (competition_id, name, short_name, club, color, svrz_team_name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${TEAM_COLS}`,
        [v.competition_id, v.name, v.short_name ?? null, v.club ?? null, v.color ?? null, v.svrz_team_name ?? null, isUuid(actorId) ? actorId : null])
      return ok({ team: teamOut({ ...r, sport: c.sport }) }, 201)
    })
  }

  async function updateTeam ({ id, body } = {}) {
    if (!isUuid(id)) return notFound()
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const f = teamFields(body, { partial: true })
    if (f.error) return f.error
    return guarded('update-team', async () => {
      const entries = Object.entries(f.out)
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`)
      const { rowCount } = await pool.query(
        `UPDATE public.competition_teams SET ${sets.length ? sets.join(', ') : 'name = name'} WHERE id = $1`, [id, ...entries.map(([, v]) => v)])
      if (!rowCount) return notFound()
      return ok({ team: await teamById(pool, id) })
    })
  }

  /**
   * DELETE /api/saved-teams/teams/:id[?confirm=<name>]: the team with its
   * players and officials. One that still has people only with its name as
   * `confirm`. Audited (the name and the counts).
   */
  async function deleteTeam ({ id, actorId = null, confirm = null } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete-team', () => withTx(async (client) => {
      const { rows: [t] } = await client.query(
        `SELECT t.id, t.name, t.competition_id, c.sport,
                (SELECT count(*)::int FROM public.competition_players p WHERE p.team_id = t.id) AS players,
                (SELECT count(*)::int FROM public.competition_staff s WHERE s.team_id = t.id) AS staff
           FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
          WHERE t.id = $1 FOR UPDATE OF t`, [id])
      if (!t) throw abort(notFound())
      if (t.players + t.staff > 0 && !sameName(confirm, t.name)) throw abort(CONFIRM_NAME('team'))
      await client.query('DELETE FROM public.competition_teams WHERE id = $1', [id])
      // The bundle version follows deletions too
      await client.query('UPDATE public.competitions SET updated_at = now() WHERE id = $1', [t.competition_id])
      await auditOf(client, {
        actorId,
        action: 'saved_teams.team_delete',
        details: { team_id: id, competition_id: t.competition_id, name: t.name, players: t.players, staff: t.staff },
        ...(sportOut(t.sport) === 'beach' ? { app: 'beach' } : {})
      })
      return ok({ deleted: true })
    }))
  }

  /** The roster write of putRoster on `client` (in a transaction): { team, before } or an abort. */
  async function replaceRoster (client, id, body) {
    const { rows: [team] } = await client.query(
      `SELECT t.id, t.name, t.competition_id, c.sport,
              (SELECT count(*)::int FROM public.competition_players p WHERE p.team_id = t.id) AS players,
              (SELECT count(*)::int FROM public.competition_staff s WHERE s.team_id = t.id) AS staff
         FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE t.id = $1 FOR UPDATE OF t`, [id])
    if (!team) throw abort(notFound())
    // The rules of the team's sport (a beach pair, or the indoor roster)
    const v = validateRoster(body, { sport: team.sport })
    if (v.error) throw abort(v.error)
    for (const [table, rows, label] of [['competition_players', v.players, 'players'], ['competition_staff', v.staff, 'staff']]) {
      const given = rows.filter((r) => r.id).map((r) => r.id)
      const { rows: found } = given.length
        ? await client.query(`SELECT id, team_id FROM public.${table} WHERE id = ANY($1::uuid[])`, [given])
        : { rows: [] }
      const owner = new Map(found.map((r) => [r.id, r.team_id]))
      const kept = []
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.id && owner.has(r.id)) {
          if (owner.get(r.id) !== id) throw abort(invalid(`${label}[${i}].id: belongs to another team`))
          kept.push(r.id)
        } else {
          r.id = randomUUID() // a new row (an unknown id is not taken from the client)
        }
      }
      await client.query(`DELETE FROM public.${table} WHERE team_id = $1 AND NOT (id = ANY($2::uuid[]))`, [id, kept])
      for (const r of rows) {
        if (table === 'competition_players') {
          await client.query(
            `INSERT INTO public.competition_players (id, team_id, number, first_name, last_name, dob, license_number, is_libero, is_captain, active, sort_order, country)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
               dob = EXCLUDED.dob, license_number = EXCLUDED.license_number, is_libero = EXCLUDED.is_libero,
               is_captain = EXCLUDED.is_captain, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, country = EXCLUDED.country`,
            [r.id, id, r.number, r.first_name, r.last_name, r.dob, r.license_number, r.is_libero, r.is_captain, r.active, r.sort_order, r.country ?? null])
        } else {
          await client.query(
            `INSERT INTO public.competition_staff (id, team_id, role, first_name, last_name, dob, license_number, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
               dob = EXCLUDED.dob, license_number = EXCLUDED.license_number, sort_order = EXCLUDED.sort_order`,
            [r.id, id, r.role, r.first_name, r.last_name, r.dob, r.license_number, r.sort_order])
        }
      }
    }
    await client.query('UPDATE public.competition_teams SET updated_at = now() WHERE id = $1', [id])
    return { team: await teamById(client, id), before: team, players: v.players.length, staff: v.staff.length }
  }

  /**
   * PUT /api/saved-teams/teams/:id/roster { players, staff }: the team's whole
   * roster. Audited (the counts before and after, never a person). `client`:
   * inside the caller's transaction, which audits it itself (lib/teams.js
   * putSquad, team.squad).
   */
  async function putRoster ({ id, body, actorId = null, client = null } = {}) {
    if (!isUuid(id)) return notFound()
    const shape = rosterShapeError(body)
    if (shape) return shape
    if (client) return guarded('put-roster', async () => ok({ team: (await replaceRoster(client, id, body)).team }))
    return guarded('put-roster', () => withTx(async (c) => {
      const out = await replaceRoster(c, id, body)
      await auditOf(c, {
        actorId,
        action: 'saved_teams.roster',
        details: {
          team_id: id,
          competition_id: out.before.competition_id,
          name: out.before.name,
          before: { players: out.before.players, staff: out.before.staff },
          players: out.players,
          staff: out.staff
        },
        ...(sportOut(out.before.sport) === 'beach' ? { app: 'beach' } : {})
      })
      return ok({ team: out.team })
    }))
  }

  /**
   * The sport of a competition or of a team's competition (server.js checks
   * the role of that sport before a write): { sport } ('indoor' | 'beach'),
   * { sport: null } when there is no such row (the write answers 404), or
   * { error } (503). Never throws.
   */
  async function sportOf ({ competitionId, teamId } = {}) {
    const id = competitionId ?? teamId
    if (!isUuid(id)) return { sport: null }
    try {
      const { rows: [r] } = competitionId
        ? await pool.query('SELECT sport FROM public.competitions WHERE id = $1', [id])
        : await pool.query('SELECT c.sport FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id WHERE t.id = $1', [id])
      return { sport: r ? sportOut(r.sport) : null }
    } catch (err) {
      log.error?.(`[savedTeams] sport-of failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return { error: unavailable() }
    }
  }

  /** One saved team with its players and staff (lib/teams.js, a team manager's squad). */
  async function getTeam ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('get-team', async () => {
      const team = await teamById(pool, id)
      return team ? ok({ team }) : notFound()
    })
  }

  return { getBundle, createCompetition, updateCompetition, deleteCompetition, createTeam, updateTeam, deleteTeam, putRoster, getTeam, sportOf }
}
