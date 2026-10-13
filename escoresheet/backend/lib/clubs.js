/**
 * clubs — scorers score the home games of their own club (indoor; db/018,
 * docs/scorer-accounts-spec.md section 9).
 *
 * A club is a name and the VolleyManager team names that play for it
 * (svrz_games.team_home / team_away); an account scores for one or more
 * clubs. The database refuses an official indoor game whose home team is not
 * of the writer's clubs (db/018 ov_matches_club_guard) while the rule is on;
 * this module is what the manager and the scorer app see of it:
 *
 *   admins (lib/manageApi.js, /api/admin/...)
 *     list()                              clubs with their teams and scorer count, the rule
 *     create({ actorId, body })           { name, teams?: [team name] }
 *     update({ actorId, id, body })       { name?, teams? } (teams: the whole list)
 *     remove({ actorId, id })             the club, its teams and memberships
 *     vmTeams({ q })                      VolleyManager team names, each with its club
 *     setAccountClubs({ actorId, userId, body })  { club_ids: [...] } (the whole list)
 *     setRule({ actorId, body })          { enabled }
 *   everyone else (lib/accounts.js)
 *     clubsOf(client, userId)             [{ id, name, teams }] of an account
 *     clubsOfMany(client, userIds)        Map userId -> [{ id, name }]
 *     ruleOn(client)                      is the rule on?
 *     verdict({ userId, access, gameN, sportType })  { ok } or { ok: false, code, home_team }
 *
 * Every answer is the { status, body } shape of lib/accounts.js. A database
 * without db/018 reads as "no clubs, rule off" (deploy order), never a 503.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { sportOf } from './officialGame.js'

export const CLUB_REQUIRED = () => fail(403, 'OV_CLUB_REQUIRED',
  'Your account has no club yet. An admin adds it before you can score official games.')
export const NOT_YOUR_CLUB = () => fail(403, 'OV_NOT_YOUR_CLUB',
  'You can score the home games of your club only.')
export const GAME_NOT_IN_SCHEDULE = () => fail(403, 'OV_GAME_NOT_IN_SCHEDULE',
  'This game is not in the VolleyManager schedule, so its home team is unknown.')

const MAX_TEAMS = 60
const MAX_CLUBS_PER_ACCOUNT = 20
// No db/018 yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])

const text = (raw, max) => {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().replace(/\s+/g, ' ')
  return s.length >= 1 && s.length <= max ? s : undefined
}

/** A club's team list from a body: unique (case-insensitive), trimmed names; undefined when invalid. */
export function teamList (raw) {
  if (!Array.isArray(raw) || raw.length > MAX_TEAMS) return undefined
  const out = []
  const seen = new Set()
  for (const t of raw) {
    const s = text(t, 200)
    if (s === undefined) return undefined
    const k = s.toLowerCase()
    if (!seen.has(k)) { seen.add(k); out.push(s) }
  }
  return out
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit (throws)
 * @param {{ invalidate?: (userId: string) => void }} [o.access]
 */
export function createClubs ({ pool, audit, access = null, logger = console } = {}) {
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
  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      log.error?.(`[clubs] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  // ---------------------------------------------------------------- reads for everyone
  /** The clubs of an account with their team names. [] without db/018. */
  async function clubsOf (client, userId) {
    if (!isUuid(userId)) return []
    try {
      const { rows } = await (client || pool).query(
        `SELECT c.id, c.name, coalesce(array_agg(ct.team_name ORDER BY lower(ct.team_name)) FILTER (WHERE ct.team_name IS NOT NULL), '{}') AS teams
           FROM public.account_clubs ac
           JOIN public.clubs c ON c.id = ac.club_id
           LEFT JOIN public.club_teams ct ON ct.club_id = c.id
          WHERE ac.user_id = $1
          GROUP BY c.id, c.name
          ORDER BY lower(c.name)`, [userId])
      return rows.map((r) => ({ id: r.id, name: r.name, teams: r.teams }))
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  /** userId -> [{ id, name }] for the admin's account list. Empty without db/018. */
  async function clubsOfMany (client, userIds) {
    const ids = [...new Set((userIds || []).filter(isUuid))]
    const out = new Map()
    if (!ids.length) return out
    try {
      const { rows } = await (client || pool).query(
        `SELECT ac.user_id, c.id, c.name FROM public.account_clubs ac JOIN public.clubs c ON c.id = ac.club_id
          WHERE ac.user_id = ANY($1::uuid[]) ORDER BY lower(c.name)`, [ids])
      for (const r of rows) {
        if (!out.has(r.user_id)) out.set(r.user_id, [])
        out.get(r.user_id).push({ id: r.id, name: r.name })
      }
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    return out
  }

  /** Is the rule on? false without db/018. */
  async function ruleOn (client) {
    try {
      const { rows: [r] } = await (client || pool).query('SELECT enabled FROM public.club_rule WHERE id')
      return r?.enabled === true
    } catch (err) {
      if (MISSING.has(err?.code)) return false
      throw err
    }
  }

  /**
   * May `userId` score official game `gameN` (the database's rule, asked
   * before the match exists)? { ok: true } or { ok: false, code, home_team,
   * clubs }. Not for beach, admins or with the rule off. Throws on a DB error.
   */
  async function verdict ({ userId, access, gameN, sportType }) {
    if (sportOf(sportType) !== 'indoor' || access?.isAdmin) return { ok: true }
    if (!(await ruleOn(pool))) return { ok: true }
    const clubs = await clubsOf(pool, userId)
    if (!clubs.length) return { ok: false, code: 'OV_CLUB_REQUIRED', home_team: null, clubs: [] }
    let home = null
    try {
      const { rows: [g] } = await pool.query(
        'SELECT team_home FROM public.svrz_games WHERE game_number = $1 AND team_home IS NOT NULL ORDER BY id DESC LIMIT 1', [String(gameN)])
      home = g?.team_home ?? null
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    const names = clubs.map((c) => c.name)
    if (!home) return { ok: false, code: 'OV_GAME_NOT_IN_SCHEDULE', home_team: null, clubs: names }
    const h = home.trim().toLowerCase()
    const mine = clubs.some((c) => c.teams.some((t) => t.trim().toLowerCase() === h))
    return mine ? { ok: true, home_team: home } : { ok: false, code: 'OV_NOT_YOUR_CLUB', home_team: home, clubs: names }
  }

  // ---------------------------------------------------------------- admin
  async function readClubs (client, where = '', values = []) {
    const { rows } = await client.query(
      `SELECT c.id, c.name, c.created_at, c.updated_at,
              coalesce((SELECT array_agg(ct.team_name ORDER BY lower(ct.team_name)) FROM public.club_teams ct WHERE ct.club_id = c.id), '{}') AS teams,
              (SELECT count(*)::int FROM public.account_clubs ac WHERE ac.club_id = c.id) AS scorers
         FROM public.clubs c ${where}
        ORDER BY lower(c.name)`, values)
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      teams: r.teams,
      scorers: r.scorers,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    }))
  }

  /** GET /api/admin/clubs */
  async function list () {
    return guarded('list', async () => {
      const { rows: [rule] } = await pool.query('SELECT enabled, changed_at FROM public.club_rule WHERE id')
      return ok({
        clubs: await readClubs(pool),
        rule: { enabled: rule?.enabled === true, changed_at: rule?.changed_at instanceof Date ? rule.changed_at.toISOString() : (rule?.changed_at ?? null) }
      })
    })
  }

  /** The team names another club already has: [{ team, club }]. */
  async function takenTeams (client, teams, exceptClubId) {
    if (!teams.length) return []
    const { rows } = await client.query(
      `SELECT ct.team_name AS team, c.name AS club FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id
        WHERE lower(btrim(ct.team_name)) = ANY($1::text[]) AND ($2::uuid IS NULL OR ct.club_id <> $2::uuid)`,
      [teams.map((t) => t.toLowerCase()), exceptClubId ?? null])
    return rows
  }
  const teamsTaken = (taken) => fail(409, 'OV_TEAM_TAKEN', 'A team plays for one club only', taken.map((t) => `${t.team}: ${t.club}`).join('; '))
  const nameTaken = () => fail(409, 'OV_CLUB_EXISTS', 'A club with this name exists')

  async function writeTeams (client, clubId, teams) {
    await client.query('DELETE FROM public.club_teams WHERE club_id = $1', [clubId])
    if (teams.length) {
      await client.query(
        'INSERT INTO public.club_teams (club_id, team_name) SELECT $1, unnest($2::text[])', [clubId, teams])
    }
  }

  /** POST /api/admin/clubs { name, teams? } */
  async function create ({ actorId, body } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('body: must be an object')
    const name = text(body.name, 120)
    if (name === undefined) return invalid('name: 1 to 120 characters')
    const teams = body.teams == null ? [] : teamList(body.teams)
    if (teams === undefined) return invalid(`teams: at most ${MAX_TEAMS} names of 1 to 200 characters`)
    return guarded('create', () => withTx(async (client) => {
      const taken = await takenTeams(client, teams, null)
      if (taken.length) throw abort(teamsTaken(taken))
      let id
      try {
        const { rows: [row] } = await client.query(
          'INSERT INTO public.clubs (name, created_by) VALUES ($1, $2) RETURNING id', [name, isUuid(actorId) ? actorId : null])
        id = row.id
      } catch (err) {
        if (err?.code === '23505') throw abort(nameTaken())
        throw err
      }
      await writeTeams(client, id, teams)
      await audit(client, { actorId, action: 'club.create', details: { club_id: id, name, teams } })
      const [club] = await readClubs(client, 'WHERE c.id = $1', [id])
      return ok({ club }, 201)
    }))
  }

  /** PATCH /api/admin/clubs/:id { name?, teams? } */
  async function update ({ actorId, id, body } = {}) {
    if (!isUuid(id)) return notFound()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('body: must be an object')
    const name = 'name' in body ? text(body.name, 120) : null
    if (name === undefined) return invalid('name: 1 to 120 characters')
    const teams = 'teams' in body ? teamList(body.teams) : null
    if (teams === undefined) return invalid(`teams: at most ${MAX_TEAMS} names of 1 to 200 characters`)
    return guarded('update', () => withTx(async (client) => {
      const { rows: [cur] } = await client.query('SELECT id, name FROM public.clubs WHERE id = $1 FOR UPDATE', [id])
      if (!cur) throw abort(notFound())
      if (name !== null && name !== cur.name) {
        try {
          await client.query('UPDATE public.clubs SET name = $2 WHERE id = $1', [id, name])
        } catch (err) {
          if (err?.code === '23505') throw abort(nameTaken())
          throw err
        }
      }
      if (teams !== null) {
        const taken = await takenTeams(client, teams, id)
        if (taken.length) throw abort(teamsTaken(taken))
        await writeTeams(client, id, teams)
        await client.query('UPDATE public.clubs SET updated_at = now() WHERE id = $1', [id])
      }
      await audit(client, { actorId, action: 'club.update', details: { club_id: id, ...(name !== null ? { name } : {}), ...(teams !== null ? { teams } : {}) } })
      const [club] = await readClubs(client, 'WHERE c.id = $1', [id])
      return ok({ club })
    }))
  }

  /** DELETE /api/admin/clubs/:id: its teams and memberships go with it. */
  async function remove ({ actorId, id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete', () => withTx(async (client) => {
      const { rows: [cur] } = await client.query('SELECT name FROM public.clubs WHERE id = $1 FOR UPDATE', [id])
      if (!cur) throw abort(notFound())
      const { rows: members } = await client.query('SELECT user_id FROM public.account_clubs WHERE club_id = $1', [id])
      await client.query('DELETE FROM public.clubs WHERE id = $1', [id])
      await audit(client, { actorId, action: 'club.delete', details: { club_id: id, name: cur.name, scorers: members.length } })
      for (const m of members) access?.invalidate?.(m.user_id)
      return ok({ deleted: id })
    }))
  }

  /**
   * GET /api/admin/club-teams?q=: the VolleyManager team names (home and away
   * of svrz_games), each with the club it is in, for the club editor.
   */
  async function vmTeams ({ q = '' } = {}) {
    if (typeof q !== 'string' || q.length > 80) return invalid('q: at most 80 characters')
    return guarded('vm-teams', async () => {
      const term = q.trim()
      const values = []
      let filter = ''
      if (term) {
        values.push('%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%')
        filter = 'WHERE t.name ILIKE $1'
      }
      const { rows } = await pool.query(
        `WITH t AS (
           SELECT DISTINCT btrim(team_home) AS name FROM public.svrz_games WHERE coalesce(btrim(team_home), '') <> ''
           UNION
           SELECT DISTINCT btrim(team_away) FROM public.svrz_games WHERE coalesce(btrim(team_away), '') <> ''
         )
         SELECT t.name, c.id AS club_id, c.name AS club_name
           FROM t
           LEFT JOIN public.club_teams ct ON lower(btrim(ct.team_name)) = lower(t.name)
           LEFT JOIN public.clubs c ON c.id = ct.club_id
          ${filter}
          ORDER BY lower(t.name)
          LIMIT 1000`, values)
      return ok({ teams: rows.map((r) => ({ name: r.name, club_id: r.club_id ?? null, club_name: r.club_name ?? null })) })
    })
  }

  /** PUT /api/admin/accounts/:id/clubs { club_ids: [...] }: the account's whole list. */
  async function setAccountClubs ({ actorId, userId, body } = {}) {
    if (!isUuid(userId)) return notFound()
    const ids = body && Array.isArray(body.club_ids) ? [...new Set(body.club_ids)] : undefined
    if (!ids || ids.length > MAX_CLUBS_PER_ACCOUNT || !ids.every(isUuid)) return invalid(`club_ids: at most ${MAX_CLUBS_PER_ACCOUNT} club ids`)
    return guarded('account-clubs', () => withTx(async (client) => {
      const { rows: [u] } = await client.query('SELECT id FROM auth.users WHERE id = $1', [userId])
      if (!u) throw abort(notFound())
      if (ids.length) {
        const { rows } = await client.query('SELECT id FROM public.clubs WHERE id = ANY($1::uuid[])', [ids])
        if (rows.length !== ids.length) throw abort(fail(404, 'OV_CLUB_NOT_FOUND', 'A club in the list does not exist'))
      }
      const before = (await clubsOf(client, userId)).map((c) => c.id)
      await client.query('DELETE FROM public.account_clubs WHERE user_id = $1 AND NOT (club_id = ANY($2::uuid[]))', [userId, ids])
      if (ids.length) {
        await client.query(
          `INSERT INTO public.account_clubs (user_id, club_id, granted_by)
           SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT (user_id, club_id) DO NOTHING`,
          [userId, ids, isUuid(actorId) ? actorId : null])
      }
      const clubs = await clubsOf(client, userId)
      await audit(client, { actorId, action: 'account.clubs', targetUserId: userId, details: { before, after: clubs.map((c) => c.id), names: clubs.map((c) => c.name) } })
      return ok({ clubs: clubs.map(({ id, name }) => ({ id, name })) })
    })).finally(() => access?.invalidate?.(userId))
  }

  /** PUT /api/admin/club-rule { enabled } */
  async function setRule ({ actorId, body } = {}) {
    if (!body || typeof body.enabled !== 'boolean') return invalid('enabled: true or false')
    return guarded('rule', () => withTx(async (client) => {
      await client.query(
        `INSERT INTO public.club_rule (id, enabled, changed_by, changed_at) VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
        [body.enabled, isUuid(actorId) ? actorId : null])
      await audit(client, { actorId, action: 'club_rule.set', details: { enabled: body.enabled } })
      return ok({ rule: { enabled: body.enabled } })
    }))
  }

  return { list, create, update, remove, vmTeams, setAccountClubs, setRule, clubsOf, clubsOfMany, ruleOn, verdict }
}
