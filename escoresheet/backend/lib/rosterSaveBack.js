/**
 * rosterSaveBack — an official match's rosters fill the teams' saved teams
 * (squads) and the clubs' licence lists (docs/team-managers-spec.md
 * "Filled from official matches", docs/club-licences-spec.md).
 *
 * Owner 2026-11-19: "As club/team management can be used saltuarly: make sure
 * that when online and a roster is saved -> their numbers get saved for such
 * team and club. so that we can create a big database (at the end of the day
 * it is last name first name number and licence n, super public) and next
 * games the 'load from club' works, and the numbers can be automatically
 * filled with roster (einsatzliste) import". When numbers clash, the latest
 * official match wins; nobody is ever deleted.
 *
 * Owner decision 2026-11-23 no. 2 (audit 2611, PERM-04: one club's scorer
 * rewrote another club's saved team and lists, days before the game, without
 * an actor):
 *   - nothing is saved back before the match is CLOSED (approved / final:
 *     matches.closed_at, db/007), whatever its status said before;
 *   - the writer is the account that closed it (matches.closed_by), else its
 *     creator. The side whose team is a club's the writer is a member of
 *     (account_clubs) is merged at once, as before, audited with the writer
 *     as actor (and as imported_by of the club's new rows);
 *   - the other side (another club's team, or a team of no club) gets a
 *     SUGGESTION (db/058 roster_suggestions, one per match and side) and
 *     nothing else: no write to its saved team or its club's lists. Whoever
 *     may manage that team (its club's managers, its team managers, admins)
 *     sees it in the manager (listSuggestions, with what it would change) and
 *     confirms it (merged then, as the own side is, the manager the actor) or
 *     rejects it (decideSuggestion). A suggestion holds no personal data: the
 *     roster is read from the match each time;
 *   - a deleted match is gone, with its suggestions (ON DELETE CASCADE); it is
 *     never a team's "latest" match.
 *
 * Server side, from the stored match row: server.js passes the `changes` of
 * every successful write of public.matches (/api/db, /api/match/restore) to
 * note(), after the answer is decided; no client job, no new write right for
 * a client, so older apps feed it too. Per match the run waits until the
 * match has been quiet for SAVE_BACK_QUIET_MS (a close writes the row a few
 * times: approved, then final), at most SAVE_BACK_MAX_WAIT_MS after the first
 * write it waits for, and reads the row again then. In memory: a restart
 * forgets what was waiting, so the start runs catchUp() (the matches written
 * in the last SAVE_BACK_CATCH_UP_MS). Every run is idempotent: a match that
 * brings nothing new writes nothing.
 *
 * A run does something only for an OFFICIAL match that is CLOSED: not a test,
 * a game number (game_n > 0), indoor (sport_type indoor or NULL), not exempt
 * from the official-game key (a released game, a second match of the game:
 * db/007, db/040), status approved / final with closed_at set, of the current
 * season (matches.official_season, db/034). Its game must be in the schedule
 * (svrz_games): the schedule's home and away team names say who played. Each
 * side of the match row is mapped to one of them by its team name (mapSides:
 * the scorer may have swapped the sides in Match Setup, and a name may be
 * shortened); a side no name points to is left alone.
 *
 * For the writer's own club's side (and for a confirmed suggestion), one
 * transaction:
 *   1. The team's saved team of the season (lib/teams.js ensureSquad: the
 *      team manager's squad, found by its VolleyManager name, or made the
 *      way a team manager's first save makes it), under the same lock as a
 *      squad save.
 *   2. The match's people merged into it (mergeMatchRoster): the same person
 *      by licence, else by name (accents and case aside, first and last name
 *      also swapped); the match's shirt number wins, and a player of the
 *      saved team holding that number loses it; a licence the saved team
 *      lacks is filled in (one that differs stays the saved team's, counted);
 *      new people are added (no captain, no libero); nobody is removed; the
 *      captain and libero flags of the saved team stay. Only the latest
 *      official match of the team sets numbers: an older one (its kick-off
 *      before another closed official match of the team whose roster reached
 *      the team: its writer was of the team's club, or the team confirmed its
 *      suggestion) adds people and fills empty numbers that nobody holds.
 *      Officials the same way (owner 2026-11-20): the latest match's role
 *      wins (Coach, Assistant Coach 1 / 2, Physiotherapist, Medic, as the
 *      sheet names them); an official of the saved team who is not on that
 *      match and held a role it gave to another takes the role left over by
 *      the moves (the assistant who stood in as coach and the coach swap),
 *      else keeps theirs (a role twice is allowed in a saved team); an older
 *      match changes no role, its new officials come with the match's. A
 *      person that would fail the saved team's rules (a player of the other
 *      gender in the club's players list, lib/licences.js wrongGenders; more
 *      than 40 players or 10 officials; twice in the roster; a name too long)
 *      is left out, counted; the rest is saved. Written with
 *      savedTeams.putRoster (the whole roster: every person of before, with
 *      their ids).
 *   3. When the team is a club's (club_teams), its people with a licence
 *      number join the club's lists (lib/licences.js addFromMatch, source
 *      'match', imported_by the actor): players to 'players', Coach /
 *      Assistant Coach 1 / 2 to 'coaches'; a licence number the club has in
 *      any list stays as it is; within the 300 rows per club that no upload
 *      brought.
 *   4. One audit entry team.squad.match (the own side) or
 *      team.squad.suggestion (made, confirmed, rejected) when anything
 *      changed: the actor, the game number, season, side, ids and the counts,
 *      never a name or a licence.
 *
 * Never throws out of note() or a timer; a failed side is logged (code only)
 * and done again with the match's next write.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf } from './officialGame.js'
import { MAX_PLAYERS, MAX_STAFF, STAFF_ROLES } from './savedTeams.js'
import { isDateValue } from './birthdates.js'
import { connectClient } from './pgClient.js'
import { seasonLabel } from './teams.js'

export const SAVE_BACK_QUIET_MS = 60 * 1000
export const SAVE_BACK_MAX_WAIT_MS = 10 * 60 * 1000
// At start: the official matches written in this time before (what a restart forgot)
export const SAVE_BACK_CATCH_UP_MS = 6 * 60 * 60 * 1000
export const SAVE_BACK_CATCH_UP_MAX = 500
// The coin toss is done (db/011: ended, approved, final close the match)
export const TOSSED_STATUSES = Object.freeze(['live', 'ended', 'approved', 'final'])
// Owner decision 2026-11-23 no. 2: a match saves back once it is closed (db/007 closes approved / final)
export const CLOSED_STATUSES = Object.freeze(['approved', 'final'])
// The open suggestions a team's page lists at most
export const MAX_SUGGESTIONS_LISTED = 20
export const SUGGESTION_DECISIONS = Object.freeze(['confirm', 'reject'])
// The bench roles that go to the club's coaches list (a physiotherapist or a medic does not)
export const CLUB_COACH_ROLES = Object.freeze(['Coach', 'Assistant Coach 1', 'Assistant Coach 2'])
// frontend domain/idMode.js LICENCE_MAX; lib/savedTeams.js names
const LICENCE_MAX = 10
const NAME_MAX = 80
const SV_RE = /^[0-9]{4,7}$/
// No db/023 (club_teams.id) yet
const MISSING = new Set(['42P01', '42703'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const tidy = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')
const fold = (v) => tidy(String(v ?? '')).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const nameKey = (p) => `${fold(p?.last_name)}|${fold(p?.first_name)}`
const swappedKey = (p) => `${fold(p?.first_name)}|${fold(p?.last_name)}`
const arr = (v) => (Array.isArray(v) ? v : [])

/**
 * The licence number a person's value holds (frontend domain/idMode.js
 * licenceOf): its digits when it is no date and nothing else (spaces aside),
 * at most 10; else null.
 */
export function licenceOf (v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v)
  if (isDateValue(s)) return null
  const t = s.replace(/\s+/g, '')
  return /^\d+$/.test(t) ? t.slice(0, LICENCE_MAX) : null
}

const numberOf = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null
}

/**
 * One person of a match row (players_home / bench_home ...: { number,
 * first_name, last_name, dob, role }) in the saved team's shape: { number,
 * first_name, last_name, license_number } (players) or { role, first_name,
 * last_name, license_number } (`staff`). The licence is the Swiss sheet's
 * value beside the name (`dob`, a licence or a date: frontend
 * domain/idMode.js), else an older match's own `licence`; a date of birth is
 * never taken. null: no name (an empty row); { invalid: true }: a person the
 * saved team would refuse (a name too long, an unknown role).
 */
export function matchPerson (raw, { staff = false } = {}) {
  if (!isPlainObject(raw)) return null
  let first = tidy(raw.first_name ?? raw.firstName)
  let last = tidy(raw.last_name ?? raw.lastName)
  if (!last && first) { last = first; first = '' }
  if (!last) return null
  if (last.length > NAME_MAX || first.length > NAME_MAX) return { invalid: true }
  const license = licenceOf(raw.dob) ?? licenceOf(raw.licence) ?? licenceOf(raw.license_number)
  if (staff) {
    if (!STAFF_ROLES.includes(raw.role)) return { invalid: true }
    return { role: raw.role, first_name: first, last_name: last, license_number: license }
  }
  return { number: numberOf(raw.number), first_name: first, last_name: last, license_number: license }
}

/**
 * Which schedule team each side of the match row is: { home, away } (the
 * schedule's names, or null for a side that can't be told). A side is a
 * schedule team by its name: the same (accents, case and spaces aside), else
 * one holds the other (4 characters at least: "Musterdorf H1" for "VBC
 * Musterdorf H1"). The sides as they are or swapped (Match Setup's swap, a
 * game played the other way round), whichever fits better; a tie names
 * nobody.
 */
export function mapSides (row, schedule) {
  const score = (a, b) => {
    const x = fold(a)
    const y = fold(b)
    if (!x || !y) return 0
    if (x === y) return 3
    if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 1
    return 0
  }
  const sh = tidy(schedule?.home)
  const sa = tidy(schedule?.away)
  if (!sh || !sa || fold(sh) === fold(sa)) return { home: null, away: null }
  const hh = score(row?.home, sh)
  const ha = score(row?.home, sa)
  const ah = score(row?.away, sh)
  const aa = score(row?.away, sa)
  const straight = hh + aa
  const swapped = ha + ah
  if (straight === swapped) return { home: null, away: null }
  return straight > swapped
    ? { home: hh ? sh : null, away: aa ? sa : null }
    : { home: ha ? sa : null, away: ah ? sh : null }
}

/**
 * The saved team `squad` ({ players, staff } as lib/savedTeams.js answers,
 * with ids) with a match's people `roster` ({ players, staff } of
 * matchPerson; nulls left out) merged in, by the rules in the header.
 * `latest`: this match is the team's latest official one (its numbers win);
 * `wrong`: the indexes of roster.players to leave out (the other gender).
 * Returns { players, staff } (the whole PUT body: everyone of before, in
 * their order, the new ones after), `changed`, `counts` { added, numbers
 * (set by the match), cleared (taken from another player), licences (filled
 * in), roles (an official's role set by the match), moved (an official not on
 * the match moved to the role left over), skipped, conflicts (another licence
 * than the saved team's) } and
 * `club` ([{ list, sv_number, last_name, first_name }]: the people for the
 * club's lists, those with a 4- to 7-digit licence the saved team agrees
 * with). Pure.
 */
export function mergeMatchRoster (squad, roster, { latest = true, wrong = new Set() } = {}) {
  const counts = { added: 0, numbers: 0, cleared: 0, licences: 0, roles: 0, moved: 0, skipped: 0, conflicts: 0 }
  const club = []
  let changed = false
  const players = arr(squad?.players).map((p) => ({ ...p }))
  const staff = arr(squad?.staff).map((s) => ({ ...s }))
  const active = (p) => p.active !== false

  // the same person in `list` (not one taken already): by licence, else by
  // name; a name hit with another licence is the person all the same (the
  // saved team's licence stays): `conflict`
  const findIn = (list, used, p) => {
    if (p.license_number) {
      const i = list.findIndex((e, j) => !used.has(j) && licenceOf(e.license_number) === p.license_number)
      if (i !== -1) return { i, conflict: false }
    }
    const k = nameKey(p)
    const sk = swappedKey(p)
    const hits = []
    list.forEach((e, j) => { if (!used.has(j) && (nameKey(e) === k || nameKey(e) === sk)) hits.push(j) })
    if (!hits.length) return null
    const fits = hits.find((j) => !p.license_number || !licenceOf(list[j].license_number))
    return fits !== undefined ? { i: fits, conflict: false } : { i: hits[0], conflict: true }
  }
  // twice in the roster: the same licence, or the same name where one of the two has none
  const twice = () => {
    const licences = new Set()
    const names = new Map()
    return (p) => {
      if (p.license_number && licences.has(p.license_number)) return true
      for (const k of [nameKey(p), swappedKey(p)]) {
        if (names.has(k) && (!p.license_number || !names.get(k) || names.get(k) === p.license_number)) return true
      }
      if (p.license_number) licences.add(p.license_number)
      names.set(nameKey(p), p.license_number || null)
      return false
    }
  }
  const forClub = (list, p) => {
    if (SV_RE.test(p.license_number || '')) club.push({ list, sv_number: p.license_number, last_name: p.last_name, first_name: p.first_name || null })
  }
  const fillIn = (e, p, conflict) => {
    if (conflict) counts.conflicts++
    else if (p.license_number && !licenceOf(e.license_number)) {
      e.license_number = p.license_number
      counts.licences++
      changed = true
    }
    if (!tidy(e.first_name) && p.first_name) {
      e.first_name = p.first_name
      changed = true
    }
  }

  // ---- players
  const held = (n, except) => players.some((o, j) => j !== except && active(o) && o.number === n)
  const setNumber = (i, n) => {
    players.forEach((o, j) => {
      if (j !== i && active(o) && o.number === n) {
        o.number = null
        counts.cleared++
      }
    })
    if (players[i].number !== n) {
      players[i].number = n
      counts.numbers++
      changed = true
    }
  }
  const usedPlayers = new Set()
  const seenPlayer = twice()
  arr(roster?.players).forEach((p, idx) => {
    if (!p) return
    if (p.invalid || wrong.has(idx) || seenPlayer(p)) { counts.skipped++; return }
    const hit = findIn(players, usedPlayers, p)
    if (hit) {
      usedPlayers.add(hit.i)
      const e = players[hit.i]
      fillIn(e, p, hit.conflict)
      // they played: a player set inactive in the saved team is one again (the
      // latest match only; not when that would make a second captain)
      if (latest && !active(e) && !(e.is_captain && players.some((o) => o !== e && active(o) && o.is_captain))) {
        e.active = true
        changed = true
        if (p.number == null && e.number != null && held(e.number, hit.i)) e.number = null
      }
      if (p.number != null && e.number !== p.number) {
        if (latest) setNumber(hit.i, p.number)
        else if (e.number == null && !held(p.number, hit.i)) setNumber(hit.i, p.number)
      }
      if (!hit.conflict) forClub('players', p)
      return
    }
    if (players.length >= MAX_PLAYERS) { counts.skipped++; return }
    players.push({ number: null, first_name: p.first_name, last_name: p.last_name, license_number: p.license_number, is_libero: false, is_captain: false, active: true })
    const i = players.length - 1
    usedPlayers.add(i)
    counts.added++
    changed = true
    if (p.number != null && (latest || !held(p.number, i))) setNumber(i, p.number)
    forClub('players', p)
  })

  // ---- officials: added or completed, never removed. The latest match's
  // roles win (owner 2026-11-20); an older match changes no role.
  const usedStaff = new Set()
  const seenStaff = twice()
  // the roles of the saved team's officials before the merge, by index
  const before = staff.map((e) => e.role)
  // latest: role -> the index of the match's official who holds it now (the first one the match names)
  const given = new Map()
  arr(roster?.staff).forEach((s) => {
    if (!s) return
    if (s.invalid || seenStaff(s)) { counts.skipped++; return }
    const hit = findIn(staff, usedStaff, s)
    if (hit) {
      usedStaff.add(hit.i)
      const e = staff[hit.i]
      fillIn(e, s, hit.conflict)
      if (latest && !given.has(s.role)) {
        given.set(s.role, hit.i)
        if (e.role !== s.role) {
          e.role = s.role
          counts.roles++
          changed = true
        }
      }
      if (!hit.conflict && CLUB_COACH_ROLES.includes(s.role)) forClub('coaches', s)
      return
    }
    if (staff.length >= MAX_STAFF) { counts.skipped++; return }
    staff.push({ role: s.role, first_name: s.first_name, last_name: s.last_name, license_number: s.license_number })
    usedStaff.add(staff.length - 1)
    if (latest && !given.has(s.role)) given.set(s.role, staff.length - 1)
    counts.added++
    changed = true
    if (CLUB_COACH_ROLES.includes(s.role)) forClub('coaches', s)
  })
  if (latest && given.size) {
    // An official of the saved team who is not on the match and holds a role
    // the match gave to another takes the role left over at the end of the
    // moves: the role their taker had before, when nobody holds it now, else
    // the one that taker's own role went to ... (the coach who missed a game:
    // the assistant who stood in is Coach, the coach the assistant). Nothing
    // left over (a new official took the role): they keep it; the saved team
    // allows a role twice (validateRoster), only the match sheet and a game
    // roster name each role once. Nobody gets a role no sheet gave anyone.
    const heldByOther = (r, i) => staff.some((o, k) => k !== i && o.role === r)
    const leftOver = (role, i) => {
      const seen = new Set()
      let r = role
      while (given.has(r) && !seen.has(r)) {
        seen.add(r)
        r = before[given.get(r)]
        if (!r) return null
        if (!heldByOther(r, i)) return r
      }
      return null
    }
    staff
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => !usedStaff.has(i) && given.has(e.role))
      .sort((a, b) => STAFF_ROLES.indexOf(a.e.role) - STAFF_ROLES.indexOf(b.e.role) || a.i - b.i)
      .forEach(({ e, i }) => {
        const r = leftOver(e.role, i)
        if (r && r !== e.role) {
          e.role = r
          counts.moved++
          changed = true
        }
      })
  }

  return { players, staff, changed, counts, club }
}

/** A person of `list` the same as `p` (licence, else name, also swapped): the team has them already. */
const knownIn = (list, p) => arr(list).some((e) =>
  (p.license_number && licenceOf(e.license_number) === p.license_number) ||
  nameKey(e) === nameKey(p) || nameKey(e) === swappedKey(p))

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {object} o.teams  lib/teams.js (ensureSquad)
 * @param {object} o.savedTeams  lib/savedTeams.js (getTeam, putRoster)
 * @param {object} [o.licences]  lib/licences.js (wrongGenders, addFromMatch); without it no
 *   gender check and no club list
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit (throws)
 * @param {(fn: Function, ms: number) => any} [o.setTimer]  tests: a fake clock
 */
export function createRosterSaveBack ({
  pool, teams, savedTeams, licences = null, audit, logger = console, clock = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout, quietMs = SAVE_BACK_QUIET_MS, maxWaitMs = SAVE_BACK_MAX_WAIT_MS
} = {}) {
  const log = logger
  const now = () => clock().getTime()
  /** match id -> { first, timer }: a run waiting for the match to be quiet */
  const jobs = new Map()
  /** match id -> the run's promise; `again`: written while it ran */
  const running = new Map()
  const again = new Set()

  /**
   * After a successful write: every matches row of `changes` ([{ table,
   * eventType, row }], pgQuery / matchRestore) that may be a closed official
   * match waits for its run. Never throws.
   */
  function note (changes) {
    try {
      for (const c of arr(changes)) {
        if (c?.table !== 'matches' || (c.eventType !== 'INSERT' && c.eventType !== 'UPDATE')) continue
        const r = c.row
        if (!isPlainObject(r) || !isUuid(r.id)) continue
        // what the row says already (the run reads it again)
        if (r.test === true || r.sport_type === 'beach') continue
        if ('game_n' in r && !(Number(r.game_n) > 0)) continue
        // owner decision 2026-11-23 no. 2: not before the close
        if ('status' in r && !CLOSED_STATUSES.includes(r.status)) continue
        schedule(r.id)
      }
    } catch (err) {
      log.warn?.(`[saveBack] note failed: ${String(err?.message || err).slice(0, 200)}`)
    }
  }

  /** The run of match `matchId` after SAVE_BACK_QUIET_MS without a write (at most SAVE_BACK_MAX_WAIT_MS). */
  function schedule (matchId) {
    const t = now()
    let job = jobs.get(matchId)
    if (!job) {
      job = { first: t, timer: null }
      jobs.set(matchId, job)
    } else clearTimer(job.timer)
    const wait = Math.max(0, Math.min(quietMs, job.first + maxWaitMs - t))
    const mine = job
    job.timer = setTimer(() => fire(matchId, mine), wait)
    job.timer?.unref?.()
  }

  function fire (matchId, job) {
    if (jobs.get(matchId) !== job) return
    jobs.delete(matchId)
    if (running.has(matchId)) {
      again.add(matchId)
      return
    }
    const p = run(matchId)
      .then((r) => {
        for (const s of r?.sides || []) {
          if (s.error) log.warn?.(`[saveBack] match ${matchId} ${s.side}: ${s.error}`)
        }
      })
      .catch((err) => log.error?.(`[saveBack] match ${matchId} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`))
      .finally(() => {
        running.delete(matchId)
        if (again.delete(matchId)) schedule(matchId)
      })
    running.set(matchId, p)
  }

  /** The club's team of that name ({ id, name, club_id, club_name }), else the schedule's team alone. */
  async function teamOf (client, name) {
    try {
      const { rows: [t] } = await client.query(
        `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
           FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id
          WHERE lower(btrim(ct.team_name)) = $1 ORDER BY ct.id LIMIT 1`, [key(name)])
      if (t) return { id: t.id, name: tidy(t.name) || name, club_id: t.club_id, club_name: t.club_name }
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    return { id: null, name, club_id: null, club_name: null }
  }

  /** Does the database have db/058's roster_suggestions? */
  async function hasSuggestions (db) {
    const { rows: [r] } = await db.query("SELECT to_regclass('public.roster_suggestions') IS NOT NULL AS ok")
    return r?.ok === true
  }

  /**
   * Is there another closed official match of team `name` whose kick-off is
   * after `kickoff` and whose roster reached the team (then this one's
   * numbers do not win)? Reached: its writer (closed_by, else created_by) is
   * a member of the team's club, or the team confirmed its suggestion. A
   * deleted match is gone; one only suggested to the team (open or rejected)
   * does not count, nor does one not closed.
   */
  async function laterMatch (db, { name, kickoff, matchId, season, suggestions }) {
    if (typeof kickoff !== 'string' || !kickoff) return false
    const { rows } = await db.query(
      `SELECT 1 FROM public.matches m
         JOIN public.svrz_games g ON g.game_number = m.game_n::text
        WHERE m.id <> $1 AND m.test IS NOT TRUE AND m.game_n > 0 AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE
          AND m.official_game_exempt IS NOT TRUE AND m.status = ANY($4::text[]) AND m.closed_at IS NOT NULL AND m.official_season = $5
          AND (lower(btrim(g.team_home)) = $2 OR lower(btrim(g.team_away)) = $2)
          AND g.datetime > $3
          AND (EXISTS (SELECT 1 FROM public.account_clubs ac JOIN public.club_teams ct ON ct.club_id = ac.club_id
                        WHERE ac.user_id = coalesce(m.closed_by, m.created_by) AND lower(btrim(ct.team_name)) = $2)
               ${suggestions ? `OR EXISTS (SELECT 1 FROM public.roster_suggestions s
                                           WHERE s.match_id = m.id AND lower(btrim(s.team_name)) = $2 AND s.status = 'confirmed')` : ''})
        LIMIT 1`, [matchId, key(name), kickoff, [...CLOSED_STATUSES], season])
    return rows.length > 0
  }

  /** The saved team of team `name` in season `year`, if there is one (lib/teams.js squadId; reads only). */
  async function findSquad (db, name, year) {
    const { rows: [r] } = await db.query(
      `SELECT t.id FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE c.sport = 'indoor' AND c.season = $2 AND NOT c.archived
          AND (lower(btrim(t.svrz_team_name)) = $1 OR (coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) = $1))
        ORDER BY (lower(btrim(t.svrz_team_name)) = $1) DESC NULLS LAST, t.updated_at DESC
        LIMIT 1`, [key(name), seasonLabel(year)])
    return r?.id ?? null
  }

  /** The people of side `side` of match row `m` ({ players, staff } of matchPerson). */
  const rosterOf = (m, side) => ({
    players: arr(json(m[`players_${side}`])).map((p) => matchPerson(p)).filter(Boolean),
    staff: arr(json(m[`bench_${side}`])).map((x) => matchPerson(x, { staff: true })).filter(Boolean)
  })

  /**
   * The side merged into team `team`'s saved team on `client` (inside its
   * transaction): the saved team made when there is none (ensureSquad), locked
   * until COMMIT, and written; the club's lists filled; audited `action` with
   * the actor. { side, team, saved_team_id, created, latest, changed, counts,
   * club } or { side, team, error } (rolled back by the caller).
   */
  async function mergeSide (client, { m, game, side, team, roster, year, actorId, suggestions, action, extra = {} }) {
    const wrong = licences?.wrongGenders ? await licences.wrongGenders(client, team, roster.players) : new Map()
    const squad = await teams.ensureSquad(client, { actorId, team, year })
    if (squad.answer) return { side, team: team.name, error: `saved team: ${squad.answer.body?.error?.code || squad.answer.status}` }
    // the saved team as it is now, locked against another write until COMMIT
    await client.query('SELECT 1 FROM public.competition_teams WHERE id = $1 FOR UPDATE', [squad.id])
    const cur = await savedTeams.getTeam({ id: squad.id, client })
    if (cur.status !== 200) throw new Error(`saved team read ${cur.status}`)
    const latest = !(await laterMatch(client, { name: team.name, kickoff: game.datetime, matchId: m.id, season: year, suggestions }))
    const merged = mergeMatchRoster(cur.body.data.team, roster, { latest, wrong: new Set(wrong.keys()) })
    if (merged.changed) {
      const put = await savedTeams.putRoster({ id: squad.id, body: { players: merged.players, staff: merged.staff }, client })
      if (put.status !== 200) return { side, team: team.name, error: `saved team write: ${put.body?.error?.code || put.status}` }
    }
    let clubOut = null
    if (team.club_id && merged.club.length && licences?.addFromMatch) {
      // the club's lists never fail the saved team (a database without db/048's source)
      await client.query('SAVEPOINT club_lists')
      try {
        clubOut = await licences.addFromMatch(client, { clubId: team.club_id, people: merged.club, importedBy: actorId })
        await client.query('RELEASE SAVEPOINT club_lists')
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT club_lists')
        log.warn?.(`[saveBack] match ${m.id} ${side}: club lists not filled: ${err?.code || String(err?.message || err).slice(0, 120)}`)
        clubOut = { added: 0, error: err?.code || 'failed' }
      }
    }
    if (merged.changed || clubOut?.added || action === 'team.squad.suggestion') {
      // the game, the ids and the counts: never a name or a licence number
      await audit(client, {
        actorId,
        action,
        matchId: m.id,
        details: {
          ...extra,
          game_number: String(m.game_n),
          season: year,
          side,
          team_id: team.id,
          club_id: team.club_id,
          saved_team_id: squad.id,
          created: squad.created,
          latest,
          players: merged.players.length,
          staff: merged.staff.length,
          ...merged.counts,
          club_added: clubOut?.added ?? 0,
          club_capped: clubOut?.capped ?? 0
        }
      })
    }
    return { side, team: team.name, saved_team_id: squad.id, created: squad.created, latest, changed: merged.changed, counts: merged.counts, club: clubOut }
  }

  /**
   * What side `side` would change in team `team`'s saved team, now, without
   * writing (and without making a saved team): { latest, changed, counts,
   * club_new (licence numbers the team's club lacks), players, staff (the
   * match's people, `known`: the saved team has them) }.
   */
  async function preview (db, { m, game, team, roster, year, suggestions }) {
    const wrong = licences?.wrongGenders ? await licences.wrongGenders(db, team, roster.players) : new Map()
    const id = await findSquad(db, team.name, year)
    const cur = id ? await savedTeams.getTeam({ id, client: db }) : null
    if (cur && cur.status !== 200) throw new Error(`saved team read ${cur.status}`)
    const squad = cur?.body?.data?.team ?? { players: [], staff: [] }
    const latest = !(await laterMatch(db, { name: team.name, kickoff: game.datetime, matchId: m.id, season: year, suggestions }))
    const merged = mergeMatchRoster(squad, roster, { latest, wrong: new Set(wrong.keys()) })
    let clubNew = 0
    if (team.club_id && merged.club.length) {
      try {
        const { rows } = await db.query(
          'SELECT DISTINCT sv_number FROM public.club_licences WHERE club_id = $1 AND sv_number = ANY($2::text[])', [team.club_id, merged.club.map((x) => x.sv_number)])
        const held = new Set(rows.map((r) => r.sv_number))
        clubNew = new Set(merged.club.map((x) => x.sv_number).filter((n) => !held.has(n))).size
      } catch (err) {
        if (!MISSING.has(err?.code)) throw err
      }
    }
    const players = roster.players.filter((p) => p && !p.invalid).map((p) => ({ number: p.number, first_name: p.first_name, last_name: p.last_name, license_number: p.license_number, known: knownIn(squad.players, p) }))
    const staff = roster.staff.filter((x) => x && !x.invalid).map((x) => ({ role: x.role, first_name: x.first_name, last_name: x.last_name, license_number: x.license_number, known: knownIn(squad.staff, x) }))
    return { latest, changed: merged.changed, counts: merged.counts, club_new: clubNew, players, staff, saved_team_id: id }
  }

  /** The writer's own club's side: merged at once (the writer the actor), one transaction. */
  async function saveOwnSide ({ m, game, side, team, roster, year, writer, suggestions }) {
    const client = await connectClient(pool, log)
    let done = false
    try {
      await client.query('BEGIN')
      const out = await mergeSide(client, { m, game, side, team, roster, year, actorId: writer, suggestions, action: 'team.squad.match' })
      await client.query(out.error ? 'ROLLBACK' : 'COMMIT')
      done = true
      return out
    } finally {
      if (!done) { try { await client.query('ROLLBACK') } catch { /* connection already gone */ } }
      client.release()
    }
  }

  /**
   * Another club's side (or a team of no club): a suggestion for whoever may
   * manage that team, when it would change anything; nothing else is written.
   * Made (audited) or brought up to date while it is open; a decided one is
   * left alone. { side, team, suggested, suggestion_id?, counts } | { side, team, skipped }.
   */
  async function suggestSide ({ m, game, side, team, roster, year, writer }) {
    const p = await preview(pool, { m, game, team, roster, year, suggestions: true })
    if (!p.changed && !p.club_new) return { side, team: team.name, skipped: 'nothing_new', suggested: false }
    const payload = { players: p.players.length, staff: p.staff.length, latest: p.latest, club_new: p.club_new, ...p.counts }
    const client = await connectClient(pool, log)
    let done = false
    try {
      await client.query('BEGIN')
      const { rows: [r] } = await client.query(
        `INSERT INTO public.roster_suggestions (match_id, side, team_name, club_id, team_id, season, payload, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (match_id, side) DO UPDATE
            SET team_name = EXCLUDED.team_name, club_id = EXCLUDED.club_id, team_id = EXCLUDED.team_id, season = EXCLUDED.season,
                payload = EXCLUDED.payload, actor_id = EXCLUDED.actor_id, updated_at = now()
          WHERE public.roster_suggestions.status = 'open'
            AND (public.roster_suggestions.payload IS DISTINCT FROM EXCLUDED.payload
                 OR public.roster_suggestions.team_name IS DISTINCT FROM EXCLUDED.team_name)
         RETURNING id, (xmax = 0) AS made`,
        [m.id, side, team.name, team.club_id, team.id, year, payload, writer])
      if (r) {
        await audit(client, {
          actorId: writer,
          action: 'team.squad.suggestion',
          matchId: m.id,
          details: { event: r.made ? 'made' : 'updated', suggestion_id: r.id, game_number: String(m.game_n), season: year, side, team_id: team.id, club_id: team.club_id, ...payload }
        })
      }
      await client.query('COMMIT')
      done = true
      return { side, team: team.name, suggested: true, suggestion_id: r?.id ?? null, counts: p.counts }
    } finally {
      if (!done) { try { await client.query('ROLLBACK') } catch { /* connection already gone */ } }
      client.release()
    }
  }

  const json = (v) => {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return null }
  }
  const MATCH_COLUMNS = `m.id, m.game_n, m.official_season, m.status, m.test, m.sport_type::text AS sport_type,
              m.official_game_exempt AS exempt, m.home_team, m.away_team, m.closed_at, m.closed_by, m.created_by,
              m.players_home, m.players_away, m.bench_home, m.bench_away`
  const isOfficial = (m) => !(m.test === true || !(Number(m.game_n) > 0) || m.sport_type === 'beach' || m.exempt === true)
  const isClosed = (m) => CLOSED_STATUSES.includes(m.status) && m.closed_at != null
  const scheduleOf = async (db, gameN) => (await db.query(
    'SELECT g.datetime, g.team_home, g.team_away FROM public.svrz_games g WHERE g.game_number = $1 ORDER BY g.id DESC LIMIT 1', [String(gameN)])).rows[0] ?? null

  /**
   * One run for match `matchId`, now: { skipped: reason } or { sides: [{ side,
   * team, own: true, saved_team_id, created, latest, changed, counts, club } |
   * { side, team, own: false, suggested, suggestion_id?, counts } | { side,
   * skipped } | { side, error }] }. Throws on a DB error.
   */
  async function run (matchId) {
    if (!isUuid(matchId)) return { skipped: 'id' }
    const { rows: [m] } = await pool.query(`SELECT ${MATCH_COLUMNS} FROM public.matches m WHERE m.id = $1`, [matchId])
    if (!m) return { skipped: 'gone' }
    if (!isOfficial(m)) return { skipped: 'not_official' }
    // owner decision 2026-11-23 no. 2: only a closed match (approved / final)
    if (!isClosed(m)) return { skipped: 'not_closed' }
    const game = await scheduleOf(pool, m.game_n)
    if (!game) return { skipped: 'not_in_schedule' }
    // the saved teams and club lists of the current season only (a past one's are archived or swept)
    const year = seasonOf(clock())
    const season = m.official_season ?? seasonOf(game.datetime)
    if (season !== year) return { skipped: 'other_season' }
    // the writer: who closed it, else who made it; its clubs' sides are its own
    const writer = isUuid(m.closed_by) ? m.closed_by : isUuid(m.created_by) ? m.created_by : null
    const { rows: own } = writer
      ? await pool.query('SELECT club_id FROM public.account_clubs WHERE user_id = $1', [writer]).catch((err) => { if (MISSING.has(err?.code)) return { rows: [] }; throw err })
      : { rows: [] }
    const writerClubs = new Set(own.map((r) => r.club_id))
    const suggestions = await hasSuggestions(pool)
    const names = mapSides({ home: json(m.home_team)?.name, away: json(m.away_team)?.name }, { home: game.team_home, away: game.team_away })
    const sides = []
    for (const side of ['home', 'away']) {
      const name = names[side]
      if (!name) { sides.push({ side, skipped: 'team_unknown' }); continue }
      const roster = rosterOf(m, side)
      if (!roster.players.length && !roster.staff.length) { sides.push({ side, skipped: 'empty' }); continue }
      try {
        const team = await teamOf(pool, name)
        if (team.club_id && writerClubs.has(team.club_id)) {
          sides.push({ ...(await saveOwnSide({ m, game, side, team, roster, year, writer, suggestions })), own: true })
        } else if (suggestions) {
          sides.push({ ...(await suggestSide({ m, game, side, team, roster, year, writer })), own: false })
        } else {
          // before db/058: no direct write to another club's team, and no suggestion either
          sides.push({ side, team: team.name, own: false, skipped: 'no_suggestions_table' })
        }
      } catch (err) {
        // the other side still gets its run
        sides.push({ side, error: `${err?.code || ''} ${String(err?.message || err).slice(0, 160)}`.trim() })
      }
    }
    return { sides }
  }

  /**
   * At start: the closed official matches written in the last `sinceMs` (at
   * most SAVE_BACK_CATCH_UP_MAX) wait for their run, as after a write; what a
   * restart forgot is done. The number of matches. Never throws.
   */
  async function catchUp ({ sinceMs = SAVE_BACK_CATCH_UP_MS } = {}) {
    try {
      const { rows } = await pool.query(
        `SELECT m.id FROM public.matches m
          WHERE m.updated_at > $1 AND m.test IS NOT TRUE AND m.game_n > 0 AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE
            AND m.official_game_exempt IS NOT TRUE AND m.status = ANY($2::text[]) AND m.closed_at IS NOT NULL
          ORDER BY m.updated_at LIMIT ${SAVE_BACK_CATCH_UP_MAX}`, [new Date(now() - sinceMs), [...CLOSED_STATUSES]])
      for (const r of rows) schedule(r.id)
      return rows.length
    } catch (err) {
      log.warn?.(`[saveBack] catch-up failed: ${err?.code || String(err?.message || err).slice(0, 120)}`)
      return 0
    }
  }

  // ------------------------------------------------------------ suggestions (the manager)
  /** The club team `teamId` ({ id, name, club_id, club_name }) or null. */
  async function clubTeam (db, teamId) {
    const { rows: [t] } = await db.query(
      `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
         FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id WHERE ct.id = $1`, [teamId])
    return t ? { id: t.id, name: tidy(t.name), club_id: t.club_id, club_name: t.club_name } : null
  }

  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err?.answer) return err.answer
      if (MISSING.has(err?.code)) return unavailable()
      log.error?.(`[saveBack] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /**
   * GET /api/team/:id/roster-suggestions (whoever may manage the team): the
   * open suggestions of the team this season, newest game first, at most
   * MAX_SUGGESTIONS_LISTED, each with what confirming would change now:
   * { suggestions: [{ id, game_number, kickoff, team_home, team_away, side,
   * created_at, latest, changed, counts, club_new, players, staff }] }. A
   * suggestion of a match no longer closed (an admin reopened it) waits.
   */
  async function listSuggestions ({ teamId } = {}) {
    if (!isUuid(teamId)) return notFound()
    return guarded('list-suggestions', async () => {
      const team = await clubTeam(pool, teamId)
      if (!team) return notFound()
      if (!(await hasSuggestions(pool))) return ok({ team, suggestions: [] })
      const year = seasonOf(clock())
      const { rows } = await pool.query(
        `SELECT s.id AS suggestion_id, s.side, s.created_at AS suggested_at, ${MATCH_COLUMNS},
                g.datetime AS kickoff, g.team_home AS sched_home, g.team_away AS sched_away
           FROM public.roster_suggestions s
           JOIN public.matches m ON m.id = s.match_id
           LEFT JOIN LATERAL (SELECT sg.datetime, sg.team_home, sg.team_away FROM public.svrz_games sg
                               WHERE sg.game_number = m.game_n::text ORDER BY sg.id DESC LIMIT 1) g ON true
          WHERE lower(btrim(s.team_name)) = $1 AND s.status = 'open' AND s.season = $2 AND m.closed_at IS NOT NULL
          ORDER BY g.datetime DESC NULLS LAST, s.created_at DESC, s.id
          LIMIT ${MAX_SUGGESTIONS_LISTED}`, [key(team.name), year])
      const out = []
      for (const r of rows) {
        if (!isOfficial(r) || !isClosed(r)) continue
        const game = { datetime: r.kickoff, team_home: r.sched_home, team_away: r.sched_away }
        const p = await preview(pool, { m: r, game, team, roster: rosterOf(r, r.side), year, suggestions: true })
        out.push({
          id: r.suggestion_id,
          game_number: String(r.game_n),
          kickoff: r.kickoff ?? null,
          team_home: r.sched_home ?? null,
          team_away: r.sched_away ?? null,
          side: r.side,
          created_at: r.suggested_at instanceof Date ? r.suggested_at.toISOString() : r.suggested_at,
          latest: p.latest,
          changed: p.changed,
          counts: p.counts,
          club_new: p.club_new,
          players: p.players,
          staff: p.staff
        })
      }
      return ok({ team, suggestions: out })
    })
  }

  const decided = () => fail(409, 'OV_SUGGESTION_DECIDED', 'This suggestion was confirmed or rejected already')
  const notClosed = () => fail(409, 'OV_MATCH_NOT_CLOSED', 'The match was reopened: its roster can be confirmed once it is closed again')

  /**
   * POST /api/team/:id/roster-suggestions/:sid { decision: confirm | reject }
   * (whoever may manage the team): confirm merges the match's side into the
   * team's saved team and its club's lists now (the manager the actor, as
   * for the writer's own side); reject keeps nothing. Either is final and
   * audited (team.squad.suggestion). 404: not this team's; 409
   * OV_SUGGESTION_DECIDED, OV_MATCH_NOT_CLOSED. { suggestion: { id, status },
   * result? }
   */
  async function decideSuggestion ({ actorId, teamId, id, body } = {}) {
    if (!isUuid(teamId) || !isUuid(id)) return notFound()
    const decision = isPlainObject(body) ? body.decision : undefined
    if (!SUGGESTION_DECISIONS.includes(decision)) return invalid('decision: confirm or reject')
    return guarded('decide-suggestion', async () => {
      const client = await connectClient(pool, log)
      let done = false
      const abort = (answer) => Object.assign(new Error('abort'), { answer })
      try {
        await client.query('BEGIN')
        const team = await clubTeam(client, teamId)
        if (!team) throw abort(notFound())
        const { rows: [s] } = await client.query(
          'SELECT s.id, s.match_id, s.side, s.team_name, s.status, s.season FROM public.roster_suggestions s WHERE s.id = $1 FOR UPDATE', [id])
        if (!s || key(s.team_name) !== key(team.name)) throw abort(notFound())
        if (s.status !== 'open') throw abort(decided())
        const { rows: [m] } = await client.query(`SELECT ${MATCH_COLUMNS} FROM public.matches m WHERE m.id = $1 FOR SHARE`, [s.match_id])
        if (!m) throw abort(notFound())
        if (!isOfficial(m) || !isClosed(m)) throw abort(notClosed())
        const year = seasonOf(clock())
        if (s.season !== year) throw abort(fail(409, 'OV_SUGGESTION_OLD', 'This suggestion is of a past season'))
        let result = null
        if (decision === 'confirm') {
          const game = await scheduleOf(client, m.game_n)
          if (!game) throw abort(notClosed())
          result = await mergeSide(client, {
            m, game, side: s.side, team, roster: rosterOf(m, s.side), year, actorId, suggestions: true,
            action: 'team.squad.suggestion', extra: { event: 'confirmed', suggestion_id: s.id }
          })
          if (result.error) throw abort(fail(409, 'OV_SUGGESTION_FAILED', `The saved team could not take the roster (${result.error})`))
        } else {
          await audit(client, {
            actorId,
            action: 'team.squad.suggestion',
            matchId: m.id,
            details: { event: 'rejected', suggestion_id: s.id, game_number: String(m.game_n), season: year, side: s.side, team_id: team.id, club_id: team.club_id }
          })
        }
        const status = decision === 'confirm' ? 'confirmed' : 'rejected'
        await client.query(
          'UPDATE public.roster_suggestions SET status = $2, decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1',
          [s.id, status, isUuid(actorId) ? actorId : null])
        await client.query('COMMIT')
        done = true
        return ok({ suggestion: { id: s.id, status }, ...(result ? { result: { changed: result.changed, latest: result.latest, counts: result.counts, club_added: result.club?.added ?? 0 } } : {}) })
      } finally {
        if (!done) { try { await client.query('ROLLBACK') } catch { /* connection already gone */ } }
        client.release()
      }
    })
  }

  /** The matches waiting for their run (tests, /health). */
  const pending = () => [...jobs.keys()]

  /** Tests: the waiting runs at once, and every run that is going, done. */
  async function flush () {
    for (const [id, job] of [...jobs]) {
      clearTimer(job.timer)
      fire(id, job)
    }
    await Promise.all([...running.values()])
  }

  /** No more runs (the timers cleared). */
  function stop () {
    for (const job of jobs.values()) clearTimer(job.timer)
    jobs.clear()
  }

  return { note, schedule, run, catchUp, pending, flush, stop, listSuggestions, decideSuggestion }
}
