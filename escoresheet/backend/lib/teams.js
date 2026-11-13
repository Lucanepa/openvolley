/**
 * teams — team managers and the roster a team sends for a game before the
 * scorer opens it (db/023, docs/team-managers-spec.md).
 *
 * A team is a VolleyManager team name of a club (public.club_teams, with its
 * own id since db/023). Its team managers (team_managers), the managers of its
 * club (club_managers, db/020) and admins may:
 *   teamDetail({ teamId })                      the team and its club
 *   squad({ teamId })                           the saved team of the current season, or null
 *   putSquad({ actorId, teamId, body })         { players, staff }: creates the saved team when needed
 *                                               (db/024: 400 OV_WRONG_GENDER for a player of the
 *                                               club's players list with the other gender than the team's;
 *                                               the players only: an official may be anyone of the club)
 *   games({ teamId })                           the team's games from today, each with its roster summary
 *   getRoster({ teamId, game })                 the team's roster of game `game`, or null
 *   putRoster({ actorId, teamId, game, body })  { players, staff, coach_signature?, captain_signature? }, any time
 *                                               (OV_WRONG_GENDER as putSquad)
 *   deleteRoster({ actorId, teamId, game })
 * Club managers of the club (and admins):
 *   clubTeams({ clubId })                       the club's teams with their managers
 *   teamInviteBody(body)                        a team link within the limits below
 *   removeManager({ actorId, clubId, teamId, userId })  the team links it redeemed are revoked too
 * Scorers (indoor canReadTeams, the read right of the saved teams):
 *   scorerRosters({ userId, games })            the sent rosters the scoring tablet keeps
 *   markUsed({ userId, body })                  accepted in Match Setup (who, which match)
 * Everyone else (lib/accounts.js, lib/manageApi.js):
 *   managedTeamsOf(client, userId, { all })     [{ id, name, club_id, club_name, via }] (/api/me; all: admins)
 *   mayManage({ userId, access, teamId })       may the account act for the team?
 *   teamOfClub(clubId, teamId)                  is the team one of the club's?
 *
 * Personal data (names, dates of birth, licence numbers): served only through
 * these routes, never on the /api/db allowlist, never anonymous; the audit
 * keeps game numbers, sides and counts only. Owner 2026-11-08: a sent roster
 * has no lock (the team may change it at any time). db/035: it is read and
 * accepted only by the home club's scorers, the match holder and the sending
 * team, every read is audited, accepting records the match, and every row
 * goes at expires_at, 14 days after its game (sweep(), on a timer).
 *
 * Every answer is the { status, body } shape of lib/accounts.js; nothing
 * throws. A database without db/023 answers "no teams" to the reads that
 * /api/me makes, never a 503.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf } from './officialGame.js'
import { STAFF_ROLES, validateRoster } from './savedTeams.js'
import { zurichDay } from './clubs.js'
import { WRONG_GENDER, teamGenderOf } from './licences.js'
import { connectClient } from './pgClient.js'
import { createHash } from 'node:crypto'

// A team link (owner, 2026-11-08): a few uses, never unlimited, gone after 90 days at most
export const TEAM_INVITE_MAX_USES = 10
export const TEAM_INVITE_MAX_DAYS = 90
export const TEAM_INVITE_DEFAULT_USES = 3
export const TEAM_INVITE_DEFAULT_DAYS = 30
// FIVB 4.1.1 (and VolleyManager's own limit): 14 players on the scoresheet, two liberos at most
export const GAME_ROSTER_MAX_PLAYERS = 14
// at most 12 players besides the liberos: 13 or 14 only with two liberos
export const GAME_ROSTER_MAX_REGULAR = 12
export const GAME_ROSTER_MAX_LIBEROS = 2
export const GAME_ROSTER_MAX_STAFF = 5
// What a scoring tablet downloads ahead, and how long a sent roster stays
export const SCORER_AHEAD_DAYS = 7
export const ROSTER_KEEP_DAYS = 14
export const MAX_GAMES_PER_READ = 50
const SWEEP_EVERY_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const GAME_RE = /^[0-9]{1,12}$/
// No db/023 yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export const NOT_YOUR_GAME = () => fail(404, 'OV_GAME_NOT_YOURS', 'This game is not one of the team\'s games in the schedule')
// A signature made ahead: the pad's PNG data URL (db/023 CHECK)
export const SIGNATURE_MAX_LENGTH = 200000
const SIGNATURE_PREFIX = 'data:image/png;base64,'
export const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

/** '2026/27' for season year 2026 (the saved teams' season label). */
/** db/035: what a signature made ahead was made on (the players and staff as stored). */
export const rosterHash = (v) => createHash('sha256').update(JSON.stringify({ players: v.players, staff: v.staff })).digest('hex')

export const seasonLabel = (year) => `${year}/${String((year + 1) % 100).padStart(2, '0')}`

const zurichClockFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})
/** Europe/Zurich wall-clock time of `d` as YYYY-MM-DDTHH:MM:SS. */
export function zurichClock (d = new Date()) {
  const p = Object.fromEntries(zurichClockFmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

/**
 * Has a game whose svrz_games.datetime is `kickoff` started at `now`? A value
 * with Z or an offset is an instant; one without is a Zurich wall-clock time
 * (lib/vmSync.js). No kick-off known: not started.
 */
export function kickoffPassed (kickoff, now = new Date()) {
  if (typeof kickoff !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(kickoff)) return false
  if (/(Z|[+-]\d\d:?\d\d)$/.test(kickoff)) {
    const t = Date.parse(kickoff)
    return Number.isFinite(t) && now.getTime() >= t
  }
  const wall = kickoff.length >= 19 ? kickoff.slice(0, 19) : (kickoff.length === 16 ? `${kickoff}:00` : `${kickoff.slice(0, 10)}T23:59:59`)
  return zurichClock(now) >= wall.replace(' ', 'T')
}

const addDays = (day, n) => {
  const t = new Date(`${day}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

/**
 * A club manager's team link body: { label, max_uses, expires_at } within the
 * limits above (defaults: 3 uses, 30 days), or { error }. The team, its club
 * and the role are the route's, never the body's.
 */
export function teamInviteBody (body, now = Date.now()) {
  if (body == null) body = {}
  if (!isPlainObject(body)) return { error: 'body: must be an object' }
  let maxUses = TEAM_INVITE_DEFAULT_USES
  if (body.max_uses != null) {
    maxUses = Number.isInteger(body.max_uses) ? body.max_uses : NaN
    if (!(maxUses >= 1 && maxUses <= TEAM_INVITE_MAX_USES)) return { error: `max_uses: 1 to ${TEAM_INVITE_MAX_USES}` }
  }
  let expires = new Date(now + TEAM_INVITE_DEFAULT_DAYS * DAY_MS)
  if (body.expires_at != null) {
    expires = typeof body.expires_at === 'string' ? new Date(body.expires_at) : null
    if (!expires || Number.isNaN(expires.getTime())) return { error: 'expires_at: an ISO date-time' }
    if (expires.getTime() <= now) return { error: 'expires_at: must be in the future' }
    if (expires.getTime() > now + TEAM_INVITE_MAX_DAYS * DAY_MS) return { error: `expires_at: at most ${TEAM_INVITE_MAX_DAYS} days ahead` }
  }
  return { body: { max_uses: maxUses, expires_at: expires.toISOString() } }
}

/**
 * A game roster body { players, staff }: the saved-team rules (names, dates
 * of birth, licence numbers, one captain, distinct numbers), and for one game
 * at most 14 players (more than 12 only with 2 liberos), every one with a
 * shirt number, at most 2 liberos, at most 5 team officials with each role once. { players, staff } (as stored)
 * or { error } (a 400 answer).
 */
export function validateGameRoster (body) {
  const v = validateRoster(body, { sport: 'indoor' })
  if (v.error) return v
  if (v.players.length > GAME_ROSTER_MAX_PLAYERS) return { error: invalid(`players: at most ${GAME_ROSTER_MAX_PLAYERS} for a game`) }
  if (v.staff.length > GAME_ROSTER_MAX_STAFF) return { error: invalid(`staff: at most ${GAME_ROSTER_MAX_STAFF} for a game`) }
  let liberos = 0
  for (let i = 0; i < v.players.length; i++) {
    const p = v.players[i]
    if (p.number == null) return { error: invalid(`players[${i}].number: required for a game`) }
    if (!p.active) return { error: invalid(`players[${i}].active: every player of a game roster plays`) }
    if (p.is_libero && ++liberos > GAME_ROSTER_MAX_LIBEROS) return { error: invalid(`players[${i}].is_libero: at most ${GAME_ROSTER_MAX_LIBEROS} liberos`) }
  }
  // 13 or 14 players only with two liberos: at most 12 others (owner 2026-11-11)
  if (v.players.length > GAME_ROSTER_MAX_REGULAR && liberos < GAME_ROSTER_MAX_LIBEROS) {
    return { error: invalid(`players: more than ${GAME_ROSTER_MAX_REGULAR} only with ${GAME_ROSTER_MAX_LIBEROS} liberos`) }
  }
  const roles = new Set()
  for (let i = 0; i < v.staff.length; i++) {
    if (roles.has(v.staff[i].role)) return { error: invalid(`staff[${i}].role: ${v.staff[i].role} is there twice`) }
    roles.add(v.staff[i].role)
  }
  // Signed ahead if they want to (owner 2026-11-08): the coach's needs a Coach,
  // the captain's a captain; absent or null = not signed
  const signatures = {}
  for (const [k, needs, ok] of [
    ['coach_signature', 'a Coach in staff', v.staff.some((x) => x.role === 'Coach')],
    ['captain_signature', 'a captain in players', v.players.some((x) => x.is_captain)]
  ]) {
    const raw = body[k]
    if (raw == null || raw === '') { signatures[k] = null; continue }
    if (typeof raw !== 'string' || !raw.startsWith(SIGNATURE_PREFIX) || raw.length > SIGNATURE_MAX_LENGTH || !SIGNATURE_RE.test(raw)) {
      return { error: invalid(`${k}: a PNG data URL of at most ${SIGNATURE_MAX_LENGTH} characters, or null`) }
    }
    if (!ok) return { error: invalid(`${k}: needs ${needs}`) }
    signatures[k] = raw
  }
  const person = (p) => ({ first_name: p.first_name, last_name: p.last_name, dob: p.dob, license_number: p.license_number })
  return {
    players: v.players.map((p) => ({ number: p.number, ...person(p), is_libero: p.is_libero, is_captain: p.is_captain })),
    staff: v.staff
      .map((s) => ({ role: s.role, ...person(s) }))
      .sort((a, b) => STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role)),
    ...signatures
  }
}

const SVRZ_GENDER = {
  men: ['m', 'men', 'male', 'h', 'herren', 'hommes', 'uomini', 'masculin'],
  women: ['f', 'w', 'women', 'female', 'd', 'damen', 'dames', 'donne', 'feminin', 'féminin']
}
const genderOf = (raw) => {
  const g = key(raw)
  if (SVRZ_GENDER.men.includes(g)) return 'men'
  if (SVRZ_GENDER.women.includes(g)) return 'women'
  return null
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit (throws)
 * @param {object} o.savedTeams  lib/savedTeams.js (the squad is a saved team)
 * @param {object} o.clubs  lib/clubs.js (clubsOf: the clubs a scorer scores for)
 * @param {object} [o.licences]  lib/licences.js (db/024: a player of the club's players list
 *   with the other gender than the team's is refused, OV_WRONG_GENDER)
 */
export function createTeams ({ pool, audit, savedTeams, clubs, licences = null, logger = console, clock = () => new Date() } = {}) {
  const log = logger
  let lastSweep = 0

  async function withTx (fn) {
    const client = await connectClient(pool, log)
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
      log.error?.(`[teams] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /**
   * Delete the rosters of games that were more than ROSTER_KEEP_DAYS ago (at
   * most once an hour per process; never fails the request it runs in).
   */
  async function sweep ({ force = false } = {}) {
    const now = clock()
    if (!force && now.getTime() - lastSweep < SWEEP_EVERY_MS) return 0
    lastSweep = now.getTime()
    try {
      const cutoff = addDays(zurichDay(now), -ROSTER_KEEP_DAYS)
      const { rowCount } = await pool.query(
        `DELETE FROM public.game_rosters
          WHERE expires_at < $3
             OR (expires_at IS NULL AND ((kickoff ~ '^\\d{4}-\\d{2}-\\d{2}' AND left(kickoff, 10) < $1)
             OR (NOT coalesce(kickoff ~ '^\\d{4}-\\d{2}-\\d{2}', false) AND updated_at < $2)))`,
        [cutoff, new Date(now.getTime() - 4 * ROSTER_KEEP_DAYS * DAY_MS), now])
      if (rowCount) log.info?.(`[teams] swept ${rowCount} game roster(s)`)
      return rowCount
    } catch (err) {
      if (!MISSING.has(err?.code)) log.warn?.(`[teams] sweep failed: ${err?.code || err?.message}`)
      return 0
    }
  }

  /** db/035: sweep() every SWEEP_EVERY_MS without request traffic too; returns stop(). */
  function startSweeps () {
    const t = setInterval(() => { sweep({ force: true }).catch(() => {}) }, SWEEP_EVERY_MS)
    t.unref?.()
    return () => clearInterval(t)
  }

  // ---------------------------------------------------------------- who
  /**
   * `list` with each team's gender from its games (svrz_games: 'm', 'f' or
   * null) and `active`: it has a game this season (owner 2026-11-11: "KSCW
   * DU23-2 is not playing this season"). One query.
   */
  async function withGenders (client, list) {
    if (!list.length) return list
    const keys = [...new Set(list.map((x) => String(x.name || '').trim().toLowerCase()).filter(Boolean))]
    const from = `${seasonOf(clock()) ?? new Date(clock()).getFullYear()}-07-01`
    const { rows } = await (client || pool).query(
      `SELECT k, array_agg(DISTINCT coalesce(btrim(gender), '')) AS genders, bool_or(datetime >= $2) AS active
         FROM (SELECT lower(btrim(team_home)) AS k, gender, datetime::text AS datetime FROM public.svrz_games WHERE lower(btrim(team_home)) = ANY($1::text[])
               UNION ALL
               SELECT lower(btrim(team_away)), gender, datetime::text FROM public.svrz_games WHERE lower(btrim(team_away)) = ANY($1::text[])) x
        GROUP BY k`, [keys, from])
    const by = new Map(rows.map((r) => [r.k, r]))
    return list.map((x) => {
      const r = by.get(String(x.name || '').trim().toLowerCase())
      return { ...x, gender: r ? teamGenderOf(r.genders) : null, active: r?.active === true }
    })
  }

  /**
   * The teams an account acts for: its own (team_managers) and every team of
   * the clubs it manages, [{ id, name, club_id, club_name, via: 'team' | 'club',
   * gender: 'm' | 'f' | null, active }] (the gender of the team's games in the
   * schedule, lib/licences.js teamGenderOf: the manager's Club / Gender / Team
   * pickers, owner 2026-11-11). [] without db/023.
   */
  async function managedTeamsOf (client, userId, { all = false } = {}) {
    if (!isUuid(userId)) return []
    try {
      // Admins see every team of every club (owner 2026-11-08), as 'admin'
      // unless they manage it themselves
      if (all) {
        const own = new Map((await managedTeamsOf(client, userId)).map((t) => [t.id, t.via]))
        const { rows } = await (client || pool).query(
          `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
             FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id`)
        return withGenders(client, rows
          .map((r) => ({ id: r.id, name: r.name, club_id: r.club_id, club_name: r.club_name, via: own.get(r.id) || 'admin' }))
          .sort((a, b) => a.club_name.localeCompare(b.club_name) || a.name.localeCompare(b.name)))
      }
      const { rows } = await (client || pool).query(
        `SELECT DISTINCT ON (ct.id) ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name, x.via
           FROM (SELECT tm.team_id, 'team' AS via, 2 AS rank FROM public.team_managers tm WHERE tm.user_id = $1
                 UNION ALL
                 SELECT ct2.id, 'club', 1 FROM public.club_managers cm JOIN public.club_teams ct2 ON ct2.club_id = cm.club_id
                  WHERE cm.user_id = $1) x
           JOIN public.club_teams ct ON ct.id = x.team_id
           JOIN public.clubs c ON c.id = ct.club_id
          ORDER BY ct.id, x.rank`, [userId])
      return withGenders(client, rows
        .map((r) => ({ id: r.id, name: r.name, club_id: r.club_id, club_name: r.club_name, via: r.via }))
        .sort((a, b) => a.club_name.localeCompare(b.club_name) || a.name.localeCompare(b.name)))
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  /** May `userId` act for team `teamId`? Admins always; false without db/023. Throws on a DB error. */
  async function mayManage ({ userId, access, teamId }) {
    if (access?.isAdmin) return true
    if (!isUuid(userId) || !isUuid(teamId)) return false
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM public.team_managers WHERE team_id = $1 AND user_id = $2
         UNION ALL
         SELECT 1 FROM public.club_teams ct JOIN public.club_managers cm ON cm.club_id = ct.club_id
          WHERE ct.id = $1 AND cm.user_id = $2
         LIMIT 1`, [teamId, userId])
      return rows.length > 0
    } catch (err) {
      if (MISSING.has(err?.code)) return false
      throw err
    }
  }

  /** Is team `teamId` one of club `clubId`'s? false without db/023. Throws on a DB error. */
  async function teamOfClub (clubId, teamId) {
    if (!isUuid(clubId) || !isUuid(teamId)) return false
    try {
      const { rows } = await pool.query('SELECT 1 FROM public.club_teams WHERE id = $1 AND club_id = $2', [teamId, clubId])
      return rows.length > 0
    } catch (err) {
      if (MISSING.has(err?.code)) return false
      throw err
    }
  }

  async function teamRow (db, teamId) {
    if (!isUuid(teamId)) return null
    const { rows: [t] } = await db.query(
      `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
         FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id WHERE ct.id = $1`, [teamId])
    return t ? { id: t.id, name: t.name, club_id: t.club_id, club_name: t.club_name } : null
  }

  // ---------------------------------------------------------------- the team
  /** GET /api/team/:teamId */
  async function teamDetail ({ teamId } = {}) {
    return guarded('team', async () => {
      const team = await teamRow(pool, teamId)
      return team ? ok({ team }) : notFound()
    })
  }

  /** The schedule rows of the team (home or away) from `fromDay`, kick-off order. */
  async function scheduleOf (db, teamName, { fromDay, toDay = null, limit = 100 }) {
    const { rows } = await db.query(
      `SELECT g.game_number, g.datetime, g.league, g.gender, g.hall, g.city, g.team_home, g.team_away,
              g.hall_address, g.hall_postal_code, g.referee_1, g.referee_2,
              g.referee_1_first_name, g.referee_1_last_name, g.referee_2_first_name, g.referee_2_last_name
         FROM public.svrz_games g
        WHERE (lower(btrim(g.team_home)) = $1 OR lower(btrim(g.team_away)) = $1)
          AND g.datetime >= $2 AND ($3::text IS NULL OR g.datetime < $3)
        ORDER BY g.datetime, g.game_number
        LIMIT $4`, [key(teamName), fromDay, toDay, limit])
    return rows
  }
  const sideOf = (game, teamName) => (key(game.team_home) === key(teamName) ? 'home' : 'away')

  /** The roster rows of these (game_number, season, side) keys: Map 'n|season|side' -> row. */
  async function rostersFor (db, keys, { full = false, unused = false } = {}) {
    const out = new Map()
    if (!keys.length) return out
    const { rows } = await db.query(
      `SELECT r.game_number, r.season, r.side, r.team_name, r.kickoff, r.updated_at, r.used_at, r.team_id,
              jsonb_array_length(r.players) AS player_count, jsonb_array_length(r.staff) AS staff_count,
              r.coach_signature IS NOT NULL AS coach_signed, r.captain_signature IS NOT NULL AS captain_signed,
              ${full ? `r.players, r.staff, r.coach_signature, r.captain_signature, ${nameSql('pc')} AS coach_signed_by_name, ${nameSql('pk')} AS captain_signed_by_name,` : ''} ${nameSql('p')} AS updated_by_name,
              ${nameSql('pu')} AS used_by_name
         FROM public.game_rosters r
         JOIN unnest($1::text[], $2::int[], $3::text[]) AS k(game_number, season, side)
           ON k.game_number = r.game_number AND k.season = r.season AND k.side = r.side
         LEFT JOIN public.profiles p ON p.user_id = r.updated_by
         LEFT JOIN public.profiles pu ON pu.user_id = r.used_by
         ${full ? 'LEFT JOIN public.profiles pc ON pc.user_id = r.coach_signed_by LEFT JOIN public.profiles pk ON pk.user_id = r.captain_signed_by' : ''}
        ${unused ? 'WHERE r.used_at IS NULL' : ''}`,
      [keys.map((k) => k.game_number), keys.map((k) => k.season), keys.map((k) => k.side)])
    for (const r of rows) out.set(`${r.game_number}|${r.season}|${r.side}`, r)
    return out
  }
  const usedOut = (r) => (r.used_at ? { used_at: iso(r.used_at), used_by_name: r.used_by_name ?? null } : { used_at: null, used_by_name: null })
  const summaryOut = (r) => (r
    ? {
        players: r.player_count,
        staff: r.staff_count,
        signed: { coach: r.coach_signed === true, captain: r.captain_signed === true },
        updated_at: iso(r.updated_at),
        updated_by_name: r.updated_by_name ?? null,
        ...usedOut(r)
      }
    : null)

  /** GET /api/team/:teamId/games: the team's games from today, each with its side and roster summary. */
  async function games ({ teamId } = {}) {
    return guarded('games', async () => {
      const team = await teamRow(pool, teamId)
      if (!team) return notFound()
      const now = clock()
      const rows = await scheduleOf(pool, team.name, { fromDay: zurichDay(now) })
      const list = rows
        .filter((g) => GAME_RE.test(String(g.game_number || '')))
        .map((g) => ({ g, side: sideOf(g, team.name), season: seasonOf(g.datetime) ?? seasonOf(now) }))
      const rosters = await rostersFor(pool, list.map((x) => ({ game_number: String(x.g.game_number), season: x.season, side: x.side })))
      return ok({
        team,
        games: list.map(({ g, side, season }) => ({
          game_number: String(g.game_number),
          datetime: g.datetime ?? null,
          league: g.league ?? null,
          hall: g.hall ?? null,
          city: g.city ?? null,
          // the game page's where and who (owner 2026-11-10: "at the top where,
          // when, referees"); the referees' names only, as the public match
          // assignments show them (no dates of birth)
          hall_address: g.hall_address ?? null,
          hall_postal_code: g.hall_postal_code ?? null,
          referees: [[g.referee_1, g.referee_1_first_name, g.referee_1_last_name], [g.referee_2, g.referee_2_first_name, g.referee_2_last_name]]
            .map(([name, first, last]) => String(name ?? '').trim() || [first, last].map((x) => String(x ?? '').trim()).filter(Boolean).join(' '))
            .filter(Boolean),
          team_home: g.team_home ?? null,
          team_away: g.team_away ?? null,
          side,
          started: kickoffPassed(g.datetime, now),
          roster: summaryOut(rosters.get(`${g.game_number}|${season}|${side}`))
        }))
      })
    })
  }

  /** The team's game `game`: { team, game, side, season, started } or an answer. No lock (owner 2026-11-08). */
  async function gameOf (db, teamId, game) {
    const team = await teamRow(db, teamId)
    if (!team) return { answer: notFound() }
    const n = typeof game === 'string' ? game.trim() : (Number.isInteger(game) ? String(game) : '')
    if (!GAME_RE.test(n)) return { answer: invalid('game: a game number') }
    const { rows } = await db.query(
      `SELECT g.game_number, g.datetime, g.league, g.hall, g.city, g.team_home, g.team_away
         FROM public.svrz_games g
        WHERE g.game_number = $1 AND (lower(btrim(g.team_home)) = $2 OR lower(btrim(g.team_away)) = $2)
        ORDER BY g.id DESC LIMIT 1`, [n, key(team.name)])
    const g = rows[0]
    if (!g) return { answer: NOT_YOUR_GAME() }
    const now = clock()
    return { team, game: g, side: sideOf(g, team.name), season: seasonOf(g.datetime) ?? seasonOf(now), started: kickoffPassed(g.datetime, now) }
  }
  const gameOut = (g) => ({
    game_number: String(g.game_number), datetime: g.datetime ?? null, league: g.league ?? null, hall: g.hall ?? null,
    city: g.city ?? null, team_home: g.team_home ?? null, team_away: g.team_away ?? null
  })
  const rosterOut = (r) => (r
    ? {
        players: r.players ?? [],
        staff: r.staff ?? [],
        coach_signature: r.coach_signature ?? null,
        captain_signature: r.captain_signature ?? null,
        updated_at: iso(r.updated_at),
        updated_by_name: r.updated_by_name ?? null,
        ...usedOut(r)
      }
    : null)

  /** GET /api/team/:teamId/roster?game=<n> */
  async function getRoster ({ teamId, game } = {}) {
    return guarded('roster', async () => {
      const x = await gameOf(pool, teamId, game)
      if (x.answer) return x.answer
      const rosters = await rostersFor(pool, [{ game_number: String(x.game.game_number), season: x.season, side: x.side }], { full: true })
      const r = rosters.get(`${x.game.game_number}|${x.season}|${x.side}`)
      return ok({ team: x.team, game: gameOut(x.game), side: x.side, started: x.started, roster: rosterOut(r) })
    })
  }

  /**
   * PUT /api/team/:teamId/roster?game=<n> { players, staff, coach_signature?,
   * captain_signature? }: at any time (no lock). A new version is offered to
   * the scorer again, also after an earlier one was accepted.
   */
  async function putRoster ({ actorId, teamId, game, body } = {}) {
    const v = validateGameRoster(body)
    if (v.error) return v.error
    const out = await guarded('put-roster', () => withTx(async (client) => {
      const x = await gameOf(client, teamId, game)
      if (x.answer) throw abort(x.answer)
      // db/024: a player can't play in the wrong gender (owner 2026-11-09);
      // the officials are not checked: they may be anyone of the club
      const wrong = licences ? await licences.wrongGender(client, x.team, v.players) : null
      if (wrong) throw abort(WRONG_GENDER(wrong.index, wrong.gender))
      const n = String(x.game.game_number)
      const actor = isUuid(actorId) ? actorId : null
      // db/035: a signature made ahead belongs to the players and staff it was
      // made on and to the account that sent it; the same image re-sent with
      // another roster is dropped, a new image is the sender's
      const { rows: [prev] } = await client.query(
        `SELECT coach_signature, captain_signature, coach_signed_hash, captain_signed_hash, coach_signed_by, captain_signed_by
           FROM public.game_rosters WHERE game_number = $1 AND season = $2 AND side = $3 FOR UPDATE`, [n, x.season, x.side])
      const hash = rosterHash(v)
      const sig = {}
      for (const k of ['coach', 'captain']) {
        const img = v[`${k}_signature`]
        const kept = img && prev && prev[`${k}_signature`] === img
        if (kept && prev[`${k}_signed_hash`] !== hash) sig[k] = [null, null, null]
        else if (kept) sig[k] = [img, prev[`${k}_signed_hash`], prev[`${k}_signed_by`]]
        else sig[k] = img ? [img, hash, actor] : [null, null, null]
      }
      await client.query(
        `INSERT INTO public.game_rosters (game_number, season, side, team_name, players, staff, coach_signature, captain_signature, kickoff, updated_by,
                club_id, team_id, coach_signed_hash, coach_signed_by, captain_signed_hash, captain_signed_by, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 CASE WHEN $9::text ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (left($9::text, 10)::date + ${ROSTER_KEEP_DAYS + 1})::timestamp AT TIME ZONE 'Europe/Zurich'
                      ELSE now() + interval '${4 * ROSTER_KEEP_DAYS} days' END)
         ON CONFLICT (game_number, season, side) DO UPDATE SET team_name = EXCLUDED.team_name, players = EXCLUDED.players,
           staff = EXCLUDED.staff, coach_signature = EXCLUDED.coach_signature, captain_signature = EXCLUDED.captain_signature,
           kickoff = EXCLUDED.kickoff, updated_by = EXCLUDED.updated_by, updated_at = now(), used_at = NULL, used_by = NULL,
           used_match_id = NULL, club_id = EXCLUDED.club_id, team_id = EXCLUDED.team_id, expires_at = EXCLUDED.expires_at,
           coach_signed_hash = EXCLUDED.coach_signed_hash, coach_signed_by = EXCLUDED.coach_signed_by,
           captain_signed_hash = EXCLUDED.captain_signed_hash, captain_signed_by = EXCLUDED.captain_signed_by`,
        [n, x.season, x.side, x.team.name, JSON.stringify(v.players), JSON.stringify(v.staff), sig.coach[0], sig.captain[0],
          x.game.datetime ?? null, actor, x.team.club_id, x.team.id, sig.coach[1], sig.coach[2], sig.captain[1], sig.captain[2]])
      await audit(client, {
        actorId,
        action: 'team.roster',
        details: { team_id: x.team.id, game_number: n, side: x.side, players: v.players.length, staff: v.staff.length, signed: { coach: !!sig.coach[0], captain: !!sig.captain[0] } }
      })
      const rosters = await rostersFor(client, [{ game_number: n, season: x.season, side: x.side }], { full: true })
      return ok({ team: x.team, game: gameOut(x.game), side: x.side, started: x.started, roster: rosterOut(rosters.get(`${n}|${x.season}|${x.side}`)) })
    }))
    sweep().catch(() => {})
    return out
  }

  /** DELETE /api/team/:teamId/roster?game=<n> */
  async function deleteRoster ({ actorId, teamId, game } = {}) {
    return guarded('delete-roster', () => withTx(async (client) => {
      const x = await gameOf(client, teamId, game)
      if (x.answer) throw abort(x.answer)
      const n = String(x.game.game_number)
      const { rowCount } = await client.query(
        'DELETE FROM public.game_rosters WHERE game_number = $1 AND season = $2 AND side = $3', [n, x.season, x.side])
      if (!rowCount) throw abort(notFound())
      await audit(client, { actorId, action: 'team.roster', details: { team_id: x.team.id, game_number: n, side: x.side, deleted: true } })
      return ok({ deleted: true })
    }))
  }

  // ---------------------------------------------------------------- the squad (a saved team)
  /** The saved team of `team` in season `label`: by its VolleyManager name, else by its name without one. */
  async function squadId (db, team, label) {
    const { rows: [r] } = await db.query(
      `SELECT t.id FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE c.sport = 'indoor' AND c.season = $2 AND NOT c.archived
          AND (lower(btrim(t.svrz_team_name)) = $1 OR (coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) = $1))
        ORDER BY (lower(btrim(t.svrz_team_name)) = $1) DESC NULLS LAST, t.updated_at DESC
        LIMIT 1`, [key(team.name), label])
    return r?.id ?? null
  }

  /** GET /api/team/:teamId/squad */
  async function squad ({ teamId } = {}) {
    return guarded('squad', async () => {
      const team = await teamRow(pool, teamId)
      if (!team) return notFound()
      const label = seasonLabel(seasonOf(clock()))
      const id = await squadId(pool, team, label)
      const saved = id ? await savedTeams.getTeam({ id }) : null
      return ok({ team, season: label, squad: saved?.body?.data?.team ?? null })
    })
  }

  /**
   * The season's competition of the team's league (vm_leagues), else a new
   * one named after the league (owner decision D1). The league is the one of
   * the team's games this season.
   */
  async function competitionFor (actorId, team, label, seasonYear) {
    const { rows: g } = await pool.query(
      `SELECT g.league, g.gender, count(*)::int AS n FROM public.svrz_games g
        WHERE (lower(btrim(g.team_home)) = $1 OR lower(btrim(g.team_away)) = $1) AND g.datetime >= $2
          AND coalesce(btrim(g.league), '') <> ''
        GROUP BY g.league, g.gender ORDER BY n DESC, g.league LIMIT 1`, [key(team.name), `${seasonYear}-07-01`])
    const league = g[0]?.league?.trim() || null
    if (league) {
      const { rows: [c] } = await pool.query(
        `SELECT id FROM public.competitions WHERE sport = 'indoor' AND season = $1 AND NOT archived AND $2 = ANY(vm_leagues)
          ORDER BY created_at LIMIT 1`, [label, league])
      if (c) return { id: c.id }
    }
    const made = await savedTeams.createCompetition({
      actorId,
      body: { name: (league || team.name).slice(0, 120), season: label, gender: genderOf(g[0]?.gender), vm_leagues: league ? [league] : [], sport: 'indoor' }
    })
    if (made.status !== 201) return { answer: made }
    return { id: made.body.data.competition.id }
  }

  /** PUT /api/team/:teamId/squad { players, staff }: the saved team's whole roster; creates it when there is none. */
  async function putSquad ({ actorId, teamId, body } = {}) {
    const v = validateRoster(body, { sport: 'indoor' })
    if (v.error) return v.error
    return guarded('put-squad', async () => {
      const team = await teamRow(pool, teamId)
      if (!team) return notFound()
      // db/024: a player can't play in the wrong gender (owner 2026-11-09);
      // the officials are not checked: they may be anyone of the club
      const wrong = licences ? await licences.wrongGender(pool, team, v.players) : null
      if (wrong) return WRONG_GENDER(wrong.index, wrong.gender)
      const year = seasonOf(clock())
      const label = seasonLabel(year)
      let id = await squadId(pool, team, label)
      if (!id) {
        const comp = await competitionFor(actorId, team, label, year)
        if (comp.answer) return comp.answer
        const made = await savedTeams.createTeam({
          actorId,
          body: { competition_id: comp.id, name: team.name.slice(0, 120), club: team.club_name.slice(0, 120), svrz_team_name: team.name }
        })
        if (made.status !== 201) return made
        id = made.body.data.team.id
      }
      const put = await savedTeams.putRoster({ id, body })
      if (put.status !== 200) return put
      await audit(pool, { actorId, action: 'team.squad', details: { team_id: team.id, saved_team_id: id, players: v.players.length, staff: v.staff.length } })
      return ok({ team, season: label, squad: put.body.data.team })
    })
  }

  // ---------------------------------------------------------------- club managers
  /** GET /api/club/:id/teams: the club's teams with ids and their managers. */
  async function clubTeams ({ clubId } = {}) {
    if (!isUuid(clubId)) return notFound()
    return guarded('club-teams', async () => {
      const { rows: [c] } = await pool.query('SELECT id FROM public.clubs WHERE id = $1', [clubId])
      if (!c) return notFound()
      const { rows } = await pool.query(
        `SELECT ct.id, ct.team_name AS name,
                coalesce((SELECT json_agg(json_build_object('user_id', u.id, 'email', u.email, 'name', ${nameSql('p')}, 'added_at', tm.added_at)
                                          ORDER BY lower(coalesce(${nameSql('p')}, u.email)))
                            FROM public.team_managers tm JOIN auth.users u ON u.id = tm.user_id
                            LEFT JOIN public.profiles p ON p.user_id = u.id
                           WHERE tm.team_id = ct.id), '[]') AS managers,
                (SELECT count(*)::int FROM public.invite_codes i
                  WHERE i.team_id = ct.id AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now())
                    AND (i.max_uses IS NULL OR i.uses < i.max_uses)) AS open_links
           FROM public.club_teams ct WHERE ct.club_id = $1
          ORDER BY lower(ct.team_name)`, [clubId])
      return ok({
        teams: rows.map((r) => ({
          id: r.id,
          name: r.name,
          managers: (r.managers || []).map((m) => ({ user_id: m.user_id, email: m.email, name: m.name ?? null, added_at: m.added_at ?? null })),
          open_links: r.open_links
        }))
      })
    })
  }

  /**
   * DELETE /api/club/:id/teams/:teamId/managers/:userId: the account no
   * longer manages the team. The team links it redeemed are revoked with it
   * (be-clubs-teams-5: also for anyone it passed them on to), and the same
   * link refuses it from now on (lib/accounts.js redeemTeamLink). It is in no
   * club through the team (db/036), so it keeps no club data either.
   * { removed, links_revoked }
   */
  async function removeManager ({ actorId, clubId, teamId, userId } = {}) {
    if (!isUuid(clubId) || !isUuid(teamId) || !isUuid(userId)) return notFound()
    return guarded('remove-manager', () => withTx(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM public.team_managers tm USING public.club_teams ct
          WHERE tm.team_id = ct.id AND ct.id = $1 AND ct.club_id = $2 AND tm.user_id = $3`, [teamId, clubId, userId])
      if (!rowCount) throw abort(notFound())
      await audit(client, { actorId, action: 'team.managers', targetUserId: userId, details: { team_id: teamId, club_id: clubId, removed: true } })
      const { rows: links } = await client.query(
        `UPDATE public.invite_codes i SET revoked_at = now()
          WHERE i.team_id = $1 AND i.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM public.invite_redemptions r WHERE r.invite_id = i.id AND r.user_id = $2)
          RETURNING i.id, i.label`, [teamId, userId])
      for (const l of links) {
        await audit(client, { actorId, action: 'invite.revoke', details: { invite_id: l.id, label: l.label, reason: 'team_manager_removed' }, app: 'indoor' })
      }
      return ok({ removed: userId, links_revoked: links.length })
    }))
  }

  // ---------------------------------------------------------------- scorers
  /**
   * Who may read and accept a sent roster (db/035): the home club's scorers
   * (both sides of its home games), an editor of the match that holds the
   * game (official, not a test), and the managers of the sending team.
   * { mayRead(row, teamHome), matchOf(n, season) }
   */
  async function accessOf (db, userId, numbers) {
    const myClubs = clubs?.clubsOf ? await clubs.clubsOf(db, userId) : []
    const home = new Set(myClubs.flatMap((c) => c.teams || []).map(key).filter(Boolean))
    const ints = numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)
    const held = new Map()
    if (ints.length) {
      const { rows } = await db.query(
        `SELECT m.id, m.game_n, m.official_season FROM public.matches m
          WHERE m.game_n = ANY($1::int[]) AND m.test IS NOT TRUE AND m.sport_type IS DISTINCT FROM 'beach'
            AND (m.created_by = $2 OR EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = $2))
          ORDER BY m.created_at NULLS LAST, m.id`, [ints, userId])
      for (const m of rows) { const k = `${m.game_n}|${m.official_season}`; if (!held.has(k)) held.set(k, m.id) }
    }
    const { rows: tm } = await db.query('SELECT team_id FROM public.team_managers WHERE user_id = $1', [userId])
    const teamsOfUser = new Set(tm.map((t) => t.team_id))
    const matchOf = (n, season) => held.get(`${Number(n)}|${season}`) ?? null
    return {
      matchOf,
      mayRead: (r, teamHome) => home.has(key(teamHome)) || !!matchOf(r.game_number, r.season) || (r.team_id != null && teamsOfUser.has(r.team_id))
    }
  }

  /**
   * GET /api/game-rosters[?games=1,2]: the rosters the scoring tablet keeps
   * (offline first). Without `games`: those of the home games of the caller's
   * clubs from today to SCORER_AHEAD_DAYS ahead. With `games` (at most 50):
   * those games. `games` in the answer lists every game the answer covers, so
   * the tablet drops a copy the team deleted.
   */
  async function scorerRosters ({ userId, games: wanted } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    let numbers = null
    if (wanted != null && wanted !== '') {
      const list = String(wanted).split(',').map((s) => s.trim()).filter(Boolean)
      if (list.length > MAX_GAMES_PER_READ || !list.every((n) => GAME_RE.test(n))) return invalid(`games: at most ${MAX_GAMES_PER_READ} game numbers`)
      numbers = [...new Set(list)]
    }
    const out = await guarded('scorer-rosters', async () => {
      const now = clock()
      const today = zurichDay(now)
      let schedule
      if (numbers) {
        const { rows } = await pool.query(
          `SELECT DISTINCT ON (g.game_number) g.game_number, g.datetime, g.team_home FROM public.svrz_games g
            WHERE g.game_number = ANY($1::text[]) ORDER BY g.game_number, g.id DESC`, [numbers])
        schedule = rows
      } else {
        const myClubs = clubs?.clubsOf ? await clubs.clubsOf(pool, userId) : []
        const names = [...new Set(myClubs.flatMap((c) => c.teams || []).map(key).filter(Boolean))]
        if (!names.length) return ok({ fetched_at: now.toISOString(), games: [], rosters: [] })
        const { rows } = await pool.query(
          `SELECT g.game_number, g.datetime, g.team_home FROM public.svrz_games g
            WHERE lower(btrim(g.team_home)) = ANY($1::text[]) AND g.datetime >= $2 AND g.datetime < $3
            ORDER BY g.datetime LIMIT 200`, [names, today, addDays(today, SCORER_AHEAD_DAYS + 1)])
        schedule = rows
      }
      const covered = schedule.filter((g) => GAME_RE.test(String(g.game_number || '')))
      const keys = []
      for (const g of covered) {
        const season = seasonOf(g.datetime) ?? seasonOf(now)
        for (const side of ['home', 'away']) keys.push({ game_number: String(g.game_number), season, side })
      }
      const homeOf = new Map(covered.map((g) => [String(g.game_number), g.team_home]))
      const access = await accessOf(pool, userId, [...homeOf.keys()])
      const rosters = [...(await rostersFor(pool, keys, { full: true, unused: true })).values()]
        .filter((r) => access.mayRead(r, homeOf.get(r.game_number)))
      // every read of personal data is audited: game numbers and sides only
      if (rosters.length) {
        await audit(pool, { actorId: userId, action: 'team.roster', details: { read: rosters.map((r) => `${r.game_number}|${r.side}`) } })
      }
      return ok({
        fetched_at: now.toISOString(),
        games: covered.map((g) => ({ game_number: String(g.game_number), season: seasonOf(g.datetime) ?? seasonOf(now) })),
        rosters: rosters.map((r) => ({
          game_number: r.game_number,
          season: r.season,
          side: r.side,
          team_name: r.team_name,
          kickoff: r.kickoff ?? null,
          players: r.players ?? [],
          staff: r.staff ?? [],
          coach_signature: r.coach_signature ?? null,
          captain_signature: r.captain_signature ?? null,
          // db/035: made ahead, sent by this account (Accept shows it)
          coach_signed_by_name: r.coach_signature ? (r.coach_signed_by_name ?? null) : null,
          captain_signed_by_name: r.captain_signature ? (r.captain_signed_by_name ?? null) : null,
          updated_at: iso(r.updated_at),
          updated_by_name: r.updated_by_name ?? null
        }))
      })
    })
    sweep().catch(() => {})
    return out
  }

  /**
   * POST /api/game-rosters/used { game_number, side, season?, updated_at }: a
   * scorer accepted this version in Match Setup. Only those who may read it
   * (accessOf) may; anyone else gets 'gone'. db/035: the row keeps its content
   * until expires_at and records who accepted it and for which match
   * (used_at, used_by, used_match_id); scorers' downloads leave it out from
   * then on, the team sees "Accepted". A newer version (the team changed it
   * since) is left alone: the tablet gets it offered again. Idempotent:
   * { used: true } or { used: false, reason: 'changed' | 'gone' }.
   */
  async function markUsed ({ userId, body } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const n = typeof body.game_number === 'string' ? body.game_number.trim() : (Number.isInteger(body.game_number) ? String(body.game_number) : '')
    if (!GAME_RE.test(n)) return invalid('game_number: a game number')
    if (body.side !== 'home' && body.side !== 'away') return invalid('side: home or away')
    const season = body.season == null ? null : Number(body.season)
    if (season !== null && !(Number.isInteger(season) && season >= 2000 && season <= 2100)) return invalid('season: a year')
    const version = typeof body.updated_at === 'string' ? new Date(body.updated_at) : null
    if (!version || Number.isNaN(version.getTime())) return invalid('updated_at: the version accepted (ISO date-time)')
    return guarded('mark-used', () => withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT game_number, season, team_id, used_at, date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $4::timestamptz) AS same
           FROM public.game_rosters WHERE game_number = $1 AND side = $2 AND ($3::int IS NULL OR season = $3)
          ORDER BY season DESC LIMIT 1 FOR UPDATE`, [n, body.side, season, version.toISOString()])
      const r = rows[0]
      if (!r) return ok({ used: false, reason: 'gone' })
      const { rows: [g] } = await client.query(
        'SELECT g.team_home FROM public.svrz_games g WHERE g.game_number = $1 ORDER BY g.id DESC LIMIT 1', [n])
      const access = await accessOf(client, userId, [n])
      // not one of the caller's games: the same answer as no roster at all
      if (!access.mayRead(r, g?.team_home)) return ok({ used: false, reason: 'gone' })
      if (!r.same) return ok({ used: false, reason: 'changed' })
      if (r.used_at) return ok({ used: true, already: true })
      const matchId = access.matchOf(n, r.season)
      await client.query(
        `UPDATE public.game_rosters SET used_at = now(), used_by = $4, used_match_id = $5
          WHERE game_number = $1 AND side = $2 AND season = $3`, [n, body.side, r.season, userId, matchId])
      await audit(client, { actorId: userId, action: 'team.roster', matchId, details: { game_number: n, side: body.side, used: true } })
      return ok({ used: true })
    }))
  }

  return {
    managedTeamsOf, mayManage, teamOfClub,
    teamDetail, games, getRoster, putRoster, deleteRoster, squad, putSquad,
    clubTeams, removeManager, scorerRosters, markUsed, sweep, startSweeps
  }
}
