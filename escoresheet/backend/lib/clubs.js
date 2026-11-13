/**
 * clubs — scorers score the home games of their own club (indoor; db/018,
 * docs/scorer-clubs-spec.md).
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
 *     setManagers({ actorId, id, body })  { user_ids: [...] } the club's managers (the whole list, db/020),
 *                                         each one an account linked to the club (managerCandidates)
 *     managerCandidates({ id })           the accounts linked to the club: its members (account_clubs; via
 *                                         'scorer' with that role, else 'member'),
 *                                         the managers of its teams (db/023) and its managers (db/020)
 *     inviteManager({ actorId, id, body, lang })  { email }: a club manager link (db/029) mailed to
 *                                         someone not linked to the club yet; { invite, link, mailed }
 *   club managers of that club, and admins (/api/club/:id/..., db/020)
 *     clubDetail({ id })                  the club with its teams, contact address and scorer count
 *     setContact({ actorId, id, body })   { contact_email } (null clears it)
 *     members({ id })                     the accounts that score for the club
 *     removeMember({ actorId, id, userId })  the club link; with the last one the scorer or referee
 *                                         role the club gave (and nothing else did) goes too
 *     clubInviteBody(body)                an invite code body within a club manager's limits
 *     isManager(userId, clubId)           does the account manage the club?
 *   everyone else (lib/accounts.js)
 *     clubsOf(client, userId)             [{ id, name, teams }] of an account
 *     clubsOfMany(client, userIds)        Map userId -> [{ id, name }]
 *     managedClubsOf(client, userId)      [{ id, name }] the account manages (db/020)
 *     namesOf(client, clubIds)            Map clubId -> name (the audit list, GET /api/admin/audit)
 *     ruleOn(client)                      is the rule on?
 *     verdict({ userId, access, gameN, sportType })  { ok } or { ok: false, code, home_team }
 *     todayGames({ userId, refereeDob })  today's home games of the account's clubs (GET /api/games/today)
 *
 * Every answer is the { status, body } shape of lib/accounts.js. A database
 * without db/018 reads as "no clubs, rule off" (deploy order), never a 503.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf, sportOf } from './officialGame.js'
import { pickLang } from './mailer.js'

export const CLUB_REQUIRED = () => fail(403, 'OV_CLUB_REQUIRED',
  'Your account has no club yet. An admin adds it before you can score official games.')
export const NOT_YOUR_CLUB = () => fail(403, 'OV_NOT_YOUR_CLUB',
  'You can score the home games of your club only.')
export const GAME_NOT_IN_SCHEDULE = () => fail(403, 'OV_GAME_NOT_IN_SCHEDULE',
  'This game is not in the VolleyManager schedule, so its home team is unknown.')

const MAX_TEAMS = 60
const MAX_CLUBS_PER_ACCOUNT = 20
const MAX_MANAGERS = 10
// A club manager's invite codes (owner, 2026-10-29): scorer or referee, the
// club fixed, at most 50 uses, never unlimited, gone after 90 days at most
export const CLUB_INVITE_ROLES = Object.freeze(['scorer', 'referee'])
export const CLUB_INVITE_MAX_USES = 50
export const CLUB_INVITE_MAX_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
// The schedule fields the scorer app maps into a match (LoadOfficialMatchModal
// mapSupabaseToMatchFormat): read through to_jsonb, so a column a schedule
// lacks reads as null instead of failing
const SCHEDULE_FIELDS = Object.freeze([
  'game_number', 'datetime', 'date', 'time', 'city', 'hall', 'hall_address', 'hall_postal_code',
  'match_type', 'championship_type', 'gender', 'match_level', 'league', 'match_format', 'team_home', 'team_away',
  'referee_1_first_name', 'referee_1_last_name', 'referee_1_dob', 'referee_2_first_name', 'referee_2_last_name', 'referee_2_dob',
  'linesman_1', 'linesman_2', 'group_display'
])
// Null unless the account fills the sheet's officials (todayGames refereeDob;
// the same rule as /api/db, server.js REFEREE_DOB_SPORTS)
const REFEREE_DOB_FIELDS = Object.freeze(['referee_1_dob', 'referee_2_dob'])
const zurichDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' })
/** Europe/Zurich calendar day of `d` as YYYY-MM-DD. */
export const zurichDay = (d = new Date()) => zurichDayFmt.format(d)
const nextDay = (day) => {
  const t = new Date(`${day}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
// No db/018 yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])

const text = (raw, max) => {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().replace(/\s+/g, ' ')
  return s.length >= 1 && s.length <= max ? s : undefined
}

/** A contact address from a body: the trimmed, lower-case address, null to clear it, undefined when invalid. */
export function contactEmail (raw) {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (s === '') return null
  return s.length >= 3 && s.length <= 254 && EMAIL_RE.test(s) ? s : undefined
}

/**
 * A club manager's invite code body: { label, role, max_uses, expires_at }
 * within the limits above (defaults: scorer, 1 use, 30 days), or { error }.
 * The club and the sport are the route's, never the body's.
 */
export function clubInviteBody (body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body: must be an object' }
  const role = body.role == null ? 'scorer' : body.role
  if (!CLUB_INVITE_ROLES.includes(role)) return { error: 'role: scorer or referee' }
  let maxUses = 1
  if (body.max_uses != null) {
    maxUses = Number.isInteger(body.max_uses) ? body.max_uses : NaN
    if (!(maxUses >= 1 && maxUses <= CLUB_INVITE_MAX_USES)) return { error: `max_uses: 1 to ${CLUB_INVITE_MAX_USES}` }
  }
  let expires = new Date(now + 30 * DAY_MS)
  if (body.expires_at != null) {
    expires = typeof body.expires_at === 'string' ? new Date(body.expires_at) : null
    if (!expires || Number.isNaN(expires.getTime())) return { error: 'expires_at: an ISO date-time' }
    if (expires.getTime() > now + CLUB_INVITE_MAX_DAYS * DAY_MS) return { error: `expires_at: at most ${CLUB_INVITE_MAX_DAYS} days ahead` }
  }
  return { body: { label: body.label, role, max_uses: maxUses, expires_at: expires.toISOString() } }
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
// A club manager link (db/029): one use, two weeks
export const MANAGER_LINK_DAYS = 14

export function createClubs ({ pool, audit, access = null, createInvite = null, mailer = null, logger = console } = {}) {
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

  /** clubId -> name of the clubs that still exist (the audit list names them). Empty without db/018. */
  async function namesOf (client, clubIds) {
    const ids = [...new Set((clubIds || []).filter(isUuid))]
    const out = new Map()
    if (!ids.length) return out
    try {
      const { rows } = await (client || pool).query('SELECT id, name FROM public.clubs WHERE id = ANY($1::uuid[])', [ids])
      for (const r of rows) out.set(r.id, r.name)
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    return out
  }

  /** The clubs an account manages: [{ id, name }]. [] without db/020. */
  async function managedClubsOf (client, userId) {
    if (!isUuid(userId)) return []
    try {
      const { rows } = await (client || pool).query(
        `SELECT c.id, c.name FROM public.club_managers cm JOIN public.clubs c ON c.id = cm.club_id
          WHERE cm.user_id = $1 ORDER BY lower(c.name)`, [userId])
      return rows.map((r) => ({ id: r.id, name: r.name }))
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  /** Does `userId` manage club `clubId`? false without db/020. Throws on a DB error. */
  async function isManager (userId, clubId) {
    if (!isUuid(userId) || !isUuid(clubId)) return false
    try {
      const { rows } = await pool.query('SELECT 1 FROM public.club_managers WHERE club_id = $1 AND user_id = $2', [clubId, userId])
      return rows.length > 0
    } catch (err) {
      if (MISSING.has(err?.code)) return false
      throw err
    }
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

  /**
   * GET /api/games/today: today's (Europe/Zurich) games whose HOME team is of
   * one of the account's clubs (owner, 2026-10-29: the club scores its home
   * games), each with the schedule fields the app fills the match from and
   * whether a match claims it already (`claim`: { mine, closed } or null).
   * The referees' dates of birth only with `refereeDob` (the account can
   * score indoor), else null. No club: no games. [] without db/018.
   */
  async function todayGames ({ userId, refereeDob = false, now = new Date() } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    return guarded('today-games', async () => {
      const day = zurichDay(now)
      const clubs = await clubsOf(pool, userId)
      const teams = new Map()
      for (const c of clubs) for (const t of c.teams) teams.set(t.trim().toLowerCase(), c.name)
      if (!teams.size) return ok({ day, clubs: clubs.map((c) => c.name), games: [] })
      const { rows } = await pool.query(
        `SELECT to_jsonb(g) AS g FROM public.svrz_games g
          WHERE g.datetime >= $1 AND g.datetime < $2 AND lower(btrim(g.team_home)) = ANY($3::text[])
          ORDER BY g.datetime, g.game_number
          LIMIT 200`, [day, nextDay(day), [...teams.keys()]])
      const games = rows.map((r) => Object.fromEntries(SCHEDULE_FIELDS.map((k) => [k, !refereeDob && REFEREE_DOB_FIELDS.includes(k) ? null : (r.g[k] ?? null)])))
      const numbers = [...new Set(games.map((g) => Number(g.game_number)).filter((n) => Number.isInteger(n) && n > 0))]
      const claims = new Map()
      if (numbers.length) {
        const { rows: ms } = await pool.query(
          `SELECT m.game_n, m.created_by, m.closed_at, m.scheduled_at, m.created_at FROM public.matches m
            WHERE m.test IS NOT TRUE AND NOT m.official_game_exempt AND m.game_n = ANY($1::int[])
              AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE`, [numbers])
        for (const m of ms) {
          const key = `${m.game_n}|${seasonOf(m.scheduled_at || m.created_at)}`
          if (!claims.has(key)) claims.set(key, m)
        }
      }
      return ok({
        day,
        clubs: clubs.map((c) => c.name),
        games: games.map((g) => {
          const m = claims.get(`${Number(g.game_number)}|${seasonOf(g.datetime)}`)
          return {
            ...g,
            club: teams.get(String(g.team_home || '').trim().toLowerCase()) ?? null,
            claim: m ? { mine: m.created_by === userId, closed: m.closed_at != null } : null
          }
        })
      })
    })
  }

  // ---------------------------------------------------------------- admin
  async function readClubs (client, where = '', values = []) {
    const { rows } = await client.query(
      `SELECT c.id, c.name, c.created_at, c.updated_at, c.contact_email,
              coalesce((SELECT array_agg(ct.team_name ORDER BY lower(ct.team_name)) FROM public.club_teams ct WHERE ct.club_id = c.id), '{}') AS teams,
              -- db/030: club and team managers are members too; the count is of scorers
              (SELECT count(*)::int FROM public.account_clubs ac JOIN public.profiles sp ON sp.user_id = ac.user_id
                WHERE ac.club_id = c.id AND 'scorer' = ANY (sp.roles)) AS scorers,
              coalesce((SELECT json_agg(json_build_object('user_id', u.id, 'email', u.email, 'name', ${nameSql('p')}) ORDER BY lower(u.email))
                          FROM public.club_managers cm JOIN auth.users u ON u.id = cm.user_id
                          LEFT JOIN public.profiles p ON p.user_id = u.id
                         WHERE cm.club_id = c.id), '[]') AS managers
         FROM public.clubs c ${where}
        ORDER BY lower(c.name)`, values)
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      teams: r.teams,
      scorers: r.scorers,
      contact_email: r.contact_email ?? null,
      managers: r.managers,
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

  // A diff, not delete-and-insert: a team that stays keeps its row, so its id
  // and its team managers (db/023) stay too; a new spelling of the same name
  // (case, spaces) is written in place.
  async function writeTeams (client, clubId, teams) {
    const { rows: cur } = await client.query('SELECT team_name FROM public.club_teams WHERE club_id = $1', [clubId])
    const want = new Map(teams.map((t) => [t.trim().toLowerCase(), t]))
    const have = new Map(cur.map((r) => [r.team_name.trim().toLowerCase(), r.team_name]))
    const gone = cur.filter((r) => !want.has(r.team_name.trim().toLowerCase())).map((r) => r.team_name)
    if (gone.length) await client.query('DELETE FROM public.club_teams WHERE club_id = $1 AND team_name = ANY($2::text[])', [clubId, gone])
    for (const [k, name] of want) {
      const old = have.get(k)
      if (old !== undefined && old !== name) await client.query('UPDATE public.club_teams SET team_name = $3 WHERE club_id = $1 AND team_name = $2', [clubId, old, name])
    }
    const added = [...want].filter(([k]) => !have.has(k)).map(([, name]) => name)
    if (added.length) {
      await client.query(
        'INSERT INTO public.club_teams (club_id, team_name) SELECT $1, unnest($2::text[])', [clubId, added])
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
    const contact = 'contact_email' in body ? contactEmail(body.contact_email) : false
    if (contact === undefined) return invalid('contact_email: an email address, or null')
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
      if (contact !== false) await client.query('UPDATE public.clubs SET contact_email = $2 WHERE id = $1', [id, contact])
      await audit(client, { actorId, action: 'club.update', details: { club_id: id, ...(name !== null ? { name } : {}), ...(teams !== null ? { teams } : {}), ...(contact !== false ? { contact_email: contact !== null } : {}) } })
      const [club] = await readClubs(client, 'WHERE c.id = $1', [id])
      return ok({ club })
    }))
  }

  /**
   * DELETE /api/admin/clubs/:id: its teams and memberships go with it, and its
   * open codes are revoked first (be-clubs-teams-8: invite_codes.club_id is
   * ON DELETE SET NULL, so a scorer code of the club would go on giving the
   * role without a club).
   */
  async function remove ({ actorId, id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('delete', () => withTx(async (client) => {
      const { rows: [cur] } = await client.query('SELECT name FROM public.clubs WHERE id = $1 FOR UPDATE', [id])
      if (!cur) throw abort(notFound())
      const { rows: members } = await client.query('SELECT user_id FROM public.account_clubs WHERE club_id = $1', [id])
      const { rows: revoked } = await client.query(
        'UPDATE public.invite_codes SET revoked_at = now() WHERE club_id = $1 AND revoked_at IS NULL RETURNING id, label', [id])
      for (const r of revoked) {
        await audit(client, { actorId, action: 'invite.revoke', details: { invite_id: r.id, label: r.label, reason: 'club_deleted' }, app: 'indoor' })
      }
      await client.query('DELETE FROM public.clubs WHERE id = $1', [id])
      await audit(client, { actorId, action: 'club.delete', details: { club_id: id, name: cur.name, scorers: members.length, codes_revoked: revoked.length } })
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

  /** PUT /api/admin/clubs/:id/managers { emails: [...] }: the club's whole list of managers. */
  /**
   * The accounts linked to club `id` (as a client query): its scorers, the
   * managers of its teams and its managers, each once, with how it is linked.
   */
  async function candidatesOf (client, id) {
    let teamPart = ''
    const { rows: [t] } = await client.query("SELECT to_regclass('public.team_managers') IS NOT NULL AS ok")
    if (t?.ok) {
      teamPart = `UNION ALL SELECT tm.user_id, 'team_manager' FROM public.team_managers tm
                    JOIN public.club_teams ct ON ct.id = tm.team_id WHERE ct.club_id = $1`
    }
    const { rows } = await client.query(
      `SELECT u.id, u.email, ${nameSql('p')} AS name, array_agg(DISTINCT l.via ORDER BY l.via) AS via
         FROM (SELECT ac.user_id, CASE WHEN 'scorer' = ANY (coalesce(sp.roles, '{}')) THEN 'scorer' ELSE 'member' END AS via
                 FROM public.account_clubs ac LEFT JOIN public.profiles sp ON sp.user_id = ac.user_id WHERE ac.club_id = $1
               UNION ALL SELECT cm.user_id, 'club_manager' FROM public.club_managers cm WHERE cm.club_id = $1
               ${teamPart}) l
         JOIN auth.users u ON u.id = l.user_id
         LEFT JOIN public.profiles p ON p.user_id = u.id
        GROUP BY u.id, u.email, p.first_name, p.last_name
        ORDER BY lower(coalesce(${nameSql('p')}, u.email))
        LIMIT 1000`, [id])
    // db/030: managers are members too; "member" only when nothing says more
    return rows.map((r) => {
      const via = r.via || []
      return { id: r.id, email: r.email, name: r.name ?? null, via: via.length > 1 ? via.filter((v) => v !== 'member') : via }
    })
  }

  /** GET /api/admin/clubs/:id/manager-candidates: who may be picked as a manager of the club. */
  async function managerCandidates ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('manager-candidates', async () => {
      const { rows: [c] } = await pool.query('SELECT id FROM public.clubs WHERE id = $1', [id])
      if (!c) return notFound()
      return ok({ candidates: await candidatesOf(pool, id) })
    })
  }

  /**
   * PUT /api/admin/clubs/:id/managers { user_ids }: the club's managers, the
   * whole list. Each one is an account linked to the club (owner 2026-11-11:
   * "managers can be picked from members of that club ... no random
   * emails"); anyone else gets a link (inviteManager).
   */
  async function setManagers ({ actorId, id, body } = {}) {
    if (!isUuid(id)) return notFound()
    const raw = body && Array.isArray(body.user_ids) ? body.user_ids : undefined
    const ids = raw && raw.every(isUuid) ? [...new Set(raw.map((x) => x.toLowerCase()))] : undefined
    if (!ids || ids.length > MAX_MANAGERS) return invalid(`user_ids: at most ${MAX_MANAGERS} account ids`)
    return guarded('managers', () => withTx(async (client) => {
      const { rows: [cur] } = await client.query('SELECT id FROM public.clubs WHERE id = $1 FOR UPDATE', [id])
      if (!cur) throw abort(notFound())
      const linked = new Set((await candidatesOf(client, id)).map((x) => x.id))
      const outside = ids.filter((x) => !linked.has(x))
      if (outside.length) {
        throw abort(fail(422, 'OV_NOT_A_CLUB_MEMBER', 'Pick a manager from the club\'s accounts, or send a club manager link', outside.join(', ')))
      }
      const { rows: before } = await client.query('SELECT user_id FROM public.club_managers WHERE club_id = $1', [id])
      await client.query('DELETE FROM public.club_managers WHERE club_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [id, ids])
      if (ids.length) {
        await client.query(
          `INSERT INTO public.club_managers (club_id, user_id, added_by)
           SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT (club_id, user_id) DO NOTHING`,
          [id, ids, isUuid(actorId) ? actorId : null])
      }
      await audit(client, { actorId, action: 'club.managers', details: { club_id: id, before: before.map((r) => r.user_id), after: ids } })
      const [club] = await readClubs(client, 'WHERE c.id = $1', [id])
      return ok({ club })
    })).finally(() => {
      // the managed clubs come with /api/me (lib/access.js)
      for (const x of ids || []) access?.invalidate?.(x)
    })
  }

  /**
   * POST /api/admin/clubs/:id/manager-invites { email }: a one-use club
   * manager link (db/029, two weeks) for someone not linked to the club,
   * mailed to `email` (lib/mailer.js club_manager_invite) and answered too,
   * so the admin can pass it on when the mail does not arrive. The link works
   * for an account of that address only (db/036 invited_email; another
   * account answers 403 OV_INVITE_OTHER_ACCOUNT). { invite, link, mailed }
   */
  async function inviteManager ({ actorId, id, body, lang = null } = {}) {
    if (!isUuid(id)) return notFound()
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return invalid('email: an email address')
    if (!createInvite) return notFound()
    let club, inviter
    try {
      ({ rows: [club] } = await pool.query('SELECT id, name FROM public.clubs WHERE id = $1', [id]))
      if (!club) return notFound()
      ;({ rows: [inviter] } = await pool.query(
        `SELECT ${nameSql('p')} AS name FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id WHERE u.id = $1`, [actorId]))
    } catch (err) {
      log.error?.(`[clubs] manager invite failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
    const made = await createInvite({
      actorId,
      body: { label: `Club manager · ${email}`.slice(0, 120), role: 'club_manager', club_id: id, sport: 'indoor', max_uses: 1, expires_at: new Date(Date.now() + MANAGER_LINK_DAYS * DAY_MS).toISOString(), invited_email: email },
      app: 'indoor'
    })
    if (made.status !== 201) return made
    const { invite, code } = made.body.data
    const base = String(mailer?.managerUrl || 'https://manager.openvolley.app').replace(/\/+$/, '')
    const link = `${base}/#club=${encodeURIComponent(code)}`
    let mailed = false
    if (mailer?.enabled) {
      try {
        const r = await mailer.send('club_manager_invite', { to: email, lang: pickLang(body?.lang, lang), link, vars: { club: club.name, inviter: inviter?.name || '', days: String(MANAGER_LINK_DAYS) } })
        mailed = r?.sent === true
      } catch (err) {
        log.error?.(`[clubs] club manager link mail failed: ${String(err?.code || err?.message || err).slice(0, 120)}`)
      }
    }
    return ok({ invite, link, code, mailed }, 201)
  }


  // ---------------------------------------------------------------- club managers
  /** GET /api/club/:id: the club as its manager sees it (no other club's data). */
  async function clubDetail ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('club', async () => {
      const [club] = await readClubs(pool, 'WHERE c.id = $1', [id])
      if (!club) return notFound()
      return ok({ club })
    })
  }

  /** PATCH /api/club/:id { contact_email }: where the club's final scoresheets go (step 4). */
  async function setContact ({ actorId, id, body } = {}) {
    if (!isUuid(id)) return notFound()
    if (!body || typeof body !== 'object' || !('contact_email' in body)) return invalid('contact_email: an email address, or null')
    const contact = contactEmail(body.contact_email)
    if (contact === undefined) return invalid('contact_email: an email address, or null')
    return guarded('contact', () => withTx(async (client) => {
      const { rowCount } = await client.query('UPDATE public.clubs SET contact_email = $2 WHERE id = $1', [id, contact])
      if (!rowCount) throw abort(notFound())
      await audit(client, { actorId, action: 'club.contact', details: { club_id: id, set: contact !== null } })
      const [club] = await readClubs(client, 'WHERE c.id = $1', [id])
      return ok({ club })
    }))
  }

  /** GET /api/club/:id/members: the accounts that score for the club. */
  async function members ({ id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('members', async () => {
      const { rows: [c] } = await pool.query('SELECT id FROM public.clubs WHERE id = $1', [id])
      if (!c) return notFound()
      const { rows } = await pool.query(
        `SELECT u.id, u.email, ${nameSql('p')} AS name, coalesce(p.roles, '{}') AS roles, ac.granted_at,
                EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.club_id = ac.club_id AND cm.user_id = u.id) AS manager
           FROM public.account_clubs ac
           JOIN auth.users u ON u.id = ac.user_id
           LEFT JOIN public.profiles p ON p.user_id = u.id
          WHERE ac.club_id = $1
          ORDER BY lower(coalesce(${nameSql('p')}, u.email))
          LIMIT 1000`, [id])
      return ok({
        members: rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name ?? null,
          // the indoor roles only: what the account may do for the club
          roles: (r.roles || []).filter((x) => ['scorer', 'referee', 'competition_manager', 'admin', 'super_admin'].includes(x)),
          manager: r.manager === true,
          joined_at: r.granted_at instanceof Date ? r.granted_at.toISOString() : r.granted_at
        }))
      })
    })
  }

  /**
   * DELETE /api/club/:id/members/:userId: the club link. Its last club link
   * gone, the account also loses a scorer or referee role this club gave it
   * (be-clubs-teams-7: a code of the club, or a request the club approved)
   * and nothing else gave (another club's code or none, an admin's grant);
   * the account and its other roles stay. { removed, roles_removed }
   */
  async function removeMember ({ actorId, id, userId } = {}) {
    if (!isUuid(id) || !isUuid(userId)) return notFound()
    return guarded('remove-member', () => withTx(async (client) => {
      const { rowCount } = await client.query('DELETE FROM public.account_clubs WHERE club_id = $1 AND user_id = $2', [id, userId])
      if (!rowCount) throw abort(notFound())
      await audit(client, { actorId, action: 'club.member_remove', targetUserId: userId, details: { club_id: id } })
      const rolesRemoved = await dropClubRoles(client, { actorId, clubId: id, userId })
      return ok({ removed: userId, roles_removed: rolesRemoved })
    })).finally(() => access?.invalidate?.(userId))
  }

  /**
   * The scorer / referee roles club `clubId` gave `userId` and nothing else
   * did, taken away when the account is in no club any more (inside
   * removeMember's transaction; audited account.roles). Returns the roles
   * removed. Where a role came from is read from the audit: invite.redeem of
   * a code (its club), account.request_approve (the club of the part) and
   * account.roles (an admin's grant, or the role an approved request added in
   * the same transaction).
   */
  async function dropClubRoles (client, { actorId, clubId, userId }) {
    const { rows: [other] } = await client.query('SELECT 1 FROM public.account_clubs WHERE user_id = $1 LIMIT 1', [userId])
    if (other) return []
    const { rows: [prof] } = await client.query('SELECT roles FROM public.profiles WHERE user_id = $1 LIMIT 1 FOR UPDATE', [userId])
    const before = Array.isArray(prof?.roles) ? prof.roles : []
    const held = CLUB_INVITE_ROLES.filter((r) => before.includes(r))
    if (!held.length) return []
    const { rows } = await client.query(
      `SELECT r.role FROM unnest($3::text[]) AS r(role)
        WHERE EXISTS (SELECT 1 FROM public.audit_log a
                       WHERE a.target_user_id = $1
                         AND ((a.action = 'invite.redeem' AND a.details ->> 'role' = r.role
                               AND EXISTS (SELECT 1 FROM public.invite_codes i WHERE i.id::text = a.details ->> 'invite_id' AND i.club_id::text = $2::text))
                           OR (a.action = 'account.request_approve' AND a.details ->> 'kind' = r.role AND a.details ->> 'club_id' = $2::text)))
          AND NOT EXISTS (SELECT 1 FROM public.audit_log a
                           WHERE a.target_user_id = $1
                             AND ((a.action = 'invite.redeem' AND a.details ->> 'role' = r.role
                                   AND NOT EXISTS (SELECT 1 FROM public.invite_codes i WHERE i.id::text = a.details ->> 'invite_id' AND i.club_id::text = $2::text))
                               OR (a.action = 'account.request_approve' AND a.details ->> 'kind' = r.role
                                   AND a.details ->> 'club_id' IS DISTINCT FROM $2::text)
                               OR (a.action = 'account.roles' AND coalesce(a.details -> 'added', '[]'::jsonb) ? r.role
                                   AND NOT EXISTS (SELECT 1 FROM public.audit_log q
                                                    WHERE q.action = 'account.request_approve' AND q.target_user_id = $1 AND q.at = a.at
                                                      AND q.details ->> 'kind' = r.role AND q.details ->> 'club_id' = $2::text))))`,
      [userId, clubId, held])
    const removed = rows.map((r) => r.role)
    if (!removed.length) return []
    const after = before.filter((r) => !removed.includes(r))
    await client.query('UPDATE public.profiles SET roles = $2::text[] WHERE user_id = $1', [userId, after])
    await audit(client, { actorId, action: 'account.roles', targetUserId: userId, details: { added: [], removed, before, after, club_id: clubId, reason: 'club_member_remove' }, app: 'indoor' })
    return removed
  }

  return {
    list, create, update, remove, vmTeams, setAccountClubs, setRule, setManagers, managerCandidates, inviteManager,
    clubDetail, setContact, members, removeMember, isManager,
    clubsOf, clubsOfMany, managedClubsOf, namesOf, ruleOn, verdict, todayGames
  }
}
