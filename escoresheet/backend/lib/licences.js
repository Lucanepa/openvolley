/**
 * licences — a club's licence lists from VolleyManager's club administration
 * (db/024, docs/club-licences-spec.md).
 *
 * A club manager reads the XLSX export in the browser
 * (frontend src/utils/vmLicenceExport.js) and sends five fields per person:
 * licence number (Swiss Volley "SV" number), last name, first name, date of
 * birth and gender. Nothing else of the export reaches the server, and this
 * module refuses any other field. Three lists per club: players, scorers,
 * coaches; each upload replaces the imported rows of its list.
 *
 * db/026 (owner 2026-11-10: "if I add somebody manually, when saving ask if I
 * want to save him/her in the club. Those from the club/recognized/linked ->
 * green shield. Those added manually -> gray shield, but can be linked
 * later."): a team or club manager may add people typed in by hand to the
 * club's lists, the same five fields (source 'manual'). An upload keeps them,
 * and turns those it contains into imported rows; Delete list (an empty
 * upload) removes them too. A row of the players list has `manual`: true when
 * it was added by hand; a person (every list once) when all its rows are (the
 * gray shield), with the fields of its imported rows first. A licence number
 * the club has in any list is never added by hand again (nobody passes for
 * someone of another list); at most MAX_MANUAL_PER_CLUB hand-added rows per
 * club and MAX_MANUAL_PER_DAY per account a day; a club manager deletes one
 * of them (deleteRow).
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
 *   addPeople({ clubId, body, userId })        { people: [{ list, ...five fields }] } (1 to 30) by
 *                                              hand: new licence numbers only, never over a row
 *   deleteRow({ clubId, rowId, userId })       one row added by hand
 * Whoever may manage the team (lib/teams.js mayManage):
 *   teamClubPlayers({ teamId })                the team's club: its players of the team's gender
 *                                              and age class (filtered here, never in the
 *                                              browser) and the people of the team's saved team
 *                                              (`people`, the shields); dates of birth only of
 *                                              the people in the saved team (fillDob adds them
 *                                              when a person is saved into a roster)
 *   searchPeople({ teamId, q })                at most MAX_SEARCH_RESULTS people of the club's
 *                                              lists by name or licence number (an official may
 *                                              be anyone of the club), dates of birth as above
 *   addPeople({ teamId, body, userId })        the same as the club's, to the team's club
 * Scorers (indoor canReadTeams, as GET /api/game-rosters):
 *   scorerClubPlayers({ userId })              each club of the caller: its teams, their gender,
 *                                              its players list and every person of its lists
 *                                              once, without dates of birth (the tablet's copy)
 *   scorerDob({ userId, clubId, svNumbers })   the dates of birth of the people a scorer adds to
 *                                              a roster (at most MAX_DOB_LOOKUP), of its own clubs
 * Everyone else (lib/teams.js, server.js):
 *   wrongGender(db, team, players)             the first player of the club's players list
 *                                              whose gender is not the team's, or null; players
 *                                              only, never the team's officials (owner 2026-11-09:
 *                                              "coaches can literally be any player/member of the
 *                                              club")
 *   fillDob(db, clubId, people)                `people` with the club's dates of birth where a
 *                                              row with a licence number of the lists has none
 *   teamGenders(db, names)                     Map team key -> 'm' | 'f' | null (svrz_games)
 *   sweep()                                    deletes the rows of past seasons
 *
 * Personal data (names, dates of birth, licence numbers, gender): served only
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

export const LICENCE_LISTS = Object.freeze(['players', 'scorers', 'coaches'])
export const MAX_LICENCE_PEOPLE = 2000
export const LICENCE_NAME_MAX = 100
// The only fields a person of a list has (owner 2026-11-09)
export const LICENCE_FIELDS = Object.freeze(['sv_number', 'last_name', 'first_name', 'dob', 'gender'])
// db/026: people added by hand from a roster, at most this many per request
export const MAX_MANUAL_PEOPLE = 30
// ... and at most this many rows added by hand per club, and per account a day
export const MAX_MANUAL_PER_CLUB = 300
export const MAX_MANUAL_PER_DAY = 100
// A team manager's search of the club's people (an official): a few rows, never the list
export const MAX_SEARCH_RESULTS = 10
export const SEARCH_MIN_LENGTH = 3
// The dates of birth a scorer asks for at once (the people added to one roster)
export const MAX_DOB_LOOKUP = 30
const MANUAL_FIELDS = Object.freeze(['list', ...LICENCE_FIELDS])
const SV_RE = /^[0-9]{4,7}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// No db/024 (or db/023) yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
// db/026's column; 'import' on a database without it (every row of before is an import)
const sourceSql = (alias) => `coalesce(to_jsonb(${alias}) ->> 'source', 'import')`
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
 * Could a person born on `dob` (YYYY-MM-DD, or none) play in age class U<n>
 * in season `seasonYear`? Born in the season's first year minus n or later:
 * one year more than the class's own limit, so that no player of the class is
 * left out; a person without a date of birth always.
 */
export function fitsAgeClass (dob, n, seasonYear) {
  if (!n || !seasonYear || typeof dob !== 'string' || !DATE_RE.test(dob)) return true
  return Number(dob.slice(0, 4)) >= seasonYear - n
}

function validDate (s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false
  const y = Number(s.slice(0, 4))
  return y >= 1900 && y <= 2100
}

/**
 * One person of a list: the five fields, trimmed. { person } or { error } (a
 * 400 answer). A field outside `fields` is refused.
 */
function validPerson (raw, at, fields = LICENCE_FIELDS) {
  if (!isPlainObject(raw)) return { error: invalid(`${at}: must be an object`) }
  const extra = Object.keys(raw).find((k) => !fields.includes(k))
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
  let dob = null
  if (raw.dob != null && raw.dob !== '') {
    if (!validDate(raw.dob)) return { error: invalid(`${at}.dob: YYYY-MM-DD or null`) }
    dob = raw.dob
  }
  let gender = null
  if (raw.gender != null && raw.gender !== '') {
    if (raw.gender !== 'm' && raw.gender !== 'f') return { error: invalid(`${at}.gender: m, f or null`) }
    gender = raw.gender
  }
  return { person: { sv_number: sv, last_name: last, first_name: first, dob, gender } }
}

/** A person named twice: the first one's fields, completed by the later one's. */
function completeWith (cur, p) {
  cur.first_name ??= p.first_name
  cur.dob ??= p.dob
  cur.gender ??= p.gender
}

/**
 * The people of one upload: the five fields, trimmed; a licence number twice
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
 * last_name, first_name, dob, gender }] }, 1 to 30 entries, the five fields as
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

const personOut = (r, manual) => ({
  sv_number: r.sv_number,
  last_name: r.last_name,
  first_name: r.first_name ?? null,
  dob: r.dob ?? null,
  gender: r.gender ?? null,
  manual
})
const byName = (a, b) => a.last_name.localeCompare(b.last_name, 'de') || String(a.first_name || '').localeCompare(String(b.first_name || ''), 'de') || a.sv_number.localeCompare(b.sv_number)
const listOrder = (l) => LICENCE_LISTS.indexOf(l)

/**
 * Rows of several lists ({ list, sv_number, last_name, first_name, dob,
 * gender, source }) -> every person once ({ ...the five fields, manual,
 * lists }), in name order: the fields of the first imported row that has
 * them (players, scorers, coaches), then of the rows added by hand (so a row
 * typed in by hand never replaces what an upload says); the lists in that
 * order; manual when every row of the person is (db/026). `extra(sv)` adds
 * fields to a person (the teams of My club).
 */
export function mergeLicencePeople (rows, extra = null) {
  const people = new Map()
  const manualOf = new Map()
  const valid = (rows || []).filter((x) => LICENCE_LISTS.includes(x?.list))
  for (const r of valid) manualOf.set(r.sv_number, (manualOf.get(r.sv_number) ?? true) && r.source === 'manual')
  const rank = (r) => (r.source === 'manual' ? 10 : 0) + listOrder(r.list)
  for (const r of [...valid].sort((a, b) => rank(a) - rank(b))) {
    const cur = people.get(r.sv_number)
    if (!cur) {
      people.set(r.sv_number, { ...personOut(r, manualOf.get(r.sv_number)), lists: [r.list], ...(extra ? extra(r.sv_number) : {}) })
      continue
    }
    if (!cur.lists.includes(r.list)) cur.lists.push(r.list)
    cur.first_name ??= r.first_name ?? null
    cur.dob ??= r.dob ?? null
    cur.gender ??= r.gender ?? null
  }
  for (const p of people.values()) p.lists.sort((a, b) => listOrder(a) - listOrder(b))
  return [...people.values()].sort(byName)
}

/** The players list of `rows` (several lists): the five fields and manual (this row's, db/026), in name order. */
const playersOf = (rows) => (rows || []).filter((r) => r.list === 'players').map((r) => personOut(r, r.source === 'manual')).sort(byName)

// A person without the date of birth (what a scorer's tablet keeps, and a team
// manager's answer for those not in its saved team)
const withoutDob = (p) => ({ ...p, dob: null })

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
   * rows with dob as YYYY-MM-DD, their source and row id.
   */
  async function peopleOf (db, clubId, list = null) {
    const { rows } = await (db || pool).query(
      `SELECT l.list, l.sv_number, l.last_name, l.first_name, l.dob::text AS dob, l.gender, ${sourceSql('l')} AS source, ${idSql('l')} AS id
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
   * and officials; lib/teams.js squad): the people whose dates of birth its
   * managers see. Throws on a DB error.
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
    if (!team || !isUuid(team.club_id) || !Array.isArray(players) || !players.length) return null
    const lics = [...new Set(players.map((p) => String(p?.license_number ?? '').trim()).filter((s) => SV_RE.test(s)))]
    if (!lics.length) return null
    try {
      const want = (await teamGenders(db, [team.name])).get(key(team.name)) ?? null
      if (!want) return null
      const { rows } = await (db || pool).query(
        `SELECT sv_number, gender FROM public.club_licences l
          WHERE club_id = $1 AND list = 'players' AND sv_number = ANY($2::text[]) AND gender IS NOT NULL AND gender <> $3
            AND ${currentSql('l', '$4')}`,
        [team.club_id, lics, want, seasonNow()])
      if (!rows.length) return null
      const wrong = new Map(rows.map((r) => [r.sv_number, r.gender]))
      const index = players.findIndex((p) => wrong.has(String(p?.license_number ?? '').trim()))
      return index === -1 ? null : { index, gender: wrong.get(String(players[index].license_number).trim()) }
    } catch (err) {
      if (MISSING.has(err?.code)) return null
      throw err
    }
  }

  /**
   * `people` (roster rows { license_number, dob, ... }) with the date of birth
   * of the club's lists where a row has a licence number of them and no date
   * of birth (the players list first): a team manager gets the dates of birth
   * of the club's people only once they are in a roster (owner decision 2).
   * The others as they are; none without db/024. Throws on a DB error.
   */
  async function fillDob (db, clubId, people) {
    const list = Array.isArray(people) ? people : []
    const want = [...new Set(list.filter((p) => isPlainObject(p) && (p.dob == null || p.dob === ''))
      .map((p) => String(p.license_number ?? '').trim()).filter((s) => SV_RE.test(s)))]
    if (!isUuid(clubId) || !want.length) return list
    let rows
    try {
      ;({ rows } = await (db || pool).query(
        `SELECT DISTINCT ON (l.sv_number) l.sv_number, l.dob::text AS dob
           FROM public.club_licences l
          WHERE l.club_id = $1 AND l.sv_number = ANY($2::text[]) AND l.dob IS NOT NULL AND ${currentSql('l', '$3')}
          ORDER BY l.sv_number, (${sourceSql('l')} = 'manual'), array_position(ARRAY['players', 'scorers', 'coaches'], l.list)`,
        [clubId, want, seasonNow()]))
    } catch (err) {
      if (MISSING.has(err?.code)) return list
      throw err
    }
    const dobOf = new Map(rows.map((r) => [r.sv_number, r.dob]))
    return list.map((p) => {
      if (!isPlainObject(p) || (p.dob != null && p.dob !== '')) return p
      const d = dobOf.get(String(p.license_number ?? '').trim())
      return d ? { ...p, dob: d } : p
    })
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
        await client.query("DELETE FROM public.club_licences WHERE club_id = $1 AND list = $2 AND source = 'import'", [clubId, list])
        await client.query(
          `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob, gender, imported_by, source, season)
           SELECT $1, $2, x.sv, x.ln, x.fn, x.dob, x.g, $3, 'import', $9
             FROM unnest($4::text[], $5::text[], $6::text[], $7::date[], $8::text[]) AS x(sv, ln, fn, dob, g)
           ON CONFLICT (club_id, list, sv_number) DO UPDATE
              SET last_name = EXCLUDED.last_name, first_name = EXCLUDED.first_name, dob = EXCLUDED.dob, gender = EXCLUDED.gender,
                  source = 'import', imported_at = EXCLUDED.imported_at, imported_by = EXCLUDED.imported_by, season = EXCLUDED.season`,
          [clubId, list, isUuid(userId) ? userId : null, p.map((x) => x.sv_number), p.map((x) => x.last_name),
            p.map((x) => x.first_name), p.map((x) => x.dob), p.map((x) => x.gender), seasonNow()])
      }
      const { rows: [n] } = await client.query(
        "SELECT count(*)::int AS manual, now() AS at FROM public.club_licences WHERE club_id = $1 AND list = $2 AND source = 'manual'", [clubId, list])
      // the list and the count only: never a name
      await audit(client, { actorId: userId, action: 'club.licences', details: { club_id: clubId, list, count: p.length } })
      return ok({ list, count: p.length, manual: n.manual, imported_at: iso(n.at) })
    }))
  }

  /**
   * POST /api/club/:id/licences/people and POST /api/team/:id/club-people
   * { people: [{ list, sv_number, last_name, first_name, dob, gender }] }
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
          `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob, gender, imported_by, source, season)
           SELECT $1, x.list, x.sv, x.ln, x.fn, x.dob, x.g, $2, 'manual', $9
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::text[]) AS x(list, sv, ln, fn, dob, g)
           ON CONFLICT (club_id, list, sv_number) DO NOTHING
           RETURNING list`,
          [club, isUuid(userId) ? userId : null, fresh.map((x) => x.list), fresh.map((x) => x.sv_number), fresh.map((x) => x.last_name),
            fresh.map((x) => x.first_name), fresh.map((x) => x.dob), fresh.map((x) => x.gender), seasonNow()])
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
      if (r.source !== 'manual') throw abort(fail(409, 'OV_NOT_HAND_ADDED', 'Only a person added by hand is removed one by one; upload the list again for the others'))
      await client.query('DELETE FROM public.club_licences WHERE club_id = $1 AND id = $2', [clubId, rowId])
      // the club and the list only: never a name or a licence number
      await audit(client, { actorId: userId, action: 'club.licences.manual_delete', details: { club_id: clubId, list: r.list } })
      return ok({ deleted: true, list: r.list })
    }))
  }

  /**
   * GET /api/club/:id/licences: every person of the club's lists once
   * ({ id, sv_number, last_name, first_name, dob, gender, manual, lists,
   * teams, hand_rows }), and per list { count, manual, imported_at,
   * imported_by_name }: count every row, manual the hand-added ones (db/026),
   * imported_at and imported_by_name the last upload's (null when there was
   * none). id: the person's first row (db/037: the person page's key);
   * hand_rows: its rows added by hand ({ id, list }, deleteRow). teams: the
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
                n AS (SELECT list, count(*)::int AS count, (count(*) FILTER (WHERE src = 'manual'))::int AS manual FROM r GROUP BY list),
                i AS (SELECT DISTINCT ON (r.list) r.list, r.imported_at, ${nameSql('p')} AS imported_by_name
                        FROM r LEFT JOIN public.profiles p ON p.user_id = r.imported_by
                       WHERE r.src = 'import'
                       ORDER BY r.list, r.imported_at DESC)
           SELECT n.list, n.count, n.manual, i.imported_at, i.imported_by_name FROM n LEFT JOIN i ON i.list = n.list`, [clubId, seasonNow()]))
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
      // db/037: the person's row id (its first list) and its rows added by hand
      const idOf = new Map()
      const handOf = new Map()
      for (const r of [...rows].sort((a, b) => listOrder(a.list) - listOrder(b.list))) {
        if (!idOf.has(r.sv_number)) idOf.set(r.sv_number, r.id ?? null)
        if (r.source === 'manual' && r.id) {
          if (!handOf.has(r.sv_number)) handOf.set(r.sv_number, [])
          handOf.get(r.sv_number).push({ id: r.id, list: r.list })
        }
      }
      // one entry per licence number: its fields from the first imported list that has them
      const people = mergeLicencePeople(rows, (sv) => ({
        id: idOf.get(sv) ?? null,
        teams: (teamsOf.get(sv) || []).sort((a, b) => a.name.localeCompare(b.name)),
        hand_rows: handOf.get(sv) || []
      }))
      const lists = Object.fromEntries(LICENCE_LISTS.map((l) => {
        const s = summary.find((x) => x.list === l)
        return [l, s
          ? { count: s.count, manual: s.manual, imported_at: iso(s.imported_at), imported_by_name: s.imported_by_name ?? null }
          : { count: 0, manual: 0, imported_at: null, imported_by_name: null }]
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
    return { team, rows, squad }
  }

  /**
   * GET /api/team/:id/club-players: the team's club for "Add from club", the
   * team's gender (null: no check) and age class (U<n> of its leagues, null:
   * none). Owner decision 2: only what the team needs, decided here.
   * `players`: the players list of the team's gender (and those without one)
   * and age class (fitsAgeClass); `people`: the people of the team's saved
   * team and those players, once each with its `lists` (the shields of the
   * squad's rows; an official of the club is found with searchPeople). Dates
   * of birth only of the people in the team's saved team. Each person has
   * `manual` (db/026: added by hand, not in any upload).
   */
  async function teamClubPlayers ({ teamId } = {}) {
    if (!isUuid(teamId)) return notFound()
    return guarded('team-club-players', async () => {
      const x = await teamRows(teamId)
      if (x.answer) return x.answer
      const { team, rows, squad } = x
      const year = seasonNow()
      const gender = (await teamGenders(pool, [team.name])).get(key(team.name)) ?? null
      const ageClass = await teamAgeClass(pool, team.name, year)
      const dobIfSquad = (p) => (squad.has(p.sv_number) ? p : withoutDob(p))
      const players = playersOf(rows)
        .filter((p) => !gender || !p.gender || p.gender === gender)
        .filter((p) => fitsAgeClass(p.dob, ageClass, year))
      const offered = new Set(players.map((p) => p.sv_number))
      const people = mergeLicencePeople(rows.filter((r) => squad.has(r.sv_number) || offered.has(r.sv_number))).map(dobIfSquad)
      return ok({ team, gender, age_class: ageClass ? `U${ageClass}` : null, players: players.map(dobIfSquad), people })
    })
  }

  /**
   * GET /api/team/:id/club-people?q=: the people of the club's lists whose
   * name or licence number has `q` (at least SEARCH_MIN_LENGTH characters;
   * accents and case aside), at most MAX_SEARCH_RESULTS, each once with its
   * `lists`, dates of birth as teamClubPlayers. An official may be anyone of
   * the club (owner 2026-11-09), so a team manager finds one by name instead
   * of reading the whole lists. { people, more } (more: there were more).
   */
  async function searchPeople ({ teamId, q } = {}) {
    if (!isUuid(teamId)) return notFound()
    const needle = fold(typeof q === 'string' ? q : '')
    if (needle.length < SEARCH_MIN_LENGTH || needle.length > 80) return invalid(`q: ${SEARCH_MIN_LENGTH} to 80 characters`)
    return guarded('search-people', async () => {
      const x = await teamRows(teamId)
      if (x.answer) return x.answer
      const { rows, squad } = x
      const hits = mergeLicencePeople(rows).filter((p) =>
        p.sv_number === needle || fold(`${p.last_name} ${p.first_name || ''} ${p.first_name || ''} ${p.last_name}`).includes(needle))
      return ok({
        people: hits.slice(0, MAX_SEARCH_RESULTS).map((p) => (squad.has(p.sv_number) ? p : withoutDob(p))),
        more: hits.length > MAX_SEARCH_RESULTS
      })
    })
  }

  // ---------------------------------------------------------------- scorers
  /**
   * GET /api/club-licences: what the scoring tablet keeps for Match Setup
   * (offline first): each club of the caller with its team names, each team's
   * gender, the club's players list (`players`: the roster rows; the only
   * field release 3.0.15 reads) and every person of its three lists once
   * (`people`, with `lists`: the bench officials). No dates of birth (owner
   * decision 2: the tablet asks for those of the people it adds, scorerDob).
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
            players: playersOf(own).map(withoutDob),
            people: mergeLicencePeople(own).map(withoutDob)
          }
        })
      })
    })
  }

  /**
   * GET /api/club-licences/dob?club=<id>&sv=<n>,<n>: the dates of birth of
   * people of the caller's club `clubId` that the scorer adds to a roster
   * (at most MAX_DOB_LOOKUP licence numbers): { club_id, people: [{ sv_number,
   * dob }] } (those of the lists that have one; the players list first). 404
   * for a club the caller does not score for.
   */
  async function scorerDob ({ userId, clubId, svNumbers } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    if (!isUuid(clubId)) return notFound()
    const list = typeof svNumbers === 'string' ? svNumbers.split(',').map((s) => s.trim()).filter(Boolean) : []
    if (!list.length || list.length > MAX_DOB_LOOKUP || !list.every((s) => SV_RE.test(s))) return invalid(`sv: 1 to ${MAX_DOB_LOOKUP} licence numbers`)
    return guarded('scorer-dob', async () => {
      const mine = clubs?.clubsOf ? await clubs.clubsOf(pool, userId) : []
      if (!mine.some((c) => c.id === clubId)) return notFound()
      const filled = await fillDob(pool, clubId, [...new Set(list)].map((sv) => ({ license_number: sv, dob: null })))
      return ok({ club_id: clubId, people: filled.filter((p) => p.dob).map((p) => ({ sv_number: p.license_number, dob: p.dob })) })
    })
  }

  return { putList, addPeople, deleteRow, clubList, teamClubPlayers, searchPeople, scorerClubPlayers, scorerDob, wrongGender, fillDob, teamGenders, sweep }
}
