/**
 * savedTeams — the competition manager's saved teams (docs/scorer-accounts-spec.md
 * 4.7 and 5.5, db/007): competitions, their teams, and each team's players
 * and officials, for MatchSetup's "Load saved team".
 *
 * Personal data (dates of birth, licence numbers): served only through
 * /api/saved-teams*, never on the /api/db allowlist, never anonymous, never in
 * a public projection. Who may read (approved scorers, competition managers,
 * admins) and write (competition managers, admins) is decided by the server.
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

export function createSavedTeams ({ pool, logger = console } = {}) {
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

  /** GET /api/saved-teams?sport=indoor|beach|all (absent or '' = indoor, for 2.1.0 clients) */
  async function getBundle ({ sport } = {}) {
    if (sport === undefined || sport === null || sport === '') sport = 'indoor'
    if (sport !== 'all' && !SPORTS.includes(sport)) return invalid('sport: indoor, beach or all')
    return guarded('bundle', async () => {
      const { rows: comps } = await pool.query(
        `SELECT ${COMPETITION_COLS} FROM public.competitions WHERE ($1::text = 'all' OR sport = $1::text) ORDER BY season DESC, lower(name), id`, [sport])
      const { rows: teams } = await pool.query(`SELECT ${TEAM_SELECT}, ${ROSTER_SQL('t')}
        FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE ($1::text = 'all' OR c.sport = $1::text) ORDER BY lower(t.name), t.id`, [sport])
      const { rows: [v] } = await pool.query(
        `SELECT greatest(
           (SELECT max(updated_at) FROM public.competitions WHERE ($1::text = 'all' OR sport = $1::text)),
           (SELECT max(t.updated_at) FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
             WHERE ($1::text = 'all' OR c.sport = $1::text))) AS version`, [sport])
      return ok({
        version: v?.version ? iso(v.version) : '0',
        fetched_at: new Date().toISOString(),
        sport,
        competitions: comps.map(competitionOut),
        teams: teams.map(teamOut)
      })
    })
  }

  async function createCompetition ({ actorId, body } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const sport = body.sport == null ? 'indoor' : body.sport
    if (!SPORTS.includes(sport)) return invalid('sport: indoor or beach')
    const f = competitionFields(body, { partial: false, sport })
    if (f.error) return f.error
    return guarded('create-competition', async () => {
      const v = f.out
      const { rows: [r] } = await pool.query(
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

  async function deleteCompetition ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete-competition', async () => {
      const { rowCount } = await pool.query('DELETE FROM public.competitions WHERE id = $1', [id])
      return rowCount ? ok({ deleted: true }) : notFound()
    })
  }

  async function createTeam ({ actorId, body } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const f = teamFields(body, { partial: false })
    if (f.error) return f.error
    return guarded('create-team', async () => {
      const v = f.out
      const { rows: [c] } = await pool.query('SELECT id, sport FROM public.competitions WHERE id = $1', [v.competition_id])
      if (!c) return notFound('competition_id: no such competition')
      const { rows: [r] } = await pool.query(
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

  async function deleteTeam ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete-team', () => withTx(async (client) => {
      const { rows: [t] } = await client.query('DELETE FROM public.competition_teams WHERE id = $1 RETURNING competition_id', [id])
      if (!t) throw abort(notFound())
      // The bundle version follows deletions too
      await client.query('UPDATE public.competitions SET updated_at = now() WHERE id = $1', [t.competition_id])
      return ok({ deleted: true })
    }))
  }

  /** PUT /api/saved-teams/teams/:id/roster { players, staff }: the team's whole roster. */
  async function putRoster ({ id, body } = {}) {
    if (!isUuid(id)) return notFound()
    const shape = rosterShapeError(body)
    if (shape) return shape
    return guarded('put-roster', () => withTx(async (client) => {
      const { rows: [team] } = await client.query(
        `SELECT t.id, c.sport FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
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
      return ok({ team: await teamById(client, id) })
    }))
  }

  return { getBundle, createCompetition, updateCompetition, deleteCompetition, createTeam, updateTeam, deleteTeam, putRoster }
}
