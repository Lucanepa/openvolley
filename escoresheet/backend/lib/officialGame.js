/**
 * officialGame — one cloud match per official game (docs/scorer-accounts-spec.md
 * section 2, db/007_scorer_accounts.sql).
 *
 * Key: (beach or not, game_n, season) for matches with test IS NOT TRUE,
 * game_n > 0 and NOT official_game_exempt. VolleyManager game numbers are
 * unique within a season only, so game_n alone would block a later season.
 *
 *   season = Europe/Zurich year of coalesce(scheduled_at, created_at)
 *            minus 1 before July        (2026-08 .. 2027-06 is season 2026)
 *
 * The expression must stay identical in three places: db/007 (index and
 * duplicate scan), SEASON_SQL below, and frontend/src/domain/season.js.
 * seasonOf() is the JS twin, tested against SEASON_SQL on Postgres.
 */

export const OFFICIAL_INDEX = 'matches_official_game_uidx'
export const SEASON_TZ = 'Europe/Zurich'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SQL text of the season of a timestamptz expression (exactly db/007's). */
export function SEASON_SQL (tsExpr) {
  const local = `(${tsExpr} AT TIME ZONE '${SEASON_TZ}')`
  return `(date_part('year', ${local})::int - CASE WHEN date_part('month', ${local}) < 7 THEN 1 ELSE 0 END)`
}

const zurichParts = new Intl.DateTimeFormat('en-CH', { timeZone: SEASON_TZ, year: 'numeric', month: 'numeric' })

/** The season (an integer year) of a date, ISO string or epoch ms; null when there is none. */
export function seasonOf (dateLike) {
  if (dateLike == null || dateLike === '') return null
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (Number.isNaN(d.getTime())) return null
  let year = 0
  let month = 0
  for (const p of zurichParts.formatToParts(d)) {
    if (p.type === 'year') year = Number(p.value)
    else if (p.type === 'month') month = Number(p.value)
  }
  return month < 7 ? year - 1 : year
}

/** Rows that claim an official game: not a test match and a positive integer game_n. */
export function officialRowsOf (rows) {
  const list = Array.isArray(rows) ? rows : [rows]
  return list.filter((r) => r && typeof r === 'object' && r.test !== true &&
    r.game_n != null && r.game_n !== '' && Number.isInteger(Number(r.game_n)) && Number(r.game_n) > 0)
}

/** 'beach' or 'indoor' (NULL / anything else counts as indoor, like the index). */
export function sportOf (sportType) {
  return sportType === 'beach' ? 'beach' : 'indoor'
}

/** The claim object a client may see (spec 5.2): no match id, PINs, emails, user ids or external_id. */
export function publicClaim (claim) {
  if (!claim) return null
  const { game_n, season, sport, status, scorer_name, mine, scheduled_at } = claim
  return { game_n, season, sport, status, scorer_name, mine, scheduled_at }
}

/**
 * The match that already holds this official game, or null.
 * @param {{query: Function}} db  a pg Pool or client
 * @returns {Promise<null|{match_id, game_n, season, sport, status, scorer_name, mine, scheduled_at}>}
 */
export async function findClaim (db, { gameN, scheduledAt = null, sportType = 'indoor', excludeExternalId = null, callerId = null } = {}) {
  const n = Number(gameN)
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) return null
  let scheduled = null
  if (scheduledAt != null && scheduledAt !== '') {
    const d = new Date(scheduledAt)
    if (!Number.isNaN(d.getTime())) scheduled = d.toISOString()
  }
  const caller = typeof callerId === 'string' && UUID_RE.test(callerId) ? callerId : null
  const exclude = typeof excludeExternalId === 'string' && excludeExternalId ? excludeExternalId : null
  const { rows } = await db.query(
    `SELECT m.id AS match_id, m.game_n, m.status, m.scheduled_at,
            ${SEASON_SQL('coalesce(m.scheduled_at, m.created_at)')} AS season,
            CASE WHEN m.sport_type IS NOT DISTINCT FROM 'beach' THEN 'beach' ELSE 'indoor' END AS sport,
            nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS scorer_name,
            ($5::uuid IS NOT NULL AND (m.created_by = $5::uuid OR EXISTS (
              SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = $5::uuid))) AS mine
       FROM public.matches m
       LEFT JOIN public.profiles p ON p.user_id = m.created_by
      WHERE m.test IS NOT TRUE AND NOT m.official_game_exempt AND m.game_n = $1
        AND (m.sport_type IS NOT DISTINCT FROM 'beach') = ($2::text = 'beach')
        AND ${SEASON_SQL('coalesce(m.scheduled_at, m.created_at)')} = ${SEASON_SQL('coalesce($3::timestamptz, now())')}
        AND m.external_id IS DISTINCT FROM $4::text
      ORDER BY m.created_at NULLS LAST, m.id
      LIMIT 1`,
    [n, sportOf(sportType), scheduled, exclude, caller])
  const r = rows[0]
  if (!r) return null
  return {
    match_id: r.match_id,
    game_n: r.game_n,
    season: r.season,
    sport: r.sport,
    status: r.status ?? null,
    scorer_name: r.scorer_name ?? null,
    mine: r.mine === true,
    scheduled_at: r.scheduled_at instanceof Date ? r.scheduled_at.toISOString() : (r.scheduled_at ?? null)
  }
}
