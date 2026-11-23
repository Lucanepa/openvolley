/**
 * licences — a club's licence lists from VolleyManager's club administration
 * (db/024, docs/club-licences-spec.md).
 *
 * A club manager reads the XLSX export in the browser
 * (frontend src/utils/vmLicenceExport.js) and sends four fields per person:
 * licence number (Swiss Volley "SV" number), last name, first name and
 * gender. Nothing else of the export reaches the server, and this module
 * refuses any other field, with one exception: `dob`, which older manager
 * builds and Club API clients still send, is accepted and dropped (db/048,
 * owner 2026-11-19: "ONLY licence number", no dates of birth anywhere). Three
 * lists per club: players, scorers, coaches; each upload replaces the
 * imported rows of its list.
 *
 * db/026 (owner 2026-11-10: "if I add somebody manually, when saving ask if I
 * want to save him/her in the club. Those from the club/recognized/linked ->
 * green shield. Those added manually -> gray shield, but can be linked
 * later."): a team or club manager may add people typed in by hand to the
 * club's lists, the same four fields (source 'manual'). An upload keeps them,
 * and turns those it contains into imported rows; Delete list (an empty
 * upload) removes them too. A row of the players list has `manual`: true when
 * it was added by hand; a person (every list once) when all its rows are (the
 * gray shield), with the fields of its imported rows first. A licence number
 * the club has in any list is never added by hand again (nobody passes for
 * someone of another list); at most MAX_MANUAL_PER_CLUB hand-added rows per
 * club and MAX_MANUAL_PER_DAY per account a day; a club manager deletes one
 * of them (deleteRow).
 *
 * db/048 (owner 2026-11-19): the people of an official match's roster with a
 * licence number join the lists too, source 'match' (addFromMatch, called by
 * lib/rosterSaveBack.js): the rules of a hand-added row (never over a row the
 * club has, an upload keeps them, the gray shield, deleteRow), counted with
 * them in the MAX_MANUAL_PER_CLUB rows no upload brought, no daily cap.
 *
 * db/037: each row has the season of its upload (or of its adding by hand);
 * only the current season's rows are served, sweep() deletes the others
 * (server.js, daily). Each row has an id: My club's person page and deleteRow
 * use it, never the licence number.
 *
 * Who gets what (owner decision 2: only what each role needs):
 * Club managers of the club (and admins), lib/manageApi.js:
 *   putList({ clubId, list, people, userId })  replaces the imported rows of one list (<= 2000
 *                                              people); an empty list deletes the whole list
 *   clubList({ clubId })                       every person once: lists, teams, row id and the
 *                                              rows added by hand
 *   addPeople({ clubId, body, userId })        { people: [{ list, ...four fields }] } (1 to 30) by
 *                                              hand: new licence numbers only, never over a row
 *   deleteRow({ clubId, rowId, userId })       one row added by hand
 * Whoever may manage the team (lib/teams.js mayManage):
 *   teamClubPlayers({ teamId })                the team's club: its players of the team's gender
 *                                              (filtered here, never in the browser) and the
 *                                              people of the team's saved team (`people`, the
 *                                              shields). No age class filter since db/048 (it
 *                                              read the dates of birth): a youth team is offered
 *                                              every player of its gender
 *   searchPeople({ teamId, q })                at most MAX_SEARCH_RESULTS people of the club's
 *                                              lists by name or licence number (an official may
 *                                              be anyone of the club)
 *   addPeople({ teamId, body, userId })        the same as the club's, to the team's club
 * Scorers (indoor canReadTeams, as GET /api/game-rosters):
 *   scorerClubPlayers({ userId })              each club of the caller: its teams, their gender,
 *                                              its players list and every person of its lists
 *                                              once (the tablet's copy)
 *   scorerDob()                                GET /api/club-licences/dob of apps before db/048:
 *                                              always { people: [] } (no dates of birth kept)
 * Everyone else (lib/teams.js, lib/rosterSaveBack.js, server.js):
 *   wrongGender(db, team, players)             the first player of the club's players list
 *                                              whose gender is not the team's, or null; players
 *                                              only, never the team's officials (owner 2026-11-09:
 *                                              "coaches can literally be any player/member of the
 *                                              club")
 *   wrongGenders(db, team, players)            every such player: Map index -> gender
 *   addFromMatch(client, { clubId, people })   an official match's people with a licence number
 *                                              (source 'match'), on the caller's transaction
 *   teamGenders(db, names)                     Map team key -> 'm' | 'f' | null (svrz_games)
 *   sweep()                                    deletes the rows of past seasons
 *
 * Personal data (names, licence numbers, gender): served only
 * through these routes, never on the /api/db allowlist, never anonymous; the
 * audit keeps the list and the count, never a name. A database without db/024
 * answers "no list" to the reads and never blocks a squad or a roster; one
 * without db/026 reads every row as imported and answers 503 to the writes;
 * one without db/037 reads every row as one of the current season and
 * answers 503 to the writes (run 037 first).
 *
 * Every answer is the { status, body } shape of lib/accounts.js; nothing throws.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf } from './officialGame.js'
import { connectClient } from './pgClient.js'

export const LICENCE_LISTS = Object.freeze(['players', 'scorers', 'coaches'])
export const MAX_LICENCE_PEOPLE = 2000
export const LICENCE_NAME_MAX = 100
// The only fields a person of a list has (owner 2026-11-09; db/048: no date of birth)
export const LICENCE_FIELDS = Object.freeze(['sv_number', 'last_name', 'first_name', 'gender'])
// Accepted in a person and dropped: older manager builds and Club API clients
// still send the date of birth (db/048)
const DROPPED_FIELDS = Object.freeze(['dob'])
// db/026: people added by hand from a roster, at most this many per request
export const MAX_MANUAL_PEOPLE = 30
// ... and at most this many rows added by hand per club, and per account a day
export const MAX_MANUAL_PER_CLUB = 300
export const MAX_MANUAL_PER_DAY = 100
// A team manager's search of the club's people (an official): a few rows, never the list
export const MAX_SEARCH_RESULTS = 10
export const SEARCH_MIN_LENGTH = 3
// Owner decision 7 (audit 2611, PERM-19): it finds a person, it cannot dump a
// list. A name word matches the START of a part of a name (at least
// SEARCH_MIN_LENGTH letters for the longest word), a licence number matches
// whole, and one account gets at most SEARCH_DAILY_PEOPLE different people
// in 24 hours (those it was shown already come again); every search is audited
export const SEARCH_DAILY_PEOPLE = 50
const SEARCH_WINDOW = '24 hours'
const MANUAL_FIELDS = Object.freeze(['list', ...LICENCE_FIELDS])
const SV_RE = /^[0-9]{4,7}$/
// No db/024 (or db/023) yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
// db/026's column; 'import' on a database without it (every row of before is an import)
const sourceSql = (alias) => `coalesce(to_jsonb(${alias}) ->> 'source', 'import')`
// A row no upload brought: added by hand (db/026) or from an official match's
// roster (db/048, lib/rosterSaveBack.js); both have the gray shield, an upload
// keeps them and turns those it contains into imported rows, and a club
// manager deletes one of them (deleteRow)
const notUploaded = (source) => source === 'manual' || source === 'match'
// db/037's columns: a row of the season in `param` or later (every row without
// the column), and the row's id (null without it)
const currentSql = (alias, param) => `coalesce((to_jsonb(${alias}) ->> 'season')::int, ${param}::int) >= ${param}::int`
const idSql = (alias) => `(to_jsonb(${alias}) ->> 'id')`
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const tidy = (s) => s.trim().replace(/\s+/g, ' ')
const fold = (s) => key(s).normalize('NFD').replace(/\p{Diacritic}/gu, '')

export const WRONG_GENDER = (index, gender) => {
  const r = fail(400, 'OV_WRONG_GENDER', 'This player is in the club\'s licence list with the other gender than the team\'s', `players[${index}].license_number`)
  r.body.error.index = index
  r.body.error.gender = gender
  return r
}
export const MANUAL_LIMIT = (limit, per) => fail(409, 'OV_MANUAL_LIMIT',
  per === 'club'
    ? `The club's lists hold at most ${limit} people added by hand: upload the list from VolleyManager instead`
    : `At most ${limit} people can be added by hand a day`)

/** VolleyManager's gender of a game (vmSync: 'men' | 'women' | ''; tests 'm' | 'f'): 'm', 'f', '' (none) or 'x' (another value). */
export function scheduleGender (raw) {
  const g = key(raw)
  if (!g) return ''
  if (['m', 'men', 'male', 'h', 'herren', 'hommes', 'uomini', 'masculin'].includes(g)) return 'm'
  if (['f', 'w', 'women', 'female', 'd', 'damen', 'dames', 'donne', 'feminin', 'féminin'].includes(g)) return 'f'
  return 'x'
}

/**
 * The gender of a team from the genders of its games: the one gender they
 * have; null when there is none, a mixed one, or both (no check then). A game
 * without a gender says nothing.
 */
export function teamGenderOf (values) {
  const seen = new Set((values || []).map(scheduleGender).filter(Boolean))
  if (seen.size !== 1) return null
  const [g] = seen
  return g === 'm' || g === 'f' ? g : null
}

/**
 * The age class of a team from the leagues of its games ("U16 Juniorinnen",
 * "SM Quali U18"): the one "U<n>" they name (10 to 23); null when none names
 * one or they name several (no filter then). A league without one says
 * nothing (a cup).
 */
export function ageClassOf (leagues) {
  const seen = new Set()
  for (const l of leagues || []) {
    const m = /\bU ?(\d{2})\b/i.exec(String(l ?? ''))
    if (m && Number(m[1]) >= 10 && Number(m[1]) <= 23) seen.add(Number(m[1]))
  }
  if (seen.size !== 1) return null
  return [...seen][0]
}

/**
 * One person of a list: the four fields, trimmed. { person } or { error } (a
 * 400 answer). A field outside `fields` is refused; a date of birth
 * (DROPPED_FIELDS) is dropped, whatever it holds.
 */
function validPerson (raw, at, fields = LICENCE_FIELDS) {
  if (!isPlainObject(raw)) return { error: invalid(`${at}: must be an object`) }
  const extra = Object.keys(raw).find((k) => !fields.includes(k) && !DROPPED_FIELDS.includes(k))
  if (extra) return { error: invalid(`${at}.${extra.slice(0, 40)}: not accepted (only ${fields.join(', ')})`) }
  const sv = typeof raw.sv_number === 'number' && Number.isInteger(raw.sv_number) ? String(raw.sv_number) : (typeof raw.sv_number === 'string' ? raw.sv_number.trim() : '')
  if (!SV_RE.test(sv)) return { error: invalid(`${at}.sv_number: 4 to 7 digits`) }
  if (typeof raw.last_name !== 'string' || !tidy(raw.last_name)) return { error: invalid(`${at}.last_name: required`) }
  const last = tidy(raw.last_name)
  if (last.length > LICENCE_NAME_MAX) return { error: invalid(`${at}.last_name: at most ${LICENCE_NAME_MAX} characters`) }
  let first = null
  if (raw.first_name != null && raw.first_name !== '') {
    if (typeof raw.first_name !== 'string') return { error: invalid(`${at}.first_name: text or null`) }
    first = tidy(raw.first_name) || null
    if (first && first.length > LICENCE_NAME_MAX) return { error: invalid(`${at}.first_name: at most ${LICENCE_NAME_MAX} characters`) }
  }
  let gender = null
  if (raw.gender != null && raw.gender !== '') {
    if (raw.gender !== 'm' && raw.gender !== 'f') return { error: invalid(`${at}.gender: m, f or null`) }
    gender = raw.gender
  }
  return { person: { sv_number: sv, last_name: last, first_name: first, gender } }
}

/** A person named twice: the first one's fields, completed by the later one's. */
function completeWith (cur, p) {
  cur.first_name ??= p.first_name
  cur.gender ??= p.gender
}

/**
 * The people of one upload: the four fields, trimmed; a licence number twice
 * is one person (the first one's fields, completed by the later ones).
 * { people } or { error } (a 400 answer). Any other field is refused: nothing
 * else of the export may be sent.
 */
export function validateLicencePeople (people) {
  if (!Array.isArray(people)) return { error: invalid('people: an array') }
  if (people.length > MAX_LICENCE_PEOPLE) return { error: invalid(`people: at most ${MAX_LICENCE_PEOPLE}`) }
  const bySv = new Map()
  for (let i = 0; i < people.length; i++) {
    const v = validPerson(people[i], `people[${i}]`)
    if (v.error) return v
    const cur = bySv.get(v.person.sv_number)
    if (!cur) bySv.set(v.person.sv_number, v.person)
    else completeWith(cur, v.person)
  }
  return { people: [...bySv.values()] }
}

/**
 * The body of a hand-added batch (db/026): { people: [{ list, sv_number,
 * last_name, first_name, gender }] }, 1 to 30 entries, the four fields as
 * an upload's and the list (players, scorers, coaches). Nothing else in the
 * body or an entry. A licence number twice in one list is one person (as an
 * upload). { people } or { error } (a 400 answer).
 */
export function validateManualPeople (body) {
  if (!isPlainObject(body)) return { error: invalid('body: must be an object') }
  const extra = Object.keys(body).find((k) => k !== 'people')
  if (extra) return { error: invalid(`${extra.slice(0, 40)}: not accepted (only people)`) }
  const people = body.people
  if (!Array.isArray(people) || !people.length) return { error: invalid(`people: an array of 1 to ${MAX_MANUAL_PEOPLE}`) }
  if (people.length > MAX_MANUAL_PEOPLE) return { error: invalid(`people: at most ${MAX_MANUAL_PEOPLE}`) }
  const byKey = new Map()
  for (let i = 0; i < people.length; i++) {
    const at = `people[${i}]`
    const v = validPerson(people[i], at, MANUAL_FIELDS)
    if (v.error) return v
    const list = people[i].list
    if (!LICENCE_LISTS.includes(list)) return { error: invalid(`${at}.list: ${LICENCE_LISTS.join(', ')}`) }
    const k = `${list}:${v.person.sv_number}`
    const cur = byKey.get(k)
    if (!cur) byKey.set(k, { list, ...v.person })
    else completeWith(cur, v.person)
  }
  return { people: [...byKey.values()] }
}

// manual: no upload brought the row(s); from_match: an official match's
// roster did, all of them (db/048: "From a match" in My club, not "Added by hand")
const personOut = (r, manual, fromMatch) => ({
  sv_number: r.sv_number,
  last_name: r.last_name,
  first_name: r.first_name ?? null,
  gender: r.gender ?? null,
  manual,
  from_match: fromMatch
})
const byName = (a, b) => a.last_name.localeCompare(b.last_name, 'de') || String(a.first_name || '').localeCompare(String(b.first_name || ''), 'de') || a.sv_number.localeCompare(b.sv_number)
const listOrder = (l) => LICENCE_LISTS.indexOf(l)

/**
 * Rows of several lists ({ list, sv_number, last_name, first_name, gender,
 * source }) -> every person once ({ ...the four fields, manual,
 * from_match, lists }), in name order: the fields of the first imported row
 * that has them (players, scorers, coaches), then of the rows added by hand
 * (so a row typed in by hand never replaces what an upload says); the lists
 * in that order; manual when every row of the person is (db/026), from_match
 * when every row came from an official match's roster (db/048). `extra(sv)`
 * adds fields to a person (the teams of My club).
 */
export function mergeLicencePeople (rows, extra = null) {
  const people = new Map()
  const manualOf = new Map()
  const matchOf = new Map()
  const valid = (rows || []).filter((x) => LICENCE_LISTS.includes(x?.list))
  for (const r of valid) {
    manualOf.set(r.sv_number, (manualOf.get(r.sv_number) ?? true) && notUploaded(r.source))
    matchOf.set(r.sv_number, (matchOf.get(r.sv_number) ?? true) && r.source === 'match')
  }
  const rank = (r) => (notUploaded(r.source) ? 10 : 0) + listOrder(r.list)
  for (const r of [...valid].sort((a, b) => rank(a) - rank(b))) {
    const cur = people.get(r.sv_number)
    if (!cur) {
      people.set(r.sv_number, { ...personOut(r, manualOf.get(r.sv_number), matchOf.get(r.sv_number)), lists: [r.list], ...(extra ? extra(r.sv_number) : {}) })
      continue
    }
    if (!cur.lists.includes(r.list)) cur.lists.push(r.list)
    cur.first_name ??= r.first_name ?? null
    cur.gender ??= r.gender ?? null
  }
  for (const p of people.values()) p.lists.sort((a, b) => listOrder(a) - listOrder(b))
  return [...people.values()].sort(byName)
}

/** The players list of `rows` (several lists): the four fields, manual and from_match (this row's, db/026, db/048), in name order. */
const playersOf = (rows) => (rows || []).filter((r) => r.list === 'players').map((r) => personOut(r, notUploaded(r.source), r.source === 'match')).sort(byName)

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit (throws)
 * @param {object} o.clubs  lib/clubs.js (clubsOf: the clubs a scorer scores for)
 */
export function createLicences ({ pool, audit, clubs = null, logger = console, clock = () => new Date() } = {}) {
  const log = logger
  // The season the lists are served for (db/037): its first year
  const seasonNow = () => seasonOf(clock())
  const seasonLabel = (year) => `${year}/${String((year + 1) % 100).padStart(2, '0')}`

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
      log.error?.(`[licences] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  /** Map team key -> 'm' | 'f' | null from the teams' games (home or away). */
  async function teamGenders (db, names) {
    const keys = [...new Set((names || []).map(key).filter(Boolean))]
    const out = new Map(keys.map((k) => [k, null]))
    if (!keys.length) return out
    const { rows } = await (db || pool).query(
      `SELECT k, array_agg(DISTINCT coalesce(btrim(gender), '')) AS genders
         FROM (SELECT lower(btrim(team_home)) AS k, gender FROM public.svrz_games WHERE lower(btrim(team_home)) = ANY($1::text[])
               UNION ALL
               SELECT lower(btrim(team_away)), gender FROM public.svrz_games WHERE lower(btrim(team_away)) = ANY($1::text[])) x
        GROUP BY k`, [keys])
    for (const r of rows) out.set(r.k, teamGenderOf(r.genders))
    return out
  }

  /** The age class (U<n>, or null) of team `name` from the leagues of its games this season. */
  async function teamAgeClass (db, name, seasonYear) {
    const { rows } = await (db || pool).query(
      `SELECT DISTINCT btrim(league) AS league FROM public.svrz_games
        WHERE (lower(btrim(team_home)) = $1 OR lower(btrim(team_away)) = $1) AND datetime >= $2
          AND coalesce(btrim(league), '') <> ''`, [key(name), `${seasonYear}-07-01`])
    return ageClassOf(rows.map((r) => r.league))
  }

  /**
   * The club's people of one list (or every list) of the current season:
   * rows with their source and row id.
   */
  async function peopleOf (db, clubId, list = null) {
    const { rows } = await (db || pool).query(
      `SELECT l.list, l.sv_number, l.last_name, l.first_name, l.gender, ${sourceSql('l')} AS source, ${idSql('l')} AS id
         FROM public.club_licences l
        WHERE l.club_id = $1 AND ($2::text IS NULL OR l.list = $2) AND ${currentSql('l', '$3')}`, [clubId, list, seasonNow()])
    return rows
  }

  /** db/037: the club's rows of past seasons go (no longer served; they would hold a licence number). */
  async function dropPastSeasons (client, clubId) {
    try {
      await client.query('SAVEPOINT past_seasons')
      await client.query('DELETE FROM public.club_licences WHERE club_id = $1 AND season < $2', [clubId, seasonNow()])
      await client.query('RELEASE SAVEPOINT past_seasons')
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
      await client.query('ROLLBACK TO SAVEPOINT past_seasons')
    }
  }

  /**
   * The licence numbers of team `team`'s saved team of this season (players
   * and officials; lib/teams.js squad): the people of the team's shields.
   * Throws on a DB error.
   */
  async function squadLicences (db, team) {
    const { rows } = await (db || pool).query(
      `WITH sq AS (
         SELECT t.id FROM public.competition_teams t
           JOIN public.competitions co ON co.id = t.competition_id AND co.sport = 'indoor' AND co.season = $2 AND NOT co.archived
          WHERE lower(btrim(t.svrz_team_name)) = $1 OR (coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) = $1)
          ORDER BY (lower(btrim(t.svrz_team_name)) = $1) DESC NULLS LAST, t.updated_at DESC
          LIMIT 1)
       SELECT DISTINCT btrim(x.license_number) AS lic
         FROM sq JOIN (SELECT team_id, license_number FROM public.competition_players
                       UNION ALL SELECT team_id, license_number FROM public.competition_staff) x ON x.team_id = sq.id
        WHERE coalesce(btrim(x.license_number), '') <> ''`, [key(team.name), seasonLabel(seasonNow())])
    return new Set(rows.map((r) => r.lic))
  }

  /** The team of a team manager's read with its club: { id, name, club_id, club_name } or null. */
  async function teamOf (db, teamId) {
    const { rows: [t] } = await (db || pool).query(
      `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
         FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id WHERE ct.id = $1`, [teamId])
    return t ? { id: t.id, name: t.name, club_id: t.club_id, club_name: t.club_name } : null
  }

  /**
   * The first player of `players` (body order) whose licence number is in the
   * players list of `team`'s club with a gender other than the team's:
   * { index, gender } or null. No check while the team's gender is unknown,
   * and none without db/024. `team`: { name, club_id }. Throws on a DB error.
   * Callers pass the players only: the team's officials (coach, assistant
   * coaches, physiotherapist, medic) may be anyone of the club, of either
   * gender (owner 2026-11-09).
   */
  async function wrongGender (db, team, players) {
    const wrong = await wrongGenders(db, team, players)
    if (!wrong.size) return null
    const [[index, gender]] = wrong
    return { index, gender }
  }

  /**
   * Every player of `players` that wrongGender() refuses: Map index -> the
   * list's gender, in body order (empty: none, or no check). lib/rosterSaveBack.js
   * leaves those out of a saved team instead of refusing the whole roster.
   * Throws on a DB error.
   */
  async function wrongGenders (db, team, players) {
    const out = new Map()
    if (!team || !isUuid(team.club_id) || !Array.isArray(players) || !players.length) return out
    const lics = [...new Set(players.map((p) => String(p?.license_number ?? '').trim()).filter((s) => SV_RE.test(s)))]
    if (!lics.length) return out
    try {
      const want = (await teamGenders(db, [team.name])).get(key(team.name)) ?? null
      if (!want) return out
      const { rows } = await (db || pool).query(
        `SELECT sv_number, gender FROM public.club_licences l
          WHERE club_id = $1 AND list = 'players' AND sv_number = ANY($2::text[]) AND gender IS NOT NULL AND gender <> $3
            AND ${currentSql('l', '$4')}`,
        [team.club_id, lics, want, seasonNow()])
      if (!rows.length) return out
      const wrong = new Map(rows.map((r) => [r.sv_number, r.gender]))
      players.forEach((p, i) => {
        const g = wrong.get(String(p?.license_number ?? '').trim())
        if (g) out.set(i, g)
      })
      return out
    } catch (err) {
      if (MISSING.has(err?.code)) return out
      throw err
    }
  }

  /**
   * The licence numbers of the players list of `team`'s club that fit the
   * team's gender (or have none), with the team's gender and age class (the
   * U<n> of its leagues: shown, no longer a filter since db/048, which took
   * the dates of birth it read). Throws on a DB error (MISSING without db/024).
   */
  async function fittingPlayers (db, team, rows = null) {
    const year = seasonNow()
    const gender = (await teamGenders(db, [team.name])).get(key(team.name)) ?? null
    const ageClass = await teamAgeClass(db, team.name, year)
    const players = (rows ?? await peopleOf(db, team.club_id, 'players')).filter((r) => r.list === 'players')
    const fit = new Set(players.filter((r) => !gender || !r.gender || r.gender === gender).map((r) => r.sv_number))
    return { fit, gender, ageClass }
  }

  /** db/037: deletes the rows of past seasons (server.js, daily). The number of rows; never throws. */
  async function sweep () {
    try {
      const { rowCount } = await pool.query('DELETE FROM public.club_licences WHERE season < $1', [seasonNow()])
      if (rowCount) log.info?.(`[licences] swept ${rowCount} row(s) of past seasons`)
      return rowCount
    } catch (err) {
      if (!MISSING.has(err?.code)) log.warn?.(`[licences] sweep failed: ${err?.code || err?.message}`)
      return 0
    }
  }

  // ---------------------------------------------------------------- club managers
  /**
   * PUT /api/club/:id/licences/:list { people }: an upload, in one
   * transaction. It replaces the imported rows of the list; the rows added by
   * hand stay (db/026), and one whose licence number the upload has becomes
   * an imported row with the upload's fields. An empty list is Delete list:
   * every row of the list goes, the hand-added ones too. The rows are of the
   * current season (db/037); the club's rows of past seasons go.
   * { list, count (the people of the upload), manual (the hand-added rows the
   * list keeps), imported_at }.
   */
  async function putList ({ clubId, list, people, userId } = {}) {
    if (!isUuid(clubId)) return notFound()
    if (!LICENCE_LISTS.includes(list)) return notFound()
    const v = validateLicencePeople(people)
    if (v.error) return v.error
    return guarded('put-list', () => withTx(async (client) => {
      // one upload (or hand-added batch) of a club at a time
      const { rows: [c] } = await client.query('SELECT id FROM public.clubs WHERE id = $1 FOR NO KEY UPDATE', [clubId])
      if (!c) throw abort(notFound())
      await dropPastSeasons(client, clubId)
      const p = v.people
      if (!p.length) {
        await client.query('DELETE FROM public.club_licences WHERE club_id = $1 AND list = $2', [clubId, list])
      } else {
        // the rows of people still in the list stay (updated below), so that a
        // person keeps its row id (the person page's link) across uploads
        await client.query("DELETE FROM public.club_licences WHERE club_id = $1 AND list = $2 AND source = 'import' AND sv_number <> ALL($3::text[])",
          [clubId, list, p.map((x) => x.sv_number)])
        await client.query(
          `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, gender, imported_by, source, season)
           SELECT $1, $2, x.sv, x.ln, x.fn, x.g, $3, 'import', $8
             FROM unnest($4::text[], $5::text[], $6::text[], $7::text[]) AS x(sv, ln, fn, g)
           ON CONFLICT (club_id, list, sv_number) DO UPDATE
              SET last_name = EXCLUDED.last_name, first_name = EXCLUDED.first_name, gender = EXCLUDED.gender,
                  source = 'import', imported_at = EXCLUDED.imported_at, imported_by = EXCLUDED.imported_by, season = EXCLUDED.season`,
          [clubId, list, isUuid(userId) ? userId : null, p.map((x) => x.sv_number), p.map((x) => x.last_name),
            p.map((x) => x.first_name), p.map((x) => x.gender), seasonNow()])
      }
      const { rows: [n] } = await client.query(
        "SELECT count(*)::int AS manual, now() AS at FROM public.club_licences WHERE club_id = $1 AND list = $2 AND source <> 'import'", [clubId, list])
      // the list and the count only: never a name
      await audit(client, { actorId: userId, action: 'club.licences', details: { club_id: clubId, list, count: p.length } })
      return ok({ list, count: p.length, manual: n.manual, imported_at: iso(n.at) })
    }))
  }

  /**
   * POST /api/club/:id/licences/people and POST /api/team/:id/club-people
   * { people: [{ list, sv_number, last_name, first_name, gender }] } (a dob is dropped)
   * (db/026): people a manager typed in by hand (a squad's rows with a licence
   * number), added to the club's lists as 'manual' rows of the current season.
   * A licence number the club has in ANY of its lists (imported or by hand)
   * is left as it is: nothing is overwritten, and a row typed in by hand never
   * stands for someone of another list. 409 OV_MANUAL_LIMIT past
   * MAX_MANUAL_PER_CLUB rows by hand in the club or MAX_MANUAL_PER_DAY rows
   * added by this account in a day. `teamId`: the team's club (404 for a
   * team without one). { club_id, added, already } (people of the request
   * added / already there).
   */
  async function addPeople ({ clubId = null, teamId = null, body, userId } = {}) {
    if (clubId != null && !isUuid(clubId)) return notFound()
    if (teamId != null && !isUuid(teamId)) return notFound()
    if (!clubId && !teamId) return notFound()
    const v = validateManualPeople(body)
    if (v.error) return v.error
    return guarded('add-people', () => withTx(async (client) => {
      let club = clubId
      if (teamId) {
        const { rows: [t] } = await client.query('SELECT club_id FROM public.club_teams WHERE id = $1', [teamId])
        if (!t?.club_id || (clubId && t.club_id !== clubId)) throw abort(notFound())
        club = t.club_id
      }
      // one upload (or hand-added batch) of a club at a time
      const { rows: [c] } = await client.query('SELECT id FROM public.clubs WHERE id = $1 FOR NO KEY UPDATE', [club])
      if (!c) throw abort(notFound())
      await dropPastSeasons(client, club)
      const p = v.people
      const { rows: held } = await client.query(
        'SELECT DISTINCT sv_number FROM public.club_licences WHERE club_id = $1 AND sv_number = ANY($2::text[])', [club, p.map((x) => x.sv_number)])
      const taken = new Set(held.map((r) => r.sv_number))
      const fresh = p.filter((x) => !taken.has(x.sv_number))
      if (fresh.length) {
        const { rows: [n] } = await client.query(
          `SELECT (SELECT count(*)::int FROM public.club_licences WHERE club_id = $1 AND source = 'manual') AS club,
                  (SELECT count(*)::int FROM public.club_licences
                    WHERE imported_by = $2 AND source = 'manual' AND imported_at > now() - interval '1 day') AS mine`,
          [club, isUuid(userId) ? userId : null])
        if (n.club + fresh.length > MAX_MANUAL_PER_CLUB) throw abort(MANUAL_LIMIT(MAX_MANUAL_PER_CLUB, 'club'))
        if (isUuid(userId) && n.mine + fresh.length > MAX_MANUAL_PER_DAY) throw abort(MANUAL_LIMIT(MAX_MANUAL_PER_DAY, 'day'))
      }
      const { rows: added } = fresh.length
        ? await client.query(
          `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, gender, imported_by, source, season)
           SELECT $1, x.list, x.sv, x.ln, x.fn, x.g, $2, 'manual', $8
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS x(list, sv, ln, fn, g)
           ON CONFLICT (club_id, list, sv_number) DO NOTHING
           RETURNING list`,
          [club, isUuid(userId) ? userId : null, fresh.map((x) => x.list), fresh.map((x) => x.sv_number), fresh.map((x) => x.last_name),
            fresh.map((x) => x.first_name), fresh.map((x) => x.gender), seasonNow()])
        : { rows: [] }
      if (added.length) {
        const lists = {}
        for (const r of added) lists[r.list] = (lists[r.list] || 0) + 1
        // the club, the team and the counts only: never a name or a licence number
        await audit(client, { actorId: userId, action: 'club.licences.manual', details: { club_id: club, team_id: teamId, added: added.length, lists } })
      }
      return ok({ club_id: club, added: added.length, already: p.length - added.length })
    }))
  }

  /**
   * The people of an official match's roster (lib/rosterSaveBack.js, owner
   * 2026-11-19: "a big database ... last name first name number and licence
   * n"): [{ list, sv_number, last_name, first_name }] added to club `clubId`'s
   * lists as rows of source 'match' (db/048) of the current season, on
   * `client` (the caller's transaction). The rules of addPeople: a licence
   * number the club has in ANY list stays as it is (nothing is overwritten,
   * an upload's row least of all), the club is locked against an upload at
   * the same time, its rows of past seasons go. The rows not from an upload
   * (by hand or from a match) stay within MAX_MANUAL_PER_CLUB: those past it
   * are left out (`capped`), never an error; no daily cap (no account writes
   * them). A person addPeople would refuse is left out (`invalid`). No
   * gender: a roster does not say it (an official match's player of the
   * other gender is a scorer's mistake to fix, not a fact to keep).
   * { added, already, capped, invalid, lists }. Throws on a DB error (a
   * database without db/048 refuses the source: 23514).
   */
  async function addFromMatch (client, { clubId, people } = {}) {
    const out = { added: 0, already: 0, capped: 0, invalid: 0, lists: {} }
    if (!isUuid(clubId) || !Array.isArray(people) || !people.length) return out
    const byKey = new Map()
    for (const raw of people) {
      const list = raw?.list
      const v = LICENCE_LISTS.includes(list)
        ? validPerson({ sv_number: raw.sv_number, last_name: raw.last_name, first_name: raw.first_name ?? null }, 'person')
        : { error: true }
      if (v.error) { out.invalid++; continue }
      const k = `${list}:${v.person.sv_number}`
      if (!byKey.has(k)) byKey.set(k, { list, ...v.person })
    }
    const p = [...byKey.values()]
    if (!p.length) return out
    const { rows: [c] } = await client.query('SELECT id FROM public.clubs WHERE id = $1 FOR NO KEY UPDATE', [clubId])
    if (!c) return out
    await dropPastSeasons(client, clubId)
    const { rows: held } = await client.query(
      'SELECT DISTINCT sv_number FROM public.club_licences WHERE club_id = $1 AND sv_number = ANY($2::text[])', [clubId, p.map((x) => x.sv_number)])
    const taken = new Set(held.map((r) => r.sv_number))
    // one person once (a player who is also the coach goes to the players list)
    const seen = new Set()
    const fresh = []
    for (const x of p.sort((a, b) => listOrder(a.list) - listOrder(b.list))) {
      if (taken.has(x.sv_number) || seen.has(x.sv_number)) { out.already++; continue }
      seen.add(x.sv_number)
      fresh.push(x)
    }
    if (!fresh.length) return out
    const { rows: [n] } = await client.query(
      "SELECT count(*)::int AS rows FROM public.club_licences WHERE club_id = $1 AND source <> 'import'", [clubId])
    const room = Math.max(0, MAX_MANUAL_PER_CLUB - n.rows)
    const go = fresh.slice(0, room)
    out.capped = fresh.length - go.length
    if (!go.length) return out
    const { rows: added } = await client.query(
      `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, gender, imported_by, source, season)
       SELECT $1, x.list, x.sv, x.ln, x.fn, NULL, NULL, 'match', $6
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS x(list, sv, ln, fn)
       ON CONFLICT (club_id, list, sv_number) DO NOTHING
       RETURNING list`,
      [clubId, go.map((x) => x.list), go.map((x) => x.sv_number), go.map((x) => x.last_name), go.map((x) => x.first_name), seasonNow()])
    out.added = added.length
    out.already += go.length - added.length
    for (const r of added) out.lists[r.list] = (out.lists[r.list] || 0) + 1
    return out
  }

  /**
   * DELETE /api/club/:id/licences/rows/:rowId (db/037): one row added by
   * hand, by its id. An imported row is the upload's (409 OV_NOT_HAND_ADDED:
   * upload the list again). { deleted: true, list }.
   */
  async function deleteRow ({ clubId, rowId, userId } = {}) {
    if (!isUuid(clubId) || !isUuid(rowId)) return notFound()
    return guarded('delete-row', () => withTx(async (client) => {
      const { rows: [c] } = await client.query('SELECT id FROM public.clubs WHERE id = $1 FOR NO KEY UPDATE', [clubId])
      if (!c) throw abort(notFound())
      const { rows: [r] } = await client.query('SELECT list, source FROM public.club_licences WHERE club_id = $1 AND id = $2', [clubId, rowId])
      if (!r) throw abort(notFound())
      if (!notUploaded(r.source)) throw abort(fail(409, 'OV_NOT_HAND_ADDED', 'Only a person added by hand or from a match is removed one by one; upload the list again for the others'))
      await client.query('DELETE FROM public.club_licences WHERE club_id = $1 AND id = $2', [clubId, rowId])
      // the club and the list only: never a name or a licence number
      await audit(client, { actorId: userId, action: 'club.licences.manual_delete', details: { club_id: clubId, list: r.list } })
      return ok({ deleted: true, list: r.list })
    }))
  }

  /**
   * GET /api/club/:id/licences: every person of the club's lists once
   * ({ id, sv_number, last_name, first_name, gender, manual, from_match,
   * lists, teams, hand_rows }), and per list { count, manual, from_match,
   * imported_at, imported_by_name }: count every row, manual those no upload
   * brought (by hand, db/026, or from a match, db/048), from_match those of
   * them from an official match's roster, imported_at and imported_by_name
   * the last upload's (null when there was none). id: the person's first
   * imported row, else its first row (db/037: the person page's key; kept
   * across uploads), row_ids: all its rows; hand_rows: its rows no upload
   * brought ({ id, list, source: 'manual' | 'match' }, deleteRow). teams: the
   * club's teams whose saved team of this season (lib/teams.js squad) has a
   * player or an official with that licence number. The current season's
   * rows only (db/037).
   */
  async function clubList ({ clubId } = {}) {
    if (!isUuid(clubId)) return notFound()
    return guarded('club-list', async () => {
      const { rows: [c] } = await pool.query('SELECT id FROM public.clubs WHERE id = $1', [clubId])
      if (!c) return notFound()
      let rows = []
      let summary = []
      try {
        rows = await peopleOf(pool, clubId)
        ;({ rows: summary } = await pool.query(
          `WITH r AS (SELECT l.*, ${sourceSql('l')} AS src FROM public.club_licences l WHERE l.club_id = $1 AND ${currentSql('l', '$2')}),
                n AS (SELECT list, count(*)::int AS count, (count(*) FILTER (WHERE src <> 'import'))::int AS manual,
                             (count(*) FILTER (WHERE src = 'match'))::int AS from_match FROM r GROUP BY list),
                i AS (SELECT DISTINCT ON (r.list) r.list, r.imported_at, ${nameSql('p')} AS imported_by_name
                        FROM r LEFT JOIN public.profiles p ON p.user_id = r.imported_by
                       WHERE r.src = 'import'
                       ORDER BY r.list, r.imported_at DESC)
           SELECT n.list, n.count, n.manual, n.from_match, i.imported_at, i.imported_by_name FROM n LEFT JOIN i ON i.list = n.list`, [clubId, seasonNow()]))
      } catch (err) {
        if (!MISSING.has(err?.code)) throw err
      }
      // the season label of the saved teams (lib/teams.js seasonLabel)
      const season = seasonLabel(seasonNow())
      // licence number -> [{ id, name }] of the club's teams whose saved team has it
      const teamsOf = new Map()
      if (rows.length) {
        const { rows: hits } = await pool.query(
          `WITH sq AS (
             SELECT DISTINCT ON (ct.id) ct.id AS team_id, ct.team_name, t.id AS saved_id
               FROM public.club_teams ct
               JOIN public.competition_teams t
                 ON lower(btrim(t.svrz_team_name)) = lower(btrim(ct.team_name))
                 OR (coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) = lower(btrim(ct.team_name)))
               JOIN public.competitions co ON co.id = t.competition_id AND co.sport = 'indoor' AND co.season = $2 AND NOT co.archived
              WHERE ct.club_id = $1
              ORDER BY ct.id, (lower(btrim(t.svrz_team_name)) = lower(btrim(ct.team_name))) DESC NULLS LAST, t.updated_at DESC)
           SELECT DISTINCT sq.team_id, sq.team_name, btrim(x.license_number) AS lic
             FROM sq
             JOIN (SELECT team_id, license_number FROM public.competition_players
                   UNION ALL SELECT team_id, license_number FROM public.competition_staff) x ON x.team_id = sq.saved_id
            WHERE btrim(x.license_number) IN (SELECT sv_number FROM public.club_licences WHERE club_id = $1)`, [clubId, season])
        for (const h of hits) {
          if (!teamsOf.has(h.lic)) teamsOf.set(h.lic, [])
          teamsOf.get(h.lic).push({ id: h.team_id, name: h.team_name })
        }
      }
      // db/037: the person's row id (an imported row first: it stays across
      // uploads), all its row ids (an older link still finds it) and its rows
      // added by hand
      const idOf = new Map()
      const idsOf = new Map()
      const handOf = new Map()
      const order = (r) => (notUploaded(r.source) ? 10 : 0) + listOrder(r.list)
      for (const r of [...rows].sort((a, b) => order(a) - order(b))) {
        if (!idOf.has(r.sv_number)) idOf.set(r.sv_number, r.id ?? null)
        if (r.id) idsOf.set(r.sv_number, [...(idsOf.get(r.sv_number) || []), r.id])
        if (notUploaded(r.source) && r.id) {
          if (!handOf.has(r.sv_number)) handOf.set(r.sv_number, [])
          handOf.get(r.sv_number).push({ id: r.id, list: r.list, source: r.source })
        }
      }
      // one entry per licence number: its fields from the first imported list that has them
      const people = mergeLicencePeople(rows, (sv) => ({
        id: idOf.get(sv) ?? null,
        row_ids: idsOf.get(sv) || [],
        teams: (teamsOf.get(sv) || []).sort((a, b) => a.name.localeCompare(b.name)),
        hand_rows: handOf.get(sv) || []
      }))
      const lists = Object.fromEntries(LICENCE_LISTS.map((l) => {
        const s = summary.find((x) => x.list === l)
        return [l, s
          ? { count: s.count, manual: s.manual, from_match: s.from_match, imported_at: iso(s.imported_at), imported_by_name: s.imported_by_name ?? null }
          : { count: 0, manual: 0, from_match: 0, imported_at: null, imported_by_name: null }]
      }))
      return ok({ season, lists, people })
    })
  }

  // ---------------------------------------------------------------- team managers
  /**
   * The team of a team manager's read, its club's rows of this season and the
   * licence numbers of its saved team: { team, rows, squad } or { answer }.
   */
  async function teamRows (teamId) {
    const team = await teamOf(pool, teamId)
    if (!team) return { answer: notFound() }
    let rows = []
    try {
      rows = await peopleOf(pool, team.club_id)
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    const squad = rows.length ? await squadLicences(pool, team) : new Set()
    const { fit, gender, ageClass } = await fittingPlayers(pool, team, rows)
    return { team, rows, squad, fit, gender, ageClass }
  }

  /**
   * GET /api/team/:id/club-players: the team's club for "Add from club", the
   * team's gender (null: no check) and age class (U<n> of its leagues, null:
   * none; shown only, no filter since db/048). Owner decision 2: only what
   * the team needs, decided here. `players`: the players list of the team's
   * gender (and those without one); `people`: the people of the team's saved
   * team and those players, once each with its `lists` (the shields of the
   * squad's rows; an official of the club is found with searchPeople). Each
   * person has `manual` (db/026: added by hand, not in any upload).
   */
  async function teamClubPlayers ({ teamId } = {}) {
    if (!isUuid(teamId)) return notFound()
    return guarded('team-club-players', async () => {
      const x = await teamRows(teamId)
      if (x.answer) return x.answer
      const { team, rows, squad, fit, gender, ageClass } = x
      const players = playersOf(rows).filter((p) => fit.has(p.sv_number))
      const people = mergeLicencePeople(rows.filter((r) => squad.has(r.sv_number) || fit.has(r.sv_number)))
      return ok({ team, gender, age_class: ageClass ? `U${ageClass}` : null, players, people })
    })
  }

  /**
   * GET /api/team/:id/club-people?q=: the people of the club's lists that `q`
   * names (accents and case aside), at most MAX_SEARCH_RESULTS, each once
   * with its `lists`. An official may be anyone of the club (owner
   * 2026-11-09), so a team manager finds one by name instead of reading the
   * whole lists (owner decision 2), and cannot rebuild them from the search
   * (owner decision 7, PERM-19): `q` is a licence number (whole), or words
   * that each begin a part of the person's name ("mül an" finds Anna Müller,
   * "ller" nobody), the longest at least SEARCH_MIN_LENGTH letters. An
   * account sees at most SEARCH_DAILY_PEOPLE different people in 24 hours;
   * past that only those it was shown already (`limited`: someone was left
   * out). Each search is audited (club.people_search: the team, the counts,
   * the ids of the rows shown; never a name, a licence or the query).
   * `unlimited`: an admin or a manager of the team's club (they read the
   * whole lists anyway): no budget, no audit. { people, more, limited? }
   */
  async function searchPeople ({ teamId, q, userId = null, unlimited = false } = {}) {
    if (!isUuid(teamId)) return notFound()
    const needle = fold(typeof q === 'string' ? q : '').replace(/[,;]+/g, ' ').trim()
    if (needle.length < SEARCH_MIN_LENGTH || needle.length > 80) return invalid(`q: ${SEARCH_MIN_LENGTH} to 80 characters`)
    const licence = /^[0-9]{4,7}$/.test(needle) ? needle : null
    const words = licence ? [] : needle.split(/\s+/).filter(Boolean)
    if (!licence && Math.max(0, ...words.map((w) => w.length)) < SEARCH_MIN_LENGTH) {
      return invalid(`q: a word of ${SEARCH_MIN_LENGTH} letters at least, or a licence number`)
    }
    const partsOf = (p) => fold(`${p.last_name} ${p.first_name || ''}`).split(/[\s\-'’.]+/).filter(Boolean)
    // each word begins a part of the name, two words not the same part
    const named = (p) => {
      const parts = partsOf(p)
      const used = new Set()
      return words.every((w) => {
        const i = parts.findIndex((x, j) => !used.has(j) && x.startsWith(w))
        if (i === -1) return false
        used.add(i)
        return true
      })
    }
    return guarded('search-people', async () => {
      const x = await teamRows(teamId)
      if (x.answer) return x.answer
      const { rows, team } = x
      const hits = mergeLicencePeople(rows).filter((p) => (licence ? p.sv_number === licence : named(p)))
      let free = !!unlimited
      if (!free && isUuid(userId)) {
        const { rows: m } = await pool.query('SELECT 1 FROM public.club_managers WHERE club_id = $1 AND user_id = $2', [team.club_id, userId])
        free = m.length > 0
      }
      if (free) return ok({ people: hits.slice(0, MAX_SEARCH_RESULTS), more: hits.length > MAX_SEARCH_RESULTS })
      // the person's key in the budget: its first row id (db/037), never the licence number
      const keyOf = new Map()
      for (const r of rows) {
        if (!r.id) continue
        const k = keyOf.get(r.sv_number)
        if (!k || r.id < k) keyOf.set(r.sv_number, r.id)
      }
      return withTx(async (client) => {
        // one search of the account at a time: the budget is read and spent together
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ov:people-search:${userId}`])
        const { rows: seenRows } = await client.query(
          `SELECT DISTINCT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.details -> 'ids') = 'array' THEN a.details -> 'ids' ELSE '[]'::jsonb END) AS id
             FROM public.audit_log a
            WHERE a.actor_id = $1 AND a.action = 'club.people_search' AND a.at > now() - $2::interval`, [userId, SEARCH_WINDOW])
        const seen = new Set(seenRows.map((r) => r.id))
        let room = Math.max(0, SEARCH_DAILY_PEOPLE - seen.size)
        const shown = []
        let held = 0
        for (const p of hits) {
          if (shown.length >= MAX_SEARCH_RESULTS) break
          const k = keyOf.get(p.sv_number)
          if (k && seen.has(k)) { shown.push(p); continue }
          if (room > 0) { room--; shown.push(p); continue }
          held++
        }
        const ids = shown.map((p) => keyOf.get(p.sv_number)).filter(Boolean)
        await audit(client, {
          actorId: userId,
          action: 'club.people_search',
          details: { club_id: team.club_id, team_id: team.id, results: shown.length, new: ids.filter((k) => !seen.has(k)).length, limited: held > 0, ids }
        })
        return ok({ people: shown, more: hits.length > shown.length, ...(held > 0 ? { limited: true } : {}) })
      })
    })
  }

  // ---------------------------------------------------------------- scorers
  /**
   * GET /api/club-licences: what the scoring tablet keeps for Match Setup
   * (offline first): each club of the caller with its team names, each team's
   * gender, the club's players list (`players`: the roster rows; the only
   * field release 3.0.15 reads) and every person of its three lists once
   * (`people`, with `lists`: the bench officials).
   */
  async function scorerClubPlayers ({ userId } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    return guarded('scorer-club-players', async () => {
      const now = clock()
      const mine = clubs?.clubsOf ? await clubs.clubsOf(pool, userId) : []
      if (!mine.length) return ok({ fetched_at: now.toISOString(), clubs: [] })
      const genders = await teamGenders(pool, mine.flatMap((c) => c.teams || []))
      let rows = []
      try {
        ;({ rows } = await pool.query(
          `SELECT l.club_id, l.list, l.sv_number, l.last_name, l.first_name, l.gender, ${sourceSql('l')} AS source
             FROM public.club_licences l WHERE l.club_id = ANY($1::uuid[]) AND ${currentSql('l', '$2')}`, [mine.map((c) => c.id), seasonNow()]))
      } catch (err) {
        if (!MISSING.has(err?.code)) throw err
      }
      return ok({
        fetched_at: now.toISOString(),
        clubs: mine.map((c) => {
          const names = c.teams || []
          const own = rows.filter((r) => r.club_id === c.id)
          return {
            club_id: c.id,
            club_name: c.name,
            team_names: names,
            team_genders: Object.fromEntries(names.map((n) => [n, genders.get(key(n)) ?? null])),
            players: playersOf(own),
            people: mergeLicencePeople(own)
          }
        })
      })
    })
  }

  /**
   * GET /api/club-licences/dob?club=<id>&sv=<n>,<n> (apps before db/048 ask
   * for the dates of birth of the people a scorer adds to a roster): none is
   * kept any more, so always { club_id, people: [] } for a signed-in caller.
   * The query is not read further: nothing is looked up, nothing audited.
   */
  async function scorerDob ({ userId, clubId } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    return ok({ club_id: isUuid(clubId) ? clubId : null, people: [] })
  }

  return { putList, addPeople, addFromMatch, deleteRow, clubList, teamClubPlayers, searchPeople, scorerClubPlayers, scorerDob, wrongGender, wrongGenders, teamGenders, sweep }
}
