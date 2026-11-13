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
 * upload) removes them too. Every person the reads answer has `manual`: true
 * when all its rows are manual (the gray shield), false when an upload has it.
 *
 * Club managers of the club (and admins), lib/manageApi.js:
 *   putList({ clubId, list, people, userId })  replaces the imported rows of one list (<= 2000
 *                                              people); an empty list deletes the whole list
 *   clubList({ clubId })                       every person once, their lists and teams
 *   addPeople({ clubId, body, userId })        { people: [{ list, ...five fields }] } (1 to 30) by
 *                                              hand: new rows only, never over an existing one
 * Whoever may manage the team (lib/teams.js mayManage):
 *   teamClubPlayers({ teamId })                the team's club: its players list, every person of
 *                                              its lists once (people, for the officials), the
 *                                              team's gender
 *   addPeople({ teamId, body, userId })        the same as the club's, to the team's club
 * Scorers (indoor canReadTeams, as GET /api/game-rosters):
 *   scorerClubPlayers({ userId })              each club of the caller: its teams, their gender,
 *                                              its players list and every person of its lists once
 * Everyone else (lib/teams.js):
 *   wrongGender(db, team, players)             the first player of the club's players list
 *                                              whose gender is not the team's, or null; players
 *                                              only, never the team's officials (owner 2026-11-09:
 *                                              "coaches can literally be any player/member of the
 *                                              club")
 *   teamGenders(db, names)                     Map team key -> 'm' | 'f' | null (svrz_games)
 *
 * Personal data (names, dates of birth, licence numbers, gender): served only
 * through these routes, never on the /api/db allowlist, never anonymous; the
 * audit keeps the list and the count, never a name. A database without db/024
 * answers "no list" to the reads and never blocks a squad or a roster; one
 * without db/026 reads every row as imported and answers 503 to the writes.
 *
 * Every answer is the { status, body } shape of lib/accounts.js; nothing throws.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { seasonOf } from './officialGame.js'
import { connectClient } from './pgClient.js'

export const LICENCE_LISTS = Object.freeze(['players', 'scorers', 'coaches'])
export const MAX_LICENCE_PEOPLE = 2000
export const LICENCE_NAME_MAX = 100
// The only fields a person of a list has (owner 2026-11-09)
export const LICENCE_FIELDS = Object.freeze(['sv_number', 'last_name', 'first_name', 'dob', 'gender'])
// db/026: people added by hand from a roster, at most this many per request
export const MAX_MANUAL_PEOPLE = 30
const MANUAL_FIELDS = Object.freeze(['list', ...LICENCE_FIELDS])
const SV_RE = /^[0-9]{4,7}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// No db/024 (or db/023) yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
// db/026's column; 'import' on a database without it (every row of before is an import)
const sourceSql = (alias) => `coalesce(to_jsonb(${alias}) ->> 'source', 'import')`
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const tidy = (s) => s.trim().replace(/\s+/g, ' ')

export const WRONG_GENDER = (index, gender) => {
  const r = fail(400, 'OV_WRONG_GENDER', 'This player is in the club\'s licence list with the other gender than the team\'s', `players[${index}].license_number`)
  r.body.error.index = index
  r.body.error.gender = gender
  return r
}

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

// db/026: `manual` is true when every row of the person was added by hand
// (the gray shield); one imported row (any list) makes it false
const importedOf = (rows) => new Set((rows || []).filter((r) => r.source !== 'manual').map((r) => r.sv_number))
const personOut = (r, imported) => ({
  sv_number: r.sv_number,
  last_name: r.last_name,
  first_name: r.first_name ?? null,
  dob: r.dob ?? null,
  gender: r.gender ?? null,
  manual: !imported.has(r.sv_number)
})
const byName = (a, b) => a.last_name.localeCompare(b.last_name, 'de') || String(a.first_name || '').localeCompare(String(b.first_name || ''), 'de') || a.sv_number.localeCompare(b.sv_number)

/**
 * Rows of several lists ({ list, sv_number, last_name, first_name, dob,
 * gender, source }) -> every person once ({ ...the five fields, manual,
 * lists }), in name order: the fields of the first list that has them
 * (players, scorers, coaches), lists in that order; manual when every row of
 * the person is (db/026). `extra(sv)` adds fields to a person (the teams of
 * My club).
 */
export function mergeLicencePeople (rows, extra = null) {
  const people = new Map()
  const imported = importedOf(rows)
  const order = (r) => LICENCE_LISTS.indexOf(r.list)
  for (const r of [...(rows || [])].filter((x) => LICENCE_LISTS.includes(x?.list)).sort((a, b) => order(a) - order(b))) {
    const cur = people.get(r.sv_number)
    if (!cur) {
      people.set(r.sv_number, { ...personOut(r, imported), lists: [r.list], ...(extra ? extra(r.sv_number) : {}) })
      continue
    }
    if (!cur.lists.includes(r.list)) cur.lists.push(r.list)
    cur.first_name ??= r.first_name ?? null
    cur.dob ??= r.dob ?? null
    cur.gender ??= r.gender ?? null
  }
  return [...people.values()].sort(byName)
}

/** The players list of `rows` (several lists): the five fields and manual, in name order. */
const playersOf = (rows) => {
  const imported = importedOf(rows)
  return (rows || []).filter((r) => r.list === 'players').map((r) => personOut(r, imported)).sort(byName)
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {(client: any, entry: object) => Promise<void>} o.audit  lib/accounts.js audit (throws)
 * @param {object} o.clubs  lib/clubs.js (clubsOf: the clubs a scorer scores for)
 */
export function createLicences ({ pool, audit, clubs = null, logger = console, clock = () => new Date() } = {}) {
  const log = logger

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

  /** The club's people of one list (or every list): rows with dob as YYYY-MM-DD and their source. */
  async function peopleOf (db, clubId, list = null) {
    const { rows } = await (db || pool).query(
      `SELECT l.list, l.sv_number, l.last_name, l.first_name, l.dob::text AS dob, l.gender, ${sourceSql('l')} AS source
         FROM public.club_licences l
        WHERE l.club_id = $1 AND ($2::text IS NULL OR l.list = $2)`, [clubId, list])
    return rows
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
        `SELECT sv_number, gender FROM public.club_licences
          WHERE club_id = $1 AND list = 'players' AND sv_number = ANY($2::text[]) AND gender IS NOT NULL AND gender <> $3`,
        [team.club_id, lics, want])
      if (!rows.length) return null
      const wrong = new Map(rows.map((r) => [r.sv_number, r.gender]))
      const index = players.findIndex((p) => wrong.has(String(p?.license_number ?? '').trim()))
      return index === -1 ? null : { index, gender: wrong.get(String(players[index].license_number).trim()) }
    } catch (err) {
      if (MISSING.has(err?.code)) return null
      throw err
    }
  }

  // ---------------------------------------------------------------- club managers
  /**
   * PUT /api/club/:id/licences/:list { people }: an upload, in one
   * transaction. It replaces the imported rows of the list; the rows added by
   * hand stay (db/026), and one whose licence number the upload has becomes
   * an imported row with the upload's fields. An empty list is Delete list:
   * every row of the list goes, the hand-added ones too.
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
      const p = v.people
      if (!p.length) {
        await client.query('DELETE FROM public.club_licences WHERE club_id = $1 AND list = $2', [clubId, list])
      } else {
        await client.query("DELETE FROM public.club_licences WHERE club_id = $1 AND list = $2 AND source = 'import'", [clubId, list])
        await client.query(
          `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob, gender, imported_by, source)
           SELECT $1, $2, x.sv, x.ln, x.fn, x.dob, x.g, $3, 'import'
             FROM unnest($4::text[], $5::text[], $6::text[], $7::date[], $8::text[]) AS x(sv, ln, fn, dob, g)
           ON CONFLICT (club_id, list, sv_number) DO UPDATE
              SET last_name = EXCLUDED.last_name, first_name = EXCLUDED.first_name, dob = EXCLUDED.dob, gender = EXCLUDED.gender,
                  source = 'import', imported_at = EXCLUDED.imported_at, imported_by = EXCLUDED.imported_by`,
          [clubId, list, isUuid(userId) ? userId : null, p.map((x) => x.sv_number), p.map((x) => x.last_name),
            p.map((x) => x.first_name), p.map((x) => x.dob), p.map((x) => x.gender)])
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
   * number), added to the club's lists as 'manual' rows. A licence number the
   * list already has (imported or hand-added) is left as it is: nothing is
   * overwritten. `teamId`: the team's club (404 for a team without one).
   * { club_id, added, already } (people of the request added / already there).
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
      const p = v.people
      const { rows: added } = await client.query(
        `INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob, gender, imported_by, source)
         SELECT $1, x.list, x.sv, x.ln, x.fn, x.dob, x.g, $2, 'manual'
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::text[]) AS x(list, sv, ln, fn, dob, g)
         ON CONFLICT (club_id, list, sv_number) DO NOTHING
         RETURNING list`,
        [club, isUuid(userId) ? userId : null, p.map((x) => x.list), p.map((x) => x.sv_number), p.map((x) => x.last_name),
          p.map((x) => x.first_name), p.map((x) => x.dob), p.map((x) => x.gender)])
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
   * GET /api/club/:id/licences: every person of the club's lists once
   * ({ sv_number, last_name, first_name, dob, gender, manual, lists, teams }),
   * and per list { count, manual, imported_at, imported_by_name }: count every
   * row, manual the hand-added ones (db/026), imported_at and
   * imported_by_name the last upload's (null when there was none). teams: the
   * club's teams whose saved team of this season (lib/teams.js squad) has a
   * player or an official with that licence number.
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
          `WITH r AS (SELECT l.*, ${sourceSql('l')} AS src FROM public.club_licences l WHERE l.club_id = $1),
                n AS (SELECT list, count(*)::int AS count, (count(*) FILTER (WHERE src = 'manual'))::int AS manual FROM r GROUP BY list),
                i AS (SELECT DISTINCT ON (r.list) r.list, r.imported_at, ${nameSql('p')} AS imported_by_name
                        FROM r LEFT JOIN public.profiles p ON p.user_id = r.imported_by
                       WHERE r.src = 'import'
                       ORDER BY r.list, r.imported_at DESC)
           SELECT n.list, n.count, n.manual, i.imported_at, i.imported_by_name FROM n LEFT JOIN i ON i.list = n.list`, [clubId]))
      } catch (err) {
        if (!MISSING.has(err?.code)) throw err
      }
      // the season label of the saved teams (lib/teams.js seasonLabel)
      const year = seasonOf(clock())
      const season = `${year}/${String((year + 1) % 100).padStart(2, '0')}`
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
      // one entry per licence number: its fields from the first list that has them
      const people = mergeLicencePeople(rows, (sv) => ({ teams: (teamsOf.get(sv) || []).sort((a, b) => a.name.localeCompare(b.name)) }))
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
   * GET /api/team/:id/club-players: the team's club for "Add from club" and
   * the team's gender (null: no check). `players`: the players list (for the
   * player rows, which the gender rule checks); `people`: every person of the
   * club's three lists once, with its `lists` (for the team officials, who
   * may be anyone of the club, of either gender). Each person has `manual`
   * (db/026: added by hand, not in any upload).
   */
  async function teamClubPlayers ({ teamId } = {}) {
    if (!isUuid(teamId)) return notFound()
    return guarded('team-club-players', async () => {
      const { rows: [t] } = await pool.query(
        `SELECT ct.id, ct.team_name AS name, c.id AS club_id, c.name AS club_name
           FROM public.club_teams ct JOIN public.clubs c ON c.id = ct.club_id WHERE ct.id = $1`, [teamId])
      if (!t) return notFound()
      const team = { id: t.id, name: t.name, club_id: t.club_id, club_name: t.club_name }
      const gender = (await teamGenders(pool, [team.name])).get(key(team.name)) ?? null
      let rows = []
      try {
        rows = await peopleOf(pool, team.club_id)
      } catch (err) {
        if (!MISSING.has(err?.code)) throw err
      }
      return ok({ team, gender, players: playersOf(rows), people: mergeLicencePeople(rows) })
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
          `SELECT l.club_id, l.list, l.sv_number, l.last_name, l.first_name, l.dob::text AS dob, l.gender, ${sourceSql('l')} AS source
             FROM public.club_licences l WHERE l.club_id = ANY($1::uuid[])`, [mine.map((c) => c.id)]))
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

  return { putList, addPeople, clubList, teamClubPlayers, scorerClubPlayers, wrongGender, teamGenders }
}
